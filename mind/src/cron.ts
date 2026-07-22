// serve 프로세스 내 주기 작업(collect/lifecycle) 타이머. CONTRACT.md M5 확장 절 "cron" 참고.
// watcher.ts의 busy 플래그 오버랩 가드 패턴을 클래스로 재구성해, 실제 타이머 없이 tick()을
// 동기적으로 두 번 호출하는 것만으로 오버랩 가드를 테스트할 수 있게 한다.

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

  /** intervalHours <= 0이면 아무 것도 하지 않는다(작업 비활성). */
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

  /** 이전 실행이 아직 진행 중이면 이번 tick은 건너뛴다(오버랩 방지). */
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
      // data 디렉토리 미존재 등 파일 로그 실패는 무시한다 — 콘솔 로그는 이미 남겼고
      // 서버 프로세스는 절대 죽으면 안 된다.
    }
  }
}

// serve 시작 시 호출. config.cron의 각 interval_hours가 0보다 크면 해당 작업의
// CronJob을 만들어 start()한다. 둘 다 0/미설정이면 아무 것도 하지 않는다.
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

  // M9.6 개인 지식 레포 커넥터 — 등록된 레포가 없으면 매 tick이 즉시 no-op라 상시 가동.
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
