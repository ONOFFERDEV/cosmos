// M9: tests for identity→owner_scope mapping and ownership-scope handling in /search·/ingest.
// See CONTRACT.md "# M9 확장" mind section. Reuses the withServer/withAuthServer/
// makeTempDataDir patterns from server-mode.test.ts as-is.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMindServer, ownerScopeFor } from "./server.js";
import type { ServerDeps } from "./server.js";
import type { CoreClient, SearchRequest, SearchResponse, IngestRequest } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import type { Identity } from "./users.js";
import { addUser } from "./users.js";

const EMPTY_SEARCH: SearchResponse = {
  results: [],
  stats: { num_bm25: 0, num_vec: 0, pool: 0, reranked: 0, secs: 0 },
};

const NEVER_CALL_LLM: LlmClient = {
  model: "mock",
  async complete(): Promise<string> {
    throw new Error("이 시나리오에서는 LLM이 호출되면 안 됩니다.");
  },
};

function makeSearchRecordingCore(): { core: CoreClient; calls: SearchRequest[] } {
  const calls: SearchRequest[] = [];
  const core = {
    async search(req: SearchRequest): Promise<SearchResponse> {
      calls.push(req);
      return EMPTY_SEARCH;
    },
  } as unknown as CoreClient;
  return { core, calls };
}

function makeIngestRecordingCore(): { core: CoreClient; calls: IngestRequest[] } {
  const calls: IngestRequest[] = [];
  const core = {
    async ingest(req: IngestRequest) {
      calls.push(req);
      return { doc_ids: ["doc-1"], chunks: 1 };
    },
  } as unknown as CoreClient;
  return { core, calls };
}

async function withServer(deps: ServerDeps, fn: (port: number) => Promise<void>): Promise<void> {
  const server = createMindServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Same pattern as server-mode.test.ts: temporarily set COSMOS_TOKEN and restore it on exit.
async function withAuthServer(
  deps: ServerDeps,
  token: string,
  fn: (port: number) => Promise<void>
): Promise<void> {
  const prev = process.env.COSMOS_TOKEN;
  process.env.COSMOS_TOKEN = token;
  try {
    await withServer(deps, fn);
  } finally {
    if (prev === undefined) delete process.env.COSMOS_TOKEN;
    else process.env.COSMOS_TOKEN = prev;
  }
}

async function makeTempDataDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "cosmos-mind-test-"));
}

// ① ownerScopeFor 3-way branch + fixed admin namespace (independent of account name) + null (unauthenticated)
test("ownerScopeFor: admin→shared+admin(이름 무관 고정), member→shared+<이름>, null→shared", () => {
  assert.equal(ownerScopeFor({ name: "admin", role: "admin" }), "shared+admin");
  // Multiple admin accounts with different names still share the same fixed namespace.
  assert.equal(ownerScopeFor({ name: "charlie", role: "admin" } as Identity), "shared+admin");
  assert.equal(ownerScopeFor({ name: "alice", role: "member" }), "shared+alice");
  assert.equal(ownerScopeFor(null), "shared");
});

// ② /search: no token→shared, admin token→shared+admin, server overwrites any client-spoofed owner_scope
test("POST /search: COSMOS_TOKEN 설정 상태에서 토큰 없으면 core는 owner_scope=shared를 받는다", async () => {
  const { core, calls } = makeSearchRecordingCore();
  const deps: ServerDeps = { core, llm: NEVER_CALL_LLM };

  await withAuthServer(deps, "boot-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.owner_scope, "shared");
  });
});

test("POST /search: admin 토큰이면 core는 owner_scope=shared+admin을 받는다", async () => {
  const { core, calls } = makeSearchRecordingCore();
  const deps: ServerDeps = { core, llm: NEVER_CALL_LLM };

  await withAuthServer(deps, "boot-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer boot-token" },
      body: JSON.stringify({ query: "test" }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.owner_scope, "shared+admin");
  });
});

test("POST /search: 클라이언트가 body에 owner_scope를 위장 지정해도 서버가 계산한 값으로 덮어쓴다", async () => {
  const { core, calls } = makeSearchRecordingCore();
  const deps: ServerDeps = { core, llm: NEVER_CALL_LLM };

  await withAuthServer(deps, "boot-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", owner_scope: "shared+bob" }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    // No token -> null identity -> shared. The client-specified "shared+bob" is ignored.
    assert.equal(calls[0]?.owner_scope, "shared");
  });
});

// ③ member ingest: owner=self passes, owner=other 403, 403 if neither branch_id nor owner given (updated message)
test("POST /ingest: member가 owner=본인으로 지정하면 통과한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("mallory", "member", dataDir);
    const { core, calls } = makeIngestRecordingCore();
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };
    const doc = { origin: "https://example.com/doc", source_type: "manual", text: "hello world" };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ docs: [doc], owner: "mallory" }),
      });
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.owner, "mallory");
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /ingest: member가 owner=타인을 지정하면 403", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("nathan", "member", dataDir);
    const { core, calls } = makeIngestRecordingCore();
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };
    const doc = { origin: "https://example.com/doc", source_type: "manual", text: "hello world" };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ docs: [doc], owner: "someone-else" }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { message: string };
      assert.equal(body.message, "본인 개인 공간에만 업로드할 수 있습니다");
      assert.equal(calls.length, 0);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /ingest: member가 branch_id도 owner도 지정하지 않으면 403(갱신된 메시지)", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("olivia", "member", dataDir);
    const { core, calls } = makeIngestRecordingCore();
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };
    const doc = { origin: "https://example.com/doc", source_type: "manual", text: "hello world" };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ docs: [doc] }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { message: string };
      assert.equal(body.message, "팀원 업로드는 브랜치를 지정하거나 owner=본인으로 개인 공간에 업로드해야 합니다");
      assert.equal(calls.length, 0);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ④ admin ingest with owner="admin" passes
test("POST /ingest: admin이 owner=admin으로 지정하면 통과한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const { core, calls } = makeIngestRecordingCore();
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };
    const doc = { origin: "https://example.com/doc", source_type: "manual", text: "hello world" };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer boot-token" },
        body: JSON.stringify({ docs: [doc], owner: "admin" }),
      });
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.owner, "admin");
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /ingest: admin이 owner=admin이 아닌 다른 이름을 지정하면 403", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const { core, calls } = makeIngestRecordingCore();
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };
    const doc = { origin: "https://example.com/doc", source_type: "manual", text: "hello world" };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer boot-token" },
        body: JSON.stringify({ docs: [doc], owner: "not-admin" }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { message: string };
      assert.equal(body.message, "본인 개인 공간에만 업로드할 수 있습니다");
      assert.equal(calls.length, 0);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
