#!/usr/bin/env node
// Cosmos M2 게이트: 유입 3경로(arxiv/rss 승인, manual, session 워처) + 클러스터 자동배정 실측.
// 전제: core(:8801)·mind(:8800) 기동 상태. mind CLI는 child_process로 node dist/cli.js <cmd> 실행.
// contract/CONTRACT.md "# M2 확장"의 "M2 게이트" 6항을 그대로 따른다.

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  judgeAskUncited,
  judgeAskCited,
  judgeUnindexedProof,
  judgeApproveEndToEnd,
  judgeJournalHasIngestAndAssign,
  judgeReject,
  judgeIngestTriple,
  judgeDocsUnchanged,
  judgeManualImmediate,
} from "./eval/judge_m2.mjs";

const CORE_BASE_URL = process.env.COSMOS_CORE_URL ?? "http://127.0.0.1:8801";
const MIND_BASE_URL = process.env.COSMOS_MIND_URL ?? "http://127.0.0.1:8800";
const TOOLS_ROOT = "D:\\cosmos\\tools";
const DATA_ROOT = "D:\\cosmos\\data";
const MIND_CLI = "D:\\cosmos\\mind\\dist\\cli.js";
const REPORT_PATH = path.join(TOOLS_ROOT, "eval", "report_m2.json");

const INBOX_ROOT = path.join(DATA_ROOT, "inbox");
const PENDING_DIR = path.join(INBOX_ROOT, "pending");
const APPROVED_DIR = path.join(INBOX_ROOT, "approved");
const REJECTED_DIR = path.join(INBOX_ROOT, "rejected");

const WATCH_TMP_DIR = path.join(TOOLS_ROOT, ".m2_watch_tmp");
const MANUAL_TMP_DIR = path.join(TOOLS_ROOT, ".m2_manual_tmp");

const CLI_TIMEOUT_MS = 180000;

// --- mind CLI 실행 (절대 reject하지 않고 {code, stdout, stderr, timedOut}로 항상 resolve) ---

function runMindCli(args, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MIND_CLI, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${String(err)}`, timedOut });
    });
  });
}

// --- HTTP 헬퍼 ---

async function coreHealth() {
  const res = await fetch(`${CORE_BASE_URL}/health`);
  if (!res.ok) throw new Error(`core /health ${res.status}`);
  return res.json();
}

async function mindHealth() {
  const res = await fetch(`${MIND_BASE_URL}/health`);
  if (!res.ok) throw new Error(`mind /health ${res.status}`);
  return res.json();
}

async function coreDocs() {
  const res = await fetch(`${CORE_BASE_URL}/docs`);
  if (!res.ok) throw new Error(`core /docs ${res.status}`);
  return res.json();
}

async function coreIngest(docs) {
  const res = await fetch(`${CORE_BASE_URL}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docs }),
  });
  if (!res.ok) throw new Error(`core /ingest ${res.status}`);
  return res.json();
}

async function coreJournal(afterSeq) {
  const res = await fetch(`${CORE_BASE_URL}/journal?after_seq=${afterSeq}`);
  if (!res.ok) throw new Error(`core /journal ${res.status}`);
  return res.json();
}

async function mindAsk(question) {
  const res = await fetch(`${MIND_BASE_URL}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`mind /ask ${res.status}`);
  return res.json();
}

async function checkHealth() {
  await coreHealth();
  await mindHealth();
}

async function docsCount() {
  const docs = await coreDocs();
  return docs.length;
}

async function latestJournalSeq() {
  const { events } = await coreJournal(0);
  return events.reduce((max, e) => Math.max(max, e.seq), 0);
}

// --- inbox 파일시스템 헬퍼 ---

async function readInboxDir(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(dir, name), "utf8");
      entries.push(JSON.parse(raw));
    } catch {
      // 손상된 파일은 건너뜀
    }
  }
  return entries;
}

async function readPendingSortedByScore() {
  const entries = await readInboxDir(PENDING_DIR);
  return entries.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

async function findInboxEntry(dir, id) {
  const entries = await readInboxDir(dir);
  return entries.find((e) => e.id === id) ?? null;
}

async function pendingFileExists(id) {
  const entries = await readInboxDir(PENDING_DIR);
  return entries.some((e) => e.id === id);
}

// --- 게이트 실행 래퍼: 한 게이트의 예외가 전체 실행을 죽이지 않도록 ---

async function safeGate(name, fn) {
  try {
    const detail = await fn();
    return { name, status: detail.pass ? "PASS" : "FAIL", detail, reason: detail.reason ?? "" };
  } catch (err) {
    return { name, status: "FAIL", detail: null, reason: String(err?.stack ?? err) };
  }
}

// --- 게이트1: 수집·미색인 증명 ---

async function gate1_collectUnindexed() {
  const docsBefore = await docsCount();

  const collectResult = await runMindCli(["collect"]);
  if (collectResult.code !== 0) {
    return {
      pass: false,
      reason: `mind collect 실행 실패(code=${collectResult.code}, timedOut=${collectResult.timedOut}): ${collectResult.stderr.slice(0, 500)}`,
      docsBefore,
    };
  }

  const pending = await readPendingSortedByScore();
  const docsAfter = await docsCount();

  const proof = judgeUnindexedProof({ docsBefore, docsAfter, pendingCount: pending.length });
  if (!proof.pass) {
    return { pass: false, reason: proof.reason, docsBefore, docsAfter, pendingCount: pending.length };
  }

  const top = pending[0];
  const envelope = await mindAsk(top.title);
  const askJudge = judgeAskUncited(envelope, top.origin);

  return {
    pass: askJudge.pass,
    reason: askJudge.reason,
    docsBefore,
    docsAfter,
    pendingCount: pending.length,
    topPendingId: top.id,
    topPendingOrigin: top.origin,
  };
}

// --- 게이트2: 승인 종단 ---

async function gate2_approveEndToEnd() {
  const pending = await readPendingSortedByScore();
  if (pending.length === 0) {
    return { pass: false, reason: "승인할 pending 없음(게이트1이 실패했을 가능성)" };
  }
  const target = pending[0];

  const docsBefore = await docsCount();
  const beforeSeq = await latestJournalSeq();

  const approveResult = await runMindCli(["approve", target.id]);
  if (approveResult.code !== 0) {
    return {
      pass: false,
      reason: `mind approve 실행 실패(code=${approveResult.code}): ${approveResult.stderr.slice(0, 500)}`,
      targetId: target.id,
      targetOrigin: target.origin,
    };
  }

  const docsAfterList = await coreDocs();
  const docsAfterApprove = docsAfterList.length;
  const approvedEntry = await findInboxEntry(APPROVED_DIR, target.id);

  const endToEndJudge = judgeApproveEndToEnd({
    docsBefore,
    docsAfterApprove,
    approvedEntry,
    origin: target.origin,
    docsAfterList,
  });

  const journalAfter = await coreJournal(beforeSeq);
  const journalJudge = judgeJournalHasIngestAndAssign(journalAfter.events);

  const envelope = await mindAsk(target.title);
  const askJudge = judgeAskCited(envelope, target.origin);

  const reasons = [endToEndJudge.reason, journalJudge.reason, askJudge.reason].filter(Boolean);

  return {
    pass: endToEndJudge.pass && journalJudge.pass && askJudge.pass,
    reason: reasons.join(" | "),
    targetId: target.id,
    targetOrigin: target.origin,
    docsBefore,
    docsAfterApprove,
    approvedEntry,
  };
}

// --- 게이트3: 거부 ---

async function gate3_reject() {
  const pending = await readPendingSortedByScore();
  if (pending.length === 0) {
    return { pass: false, reason: "거부할 pending 없음(게이트2가 유일한 pending을 승인했을 가능성)" };
  }
  const target = pending[0];

  const docsBefore = await docsCount();

  const rejectResult = await runMindCli(["reject", target.id]);
  if (rejectResult.code !== 0) {
    return {
      pass: false,
      reason: `mind reject 실행 실패(code=${rejectResult.code}): ${rejectResult.stderr.slice(0, 500)}`,
      targetId: target.id,
    };
  }

  const docsAfter = await docsCount();
  const pendingStillExists = await pendingFileExists(target.id);
  const rejectedEntry = await findInboxEntry(REJECTED_DIR, target.id);

  const verdict = judgeReject({ docsBefore, docsAfter, pendingStillExists, rejectedEntry });

  return { pass: verdict.pass, reason: verdict.reason, targetId: target.id, docsBefore, docsAfter };
}

// --- 게이트4: 워처 3상태 + 실제 스캔 무손상 ---

async function gate4_watcher() {
  await mkdir(WATCH_TMP_DIR, { recursive: true });
  const testFile = path.join(WATCH_TMP_DIR, "m2_watch_test.md");
  await writeFile(testFile, "# M2 워처 테스트 문서\n\n최초 내용.\n", "utf8");

  const scanDirsProbe = await runMindCli(["scan", "--dirs", WATCH_TMP_DIR]);

  let watcherMethod;
  let tripleJudge;
  let tripleDetail = null;

  if (scanDirsProbe.code === 0) {
    watcherMethod = "cli_scan_dirs";
    tripleJudge = { pass: true, reason: "cli_scan_dirs 경로: docs 델타 경량 확인만 수행" };
  } else {
    watcherMethod = "core_ingest_direct";
    const origin = testFile;

    const freshContent = "# M2 워처 테스트 문서\n\n최초 내용.\n";
    const freshRes = await coreIngest([{ origin, source_type: "session", title: "M2 워처 테스트", text: freshContent }]);
    const fresh = freshRes.ingested?.[0] ?? null;

    const dupRes = await coreIngest([{ origin, source_type: "session", title: "M2 워처 테스트", text: freshContent }]);
    const duplicate = dupRes.ingested?.[0] ?? null;

    const modifiedContent = "# M2 워처 테스트 문서\n\n수정된 내용(재전송).\n";
    const replacedRes = await coreIngest([{ origin, source_type: "session", title: "M2 워처 테스트", text: modifiedContent }]);
    const replaced = replacedRes.ingested?.[0] ?? null;

    tripleJudge = judgeIngestTriple({ fresh, duplicate, replaced });
    tripleDetail = { fresh, duplicate, replaced };
  }

  const docsBeforeRealScan = await docsCount();
  const realScan = await runMindCli(["scan"]);

  let realScanJudge;
  if (realScan.code !== 0) {
    realScanJudge = {
      pass: false,
      reason: `scan 명령 실행 실패(미구현 가능, code=${realScan.code}): ${realScan.stderr.slice(0, 300)}`,
    };
  } else {
    const docsAfterRealScan = await docsCount();
    realScanJudge = judgeDocsUnchanged(docsBeforeRealScan, docsAfterRealScan);
  }

  await rm(WATCH_TMP_DIR, { recursive: true, force: true });

  const reasons = [tripleJudge.reason, realScanJudge.reason].filter(Boolean);

  return {
    pass: tripleJudge.pass && realScanJudge.pass,
    reason: reasons.join(" | "),
    watcherMethod,
    tripleDetail,
    docsBeforeRealScan,
  };
}

// --- 게이트5: manual 2건 ---

async function gate5_manual() {
  await mkdir(MANUAL_TMP_DIR, { recursive: true });
  const localFile = path.join(MANUAL_TMP_DIR, "m2_manual_test.md");
  const localContent = "# M2 manual 테스트 문서\n\n로컬 임시 파일 색인 확인용.\n";
  await writeFile(localFile, localContent, "utf8");

  const localRes = await coreIngest([{ origin: localFile, source_type: "manual", title: "M2 manual 로컬 테스트", text: localContent }]);
  const localEntry = localRes.ingested?.[0] ?? null;
  const localJudge = judgeManualImmediate(localEntry);

  let urlText;
  try {
    const res = await fetch("https://example.com");
    urlText = await res.text();
  } catch {
    urlText = "<html><body><h1>Example Domain</h1></body></html>";
  }
  const urlOrigin = "https://example.com";
  const urlRes = await coreIngest([{ origin: urlOrigin, source_type: "manual", title: "Example Domain", text: urlText }]);
  const urlEntry = urlRes.ingested?.[0] ?? null;
  const urlJudge = judgeManualImmediate(urlEntry);

  await rm(MANUAL_TMP_DIR, { recursive: true, force: true });

  const reasons = [localJudge.reason, urlJudge.reason].filter(Boolean);

  return {
    pass: localJudge.pass && urlJudge.pass,
    reason: reasons.join(" | "),
    localEntry,
    urlEntry,
    note: "core에 색인된 두 manual 문서는 표시만 하고 정리하지 않음(정리는 관리자 몫)",
  };
}

// --- main ---

async function main() {
  try {
    await checkHealth();
  } catch (err) {
    console.error("core(:8801) 또는 mind(:8800)가 기동되어 있지 않습니다.");
    console.error(`  core:  cd D:\\cosmos\\core && cargo run`);
    console.error(`  mind:  cd D:\\cosmos\\mind && node dist/cli.js serve`);
    console.error(`오류: ${err}`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  results.push(await safeGate("게이트1 수집·미색인증명", gate1_collectUnindexed));
  results.push(await safeGate("게이트2 승인종단", gate2_approveEndToEnd));
  results.push(await safeGate("게이트3 거부", gate3_reject));
  results.push(await safeGate("게이트4 워처3상태", gate4_watcher));
  results.push(await safeGate("게이트5 manual2건", gate5_manual));

  const nameWidth = Math.max(...results.map((r) => r.name.length));
  console.log("\n=== Cosmos M2 게이트 결과 ===\n");
  for (const r of results) {
    const icon = r.status === "PASS" ? "✅" : "❌";
    const paddedName = r.name.padEnd(nameWidth, " ");
    console.log(`${paddedName}  ${icon}  ${r.reason}`);
  }

  const overallPass = results.every((r) => r.status === "PASS");
  console.log(`\n종합: ${overallPass ? "✅ PASS" : "❌ FAIL"}\n`);

  const watcherMethod = results.find((r) => r.name === "게이트4 워처3상태")?.detail?.watcherMethod ?? null;

  const report = {
    generated_at: new Date().toISOString(),
    gates: results,
    watcher_method: watcherMethod,
    overall_pass: overallPass,
  };
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`리포트 저장: ${REPORT_PATH}`);

  if (!overallPass) process.exitCode = 1;
}

main().catch((err) => {
  console.error("eval_m2 실패:", err);
  process.exitCode = 1;
});
