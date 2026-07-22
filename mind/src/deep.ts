// deep 협의 모드: 플래너(Opus) → 클러스터 에이전트(Sonnet, 병렬) → 모순 검사·반박(최대 1회) → 종합(Opus).
// CONTRACT.md M3 확장 절 참고. core 변경 없음 — 기존 /route, 클러스터 스코프 /search를 그대로 재사용한다.
// 프로세스 전역 동시 1건 뮤텍스로 직렬화한다(fast 경로는 영향 없음).

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
 * 클러스터 에이전트 병렬 실행 동시성 상한(3차 실측 개정, CONTRACT.md LLM 타임아웃 규격).
 * 공유 레이트리밋 계정에서 3~4개 동시 CLI spawn이 개별 호출을 극단적으로 지연시키는 사례가
 * 확인되어, 클러스터 에이전트 실행을 전체 병렬에서 동시 2개 제한 풀로 낮춘다.
 */
export const DEEP_AGENT_CONCURRENCY = 2;

export interface DeepAskDeps {
  core: CoreClient;
  llm: LlmClient;
  /** data/queries.jsonl을 둘 디렉터리. 기본값은 ask.ts의 defaultDataDir()와 동일. */
  dataDir?: string;
  /** 소요시간 측정용 시계. 테스트에서 주입 가능. */
  now?: () => number;
  /** SSE 진행 상황 훅. 미지정 시 동작 변화 없음(no-op). CONTRACT.md "# M7.5 확장" 참고. */
  onProgress?: (stage: string, detail?: string) => void;
  /** M9: 지식 소유권 스코프("shared" | "shared+<name>"). 미지정=shared(기존 동작). */
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
  /** 전역(cross-cluster) 청크 번호 공간으로 offset이 적용된 cites. */
  claims: BriefClaim[];
  gaps: string[];
  notes?: string;
}

function elapsed(now: () => number, start: number): number {
  return Math.round(((now() - start) / 1000) * 100) / 100;
}

/**
 * items를 concurrency개 워커로 동시 실행 제한하며 매핑한다(외부 의존성 없는 단순 풀).
 * 각 워커는 공유 커서(nextIndex)로 다음 항목을 가져가므로 완료 순서는 무관하지만,
 * 결과 배열은 항상 items와 동일한 인덱스에 채워져 순서를 보존한다.
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
 * 진단 규격: deep 파이프라인 내부 단계에서 발생한 에러에 단계명(planner/agent:<slug>/rebuttal/synthesis)을
 * 프리픽스로 붙여 재던진다. server.ts의 /ask 500 로깅이 이 단계 정보를 err.stack/message로 그대로 넘겨받는다.
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
 * 플래너 응답을 방어적으로 정제한다: 유효하지 않은 슬러그·형식은 버리고,
 * subquestions/skipped 양쪽에 등장하는 슬러그는 subquestions를 우선하며,
 * 어느 목록에도 없는 active 클러스터는 자동으로 skipped(누락 보정)에 채운다.
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
 * 참여 클러스터가 예산(K)을 초과하면 라우팅 점수 상위 K개만 남기고 나머지는
 * "예산 컷" 사유로 skipped에 합류시킨다. 순수 함수 — I/O 없음.
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

/** 클러스터 에이전트/반박 응답의 claims를 방어적으로 정제한다. cites 없는 claim은 드랍한다. */
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

/** 종합 1차 콜의 contradictions를 방어적으로 정제한다. 실재하는 협의 클러스터만 허용한다. */
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
 * 각 클러스터 브리프의 로컬 청크 번호([1..k], 자기 클러스터 /search 결과)를
 * 전역 번호 공간으로 이어붙인다(offset 누적). claims의 cites도 함께 재기입한다.
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

/** 모든 active 클러스터를 consulted(하위질문+claim 수) 또는 skipped(이유)로 매핑한다(trace 완전성). */
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

/** deep 파이프라인 본체(뮤텍스 내부). 프로세스 전역 동시 1건만 실행되도록 runDeepAsk가 감싼다. */
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
    // 전 브리프 claims 합계 0 — 종합 LLM 호출 자체를 생략하고 차단.
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
 * deep 협의 모드 진입점. 프로세스 전역 동시 1건 뮤텍스로 직렬화한다 — 이미 실행 중이면
 * DEEP_BUSY_MESSAGE로 즉시 거부한다(fast 경로 runAsk는 영향받지 않는다).
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
