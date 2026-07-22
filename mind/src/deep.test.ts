import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEEP_BUSY_MESSAGE,
  DEEP_CLUSTER_BUDGET,
  DEEP_AGENT_CONCURRENCY,
  normalizePlannerOutput,
  applyBudgetCut,
  normalizeBriefClaims,
  runDeepAsk,
} from "./deep.js";
import type { PlannerSubquestion, PlannerSkip } from "./deep.js";
import type {
  CoreClient,
  ClusterSummary,
  RouteScore,
  RouteResponse,
  SearchRequest,
  SearchResponse,
  HealthResponse,
  BootstrapResponse,
  IngestResponse,
} from "./core-client.js";
import type { LlmClient, ModelAlias } from "./llm.js";
import { BLOCK_MESSAGE } from "./guard.js";

function cluster(id: string, slug: string, opts: Partial<ClusterSummary> = {}): ClusterSummary {
  return { id, slug, status: "active", n_docs: 1, n_chunks: 1, ...opts };
}

function routeScore(clusterId: string, slug: string, centroidSim: number, bm25Hits = 0): RouteScore {
  return { cluster_id: clusterId, slug, centroid_sim: centroidSim, bm25_hits: bm25Hits };
}

function searchResponse(items: { origin: string; text: string }[]): SearchResponse {
  return {
    results: items.map((it, i) => ({
      chunk_id: `chunk-${i}`,
      doc_id: `doc-${i}`,
      origin: it.origin,
      text: it.text,
      char_start: 0,
      char_end: it.text.length,
      score: 1,
      stages: { bm25_rank: 1, vec_rank: 1, rrf_score: 1, rerank_score: 1 },
    })),
    stats: { num_bm25: items.length, num_vec: items.length, pool: items.length, reranked: items.length, secs: 0.01 },
  };
}

class MockCoreClient {
  searchCalls: SearchRequest[] = [];
  constructor(
    private readonly clusters: ClusterSummary[],
    private readonly routeResp: RouteResponse,
    private readonly searchByClusterId: Map<string, SearchResponse>
  ) {}
  async listClusters(): Promise<ClusterSummary[]> {
    return this.clusters;
  }
  async route(_query: string): Promise<RouteResponse> {
    return this.routeResp;
  }
  async search(req: SearchRequest): Promise<SearchResponse> {
    this.searchCalls.push(req);
    const clusterId = req.cluster_ids?.[0] ?? "";
    return this.searchByClusterId.get(clusterId) ?? searchResponse([]);
  }
  async health(): Promise<HealthResponse> {
    throw new Error("MockCoreClient: health 미구현");
  }
  async bootstrapClusters(): Promise<BootstrapResponse> {
    throw new Error("MockCoreClient: bootstrapClusters 미구현");
  }
  async updateCluster(): Promise<ClusterSummary> {
    throw new Error("MockCoreClient: updateCluster 미구현");
  }
  async ingest(): Promise<IngestResponse> {
    throw new Error("MockCoreClient: ingest 미구현");
  }
}

class MockLlmClient {
  readonly model = "sonnet";
  calls: { prompt: string; model?: ModelAlias }[] = [];
  plannerResponse: unknown = { subquestions: [], skipped: [], strategy: "" };
  briefResponder: (prompt: string) => unknown = () => ({ claims: [], gaps: [] });
  rebuttalResponder: (prompt: string) => unknown = () => ({ claims: [], gaps: [] });
  synthesis1Response: unknown = { sentences: [], insufficient: false, contradictions: [] };
  synthesis2Response: unknown = { sentences: [], insufficient: false, contradictions: [] };

  async complete(prompt: string, model?: ModelAlias): Promise<string> {
    this.calls.push({ prompt, model });
    if (prompt.includes("클러스터 카탈로그:")) {
      return JSON.stringify(this.plannerResponse);
    }
    if (prompt.includes("클러스터별 브리프:")) {
      return JSON.stringify(prompt.includes("2차(최종)") ? this.synthesis2Response : this.synthesis1Response);
    }
    if (prompt.includes("상대 클러스터의 상충 주장")) {
      return JSON.stringify(this.rebuttalResponder(prompt));
    }
    return JSON.stringify(this.briefResponder(prompt));
  }
}

/**
 * 브리프 콜(클러스터 에이전트)에 인위적 지연을 주고 동시 실행 수를 추적하는 mock.
 * DEEP_AGENT_CONCURRENCY 풀이 실제로 동시 2개를 넘지 않는지, 그리고 완료 순서가
 * 뒤섞여도 브리프-클러스터 매핑이 흔들리지 않는지 검증하는 데 쓴다.
 */
class ConcurrencyTrackingLlmClient {
  readonly model = "sonnet";
  calls: { prompt: string; model?: ModelAlias }[] = [];
  plannerResponse: unknown = { subquestions: [], skipped: [], strategy: "" };
  briefResponder: (prompt: string) => unknown = () => ({ claims: [], gaps: [] });
  briefDelayMs: (prompt: string) => number = () => 0;
  synthesis1Response: unknown = { sentences: [], insufficient: false, contradictions: [] };

  activeConcurrent = 0;
  maxConcurrentObserved = 0;

  async complete(prompt: string, model?: ModelAlias): Promise<string> {
    this.calls.push({ prompt, model });
    if (prompt.includes("클러스터 카탈로그:")) {
      return JSON.stringify(this.plannerResponse);
    }
    if (prompt.includes("클러스터별 브리프:")) {
      return JSON.stringify(this.synthesis1Response);
    }
    this.activeConcurrent += 1;
    this.maxConcurrentObserved = Math.max(this.maxConcurrentObserved, this.activeConcurrent);
    try {
      const delayMs = this.briefDelayMs(prompt);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return JSON.stringify(this.briefResponder(prompt));
    } finally {
      this.activeConcurrent -= 1;
    }
  }
}

// (a) 플래너 커버리지 보정 -----------------------------------------------

test("(a) 플래너 응답에서 누락된 active 클러스터는 자동으로 skipped 처리된다", () => {
  const activeClusters = [cluster("c1", "cluster-a"), cluster("c2", "cluster-b"), cluster("c3", "cluster-c")];
  const raw = {
    subquestions: [
      { cluster_slug: "cluster-a", question: "질문A" },
      { cluster_slug: "cluster-b", question: "중복 슬러그" },
    ],
    skipped: [
      { cluster_slug: "cluster-b", why: "이유가 무시되어야 함" },
      { cluster_slug: "cluster-unknown", why: "존재하지 않는 클러스터" },
    ],
  };

  const result = normalizePlannerOutput(raw, activeClusters);

  assert.deepEqual(
    result.subquestions.map((s) => s.cluster_slug).sort(),
    ["cluster-a", "cluster-b"]
  );
  assert.equal(
    result.skipped.some((s) => s.cluster_slug === "cluster-b"),
    false
  );
  assert.equal(
    result.skipped.some((s) => s.cluster_slug === "cluster-unknown"),
    false
  );
  const cSkip = result.skipped.find((s) => s.cluster_slug === "cluster-c");
  assert.ok(cSkip);
  assert.equal(cSkip!.why, "플래너 응답 누락 — 자동 보정으로 skipped 처리");

  const allSlugs = [
    ...result.subquestions.map((s) => s.cluster_slug),
    ...result.skipped.map((s) => s.cluster_slug),
  ].sort();
  assert.deepEqual(allSlugs, ["cluster-a", "cluster-b", "cluster-c"]);
});

// (b) K>4 예산 컷 ---------------------------------------------------------

test("(b) 참여 클러스터가 예산(K=4)을 초과하면 라우팅 점수 상위 4개만 남긴다", () => {
  const subquestions: PlannerSubquestion[] = [
    { cluster_slug: "cluster-a", question: "qa" },
    { cluster_slug: "cluster-b", question: "qb" },
    { cluster_slug: "cluster-c", question: "qc" },
    { cluster_slug: "cluster-d", question: "qd" },
    { cluster_slug: "cluster-e", question: "qe" },
  ];
  const skipped: PlannerSkip[] = [];
  const routeScores: RouteScore[] = [
    routeScore("c1", "cluster-a", 0.9),
    routeScore("c2", "cluster-b", 0.8),
    routeScore("c3", "cluster-c", 0.7),
    routeScore("c4", "cluster-d", 0.6),
    routeScore("c5", "cluster-e", 0.95),
  ];

  const result = applyBudgetCut(subquestions, skipped, routeScores);

  assert.equal(result.subquestions.length, DEEP_CLUSTER_BUDGET);
  assert.deepEqual(
    result.subquestions.map((s) => s.cluster_slug),
    ["cluster-e", "cluster-a", "cluster-b", "cluster-c"]
  );
  const cut = result.skipped.find((s) => s.cluster_slug === "cluster-d");
  assert.ok(cut);
  assert.equal(cut!.why, "예산 컷");
});

// (c) 브리프 파싱 — cites 없는 claim은 드랍 ---------------------------------

test("(c) cites가 없거나 유효하지 않은 claim은 드랍된다", () => {
  const maxCiteNumber = 3;
  const raw = [
    { text: "유효한 주장", cites: [1, 2], confidence: 0.8 },
    { text: "cites 없는 주장", cites: [] },
    { text: "cites 필드 자체가 없는 주장" },
    { text: "범위 밖 인용만 있는 주장", cites: [99] },
    { text: "일부만 유효한 인용", cites: [2, 99] },
    { text: 123, cites: [1] },
  ];

  const claims = normalizeBriefClaims(raw, maxCiteNumber);

  assert.equal(claims.length, 2);
  assert.equal(claims[0]!.text, "유효한 주장");
  assert.deepEqual(claims[0]!.cites, [1, 2]);
  assert.equal(claims[0]!.confidence, 0.8);
  assert.equal(claims[1]!.text, "일부만 유효한 인용");
  assert.deepEqual(claims[1]!.cites, [2]);
  assert.equal(claims[1]!.confidence, undefined);
});

// 공통 deps 빌더 ------------------------------------------------------------

function buildSimpleDeps(): { core: MockCoreClient; llm: MockLlmClient } {
  const clusters = [cluster("c1", "cluster-a")];
  const routeResp: RouteResponse = { scores: [routeScore("c1", "cluster-a", 0.9, 5)] };
  const searchByClusterId = new Map([["c1", searchResponse([{ origin: "doc1.md", text: "본문1" }])]]);
  const core = new MockCoreClient(clusters, routeResp, searchByClusterId);

  const llm = new MockLlmClient();
  llm.plannerResponse = {
    subquestions: [{ cluster_slug: "cluster-a", question: "하위질문A" }],
    skipped: [],
    strategy: "단일 클러스터 협의",
  };
  llm.briefResponder = () => ({ claims: [{ text: "주장1", cites: [1], confidence: 0.9 }], gaps: [] });
  llm.synthesis1Response = { sentences: [{ text: "답변문장", cites: [1] }], insufficient: false, contradictions: [] };

  return { core, llm };
}

// (d) 모순 없음 → 종합 1회 ---------------------------------------------------

test("(d) 모순이 없으면 종합 콜은 1회만 실행된다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-deep-test-"));
  try {
    const { core, llm } = buildSimpleDeps();
    const envelope = await runDeepAsk("전체 질문", {
      core: core as unknown as CoreClient,
      llm: llm as unknown as LlmClient,
      dataDir,
    });

    assert.equal(envelope.mode, "deep");
    assert.equal(envelope.insufficient, false);
    assert.equal(envelope.cost.llm_calls, 3);
    assert.equal(envelope.cost.stages?.["synthesis_2"], undefined);
    assert.equal(
      llm.calls.filter((c) => c.prompt.includes("상대 클러스터의 상충 주장")).length,
      0
    );
    assert.equal(
      llm.calls.filter((c) => c.prompt.includes("클러스터별 브리프:")).length,
      1
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// (e) 모순 발견 → 반박 1회 + 종합 2회 ------------------------------------------

function buildContradictionDeps(): { core: MockCoreClient; llm: MockLlmClient } {
  const clusters = [cluster("c1", "cluster-a"), cluster("c2", "cluster-b")];
  const routeResp: RouteResponse = {
    scores: [routeScore("c1", "cluster-a", 0.9, 5), routeScore("c2", "cluster-b", 0.8, 3)],
  };
  const searchByClusterId = new Map([
    ["c1", searchResponse([{ origin: "a.md", text: "A본문" }])],
    ["c2", searchResponse([{ origin: "b.md", text: "B본문" }])],
  ]);
  const core = new MockCoreClient(clusters, routeResp, searchByClusterId);

  const llm = new MockLlmClient();
  llm.plannerResponse = {
    subquestions: [
      { cluster_slug: "cluster-a", question: "하위질문A" },
      { cluster_slug: "cluster-b", question: "하위질문B" },
    ],
    skipped: [],
    strategy: "두 클러스터 협의",
  };
  llm.briefResponder = (prompt) =>
    prompt.includes("하위질문A")
      ? { claims: [{ text: "주장A", cites: [1] }], gaps: [] }
      : { claims: [{ text: "주장B", cites: [1] }], gaps: [] };
  llm.synthesis1Response = {
    sentences: [],
    insufficient: false,
    contradictions: [
      { a_cluster: "cluster-a", a_claim: "주장A", b_cluster: "cluster-b", b_claim: "주장B", issue: "상충" },
    ],
  };
  llm.rebuttalResponder = (prompt) =>
    prompt.includes("하위질문A")
      ? { claims: [{ text: "수정된 주장A", cites: [1] }], gaps: [] }
      : { claims: [{ text: "수정된 주장B", cites: [1] }], gaps: [] };
  llm.synthesis2Response = {
    sentences: [{ text: "최종 답변", cites: [1] }],
    insufficient: false,
    contradictions: [],
  };

  return { core, llm };
}

test("(e) 모순 발견 시 반박 1회 + 종합 2회가 실행된다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-deep-test-"));
  try {
    const { core, llm } = buildContradictionDeps();
    const envelope = await runDeepAsk("전체 질문", {
      core: core as unknown as CoreClient,
      llm: llm as unknown as LlmClient,
      dataDir,
    });

    const rebuttalCalls = llm.calls.filter((c) => c.prompt.includes("상대 클러스터의 상충 주장"));
    const synthesisCalls = llm.calls.filter((c) => c.prompt.includes("클러스터별 브리프:"));
    assert.equal(rebuttalCalls.length, 2);
    assert.equal(synthesisCalls.length, 2);
    assert.equal(envelope.cost.llm_calls, 7);
    assert.notEqual(envelope.cost.stages?.["synthesis_2"], undefined);
    assert.equal(envelope.insufficient, false);
    assert.ok(envelope.answer.includes("최종 답변"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// (f) 전 브리프 claims 합계 0 → 종합 생략, 차단 ------------------------------

test("(f) 전 브리프 claims 합계가 0이면 종합 콜 없이 차단된다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-deep-test-"));
  try {
    const clusters = [cluster("c1", "cluster-a")];
    const routeResp: RouteResponse = { scores: [routeScore("c1", "cluster-a", 0.5, 0)] };
    const searchByClusterId = new Map([["c1", searchResponse([{ origin: "doc1.md", text: "본문1" }])]]);
    const core = new MockCoreClient(clusters, routeResp, searchByClusterId);

    const llm = new MockLlmClient();
    llm.plannerResponse = {
      subquestions: [{ cluster_slug: "cluster-a", question: "하위질문A" }],
      skipped: [],
      strategy: "단일 클러스터",
    };
    llm.briefResponder = () => ({ claims: [], gaps: ["근거 부족"] });

    const envelope = await runDeepAsk("답할 수 없는 질문", {
      core: core as unknown as CoreClient,
      llm: llm as unknown as LlmClient,
      dataDir,
    });

    assert.equal(envelope.insufficient, true);
    assert.equal(envelope.answer, BLOCK_MESSAGE);
    assert.equal(
      llm.calls.filter((c) => c.prompt.includes("클러스터별 브리프:")).length,
      0
    );
    assert.equal(envelope.cost.llm_calls, 2);
    assert.equal(envelope.cost.stages?.["synthesis_1"], 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// (g) 전역 재번호 + trace 완전성 ---------------------------------------------

test("(g) 전역 재번호와 trace 완전성을 갖춘 봉투를 조립한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-deep-test-"));
  try {
    const clusters = [cluster("c1", "cluster-a"), cluster("c2", "cluster-b"), cluster("c3", "cluster-c")];
    const routeResp: RouteResponse = {
      scores: [
        routeScore("c1", "cluster-a", 0.9, 5),
        routeScore("c2", "cluster-b", 0.8, 3),
        routeScore("c3", "cluster-c", 0.1, 0),
      ],
    };
    const searchByClusterId = new Map([
      [
        "c1",
        searchResponse([
          { origin: "a1.md", text: "A첫번째" },
          { origin: "a2.md", text: "A두번째" },
        ]),
      ],
      ["c2", searchResponse([{ origin: "b1.md", text: "B첫번째" }])],
    ]);
    const core = new MockCoreClient(clusters, routeResp, searchByClusterId);

    const llm = new MockLlmClient();
    llm.plannerResponse = {
      subquestions: [
        { cluster_slug: "cluster-a", question: "하위질문A" },
        { cluster_slug: "cluster-b", question: "하위질문B" },
      ],
      skipped: [{ cluster_slug: "cluster-c", why: "관련 없음" }],
      strategy: "전략",
    };
    llm.briefResponder = (prompt) =>
      prompt.includes("하위질문A")
        ? { claims: [{ text: "주장A1", cites: [2] }], gaps: [] }
        : { claims: [{ text: "주장B1", cites: [1] }], gaps: [] };
    llm.synthesis1Response = {
      sentences: [
        { text: "종합문장1", cites: [2] },
        { text: "종합문장2", cites: [3] },
      ],
      insufficient: false,
      contradictions: [],
    };

    const envelope = await runDeepAsk("전체 질문", {
      core: core as unknown as CoreClient,
      llm: llm as unknown as LlmClient,
      dataDir,
    });

    assert.equal(envelope.sources.length, 2);
    assert.equal(envelope.sources[0]!.n, 1);
    assert.equal(envelope.sources[0]!.origin, "a2.md");
    assert.equal(envelope.sources[1]!.n, 2);
    assert.equal(envelope.sources[1]!.origin, "b1.md");
    assert.deepEqual(envelope.sentences[0]!.cites, [1]);
    assert.deepEqual(envelope.sentences[1]!.cites, [2]);

    assert.equal(envelope.trace.length, 3);
    const traceBySlug = new Map(envelope.trace.map((t) => [t.cluster, t]));
    assert.equal(traceBySlug.get("cluster-a")?.action, "consulted");
    assert.equal(traceBySlug.get("cluster-a")?.subquestion, "하위질문A");
    assert.equal(traceBySlug.get("cluster-a")?.claims, 1);
    assert.equal(traceBySlug.get("cluster-b")?.action, "consulted");
    assert.equal(traceBySlug.get("cluster-b")?.claims, 1);
    assert.equal(traceBySlug.get("cluster-c")?.action, "skipped");
    assert.equal(traceBySlug.get("cluster-c")?.why, "관련 없음");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// (h) 뮤텍스 — 동시 요청 차단 ------------------------------------------------

test("(h) 뮤텍스: 동시에 실행 중인 deep 요청이 있으면 두 번째 호출은 즉시 거부된다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-deep-test-"));
  try {
    const { core, llm } = buildSimpleDeps();
    const deps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, dataDir };

    const p1 = runDeepAsk("질문1", deps);
    const p2 = runDeepAsk("질문2", deps);

    await assert.rejects(p2, { message: DEEP_BUSY_MESSAGE });
    const envelope1 = await p1;
    assert.equal(envelope1.mode, "deep");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// (i) 동시성 풀 — 동시 2개 초과 금지 + 브리프-클러스터 매핑 순서 보존 -----------

test("(i) 클러스터 에이전트 풀은 동시 2개를 초과하지 않고, 브리프-클러스터 매핑 순서를 보존한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-deep-test-"));
  try {
    const clusters = [
      cluster("c1", "cluster-a"),
      cluster("c2", "cluster-b"),
      cluster("c3", "cluster-c"),
      cluster("c4", "cluster-d"),
    ];
    const routeResp: RouteResponse = {
      scores: [
        routeScore("c1", "cluster-a", 0.9, 5),
        routeScore("c2", "cluster-b", 0.8, 4),
        routeScore("c3", "cluster-c", 0.7, 3),
        routeScore("c4", "cluster-d", 0.6, 2),
      ],
    };
    const searchByClusterId = new Map([
      ["c1", searchResponse([{ origin: "a.md", text: "A본문" }])],
      ["c2", searchResponse([{ origin: "b.md", text: "B본문" }])],
      ["c3", searchResponse([{ origin: "c.md", text: "C본문" }])],
      ["c4", searchResponse([{ origin: "d.md", text: "D본문" }])],
    ]);
    const core = new MockCoreClient(clusters, routeResp, searchByClusterId);

    const llm = new ConcurrencyTrackingLlmClient();
    llm.plannerResponse = {
      subquestions: [
        { cluster_slug: "cluster-a", question: "하위질문A" },
        { cluster_slug: "cluster-b", question: "하위질문B" },
        { cluster_slug: "cluster-c", question: "하위질문C" },
        { cluster_slug: "cluster-d", question: "하위질문D" },
      ],
      skipped: [],
      strategy: "4클러스터 협의",
    };
    // 먼저 시작한 항목(A)이 나중에 끝나도록 지연을 역순으로 부여 — 완료 순서와
    // items 순서가 어긋나도 결과 매핑이 인덱스 기준으로 유지되는지 검증한다.
    llm.briefDelayMs = (prompt) => {
      if (prompt.includes("하위질문A")) return 30;
      if (prompt.includes("하위질문B")) return 20;
      if (prompt.includes("하위질문C")) return 10;
      return 0;
    };
    llm.briefResponder = (prompt) => {
      if (prompt.includes("하위질문A")) return { claims: [{ text: "주장A", cites: [1] }], gaps: [] };
      if (prompt.includes("하위질문B")) return { claims: [{ text: "주장B", cites: [1] }], gaps: [] };
      if (prompt.includes("하위질문C")) return { claims: [{ text: "주장C", cites: [1] }], gaps: [] };
      return { claims: [{ text: "주장D", cites: [1] }], gaps: [] };
    };
    // 4개 클러스터가 각 1개 청크만 내므로 전역 번호는 1(A)/2(B)/3(C)/4(D) — 전부 인용해야
    // numberSources()가 4개 소스 모두 살린다(인용 안 된 청크는 sources에서 제외되는 사양).
    llm.synthesis1Response = {
      sentences: [
        { text: "종합답변A", cites: [1] },
        { text: "종합답변B", cites: [2] },
        { text: "종합답변C", cites: [3] },
        { text: "종합답변D", cites: [4] },
      ],
      insufficient: false,
      contradictions: [],
    };

    const envelope = await runDeepAsk("전체 질문", {
      core: core as unknown as CoreClient,
      llm: llm as unknown as LlmClient,
      dataDir,
    });

    assert.ok(
      llm.maxConcurrentObserved <= DEEP_AGENT_CONCURRENCY,
      `동시 실행 관측치가 상한(${DEEP_AGENT_CONCURRENCY})을 초과함: ${llm.maxConcurrentObserved}`
    );
    assert.ok(llm.maxConcurrentObserved >= 2, "풀이 병렬로 실행되지 않아 동시성 검증이 무의미함");

    assert.equal(envelope.trace.length, 4);
    const traceBySlug = new Map(envelope.trace.map((t) => [t.cluster, t]));
    assert.equal(traceBySlug.get("cluster-a")?.subquestion, "하위질문A");
    assert.equal(traceBySlug.get("cluster-b")?.subquestion, "하위질문B");
    assert.equal(traceBySlug.get("cluster-c")?.subquestion, "하위질문C");
    assert.equal(traceBySlug.get("cluster-d")?.subquestion, "하위질문D");
    for (const slug of ["cluster-a", "cluster-b", "cluster-c", "cluster-d"]) {
      assert.equal(traceBySlug.get(slug)?.claims, 1, `${slug}의 claims 수가 어긋남`);
    }

    assert.equal(envelope.sources.length, 4);
    assert.deepEqual(
      envelope.sources.map((s) => s.origin),
      ["a.md", "b.md", "c.md", "d.md"]
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
