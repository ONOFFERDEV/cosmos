// Cosmos M2 유입 3경로 + 승인 게이트 평가용 순수 판정 함수 모음. eval_m2.mjs(실행)와 judge_m2.test.mjs(자가검증)가 공유한다.
// 판정 대상 스키마는 contract/CONTRACT.md "# M2 확장"의 승인 게이트·워처·core ingest-시 클러스터 배정을 따른다.

/** stdout 안에서 '}'와 짝이 맞는 '{'의 인덱스를 뒤에서부터 찾는다. 없으면 -1. */
function findMatchingOpenBrace(str, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (str[i] === "}") depth++;
    else if (str[i] === "{") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * mind CLI(collect/approve/reject/scan) stdout에서 JSON 결과 블록을 추출한다.
 * CLI가 로그 라인 사이/앞뒤에 JSON을 섞어 찍을 수 있어 3단계로 시도하는 순수 함수.
 * 1) 전체 문자열이 그대로 JSON  2) 마지막 줄부터 역순으로 파싱 가능한 첫 줄
 * 3) 마지막 '}'에서 짝이 맞는 '{'까지 균형 잡힌 블록
 */
export function extractJsonBlob(stdout) {
  if (typeof stdout !== "string" || stdout.trim().length === 0) return null;
  const trimmed = stdout.trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }

  const lastBrace = trimmed.lastIndexOf("}");
  if (lastBrace === -1) return null;
  const openIdx = findMatchingOpenBrace(trimmed, lastBrace);
  if (openIdx === -1) return null;
  try {
    return JSON.parse(trimmed.slice(openIdx, lastBrace + 1));
  } catch {
    return null;
  }
}

/** /ask 응답 envelope.sources[]에 origin이 정확히 일치하는 항목이 있는지 */
export function citesOrigin(envelope, origin) {
  const sources = envelope?.sources ?? [];
  return sources.some((s) => s.origin === origin);
}

// 게이트1: 승인 전 문서는 /ask에 인용되면 안 된다 (미색인 증명).
export function judgeAskUncited(envelope, origin) {
  if (citesOrigin(envelope, origin)) {
    return { pass: false, reason: `승인 전 문서(${origin})가 이미 /ask에 인용됨` };
  }
  return { pass: true, reason: "" };
}

// 게이트2: 승인된 문서는 /ask에 인용되어야 한다 (종단 검증).
export function judgeAskCited(envelope, origin) {
  if (!citesOrigin(envelope, origin)) {
    return { pass: false, reason: `승인된 문서(${origin})가 /ask sources에 없음` };
  }
  return { pass: true, reason: "" };
}

// 게이트1: collect 직후 core /docs 수 불변 + pending >= 1건
export function judgeUnindexedProof({ docsBefore, docsAfter, pendingCount }) {
  const reasons = [];
  if (docsAfter !== docsBefore) reasons.push(`core /docs 수 변동(${docsBefore} -> ${docsAfter})`);
  if (!(pendingCount >= 1)) reasons.push("pending 0건(수집 실패 가능)");
  return { pass: reasons.length === 0, reason: reasons.join(", ") };
}

// 게이트2 (M2 백로그 수정, 2026-07-13): CLI stdout JSON 파싱 가정을 폐기하고, approved/{id}.json의
// cluster_slug·fit 존재 + core /docs에 origin 실재 + docs 수 증가로 판정한다.
// (2026-07-13 수동 검증과 동일한 증거 채널. CONTRACT.md "## M2 백로그 처리" 참고.)
export function judgeApproveEndToEnd({ docsBefore, docsAfterApprove, approvedEntry, origin, docsAfterList }) {
  const reasons = [];
  if (!(docsAfterApprove > docsBefore)) {
    reasons.push(`core /docs 수가 증가하지 않음(${docsBefore} -> ${docsAfterApprove})`);
  }
  if (!approvedEntry) {
    reasons.push(`data/inbox/approved/{id}.json 없음(origin=${origin})`);
  } else {
    if (approvedEntry.cluster_slug == null) reasons.push("approved 파일에 cluster_slug 없음(클러스터 자동배정 미기록)");
    if (typeof approvedEntry.fit !== "number") reasons.push("approved 파일에 fit 없음(수치 아님)");
  }
  const originPresent = (docsAfterList ?? []).some((d) => d.origin === origin);
  if (!originPresent) reasons.push(`core /docs에 origin(${origin})이 실재하지 않음`);
  return { pass: reasons.length === 0, reason: reasons.join(", ") };
}

// 게이트2: 저널 신규 이벤트에 ingest 1건 + assign 1건이 있어야 한다
export function judgeJournalHasIngestAndAssign(events) {
  const list = events ?? [];
  const hasIngest = list.some((e) => e.kind === "ingest");
  const hasAssign = list.some((e) => e.kind === "assign");
  const reasons = [];
  if (!hasIngest) reasons.push("ingest 이벤트 없음");
  if (!hasAssign) reasons.push("assign 이벤트 없음");
  return { pass: hasIngest && hasAssign, reason: reasons.join(", ") };
}

// 게이트3: reject 후 docs 불변 + pending에서 제거 + rejected/에 decision·decided_at 기록
export function judgeReject({ docsBefore, docsAfter, pendingStillExists, rejectedEntry }) {
  const reasons = [];
  if (docsAfter !== docsBefore) {
    reasons.push(`core /docs 수 변동(${docsBefore} -> ${docsAfter}, 거부는 미색인이어야 함)`);
  }
  if (pendingStillExists) reasons.push("pending/에 여전히 존재(rejected/로 미이동)");
  if (!rejectedEntry) {
    reasons.push("rejected/ 파일 없음");
  } else {
    if (rejectedEntry.decision !== "rejected") reasons.push(`decision !== "rejected"(${rejectedEntry.decision})`);
    if (!rejectedEntry.decided_at) reasons.push("decided_at 없음");
  }
  return { pass: reasons.length === 0, reason: reasons.join(", ") };
}

// 게이트4: 워처 3상태 — 신규(chunks>0, duplicate:false) / 동일 재전송(duplicate:true) / 수정 재전송(replaced:true)
export function judgeIngestTriple({ fresh, duplicate, replaced }) {
  const reasons = [];
  if (!fresh || !(fresh.chunks > 0) || fresh.duplicate !== false) {
    reasons.push("신규 전송이 chunks>0 && duplicate===false 아님");
  }
  if (!duplicate || duplicate.duplicate !== true) {
    reasons.push("동일 재전송이 duplicate===true 아님");
  }
  if (!replaced || replaced.replaced !== true) {
    reasons.push("수정 후 재전송이 replaced===true 아님");
  }
  return { pass: reasons.length === 0, reason: reasons.join(", ") };
}

// 게이트4(실제 스캔): 전후 core /docs 수가 같아야 한다 (전량 duplicate, 기존 문서 무손상)
export function judgeDocsUnchanged(before, after) {
  if (before !== after) {
    return { pass: false, reason: `core /docs 수 변동(${before} -> ${after})` };
  }
  return { pass: true, reason: "" };
}

// 게이트5: manual ingest는 즉시 색인되어야 한다 (신규면 chunks>0, 재실행이면 duplicate:true도 허용)
export function judgeManualImmediate(entry) {
  if (!entry || !entry.doc_id) {
    return { pass: false, reason: "IngestResponse에 doc_id 없음" };
  }
  if (!(entry.chunks > 0 || entry.duplicate === true)) {
    return { pass: false, reason: "chunks>0도 duplicate=true도 아님(즉시색인 실패)" };
  }
  return { pass: true, reason: "" };
}
