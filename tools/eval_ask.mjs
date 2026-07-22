#!/usr/bin/env node
// Cosmos M1 Q&A 평가 하네스: mind(:8800) /ask 엔드포인트 판정기.
// 순서: GET /health로 mind 기동 확인 -> questions_ask.json(긍정10+부정3) 순회
//       -> 문항별 POST /ask{question} -> judge_ask.mjs로 판정(정답인용/불충분/trace) -> 표+요약 출력
//       -> D:\cosmos\tools\eval\report_ask.json에 문항별 상세 기록
//       (CONTRACT.md M1 게이트 §2~4: 긍정 hit>=8/10, 부정 3/3, trace 전건 consulted+skipped+why).
// 외부 의존성 0 (전역 fetch만 사용). 판정 로직은 eval/judge_ask.mjs로 분리해 judge_ask.test.mjs가 별도 검증한다.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { judgeAnswer, judgeTrace, topCitedFile } from "./eval/judge_ask.mjs";

const BASE_URL = process.env.COSMOS_MIND_URL ?? "http://127.0.0.1:8800";
const TOOLS_ROOT = "D:\\cosmos\\tools";
const QUESTIONS_PATH = path.join(TOOLS_ROOT, "eval", "questions_ask.json");
const REPORT_PATH = path.join(TOOLS_ROOT, "eval", "report_ask.json");

const GATE_POSITIVE_MIN = 8;
const GATE_NEGATIVE_MIN = 3;

async function checkHealth() {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`unexpected /health response (status ${res.status})`);
}

async function loadQuestions() {
  const raw = await readFile(QUESTIONS_PATH, "utf8");
  return JSON.parse(raw);
}

async function askOne(question) {
  const res = await fetch(`${BASE_URL}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: question.question }),
  });
  if (!res.ok) throw new Error(`/ask returned ${res.status} for ${question.id}`);
  return res.json();
}

async function main() {
  try {
    await checkHealth();
  } catch {
    console.error("mind 서버 미기동. 먼저 실행: mind/dist/cli.js serve --port 8800 (빌드: cd mind && npm run build)");
    process.exitCode = 1;
    return;
  }

  const questions = await loadQuestions();
  const rows = [];
  let positiveTotal = 0;
  let positivePass = 0;
  let negativeTotal = 0;
  let negativePass = 0;
  let traceOkCount = 0;

  for (const q of questions) {
    const t0 = Date.now();
    let envelope;
    try {
      envelope = await askOne(q);
    } catch (err) {
      if (q.expect === "answer") positiveTotal++;
      else negativeTotal++;
      rows.push({
        id: q.id,
        expect: q.expect,
        verdict: "❌",
        insufficient: null,
        top: null,
        trace_ok: false,
        secs: null,
        reason: String(err),
      });
      continue;
    }
    const secs = (Date.now() - t0) / 1000;

    const answerJudge = judgeAnswer(q, envelope);
    const traceJudge = judgeTrace(envelope);
    if (traceJudge.ok) traceOkCount++;

    if (q.expect === "answer") {
      positiveTotal++;
      if (answerJudge.pass) positivePass++;
    } else {
      negativeTotal++;
      if (answerJudge.pass) negativePass++;
    }

    rows.push({
      id: q.id,
      expect: q.expect,
      verdict: answerJudge.pass ? "✅" : "❌",
      insufficient: envelope.insufficient ?? null,
      top: topCitedFile(envelope),
      trace_ok: traceJudge.ok,
      secs,
      reason: answerJudge.pass ? "" : answerJudge.reason,
      trace_reason: traceJudge.ok ? "" : traceJudge.reason,
    });
  }

  console.log("id".padEnd(6) + "판정".padEnd(6) + "insufficient".padEnd(14) + "top인용".padEnd(45) + "trace".padEnd(7) + "secs");
  for (const row of rows) {
    console.log(
      row.id.padEnd(6) +
        row.verdict.padEnd(6) +
        String(row.insufficient).padEnd(14) +
        (row.top ?? "(없음)").padEnd(45) +
        (row.trace_ok ? "OK" : "FAIL").padEnd(7) +
        (row.secs != null ? row.secs.toFixed(1) : "-")
    );
  }

  const positiveGateOk = positivePass >= GATE_POSITIVE_MIN;
  const negativeGateOk = negativePass >= GATE_NEGATIVE_MIN;
  const traceGateOk = traceOkCount === questions.length;

  console.log(`\n긍정 ${positivePass}/${positiveTotal} (게이트 >= ${GATE_POSITIVE_MIN}) ${positiveGateOk ? "✅" : "❌"}`);
  console.log(`부정 ${negativePass}/${negativeTotal} (게이트 = ${GATE_NEGATIVE_MIN}) ${negativeGateOk ? "✅" : "❌"}`);
  console.log(`trace_ok ${traceOkCount}/${questions.length} (게이트 전건) ${traceGateOk ? "✅" : "❌"}`);

  const report = {
    generated_at: new Date().toISOString(),
    positive: { pass: positivePass, total: positiveTotal, gate_min: GATE_POSITIVE_MIN, gate_ok: positiveGateOk },
    negative: { pass: negativePass, total: negativeTotal, gate_min: GATE_NEGATIVE_MIN, gate_ok: negativeGateOk },
    trace_ok: { pass: traceOkCount, total: questions.length, gate_ok: traceGateOk },
    rows,
  };
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`report: ${REPORT_PATH}`);

  if (!positiveGateOk || !negativeGateOk || !traceGateOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error("eval_ask 실패:", err);
  process.exitCode = 1;
});
