// Personal knowledge repo connector: each person's GitHub repo (.md notes) is the source of
// truth; mind pulls from the server and ingests it as owner=that person's own space. See
// CONTRACT.md "개인 지식 레포 커넥터 (M9.6)".
// GitHub access is just 2 API calls (head sha → tarball), and tar.gz is unpacked with a
// dependency-free parser (keeps mind's runtime dependency count at 0).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { gunzipSync } from "node:zlib";
import path from "node:path";

import { defaultDataDir } from "./config.js";
import type { CoreClient, IngestRequest } from "./core-client.js";

export interface RepoEntry {
  /** Owner of the personal space (name from users.json; admin gets "admin").
   *  P4 shared repos use the reserved key "@shared/<repo-name>" — usernames can't
   *  contain '/', so there's no collision. */
  owner: string;
  /** P4: true for a shared repo — ingested under the shared scope with no owner (admin-only). */
  shared?: boolean;
  /** "owner/name" format */
  repo: string;
  /** GitHub's default branch when omitted */
  branch?: string;
  /** Token for a personal-account repo (optional). Falls back to env GITHUB_KNOWLEDGE_TOKEN. */
  token?: string;
  last_sha?: string;
  last_synced?: string;
  last_error?: string;
  last_ingested?: number;
}

export interface RepoSyncResult {
  repo: string;
  owner: string;
  changed: boolean;
  ingested: number;
  duplicate: number;
  sha?: string;
  error?: string;
}

export interface RepoDeps {
  core: CoreClient;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function reposPath(dataDir: string): string {
  return path.join(dataDir, "repos.json");
}

export async function loadRepos(dataDir = defaultDataDir()): Promise<RepoEntry[]> {
  try {
    const raw = await readFile(reposPath(dataDir), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RepoEntry[]) : [];
  } catch {
    return [];
  }
}

export async function saveRepos(entries: RepoEntry[], dataDir = defaultDataDir()): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(reposPath(dataDir), JSON.stringify(entries, null, 2), "utf8");
}

/** One repo per owner (v1): replaces if present, adds if not. Includes repo format validation. */
export async function upsertRepo(
  entry: Pick<RepoEntry, "owner" | "repo" | "branch" | "token">,
  dataDir = defaultDataDir()
): Promise<RepoEntry> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo)) {
    throw new Error(`repo는 "owner/name" 형식이어야 합니다: ${entry.repo}`);
  }
  const entries = await loadRepos(dataDir);
  const next: RepoEntry = {
    owner: entry.owner,
    repo: entry.repo,
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.token ? { token: entry.token } : {}),
  };
  const idx = entries.findIndex((e) => e.owner === entry.owner);
  if (idx >= 0) entries[idx] = next;
  else entries.push(next);
  await saveRepos(entries, dataDir);
  return next;
}

/** P4: register a shared repo (called by the admin-only route). One entry per repo — key is "@shared/<name>". */
export async function upsertSharedRepo(
  entry: { repo: string; branch?: string; token?: string },
  dataDir = defaultDataDir()
): Promise<RepoEntry> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo)) {
    throw new Error(`repo는 "owner/name" 형식이어야 합니다: ${entry.repo}`);
  }
  const name = entry.repo.split("/")[1]!;
  const entries = await loadRepos(dataDir);
  const next: RepoEntry = {
    owner: `@shared/${name}`,
    shared: true,
    repo: entry.repo,
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.token ? { token: entry.token } : {}),
  };
  const idx = entries.findIndex((e) => e.owner === next.owner);
  if (idx >= 0) entries[idx] = next;
  else entries.push(next);
  await saveRepos(entries, dataDir);
  return next;
}

/** undici's "fetch failed" hides the real cause in the cause chain — unwrap it here so it's diagnosable. */
export function errorWithCause(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    const e = cur as { message?: string; code?: string; cause?: unknown };
    parts.push(e.code ?? e.message ?? String(cur));
    cur = e.cause;
  }
  return [...new Set(parts)].join(" ← ");
}

function authHeaders(entry: RepoEntry): Record<string, string> {
  const token = entry.token || process.env.GITHUB_KNOWLEDGE_TOKEN;
  return {
    "User-Agent": "cosmos-mind",
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Extracts file path → content from a tar stream (512B header block format).
 * Supports the path= override from GNU longname ('L') and pax extended headers
 * ('x'), so paths over 100 chars are read safely too. Other types are skipped.
 */
export function extractTarFiles(tarBuf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let off = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;

  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // terminator block

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeOctal = header.subarray(124, 136).toString("ascii").replace(/[^0-7]/g, "");
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const body = tarBuf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      pendingLongName = body.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      // pax: "NN path=value\n" record format
      const text = body.toString("utf8");
      const m = /(^|\n)\d+ path=([^\n]+)\n/.exec(text);
      if (typeflag === "x" && m) pendingPaxPath = m[2];
      continue;
    }
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      const name = pendingPaxPath ?? pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      files.set(name, Buffer.from(body));
    }
    pendingLongName = null;
    pendingPaxPath = null;
  }
  return files;
}

/**
 * Production GitHub calls go straight through node:https (manual redirect
 * tracking, 60s timeout). Measured (2026-07-23, Rocky mind container): in the
 * same process, Slack fetch works fine, but GitHub alone hits undici
 * UND_ERR_SOCKET/ECONNREFUSED/hangs — while a fresh node from docker exec
 * succeeds every time. Root cause unidentified, so we work around it the same
 * way as the M3 precedent (long-running LLM calls going straight through
 * node:http). On a cross-host redirect (tarball→codeload) we strip
 * Authorization before following it (same as fetch's standard behavior —
 * the codeload URL is pre-signed, so it works unauthenticated).
 */
function httpsGet(
  url: string,
  headers: Record<string, string>,
  redirects = 3
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { headers }, (res) => {
      const code = res.statusCode ?? 0;
      const loc = res.headers.location;
      if (code >= 300 && code < 400 && loc && redirects > 0) {
        res.resume();
        const next = new URL(loc, url).toString();
        const sameHost = new URL(next).host === new URL(url).host;
        const nextHeaders = { ...headers };
        if (!sameHost) delete nextHeaders.Authorization;
        resolve(httpsGet(next, nextHeaders, redirects - 1));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: code, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("GitHub 요청 60s 타임아웃")));
    req.end();
  });
}

/** Tests go through the injected fetchImpl path; production (none injected) goes straight through node:https. */
async function githubGet(
  url: string,
  entry: RepoEntry,
  fetchImpl: typeof fetch | undefined
): Promise<{ status: number; body: Buffer }> {
  if (fetchImpl) {
    const res = await fetchImpl(url, { headers: authHeaders(entry) });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  }
  return httpsGet(url, authHeaders(entry));
}

async function githubJson(url: string, entry: RepoEntry, fetchImpl: typeof fetch | undefined): Promise<unknown> {
  const res = await githubGet(url, entry, fetchImpl);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitHub ${res.status}: ${url.replace(/^https:\/\/api\.github\.com/, "")}`);
  }
  return JSON.parse(res.body.toString("utf8"));
}

/** No-op if head sha matches last_sha. On change: tarball→extract .md→owner ingest. */
export async function syncRepo(entry: RepoEntry, deps: RepoDeps): Promise<RepoSyncResult> {
  const fetchImpl = deps.fetchImpl; // if none injected (production), githubGet takes the node:https direct path
  const now = deps.now ?? (() => new Date());
  const base = `https://api.github.com/repos/${entry.repo}`;
  const result: RepoSyncResult = { repo: entry.repo, owner: entry.owner, changed: false, ingested: 0, duplicate: 0 };

  let branch = entry.branch;
  if (!branch) {
    const info = (await githubJson(base, entry, fetchImpl)) as { default_branch?: string };
    branch = info.default_branch ?? "main";
  }

  const head = (await githubJson(`${base}/commits/${encodeURIComponent(branch)}`, entry, fetchImpl)) as { sha?: string };
  if (!head.sha) throw new Error(`head sha를 얻지 못했습니다: ${entry.repo}@${branch}`);
  result.sha = head.sha;
  if (head.sha === entry.last_sha) return result; // unchanged

  const tarRes = await githubGet(`${base}/tarball/${encodeURIComponent(branch)}`, entry, fetchImpl);
  if (tarRes.status < 200 || tarRes.status >= 300) throw new Error(`tarball ${tarRes.status}`);
  const files = extractTarFiles(gunzipSync(tarRes.body));

  // P4: shared repos get no owner (shared scope) — namespaced as "knowledge://shared/<repo-name>/".
  const originBase = entry.shared ? `knowledge://shared/${entry.repo.split("/")[1]}` : `knowledge://${entry.owner}`;

  const docs: IngestRequest["docs"] = [];
  for (const [name, buf] of files) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    // GitHub tarball paths are prefixed with "<repo>-<sha>/..." — strip the first segment.
    const rel = name.split("/").slice(1).join("/");
    if (!rel || rel.includes("node_modules/") || rel.split("/").some((seg) => seg.startsWith("."))) continue;
    const text = buf.toString("utf8");
    if (!text.trim()) continue;
    const titleLine = text.split("\n").find((l) => /^#\s+/.test(l));
    docs.push({
      origin: `${originBase}/${rel}`,
      source_type: "session",
      title: titleLine ? titleLine.replace(/^#\s+/, "").trim() : path.basename(rel, ".md"),
      text,
    });
  }

  result.changed = true;
  for (let i = 0; i < docs.length; i += 50) {
    const batch = docs.slice(i, i + 50);
    const resp = await deps.core.ingest(entry.shared ? { docs: batch } : { owner: entry.owner, docs: batch });
    for (const r of resp.ingested) {
      result.ingested++;
      if (r.duplicate) result.duplicate++;
    }
  }

  entry.branch = branch;
  entry.last_sha = head.sha;
  entry.last_synced = now().toISOString();
  entry.last_ingested = result.ingested;
  delete entry.last_error;
  return result;
}

/** Walks all repos (shared by cron and manual sync). Failures are recorded on the entry and syncing continues. */
export async function syncAllRepos(deps: RepoDeps): Promise<RepoSyncResult[]> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const entries = await loadRepos(dataDir);
  const results: RepoSyncResult[] = [];
  for (const entry of entries) {
    try {
      results.push(await syncRepo(entry, deps));
    } catch (err) {
      const msg = errorWithCause(err);
      entry.last_error = msg;
      results.push({ repo: entry.repo, owner: entry.owner, changed: false, ingested: 0, duplicate: 0, error: msg });
    }
  }
  await saveRepos(entries, dataDir);
  return results;
}

/** Immediately syncs just the caller's own entry (web's "지금 동기화" button). */
export async function syncOwnerRepo(owner: string, deps: RepoDeps): Promise<RepoSyncResult | null> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const entries = await loadRepos(dataDir);
  const entry = entries.find((e) => e.owner === owner);
  if (!entry) return null;
  try {
    const result = await syncRepo(entry, deps);
    await saveRepos(entries, dataDir);
    return result;
  } catch (err) {
    const msg = errorWithCause(err);
    entry.last_error = msg;
    await saveRepos(entries, dataDir);
    return { repo: entry.repo, owner, changed: false, ingested: 0, duplicate: 0, error: msg };
  }
}

/** For responses: the token is never sent out. */
export function publicRepoView(entry: RepoEntry): Omit<RepoEntry, "token"> & { has_token: boolean } {
  const { token, ...rest } = entry;
  return { ...rest, has_token: Boolean(token || process.env.GITHUB_KNOWLEDGE_TOKEN) };
}
