// mind HTTP 서버 (node:http, 포트 8800). CONTRACT.md M1/M4 확장 절 "server" 참고.
// POST /ask {question} -> ask 응답 봉투. GET /health -> {status, core: <core /health 프록시>}.
// GET /universe -> 3D 코스모스 뷰 페이로드(universe.ts). GET / , GET /web/* -> mind/web/ 정적 서빙
// (mind/web/은 디자이너 레인 소유 — 이 파일은 그 디렉토리를 읽기만 하고 절대 쓰지 않는다).
// 어떤 요청 처리 중 예외가 나도 HTTP 500 + 한국어 message로 응답하고 프로세스는 죽지 않는다.

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

export const DEFAULT_MIND_PORT = 8800;

// mind/web/ 은 디자이너 레인 소유 산출물 디렉토리 — 여기서는 정적 서빙을 위해 읽기만 한다.
// 빌드 산출물 dist/server.js 기준 한 단계 위(../web)가 mind/web/ 이다(universe.ts의 defaultDataDir 패턴과 동일).
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
  // 팀원 킷(.ps1)은 text/plain+utf-8 — `iex (irm .../kit)` 원라이너가 문자열로 받아 실행한다.
  ".ps1": "text/plain; charset=utf-8",
  // AI 실행용 런북(.md) — 팀원의 AI가 URL로 fetch해 텍스트로 읽는다.
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
      // handleRequest 내부의 개별 try/catch를 모두 뚫고 올라온 경우의 최종 방어선.
      if (!res.headersSent) {
        sendJson(res, 500, { message: `서버 오류: ${errorMessage(err)}` });
      } else {
        res.end();
      }
    });
  });
  // CONTRACT.md "서버 소켓·진단 규격": 기본 requestTimeout(300s)이 deep 장시간 응답(최대 900s) 소켓을 절단하므로 비활성화.
  server.requestTimeout = 0;
  console.log("requestTimeout=0");
  console.log(process.env.COSMOS_TOKEN ? "인증 활성화" : "인증 비활성");
  return server;
}

// M8: 브랜치 검토로 일원화됨에 따라 /inbox 계열은 410 Gone으로 안내만 한다. CONTRACT.md "# M8 확장" 참고.
const INBOX_GONE_MESSAGE = "브랜치 검토로 일원화되었습니다 — 웹 검토 화면 또는 /branches 사용";

/**
 * Authorization: Bearer <token> 헤더로 identity(name+role)를 판정한다. COSMOS_TOKEN env가
 * 비어 있으면 resolveIdentity가 로컬 개발 모드로 항상 admin을 반환한다(기존 isTokenValid의
 * "!token → true" 공개 규약과 동일한 효과). 실패 시 기존 401 응답 계약을 그대로 유지한다.
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
 * identity로 core에 전달할 owner_scope를 결정한다. CONTRACT.md "# M9 확장" mind 절 참고.
 * admin은 인증된 이름과 무관하게 고정 "admin" 개인 네임스페이스를 공유한다(다중 admin 계정도 동일).
 * identity가 null(무인증 공개 경로)이면 공통(shared)만 노출한다.
 */
export function ownerScopeFor(identity: Identity | null): string {
  if (!identity) return "shared";
  if (identity.role === "admin") return "shared+admin";
  return `shared+${identity.name}`;
}

/** core 프록시 호출 실패 시 CoreHttpError면 core의 status(404/409 등)를 그대로 전달한다. */
function sendCoreError(res: ServerResponse, prefix: string, err: unknown): void {
  if (err instanceof CoreHttpError) {
    sendJson(res, err.status, { message: `${prefix}: ${err.message}` });
    return;
  }
  sendJson(res, 500, { message: `${prefix}: ${errorMessage(err)}` });
}

// ---------------------------------------------------------------------
// 라우트 테이블 — 모든 엔드포인트는 여기에 auth 수준을 명시하고 등록한다.
//   public   : 무인증 허용 (근거 주석 필수 — 공개는 예외지 기본값이 아니다)
//   identity : 유효 토큰 필요 (401은 디스패처가 전송)
//   admin    : identity + admin 역할 (403은 디스패처가 전송)
// path가 RegExp면 캡처 그룹이 ctx.params로 들어온다.
// ---------------------------------------------------------------------
type AuthLevel = "public" | "identity" | "admin";

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  deps: ServerDeps;
  url: URL;
  /** auth가 identity/admin이면 항상 non-null. public이면 null. */
  identity: Identity | null;
  /** RegExp path의 캡처 그룹(1번부터). */
  params: string[];
}

interface Route {
  method: "GET" | "POST" | "PUT";
  path: string | RegExp;
  auth: AuthLevel;
  handler: (ctx: RouteContext) => Promise<void> | void;
}

const ROUTES: Route[] = [
  // public: 상태 확인용 — 데이터 비노출(카운트만).
  { method: "GET", path: "/health", auth: "public", handler: ({ res, deps }) => handleHealth(res, deps) },

  { method: "POST", path: "/ask", auth: "identity", handler: ({ req, res, deps, identity }) => handleAsk(req, res, deps, identity!) },
  { method: "POST", path: "/ask/stream", auth: "identity", handler: ({ req, res, deps, identity }) => handleAskStream(req, res, deps, identity!) },
  { method: "GET", path: "/me", auth: "identity", handler: ({ res, identity }) => sendJson(res, 200, { name: identity!.name, role: identity!.role }) },

  // M8: /inbox 계열은 브랜치 검토로 일원화 — 410 안내만 (public: 안내 문구뿐, 데이터 없음).
  { method: "GET", path: "/inbox", auth: "public", handler: ({ res }) => sendJson(res, 410, { message: INBOX_GONE_MESSAGE }) },
  { method: "POST", path: /^\/inbox\/([^/]+)\/(approve|reject)$/, auth: "public", handler: ({ res }) => sendJson(res, 410, { message: INBOX_GONE_MESSAGE }) },

  // 지식 PR(브랜치): 열람=identity, 병합/폐기=admin.
  { method: "GET", path: "/branches", auth: "identity", handler: ({ res, deps, url }) => handleListBranches(res, deps, url) },
  { method: "POST", path: "/branches", auth: "identity", handler: ({ req, res, deps, identity }) => handleCreateBranch(req, res, deps, identity!) },
  { method: "GET", path: /^\/branches\/([^/]+)\/docs$/, auth: "identity", handler: ({ res, deps, params }) => handleBranchDocs(res, deps, params[0]) },
  { method: "POST", path: /^\/branches\/([^/]+)\/merge$/, auth: "admin", handler: ({ req, res, deps, params }) => handleMergeBranch(req, res, deps, params[0]) },
  { method: "POST", path: /^\/branches\/([^/]+)\/discard$/, auth: "admin", handler: ({ res, deps, params }) => handleDiscardBranch(res, deps, params[0]) },

  // M8.6 관리 콘솔: 슬랙 사용자 검색 + 초대 DM 발송.
  { method: "GET", path: "/slack/users", auth: "admin", handler: ({ res, deps, url }) => handleSlackUsers(res, deps, url) },
  { method: "POST", path: "/invite", auth: "admin", handler: ({ req, res, deps }) => handleInvite(req, res, deps) },

  // 업로드: member는 branch_id 또는 owner=본인 필수(핸들러 내부 규칙).
  { method: "POST", path: "/ingest", auth: "identity", handler: ({ req, res, deps, identity }) => handleIngest(req, res, deps, identity!) },

  // M9.6 개인 지식 레포 커넥터 — owner는 identity에서 강제(타인 레포 등록 불가).
  { method: "GET", path: "/my/repo", auth: "identity", handler: ({ res, deps, identity }) => handleMyRepoGet(res, deps, identity!) },
  { method: "PUT", path: "/my/repo", auth: "identity", handler: ({ req, res, deps, identity }) => handleMyRepoPut(req, res, deps, identity!) },
  { method: "POST", path: "/my/repo/sync", auth: "identity", handler: ({ res, deps, identity }) => handleMyRepoSync(res, deps, identity!) },
  { method: "GET", path: "/repos", auth: "admin", handler: ({ res, deps }) => handleReposList(res, deps) },
  // P4: 공용 지식 레포(owner 없이 shared 스코프 ingest) — 등록·강제 동기화는 admin 전용.
  { method: "PUT", path: "/repos/shared", auth: "admin", handler: ({ req, res, deps }) => handleSharedRepoPut(req, res, deps) },
  { method: "POST", path: "/repos/shared/sync", auth: "admin", handler: ({ res, deps }) => handleSharedRepoSync(res, deps) },

  // public: 읽기 전용 검색 — MCP cosmos_search가 core 응답 shape을 그대로 기대.
  // 핸들러가 옵션 토큰을 해석해 owner_scope를 서버 계산값으로 강제 덮어쓴다(M9 위장 차단).
  { method: "POST", path: "/search", auth: "public", handler: ({ req, res, deps }) => handleSearch(req, res, deps) },
  // public: 3D 코스모스 데이터 — 무인증=공통(shared)만, 토큰 있으면 핸들러가 본인 스코프 부여.
  { method: "GET", path: "/universe", auth: "public", handler: ({ req, res, deps }) => handleUniverse(req, res, deps) },
  // public: M10 문서 관계 그래프 — /universe와 동급(무인증=공통만, 스코프는 서버가 강제).
  { method: "GET", path: /^\/graph\/docs\/([^/]+)$/, auth: "public", handler: ({ req, res, deps, params }) => handleGraphDoc(req, res, deps, params[0]) },

  // public: 팀원 개인 지식 킷 설치기(짧은 주소) — 스크립트에 시크릿 없음, 토큰은 실행자가 입력.
  { method: "GET", path: "/kit", auth: "public", handler: ({ res }) => serveWebAsset(res, "kit/install.ps1") },

  // public: 정적 웹 자산.
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
      if (!identity) return; // 401 전송됨
      if (route.auth === "admin" && !requireAdmin(identity, res)) return; // 403 전송됨
    }

    await route.handler({ req, res, deps, url, identity, params });
    return;
  }

  sendJson(res, 404, { message: "찾을 수 없는 경로입니다." });
}

/**
 * GET /graph/docs/{doc_id}: 문서의 관계(in/out)를 core에서 조회해 그대로 반환한다.
 * 공개 경로 — 옵션 토큰을 해석해 owner_scope를 서버 계산값으로 강제한다(/search와 동일 원칙).
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

// ---- M9.6 개인 지식 레포 커넥터 핸들러 ----

/** ingest의 expectedOwner 규칙과 동일: admin은 고정 "admin" 네임스페이스, member는 본인 이름. */
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
    // 등록 직후 1회 즉시 동기화 — 연결이 실제로 되는지 그 자리에서 확인시킨다.
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

/** P4: 공용 레포 등록(admin) — owner 없이 shared 스코프로 pull되는 레포. 등록 직후 1회 동기화. */
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

/** P4: 공용 레포 전체 즉시 동기화(admin). */
async function handleSharedRepoSync(res: ServerResponse, deps: ServerDeps): Promise<void> {
  const entries = await loadRepos(deps.dataDir);
  const results = [];
  for (const entry of entries.filter((e) => e.shared)) {
    results.push(await syncOwnerRepo(entry.owner, { core: deps.core, dataDir: deps.dataDir, fetchImpl: deps.fetchImpl }));
  }
  sendJson(res, 200, results);
}

/**
 * POST /ingest: {docs:[...]} 를 core /ingest로 그대로 전달하고 응답을 그대로 반환한다.
 * M9: owner 지정 시 본인 개인 공간(admin은 고정 "admin", member는 본인 이름)과 다르면 403.
 * 팀원은 branch_id 또는 owner=본인 중 하나가 반드시 있어야 한다(둘 다 없으면 403).
 * owner+branch_id를 동시에 지정하는 경우는 여기서 막지 않고 core의 400 응답을 그대로 전달한다.
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
 * POST /search: {query, k?, cluster_ids?} 를 core /search로 그대로 전달하고 응답을 그대로 반환한다.
 * 공개 엔드포인트지만(토큰 없이도 접근 가능) Authorization 헤더가 있으면 identity를 해석해
 * 본인 스코프를 부여한다. 클라이언트가 body에 owner_scope를 지정해도 서버가 계산한 값으로
 * 무조건 덮어쓴다 — 타인 스코프로 위장한 검색을 막기 위함(CONTRACT.md "# M9 확장" mind 절).
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
    // M9: 공개 경로 — 무토큰=공통만, 토큰 있으면 본인 스코프(401 아님).
    // resolveIdentity가 개발 모드(COSMOS_TOKEN 미설정=전원 admin)까지 일관 처리한다.
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
 * kit/ 텍스트 자산의 배포처별 치환 — 소스는 {{PUBLIC_URL}}·{{TEMPLATE_REPO}} 플레이스홀더만
 * 담고, 서빙 시 그 조직의 env가 박혀 나간다(다른 회사가 띄우면 그들의 주소·템플릿이 나감).
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
 * mind/web/ 아래의 상대 경로를 읽어 응답한다. 경로 탈출 방어: path.resolve로 정규화한 뒤
 * WEB_ROOT 하위에 실제로 포함되는지 문자열 접두 검사로 확인한다(윈도우 경로 구분자 처리 포함이므로
 * "..%5C"(역슬래시 인코딩) 같은 윈도우 전용 탈출 시도도 이 검사 하나로 걸러진다).
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

/** SLACK_BOT_TOKEN으로 users.list를 호출해 활성·비봇 사용자 중 real_name/display_name에 q가 포함되는 것만 반환한다. */
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

/** GET /slack/users?q=<이름>: admin 전용 — SLACK_BOT_TOKEN 미설정 시 503. */
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

/** POST /invite {name, slack_user_id, role?="member"}: admin 전용 — invite.ts sendInvite 재사용. */
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

type AskMode = "fast" | "deep" | "global";

/** mode 바디 필드 + classifyIntent 게이트로 최종 파이프라인을 결정한다. CONTRACT.md "# M7 확장" 참고. */
function resolveAskMode(rawMode: string, question: string): AskMode {
  if (rawMode === "deep") return "deep";
  if (rawMode === "global") return "global";
  if (rawMode === "point" || rawMode === "fast") return "fast";
  // "auto" 또는 알 수 없는 값: 결정론적 인텐트 게이트로 분류.
  return classifyIntent(question) === "global" ? "global" : "fast";
}

/**
 * mode에 맞는 파이프라인(fast/deep/global)을 실행하고 봉투를 반환한다. onProgress는 SSE
 * 스트림(/ask/stream)에서만 주입되고, 미지정 시 각 파이프라인은 무동작(no-op)이라 /ask 동작은
 * 그대로다. CONTRACT.md "# M7.5 확장" 참고.
 */
async function runAskPipeline(
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

    try {
      const envelope = await runAskPipeline(question, mode, deps, undefined, ownerScopeFor(identity));
      sendJson(res, 200, envelope);
    } catch (err) {
      if (err instanceof Error && err.message === DEEP_BUSY_MESSAGE) {
        sendJson(res, 429, { message: DEEP_BUSY_MESSAGE });
        return;
      }
      throw err;
    }
  } catch (err) {
    // 진단 규격: 콘솔에도 스택+단계 컨텍스트를 남긴다(삼키기 금지). 단계명은 deep.ts가
    // [deep:<stage>] 프리픽스로 에러 메시지에 실어 보내므로 err.stack에 그대로 드러난다.
    console.error("[ask-error]", mode, err instanceof Error ? err.stack ?? err.message : err);
    sendJson(res, 500, { message: `/ask 처리 실패: ${errorMessage(err)}` });
  }
}

const SSE_KEEPALIVE_MS = 15000;

/**
 * POST /ask/stream: /ask와 동일한 바디·모드 판정을 쓰되 onProgress 마일스톤을 `status` SSE
 * 이벤트로 즉시 흘려보내고, 최종 결과를 `envelope`(정확히 1회) 또는 `error`로 종결한다.
 * CONTRACT.md "# M7.5 확장" 규격.
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

  // res(응답)의 close를 봐야 한다 — req(요청)의 close는 요청 바디를 다 읽으면 곧바로
  // 발생해 스트림이 시작되기도 전에 closed=true가 돼버린다(응답이 끝난 게 아닌데도).
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

    const onProgress = (stage: string, detail?: string): void => {
      writeEvent("status", detail === undefined ? { stage } : { stage, detail });
    };

    try {
      const envelope = await runAskPipeline(question, mode, deps, onProgress, ownerScopeFor(identity));
      writeEvent("envelope", envelope);
    } catch (err) {
      if (err instanceof Error && err.message === DEEP_BUSY_MESSAGE) {
        writeEvent("error", { message: DEEP_BUSY_MESSAGE });
      } else {
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
