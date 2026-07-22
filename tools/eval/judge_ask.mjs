// Cosmos M1 /ask 평가용 순수 판정 함수 모음. eval_ask.mjs(실행)와 judge_ask.test.mjs(자가검증)가 공유한다.
// 판정 대상 스키마는 contract/CONTRACT.md "# M1 확장"의 /ask 응답 봉투를 따른다.

export function basename(p) {
  return p.split(/[\\/]/).pop();
}

// question: {id, expect:"answer"|"insufficient", gold_files?}
// envelope: /ask 응답 JSON (insufficient, sources[] 등)
export function judgeAnswer(question, envelope) {
  if (question.expect === "answer") {
    if (envelope.insufficient !== false) {
      return { pass: false, reason: "insufficient !== false" };
    }
    const goldSet = new Set(question.gold_files ?? []);
    const sources = envelope.sources ?? [];
    const cited = sources.some((s) => goldSet.has(basename(s.origin)));
    if (!cited) {
      return { pass: false, reason: "gold_files 중 인용된 것 없음" };
    }
    return { pass: true, reason: "" };
  }
  if (question.expect === "insufficient") {
    if (envelope.insufficient !== true) {
      return { pass: false, reason: "insufficient !== true" };
    }
    return { pass: true, reason: "" };
  }
  return { pass: false, reason: `알 수 없는 expect: ${question.expect}` };
}

// trace 검증: consulted>=1 AND skipped>=1 AND 모든 항목의 why가 비어있지 않음
export function judgeTrace(envelope) {
  const trace = envelope.trace ?? [];
  const hasConsulted = trace.some((t) => t.action === "consulted");
  const hasSkipped = trace.some((t) => t.action === "skipped");
  const allWhyNonEmpty = trace.length > 0 && trace.every((t) => typeof t.why === "string" && t.why.trim().length > 0);
  const ok = hasConsulted && hasSkipped && allWhyNonEmpty;
  if (ok) return { ok: true, reason: "" };
  const reasons = [];
  if (!hasConsulted) reasons.push("consulted 항목 없음");
  if (!hasSkipped) reasons.push("skipped 항목 없음");
  if (!allWhyNonEmpty) reasons.push("why 비어있는 항목 있음");
  return { ok: false, reason: reasons.join(", ") };
}

export function topCitedFile(envelope) {
  const sources = envelope.sources ?? [];
  if (sources.length === 0) return null;
  return basename(sources[0].origin);
}
