#!/usr/bin/env node
// Cosmos M3 deep 협의 모드 A/B 평가 하네스: mind(:8800) /ask를 fast -> deep 순서로 실행해 비교 판정.
// 순서: GET /health(mind+core) 확인 -> questions_deep.json(교차클러스터 긍정5+부정1) 순회
//       -> 문항별 fast(/ask{question}) -> deep(/ask{question, mode:"deep"}) 순차 실행(deep은 전역 직렬)
//       -> judge_deep.mjs로 판정(기준1 클러스터다양성/기준2 신규회수/기준3 trace완전성/부정 insufficient)
//       -> 표+게이트 요약 출력 -> D:\cosmos\tools\eval\report_deep.json에 fast/deep 원본 봉투 전체 보존.
//       (CONTRACT.md M3 게이트: 기준1 >=4/5, 기준2 >=3/5, 기준3 5/5, 부정 1/1. 지연·콜수는 참고용.)
// 외부 의존성 0. 판정 로직은 eval/judge_deep.mjs로 분리해 judge_deep.test.mjs가 별도 검증한다.
//
// 클러스터 매핑 방법(기준1 필요, 상세 설명은 judge_deep.mjs 상단 주석 참조):
// M3 게이트 2차 실측 후 core GET /docs가 cluster_slug(nullable)를 문서별로 직접 노출하도록 확장됐다
// (openapi.yaml DocSummary, 청크 cluster_ids 기준 배정). buildOriginClusterMap은 이제 GET /docs를
// 그대로 읽어 origin -> cluster_slug 딕셔너리를 만든다(근사 없음, cluster_slug가 null인 문서만 제외).

import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import {
  clustersOfSources,
  judgeMultiClusterCitation,
  judgeNewSourceRecovery,
  judgeTraceCompleteness,
  judgeNegativeInsufficient,
} from "./eval/judge_deep.mjs";

const MIND_URL = process.env.COSMOS_MIND_URL ?? "http://127.0.0.1:8800";
const CORE_URL = process.env.COSMOS_CORE_URL ?? "http://127.0.0.1:8801";
const TOOLS_ROOT = "D:\\cosmos\\tools";
const QUESTIONS_PATH = path.join(TOOLS_ROOT, "eval", "questions_deep.json");
const REPORT_PATH = path.join(TOOLS_ROOT, "eval", "report_deep.json");

const CRIT1_MIN = 4; // 서로 다른 클러스터 >=2 인용, 5문항 중
const CRIT2_MIN = 3; // 신규 출처 회수 >=1건, 5문항 중
const CRIT3_MIN = 5; // trace 완전성, 5문항 전건
const NEGATIVE_MIN = 1; // 부정 1문항 전건

const FAST_TIMEOUT_MS = Number(process.env.COSMOS_FAST_TIMEOUT_MS ?? 300_000);
const DEEP_TIMEOUT_MS = Number(process.env.COSMOS_DEEP_TIMEOUT_MS ?? 1_200_000);
const ORIGIN_CLUSTER_MAP_METHOD = "GET /docs cluster_slug 직독(근사 없음, cluster_slug가 null인 문서는 맵에서 제외).";

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function checkHealth(baseUrl, label) {
  try {
    const res = await fetch(`${baseUrl}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    throw new Error(`${label} /health 실패(${baseUrl}): ${err}`);
  }
}

async function loadQuestions() {
  const raw = await readFile(QUESTIONS_PATH, "utf8");
  return JSON.parse(raw);
}

async function fetchActiveClusters() {
  const clusters = await fetchJson(`${CORE_URL}/clusters`);
  return clusters.filter((c) => c.status === "active");
}

// GET /docs를 직독해 origin -> cluster_slug 맵을 구축한다(M3 게이트 2차 실측 후: 근사 폐기).
// 실패해도 던지지 않고 warnings에 누적한다(전체 게이트를 막지 않기 위함).
async function buildOriginClusterMap() {
  const map = {};
  const warnings = [];

  try {
    const docs = await fetchJson(`${CORE_URL}/docs`);
    for (const doc of docs ?? []) {
      if (doc.cluster_slug) map[doc.origin] = doc.cluster_slug;
    }
  } catch (err) {
    warnings.push(`GET /docs 실패: ${err}`);
  }

  return { map, warnings };
}

// node:fetch(undici)의 내부 headersTimeout(기본 300s)이 서버 requestTimeout=0과
// 무관하게 장시간 deep 응답을 절단하는 문제(M3 게이트 3차 실측)를 피하기 위해,
// /ask처럼 오래 걸리는 호출은 node:http/https를 직접 써서 자체 타임아웃만 적용한다.
function postJson(urlString, payload, timeoutMs) {
  const url = new URL(urlString);
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  const body = Buffer.from(JSON.stringify(payload), "utf8");

  return new Promise((resolve, reject) => {
    let settled = false;

    const req = requestFn(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.setEncoding("utf8");
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, text: chunks.join("") });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error("__HARNESS_TIMEOUT__"));
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

async function askOne(question, mode, timeoutMs) {
  const body = mode === "deep" ? { question: question.question, mode: "deep" } : { question: question.question };
  try {
    const { status, text } = await postJson(`${MIND_URL}/ask`, body, timeoutMs);
    if (status < 200 || status >= 300) {
      throw new Error(`/ask(${mode}) ${status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof Error && err.message === "__HARNESS_TIMEOUT__") {
      throw new Error(`하네스 타임아웃(${mode} ${Math.round(timeoutMs / 1000)}s) for ${question.id}`);
    }
    throw err;
  }
}

function clusterCount(sources, map) {
  return clustersOfSources(sources, map).size;
}

async function main() {
  try {
    await checkHealth(MIND_URL, "mind");
    await checkHealth(CORE_URL, "core");
  } catch (err) {
    console.error(String(err));
    console.error("core/mind 서버 미기동 또는 비정상. E2E 서버 기동은 본체(admin) 담당 — tools 레인은 실행만 담당.");
    process.exitCode = 1;
    return;
  }

  const questions = await loadQuestions();
  const clusters = await fetchActiveClusters();
  const activeClusterSlugs = clusters.map((c) => c.slug);
  const { map: originClusterMap, warnings: mapWarnings } = await buildOriginClusterMap();

  if (mapWarnings.length > 0) {
    console.warn("origin->cluster 맵 경고:");
    for (const w of mapWarnings) console.warn(`  - ${w}`);
  }

  const rows = [];
  const reportQuestions = [];

  let crit1Pass = 0;
  let crit1Total = 0;
  let crit2Pass = 0;
  let crit2Total = 0;
  let crit3Pass = 0;
  let crit3Total = 0;
  let negativePass = 0;
  let negativeTotal = 0;
  let llmCallsSum = 0;
  let fastSecsSum = 0;
  let deepSecsSum = 0;
  let timedCount = 0;

  for (const q of questions) {
    const isNegative = q.expect === "insufficient";

    let fastEnvelope = null;
    let fastSecs = null;
    let fastErr = null;
    const t0 = Date.now();
    try {
      fastEnvelope = await askOne(q, "fast", FAST_TIMEOUT_MS);
      fastSecs = (Date.now() - t0) / 1000;
    } catch (err) {
      fastErr = String(err);
    }

    let deepEnvelope = null;
    let deepSecs = null;
    let deepErr = null;
    const t1 = Date.now();
    try {
      deepEnvelope = await askOne(q, "deep", DEEP_TIMEOUT_MS);
      deepSecs = (Date.now() - t1) / 1000;
    } catch (err) {
      deepErr = String(err);
    }

    const judged = {};
    if (isNegative) {
      negativeTotal++;
      if (deepErr) {
        judged.negative = { pass: false, reason: deepErr };
      } else {
        judged.negative = judgeNegativeInsufficient(deepEnvelope);
      }
      if (judged.negative.pass) negativePass++;
    } else {
      crit1Total++;
      crit2Total++;
      crit3Total++;
      if (fastErr || deepErr) {
        const reason = deepErr || fastErr;
        judged.crit1 = { pass: false, reason };
        judged.crit2 = { pass: false, reason };
        judged.crit3 = { pass: false, reason };
      } else {
        judged.crit1 = judgeMultiClusterCitation(deepEnvelope.sources, originClusterMap);
        judged.crit2 = judgeNewSourceRecovery(fastEnvelope.sources, deepEnvelope.sources);
        judged.crit3 = judgeTraceCompleteness(deepEnvelope.trace, activeClusterSlugs);
      }
      if (judged.crit1.pass) crit1Pass++;
      if (judged.crit2.pass) crit2Pass++;
      if (judged.crit3.pass) crit3Pass++;
    }

    if (fastSecs != null) fastSecsSum += fastSecs;
    if (deepSecs != null) deepSecsSum += deepSecs;
    if (deepEnvelope?.cost?.llm_calls != null) {
      llmCallsSum += deepEnvelope.cost.llm_calls;
      timedCount++;
    }

    rows.push({
      id: q.id,
      neg: isNegative,
      fastSrc: fastEnvelope?.sources?.length ?? null,
      fastClusters: fastEnvelope ? clusterCount(fastEnvelope.sources, originClusterMap) : null,
      deepSrc: deepEnvelope?.sources?.length ?? null,
      deepClusters: deepEnvelope ? clusterCount(deepEnvelope.sources, originClusterMap) : null,
      newRecovered: judged.crit2?.newOrigins?.length ?? null,
      fastSecs,
      deepSecs,
      c1: isNegative ? null : judged.crit1.pass,
      c2: isNegative ? null : judged.crit2.pass,
      c3: isNegative ? null : judged.crit3.pass,
      neg_pass: isNegative ? judged.negative.pass : null,
    });

    reportQuestions.push({
      id: q.id,
      question: q.question,
      expect: q.expect,
      expected_clusters: q.expected_clusters,
      gold_files_any: q.gold_files_any,
      fast: { envelope: fastEnvelope, secs: fastSecs, error: fastErr },
      deep: { envelope: deepEnvelope, secs: deepSecs, error: deepErr },
      judged,
    });
  }

  const col = (s, n) => String(s).padEnd(n);
  console.log(
    col("id", 6) +
      col("fast#src", 9) +
      col("fast#clu", 9) +
      col("deep#src", 9) +
      col("deep#clu", 9) +
      col("신규+", 6) +
      col("fastSec", 8) +
      col("deepSec", 8) +
      col("C1", 4) +
      col("C2", 4) +
      col("C3", 4) +
      "부정"
  );
  for (const r of rows) {
    const mark = (v) => (v == null ? "-" : v ? "✅" : "❌");
    console.log(
      col(r.id, 6) +
        col(r.fastSrc ?? "-", 9) +
        col(r.fastClusters ?? "-", 9) +
        col(r.deepSrc ?? "-", 9) +
        col(r.deepClusters ?? "-", 9) +
        col(r.newRecovered ?? "-", 6) +
        col(r.fastSecs != null ? r.fastSecs.toFixed(1) : "-", 8) +
        col(r.deepSecs != null ? r.deepSecs.toFixed(1) : "-", 8) +
        col(mark(r.c1), 4) +
        col(mark(r.c2), 4) +
        col(mark(r.c3), 4) +
        (r.neg ? mark(r.neg_pass) : "-")
    );
  }

  const crit1Ok = crit1Pass >= CRIT1_MIN;
  const crit2Ok = crit2Pass >= CRIT2_MIN;
  const crit3Ok = crit3Pass >= CRIT3_MIN;
  const negativeOk = negativePass >= NEGATIVE_MIN;

  console.log(`\n기준1(클러스터>=2 인용) ${crit1Pass}/${crit1Total} (게이트 >= ${CRIT1_MIN}) ${crit1Ok ? "✅" : "❌"}`);
  console.log(`기준2(신규 출처 회수)   ${crit2Pass}/${crit2Total} (게이트 >= ${CRIT2_MIN}) ${crit2Ok ? "✅" : "❌"}`);
  console.log(`기준3(trace 완전성)     ${crit3Pass}/${crit3Total} (게이트 = ${CRIT3_MIN}) ${crit3Ok ? "✅" : "❌"}`);
  console.log(`부정(코퍼스 밖 차단)    ${negativePass}/${negativeTotal} (게이트 = ${NEGATIVE_MIN}) ${negativeOk ? "✅" : "❌"}`);
  console.log(
    `\n[참고, 게이트 아님] fast 평균 ${(fastSecsSum / questions.length).toFixed(1)}s, ` +
      `deep 평균 ${(deepSecsSum / questions.length).toFixed(1)}s, deep llm_calls 합계 ${llmCallsSum}` +
      (timedCount < questions.length ? ` (cost.llm_calls 확보 ${timedCount}/${questions.length}건)` : "")
  );

  const report = {
    generated_at: new Date().toISOString(),
    base_urls: { mind: MIND_URL, core: CORE_URL },
    origin_cluster_map_method: ORIGIN_CLUSTER_MAP_METHOD,
    origin_cluster_map_warnings: mapWarnings,
    active_cluster_slugs: activeClusterSlugs,
    origin_cluster_map: originClusterMap,
    criterion1: { pass: crit1Pass, total: crit1Total, gate_min: CRIT1_MIN, gate_ok: crit1Ok },
    criterion2: { pass: crit2Pass, total: crit2Total, gate_min: CRIT2_MIN, gate_ok: crit2Ok },
    criterion3: { pass: crit3Pass, total: crit3Total, gate_min: CRIT3_MIN, gate_ok: crit3Ok },
    negative: { pass: negativePass, total: negativeTotal, gate_min: NEGATIVE_MIN, gate_ok: negativeOk },
    latency_reference: {
      fast_avg_secs: fastSecsSum / questions.length,
      deep_avg_secs: deepSecsSum / questions.length,
      deep_llm_calls_sum: llmCallsSum,
    },
    questions: reportQuestions,
  };
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`report: ${REPORT_PATH}`);

  if (!crit1Ok || !crit2Ok || !crit3Ok || !negativeOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error("eval_deep 실패:", err);
  process.exitCode = 1;
});
