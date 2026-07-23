// Anti-hallucination triple guard (CONTRACT.md M1 확장 section).
// Three independent triggers that make insufficient=true:
//  (a) LLM declares insufficient itself
//  (b) no sentence has any citation ([n])
//  (c) the top search result's rerank_score < 0.0 — in this case, skip calling the LLM entirely and short-circuit
// (c) must be checked before the LLM call, so it's split into a separate function.

export interface CitedSentence {
  text: string;
  cites: number[];
}

export const BLOCK_MESSAGE =
  "제공된 자료만으로는 이 질문에 답할 근거가 충분하지 않습니다.";

/**
 * Trigger (c): if the top search result's rerank_score is below 0.0, treat it as
 * having no grounding and skip the LLM call entirely. Handled the same way when there are no search results at all.
 */
export function shouldSkipLlmCall(topRerankScore: number | null): boolean {
  return topRerankScore === null || topRerankScore < 0.0;
}

/**
 * Triggers (a)/(b): applied after receiving the LLM response.
 * - If llmInsufficient is true, it's insufficient as-is.
 * - insufficient if there are no sentences at all, or every sentence has an empty cites array.
 */
export function evaluateInsufficient(
  llmInsufficient: boolean,
  sentences: CitedSentence[]
): boolean {
  if (llmInsufficient) {
    return true;
  }
  if (sentences.length === 0) {
    return true;
  }
  return sentences.every((s) => s.cites.length === 0);
}
