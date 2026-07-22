#!/usr/bin/env node
// Cosmos M0 수동 확인용 조회 도구.
//   node tools/try.mjs "질문"        → 한 번 검색하고 종료
//   node tools/try.mjs               → 대화형(질문 입력 반복, 빈 줄로 종료)
// 서버가 꺼져 있으면: core/target/release/cosmos-core.exe serve --port 8801 --out data/out --models models

import readline from "node:readline";

const BASE = process.env.COSMOS_URL ?? "http://127.0.0.1:8801";
const base = (p) => p.split(/[\\/]/).pop();

async function search(query) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, k: 6 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const ms = Date.now() - t0;
  console.log(`\n── 결과 ${j.results.length}건 (${(ms / 1000).toFixed(1)}s, bm25 ${j.stats.num_bm25}·vec ${j.stats.num_vec}→rerank ${j.stats.reranked})`);
  j.results.forEach((r, i) => {
    const snippet = r.text.replace(/\s+/g, " ").slice(0, 180);
    console.log(`\n[${i + 1}] ${base(r.origin)}  (score ${r.score.toFixed(2)}${r.section ? ` · §${r.section.slice(0, 40)}` : ""})`);
    console.log(`    ${snippet}…`);
    console.log(`    출처: ${r.origin} [${r.char_start}..${r.char_end}]`);
  });
  console.log();
}

async function ensureUp() {
  try {
    const h = await (await fetch(`${BASE}/health`)).json();
    console.log(`cosmos-core OK — 문서 ${h.docs} · 청크 ${h.chunks}`);
  } catch {
    console.error("서버 미기동. 먼저 실행: core\\target\\release\\cosmos-core.exe serve --port 8801 --out data\\out --models models");
    process.exit(1);
  }
}

await ensureUp();
const argQuery = process.argv.slice(2).join(" ").trim();
if (argQuery) {
  await search(argQuery);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    rl.question("질문> ", async (q) => {
      if (!q.trim()) return rl.close();
      try { await search(q.trim()); } catch (e) { console.error("오류:", e.message); }
      ask();
    });
  ask();
}
