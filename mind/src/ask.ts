// fast Q&A pipeline: question -> routing -> core /search (scoped search) -> one LLM call
// (cited evidence) -> triple anti-hallucination guard -> assemble response envelope ->
// log to data/queries.jsonl. See CONTRACT.md M1 extension section "/ask".

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CoreClient } from "./core-client.js";
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

  const searchResponse = await deps.core.search(
    consultedIds.length > 0
      ? { query: question, k: SEARCH_K, cluster_ids: consultedIds, owner_scope: deps.ownerScope }
      : { query: question, k: SEARCH_K, owner_scope: deps.ownerScope }
  );
  deps.onProgress?.("search", String(searchResponse.results.length));

  const results = searchResponse.results;

  // M10 graph extension: append the 1-hop neighbors of the search-hit documents (relations
  // the author made explicit via [[wikilinks]]) as citation candidates. Failures or an
  // unimplemented backend (fake core) are silently skipped — this is an enhancement,
  // not a required path.
  const GRAPH_NEIGHBOR_LIMIT = 4;
  let graphNeighbors: { origin: string; title?: string | null; snippet: string; doc_id: string }[] = [];
  const graphFn = (deps.core as Partial<CoreClient>).graphNeighbors?.bind(deps.core);
  if (graphFn && results.length > 0) {
    try {
      const hitDocIds = [...new Set(results.map((r) => r.doc_id))];
      const hitOrigins = new Set(results.map((r) => r.origin));
      const neighbors = await graphFn(hitDocIds, deps.ownerScope, GRAPH_NEIGHBOR_LIMIT);
      graphNeighbors = neighbors.filter((n) => n.snippet.trim() && !hitOrigins.has(n.origin));
      if (graphNeighbors.length > 0) {
        deps.onProgress?.("graph", String(graphNeighbors.length));
        trace.push({
          cluster: "graph",
          action: "consulted",
          why: `검색 히트와 [[링크]]로 연결된 이웃 문서 ${graphNeighbors.length}건 합류`,
        });
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

  let sentences: Sentence[] = [];
  let insufficient: boolean;

  if (shouldSkipLlmCall(topRerankScore)) {
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
