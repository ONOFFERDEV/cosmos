// Intent gate: deterministically classifies whether a question is a global question
// asking for a "full enumeration/overview", or a point question targeting a specific
// target. No LLM calls. See CONTRACT.md "# M7 확장".
// Prioritizes minimizing false positives (a point question misclassified as global) —
// when ambiguous, default to point.

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
