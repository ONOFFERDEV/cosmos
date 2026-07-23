// Server-level /ask mode override test. Confirms mode:"global"/"point" overrides
// the classifyIntent guess. Both cases leave the core response empty so the request
// short-circuits without an LLM call, letting us verify the mode branch alone without
// actually mocking the LLM.
// See CONTRACT.md "# M7 확장" section.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMindServer } from "./server.js";
import type { ServerDeps } from "./server.js";
import type {
  CoreClient,
  Entity,
  ClusterDigest,
  SearchResponse,
  RouteResponse,
  BranchSummary,
  DocSummary,
  IngestRequest,
} from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { addUser, listUsers, resolveIdentity, revokeUser } from "./users.js";

const EMPTY_SEARCH: SearchResponse = {
  results: [],
  stats: { num_bm25: 0, num_vec: 0, pool: 0, reranked: 0, secs: 0 },
};

function makeFakeCore(opts: { entities?: Entity[]; digests?: ClusterDigest[]; scores?: RouteResponse["scores"] }): CoreClient {
  return {
    async listEntities(): Promise<Entity[]> {
      return opts.entities ?? [];
    },
    async listClusterDigests(): Promise<ClusterDigest[]> {
      return opts.digests ?? [];
    },
    async route(): Promise<RouteResponse> {
      return { scores: opts.scores ?? [] };
    },
    async search(): Promise<SearchResponse> {
      return EMPTY_SEARCH;
    },
  } as unknown as CoreClient;
}

const NEVER_CALL_LLM: LlmClient = {
  model: "mock",
  async complete(): Promise<string> {
    throw new Error("이 시나리오에서는 LLM이 호출되면 안 됩니다.");
  },
};

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

// M8: temporarily set COSMOS_TOKEN to force token-based role branching, restoring
// it on exit. Never touch this for the two existing mode tests, since they rely on
// COSMOS_TOKEN being unset (everyone is admin).
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

function makeBranchFakeCore(opts: {
  branches?: BranchSummary[];
  docs?: DocSummary[];
  ingestCalls?: IngestRequest[];
} = {}): CoreClient {
  const ingestCalls = opts.ingestCalls ?? [];
  return {
    async listEntities(): Promise<Entity[]> {
      return [];
    },
    async listClusterDigests(): Promise<ClusterDigest[]> {
      return [];
    },
    async route(): Promise<RouteResponse> {
      return { scores: [] };
    },
    async search(): Promise<SearchResponse> {
      return EMPTY_SEARCH;
    },
    async listBranches(): Promise<BranchSummary[]> {
      return opts.branches ?? [];
    },
    async getBranchDocs(): Promise<DocSummary[]> {
      return opts.docs ?? [];
    },
    async createBranch(req: { name: string; created_by?: string }): Promise<BranchSummary> {
      return { id: "b-new", name: req.name, status: "open", created_at: new Date().toISOString() };
    },
    async mergeBranch(): Promise<{ merged: number; remaining: number }> {
      return { merged: 1, remaining: 0 };
    },
    async discardBranch(branchId: string): Promise<BranchSummary> {
      return { id: branchId, name: "discarded-branch", status: "discarded", created_at: new Date().toISOString() };
    },
    async ingest(req: IngestRequest) {
      ingestCalls.push(req);
      return { doc_ids: ["doc-1"], chunks: 1 };
    },
  } as unknown as CoreClient;
}

test("mode:global은 point 형태 질문에도 global 파이프라인을 강제한다", async () => {
  const core = makeFakeCore({ entities: [], digests: [] });
  const deps: ServerDeps = { core, llm: NEVER_CALL_LLM };

  await withServer(deps, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "docseal 설계 핵심이 뭐야?", mode: "global" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { mode: string; insufficient: boolean; cost: { llm_calls: number } };
    assert.equal(body.mode, "global");
    assert.equal(body.insufficient, true);
    assert.equal(body.cost.llm_calls, 0);
  });
});

test("mode:point는 global 형태 질문에도 fast 파이프라인을 강제한다", async () => {
  const core = makeFakeCore({ scores: [] });
  const deps: ServerDeps = { core, llm: NEVER_CALL_LLM };

  await withServer(deps, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "프로젝트 전체 목록을 보여줘", mode: "point" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { mode: string; insufficient: boolean; cost: { llm_calls: number } };
    assert.equal(body.mode, "fast");
    assert.equal(body.insufficient, true);
    assert.equal(body.cost.llm_calls, 0);
  });
});

// --- M8: users/roles, branch proxying, inbox 410 deprecation ---
// See CONTRACT.md "# M8 확장" section "## mind: 사용자·역할".

test("GET /me: COSMOS_TOKEN 미설정 시 토큰 없이도 부트스트랩 admin으로 응답한다", async () => {
  const core = makeBranchFakeCore();
  const deps: ServerDeps = { core, llm: NEVER_CALL_LLM };

  await withServer(deps, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/me`);
    assert.equal(res.status, 200);
    const body = await res.json() as { name: string; role: string };
    assert.equal(body.name, "admin");
    assert.equal(body.role, "admin");
  });
});

test("GET /me: 등록된 member 토큰은 자신의 name/role을 반환한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("alice", "member", dataDir);
    const core = makeBranchFakeCore();
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/me`, {
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { name: string; role: string };
      assert.equal(body.name, "alice");
      assert.equal(body.role, "member");
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /me: COSMOS_TOKEN 설정 시 토큰 없으면 401", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = makeBranchFakeCore();
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/me`);
      assert.equal(res.status, 401);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /ask: member 토큰도 허용된다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("bob", "member", dataDir);
    const core = makeFakeCore({ entities: [], digests: [] });
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ question: "테스트 질문", mode: "global" }),
      });
      assert.equal(res.status, 200);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /ask: COSMOS_TOKEN 설정 시 토큰 없으면 401", async () => {
  const core = makeFakeCore({ entities: [], digests: [] });
  const deps: ServerDeps = { core, llm: NEVER_CALL_LLM };

  await withAuthServer(deps, "boot-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "테스트 질문", mode: "global" }),
    });
    assert.equal(res.status, 401);
  });
});

test("GET /branches, GET /branches/{id}/docs, POST /branches: member 토큰도 허용된다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("carol", "member", dataDir);
    const core = makeBranchFakeCore({
      branches: [{ id: "b-1", name: "collect/2026-07-14", status: "open", created_at: new Date().toISOString() }],
    });
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };

    await withAuthServer(deps, "boot-token", async (port) => {
      const listRes = await fetch(`http://127.0.0.1:${port}/branches`, {
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      assert.equal(listRes.status, 200);

      const docsRes = await fetch(`http://127.0.0.1:${port}/branches/b-1/docs`, {
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      assert.equal(docsRes.status, 200);

      const createRes = await fetch(`http://127.0.0.1:${port}/branches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ name: "my-branch" }),
      });
      assert.equal(createRes.status, 200);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /branches/{id}/merge, discard: member는 403, admin은 200", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("dave", "member", dataDir);
    const core = makeBranchFakeCore();
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };

    await withAuthServer(deps, "boot-token", async (port) => {
      const memberMerge = await fetch(`http://127.0.0.1:${port}/branches/b-1/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: "{}",
      });
      assert.equal(memberMerge.status, 403);
      const memberMergeBody = await memberMerge.json() as { message: string };
      assert.equal(memberMergeBody.message, "관리자 권한이 필요합니다");

      const memberDiscard = await fetch(`http://127.0.0.1:${port}/branches/b-1/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: "{}",
      });
      assert.equal(memberDiscard.status, 403);

      const adminMerge = await fetch(`http://127.0.0.1:${port}/branches/b-1/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer boot-token" },
        body: "{}",
      });
      assert.equal(adminMerge.status, 200);

      const adminDiscard = await fetch(`http://127.0.0.1:${port}/branches/b-1/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer boot-token" },
        body: "{}",
      });
      assert.equal(adminDiscard.status, 200);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /ingest: member는 branch_id 없으면 403, branch_id 있으면 200. admin은 branch_id 없어도 200", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("erin", "member", dataDir);
    const core = makeBranchFakeCore();
    const deps: ServerDeps = { core, llm: NEVER_CALL_LLM, dataDir };

    const doc = { origin: "https://example.com/doc", source_type: "manual", text: "hello world" };

    await withAuthServer(deps, "boot-token", async (port) => {
      const memberNoBranch = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ docs: [doc] }),
      });
      assert.equal(memberNoBranch.status, 403);
      const memberNoBranchBody = await memberNoBranch.json() as { message: string };
      // M9: the rule was extended to require either branch_id or owner=self, and the message was updated accordingly (see CONTRACT.md "# M9 확장" mind section).
      assert.equal(memberNoBranchBody.message, "팀원 업로드는 브랜치를 지정하거나 owner=본인으로 개인 공간에 업로드해야 합니다");

      const memberWithBranch = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ docs: [doc], branch_id: "b-1" }),
      });
      assert.equal(memberWithBranch.status, 200);

      const adminNoBranch = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer boot-token" },
        body: JSON.stringify({ docs: [doc] }),
      });
      assert.equal(adminNoBranch.status, 200);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /search: Authorization 헤더 없이도(COSMOS_TOKEN 설정 상태에서도) 공개 접근 가능하다", async () => {
  const core = makeBranchFakeCore();
  const deps: ServerDeps = { core, llm: NEVER_CALL_LLM };

  await withAuthServer(deps, "boot-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 403);
  });
});

test("GET /inbox, POST /inbox/{id}/approve, POST /inbox/{id}/reject: 인증 없이도 항상 410 Gone", async () => {
  const core = makeBranchFakeCore();
  const deps: ServerDeps = { core, llm: NEVER_CALL_LLM };
  const INBOX_GONE_MESSAGE = "브랜치 검토로 일원화되었습니다 — 웹 검토 화면 또는 /branches 사용";

  await withServer(deps, async (port) => {
    const listRes = await fetch(`http://127.0.0.1:${port}/inbox`);
    assert.equal(listRes.status, 410);
    const listBody = await listRes.json() as { message: string };
    assert.equal(listBody.message, INBOX_GONE_MESSAGE);

    const approveRes = await fetch(`http://127.0.0.1:${port}/inbox/cand-1/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(approveRes.status, 410);
    const approveBody = await approveRes.json() as { message: string };
    assert.equal(approveBody.message, INBOX_GONE_MESSAGE);

    const rejectRes = await fetch(`http://127.0.0.1:${port}/inbox/cand-1/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(rejectRes.status, 410);
    const rejectBody = await rejectRes.json() as { message: string };
    assert.equal(rejectBody.message, INBOX_GONE_MESSAGE);
  });
});

test("users.ts: addUser -> resolveIdentity -> revokeUser -> resolveIdentity 왕복", async () => {
  const dataDir = await makeTempDataDir();
  const prev = process.env.COSMOS_TOKEN;
  process.env.COSMOS_TOKEN = "boot-token";
  try {
    const token = await addUser("frank", "member", dataDir);

    const found = await resolveIdentity(token, dataDir);
    assert.deepEqual(found, { name: "frank", role: "member" });

    const wrong = await resolveIdentity("wrong-token", dataDir);
    assert.equal(wrong, null);

    const revoked = await revokeUser("frank", dataDir);
    assert.equal(revoked, true);

    const afterRevoke = await resolveIdentity(token, dataDir);
    assert.equal(afterRevoke, null);

    const users = await listUsers(dataDir);
    const frank = users.find((u) => u.name === "frank");
    assert.ok(frank);
    assert.ok(frank.revoked_at);
  } finally {
    if (prev === undefined) delete process.env.COSMOS_TOKEN;
    else process.env.COSMOS_TOKEN = prev;
    await rm(dataDir, { recursive: true, force: true });
  }
});
