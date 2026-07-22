// 폴링 스캐너(session/repo 경로): 설정된 소스의 .md 파일을 core /ingest에 벌크 전송한다.
// fs.watch 미사용(Windows 신뢰성). CONTRACT.md M2 확장 절 "워처" 참고.
// M6a: config.sources(session|repo, include_meta/docs_only)를 지원. 없으면 기존 dirs 폴백.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { CoreClient, IngestDoc, IngestResponse } from "./core-client.js";
import type { SourceConfig, WatcherConfig } from "./config.js";

const EXCLUDED_FILENAMES = new Set(["MEMORY.md", "dashboard.md", "index.md", "log.md"]);
const EXCLUDED_DIR_NAMES = new Set(["_templates"]);

// M6a: 모드(session/repo) 무관하게 항상 제외한다.
const GLOBAL_EXCLUDED_FILENAMES = new Set(["RESULTS.md"]);
const GLOBAL_EXCLUDED_DIR_NAMES = new Set(["node_modules", "target", "dist", ".git", ".omc", "data", "models", "vendor"]);

export function isWatchedFile(filename: string, opts: { includeMeta?: boolean } = {}): boolean {
  if (!filename.toLowerCase().endsWith(".md")) return false;
  if (GLOBAL_EXCLUDED_FILENAMES.has(filename)) return false;
  if (!opts.includeMeta && EXCLUDED_FILENAMES.has(filename)) return false;
  return true;
}

export async function listMarkdownFiles(dir: string, opts: { includeMeta?: boolean } = {}): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name) || GLOBAL_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      const sub = await listMarkdownFiles(path.join(dir, entry.name), opts);
      results.push(...sub);
    } else if (entry.isFile() && isWatchedFile(entry.name, opts)) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

// M6a: 레포 모드(docs_only)에서만 쓰는 화이트리스트 스캐너. 루트의 PLAN*.md/DESIGN*.md/README.md와
// docs/·design/·contract/ 하위(재귀 *.md)만 수집한다. 그 외 루트 하위 디렉터리는 내려가지 않는다.
const DOCS_ONLY_ROOT_PATTERN = /^(plan|design)[^/\\]*\.md$/i;
const DOCS_ONLY_SUBDIRS = new Set(["docs", "design", "contract"]);

function isDocsOnlyRootFile(filename: string): boolean {
  if (GLOBAL_EXCLUDED_FILENAMES.has(filename)) return false;
  if (filename.toLowerCase() === "readme.md") return true;
  return DOCS_ONLY_ROOT_PATTERN.test(filename);
}

async function listDocsOnlyFiles(rootDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name) || GLOBAL_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      if (DOCS_ONLY_SUBDIRS.has(entry.name.toLowerCase())) {
        const sub = await listMarkdownFiles(path.join(rootDir, entry.name), { includeMeta: true });
        results.push(...sub);
      }
    } else if (entry.isFile() && isDocsOnlyRootFile(entry.name)) {
      results.push(path.join(rootDir, entry.name));
    }
  }
  return results;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface ScanSummary {
  scanned: number;
  ingested: number;
  duplicate: number;
  replaced: number;
  failed: string[];
}

export interface WatcherDeps {
  core: CoreClient;
  // 테스트에서 원격 mind /ingest 호출을 mock하기 위한 주입 지점(collect.ts의 fetchImpl 패턴과 동일).
  fetchImpl?: typeof fetch;
}

export async function scanOnce(config: WatcherConfig, deps: WatcherDeps): Promise<ScanSummary> {
  const summary: ScanSummary = { scanned: 0, ingested: 0, duplicate: 0, replaced: 0, failed: [] };
  const docs: IngestDoc[] = [];

  // M6a: sources가 없거나 비어있으면 기존 dirs(session)를 소스로 취급해 폴백한다.
  const sources: SourceConfig[] =
    config.sources && config.sources.length > 0
      ? config.sources
      : config.dirs.map((dir) => ({ path: dir, source_type: "session" as const }));

  for (const source of sources) {
    if (!(await pathExists(source.path))) {
      console.error(`[watcher] 경로 없음, 스킵: ${source.path}`);
      continue;
    }
    const files = source.docs_only
      ? await listDocsOnlyFiles(source.path)
      : await listMarkdownFiles(source.path, { includeMeta: !!source.include_meta });
    for (const file of files) {
      try {
        const text = await readFile(file, "utf8");
        docs.push({
          origin: file,
          source_type: source.source_type,
          title: path.basename(file, ".md"),
          text,
        });
        summary.scanned += 1;
      } catch (err) {
        summary.failed.push(file);
      }
    }
  }

  if (docs.length === 0) {
    return summary;
  }

  // M9: session 소스(메모리·위키)는 관리자 개인 지식, repo 소스(프로젝트 정본)는 공통 —
  // owner가 다르므로 배치를 분리해 전송한다(0건 배치는 콜 생략).
  const sessionDocs = docs.filter((d) => d.source_type === "session");
  const repoDocs = docs.filter((d) => d.source_type !== "session");
  const batches: Array<{ docs: IngestDoc[]; owner?: string }> = [];
  if (sessionDocs.length > 0) batches.push({ docs: sessionDocs, owner: "admin" });
  if (repoDocs.length > 0) batches.push({ docs: repoDocs });

  // COSMOS_MIND_URL이 설정돼 있으면 core를 직접 부르지 않고 mind 자신의 /ingest 프록시로 보낸다
  // (컨테이너 분리 배포 등에서 core에 직접 네트워크 경로가 없는 워처를 위함). 미설정 시 기존 동작 그대로.
  const mindUrl = process.env.COSMOS_MIND_URL;
  for (const batch of batches) {
    const body = batch.owner ? { docs: batch.docs, owner: batch.owner } : { docs: batch.docs };
    let response: IngestResponse;
    if (mindUrl) {
      const fetchFn = deps.fetchImpl ?? fetch;
      const token = process.env.COSMOS_TOKEN;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetchFn(`${mindUrl}/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`mind /ingest 프록시 요청 실패 (status ${res.status})`);
      }
      response = (await res.json()) as IngestResponse;
    } else {
      response = await deps.core.ingest(body);
    }
    for (const item of response.ingested) {
      summary.ingested += 1;
      if (item.duplicate) summary.duplicate += 1;
      if (item.replaced) summary.replaced += 1;
    }
  }

  return summary;
}

export interface WatcherHandle {
  stop(): void;
}

export function startWatcherLoop(config: WatcherConfig, deps: WatcherDeps): WatcherHandle {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    scanOnce(config, deps)
      .then((summary) => {
        console.log(
          `[watcher] scan 완료: scanned=${summary.scanned} ingested=${summary.ingested} duplicate=${summary.duplicate} replaced=${summary.replaced} failed=${summary.failed.length}`
        );
      })
      .catch((err) => {
        console.warn(`[watcher] scan 실패: ${(err as Error).message}`);
      })
      .finally(() => {
        busy = false;
      });
  }, config.interval_secs * 1000);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
