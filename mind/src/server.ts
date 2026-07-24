// mind HTTP server (node:http, port 8800). See CONTRACT.md M1/M4 extension section "server".
// POST /ask {question} -> ask response envelope. GET /health -> {status, core: <core /health proxy>}.
// GET /universe -> 3D cosmos view payload (universe.ts). GET / , GET /web/* -> mind/web/ static serving
// (mind/web/ is owned by the designer lane — this file only reads that directory, never writes to it).
// If an exception occurs while handling any request, respond with HTTP 500 + a Korean message, and the process does not die.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CoreHttpError,
  type CoreClient,
  type IngestRequest,
  type SearchRequest,
  type CreateBranchRequest,
  type MergeBranchRequest,
} from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { runAsk } from "./ask.js";
import { runDeepAsk, DEEP_BUSY_MESSAGE } from "./deep.js";
import { resolveIdentity, type Identity } from "./users.js";
import { buildUniverse } from "./universe.js";
import { classifyIntent } from "./intent.js";
import { runGlobalAsk } from "./global.js";
import { sendInvite } from "./invite.js";
import { loadRepos, publicRepoView, syncOwnerRepo, upsertRepo, upsertSharedRepo } from "./repos.js";
import { appendAskLog, readAskStats } from "./asklog.js";
import { defaultDataDir } from "./config.js";

export const DEFAULT_MIND_PORT = 8800;

// mind/web/ is an output directory owned by the designer lane — here we only read it for static serving.
// One level up from the built dist/server.js (../web) is mind/web/ (same pattern as universe.ts's defaultDataDir).
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  // Teammate kit (.ps1) is text/plain+utf-8 — the `iex (irm .../kit)` one-liner fetches it as a string and executes it.
  ".ps1": "text/plain; charset=utf-8",
  // AI-executable runbook (.md) — the teammate's AI fetches it by URL and reads it as text.
  ".md": "text/markdown; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface ServerDeps {
  core: CoreClient;
  llm: LlmClient;
  dataDir?: string;
  fetchImpl?: typeof fetch;
}

export function createMindServer(deps: ServerDeps): Server {
  const server = createServer((req, res) => {
    handleRequest(req, res, deps).catch((err: unknown) => {
      // Final line of defense for cases that slip past every individual try/catch inside handleRequest.
      if (!res.headersSent) {
        sendJson(res, 500, { message: `서버 오류: ${errorMessage(err)}` });
      } else {
        res.end();
      }
    });
  });
  // CONTRACT.md "서버 소켓·진단 규격": disabled because the default requestTimeout (300s) would cut off the socket for deep's long-running responses (up to 900s).
  server.requestTimeout = 0;
  console.log("requestTimeout=0");
  console.log(process.env.COSMOS_TOKEN ? "인증 활성화" : "인증 비활성");
  return server;
}

// M8: since everything was unified into branch review, /inbox routes just return 410 Gone as a notice. See CONTRACT.md "# M8 확장".
const INBOX_GONE_MESSAGE = "브랜치 검토로 일원화되었습니다 — 웹 검토 화면 또는 /branches 사용";

/**
 * Determines identity (name+role) from the Authorization: Bearer <token> header. If COSMOS_TOKEN env
 * is empty, resolveIdentity treats it as local dev mode and always returns admin (same effect as the
 * old isTokenValid's "!token → true" public contract). Keeps the existing 401 response contract on failure.
 */
async function requireIdentity(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps
): Promise<Identity | null> {
  const header = req.headers.authorization;
  const token = header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const identity = await resolveIdentity(token, deps.dataDir);
  if (!identity) {
    sendJson(res, 401, { message: "인증 토큰이 필요합니다" });
    return null;
  }
  return identity;
}

function requireAdmin(identity: Identity, res: ServerResponse): boolean {
  if (identity.role === "admin") return true;
  sendJson(res, 403, { message: "관리자 권한이 필요합니다" });
  return false;
}

/**
 * Determines the owner_scope to pass to core based on identity. See CONTRACT.md "# M9 확장" mind section.
 * admin shares a fixed "admin" personal namespace regardless of the authenticated name (same for multiple admin accounts).
 * If identity is null (unauthenticated public route), only shared is exposed.
 */
export function ownerScopeFor(identity: Identity | null): string {
  if (!identity) return "shared";
  if (identity.role === "admin") return "shared+admin";
  return `shared+${identity.name}`;
}

/** If a core proxy call fails with CoreHttpError, forward core's status (404/409 etc.) as-is. */
function sendCoreError(res: ServerResponse, prefix: string, err: unknown): void {
  if (err instanceof CoreHttpError) {
    sendJson(res, err.status, { message: `${prefix}: ${err.message}` });
    return;
  }
  sendJson(res, 500, { message: `${prefix}: ${errorMessage(err)}` });
}

// ---------------------------------------------------------------------
// Route table — every endpoint declares and registers its auth level here.
//   public   : unauthenticated access allowed (justification comment required — public is the exception, not the default)
//   identity : valid token required (dispatcher sends 401)
//   admin    : identity + admin role (dispatcher sends 403)
// If path is a RegExp, capture groups flow into ctx.params.
// ---------------------------------------------------------------------
type AuthLevel = "public" | "identity" | "admin";

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  deps: ServerDeps;
  url: URL;
  /** Always non-null when auth is identity/admin. Null for public. */
  identity: Identity | null;
  /** Capture groups of the RegExp path (starting from 1). */
  params: string[];
}

interface Route {
  method: "GET" | "POST" | "PUT";
  path: string | RegExp;
  auth: AuthLevel;
  handler: (ctx: RouteContext) => Promise<void> | void;
}

const ROUTES: Route[] = [
  // public: for health checks — no data exposed (counts only).
  { method: "GET", path: "/health", auth: "public", handler: ({ res, deps }) => handleHealth(res, deps) },

  { method: "POST", path: "/ask", auth: "identity", handler: ({ req, res, deps, identity }) => handleAsk(req, res, deps, identity!) },
  { method: "POST", path: "/ask/stream", auth: "identity", handler: ({ req, res, deps, identity }) => handleAskStream(req, res, deps, identity!) },
  { method: "GET", path: "/me", auth: "identity", handler: ({ res, identity }) => sendJson(res, 200, { name: identity!.name, role: identity!.role }) },
  // Ask usage metrics (per-day mode/client/user counts + recent records) — admin only (exposes per-user counts).
  { method: "GET", path: "/stats", auth: "admin", handler: ({ res, deps }) => handleStats(res, deps) },

  // M8: /inbox routes were unified into branch review — 410 notice only (public: just a notice message, no data).
  { method: "GET", path: "/inbox", auth: "public", handler: ({ res }) => sendJson(res, 410, { message: INBOX_GONE_MESSAGE }) },
  { method: "POST", path: /^\/inbox\/([^/]+)\/(approve|reject)$/, auth: "public", handler: ({ res }) => sendJson(res, 410, { message: INBOX_GONE_MESSAGE }) },

  // Knowledge PR (branch): viewing = identity, merge/discard = admin.
  { method: "GET", path: "/branches", auth: "identity", handler: ({ res, deps, url }) => handleListBranches(res, deps, url) },
  { method: "POST", path: "/branches", auth: "identity", handler: ({ req, res, deps, identity }) => handleCreateBranch(req, res, deps, identity!) },
  { method: "GET", path: /^\/branches\/([^/]+)\/docs$/, auth: "identity", handler: ({ res, deps, params }) => handleBranchDocs(res, deps, params[0]) },
  { method: "POST", path: /^\/branches\/([^/]+)\/merge$/, auth: "admin", handler: ({ req, res, deps, params }) => handleMergeBranch(req, res, deps, params[0]) },
  { method: "POST", path: /^\/branches\/([^/]+)\/discard$/, auth: "admin", handler: ({ res, deps, params }) => handleDiscardBranch(res, deps, params[0]) },

  // M8.6 admin console: Slack user search + invite DM sending.
  { method: "GET", path: "/slack/users", auth: "admin", handler: ({ res, deps, url }) => handleSlackUsers(res, deps, url) },
  { method: "POST", path: "/invite", auth: "admin", handler: ({ req, res, deps }) => handleInvite(req, res, deps) },

  // Upload: a member must supply branch_id or owner=self (rule enforced inside the handler).
  { method: "POST", path: "/ingest", auth: "identity", handler: ({ req, res, deps, identity }) => handleIngest(req, res, deps, identity!) },

  // M9.6 personal knowledge repo connector — owner is enforced from identity (can't register someone else's repo).
  { method: "GET", path: "/my/repo", auth: "identity", handler: ({ res, deps, identity }) => handleMyRepoGet(res, deps, identity!) },
  { method: "PUT", path: "/my/repo", auth: "identity", handler: ({ req, res, deps, identity }) => handleMyRepoPut(req, res, deps, identity!) },
  { method: "POST", path: "/my/repo/sync", auth: "identity", handler: ({ res, deps, identity }) => handleMyRepoSync(res, deps, identity!) },
  { method: "GET", path: "/repos", auth: "admin", handler: ({ res, deps }) => handleReposList(res, deps) },
  // P4: shared knowledge repo (ingested into shared scope without an owner) — registration and forced sync are admin-only.
  { method: "PUT", path: "/repos/shared", auth: "admin", handler: ({ req, res, deps }) => handleSharedRepoPut(req, res, deps) },
  { method: "POST", path: "/repos/shared/sync", auth: "admin", handler: ({ res, deps }) => handleSharedRepoSync(res, deps) },

  // public: read-only search — the MCP cosmos_search expects the core response shape as-is.
  // The handler resolves the optional token and forces owner_scope to the server-computed value (blocks M9 impersonation).
  { method: "POST", path: "/search", auth: "public", handler: ({ req, res, deps }) => handleSearch(req, res, deps) },
  // public: 3D cosmos data — unauthenticated = shared only; with a token, the handler grants the caller's own scope.
  { method: "GET", path: "/universe", auth: "public", handler: ({ req, res, deps }) => handleUniverse(req, res, deps) },
  // public: M10 document relation graph — same tier as /universe (unauthenticated = shared only, scope enforced by the server).
  { method: "GET", path: /^\/graph\/docs\/([^/]+)$/, auth: "public", handler: ({ req, res, deps, params }) => handleGraphDoc(req, res, deps, params[0]) },

  // public: teammate personal knowledge kit installer (short URL) — no secrets in the script, the token is entered by whoever runs it.
  { method: "GET", path: "/kit", auth: "public", handler: ({ res }) => serveWebAsset(res, "kit/install.ps1") },

  // public: static web assets.
  { method: "GET", path: "/", auth: "public", handler: ({ res }) => serveWebAsset(res, "index.html") },
  { method: "GET", path: /^\/web\/(.*)$/, auth: "public", handler: ({ res, params }) => handleWebAsset(res, params[0]) },
];

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    let params: string[] = [];
    if (typeof route.path === "string") {
      if (route.path !== url.pathname) continue;
    } else {
      const m = url.pathname.match(route.path);
      if (!m) continue;
      params = m.slice(1);
    }

    let identity: Identity | null = null;
    if (route.auth !== "public") {
      identity = await requireIdentity(req, res, deps);
      if (!identity) return; // 401 already sent
      if (route.auth === "admin" && !requireAdmin(identity, res)) return; // 403 already sent
    }

    await route.handler({ req, res, deps, url, identity, params });
    return;
  }

  sendJson(res, 404, { message: "찾을 수 없는 경로입니다." });
}

/**
 * GET /graph/docs/{doc_id}: looks up a document's relations (in/out) from core and returns them as-is.
 * Public route — resolves the optional token and forces owner_scope to the server-computed value (same principle as /search).
 */
async function handleGraphDoc(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  docId: string
): Promise<void> {
  try {
    const header = req.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    const identity = await resolveIdentity(token, deps.dataDir);
    if (!deps.core.graphDoc) {
      sendJson(res, 501, { message: "그래프 미지원 core입니다" });
      return;
    }
    const payload = await deps.core.graphDoc(decodeURIComponent(docId), ownerScopeFor(identity));
    sendJson(res, 200, payload);
  } catch (err) {
    if (err instanceof CoreHttpError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    sendJson(res, 500, { message: `/graph 조회 실패: ${errorMessage(err)}` });
  }
}

// ---- M9.6 personal knowledge repo connector handlers ----

/** Same rule as ingest's expectedOwner: admin gets the fixed "admin" namespace, member gets their own name. */
function ownerNameFor(identity: Identity): string {
  return identity.role === "admin" ? "admin" : identity.name;
}

async function handleMyRepoGet(res: ServerResponse, deps: ServerDeps, identity: Identity): Promise<void> {
  const entries = await loadRepos(deps.dataDir);
  const mine = entries.find((e) => e.owner === ownerNameFor(identity));
  sendJson(res, 200, mine ? { connected: true, repo: publicRepoView(mine) } : { connected: false });
}

async function handleMyRepoPut(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  identity: Identity
): Promise<void> {
  try {
    const body = (await readJsonBody(req)) as { repo?: unknown; branch?: unknown; token?: unknown };
    if (typeof body?.repo !== "string" || !body.repo.trim()) {
      sendJson(res, 400, { message: 'repo("owner/name")가 필요합니다' });
      return;
    }
    const entry = await upsertRepo(
      {
        owner: ownerNameFor(identity),
        repo: body.repo.trim(),
        branch: typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : undefined,
        token: typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined,
      },
      deps.dataDir
    );
    // Sync once immediately after registration — confirms right there that the connection actually works.
    const result = await syncOwnerRepo(entry.owner, { core: deps.core, dataDir: deps.dataDir, fetchImpl: deps.fetchImpl });
    sendJson(res, 200, { saved: true, sync: result });
  } catch (err) {
    sendJson(res, 400, { message: `레포 등록 실패: ${errorMessage(err)}` });
  }
}

async function handleMyRepoSync(res: ServerResponse, deps: ServerDeps, identity: Identity): Promise<void> {
  const result = await syncOwnerRepo(ownerNameFor(identity), {
    core: deps.core,
    dataDir: deps.dataDir,
    fetchImpl: deps.fetchImpl,
  });
  if (!result) {
    sendJson(res, 404, { message: "연결된 레포가 없습니다 — 먼저 등록하세요" });
    return;
  }
  sendJson(res, result.error ? 502 : 200, result);
}

async function handleReposList(res: ServerResponse, deps: ServerDeps): Promise<void> {
  const entries = await loadRepos(deps.dataDir);
  sendJson(res, 200, entries.map(publicRepoView));
}

/** P4: register a shared repo (admin) — pulled under the shared scope with no owner. Syncs once immediately after registration. */
async function handleSharedRepoPut(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const body = (await readJsonBody(req)) as { repo?: unknown; branch?: unknown; token?: unknown };
    if (typeof body?.repo !== "string" || !body.repo.trim()) {
      sendJson(res, 400, { message: 'repo("owner/name")가 필요합니다' });
      return;
    }
    const entry = await upsertSharedRepo(
      {
        repo: body.repo.trim(),
        branch: typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : undefined,
        token: typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined,
      },
      deps.dataDir
    );
    const result = await syncOwnerRepo(entry.owner, { core: deps.core, dataDir: deps.dataDir, fetchImpl: deps.fetchImpl });
    sendJson(res, 200, { saved: true, sync: result });
  } catch (err) {
    sendJson(res, 400, { message: `공용 레포 등록 실패: ${errorMessage(err)}` });
  }
}

/** P4: immediately sync all shared repos (admin). */
async function handleSharedRepoSync(res: ServerResponse, deps: ServerDeps): Promise<void> {
  const entries = await loadRepos(deps.dataDir);
  const results = [];
  for (const entry of entries.filter((e) => e.shared)) {
    results.push(await syncOwnerRepo(entry.owner, { core: deps.core, dataDir: deps.dataDir, fetchImpl: deps.fetchImpl }));
  }
  sendJson(res, 200, results);
}

/**
 * POST /ingest: forwards {docs:[...]} as-is to core's /ingest and returns its response unchanged.
 * M9: if owner is specified and differs from the caller's own personal space (fixed "admin" for admin,
 * own name for member), returns 403.
 * A team member must have either branch_id or owner=self set (403 if neither is present).
 * Specifying owner+branch_id at the same time isn't blocked here — core's 400 response is passed through as-is.
 */
async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  identity: Identity
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const owner = bodyObj["owner"];
    const expectedOwner = identity.role === "admin" ? "admin" : identity.name;
    if (typeof owner === "string" && owner !== expectedOwner) {
      sendJson(res, 403, { message: "본인 개인 공간에만 업로드할 수 있습니다" });
      return;
    }
    if (identity.role === "member" && !bodyObj["branch_id"] && !owner) {
      sendJson(res, 403, { message: "팀원 업로드는 브랜치를 지정하거나 owner=본인으로 개인 공간에 업로드해야 합니다" });
      return;
    }
    const response = await deps.core.ingest(body as IngestRequest);
    sendJson(res, 200, response);
  } catch (err) {
    sendJson(res, 500, { message: `/ingest 처리 실패: ${errorMessage(err)}` });
  }
}

/**
 * POST /search: forwards {query, k?, cluster_ids?} as-is to core's /search and returns its response unchanged.
 * A public endpoint (accessible without a token), but if an Authorization header is present, it resolves
 * the identity and applies the caller's own scope. Even if the client specifies owner_scope in the body,
 * the server unconditionally overwrites it with its own computed value — this prevents searches disguised
 * under someone else's scope (see CONTRACT.md's mind section, "# M9 확장").
 */
async function handleSearch(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const header = req.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    const identity = await resolveIdentity(token, deps.dataDir);
    const body = await readJsonBody(req);
    const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const request: SearchRequest = {
      ...(bodyObj as unknown as SearchRequest),
      owner_scope: ownerScopeFor(identity),
    };
    const response = await deps.core.search(request);
    sendJson(res, 200, response);
  } catch (err) {
    sendJson(res, 500, { message: `/search 처리 실패: ${errorMessage(err)}` });
  }
}

async function handleUniverse(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    // M9: a public route — no token means shared content only, a token means the caller's own scope (never a 401).
    // resolveIdentity handles this consistently, including dev mode (no COSMOS_TOKEN set = everyone is admin).
    const header = req.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    const identity = await resolveIdentity(token, deps.dataDir);
    const payload = await buildUniverse({ core: deps.core, dataDir: deps.dataDir, ownerScope: ownerScopeFor(identity) });
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 500, { message: `/universe 조립 실패: ${errorMessage(err)}` });
  }
}

async function handleWebAsset(res: ServerResponse, rawSuffix: string): Promise<void> {
  let relPath: string;
  try {
    relPath = decodeURIComponent(rawSuffix);
  } catch {
    sendJson(res, 400, { message: "잘못된 경로입니다." });
    return;
  }
  await serveWebAsset(res, relPath);
}

/**
 * Per-deployment substitution for kit/ text assets — the source only holds {{PUBLIC_URL}}/{{TEMPLATE_REPO}}
 * placeholders, and that organization's own env values get baked in at serve time (if another company
 * runs this, their own URL/template comes out instead).
 */
export function renderKitAsset(text: string): string {
  const publicUrl = (process.env.COSMOS_PUBLIC_URL || "http://localhost:8800").replace(/\/+$/, "");
  const templateRepo = process.env.COSMOS_TEMPLATE_REPO || "ONOFFERDEV/knowledge-template";
  const templateOrg = templateRepo.split("/")[0];
  return text
    .replaceAll("{{PUBLIC_URL}}", publicUrl)
    .replaceAll("{{TEMPLATE_REPO}}", templateRepo)
    .replaceAll("{{TEMPLATE_ORG}}", templateOrg);
}

function isKitTextAsset(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  return p.startsWith("kit/") && (p.endsWith(".md") || p.endsWith(".ps1"));
}

/**
 * Reads and responds with a relative path under mind/web/. Path traversal defense: normalize with
 * path.resolve, then verify with a string-prefix check that the result actually falls under WEB_ROOT
 * (this includes Windows path separator handling, so Windows-only escape attempts like "..%5C"
 * (backslash-encoded) are also caught by this single check).
 */
async function serveWebAsset(res: ServerResponse, relPath: string): Promise<void> {
  const target = path.resolve(WEB_ROOT, relPath);
  const rootWithSep = WEB_ROOT.endsWith(path.sep) ? WEB_ROOT : WEB_ROOT + path.sep;
  if (target !== WEB_ROOT && !target.startsWith(rootWithSep)) {
    sendJson(res, 403, { message: "허용되지 않는 경로입니다." });
    return;
  }

  try {
    let data = await readFile(target);
    if (isKitTextAsset(relPath)) {
      data = Buffer.from(renderKitAsset(data.toString("utf8")), "utf8");
    }
    res.writeHead(200, { "Content-Type": contentTypeFor(target) });
    res.end(data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      sendJson(res, 503, { message: "웹 자산 미배치" });
    } else {
      sendJson(res, 500, { message: `정적 파일 서빙 실패: ${errorMessage(err)}` });
    }
  }
}

async function handleListBranches(res: ServerResponse, deps: ServerDeps, url: URL): Promise<void> {
  try {
    const status = url.searchParams.get("status") ?? undefined;
    const branches = await deps.core.listBranches(status);
    sendJson(res, 200, branches);
  } catch (err) {
    sendCoreError(res, "/branches 조회 실패", err);
  }
}

async function handleBranchDocs(res: ServerResponse, deps: ServerDeps, branchId: string): Promise<void> {
  try {
    const docs = await deps.core.getBranchDocs(branchId);
    sendJson(res, 200, docs);
  } catch (err) {
    sendCoreError(res, `/branches/${branchId}/docs 조회 실패`, err);
  }
}

async function handleCreateBranch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  identity: Identity
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const name = typeof bodyObj["name"] === "string" ? (bodyObj["name"] as string) : null;
    if (!name) {
      sendJson(res, 400, { message: "name 필드가 필요합니다." });
      return;
    }
    const request: CreateBranchRequest = { name, created_by: identity.name };
    const branch = await deps.core.createBranch(request);
    sendJson(res, 200, branch);
  } catch (err) {
    sendCoreError(res, "/branches 생성 실패", err);
  }
}

async function handleMergeBranch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  branchId: string
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const branch = await deps.core.mergeBranch(branchId, body as MergeBranchRequest);
    sendJson(res, 200, branch);
  } catch (err) {
    sendCoreError(res, `/branches/${branchId}/merge 실패`, err);
  }
}

async function handleDiscardBranch(res: ServerResponse, deps: ServerDeps, branchId: string): Promise<void> {
  try {
    const branch = await deps.core.discardBranch(branchId);
    sendJson(res, 200, branch);
  } catch (err) {
    sendCoreError(res, `/branches/${branchId}/discard 실패`, err);
  }
}

interface SlackUser {
  id: string;
  real_name: string;
  display_name: string;
}

interface SlackUsersListResponse {
  ok: boolean;
  error?: string;
  members?: Array<{
    id: string;
    deleted?: boolean;
    is_bot?: boolean;
    real_name?: string;
    profile?: { display_name?: string };
  }>;
}

/** Calls users.list with SLACK_BOT_TOKEN and returns only active, non-bot users whose real_name/display_name contains q. */
async function fetchSlackUsers(q: string, botToken: string, fetchImpl: typeof fetch): Promise<SlackUser[]> {
  const res = await fetchImpl("https://slack.com/api/users.list", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({}),
  });
  const json = (await res.json()) as SlackUsersListResponse;
  if (!res.ok || !json.ok) {
    throw new Error(`slack users.list 실패: ${json.error ?? res.status}`);
  }
  const needle = q.toLowerCase();
  return (json.members ?? [])
    .filter((m) => !m.deleted && !m.is_bot && m.id !== "USLACKBOT")
    .map((m) => ({
      id: m.id,
      real_name: m.real_name ?? "",
      display_name: m.profile?.display_name ?? "",
    }))
    .filter((u) => u.real_name.toLowerCase().includes(needle) || u.display_name.toLowerCase().includes(needle));
}

/** GET /slack/users?q=<name>: admin only — returns 503 if SLACK_BOT_TOKEN isn't configured. */
async function handleSlackUsers(res: ServerResponse, deps: ServerDeps, url: URL): Promise<void> {
  const q = url.searchParams.get("q");
  if (!q) {
    sendJson(res, 400, { message: "q 파라미터가 필요합니다." });
    return;
  }
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    sendJson(res, 503, { message: "슬랙 봇 미구성" });
    return;
  }
  try {
    const users = await fetchSlackUsers(q, botToken, deps.fetchImpl ?? fetch);
    sendJson(res, 200, users);
  } catch (err) {
    sendJson(res, 500, { message: `/slack/users 조회 실패: ${errorMessage(err)}` });
  }
}

/** POST /invite {name, slack_user_id, role?="member"}: admin only — reuses sendInvite from invite.ts. */
async function handleInvite(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const body = await readJsonBody(req);
  const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const name = typeof bodyObj["name"] === "string" ? (bodyObj["name"] as string) : null;
  const slackUserId = typeof bodyObj["slack_user_id"] === "string" ? (bodyObj["slack_user_id"] as string) : null;
  const role = bodyObj["role"] === "admin" ? "admin" : "member";
  if (!name || !slackUserId) {
    sendJson(res, 400, { message: "name, slack_user_id 필드가 필요합니다." });
    return;
  }
  try {
    const result = await sendInvite(name, slackUserId, role, {
      dataDir: deps.dataDir,
      fetchImpl: deps.fetchImpl,
    });
    if (result.delivered) {
      sendJson(res, 200, { sent: true });
    } else {
      sendJson(res, 200, { sent: false, token: result.token });
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("이미 존재하는 사용자입니다")) {
      sendJson(res, 409, { message: err.message });
      return;
    }
    sendJson(res, 500, { message: `/invite 처리 실패: ${errorMessage(err)}` });
  }
}

async function handleHealth(res: ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const core = await deps.core.health();
    sendJson(res, 200, { status: "ok", core });
  } catch (err) {
    sendJson(res, 500, { message: `core 상태 확인 실패: ${errorMessage(err)}` });
  }
}

export type AskMode = "fast" | "deep" | "global";

/** Decides the final pipeline from the mode body field plus the classifyIntent gate. See CONTRACT.md "# M7 확장". */
export function resolveAskMode(rawMode: string, question: string): AskMode {
  if (rawMode === "deep") return "deep";
  if (rawMode === "global") return "global";
  if (rawMode === "point" || rawMode === "fast") return "fast";
  // "auto" or an unrecognized value: classify with the deterministic intent gate.
  return classifyIntent(question) === "global" ? "global" : "fast";
}

/**
 * Runs the pipeline matching mode (fast/deep/global) and returns the envelope. onProgress is only
 * injected from the SSE stream (/ask/stream); when it's not provided, each pipeline treats it as a
 * no-op, so /ask's behavior is unchanged. See CONTRACT.md "# M7.5 확장".
 */
export async function runAskPipeline(
  question: string,
  mode: AskMode,
  deps: ServerDeps,
  onProgress?: (stage: string, detail?: string) => void,
  ownerScope?: string
) {
  if (mode === "deep") {
    return runDeepAsk(question, { core: deps.core, llm: deps.llm, dataDir: deps.dataDir, onProgress, ownerScope });
  }
  if (mode === "global") {
    return runGlobalAsk(question, { core: deps.core, llm: deps.llm, dataDir: deps.dataDir, onProgress, ownerScope });
  }
  return runAsk(question, { core: deps.core, llm: deps.llm, dataDir: deps.dataDir, onProgress, ownerScope });
}

const ASK_CLIENT_RE = /^[a-z0-9_-]{1,20}$/;

/** Resolves the caller's client tag from the X-Cosmos-Client header (web/mcp/slack/...), defaulting to "api" when missing or malformed. */
function resolveAskClient(req: IncomingMessage): string {
  const raw = req.headers["x-cosmos-client"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && ASK_CLIENT_RE.test(value) ? value : "api";
}

interface AskLogInfo {
  mode: AskMode;
  user: string;
  client: string;
  ms: number;
  insufficient: boolean;
  error?: true;
  q: string;
}

/**
 * Fire-and-forget usage logging for one ask call: one console line plus one ask-log.jsonl record.
 * Never awaited by callers — a slow or failing disk write must never delay the /ask response
 * (appendAskLog itself never throws, see asklog.ts).
 */
function logAsk(deps: ServerDeps, info: AskLogInfo): void {
  const secs = (info.ms / 1000).toFixed(1);
  console.log(`[ask] mode=${info.mode} user=${info.user} client=${info.client} ${secs}s`);
  void appendAskLog(deps.dataDir ?? defaultDataDir(), { ts: new Date().toISOString(), ...info });
}

/** GET /stats: aggregated ask usage metrics. Admin-only (exposes per-user ask counts). */
async function handleStats(res: ServerResponse, deps: ServerDeps): Promise<void> {
  const stats = await readAskStats(deps.dataDir ?? defaultDataDir());
  sendJson(res, 200, stats);
}

async function handleAsk(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, identity: Identity): Promise<void> {
  let mode: AskMode = "fast";
  try {
    const body = await readJsonBody(req);
    const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const question = typeof bodyObj["question"] === "string" ? (bodyObj["question"] as string) : null;
    const rawMode = typeof bodyObj["mode"] === "string" ? bodyObj["mode"] : "auto";

    if (!question || !question.trim()) {
      sendJson(res, 400, { message: "question 필드가 필요합니다." });
      return;
    }

    mode = resolveAskMode(rawMode, question);
    const client = resolveAskClient(req);
    const startedAt = Date.now();

    try {
      const envelope = await runAskPipeline(question, mode, deps, undefined, ownerScopeFor(identity));
      sendJson(res, 200, envelope);
      logAsk(deps, { mode, user: identity.name, client, ms: Date.now() - startedAt, insufficient: envelope.insufficient, q: question });
    } catch (err) {
      if (err instanceof Error && err.message === DEEP_BUSY_MESSAGE) {
        sendJson(res, 429, { message: DEEP_BUSY_MESSAGE });
        logAsk(deps, { mode, user: identity.name, client, ms: Date.now() - startedAt, insufficient: false, error: true, q: question });
        return;
      }
      logAsk(deps, { mode, user: identity.name, client, ms: Date.now() - startedAt, insufficient: false, error: true, q: question });
      throw err;
    }
  } catch (err) {
    // Diagnostic spec: also log the stack + stage context to the console (never swallow it). The stage
    // name is carried in the error message by deep.ts via the [deep:<stage>] prefix, so it shows up as-is in err.stack.
    console.error("[ask-error]", mode, err instanceof Error ? err.stack ?? err.message : err);
    sendJson(res, 500, { message: `/ask 처리 실패: ${errorMessage(err)}` });
  }
}

const SSE_KEEPALIVE_MS = 15000;

/**
 * POST /ask/stream: uses the same body/mode resolution as /ask, but streams onProgress milestones
 * immediately as `status` SSE events, and terminates with a single `envelope` event (exactly once)
 * or an `error` event. Spec per CONTRACT.md "# M7.5 확장".
 */
async function handleAskStream(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, identity: Identity): Promise<void> {
  let mode: AskMode = "fast";
  let closed = false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });

  const keepAlive = setInterval(() => {
    if (!closed) res.write(":ka\n\n");
  }, SSE_KEEPALIVE_MS);

  // Must watch res's (response) close — req's (request) close fires as soon as the request body
  // is fully read, which would set closed=true before the stream even starts (even though the response hasn't ended).
  res.on("close", () => {
    closed = true;
    clearInterval(keepAlive);
  });

  function writeEvent(event: string, data: unknown): void {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const body = await readJsonBody(req);
    const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const question = typeof bodyObj["question"] === "string" ? (bodyObj["question"] as string) : null;
    const rawMode = typeof bodyObj["mode"] === "string" ? bodyObj["mode"] : "auto";

    if (!question || !question.trim()) {
      writeEvent("error", { message: "question 필드가 필요합니다." });
      return;
    }

    mode = resolveAskMode(rawMode, question);
    const client = resolveAskClient(req);
    const startedAt = Date.now();

    const onProgress = (stage: string, detail?: string): void => {
      writeEvent("status", detail === undefined ? { stage } : { stage, detail });
    };

    try {
      const envelope = await runAskPipeline(question, mode, deps, onProgress, ownerScopeFor(identity));
      writeEvent("envelope", envelope);
      logAsk(deps, { mode, user: identity.name, client, ms: Date.now() - startedAt, insufficient: envelope.insufficient, q: question });
    } catch (err) {
      if (err instanceof Error && err.message === DEEP_BUSY_MESSAGE) {
        writeEvent("error", { message: DEEP_BUSY_MESSAGE });
        logAsk(deps, { mode, user: identity.name, client, ms: Date.now() - startedAt, insufficient: false, error: true, q: question });
      } else {
        logAsk(deps, { mode, user: identity.name, client, ms: Date.now() - startedAt, insufficient: false, error: true, q: question });
        throw err;
      }
    }
  } catch (err) {
    console.error("[ask-stream-error]", mode, err instanceof Error ? err.stack ?? err.message : err);
    writeEvent("error", { message: `/ask/stream 처리 실패: ${errorMessage(err)}` });
  } finally {
    clearInterval(keepAlive);
    if (!closed) res.end();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
