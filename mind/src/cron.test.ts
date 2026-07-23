import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CronJob } from "./cron.js";

// M5: CronJob.tick() does not overlap execution if a previous run is still in progress (overlap guard).
// Verified synchronously by calling tick() twice in a row without a real timer.
test("CronJob.tick()은 실행 중일 때 재호출을 무시하고, 완료 후에는 다시 실행된다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-cron-test-"));
  let runCount = 0;
  let concurrentCount = 0;
  let maxConcurrent = 0;
  let resolveFirst: (() => void) | undefined;

  const job = new CronJob({
    name: "test-job",
    intervalHours: 1,
    dataDir,
    run: async () => {
      runCount += 1;
      concurrentCount += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      if (runCount === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      concurrentCount -= 1;
      return { ok: true };
    },
  });

  try {
    const firstTick = job.tick();
    // Call the second tick while the first tick is still waiting inside run().
    // The busy guard should return as an immediate no-op and must not call run() again.
    await job.tick();
    assert.equal(runCount, 1);
    assert.equal(maxConcurrent, 1);

    assert.ok(resolveFirst);
    resolveFirst();
    await firstTick;

    // After the first tick finishes, run() is called normally again.
    await job.tick();
    assert.equal(runCount, 2);
    assert.equal(maxConcurrent, 1);

    const logContent = await readFile(path.join(dataDir, "cron.log"), "utf8");
    assert.equal((logContent.match(/완료/g) ?? []).length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
