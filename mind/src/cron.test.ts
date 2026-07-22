import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CronJob } from "./cron.js";

// M5: CronJob.tick()은 이전 실행이 진행 중이면 겹쳐 실행하지 않는다(오버랩 가드).
// 실제 타이머 없이 tick()을 두 번 연달아 호출해 동기적으로 검증한다.
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
    // 첫 tick이 run() 내부에서 대기 중인 상태에서 두 번째 tick을 호출한다.
    // busy 가드가 즉시 no-op으로 반환해야 하며 run()을 다시 호출하면 안 된다.
    await job.tick();
    assert.equal(runCount, 1);
    assert.equal(maxConcurrent, 1);

    assert.ok(resolveFirst);
    resolveFirst();
    await firstTick;

    // 첫 tick이 끝난 뒤에는 다시 정상적으로 run()이 호출된다.
    await job.tick();
    assert.equal(runCount, 2);
    assert.equal(maxConcurrent, 1);

    const logContent = await readFile(path.join(dataDir, "cron.log"), "utf8");
    assert.equal((logContent.match(/완료/g) ?? []).length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
