// Periodic-job (collect/lifecycle) timer within the serve process. See CONTRACT.md M5 expansion section "cron".
// Restructures watcher.ts's busy-flag overlap-guard pattern into a class, so the overlap guard can
// be tested just by calling tick() twice synchronously, without a real timer.

import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { CoreClient } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { type CosmosConfig, defaultDataDir } from "./config.js";
import { runCollect } from "./collect.js";
import { runLifecycle } from "./lifecycle.js";
import { syncAllRepos } from "./repos.js";

export interface CronJobOptions {
  name: string;
  intervalHours: number;
  dataDir: string;
  run: () => Promise<unknown>;
}

export class CronJob {
  private busy = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: CronJobOptions) {}

  /** Does nothing if intervalHours <= 0 (job disabled). */
  start(): void {
    if (this.opts.intervalHours <= 0) return;
    const ms = this.opts.intervalHours * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Skips this tick if the previous run is still in progress (prevents overlap). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.opts.run();
      await this.log(`완료 ${JSON.stringify(result)}`);
    } catch (err) {
      await this.log(`실패 ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async log(message: string): Promise<void> {
    const line = `[cron:${this.opts.name}] ${new Date().toISOString()} ${message}`;
    console.log(line);
    try {
      await appendFile(path.join(this.opts.dataDir, "cron.log"), line + "\n", "utf8");
    } catch {
      // Ignore file-log failures (e.g. data dir missing) — the console log already
      // captured it, and the server process must never crash over this.
    }
  }
}

// Called on serve startup. For each of config.cron's interval_hours values greater than 0,
// builds a CronJob for that job and calls start(). Does nothing if both are 0/unset.
export function startCronJobs(config: CosmosConfig, core: CoreClient, llm: LlmClient): void {
  const dataDir = defaultDataDir();
  const collectHours = config.cron?.collect_interval_hours ?? 0;
  const lifecycleHours = config.cron?.lifecycle_interval_hours ?? 0;

  if (collectHours > 0) {
    const job = new CronJob({
      name: "collect",
      intervalHours: collectHours,
      dataDir,
      run: () => runCollect({ config, core }),
    });
    job.start();
    console.log(`cron 시작: collect ${collectHours}시간 간격.`);
  }

  if (lifecycleHours > 0) {
    const job = new CronJob({
      name: "lifecycle",
      intervalHours: lifecycleHours,
      dataDir,
      run: () => runLifecycle({ core, llm, config: config.lifecycle }, {}),
    });
    job.start();
    console.log(`cron 시작: lifecycle ${lifecycleHours}시간 간격.`);
  }

  // M9.6 personal knowledge repo connector — always runs; each tick is an immediate no-op if no repos are registered.
  const repoHours = config.cron?.repo_sync_interval_hours ?? 1;
  if (repoHours > 0) {
    const job = new CronJob({
      name: "repo-sync",
      intervalHours: repoHours,
      dataDir,
      run: () => syncAllRepos({ core, dataDir }),
    });
    job.start();
    console.log(`cron 시작: repo-sync ${repoHours}시간 간격.`);
  }
}
