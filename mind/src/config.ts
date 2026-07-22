// D:\cosmos\cosmos.config.json 로더. CONTRACT.md M2 확장 절 "설정 파일" 참고.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ArxivConfig {
  categories: string[];
  max_per_category: number;
}

export interface RssFeedConfig {
  url: string;
  enabled: boolean;
}

export interface ProfileKeyword {
  term: string;
  weight: number;
}

export interface CollectConfig {
  arxiv: ArxivConfig;
  rss: { feeds: RssFeedConfig[] };
  profile: { keywords: ProfileKeyword[] };
  max_pending_per_run: number;
}

// M6a: session/repo 소스를 함께 스캔하기 위한 확장 항목. path 부재 시 스킵(에러 아님).
export interface SourceConfig {
  path: string;
  source_type: "session" | "repo";
  include_meta?: boolean;
  docs_only?: boolean;
}

// sources가 없거나 빈 배열이면 dirs를 session 소스로 취급하는 기존 동작에 폴백한다(하위호환).
// cron/policy와 동일하게 sources는 validateConfig()에서 별도 검증하지 않는 선택 필드다.
export interface WatcherConfig {
  dirs: string[];
  interval_secs: number;
  sources?: SourceConfig[];
}

export type PolicyMode = "approval" | "direct" | "auto";

export interface PolicyConfig {
  arxiv: PolicyMode;
  rss: PolicyMode;
  manual: PolicyMode;
  session: PolicyMode;
}

export interface LifecycleConfig {
  birth_min: number;
  birth_cohesion: number;
  merge_sim: number;
}

// M5: serve 프로세스 내 주기 작업(collect/lifecycle) 타이머 설정. 0 = 해당 작업 비활성.
// policy 필드와 동일하게 validateConfig()에서 검증하지 않는 선택 필드다(cron.ts).
export interface CronConfig {
  collect_interval_hours: number;
  lifecycle_interval_hours: number;
  /** M9.6 개인 지식 레포 pull 주기(기본 1, 0=비활성). */
  repo_sync_interval_hours?: number;
}

export interface CosmosConfig {
  collect: CollectConfig;
  watcher: WatcherConfig;
  policy: PolicyConfig;
  lifecycle: LifecycleConfig;
  cron?: CronConfig;
}

function here(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function defaultConfigPath(): string {
  return path.resolve(here(), "..", "..", "cosmos.config.json");
}

export function defaultDataDir(): string {
  return path.resolve(here(), "..", "..", "data");
}

function validateConfig(cfg: CosmosConfig): void {
  if (!cfg.collect || !Array.isArray(cfg.collect.arxiv?.categories)) {
    throw new Error("cosmos.config.json: collect.arxiv.categories가 필요합니다.");
  }
  if (!Array.isArray(cfg.collect.rss?.feeds)) {
    throw new Error("cosmos.config.json: collect.rss.feeds가 필요합니다.");
  }
  if (!Array.isArray(cfg.collect.profile?.keywords)) {
    throw new Error("cosmos.config.json: collect.profile.keywords가 필요합니다.");
  }
  if (!Array.isArray(cfg.watcher?.dirs)) {
    throw new Error("cosmos.config.json: watcher.dirs가 필요합니다.");
  }
  if (
    typeof cfg.lifecycle?.birth_min !== "number" ||
    typeof cfg.lifecycle?.birth_cohesion !== "number" ||
    typeof cfg.lifecycle?.merge_sim !== "number"
  ) {
    throw new Error("cosmos.config.json: lifecycle.birth_min/birth_cohesion/merge_sim(숫자)가 필요합니다.");
  }
}

export async function loadConfig(configPath?: string): Promise<CosmosConfig> {
  const p = configPath ?? defaultConfigPath();
  const raw = await readFile(p, "utf8");
  const parsed = JSON.parse(raw) as CosmosConfig;
  validateConfig(parsed);
  return parsed;
}
