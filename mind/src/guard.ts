// 안티할루시네이션 3중 가드 (CONTRACT.md M1 확장 절).
// insufficient=true가 되는 3가지 독립 트리거:
//  (a) LLM 스스로 insufficient라고 선언
//  (b) 모든 문장이 인용([n]) 없음
//  (c) 최상위 검색 결과의 rerank_score < 0.0 — 이 경우 LLM을 아예 호출하지 않고 단락(short-circuit)
// (c)는 LLM 호출 전에 검사해야 하므로 별도 함수로 분리한다.

export interface CitedSentence {
  text: string;
  cites: number[];
}

export const BLOCK_MESSAGE =
  "제공된 자료만으로는 이 질문에 답할 근거가 충분하지 않습니다.";

/**
 * 트리거 (c): 최상위 검색 결과의 rerank_score가 0.0 미만이면 근거가 없다고 보고
 * LLM 호출 자체를 생략해야 한다. 검색 결과가 아예 없어도 동일하게 처리한다.
 */
export function shouldSkipLlmCall(topRerankScore: number | null): boolean {
  return topRerankScore === null || topRerankScore < 0.0;
}

/**
 * 트리거 (a)/(b): LLM 응답을 받은 뒤 적용한다.
 * - llmInsufficient가 true면 그대로 insufficient.
 * - 문장이 하나도 없거나, 모든 문장이 cites가 빈 배열이면 insufficient.
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
