// Loader for D:\cosmos\cosmos.config.json. See CONTRACT.md M2 확장 section, "설정 파일".

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

// M6a: extension field for scanning session/repo sources together. Skipped if path is absent (not an error).
export interface SourceConfig {
  path: string;
  source_type: "session" | "repo";
  include_meta?: boolean;
  docs_only?: boolean;
}

// Falls back to the legacy behavior of treating dirs as session sources if sources is absent or an empty array (backward compatible).
// Like cron/policy, sources is an optional field not separately validated in validateConfig().
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

// M5: timer settings for periodic jobs (collect/lifecycle) within the serve process. 0 = that job disabled.
// Like the policy field, this is an optional field not validated in validateConfig() (cron.ts).
export interface CronConfig {
  collect_interval_hours: number;
  lifecycle_interval_hours: number;
  /** M9.6 personal knowledge repo pull interval (default 1, 0 = disabled). */
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
