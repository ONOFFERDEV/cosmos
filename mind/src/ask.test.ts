// Fast /ask pipeline: query-expansion recall fallback (see runAsk in ask.ts).
// Live-measured root cause: a Korean question against English-only docs gets bm25=null +
// weak vectors, so the top rerank_score goes negative and shouldSkipLlmCall short-circuits
// to insufficient even though relevant docs exist. expandQuery() bridges KO<->EN with one
// LLM call and triggers exactly one global re-search before giving up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runAsk } from "./ask.js";
import type { CoreClient, SearchRequest, SearchResponse, SearchResult, RouteResponse } from "./core-client.js";
import type { LlmClient } from "./llm.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cosmos-ask-"));
}

function makeResult(rerank: number, origin = "origin://doc.md", bm25Rank: number | null = 1): SearchResult {
  return {
    chunk_id: "c1",
    doc_id: "d1",
    origin,
    text: "본문 내용",
    char_start: 0,
    char_end: 4,
    score: 1,
    stages: { bm25_rank: bm25Rank, vec_rank: 1, rrf_score: 1, rerank_score: rerank },
  };
}

/** Fake core whose search() response is keyed by the exact query string it receives; route() always no-ops. */
function fakeCore(searchByQuery: Record<string, SearchResponse>, defaultResponse: SearchResponse) {
  const searchCalls: SearchRequest[] = [];
  const core = {
    async route(): Promise<RouteResponse> {
      return { scores: [] };
    },
    async search(req: SearchRequest): Promise<SearchResponse> {
      searchCalls.push(req);
      return searchByQuery[req.query] ?? defaultResponse;
    },
  } as unknown as CoreClient;
  return { core, searchCalls };
}

/** Fake LLM that tells the expandQuery prompt apart from the answer prompt by content. */
function fakeLlm(opts: { expandKeywords?: string[] | null; answerCites?: number[] }) {
  const calls: string[] = [];
  const llm = {
    model: "stub",
    async complete(prompt: string): Promise<string> {
      calls.push(prompt);
      if (prompt.includes("핵심 검색 키워드")) {
        if (opts.expandKeywords == null) {
          return JSON.stringify({});
        }
        return JSON.stringify({ keywords: opts.expandKeywords });
      }
      const cites = opts.answerCites ?? [1];
      return JSON.stringify({ sentences: [{ text: "답변 문장", cites }], insufficient: false });
    },
  } as unknown as LlmClient;
  return { llm, calls };
}

test("expandQuery 폴백: 원 질의 리콜 실패 시 확장 재검색으로 답변을 구조한다", async () => {
  const negative: SearchResponse = {
    results: [makeResult(-2.6)],
    stats: { num_bm25: 0, num_vec: 1, pool: 1, reranked: 1, secs: 0 },
  };
  const positive: SearchResponse = {
    results: [makeResult(1.56, "origin://coupang-automation.md")],
    stats: { num_bm25: 1, num_vec: 1, pool: 1, reranked: 1, secs: 0 },
  };
  const question = "쿠팡 자동화 내용 알려줘";
  const expandedQuery = "쿠팡 coupang 자동화 automation";
  const { core, searchCalls } = fakeCore({ [question]: negative, [expandedQuery]: positive }, negative);
  const { llm, calls } = fakeLlm({ expandKeywords: ["쿠팡", "coupang", "자동화", "automation"] });

  const envelope = await runAsk(question, { core, llm, dataDir: await tempDir() });

  assert.equal(envelope.insufficient, false);
  assert.ok(envelope.sources.some((s) => s.origin === "origin://coupang-automation.md"));
  assert.equal(searchCalls.length, 2, "원 검색 + 확장 재검색 2회");
  assert.equal(searchCalls[1]?.query, expandedQuery);
  assert.equal(searchCalls[1]?.cluster_ids, undefined, "확장 재검색은 글로벌(클러스터 미지정)이어야 한다");
  assert.equal(calls.length, 2, "확장 LLM 1회 + 답변 LLM 1회");
  assert.ok(envelope.trace.some((t) => t.cluster === "query-expansion" && t.action === "consulted"));
});

test("확장 재검색도 여전히 근거 부족이면 insufficient를 유지한다 (정직성 보존)", async () => {
  // Negative rerank AND no BM25 hit (bm25_rank null) = genuinely ungrounded; must stay insufficient.
  const negative: SearchResponse = {
    results: [makeResult(-3.1, "origin://doc.md", null)],
    stats: { num_bm25: 0, num_vec: 1, pool: 1, reranked: 1, secs: 0 },
  };
  const question = "완전히 무관한 질문입니다";
  const { core, searchCalls } = fakeCore({}, negative); // every query, including the expanded one, stays negative
  const { llm, calls } = fakeLlm({ expandKeywords: ["무관", "unrelated"] });

  const envelope = await runAsk(question, { core, llm, dataDir: await tempDir() });

  assert.equal(envelope.insufficient, true);
  assert.equal(envelope.sources.length, 0);
  assert.equal(searchCalls.length, 2, "확장 재검색까지는 시도한다");
  assert.equal(calls.length, 1, "재검색도 근거 부족이면 답변 LLM 호출은 생략된다");
  assert.ok(!envelope.trace.some((t) => t.cluster === "query-expansion"), "구조 실패 시 trace에 기록하지 않는다");
});

test("확장 재검색 rerank<0라도 BM25 히트가 있으면 LLM에 위임한다 (리랭커 저평가 완화)", async () => {
  // Original query: negative, no BM25 hit -> triggers expansion.
  const originalMiss: SearchResponse = {
    results: [makeResult(-2.6, "origin://doc.md", null)],
    stats: { num_bm25: 0, num_vec: 1, pool: 1, reranked: 1, secs: 0 },
  };
  // Expanded re-search: rerank still NEGATIVE, but a real BM25 hit surfaces the coupang doc.
  const expandedBm25Hit: SearchResponse = {
    results: [makeResult(-0.65, "origin://coupang-wing-coupon-form.md", 2)],
    stats: { num_bm25: 1, num_vec: 1, pool: 1, reranked: 1, secs: 0 },
  };
  const question = "쿠팡 자동화 내용 알려줘";
  const expandedQuery = "쿠팡 coupang 쿠팡 윙 coupang wing 쿠폰 coupon";
  const { core, searchCalls } = fakeCore(
    { [question]: originalMiss, [expandedQuery]: expandedBm25Hit },
    originalMiss
  );
  const { llm, calls } = fakeLlm({ expandKeywords: ["쿠팡", "coupang", "쿠팡 윙", "coupang wing", "쿠폰", "coupon"] });

  const envelope = await runAsk(question, { core, llm, dataDir: await tempDir() });

  assert.equal(envelope.insufficient, false, "BM25 히트가 있으면 rerank 음수여도 답변한다");
  assert.ok(envelope.sources.some((s) => s.origin === "origin://coupang-wing-coupon-form.md"));
  assert.equal(calls.length, 2, "확장 LLM 1회 + 답변 LLM 1회");
  assert.ok(envelope.trace.some((t) => t.cluster === "query-expansion"));
});

test("원 검색에는 BM25 완화를 적용하지 않는다 (원 질의 rerank<0면 확장 경로로만)", async () => {
  // Original query: negative rerank WITH a BM25 hit. Relaxation must NOT apply here — the
  // original pass stays a pure-rerank gate, so this still routes into expansion. With expansion
  // returning null, the request ends up insufficient (proving the original BM25 hit was not honored).
  const originalNegWithBm25: SearchResponse = {
    results: [makeResult(-1.2, "origin://doc.md", 1)],
    stats: { num_bm25: 1, num_vec: 1, pool: 1, reranked: 1, secs: 0 },
  };
  const question = "원 검색만 약한 질문";
  const { core, searchCalls } = fakeCore({}, originalNegWithBm25);
  const { llm, calls } = fakeLlm({ expandKeywords: null }); // expansion yields nothing

  const envelope = await runAsk(question, { core, llm, dataDir: await tempDir() });

  assert.equal(envelope.insufficient, true, "원 검색의 BM25 히트는 완화 대상이 아니다");
  assert.equal(calls.length, 1, "확장 LLM만 호출(원 검색 BM25로는 답변하지 않음)");
  assert.equal(searchCalls.length, 1, "확장이 null이라 재검색은 없다");
});

test("확장 키워드 추출 실패(빈/malformed)면 재검색 없이 insufficient로 종료한다", async () => {
  const negative: SearchResponse = {
    results: [makeResult(-1.2)],
    stats: { num_bm25: 0, num_vec: 1, pool: 1, reranked: 1, secs: 0 },
  };
  const question = "쿠팡 자동화 내용 알려줘";
  const { core, searchCalls } = fakeCore({}, negative);
  const { llm, calls } = fakeLlm({}); // expandKeywords unset -> {} -> keywords missing -> expandQuery returns null

  const envelope = await runAsk(question, { core, llm, dataDir: await tempDir() });

  assert.equal(envelope.insufficient, true);
  assert.equal(searchCalls.length, 1, "확장 실패 시 재검색을 시도하지 않는다");
  assert.equal(calls.length, 1, "확장 시도 1회만 LLM 호출");
});

test("정상 질의(양의 rerank)는 확장을 트리거하지 않는다", async () => {
  const positive: SearchResponse = {
    results: [makeResult(1.2, "origin://coupang.md")],
    stats: { num_bm25: 1, num_vec: 1, pool: 1, reranked: 1, secs: 0 },
  };
  const question = "coupang automation";
  const { core, searchCalls } = fakeCore({}, positive);
  const { llm, calls } = fakeLlm({});

  const envelope = await runAsk(question, { core, llm, dataDir: await tempDir() });

  assert.equal(envelope.insufficient, false);
  assert.equal(searchCalls.length, 1, "확장 재검색이 발생하지 않는다 — 지연 회귀 없음");
  assert.equal(calls.length, 1, "답변 LLM 호출만 발생, 확장 LLM 호출 없음");
  assert.ok(!calls[0]?.includes("핵심 검색 키워드"));
});
