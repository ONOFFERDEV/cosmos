// 인텐트 게이트: 질문이 "전수 나열/개요"를 요구하는 global 질문인지, 특정 대상을 겨누는
// point 질문인지 결정론적으로 분류한다. LLM 호출 없음. CONTRACT.md "# M7 확장" 참고.
// 오탐(포인트 질문이 global로 잘못 분류되는 경우) 최소화를 우선한다 — 애매하면 point.

const GLOBAL_KEYWORDS = [
  "전체",
  "전부",
  "모든",
  "모두",
  "목록",
  "나열",
  "한눈에",
  "뭐가 있",
  "어떤 것들",
  "프로젝트들",
];

const GLOBAL_PATTERNS_EN = [/\blist all\b/i, /\boverview\b/i, /\broster\b/i];

const STATUS_WORD = /현황/;
const SUMMARY_VERBS = /(정리|요약|알려|보여)/;

export function classifyIntent(question: string): "global" | "point" {
  const text = question.trim();
  if (!text) return "point";

  for (const kw of GLOBAL_KEYWORDS) {
    if (text.includes(kw)) return "global";
  }

  if (STATUS_WORD.test(text) && SUMMARY_VERBS.test(text)) return "global";

  for (const re of GLOBAL_PATTERNS_EN) {
    if (re.test(text)) return "global";
  }

  return "point";
}
