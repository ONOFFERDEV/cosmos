// fast Q&A 파이프라인: 질문 → 라우팅 → core /search(스코프 검색) → LLM 1회 호출(근거 인용) →
// 안티할루시네이션 3중 가드 → 응답 봉투 조립 → data/queries.jsonl 로깅.
// CONTRACT.md M1 확장 절 "/ask" 참고.

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
  /** data/queries.jsonl을 둘 디렉터리. 기본값은 mind/ 상위의 cosmos/data. */
  dataDir?: string;
  /** 소요시간 측정용 시계. 테스트에서 주입 가능. */
  now?: () => number;
  /** SSE 진행 상황 훅. 미지정 시 동작 변화 없음(no-op). CONTRACT.md "# M7.5 확장" 참고. */
  onProgress?: (stage: string, detail?: string) => void;
  /** M9: 지식 소유권 스코프("shared" | "shared+<name>"). 미지정=shared(기존 동작). */
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

/** LLM이 돌려준 sentences 배열을 방어적으로 정제한다 (형식이 어긋난 항목은 버림). */
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
  // 컴파일 결과는 mind/dist/ask.js이므로, 두 단계 위(mind/ -> cosmos/)로 올라가 data/에 붙는다.
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
  // detail은 UI 표시용이므로 UUID가 아니라 slug를 보낸다 (CONTRACT M7.5 stage 표준).
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
