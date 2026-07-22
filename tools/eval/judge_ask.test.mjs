// judge_ask.mjs 자가테스트. 픽스처 봉투로 정답/오답/trace 결여 3케이스를 포함해 검증한다.
// 실행: node --test tools/eval/judge_ask.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, judgeAnswer, judgeTrace, topCitedFile } from "./judge_ask.mjs";

const positiveQuestion = { id: "q01", expect: "answer", gold_files: ["foo.md"] };
const negativeQuestion = { id: "q11", expect: "insufficient" };

test("judgeAnswer: 정답 - insufficient=false + gold 인용 → PASS", () => {
  const envelope = {
    insufficient: false,
    sources: [{ n: 1, origin: "C:\\seed\\wiki\\foo.md", title: "foo" }],
  };
  assert.equal(judgeAnswer(positiveQuestion, envelope).pass, true);
});

test("judgeAnswer: 오답 - insufficient=false이나 gold 미인용 → FAIL", () => {
  const envelope = {
    insufficient: false,
    sources: [{ n: 1, origin: "C:\\seed\\wiki\\bar.md", title: "bar" }],
  };
  const result = judgeAnswer(positiveQuestion, envelope);
  assert.equal(result.pass, false);
  assert.match(result.reason, /gold_files/);
});

test("judgeAnswer: 부정 문항 - insufficient=true → PASS", () => {
  const envelope = { insufficient: true, sources: [] };
  assert.equal(judgeAnswer(negativeQuestion, envelope).pass, true);
});

test("judgeAnswer: 부정 문항이나 insufficient=false → FAIL", () => {
  const envelope = { insufficient: false, sources: [] };
  assert.equal(judgeAnswer(negativeQuestion, envelope).pass, false);
});

test("judgeTrace: trace 결여(빈 배열) → FAIL", () => {
  const result = judgeTrace({ trace: [] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /consulted/);
});

test("judgeTrace: consulted+skipped+why 전부 있음 → PASS", () => {
  const result = judgeTrace({
    trace: [
      { cluster: "a", action: "consulted", why: "score 0.81 (rank 1)" },
      { cluster: "b", action: "skipped", why: "0.22 < 0.6·top" },
    ],
  });
  assert.equal(result.ok, true);
});

test("judgeTrace: why가 빈 문자열이면 FAIL", () => {
  const result = judgeTrace({
    trace: [
      { cluster: "a", action: "consulted", why: "" },
      { cluster: "b", action: "skipped", why: "0.2" },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /why/);
});

test("judgeTrace: skipped 없음 → FAIL", () => {
  const result = judgeTrace({
    trace: [{ cluster: "a", action: "consulted", why: "score 0.9" }],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /skipped/);
});

test("basename: 윈도우 경로에서 파일명만 추출", () => {
  assert.equal(basename("C:\\Users\\User\\.claude\\wiki\\foo.md"), "foo.md");
});

test("topCitedFile: sources[0] 파일명 반환, 없으면 null", () => {
  assert.equal(topCitedFile({ sources: [{ origin: "C:\\x\\y.md" }] }), "y.md");
  assert.equal(topCitedFile({ sources: [] }), null);
});
