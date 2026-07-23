// Assembles the /ask response envelope. Follows the exact schema defined in CONTRACT.md's M1 extension section.
// sources holds only the actually cited chunks, renumbered as [1]..[n].

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
  /** M3 deep: the subquestion assigned to this cluster. Only present on consulted entries. */
  subquestion?: string;
  /** M3 deep: number of claims this cluster's brief produced. Only present on consulted entries. */
  claims?: number;
}

export interface Cost {
  llm_calls: number;
  secs: number;
  model: string;
  /** M3 deep: elapsed seconds per stage (planner/cluster_agents/rebuttal/synthesis_1/synthesis_2). */
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

/** Search chunks numbered [1]..[n] as shown to the LLM. */
export interface NumberedChunk {
  n: number;
  origin: string;
  title?: string;
  chunk_id: string;
  char_start: number;
  char_end: number;
  /** Raw text for assembling the LLM prompt. Not included in Source. */
  text: string;
}

/**
 * Picks only the actually cited chunks (those appearing in cites), renumbers them 1..n in order
 * of appearance, and rewrites the sentences' cites with the new numbers. Pure function -- no I/O.
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

/** Concatenates the sentences' text with their (renumbered) citations to build the full answer text. */
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
