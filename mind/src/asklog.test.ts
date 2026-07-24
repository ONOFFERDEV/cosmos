import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendAskLog, readAskStats, type AskLogRecord } from "./asklog.js";

function rec(overrides: Partial<AskLogRecord> = {}): AskLogRecord {
  return {
    ts: "2026-07-20T10:00:00.000Z",
    mode: "fast",
    user: "alice",
    client: "web",
    ms: 1200,
    insufficient: false,
    q: "질문",
    ...overrides,
  };
}

test("readAskStats는 ask-log.jsonl이 없으면 빈 통계를 반환한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-asklog-"));
  try {
    const stats = await readAskStats(dataDir);
    assert.deepEqual(stats, { total: 0, days: [], recent: [] });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("appendAskLog는 한 줄씩 기록하고 q를 120자로 자른다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-asklog-"));
  try {
    const longQ = "가".repeat(200);
    await appendAskLog(dataDir, rec({ q: longQ }));
    const stats = await readAskStats(dataDir);
    assert.equal(stats.total, 1);
    assert.equal(stats.recent[0].q.length, 120);
    assert.equal(stats.recent[0].q, longQ.slice(0, 120));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("appendAskLog는 dataDir을 만들 수 없어도 절대 throw하지 않는다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-asklog-"));
  try {
    // A path that collides with an existing file forces mkdir/appendFile to fail.
    const blockerFile = path.join(dataDir, "blocker");
    await writeFile(blockerFile, "not a directory", "utf8");
    const unwritableDir = path.join(blockerFile, "nested");
    await assert.doesNotReject(appendAskLog(unwritableDir, rec()));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("readAskStats는 날짜별/모드별/클라이언트별/사용자별로 집계하고 newest-first로 정렬한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-asklog-"));
  try {
    await appendAskLog(dataDir, rec({ ts: "2026-07-20T09:00:00.000Z", mode: "fast", user: "alice", client: "web", q: "q1" }));
    await appendAskLog(dataDir, rec({ ts: "2026-07-20T10:00:00.000Z", mode: "deep", user: "bob", client: "slack", q: "q2" }));
    await appendAskLog(dataDir, rec({ ts: "2026-07-21T09:00:00.000Z", mode: "fast", user: "alice", client: "mcp", q: "q3" }));

    const stats = await readAskStats(dataDir);
    assert.equal(stats.total, 3);

    assert.equal(stats.days.length, 2);
    assert.equal(stats.days[0].date, "2026-07-21", "newest day first");
    assert.equal(stats.days[0].count, 1);
    assert.deepEqual(stats.days[0].modes, { fast: 1 });
    assert.deepEqual(stats.days[0].clients, { mcp: 1 });
    assert.deepEqual(stats.days[0].users, { alice: 1 });

    assert.equal(stats.days[1].date, "2026-07-20");
    assert.equal(stats.days[1].count, 2);
    assert.deepEqual(stats.days[1].modes, { fast: 1, deep: 1 });
    assert.deepEqual(stats.days[1].clients, { web: 1, slack: 1 });
    assert.deepEqual(stats.days[1].users, { alice: 1, bob: 1 });

    assert.equal(stats.recent.length, 3);
    assert.equal(stats.recent[0].q, "q3", "recent is newest-first");
    assert.equal(stats.recent[2].q, "q1");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("readAskStats는 깨진 줄을 건너뛰고 유효한 줄만 집계한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-asklog-"));
  try {
    await mkdir(dataDir, { recursive: true });
    const valid = JSON.stringify(rec({ ts: "2026-07-20T09:00:00.000Z", q: "ok" }));
    const missingFields = JSON.stringify({ ts: "2026-07-20T09:00:00.000Z" }); // missing mode/user/client
    const lines = [valid, "not json at all", "", missingFields, "{broken", valid].join("\n");
    await writeFile(path.join(dataDir, "ask-log.jsonl"), lines + "\n", "utf8");

    const stats = await readAskStats(dataDir);
    assert.equal(stats.total, 2, "only the two well-formed lines with required fields count");
    assert.equal(stats.recent.every((r) => r.q === "ok"), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("readAskStats는 error 플래그와 30일/20건 제한을 반영한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-asklog-"));
  try {
    await appendAskLog(dataDir, rec({ ts: "2026-07-20T09:00:00.000Z", error: true, insufficient: false, q: "err" }));
    for (let i = 0; i < 25; i++) {
      await appendAskLog(dataDir, rec({ ts: `2026-07-19T${String(i % 24).padStart(2, "0")}:00:00.000Z`, q: `bulk-${i}` }));
    }

    const stats = await readAskStats(dataDir);
    assert.equal(stats.total, 26);
    assert.equal(stats.recent.length, 20, "recent is capped at 20");
    const errored = stats.recent.find((r) => r.q === "err");
    assert.ok(errored);
    assert.equal(errored!.error, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
