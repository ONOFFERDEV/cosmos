// M8.6 관리 콘솔: GET /slack/users, POST /invite 서버 테스트.
// CONTRACT.md "# M8.6 확장" 참고. server-mode.test.ts의 withServer/withAuthServer/
// makeTempDataDir 패턴을 그대로 복제한다(해당 파일은 읽기 전용 템플릿이라 수정 금지).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMindServer } from "./server.js";
import type { ServerDeps } from "./server.js";
import type { CoreClient } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { addUser } from "./users.js";

function makeEmptyCore(): CoreClient {
  return {
    async listEntities() {
      return [];
    },
    async listClusterDigests() {
      return [];
    },
    async route() {
      return { scores: [] };
    },
    async search() {
      return { results: [], stats: { num_bm25: 0, num_vec: 0, pool: 0, reranked: 0, secs: 0 } };
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

async function withSlackToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SLACK_BOT_TOKEN;
  if (token === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = token;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = prev;
  }
}

async function makeTempDataDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "cosmos-mind-test-"));
}

interface FakeSlackResult {
  ok: boolean;
  error?: string;
  members?: unknown[];
  channel?: { id: string };
  ts?: string;
}

/** invite.ts callSlack / server.ts fetchSlackUsers가 호출하는 슬랙 엔드포인트를 URL로 분기해 응답한다. */
function makeFakeSlackFetch(
  handlers: {
    usersList?: () => FakeSlackResult;
    conversationsOpen?: () => FakeSlackResult;
    chatPostMessage?: () => FakeSlackResult;
  },
  calls: string[]
): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    let payload: FakeSlackResult;
    if (u.includes("users.list")) {
      payload = handlers.usersList ? handlers.usersList() : { ok: true, members: [] };
    } else if (u.includes("conversations.open")) {
      payload = handlers.conversationsOpen ? handlers.conversationsOpen() : { ok: true, channel: { id: "C1" } };
    } else if (u.includes("chat.postMessage")) {
      payload = handlers.chatPostMessage ? handlers.chatPostMessage() : { ok: true, ts: "1.1" };
    } else if (u.includes("chat.delete")) {
      payload = { ok: true };
    } else {
      throw new Error(`unexpected slack call: ${u}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as unknown as Response;
  }) as typeof fetch;
}

const SAMPLE_MEMBERS = [
  { id: "U1", real_name: "김철수", is_bot: false, deleted: false, profile: { display_name: "chulsoo" } },
  { id: "U2", real_name: "박영희", is_bot: false, deleted: false, profile: { display_name: "younghee" } },
  { id: "U3", real_name: "김민준", is_bot: false, deleted: true, profile: { display_name: "minjun" } },
  { id: "U4", real_name: "봇계정", is_bot: true, deleted: false, profile: { display_name: "bot" } },
  { id: "USLACKBOT", real_name: "Slackbot", is_bot: false, deleted: false, profile: { display_name: "Slackbot" } },
];

test("GET /slack/users: member는 403", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("frank", "member", dataDir);
    const deps: ServerDeps = { core: makeEmptyCore(), llm: NEVER_CALL_LLM, dataDir };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/slack/users?q=김`, {
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      assert.equal(res.status, 403);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /slack/users: admin 200 + deleted/is_bot/USLACKBOT 제외 + real_name/display_name 필터", async () => {
  await withSlackToken("xoxb-test-token", async () => {
    const calls: string[] = [];
    const deps: ServerDeps = {
      core: makeEmptyCore(),
      llm: NEVER_CALL_LLM,
      fetchImpl: makeFakeSlackFetch({ usersList: () => ({ ok: true, members: SAMPLE_MEMBERS }) }, calls),
    };

    await withServer(deps, async (port) => {
      const byRealName = await fetch(`http://127.0.0.1:${port}/slack/users?q=${encodeURIComponent("김")}`);
      assert.equal(byRealName.status, 200);
      const realNameBody = (await byRealName.json()) as Array<{ id: string; real_name: string; display_name: string }>;
      assert.deepEqual(realNameBody, [{ id: "U1", real_name: "김철수", display_name: "chulsoo" }]);

      const byDisplayName = await fetch(`http://127.0.0.1:${port}/slack/users?q=young`);
      assert.equal(byDisplayName.status, 200);
      const displayNameBody = (await byDisplayName.json()) as Array<{ id: string }>;
      assert.deepEqual(displayNameBody, [{ id: "U2", real_name: "박영희", display_name: "younghee" }]);
    });
  });
});

test("GET /slack/users: SLACK_BOT_TOKEN 미설정 시 503", async () => {
  await withSlackToken(undefined, async () => {
    const deps: ServerDeps = { core: makeEmptyCore(), llm: NEVER_CALL_LLM };

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/slack/users?q=김`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { message: string };
      assert.equal(body.message, "슬랙 봇 미구성");
    });
  });
});

test("GET /slack/users: q 없으면 400", async () => {
  await withSlackToken("xoxb-test-token", async () => {
    const deps: ServerDeps = { core: makeEmptyCore(), llm: NEVER_CALL_LLM };

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/slack/users`);
      assert.equal(res.status, 400);
    });
  });
});

test("POST /invite: member는 403", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const memberToken = await addUser("grace", "member", dataDir);
    const deps: ServerDeps = { core: makeEmptyCore(), llm: NEVER_CALL_LLM, dataDir };

    await withAuthServer(deps, "boot-token", async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ name: "new-hire", slack_user_id: "U9" }),
      });
      assert.equal(res.status, 403);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /invite: 슬랙 발송 성공 시 {sent:true}, conversations.open+chat.postMessage 2콜", async () => {
  await withSlackToken("xoxb-test-token", async () => {
    const dataDir = await makeTempDataDir();
    try {
      const calls: string[] = [];
      const deps: ServerDeps = {
        core: makeEmptyCore(),
        llm: NEVER_CALL_LLM,
        dataDir,
        fetchImpl: makeFakeSlackFetch({}, calls),
      };

      await withAuthServer(deps, "boot-token", async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/invite`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer boot-token" },
          body: JSON.stringify({ name: "new-hire", slack_user_id: "U9" }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { sent: boolean };
        assert.equal(body.sent, true);
        assert.equal(calls.length, 2);
        assert.ok(calls[0].includes("conversations.open"));
        assert.ok(calls[1].includes("chat.postMessage"));
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("POST /invite: 슬랙 발송 실패 시 {sent:false, token}", async () => {
  await withSlackToken("xoxb-test-token", async () => {
    const dataDir = await makeTempDataDir();
    try {
      const deps: ServerDeps = {
        core: makeEmptyCore(),
        llm: NEVER_CALL_LLM,
        dataDir,
        fetchImpl: makeFakeSlackFetch({ conversationsOpen: () => ({ ok: false, error: "channel_not_found" }) }, []),
      };

      await withAuthServer(deps, "boot-token", async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/invite`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer boot-token" },
          body: JSON.stringify({ name: "new-hire-2", slack_user_id: "U10" }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { sent: boolean; token?: string };
        assert.equal(body.sent, false);
        assert.equal(typeof body.token, "string");
        assert.ok(body.token!.length > 0);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
