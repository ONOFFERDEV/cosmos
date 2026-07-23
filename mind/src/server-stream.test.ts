// Tests for the /ask/stream SSE endpoint. Confirms the onProgress hook flows out as SSE status
// events, stage ordering matches the contract, the token gate applies the same as /ask, and
// there's no regression on the existing /ask. See CONTRACT.md "# M7.5 확장" section.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createMindServer } from "./server.js";
import type { ServerDeps } from "./server.js";
import type { CoreClient, Entity, ClusterDigest, SearchResponse } from "./core-client.js";
import type { LlmClient } from "./llm.js";

const EMPTY_SEARCH: SearchResponse = {
  results: [],
  stats: { num_bm25: 0, num_vec: 0, pool: 0, reranked: 0, secs: 0 },
};

function makeEmptyCore(): CoreClient {
  return {
    async listEntities(): Promise<Entity[]> {
      return [];
    },
    async listClusterDigests(): Promise<ClusterDigest[]> {
      return [];
    },
    async search(): Promise<SearchResponse> {
      return EMPTY_SEARCH;
    },
  } as unknown as CoreClient;
}

const ENTITIES: Entity[] = [
  { doc_id: "d1", name: "Psyfi", kind: "project", origin: "notion://psyfi", status: "출시 준비" },
];

function makeNonEmptyCore(): CoreClient {
  return {
    async listEntities(): Promise<Entity[]> {
      return ENTITIES;
    },
    async listClusterDigests(): Promise<ClusterDigest[]> {
      return [];
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

const STUB_GLOBAL_LLM: LlmClient = {
  model: "mock-sonnet",
  async complete(): Promise<string> {
    return JSON.stringify({
      sentences: [{ text: "Psyfi는 출시 준비 상태다.", cites: [1] }],
      insufficient: false,
    });
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

type SseEvent = { event: string; data: unknown };

/** Parses the full SSE response text into an array of event/data pairs. Skips ":ka" keep-alive comment lines. */
function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data = line.slice("data: ".length);
    }
    if (!event) continue;
    events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

test("POST /ask/stream: status 이벤트가 envelope보다 먼저 오고, envelope은 정확히 1회, 스트림이 종료된다", async () => {
  const deps: ServerDeps = { core: makeEmptyCore(), llm: NEVER_CALL_LLM };

  await withServer(deps, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ask/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "전체 프로젝트 현황 보여줘", mode: "global" }),
    });
    assert.equal(res.status, 200);
    const events = parseSseEvents(await res.text());

    const envelopeIdx = events.findIndex((e) => e.event === "envelope");
    assert.ok(envelopeIdx >= 0, "envelope 이벤트가 있어야 한다");
    assert.equal(events.filter((e) => e.event === "envelope").length, 1);

    const statusBeforeEnvelope = events.slice(0, envelopeIdx).filter((e) => e.event === "status");
    assert.ok(statusBeforeEnvelope.length >= 1, "status 이벤트가 envelope보다 먼저 최소 1개 있어야 한다");
  });
});

test("global 모드 status 이벤트 순서는 registry -> digests -> search -> synthesize -> assemble이다", async () => {
  const deps: ServerDeps = { core: makeNonEmptyCore(), llm: STUB_GLOBAL_LLM };

  await withServer(deps, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ask/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "전체 프로젝트 현황 보여줘", mode: "global" }),
    });
    assert.equal(res.status, 200);
    const events = parseSseEvents(await res.text());

    const stages = events.filter((e) => e.event === "status").map((e) => (e.data as { stage: string }).stage);
    assert.deepEqual(stages, ["registry", "digests", "search", "synthesize", "assemble"]);

    const envelopeEvents = events.filter((e) => e.event === "envelope");
    assert.equal(envelopeEvents.length, 1);
    const envelope = envelopeEvents[0].data as { mode: string; cost: { llm_calls: number } };
    assert.equal(envelope.mode, "global");
    assert.equal(envelope.cost.llm_calls, 1);
  });
});

test("COSMOS_TOKEN 설정 시 무토큰 POST /ask/stream은 401을 반환한다", async () => {
  const savedToken = process.env.COSMOS_TOKEN;
  process.env.COSMOS_TOKEN = "secret-stream-token";
  const deps: ServerDeps = { core: makeEmptyCore(), llm: NEVER_CALL_LLM };

  try {
    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/ask/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "전체 프로젝트 현황 보여줘", mode: "global" }),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body["message"], "인증 토큰이 필요합니다");
    });
  } finally {
    if (savedToken === undefined) delete process.env.COSMOS_TOKEN;
    else process.env.COSMOS_TOKEN = savedToken;
  }
});

test("회귀: 기존 POST /ask는 리팩터 이후에도 동일한 응답 구조를 유지한다", async () => {
  const deps: ServerDeps = { core: makeEmptyCore(), llm: NEVER_CALL_LLM };

  await withServer(deps, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "전체 프로젝트 현황 보여줘", mode: "global" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mode: string; insufficient: boolean; cost: { llm_calls: number } };
    assert.equal(body.mode, "global");
    assert.equal(body.insufficient, true);
    assert.equal(body.cost.llm_calls, 0);
  });
});
