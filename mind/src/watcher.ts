// Polling scanner (session/repo paths): bulk-sends .md files from configured sources to core /ingest.
// Does not use fs.watch (Windows reliability). See CONTRACT.md M2 extension section "워처".
// M6a: supports config.sources (session|repo, include_meta/docs_only). Falls back to legacy dirs if absent.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { CoreClient, IngestDoc, IngestResponse } from "./core-client.js";
import type { SourceConfig, WatcherConfig } from "./config.js";

const EXCLUDED_FILENAMES = new Set(["MEMORY.md", "dashboard.md", "index.md", "log.md"]);
const EXCLUDED_DIR_NAMES = new Set(["_templates"]);

// M6a: always excluded regardless of mode (session/repo).
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

// M6a: whitelist scanner used only in repo mode (docs_only). Collects only root-level
// PLAN*.md/DESIGN*.md/README.md plus recursive *.md under docs/, design/, contract/.
// Does not descend into any other root-level subdirectory.
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
  // Injection point for mocking the remote mind /ingest call in tests (same fetchImpl pattern as collect.ts).
  fetchImpl?: typeof fetch;
}

export async function scanOnce(config: WatcherConfig, deps: WatcherDeps): Promise<ScanSummary> {
  const summary: ScanSummary = { scanned: 0, ingested: 0, duplicate: 0, replaced: 0, failed: [] };
  const docs: IngestDoc[] = [];

  // M6a: if sources is missing or empty, falls back to treating the legacy dirs (session) as the source.
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

  // M9: session sources (memory/wiki) are the admin's personal knowledge, while repo sources
  // (project canon) are shared — since the owner differs, batches are sent separately
  // (a batch with 0 items skips the call).
  const sessionDocs = docs.filter((d) => d.source_type === "session");
  const repoDocs = docs.filter((d) => d.source_type !== "session");
  const batches: Array<{ docs: IngestDoc[]; owner?: string }> = [];
  if (sessionDocs.length > 0) batches.push({ docs: sessionDocs, owner: "admin" });
  if (repoDocs.length > 0) batches.push({ docs: repoDocs });

  // If COSMOS_MIND_URL is set, sends to mind's own /ingest proxy instead of calling core directly
  // (for watchers that have no direct network path to core, e.g. in split-container deployments).
  // Falls back to the existing behavior if unset.
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
