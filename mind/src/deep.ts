// deep consultation mode: planner (Opus) -> cluster agents (Sonnet, parallel) -> contradiction check/rebuttal (max 1 round) -> synthesis (Opus).
// See CONTRACT.md M3 extension section. No changes to core -- reuses the existing /route and cluster-scoped /search as-is.
// Serialized via a single process-wide mutex (the fast path is unaffected).

import type { CoreClient, ClusterSummary, RouteScore } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { completeJson } from "./llm.js";
import { computeRouteScore } from "./router.js";
import type { NumberedChunk, Sentence, AskEnvelope, TraceEntry } from "./envelope.js";
import { assembleEnvelope } from "./envelope.js";
import { evaluateInsufficient } from "./guard.js";
import type { CitedSentence } from "./guard.js";
import { normalizeSentences, appendQueryLog } from "./ask.js";

export const DEEP_BUSY_MESSAGE = "이미 다른 deep 요청이 처리 중입니다. 잠시 후 다시 시도하세요.";
export const DEEP_CLUSTER_BUDGET = 4;
export const DEEP_SEARCH_K = 8;
/**
 * Concurrency cap for parallel cluster agent execution (revised after a 3rd round of real-world
 * measurements, per CONTRACT.md's LLM timeout spec). Observed that 3-4 concurrent CLI spawns on a
 * shared rate-limited account severely delay individual calls, so cluster agent execution was
 * lowered from full parallelism to a limited pool of 2 concurrent.
 */
export const DEEP_AGENT_CONCURRENCY = 2;

export interface DeepAskDeps {
  core: CoreClient;
  llm: LlmClient;
  /** Directory to place data/queries.jsonl in. Defaults to the same as ask.ts's defaultDataDir(). */
  dataDir?: string;
  /** Clock used to measure elapsed time. Can be injected in tests. */
  now?: () => number;
  /** SSE progress hook. No behavior change if unset (no-op). See CONTRACT.md "# M7.5 확장". */
  onProgress?: (stage: string, detail?: string) => void;
  /** M9: knowledge ownership scope ("shared" | "shared+<name>"). Defaults to shared (existing behavior) if unset. */
  ownerScope?: string;
}

export interface PlannerSubquestion {
  cluster_slug: string;
  question: string;
}

export interface PlannerSkip {
  cluster_slug: string;
  why: string;
}

interface PlannerLlmResponse {
  subquestions?: unknown;
  skipped?: unknown;
  strategy?: unknown;
}

interface BriefLlmResponse {
  claims?: unknown;
  gaps?: unknown;
  notes?: unknown;
}

interface SynthesisLlmResponse {
  sentences?: unknown;
  insufficient?: unknown;
  contradictions?: unknown;
}

export interface BriefClaim {
  text: string;
  cites: number[];
  confidence?: number;
}

export interface Contradiction {
  a_cluster: string;
  a_claim: string;
  b_cluster: string;
  b_claim: string;
  issue: string;
}

export interface ClusterBrief {
  clusterSlug: string;
  subquestion: string;
  chunks: NumberedChunk[];
  claims: BriefClaim[];
  gaps: string[];
  notes?: string;
}

export interface MergedClusterBrief {
  clusterSlug: string;
  subquestion: string;
  /** Cites with the offset applied into the global (cross-cluster) chunk numbering space. */
  claims: BriefClaim[];
  gaps: string[];
  notes?: string;
}

function elapsed(now: () => number, start: number): number {
  return Math.round(((now() - start) / 1000) * 100) / 100;
}

/**
 * Maps items with execution limited to `concurrency` concurrent workers (a simple pool with no
 * external dependencies). Each worker pulls the next item via a shared cursor (nextIndex), so
 * completion order doesn't matter, but the result array is always filled at the same index as
 * items, preserving order.
 */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Diagnostic spec: errors raised inside a deep pipeline stage are re-thrown with the stage name
 * (planner/agent:<slug>/rebuttal/synthesis) prefixed. server.ts's /ask 500 logging passes this
 * stage info straight through via err.stack/message.
 */
async function withStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(`[deep:${stage}] ${message}`);
    if (err instanceof Error && err.stack) {
      wrapped.stack = `${wrapped.message}\n${err.stack}`;
    }
    throw wrapped;
  }
}

/**
 * Defensively sanitizes the planner response: discards invalid slugs/formats,
 * prefers subquestions when a slug appears in both subquestions and skipped,
 * and auto-fills any active cluster missing from both lists into skipped (gap-fill).
 */
export function normalizePlannerOutput(
  raw: PlannerLlmResponse,
  activeClusters: ClusterSummary[]
): { subquestions: PlannerSubquestion[]; skipped: PlannerSkip[] } {
  const validSlugs = new Set(activeClusters.map((c) => c.slug));
  const seenSlugs = new Set<string>();

  const subquestions: PlannerSubquestion[] = [];
  if (Array.isArray(raw.subquestions)) {
    for (const item of raw.subquestions) {
      if (!item || typeof item !== "object") continue;
      const slug = (item as Record<string, unknown>)["cluster_slug"];
      const question = (item as Record<string, unknown>)["question"];
      if (typeof slug !== "string" || typeof question !== "string") continue;
      if (!validSlugs.has(slug) || seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      subquestions.push({ cluster_slug: slug, question });
    }
  }

  const skipped: PlannerSkip[] = [];
  if (Array.isArray(raw.skipped)) {
    for (const item of raw.skipped) {
      if (!item || typeof item !== "object") continue;
      const slug = (item as Record<string, unknown>)["cluster_slug"];
      const why = (item as Record<string, unknown>)["why"];
      if (typeof slug !== "string" || typeof why !== "string") continue;
      if (!validSlugs.has(slug) || seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      skipped.push({ cluster_slug: slug, why });
    }
  }

  for (const cluster of activeClusters) {
    if (!seenSlugs.has(cluster.slug)) {
      skipped.push({ cluster_slug: cluster.slug, why: "플래너 응답 누락 — 자동 보정으로 skipped 처리" });
      seenSlugs.add(cluster.slug);
    }
  }

  return { subquestions, skipped };
}

/**
 * If the number of participating clusters exceeds the budget (K), keeps only the top K by
 * routing score and moves the rest into skipped with a "budget cut" reason. Pure function -- no I/O.
 */
export function applyBudgetCut(
  subquestions: PlannerSubquestion[],
  skipped: PlannerSkip[],
  routeScores: RouteScore[],
  budget: number = DEEP_CLUSTER_BUDGET
): { subquestions: PlannerSubquestion[]; skipped: PlannerSkip[] } {
  if (subquestions.length <= budget) {
    return { subquestions, skipped };
  }

  const scoreBySlug = new Map<string, number>();
  for (const s of routeScores) {
    scoreBySlug.set(s.slug, computeRouteScore(s.centroid_sim, s.bm25_hits));
  }

  const sorted = [...subquestions].sort((a, b) => {
    const scoreA = scoreBySlug.get(a.cluster_slug) ?? Number.NEGATIVE_INFINITY;
    const scoreB = scoreBySlug.get(b.cluster_slug) ?? Number.NEGATIVE_INFINITY;
    return scoreB - scoreA;
  });

  const kept = sorted.slice(0, budget);
  const cut = sorted.slice(budget);

  const newSkipped: PlannerSkip[] = [
    ...skipped,
    ...cut.map((c) => ({ cluster_slug: c.cluster_slug, why: "예산 컷" })),
  ];

  return { subquestions: kept, skipped: newSkipped };
}

/** Defensively sanitizes claims from cluster agent/rebuttal responses. Drops any claim with no cites. */
export function normalizeBriefClaims(raw: unknown, maxCiteNumber: number): BriefClaim[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: BriefClaim[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const text = (item as Record<string, unknown>)["text"];
    if (typeof text !== "string") continue;
    const citesRaw = (item as Record<string, unknown>)["cites"];
    const cites = Array.isArray(citesRaw)
      ? citesRaw.filter(
          (c): c is number => typeof c === "number" && Number.isInteger(c) && c >= 1 && c <= maxCiteNumber
        )
      : [];
    if (cites.length === 0) continue;
    const claim: BriefClaim = { text, cites };
    const confidence = (item as Record<string, unknown>)["confidence"];
    if (typeof confidence === "number") {
      claim.confidence = confidence;
    }
    out.push(claim);
  }
  return out;
}

export function normalizeGaps(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((g): g is string => typeof g === "string");
}

/** Defensively sanitizes contradictions from the first synthesis call. Only allows clusters that actually took part in consultation. */
export function normalizeContradictions(raw: unknown, consultedSlugs: Set<string>): Contradiction[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Contradiction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const aCluster = r["a_cluster"];
    const aClaim = r["a_claim"];
    const bCluster = r["b_cluster"];
    const bClaim = r["b_claim"];
    const issue = r["issue"];
    if (
      typeof aCluster !== "string" ||
      typeof aClaim !== "string" ||
      typeof bCluster !== "string" ||
      typeof bClaim !== "string" ||
      typeof issue !== "string"
    ) {
      continue;
    }
    if (!consultedSlugs.has(aCluster) || !consultedSlugs.has(bCluster)) continue;
    out.push({ a_cluster: aCluster, a_claim: aClaim, b_cluster: bCluster, b_claim: bClaim, issue });
  }
  return out;
}

/**
 * Concatenates each cluster brief's local chunk numbers ([1..k], from its own cluster's /search
 * results) into the global numbering space (cumulative offset). Also rewrites claims' cites accordingly.
 */
export function mergeGlobalChunks(briefs: ClusterBrief[]): {
  combinedChunks: NumberedChunk[];
  merged: MergedClusterBrief[];
} {
  const combinedChunks: NumberedChunk[] = [];
  const merged: MergedClusterBrief[] = [];
  let offset = 0;

  for (const brief of briefs) {
    for (const chunk of brief.chunks) {
      combinedChunks.push({ ...chunk, n: chunk.n + offset });
    }
    const remappedClaims: BriefClaim[] = brief.claims.map((claim) => ({
      ...claim,
      cites: claim.cites.map((c) => c + offset),
    }));
    merged.push({
      clusterSlug: brief.clusterSlug,
      subquestion: brief.subquestion,
      claims: remappedClaims,
      gaps: brief.gaps,
      ...(brief.notes !== undefined ? { notes: brief.notes } : {}),
    });
    offset += brief.chunks.length;
  }

  return { combinedChunks, merged };
}

/** Maps every active cluster to either consulted (subquestion + claim count) or skipped (reason), for trace completeness. */
export function buildDeepTrace(
  activeClusters: ClusterSummary[],
  selected: PlannerSubquestion[],
  skipped: PlannerSkip[],
  briefs: ClusterBrief[]
): TraceEntry[] {
  const selectedBySlug = new Map(selected.map((s) => [s.cluster_slug, s] as const));
  const skippedBySlug = new Map(skipped.map((s) => [s.cluster_slug, s] as const));
  const briefBySlug = new Map(briefs.map((b) => [b.clusterSlug, b] as const));

  return activeClusters.map((cluster): TraceEntry => {
    const sel = selectedBySlug.get(cluster.slug);
    if (sel) {
      const brief = briefBySlug.get(cluster.slug);
      return {
        cluster: cluster.slug,
        action: "consulted",
        why: "플래너 배정",
        subquestion: sel.question,
        claims: brief ? brief.claims.length : 0,
      };
    }
    const skip = skippedBySlug.get(cluster.slug);
    return {
      cluster: cluster.slug,
      action: "skipped",
      why: skip ? skip.why : "플래너 응답 누락 — 자동 보정으로 skipped 처리",
    };
  });
}

function buildPlannerPrompt(question: string, clusters: ClusterSummary[], scores: RouteScore[]): string {
  const scoreBySlug = new Map(scores.map((s) => [s.slug, computeRouteScore(s.centroid_sim, s.bm25_hits)] as const));
  const catalogText = clusters
    .map((c) => {
      const score = scoreBySlug.get(c.slug);
      return `- slug: ${c.slug}, name: ${c.name ?? "(없음)"}, 설명: ${c.description ?? "(없음)"}, 문서수: ${c.n_docs}, 라우팅점수: ${
        score !== undefined ? score.toFixed(3) : "(없음)"
      }`;
    })
    .join("\n");

  return `당신은 사내 지식베이스의 질의 계획자입니다. 질문을 여러 지식 클러스터에 나누어 협의(consult)할 계획을 세우세요.

클러스터 카탈로그:
${catalogText || "(클러스터 없음)"}

질문: ${question}

규칙:
- 각 클러스터마다 최대 1개의 맞춤 하위 질문을 만들어 subquestions에 넣으세요(관련 없으면 넣지 마세요).
- 위 카탈로그의 모든 클러스터는 반드시 subquestions 또는 skipped 중 하나에 존재해야 합니다(누락 금지).
- 관련 없는 클러스터는 skipped에 넣고 이유(why)를 간단히 적으세요.
- strategy에 전체 전략을 1문장으로 요약하세요.

다음 JSON 형식으로만 답하세요 (설명이나 마크다운 없이 순수 JSON 객체 하나만):
{"subquestions": [{"cluster_slug": "...", "question": "..."}], "skipped": [{"cluster_slug": "...", "why": "..."}], "strategy": "..."}`;
}

function buildBriefPrompt(subquestion: string, chunks: NumberedChunk[]): string {
  const chunkText = chunks
    .map((c) => `[${c.n}] 출처: ${c.origin}${c.title ? ` (${c.title})` : ""}\n${c.text}`)
    .join("\n\n");

  return `당신은 특정 지식 클러스터를 담당하는 조사 에이전트입니다. 아래 [번호]가 매겨진 근거 자료만 사용해 하위 질문에 답하세요.

규칙:
- 반드시 제공된 근거 자료([1]..[${chunks.length}])만 사용하고, 모르는 내용을 지어내지 마세요.
- 각 주장(claim)은 근거 자료 번호를 cites 배열로 표시하세요. cites 없는 주장은 금지됩니다 — 만들지 마세요.
- 이 클러스터의 자료로 답할 수 없는 부분은 claims에 넣지 말고 gaps에 기술하세요.

근거 자료:
${chunkText || "(근거 자료 없음)"}

하위 질문: ${subquestion}

다음 JSON 형식으로만 답하세요 (설명이나 마크다운 없이 순수 JSON 객체 하나만):
{"claims": [{"text": "근거 있는 주장 1문장", "cites": [1, 2], "confidence": 0.9}], "gaps": ["이 클러스터에 없는 정보"], "notes": "선택"}`;
}

function buildRebuttalPrompt(subquestion: string, chunks: NumberedChunk[], opposingClaims: string[]): string {
  const chunkText = chunks
    .map((c) => `[${c.n}] 출처: ${c.origin}${c.title ? ` (${c.title})` : ""}\n${c.text}`)
    .join("\n\n");
  const opposingText = opposingClaims.map((c) => `- ${c}`).join("\n");

  return `당신은 특정 지식 클러스터를 담당하는 조사 에이전트입니다. 이전에 아래 하위 질문에 대해 브리프를 작성했는데,
다른 클러스터의 주장과 모순되는 부분이 발견되었습니다. 아래 상대 클러스터의 상충 주장을 참고해 당신의 브리프를 재검토하고 다시 작성하세요.

근거 자료(이전과 동일, [1]..[${chunks.length}]):
${chunkText || "(근거 자료 없음)"}

하위 질문: ${subquestion}

상대 클러스터의 상충 주장:
${opposingText || "(없음)"}

규칙:
- 반드시 제공된 근거 자료만 사용하고, 모르는 내용을 지어내지 마세요.
- 상대 주장을 검토한 뒤, 당신의 근거로 뒷받침되는 주장만 유지·수정하세요. cites 없는 주장은 금지됩니다.
- 이 클러스터의 자료로 답할 수 없는 부분은 claims에 넣지 말고 gaps에 기술하세요.

다음 JSON 형식으로만 답하세요 (설명이나 마크다운 없이 순수 JSON 객체 하나만):
{"claims": [{"text": "근거 있는 주장 1문장", "cites": [1, 2], "confidence": 0.9}], "gaps": ["이 클러스터에 없는 정보"], "notes": "선택"}`;
}

function buildSynthesisPrompt(
  question: string,
  merged: MergedClusterBrief[],
  combinedChunks: NumberedChunk[],
  round: 1 | 2,
  priorContradictions?: Contradiction[]
): string {
  const chunkText = combinedChunks
    .map((c) => `[${c.n}] 출처: ${c.origin}${c.title ? ` (${c.title})` : ""}\n${c.text}`)
    .join("\n\n");

  const briefsText = merged
    .map((b) => {
      const claimsText = b.claims.map((c) => `  - ${c.text} (cites ${c.cites.join(",")})`).join("\n") || "  (없음)";
      const gapsText = b.gaps.length > 0 ? b.gaps.join("; ") : "(없음)";
      return `클러스터 ${b.clusterSlug} — 하위 질문: ${b.subquestion}\n주장:\n${claimsText}\n공백: ${gapsText}`;
    })
    .join("\n\n");

  const roundNote =
    round === 1
      ? "이번이 1차 종합입니다. 각 클러스터 브리프 사이에 서로 모순되는 주장이 있는지 검토하고, 있다면 contradictions에 기록하세요. 모순이 없으면 contradictions를 빈 배열로 두고 최종 답변을 작성하세요."
      : `이번이 2차(최종) 종합입니다. 1차에서 아래 모순이 발견되어 관련 클러스터가 브리프를 재검토했습니다:\n${(
          priorContradictions ?? []
        )
          .map((c) => `- [${c.a_cluster}] ${c.a_claim} ↔ [${c.b_cluster}] ${c.b_claim}: ${c.issue}`)
          .join("\n")}\n재검토 후에도 남아있는 모순이 있다면 답변에 "상충 근거" 문단을 별도로 만들어 명시하세요(숨기지 마세요). contradictions에는 재검토 후에도 남은 모순만 다시 기록하세요.`;

  return `당신은 여러 클러스터 에이전트의 조사 브리프를 종합해 최종 답변을 작성하는 종합자입니다.

전체 질문: ${question}

근거 자료(전역 번호, [1]..[${combinedChunks.length}]):
${chunkText || "(근거 자료 없음)"}

클러스터별 브리프:
${briefsText || "(브리프 없음)"}

${roundNote}

규칙:
- 답변의 각 문장은 근거로 삼은 전역 자료 번호를 cites 배열로 표시하세요. 근거가 없는 문장은 만들지 마세요.
- 전 브리프의 근거로 질문에 답할 수 없다면 insufficient를 true로 표시하세요.

다음 JSON 형식으로만 답하세요 (설명이나 마크다운 없이 순수 JSON 객체 하나만):
{"sentences": [{"text": "문장 내용", "cites": [1, 2]}], "insufficient": false, "contradictions": [{"a_cluster": "...", "a_claim": "...", "b_cluster": "...", "b_claim": "...", "issue": "..."}]}`;
}

async function runClusterAgent(
  core: CoreClient,
  llm: LlmClient,
  clusterSlug: string,
  clusterId: string,
  subquestion: string,
  ownerScope?: string
): Promise<ClusterBrief> {
  const searchResponse = await core.search({
    query: subquestion,
    k: DEEP_SEARCH_K,
    cluster_ids: [clusterId],
    owner_scope: ownerScope,
  });
  const chunks: NumberedChunk[] = searchResponse.results.map((r, idx) => {
    const chunk: NumberedChunk = {
      n: idx + 1,
      origin: r.origin,
      chunk_id: r.chunk_id,
      char_start: r.char_start,
      char_end: r.char_end,
      text: r.text,
    };
    if (r.title !== undefined) {
      chunk.title = r.title;
    }
    return chunk;
  });

  const prompt = buildBriefPrompt(subquestion, chunks);
  const raw = await completeJson<BriefLlmResponse>(llm, prompt, "sonnet");
  const claims = normalizeBriefClaims(raw.claims, chunks.length);
  const gaps = normalizeGaps(raw.gaps);
  const notes = typeof raw.notes === "string" ? raw.notes : undefined;

  return {
    clusterSlug,
    subquestion,
    chunks,
    claims,
    gaps,
    ...(notes !== undefined ? { notes } : {}),
  };
}

async function runClusterRebuttal(llm: LlmClient, brief: ClusterBrief, opposingClaims: string[]): Promise<ClusterBrief> {
  const prompt = buildRebuttalPrompt(brief.subquestion, brief.chunks, opposingClaims);
  const raw = await completeJson<BriefLlmResponse>(llm, prompt, "sonnet");
  const claims = normalizeBriefClaims(raw.claims, brief.chunks.length);
  const gaps = normalizeGaps(raw.gaps);
  const notes = typeof raw.notes === "string" ? raw.notes : undefined;

  return {
    clusterSlug: brief.clusterSlug,
    subquestion: brief.subquestion,
    chunks: brief.chunks,
    claims,
    gaps,
    ...(notes !== undefined ? { notes } : {}),
  };
}

let deepMutexLocked = false;

/** Core deep pipeline body (inside the mutex). Wrapped by runDeepAsk to ensure only one process-wide execution runs at a time. */
async function runDeepAskInner(question: string, deps: DeepAskDeps): Promise<AskEnvelope> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  let llmCalls = 0;

  const [clusters, routeResponse] = await Promise.all([
    deps.core.listClusters(deps.ownerScope),
    deps.core.route(question, deps.ownerScope),
  ]);
  const activeClusters = clusters.filter((c) => c.status === "active");
  const clusterBySlug = new Map(activeClusters.map((c) => [c.slug, c] as const));

  deps.onProgress?.("plan");
  console.log("[deep] 플래너 시작");
  const plannerStart = now();
  const plannerPrompt = buildPlannerPrompt(question, activeClusters, routeResponse.scores);
  const plannerRaw = await withStage("planner", () => completeJson<PlannerLlmResponse>(deps.llm, plannerPrompt, "opus"));
  llmCalls += 1;
  const plannerSecs = elapsed(now, plannerStart);
  console.log(`[deep] 플래너 완료(${plannerSecs}s)`);

  const normalizedPlan = normalizePlannerOutput(plannerRaw, activeClusters);
  const { subquestions: selected, skipped } = applyBudgetCut(
    normalizedPlan.subquestions,
    normalizedPlan.skipped,
    routeResponse.scores
  );

  console.log(`[deep] 에이전트 ${selected.length}개(동시 ${DEEP_AGENT_CONCURRENCY}) 시작`);
  const clusterAgentsStart = now();
  let briefs: ClusterBrief[] = await mapWithConcurrencyLimit(selected, DEEP_AGENT_CONCURRENCY, (sub) => {
    const cluster = clusterBySlug.get(sub.cluster_slug)!;
    deps.onProgress?.(`agent:${sub.cluster_slug}`);
    return withStage(`agent:${sub.cluster_slug}`, () =>
      runClusterAgent(deps.core, deps.llm, sub.cluster_slug, cluster.id, sub.question, deps.ownerScope)
    );
  });
  llmCalls += selected.length;
  const clusterAgentsSecs = elapsed(now, clusterAgentsStart);
  console.log(`[deep] 에이전트 ${selected.length}개(동시 ${DEEP_AGENT_CONCURRENCY}) 완료(${clusterAgentsSecs}s)`);

  let { combinedChunks, merged } = mergeGlobalChunks(briefs);
  const totalClaims = merged.reduce((sum, b) => sum + b.claims.length, 0);

  let finalSentences: Sentence[] = [];
  let llmInsufficient = false;
  let rebuttalSecs = 0;
  let synthesis1Secs = 0;
  let synthesis2Secs: number | undefined;

  if (totalClaims === 0) {
    // Total claims across all briefs is 0 -- skip the synthesis LLM call entirely and block.
    llmInsufficient = true;
  } else {
    const consultedSlugs = new Set(selected.map((s) => s.cluster_slug));

    const synth1Start = now();
    const synth1Prompt = buildSynthesisPrompt(question, merged, combinedChunks, 1);
    deps.onProgress?.("synthesize");
    const synth1Raw = await withStage("synthesis", () =>
      completeJson<SynthesisLlmResponse>(deps.llm, synth1Prompt, "opus")
    );
    llmCalls += 1;
    synthesis1Secs = elapsed(now, synth1Start);

    const contradictions = normalizeContradictions(synth1Raw.contradictions, consultedSlugs);

    if (contradictions.length === 0) {
      finalSentences = normalizeSentences(synth1Raw.sentences, combinedChunks.length);
      llmInsufficient = Boolean(synth1Raw.insufficient);
      console.log(`[deep] 종합 완료(${synthesis1Secs}s)`);
    } else {
      deps.onProgress?.("contradict", String(contradictions.length));
      console.log("[deep] 반박 라운드");
      const rebuttalStart = now();
      const affectedSlugs = new Set<string>();
      for (const c of contradictions) {
        affectedSlugs.add(c.a_cluster);
        affectedSlugs.add(c.b_cluster);
      }

      const briefBySlug = new Map(briefs.map((b) => [b.clusterSlug, b] as const));
      const rebuttalResults = await Promise.all(
        [...affectedSlugs].map((slug) => {
          const brief = briefBySlug.get(slug)!;
          const opposing = contradictions
            .filter((c) => c.a_cluster === slug || c.b_cluster === slug)
            .map((c) => (c.a_cluster === slug ? c.b_claim : c.a_claim));
          return withStage("rebuttal", () => runClusterRebuttal(deps.llm, brief, opposing));
        })
      );
      llmCalls += rebuttalResults.length;
      rebuttalSecs = elapsed(now, rebuttalStart);

      for (const updated of rebuttalResults) {
        const idx = briefs.findIndex((b) => b.clusterSlug === updated.clusterSlug);
        if (idx !== -1) {
          briefs[idx] = updated;
        }
      }

      const remerged = mergeGlobalChunks(briefs);
      combinedChunks = remerged.combinedChunks;
      merged = remerged.merged;

      const synth2Start = now();
      const synth2Prompt = buildSynthesisPrompt(question, merged, combinedChunks, 2, contradictions);
      const synth2Raw = await withStage("synthesis", () =>
        completeJson<SynthesisLlmResponse>(deps.llm, synth2Prompt, "opus")
      );
      llmCalls += 1;
      synthesis2Secs = elapsed(now, synth2Start);

      finalSentences = normalizeSentences(synth2Raw.sentences, combinedChunks.length);
      llmInsufficient = Boolean(synth2Raw.insufficient);
      console.log(`[deep] 종합 완료(${synthesis2Secs}s)`);
    }
  }

  const citedSentences: CitedSentence[] = finalSentences.map((s) => ({ text: s.text, cites: s.cites }));
  const insufficient = evaluateInsufficient(llmInsufficient, citedSentences);

  const trace = buildDeepTrace(activeClusters, selected, skipped, briefs);
  const secs = elapsed(now, startedAt);

  const stages: Record<string, number> = {
    planner: plannerSecs,
    cluster_agents: clusterAgentsSecs,
    rebuttal: rebuttalSecs,
    synthesis_1: synthesis1Secs,
  };
  if (synthesis2Secs !== undefined) {
    stages["synthesis_2"] = synthesis2Secs;
  }

  deps.onProgress?.("assemble");
  const envelope = assembleEnvelope({
    sentences: finalSentences,
    chunks: combinedChunks,
    trace,
    insufficient,
    cost: {
      llm_calls: llmCalls,
      secs,
      model: deps.llm.model,
      stages,
    },
    mode: "deep",
  });

  await appendQueryLog(question, envelope, deps.dataDir);

  return envelope;
}

/**
 * Entry point for deep consultation mode. Serialized via a single process-wide mutex -- if one
 * is already running, immediately rejects with DEEP_BUSY_MESSAGE (the fast-path runAsk is unaffected).
 */
export async function runDeepAsk(question: string, deps: DeepAskDeps): Promise<AskEnvelope> {
  if (deepMutexLocked) {
    throw new Error(DEEP_BUSY_MESSAGE);
  }
  deepMutexLocked = true;
  try {
    return await runDeepAskInner(question, deps);
  } finally {
    deepMutexLocked = false;
  }
}
