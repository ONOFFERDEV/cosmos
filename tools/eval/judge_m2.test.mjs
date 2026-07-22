// judge_m2.mjs 자가검증. 픽스처로 각 판정 함수의 PASS/FAIL 경로를 실행한다.
// CONTRACT.md "# M2 확장" 게이트 1~5에 대응.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractJsonBlob,
  citesOrigin,
  judgeAskUncited,
  judgeAskCited,
  judgeUnindexedProof,
  judgeApproveEndToEnd,
  judgeJournalHasIngestAndAssign,
  judgeReject,
  judgeIngestTriple,
  judgeDocsUnchanged,
  judgeManualImmediate,
} from "./judge_m2.mjs";

// --- extractJsonBlob ---

test("extractJsonBlob: 전체 문자열이 순수 JSON이면 그대로 파싱", () => {
  const result = extractJsonBlob('{"doc_id":"abc","chunks":3}');
  assert.deepEqual(result, { doc_id: "abc", chunks: 3 });
});

test("extractJsonBlob: 로그 줄 뒤에 마지막 줄이 JSON이면 그 줄을 파싱", () => {
  const stdout = "collecting arxiv...\ndone.\n" + '{"pending":2}';
  assert.deepEqual(extractJsonBlob(stdout), { pending: 2 });
});

test("extractJsonBlob: 앞뒤 로그에 섞인 균형 중괄호 블록을 뒤에서부터 스캔해 파싱", () => {
  const stdout = 'log line one\n{"ingested":[{"origin":"a","chunks":1}]}\nsome trailing note';
  assert.deepEqual(extractJsonBlob(stdout), { ingested: [{ origin: "a", chunks: 1 }] });
});

test("extractJsonBlob: 파싱 불가능한 문자열은 null", () => {
  assert.equal(extractJsonBlob("not json at all, no braces"), null);
});

test("extractJsonBlob: 빈 문자열/비문자열 입력은 null", () => {
  assert.equal(extractJsonBlob(""), null);
  assert.equal(extractJsonBlob(null), null);
  assert.equal(extractJsonBlob(undefined), null);
});

// --- citesOrigin ---

test("citesOrigin: sources에 origin이 정확히 일치하면 true", () => {
  const envelope = { sources: [{ n: 1, origin: "https://arxiv.org/abs/1234" }] };
  assert.equal(citesOrigin(envelope, "https://arxiv.org/abs/1234"), true);
});

test("citesOrigin: sources에 origin이 없으면 false", () => {
  const envelope = { sources: [{ n: 1, origin: "https://arxiv.org/abs/9999" }] };
  assert.equal(citesOrigin(envelope, "https://arxiv.org/abs/1234"), false);
});

test("citesOrigin: sources가 없는 envelope도 false(예외 없이)", () => {
  assert.equal(citesOrigin({}, "https://example.com"), false);
});

// --- judgeAskUncited / judgeAskCited ---

test("judgeAskUncited: 미인용이면 PASS", () => {
  const envelope = { sources: [] };
  const result = judgeAskUncited(envelope, "https://arxiv.org/abs/1234");
  assert.equal(result.pass, true);
});

test("judgeAskUncited: 승인 전인데 이미 인용되면 FAIL", () => {
  const envelope = { sources: [{ n: 1, origin: "https://arxiv.org/abs/1234" }] };
  const result = judgeAskUncited(envelope, "https://arxiv.org/abs/1234");
  assert.equal(result.pass, false);
  assert.match(result.reason, /이미 \/ask에 인용됨/);
});

test("judgeAskCited: 승인 후 인용되면 PASS", () => {
  const envelope = { sources: [{ n: 1, origin: "https://arxiv.org/abs/1234" }] };
  const result = judgeAskCited(envelope, "https://arxiv.org/abs/1234");
  assert.equal(result.pass, true);
});

test("judgeAskCited: 승인 후에도 미인용이면 FAIL", () => {
  const envelope = { sources: [] };
  const result = judgeAskCited(envelope, "https://arxiv.org/abs/1234");
  assert.equal(result.pass, false);
  assert.match(result.reason, /sources에 없음/);
});

// --- judgeUnindexedProof ---

test("judgeUnindexedProof: docs 불변 + pending>=1 이면 PASS", () => {
  const result = judgeUnindexedProof({ docsBefore: 129, docsAfter: 129, pendingCount: 3 });
  assert.equal(result.pass, true);
});

test("judgeUnindexedProof: docs 수가 변동하면 FAIL", () => {
  const result = judgeUnindexedProof({ docsBefore: 129, docsAfter: 130, pendingCount: 3 });
  assert.equal(result.pass, false);
  assert.match(result.reason, /core \/docs 수 변동/);
});

test("judgeUnindexedProof: pending이 0건이면 FAIL", () => {
  const result = judgeUnindexedProof({ docsBefore: 129, docsAfter: 129, pendingCount: 0 });
  assert.equal(result.pass, false);
  assert.match(result.reason, /pending 0건/);
});

// --- judgeApproveEndToEnd (M2 백로그 수정, 2026-07-13: CLI stdout 파싱 대신
// approved/{id}.json + core /docs 실재 확인 채널로 판정) ---

test("judgeApproveEndToEnd: docs 증가, cluster_slug·fit 존재, origin이 /docs에 실재하면 PASS", () => {
  const result = judgeApproveEndToEnd({
    docsBefore: 129,
    docsAfterApprove: 130,
    approvedEntry: { origin: "https://arxiv.org/abs/1234", cluster_slug: "robotics", fit: 0.82 },
    origin: "https://arxiv.org/abs/1234",
    docsAfterList: [{ origin: "https://arxiv.org/abs/1234" }],
  });
  assert.equal(result.pass, true);
});

test("judgeApproveEndToEnd: docs가 증가하지 않으면 FAIL", () => {
  const result = judgeApproveEndToEnd({
    docsBefore: 129,
    docsAfterApprove: 129,
    approvedEntry: { origin: "https://arxiv.org/abs/1234", cluster_slug: "robotics", fit: 0.82 },
    origin: "https://arxiv.org/abs/1234",
    docsAfterList: [{ origin: "https://arxiv.org/abs/1234" }],
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /증가하지 않음/);
});

test("judgeApproveEndToEnd: docs가 감소해도 FAIL(증가만 PASS 조건)", () => {
  const result = judgeApproveEndToEnd({
    docsBefore: 129,
    docsAfterApprove: 128,
    approvedEntry: { origin: "https://arxiv.org/abs/1234", cluster_slug: "robotics", fit: 0.82 },
    origin: "https://arxiv.org/abs/1234",
    docsAfterList: [{ origin: "https://arxiv.org/abs/1234" }],
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /증가하지 않음/);
});

test("judgeApproveEndToEnd: approvedEntry 없으면 FAIL", () => {
  const result = judgeApproveEndToEnd({
    docsBefore: 129,
    docsAfterApprove: 130,
    approvedEntry: null,
    origin: "https://arxiv.org/abs/1234",
    docsAfterList: [{ origin: "https://arxiv.org/abs/1234" }],
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /approved\/\{id\}\.json 없음/);
});

test("judgeApproveEndToEnd: cluster_slug가 null이면 FAIL", () => {
  const result = judgeApproveEndToEnd({
    docsBefore: 129,
    docsAfterApprove: 130,
    approvedEntry: { origin: "https://arxiv.org/abs/1234", cluster_slug: null, fit: 0.82 },
    origin: "https://arxiv.org/abs/1234",
    docsAfterList: [{ origin: "https://arxiv.org/abs/1234" }],
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /cluster_slug 없음/);
});

test("judgeApproveEndToEnd: fit이 숫자가 아니면 FAIL", () => {
  const result = judgeApproveEndToEnd({
    docsBefore: 129,
    docsAfterApprove: 130,
    approvedEntry: { origin: "https://arxiv.org/abs/1234", cluster_slug: "robotics", fit: null },
    origin: "https://arxiv.org/abs/1234",
    docsAfterList: [{ origin: "https://arxiv.org/abs/1234" }],
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /fit 없음/);
});

test("judgeApproveEndToEnd: origin이 core /docs 목록에 실재하지 않으면 FAIL(신규 증거 채널)", () => {
  const result = judgeApproveEndToEnd({
    docsBefore: 129,
    docsAfterApprove: 130,
    approvedEntry: { origin: "https://arxiv.org/abs/1234", cluster_slug: "robotics", fit: 0.82 },
    origin: "https://arxiv.org/abs/1234",
    docsAfterList: [{ origin: "https://arxiv.org/abs/9999" }],
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /실재하지 않음/);
});

test("judgeApproveEndToEnd: docsAfterList가 비어있으면 origin 실재 확인도 FAIL", () => {
  const result = judgeApproveEndToEnd({
    docsBefore: 129,
    docsAfterApprove: 130,
    approvedEntry: { origin: "https://arxiv.org/abs/1234", cluster_slug: "robotics", fit: 0.82 },
    origin: "https://arxiv.org/abs/1234",
    docsAfterList: [],
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /실재하지 않음/);
});

// --- judgeJournalHasIngestAndAssign ---

test("judgeJournalHasIngestAndAssign: ingest+assign 둘 다 있으면 PASS", () => {
  const events = [
    { seq: 1, kind: "ingest", payload: {} },
    { seq: 2, kind: "assign", payload: {} },
  ];
  assert.equal(judgeJournalHasIngestAndAssign(events).pass, true);
});

test("judgeJournalHasIngestAndAssign: assign이 없으면 FAIL", () => {
  const events = [{ seq: 1, kind: "ingest", payload: {} }];
  const result = judgeJournalHasIngestAndAssign(events);
  assert.equal(result.pass, false);
  assert.match(result.reason, /assign 이벤트 없음/);
});

test("judgeJournalHasIngestAndAssign: 빈 배열이면 둘 다 없음 FAIL", () => {
  const result = judgeJournalHasIngestAndAssign([]);
  assert.equal(result.pass, false);
  assert.match(result.reason, /ingest 이벤트 없음/);
  assert.match(result.reason, /assign 이벤트 없음/);
});

// --- judgeReject ---

test("judgeReject: 정상 거부(docs 불변, pending 제거, rejected 기록)면 PASS", () => {
  const result = judgeReject({
    docsBefore: 129,
    docsAfter: 129,
    pendingStillExists: false,
    rejectedEntry: { decision: "rejected", decided_at: "2026-07-13T00:00:00.000Z" },
  });
  assert.equal(result.pass, true);
});

test("judgeReject: 거부인데 docs 수가 변하면 FAIL", () => {
  const result = judgeReject({
    docsBefore: 129,
    docsAfter: 130,
    pendingStillExists: false,
    rejectedEntry: { decision: "rejected", decided_at: "2026-07-13T00:00:00.000Z" },
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /core \/docs 수 변동/);
});

test("judgeReject: pending에 여전히 파일이 남아있으면 FAIL", () => {
  const result = judgeReject({
    docsBefore: 129,
    docsAfter: 129,
    pendingStillExists: true,
    rejectedEntry: { decision: "rejected", decided_at: "2026-07-13T00:00:00.000Z" },
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /pending\/에 여전히 존재/);
});

test("judgeReject: rejected 파일이 없으면 FAIL", () => {
  const result = judgeReject({
    docsBefore: 129,
    docsAfter: 129,
    pendingStillExists: false,
    rejectedEntry: null,
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /rejected\/ 파일 없음/);
});

// --- judgeIngestTriple ---

test("judgeIngestTriple: 신규/동일/수정 3상태가 모두 정상이면 PASS", () => {
  const result = judgeIngestTriple({
    fresh: { chunks: 2, duplicate: false, replaced: false },
    duplicate: { chunks: 2, duplicate: true, replaced: false },
    replaced: { chunks: 2, duplicate: false, replaced: true },
  });
  assert.equal(result.pass, true);
});

test("judgeIngestTriple: 동일 재전송인데 duplicate가 false면 FAIL", () => {
  const result = judgeIngestTriple({
    fresh: { chunks: 2, duplicate: false, replaced: false },
    duplicate: { chunks: 2, duplicate: false, replaced: false },
    replaced: { chunks: 2, duplicate: false, replaced: true },
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /동일 재전송이 duplicate===true 아님/);
});

test("judgeIngestTriple: 신규 전송의 chunks가 0이면 FAIL", () => {
  const result = judgeIngestTriple({
    fresh: { chunks: 0, duplicate: false, replaced: false },
    duplicate: { chunks: 2, duplicate: true, replaced: false },
    replaced: { chunks: 2, duplicate: false, replaced: true },
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /신규 전송이 chunks>0/);
});

test("judgeIngestTriple: 수정 재전송의 replaced가 false면 FAIL", () => {
  const result = judgeIngestTriple({
    fresh: { chunks: 2, duplicate: false, replaced: false },
    duplicate: { chunks: 2, duplicate: true, replaced: false },
    replaced: { chunks: 2, duplicate: false, replaced: false },
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /수정 후 재전송이 replaced===true 아님/);
});

// --- judgeDocsUnchanged ---

test("judgeDocsUnchanged: 전후 동일하면 PASS", () => {
  assert.equal(judgeDocsUnchanged(129, 129).pass, true);
});

test("judgeDocsUnchanged: 전후가 다르면 FAIL", () => {
  const result = judgeDocsUnchanged(129, 131);
  assert.equal(result.pass, false);
  assert.match(result.reason, /core \/docs 수 변동\(129 -> 131\)/);
});

// --- judgeManualImmediate ---

test("judgeManualImmediate: 신규 색인(chunks>0)이면 PASS", () => {
  const result = judgeManualImmediate({ doc_id: "abc", chunks: 4, duplicate: false });
  assert.equal(result.pass, true);
});

test("judgeManualImmediate: 재실행으로 duplicate:true여도 PASS", () => {
  const result = judgeManualImmediate({ doc_id: "abc", chunks: 0, duplicate: true });
  assert.equal(result.pass, true);
});

test("judgeManualImmediate: doc_id가 없으면 FAIL", () => {
  const result = judgeManualImmediate({ chunks: 4, duplicate: false });
  assert.equal(result.pass, false);
  assert.match(result.reason, /doc_id 없음/);
});

test("judgeManualImmediate: entry가 null이면 FAIL", () => {
  const result = judgeManualImmediate(null);
  assert.equal(result.pass, false);
});

test("judgeManualImmediate: chunks도 0이고 duplicate도 false면 FAIL(즉시색인 실패)", () => {
  const result = judgeManualImmediate({ doc_id: "abc", chunks: 0, duplicate: false });
  assert.equal(result.pass, false);
  assert.match(result.reason, /즉시색인 실패/);
});
