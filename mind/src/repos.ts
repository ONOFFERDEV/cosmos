// 개인 지식 레포 커넥터: 각자의 GitHub 레포(.md 노트)가 정본, mind가 서버에서 pull해
// owner=본인 개인 공간으로 ingest한다. CONTRACT.md "개인 지식 레포 커넥터 (M9.6)" 참고.
// GitHub 접근은 API 2콜(head sha → tarball)뿐이며 tar.gz는 무의존 파서로 푼다(mind 런타임 의존성 0 유지).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { gunzipSync } from "node:zlib";
import path from "node:path";

import { defaultDataDir } from "./config.js";
import type { CoreClient, IngestRequest } from "./core-client.js";

export interface RepoEntry {
  /** 개인 공간 소유자(users.json의 이름, admin은 "admin").
   *  P4 공용 레포는 예약 키 "@shared/<레포이름>" — 사용자명에 '/'가 없어 충돌 불가. */
  owner: string;
  /** P4: true면 공용 레포 — owner 없이 shared 스코프로 ingest된다(admin만 등록). */
  shared?: boolean;
  /** "owner/name" 형식 */
  repo: string;
  /** 생략 시 GitHub 기본 브랜치 */
  branch?: string;
  /** 개인 계정 레포용 토큰(선택). 없으면 env GITHUB_KNOWLEDGE_TOKEN 폴백. */
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

/** owner당 1레포(v1): 있으면 교체, 없으면 추가. repo 형식 검증 포함. */
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

/** P4: 공용 레포 등록(admin 전용 라우트가 호출). 레포당 1항목 — 키는 "@shared/<이름>". */
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

/** undici "fetch failed"는 원인이 cause 체인에 숨는다 — 진단 가능하게 펼친다. */
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
 * tar 스트림에서 파일 경로→내용을 추출한다(512B 헤더 블록 규격).
 * GNU longname('L')과 pax 확장 헤더('x')의 path= 오버라이드를 지원해
 * 100자 초과 경로도 안전하게 읽는다. 그 외 타입은 건너뛴다.
 */
export function extractTarFiles(tarBuf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let off = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;

  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 종료 블록

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
      // pax: "NN path=값\n" 레코드 나열
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
 * 프로덕션 GitHub 호출은 node:https 직접(리다이렉트 수동 추적, 60s 타임아웃).
 * 실측(2026-07-23, Rocky mind 컨테이너): 같은 프로세스에서 Slack fetch는 정상인데
 * GitHub만 undici가 UND_ERR_SOCKET/ECONNREFUSED/행 — docker exec의 새 node에선
 * 매번 성공. 원인 미규명이라 M3 전례(장시간 LLM 호출 node:http 직접)대로 우회.
 * 크로스 호스트 리다이렉트(tarball→codeload)에선 Authorization을 떼고 따라간다
 * (fetch의 표준 동작과 동일 — codeload URL은 사전 서명이라 무인증 동작).
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

/** 테스트는 fetchImpl 주입 경로, 프로덕션(미주입)은 node:https 직접. */
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

/** head sha가 last_sha와 같으면 no-op. 변경 시 tarball→.md 추출→owner ingest. */
export async function syncRepo(entry: RepoEntry, deps: RepoDeps): Promise<RepoSyncResult> {
  const fetchImpl = deps.fetchImpl; // 미주입(프로덕션)이면 githubGet이 node:https 직접 경로를 쓴다
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
  if (head.sha === entry.last_sha) return result; // 무변경

  const tarRes = await githubGet(`${base}/tarball/${encodeURIComponent(branch)}`, entry, fetchImpl);
  if (tarRes.status < 200 || tarRes.status >= 300) throw new Error(`tarball ${tarRes.status}`);
  const files = extractTarFiles(gunzipSync(tarRes.body));

  // P4: 공용 레포는 owner 없이(shared 스코프) "knowledge://shared/<레포이름>/" 네임스페이스로.
  const originBase = entry.shared ? `knowledge://shared/${entry.repo.split("/")[1]}` : `knowledge://${entry.owner}`;

  const docs: IngestRequest["docs"] = [];
  for (const [name, buf] of files) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    // GitHub tarball 경로는 "<repo>-<sha>/..." 접두 — 첫 세그먼트를 벗긴다.
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

/** 전체 레포 순회(cron·수동 공용). 실패는 항목에 기록하고 계속 진행한다. */
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

/** 본인 것 1건만 즉시 동기화(웹 "지금 동기화"). */
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

/** 응답용: 토큰은 절대 밖으로 내보내지 않는다. */
export function publicRepoView(entry: RepoEntry): Omit<RepoEntry, "token"> & { has_token: boolean } {
  const { token, ...rest } = entry;
  return { ...rest, has_token: Boolean(token || process.env.GITHUB_KNOWLEDGE_TOKEN) };
}
