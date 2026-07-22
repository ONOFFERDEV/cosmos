import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldSkipLlmCall, evaluateInsufficient, BLOCK_MESSAGE } from "./guard.js";
import type { CitedSentence } from "./guard.js";

// 트리거 (c): rerank_score < 0.0 이거나 검색 결과가 없으면(null) LLM 호출을 생략한다.
test("트리거 (c): 검색 결과가 없으면(null) LLM 호출을 생략한다", () => {
  assert.equal(shouldSkipLlmCall(null), true);
});

test("트리거 (c): rerank_score가 음수면 LLM 호출을 생략한다", () => {
  assert.equal(shouldSkipLlmCall(-0.01), true);
});

test("트리거 (c): rerank_score가 정확히 0.0이면 호출을 생략하지 않는다 (경계값)", () => {
  assert.equal(shouldSkipLlmCall(0.0), false);
});

test("트리거 (c): rerank_score가 양수면 호출을 생략하지 않는다", () => {
  assert.equal(shouldSkipLlmCall(0.5), false);
});

// 트리거 (a): LLM이 스스로 insufficient라고 선언
test("트리거 (a): LLM이 insufficient=true를 선언하면 인용이 있어도 insufficient", () => {
  const sentences: CitedSentence[] = [{ text: "답변", cites: [1] }];
  assert.equal(evaluateInsufficient(true, sentences), true);
});

// 트리거 (b): 문장이 없거나, 모든 문장의 cites가 빈 배열
test("트리거 (b): 문장이 하나도 없으면 insufficient", () => {
  assert.equal(evaluateInsufficient(false, []), true);
});

test("트리거 (b): 모든 문장의 cites가 비어있으면 insufficient", () => {
  const sentences: CitedSentence[] = [
    { text: "근거 없는 문장1", cites: [] },
    { text: "근거 없는 문장2", cites: [] },
  ];
  assert.equal(evaluateInsufficient(false, sentences), true);
});

test("정상 사례: 인용이 하나라도 있으면 insufficient가 아니다", () => {
  const sentences: CitedSentence[] = [
    { text: "근거 없는 문장", cites: [] },
    { text: "근거 있는 문장", cites: [1] },
  ];
  assert.equal(evaluateInsufficient(false, sentences), false);
});

test("BLOCK_MESSAGE는 비어있지 않은 한국어 문자열이다", () => {
  assert.equal(typeof BLOCK_MESSAGE, "string");
  assert.ok(BLOCK_MESSAGE.length > 0);
});
