// /ask 응답 봉투(envelope) 조립. CONTRACT.md M1 확장 절에 정의된 정확한 스키마를 따른다.
// sources는 실제로 인용된 청크만, [1]..[n]으로 재번호를 매겨 담는다.

import { BLOCK_MESSAGE } from "./guard.js";

export interface Sentence {
  text: string;
  cites: number[];
}

export interface Source {
  n: number;
  origin: string;
  title?: string;
  chunk_id: string;
  char_start: number;
  char_end: number;
}

export interface TraceEntry {
  cluster: string;
  action: "consulted" | "skipped";
  why: string;
  /** M3 deep: 해당 클러스터에 배정된 하위 질문. consulted 항목에만 존재. */
  subquestion?: string;
  /** M3 deep: 해당 클러스터 브리프가 낸 claim 수. consulted 항목에만 존재. */
  claims?: number;
}

export interface Cost {
  llm_calls: number;
  secs: number;
  model: string;
  /** M3 deep: 단계별(planner/cluster_agents/rebuttal/synthesis_1/synthesis_2) 소요 초. */
  stages?: Record<string, number>;
}

export interface AskEnvelope {
  answer: string;
  sentences: Sentence[];
  sources: Source[];
  trace: TraceEntry[];
  insufficient: boolean;
  mode: "fast" | "deep" | "global";
  cost: Cost;
}

/** LLM에 보여준 [1]..[n] 번호가 매겨진 검색 청크. */
export interface NumberedChunk {
  n: number;
  origin: string;
  title?: string;
  chunk_id: string;
  char_start: number;
  char_end: number;
  /** LLM 프롬프트 조립용 원문. Source에는 포함되지 않는다. */
  text: string;
}

/**
 * 실제로 인용된(cites에 등장한) 청크만 골라 등장 순서대로 1..n 재번호를 매기고,
 * 문장들의 cites도 새 번호로 다시 쓴다. 순수 함수 — I/O 없음.
 */
export function numberSources(
  chunks: NumberedChunk[],
  sentences: Sentence[]
): { sources: Source[]; sentences: Sentence[] } {
  const citedOriginalNumbers = new Set<number>();
  for (const s of sentences) {
    for (const c of s.cites) {
      citedOriginalNumbers.add(c);
    }
  }

  const orderedOriginal = chunks.map((c) => c.n).filter((n) => citedOriginalNumbers.has(n));

  const remap = new Map<number, number>();
  orderedOriginal.forEach((origN, idx) => {
    remap.set(origN, idx + 1);
  });

  const chunkByN = new Map(chunks.map((c) => [c.n, c] as const));

  const sources: Source[] = orderedOriginal.map((origN) => {
    const chunk = chunkByN.get(origN)!;
    const source: Source = {
      n: remap.get(origN)!,
      origin: chunk.origin,
      chunk_id: chunk.chunk_id,
      char_start: chunk.char_start,
      char_end: chunk.char_end,
    };
    if (chunk.title !== undefined) {
      source.title = chunk.title;
    }
    return source;
  });

  const remappedSentences: Sentence[] = sentences.map((s) => ({
    text: s.text,
    cites: s.cites.filter((c) => remap.has(c)).map((c) => remap.get(c)!),
  }));

  return { sources, sentences: remappedSentences };
}

/** 문장들의 텍스트와 (재번호 매겨진) 인용을 이어붙여 answer 전체 텍스트를 만든다. */
export function renderAnswer(sentences: Sentence[]): string {
  return sentences
    .map((s) => (s.cites.length > 0 ? `${s.text} ${s.cites.map((c) => `[${c}]`).join("")}` : s.text))
    .join(" ");
}

export function assembleEnvelope(params: {
  sentences: Sentence[];
  chunks: NumberedChunk[];
  trace: TraceEntry[];
  insufficient: boolean;
  cost: Cost;
  insufficientAnswer?: string;
  mode?: "fast" | "deep" | "global";
}): AskEnvelope {
  const { sources, sentences } = numberSources(params.chunks, params.sentences);
  const answer = params.insufficient
    ? params.insufficientAnswer ?? BLOCK_MESSAGE
    : renderAnswer(sentences);
  return {
    answer,
    sentences,
    sources,
    trace: params.trace,
    insufficient: params.insufficient,
    mode: params.mode ?? "fast",
    cost: params.cost,
  };
}
