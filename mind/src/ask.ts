// fast Q&A pipeline: question -> routing -> core /search (scoped search) -> one LLM call
// (cited evidence) -> triple anti-hallucination guard -> assemble response envelope ->
// log to data/queries.jsonl. See CONTRACT.md M1 extension section "/ask".

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CoreClient, SearchResult } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { completeJson } from "./llm.js";
import { decideRoutes, consultedClusterIds } from "./router.js";
import type { NumberedChunk, Sentence, AskEnvelope, TraceEntry } from "./envelope.js";
import { assembleEnvelope } from "./envelope.js";
import { shouldSkipLlmCall, evaluateInsufficient } from "./guard.js";
import type { CitedSentence } from "./guard.js";

const SEARCH_K = 8;

export interface AskDeps {
  core: CoreClient;
  llm: LlmClient;
  /** Directory to place data/queries.jsonl in. Defaults to cosmos/data, one level above mind/. */
  dataDir?: string;
  /** Clock for measuring elapsed time. Can be injected in tests. */
  now?: () => number;
  /** SSE progress hook. No behavior change (no-op) if unset. See CONTRACT.md "# M7.5 확장". */
  onProgress?: (stage: string, detail?: string) => void;
  /** M9: knowledge ownership scope ("shared" | "shared+<name>"). Unset = shared (existing behavior). */
  ownerScope?: string;
}

interface AskLlmResponse {
  sentences: unknown;
  insufficient?: boolean;
}

interface ExpandQueryResponse {
  keywords?: unknown;
}

const GRAPH_NEIGHBOR_LIMIT = 4;

interface SearchPass {
  results: SearchResult[];
  chunks: NumberedChunk[];
  /** Set only when graph neighbors were found for this pass; caller decides whether to record it. */
  graphTraceEntry: TraceEntry | null;
  topRerankScore: number | null;
}

/**
 * Runs one search -> graph-neighbor-expansion -> chunk-numbering pass. Shared by the primary
 * search and the query-expansion fallback search so both follow identical logic.
 */
async function runSearchPass(
  deps: AskDeps,
  query: string,
  clusterIds: string[],
  emitProgress: boolean
): Promise<SearchPass> {
  const searchResponse = await deps.core.search(
    clusterIds.length > 0
      ? { query, k: SEARCH_K, cluster_ids: clusterIds, owner_scope: deps.ownerScope }
      : { query, k: SEARCH_K, owner_scope: deps.ownerScope }
  );
  if (emitProgress) {
    deps.onProgress?.("search", String(searchResponse.results.length));
  }

  const results = searchResponse.results;

  // M10 graph extension: append the 1-hop neighbors of the search-hit documents (relations
  // the author made explicit via [[wikilinks]]) as citation candidates. Failures or an
  // unimplemented backend (fake core) are silently skipped — this is an enhancement,
  // not a required path.
  let graphNeighbors: { origin: string; title?: string | null; snippet: string; doc_id: string }[] = [];
  let graphTraceEntry: TraceEntry | null = null;
  const graphFn = (deps.core as Partial<CoreClient>).graphNeighbors?.bind(deps.core);
  if (graphFn && results.length > 0) {
    try {
      const hitDocIds = [...new Set(results.map((r) => r.doc_id))];
      const hitOrigins = new Set(results.map((r) => r.origin));
      const neighbors = await graphFn(hitDocIds, deps.ownerScope, GRAPH_NEIGHBOR_LIMIT);
      graphNeighbors = neighbors.filter((n) => n.snippet.trim() && !hitOrigins.has(n.origin));
      if (graphNeighbors.length > 0) {
        if (emitProgress) {
          deps.onProgress?.("graph", String(graphNeighbors.length));
        }
        graphTraceEntry = {
          cluster: "graph",
          action: "consulted",
          why: `검색 히트와 [[링크]]로 연결된 이웃 문서 ${graphNeighbors.length}건 합류`,
        };
      }
    } catch {
      // Graph unavailability doesn't block the answer.
    }
  }

  const chunks: NumberedChunk[] = results.map((r, idx) => {
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
  for (const n of graphNeighbors) {
    const chunk: NumberedChunk = {
      n: chunks.length + 1,
      origin: n.origin,
      chunk_id: `graph:${n.doc_id}`,
      char_start: 0,
      char_end: n.snippet.length,
      text: n.snippet,
    };
    if (n.title) {
      chunk.title = n.title;
    }
    chunks.push(chunk);
  }

  const topRerankScore = results.length > 0 ? results[0]!.stages.rerank_score : null;

  return { results, chunks, graphTraceEntry, topRerankScore };
}

/**
 * Query-expansion fallback: when the original query gets zero token/vector overlap against the
 * knowledge base (e.g. a Korean question against English-only docs), asks the LLM to extract
 * core search keywords in BOTH Korean and English so the re-search can bridge the language gap.
 * Returns null on LLM error or an empty/malformed keyword list — callers fall back to the
 * original insufficient-answer path in that case.
 */
async function expandQuery(question: string, llm: LlmClient): Promise<string | null> {
  const prompt = `아래 질문은 사내 지식베이스(한국어 질문·영어 문서 혼재) 검색에서 근거를 찾지 못했습니다. 검색 리콜을 높이기 위해, 질문의 핵심 검색 키워드를 한국어와 영어 두 언어 모두로 추출하고, 그 주제와 직접 관련된 구체적 하위 키워드·동의어도 5~10개 함께 포함하세요. "내용", "알려줘", "정리해줘" 같은 요청 동사·조사는 제외하고 명사/용어만 남기세요.

질문: ${question}

다음 JSON 형식으로만 답하세요 (설명이나 마크다운 없이 순수 JSON 객체 하나만):
{"keywords": ["핵심어1", "keyword1", "관련어2", "related2", "동의어3", "synonym3"]}`;

  try {
    const response = await completeJson<ExpandQueryResponse>(llm, prompt);
    if (!Array.isArray(response.keywords)) {
      return null;
    }
    const keywords = response.keywords.filter(
      (k): k is string => typeof k === "string" && k.trim().length > 0
    );
    if (keywords.length === 0) {
      return null;
    }
    return keywords.join(" ");
  } catch {
    return null;
  }
}

/**
 * A search pass is groundable if it has a real BM25 (exact keyword) hit even when the top
 * rerank_score is negative. The bge-reranker logit runs negative for short/mixed queries even
 * against genuinely relevant docs (measured: "coupang" alone reranks +1.56, but "쿠팡 coupang
 * 자동화 automation" reranks negative while still surfacing the coupang docs with BM25 hits).
 * A BM25 hit means the query keywords literally occur in the document, so we let the LLM judge
 * relevance from the chunks (its own insufficient flag + the no-citation guard remain the safety net).
 */
function hasBm25Hit(results: SearchResult[]): boolean {
  return results.some((r) => r.stages.bm25_rank != null);
}

export function buildAskPrompt(question: string, chunks: NumberedChunk[]): string {
  const chunkText = chunks
    .map((c) => `[${c.n}] 출처: ${c.origin}${c.title ? ` (${c.title})` : ""}\n${c.text}`)
    .join("\n\n");

  return `당신은 사내 지식베이스 질의응답 어시스턴트입니다. 아래 [번호]가 매겨진 근거 자료만 사용해 질문에 답하세요.

규칙:
- 반드시 제공된 근거 자료([1]..[${chunks.length}])만 사용하고, 모르는 내용을 지어내지 마세요.
- 답변의 각 문장은 근거로 삼은 자료 번호를 cites 배열로 표시하세요. 근거가 없는 문장은 만들지 마세요.
- 근거 자료로 질문에 답할 수 없다면 insufficient를 true로 표시하세요.

근거 자료:
${chunkText || "(근거 자료 없음)"}

질문: ${question}

다음 JSON 형식으로만 답하세요 (설명이나 마크다운 없이 순수 JSON 객체 하나만):
{"sentences": [{"text": "문장 내용", "cites": [1, 2]}], "insufficient": false}`;
}

/** Defensively normalizes the sentences array returned by the LLM (drops malformed items). */
export function normalizeSentences(raw: unknown, maxCiteNumber: number): Sentence[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Sentence[] = [];
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
    out.push({ text, cites });
  }
  return out;
}

function defaultDataDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Compiled output lands at mind/dist/ask.js, so go up two levels (mind/ -> cosmos/) to reach data/.
  return path.resolve(here, "..", "..", "data");
}

export async function appendQueryLog(
  question: string,
  envelope: AskEnvelope,
  dataDir?: string
): Promise<void> {
  const dir = dataDir ?? defaultDataDir();
  await mkdir(dir, { recursive: true });
  const logPath = path.join(dir, "queries.jsonl");
  const line = JSON.stringify({
    question,
    mode: envelope.mode,
    trace: envelope.trace,
    cost: envelope.cost,
    insufficient: envelope.insufficient,
    timestamp: new Date().toISOString(),
  });
  await appendFile(logPath, line + "\n", "utf8");
}

export async function runAsk(question: string, deps: AskDeps): Promise<AskEnvelope> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  let llmCalls = 0;

  const routeResponse = await deps.core.route(question, deps.ownerScope);
  const decisions = decideRoutes(routeResponse.scores);
  const consultedIds = consultedClusterIds(decisions);
  // detail is for UI display, so send the slug rather than the UUID (CONTRACT M7.5 stage standard).
  const consultedSlugs = decisions.filter((d) => d.action === "consulted").map((d) => d.slug);
  deps.onProgress?.("route", consultedSlugs.length > 0 ? consultedSlugs.join(",") : undefined);

  const trace: TraceEntry[] = decisions.map((d) => ({
    cluster: d.slug,
    action: d.action,
    why: d.why,
  }));

  let pass = await runSearchPass(deps, question, consultedIds, true);
  // The original search is judged on rerank_score alone (pure honest gate — no BM25 relaxation).
  let groundable = !shouldSkipLlmCall(pass.topRerankScore);

  // Recall fallback: the original search found nothing groundable (e.g. a Korean question
  // against English-only docs gets zero bm25/vector overlap). Try one query-expansion
  // re-search — global scope, since routing also mis-fires on these queries — before
  // giving up. Genuinely ungrounded questions still end up insufficient below.
  if (!groundable) {
    const expandedQuery = await expandQuery(question, deps.llm);
    llmCalls += 1;
    if (expandedQuery) {
      const expandedPass = await runSearchPass(deps, expandedQuery, [], false);
      // On the expansion path only, accept a negative top rerank_score when there is a real
      // BM25 hit — the reranker under-scores relevant docs for short/mixed-language queries,
      // but a literal keyword hit is strong evidence the LLM should get to judge the chunks.
      if (!shouldSkipLlmCall(expandedPass.topRerankScore) || hasBm25Hit(expandedPass.results)) {
        pass = expandedPass;
        groundable = true;
        trace.push({
          cluster: "query-expansion",
          action: "consulted",
          why: "원 질의 리콜 실패 → 한/영 키워드 확장 재검색",
        });
      }
    }
  }

  if (pass.graphTraceEntry) {
    trace.push(pass.graphTraceEntry);
  }

  const chunks = pass.chunks;

  let sentences: Sentence[] = [];
  let insufficient: boolean;

  if (!groundable) {
    insufficient = true;
  } else {
    deps.onProgress?.("synthesize");
    const prompt = buildAskPrompt(question, chunks);
    const llmResponse = await completeJson<AskLlmResponse>(deps.llm, prompt);
    llmCalls += 1;
    sentences = normalizeSentences(llmResponse.sentences, chunks.length);
    const citedSentences: CitedSentence[] = sentences.map((s) => ({ text: s.text, cites: s.cites }));
    insufficient = evaluateInsufficient(Boolean(llmResponse.insufficient), citedSentences);
  }

  const secs = Math.round(((now() - startedAt) / 1000) * 100) / 100;

  deps.onProgress?.("assemble");
  const envelope = assembleEnvelope({
    sentences,
    chunks,
    trace,
    insufficient,
    cost: {
      llm_calls: llmCalls,
      secs,
      model: deps.llm.model,
    },
  });

  await appendQueryLog(question, envelope, deps.dataDir);

  return envelope;
}
