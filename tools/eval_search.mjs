#!/usr/bin/env node
// Cosmos M0 검색 평가 하네스: hit@6 측정기.
// 순서: GET /health로 core 기동 확인 -> questions.json의 gold_files가 manifest에 실재하는지 검증
//       -> 질문별 POST /search{query,k:6} -> gold origin 매칭으로 hit 판정 -> 표+요약 출력
//       -> D:\cosmos\tools\eval\report.json에 문항별 상세 기록 (CONTRACT.md M0 게이트 §3: hit@6 >= 10/12).
// 외부 의존성 0 (전역 fetch만 사용). gold_files는 매니페스트 origin의 베어 파일명 규약(윈도우 경로 구분자 불일치 회피).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "http://127.0.0.1:8801";
const TOOLS_ROOT = "D:\\cosmos\\tools";
const QUESTIONS_PATH = path.join(TOOLS_ROOT, "eval", "questions.json");
const MANIFEST_PATH = "D:\\cosmos\\data\\seed\\manifest.json";
const REPORT_PATH = path.join(TOOLS_ROOT, "eval", "report.json");

function basename(p) {
  return p.split(/[\\/]/).pop();
}

async function checkHealth() {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok || (await res.clone().json().catch(() => null))?.status !== "ok") {
    throw new Error(`unexpected /health response (status ${res.status})`);
  }
}

async function loadQuestions() {
  const raw = await readFile(QUESTIONS_PATH, "utf8");
  return JSON.parse(raw);
}

async function loadManifestFilenames() {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  return new Set(manifest.entries.map((e) => basename(e.origin)));
}

function validateGoldFiles(questions, manifestFilenames) {
  const missing = [];
  for (const q of questions) {
    for (const gold of q.gold_files) {
      if (!manifestFilenames.has(gold)) missing.push(`${q.id}: ${gold}`);
    }
  }
  return missing;
}

async function searchOne(question) {
  const res = await fetch(`${BASE_URL}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: question.question, k: 6 }),
  });
  if (!res.ok) throw new Error(`/search returned ${res.status} for ${question.id}`);
  return res.json();
}

function isHit(results, goldFiles) {
  const goldSet = new Set(goldFiles);
  return results.some((r) => goldSet.has(basename(r.origin)));
}

async function main() {
  try {
    await checkHealth();
  } catch {
    console.error("core 서버 미기동");
    process.exitCode = 1;
    return;
  }

  const questions = await loadQuestions();
  const manifestFilenames = await loadManifestFilenames();

  const missing = validateGoldFiles(questions, manifestFilenames);
  if (missing.length > 0) {
    console.error("questions.json의 gold_files가 manifest에 없음:");
    for (const m of missing) console.error(`  - ${m}`);
    process.exitCode = 1;
    return;
  }

  const rows = [];
  let hits = 0;

  for (const q of questions) {
    let response;
    try {
      response = await searchOne(q);
    } catch (err) {
      rows.push({ id: q.id, hit: false, top1: null, gold: q.gold_files, error: String(err) });
      continue;
    }
    const results = response.results ?? [];
    const hit = isHit(results, q.gold_files);
    if (hit) hits++;
    rows.push({
      id: q.id,
      hit,
      top1: results[0] ? basename(results[0].origin) : null,
      gold: q.gold_files,
      results: results.map((r) => ({ origin: r.origin, score: r.score })),
    });
  }

  console.log("id".padEnd(6) + "결과".padEnd(8) + "top1".padEnd(45) + "gold");
  for (const row of rows) {
    const top1 = row.top1 ?? "(없음)";
    console.log(
      row.id.padEnd(6) + (row.hit ? "HIT" : "MISS").padEnd(8) + top1.padEnd(45) + row.gold.join(",")
    );
  }
  console.log(`\nhit@6 = ${hits}/${questions.length}`);

  const report = {
    generated_at: new Date().toISOString(),
    hit_at_6: hits,
    total: questions.length,
    rows,
  };
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`report: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error("eval_search 실패:", err);
  process.exitCode = 1;
});
