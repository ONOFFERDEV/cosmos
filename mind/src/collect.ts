// arXiv/RSS collector. See CONTRACT.md M2 extension section "수집기". No LLM use — fully deterministic end to end.

import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { loadConfig, defaultConfigPath, defaultDataDir, type CosmosConfig, type ProfileKeyword } from "./config.js";
import { CoreHttpError, type CoreClient, type BranchSummary } from "./core-client.js";

export type CandidateSourceType = "arxiv" | "rss";

export interface PendingCandidate {
  id: string;
  source_type: CandidateSourceType;
  origin: string;
  title: string;
  summary: string;
  score: number;
  matched: string[];
  fetched_at: string;
  text: string;
  status: "pending";
}

export interface CollectState {
  arxiv: Record<string, string>;
  rss: Record<string, string>;
}

// ---- Pure helpers (unit-test targets, no network/fs access) ----

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (Number.isNaN(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return ENTITY_MAP[entity] ?? match;
  });
}

export function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1] : null;
}

function unwrapCdata(s: string): string {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(text: string, max = 500): string {
  return text.length > max ? text.slice(0, max) : text;
}

export function candidateId(origin: string): string {
  return createHash("sha256").update(origin).digest("hex").slice(0, 12);
}

export interface ArxivEntry {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
}

export function parseArxivAtom(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const block of blocks) {
    const idRaw = extractTag(block, "id");
    const titleRaw = extractTag(block, "title");
    const summaryRaw = extractTag(block, "summary");
    const publishedRaw = extractTag(block, "published") ?? extractTag(block, "updated");
    if (!idRaw || !titleRaw || !summaryRaw) continue;
    const authorBlocks = block.match(/<author>[\s\S]*?<\/author>/g) ?? [];
    const authors = authorBlocks
      .map((ab) => extractTag(ab, "name"))
      .filter((n): n is string => !!n)
      .map((n) => normalizeWhitespace(decodeXmlEntities(n)));
    entries.push({
      id: normalizeWhitespace(idRaw),
      title: normalizeWhitespace(decodeXmlEntities(titleRaw)),
      authors,
      summary: normalizeWhitespace(decodeXmlEntities(summaryRaw)),
      published: publishedRaw ? normalizeWhitespace(publishedRaw) : "",
    });
  }
  return entries;
}

export interface FeedItem {
  id: string;
  title: string;
  summary: string;
  link: string;
  published: string;
}

function cleanFeedText(raw: string): string {
  const unwrapped = unwrapCdata(raw.trim());
  return normalizeWhitespace(stripHtmlTags(decodeXmlEntities(unwrapped)));
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g);
  if (itemBlocks && itemBlocks.length > 0) {
    for (const block of itemBlocks) {
      const title = extractTag(block, "title");
      const link = extractTag(block, "link");
      const description = extractTag(block, "description");
      const guid = extractTag(block, "guid");
      const pubDate = extractTag(block, "pubDate");
      const linkVal = link ? unwrapCdata(link.trim()) : "";
      const idVal = guid ? unwrapCdata(guid.trim()) : linkVal;
      if (!title || !idVal) continue;
      items.push({
        id: idVal,
        title: cleanFeedText(title),
        summary: description ? cleanFeedText(description) : "",
        link: linkVal,
        published: pubDate ? normalizeWhitespace(pubDate) : "",
      });
    }
    return items;
  }
  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/g) ?? [];
  for (const block of entryBlocks) {
    const title = extractTag(block, "title");
    const idRaw = extractTag(block, "id");
    const summary = extractTag(block, "summary") ?? extractTag(block, "content");
    const published = extractTag(block, "published") ?? extractTag(block, "updated");
    const linkMatch = block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i);
    const link = linkMatch ? linkMatch[1] : "";
    if (!title || !idRaw) continue;
    items.push({
      id: normalizeWhitespace(idRaw),
      title: cleanFeedText(title),
      summary: summary ? cleanFeedText(summary) : "",
      link,
      published: published ? normalizeWhitespace(published) : "",
    });
  }
  return items;
}

export function scoreText(
  title: string,
  body: string,
  keywords: ProfileKeyword[]
): { score: number; matched: string[] } {
  const titleLower = title.toLowerCase();
  const bodyLower = body.toLowerCase();
  let score = 0;
  const matched: string[] = [];
  for (const kw of keywords) {
    const term = kw.term.toLowerCase().trim();
    if (!term) continue;
    let hit = false;
    if (titleLower.includes(term)) {
      score += 2 * kw.weight;
      hit = true;
    }
    if (bodyLower.includes(term)) {
      score += kw.weight;
      hit = true;
    }
    if (hit) matched.push(kw.term);
  }
  return { score, matched };
}

export function selectTopCandidates<T extends { score: number }>(items: T[], maxN: number): T[] {
  return [...items].sort((a, b) => b.score - a.score).slice(0, maxN);
}

export function cutUnseen<T extends { id: string }>(entries: T[], lastSeenId: string | undefined): T[] {
  if (!lastSeenId) return entries;
  const idx = entries.findIndex((e) => e.id === lastSeenId);
  return idx === -1 ? entries : entries.slice(0, idx);
}

export function advanceCursor(
  state: CollectState,
  kind: "arxiv" | "rss",
  key: string,
  newestId: string | undefined
): CollectState {
  if (!newestId) return state;
  return { ...state, [kind]: { ...state[kind], [key]: newestId } };
}

// ---- Orchestration (network+fs, not a unit-test target — verified only via smoke tests) ----

export interface CollectSummary {
  written: number;
  consideredArxiv: number;
  consideredRss: number;
  skippedExisting: number;
  cutByCap: number;
  failedFeeds: string[];
  branch_name: string;
}

export interface CollectDeps {
  core: CoreClient;
  config?: CosmosConfig;
  dataDir?: string;
  fetchImpl?: typeof fetch;
}

function inboxDir(dataDir: string, sub: "pending" | "approved" | "rejected" | "migrated"): string {
  return path.join(dataDir, "inbox", sub);
}

/** If the name conflicts (409), appends a -2, -3, ... suffix to create a new branch (a separate branch per collection run). */
async function createBranchWithSuffix(core: CoreClient, baseName: string, createdBy?: string): Promise<BranchSummary> {
  let attempt = 1;
  let name = baseName;
  for (;;) {
    try {
      return await core.createBranch({ name, created_by: createdBy });
    } catch (err) {
      if (err instanceof CoreHttpError && err.status === 409) {
        attempt += 1;
        name = `${baseName}-${attempt}`;
        continue;
      }
      throw err;
    }
  }
}

/** If the name already exists (409), reuses that branch; otherwise creates a new one (for legacy migration — avoids creating a new branch every time). */
async function getOrCreateBranchByName(core: CoreClient, name: string, createdBy?: string): Promise<BranchSummary> {
  try {
    return await core.createBranch({ name, created_by: createdBy });
  } catch (err) {
    if (err instanceof CoreHttpError && err.status === 409) {
      const branches = await core.listBranches();
      const existing = branches.find((b) => b.name === name);
      if (existing) return existing;
    }
    throw err;
  }
}

async function loadExistingIds(dataDir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const sub of ["pending", "approved", "rejected"] as const) {
    const dir = inboxDir(dataDir, sub);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".json")) ids.add(f.slice(0, -".json".length));
    }
  }
  return ids;
}

async function loadState(dataDir: string): Promise<CollectState> {
  try {
    const raw = await readFile(path.join(dataDir, "collect.state.json"), "utf8");
    return JSON.parse(raw) as CollectState;
  } catch {
    return { arxiv: {}, rss: {} };
  }
}

async function saveState(dataDir: string, state: CollectState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "collect.state.json"), JSON.stringify(state, null, 2), "utf8");
}

interface ScoredCandidate {
  source_type: CandidateSourceType;
  id: string;
  origin: string;
  title: string;
  text: string;
  score: number;
  matched: string[];
}

export async function runCollect(deps: CollectDeps): Promise<CollectSummary> {
  const core = deps.core;
  const config = deps.config ?? (await loadConfig(defaultConfigPath()));
  const dataDir = deps.dataDir ?? defaultDataDir();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const keywords = config.collect.profile.keywords;

  const state = await loadState(dataDir);
  const existingIds = await loadExistingIds(dataDir);

  const summary: CollectSummary = {
    written: 0,
    consideredArxiv: 0,
    consideredRss: 0,
    skippedExisting: 0,
    cutByCap: 0,
    failedFeeds: [],
    branch_name: "",
  };

  const scored: ScoredCandidate[] = [];

  for (const category of config.collect.arxiv.categories) {
    try {
      const url = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(
        category
      )}&sortBy=submittedDate&sortOrder=descending&max_results=${config.collect.arxiv.max_per_category}`;
      const res = await fetchImpl(url);
      if (!res.ok) {
        console.warn(`[collect] arxiv ${category} 요청 실패: HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const entries = parseArxivAtom(xml);
      const newest = entries[0]?.id;
      const unseen = cutUnseen(entries, state.arxiv[category]);
      summary.consideredArxiv += unseen.length;
      for (const entry of unseen) {
        const origin = entry.id;
        const id = candidateId(origin);
        if (existingIds.has(id)) {
          summary.skippedExisting += 1;
          continue;
        }
        const text = `${entry.title}\n\n${entry.authors.join(", ")}\n\n${entry.summary}`;
        const { score, matched } = scoreText(entry.title, entry.summary, keywords);
        scored.push({ source_type: "arxiv", id, origin, title: entry.title, text, score, matched });
      }
      Object.assign(state.arxiv, advanceCursor(state, "arxiv", category, newest).arxiv);
    } catch (err) {
      console.warn(`[collect] arxiv ${category} 처리 중 오류: ${(err as Error).message}`);
    }
  }

  for (const feed of config.collect.rss.feeds) {
    if (!feed.enabled) continue;
    try {
      const res = await fetchImpl(feed.url);
      if (!res.ok) {
        console.warn(`[collect] rss ${feed.url} 요청 실패: HTTP ${res.status}`);
        summary.failedFeeds.push(feed.url);
        continue;
      }
      const xml = await res.text();
      const items = parseFeed(xml);
      const newest = items[0]?.id;
      const unseen = cutUnseen(items, state.rss[feed.url]);
      summary.consideredRss += unseen.length;
      for (const item of unseen) {
        const origin = item.link || item.id;
        const id = candidateId(origin);
        if (existingIds.has(id)) {
          summary.skippedExisting += 1;
          continue;
        }
        const text = `${item.title}\n\n${item.summary}`;
        const { score, matched } = scoreText(item.title, item.summary, keywords);
        scored.push({ source_type: "rss", id, origin, title: item.title, text, score, matched });
      }
      Object.assign(state.rss, advanceCursor(state, "rss", feed.url, newest).rss);
    } catch (err) {
      console.warn(`[collect] rss ${feed.url} 처리 중 오류: ${(err as Error).message}`);
      summary.failedFeeds.push(feed.url);
    }
  }

  const top = selectTopCandidates(scored, config.collect.max_pending_per_run);
  summary.cutByCap = scored.length - top.length;

  if (top.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const branch = await createBranchWithSuffix(core, `collect/${today}`, "collect");
    summary.branch_name = branch.name;
    for (const c of top) {
      await core.ingest({
        docs: [{ origin: c.origin, source_type: c.source_type, title: c.title, text: c.text }],
        branch_id: branch.id,
      });
      summary.written += 1;
    }
  }

  if (scored.length - top.length > 0) {
    console.log(`[collect] 탈락(cap 초과): ${scored.length - top.length}건`);
  }

  await saveState(dataDir, state);

  return summary;
}

export interface MigrationResult {
  migrated: number;
  branch_name: string;
}

/**
 * One-time migration of legacy pending items in data/inbox/pending to a branch (inbox-legacy).
 * Does nothing if there's nothing to migrate (migrated=0). Successfully migrated files are moved to data/inbox/migrated.
 * Called once by cli.ts's serve command after the server starts.
 */
export async function migrateLegacyInbox(deps: { core: CoreClient; dataDir?: string }): Promise<MigrationResult> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const pendingDir = inboxDir(dataDir, "pending");

  let files: string[] = [];
  try {
    files = (await readdir(pendingDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }

  if (files.length === 0) {
    return { migrated: 0, branch_name: "" };
  }

  const branchName = "inbox-legacy";
  const branch = await getOrCreateBranchByName(deps.core, branchName, "collect");
  const migratedDir = inboxDir(dataDir, "migrated");
  await mkdir(migratedDir, { recursive: true });

  let migrated = 0;
  for (const f of files) {
    const filePath = path.join(pendingDir, f);
    try {
      const raw = await readFile(filePath, "utf8");
      const candidate = JSON.parse(raw) as PendingCandidate;
      await deps.core.ingest({
        docs: [
          {
            origin: candidate.origin,
            source_type: candidate.source_type,
            title: candidate.title,
            text: candidate.text,
          },
        ],
        branch_id: branch.id,
      });
      await writeFile(path.join(migratedDir, f), raw, "utf8");
      await unlink(filePath);
      migrated += 1;
    } catch (err) {
      console.warn(`[collect] 레거시 인박스 이전 실패 (${f}): ${(err as Error).message}`);
    }
  }

  console.log(`[collect] 레거시 인박스 이전 완료: ${migrated}건 -> 브랜치 '${branchName}'`);

  return { migrated, branch_name: branchName };
}
