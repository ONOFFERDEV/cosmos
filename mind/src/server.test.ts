// mind HTTP 서버 라우팅 테스트. GET /universe, GET /, GET /web/* 정적 서빙(경로 탈출 방어 포함).
// mind/web/은 디자이너 레인이 이미 채워둔 실제 산출물 디렉토리 — 이 테스트는 그 파일들을 읽기만 하고
// 절대 쓰거나 만들지 않는다(서버가 실제로 서빙하는 대상 그대로를 검증한다).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import type {
  CoreClient,
  ClusterSummary,
  ClusterCentroid,
  DocSummary,
  RouteResponse,
  SearchRequest,
  SearchResponse,
  IngestRequest,
  IngestResponse,
} from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { createMindServer, type ServerDeps } from "./server.js";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MIND_ROOT = path.resolve(WEB_ROOT, "..");

class MockCoreClient {
  // M5: /ingest 프록시 테스트가 core로 전달된 요청을 검증할 수 있도록 호출을 기록한다.
  ingestCalls: IngestRequest[] = [];
  async listClusters(): Promise<ClusterSummary[]> {
    return [];
  }
  async getCentroids(): Promise<ClusterCentroid[]> {
    return [];
  }
  async listDocs(): Promise<DocSummary[]> {
    return [];
  }
  // route/search를 빈 결과로 두면 runAsk가 LLM 호출 없이 insufficient=true로 단락되므로
  // 인증 테스트에서 MockLlmClient.complete()의 throw를 건드리지 않고 200을 받을 수 있다.
  async route(): Promise<RouteResponse> {
    return { scores: [] };
  }
  // M5: /search 프록시 테스트가 core로 전달된 요청을 검증할 수 있도록 호출을 기록한다.
  searchCalls: SearchRequest[] = [];
  async search(req: SearchRequest): Promise<SearchResponse> {
    this.searchCalls.push(req);
    return { results: [], stats: { num_bm25: 0, num_vec: 0, pool: 0, reranked: 0, secs: 0 } };
  }
  async ingest(req: IngestRequest): Promise<IngestResponse> {
    this.ingestCalls.push(req);
    return {
      ingested: req.docs.map((d, i) => ({
        doc_id: `doc-${i}`,
        origin: d.origin,
        chunks: 1,
        duplicate: false,
        replaced: false,
      })),
    };
  }
}

class MockLlmClient {
  readonly model = "mock";
  async complete(): Promise<string> {
    throw new Error("이 테스트에서는 LLM 호출이 필요하지 않습니다.");
  }
}

// M5: 인증/ingest 테스트가 커스텀 core mock이나 격리된 dataDir을 주입할 수 있도록 overrides를
// 받는다. 인자 없이 호출하면 기존 테스트들과 동일하게 기본 MockCoreClient/MockLlmClient로 동작한다.
async function startServer(overrides?: Partial<ServerDeps>): Promise<{ base: string; close: () => Promise<void> }> {
  const deps: ServerDeps = {
    core: new MockCoreClient() as unknown as CoreClient,
    llm: new MockLlmClient() as unknown as LlmClient,
    ...overrides,
  };
  const server = createMindServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test("GET /universe는 core 데이터로 조립한 코스모스 페이로드를 200으로 반환한다", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/universe`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body["clusters"]));
    assert.ok(Array.isArray(body["docs"]));
    assert.ok(Array.isArray(body["edges"]));
    assert.ok(Array.isArray(body["recent_queries"]));
    assert.equal(typeof body["generated_at"], "string");
  } finally {
    await close();
  }
});

test("GET /는 mind/web/index.html을 그대로 서빙한다", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const body = await res.text();
    const expected = await readFile(path.join(WEB_ROOT, "index.html"), "utf8");
    assert.equal(body, expected);
  } finally {
    await close();
  }
});

test("GET /web/<file>은 실제 확장자별 Content-Type으로 파일을 그대로 서빙한다", async () => {
  const { base, close } = await startServer();
  try {
    const htmlRes = await fetch(`${base}/web/index.html`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get("content-type"), "text/html; charset=utf-8");

    const cssRes = await fetch(`${base}/web/style.css`);
    assert.equal(cssRes.status, 200);
    assert.equal(cssRes.headers.get("content-type"), "text/css; charset=utf-8");
    const cssBody = await cssRes.text();
    const expectedCss = await readFile(path.join(WEB_ROOT, "style.css"), "utf8");
    assert.equal(cssBody, expectedCss);

    const jsRes = await fetch(`${base}/web/app.js`);
    assert.equal(jsRes.status, 200);
    assert.equal(jsRes.headers.get("content-type"), "text/javascript; charset=utf-8");

    const jsonRes = await fetch(`${base}/web/dev-fixture.json`);
    assert.equal(jsonRes.status, 200);
    assert.equal(jsonRes.headers.get("content-type"), "application/json; charset=utf-8");
  } finally {
    await close();
  }
});

test("GET /web/<존재하지 않는 파일>은 503 웹 자산 미배치로 응답한다", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/web/does-not-exist-xyz.txt`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["message"], "웹 자산 미배치");
  } finally {
    await close();
  }
});

test("GET /web/..%5C<실제 존재 파일>은 윈도우 역슬래시 인코딩 경로 탈출을 403으로 차단한다", async () => {
  const { base, close } = await startServer();
  try {
    // mind/package.json은 web/의 부모(mind/)에 실제로 존재하는 파일 — 우연한 404가 아니라
    // "존재하지만 차단됨"을 증명하기 위해 실존 파일을 목표로 삼는다.
    await assert.doesNotReject(readFile(path.join(MIND_ROOT, "package.json"), "utf8"));

    const res = await fetch(`${base}/web/..%5Cpackage.json`);
    // 응답 상태와 바디 둘 다로 판정한다(캐치올이 200으로 위장할 수 있다는 교훈 반영).
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["message"], "허용되지 않는 경로입니다.");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  } finally {
    await close();
  }
});

test("GET /web/..%5C..%5Csrc%5Cserver.ts 같은 깊은 역슬래시 체인도 403으로 차단한다", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/web/..%5C..%5Csrc%5Cserver.ts`);
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["message"], "허용되지 않는 경로입니다.");
  } finally {
    await close();
  }
});

test("GET /web/..%2Fpackage.json (인코딩된 슬래시)도 403으로 차단한다", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/web/..%2Fpackage.json`);
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["message"], "허용되지 않는 경로입니다.");
  } finally {
    await close();
  }
});

test("GET /web/../package.json (리터럴 상대경로)는 URL 파서가 정규화해 /web/* 라우트 자체에 도달하지 않고 404가 된다", async () => {
  const { base, close } = await startServer();
  try {
    // 참고: WHATWG URL 파서가 리터럴 '../'를 파싱 단계에서 이미 접어 pathname이 '/package.json'이
    // 되므로(new URL 검증 완료) /web/* 핸들러의 경로 탈출 방어 코드에는 도달하지 않는다. 이 요청은
    // 서버에 정의되지 않은 경로가 되어 404를 받는다 — 방어 로직 자체의 검증은 위 %5C/%2F 테스트가 담당한다.
    const res = await fetch(`${base}/web/../package.json`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("정의되지 않은 경로는 여전히 404를 반환한다(캐치올로 위장되지 않음)", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/nonexistent-route-xyz`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["message"], "찾을 수 없는 경로입니다.");
  } finally {
    await close();
  }
});

// M5: 토큰 인증 + /ingest 프록시. -------------------------------------------------------

test("COSMOS_TOKEN 미설정 시 POST /ask, POST /ingest 모두 인증 없이 통과한다", async () => {
  const savedToken = process.env.COSMOS_TOKEN;
  delete process.env.COSMOS_TOKEN;
  const core = new MockCoreClient();
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-server-test-"));
  const { base, close } = await startServer({ core: core as unknown as CoreClient, dataDir });
  try {
    const askRes = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "토큰 없이 질문", mode: "fast" }),
    });
    assert.equal(askRes.status, 200);

    const ingestRes = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docs: [{ origin: "test://a", source_type: "manual", text: "본문" }] }),
    });
    assert.equal(ingestRes.status, 200);
    assert.equal(core.ingestCalls.length, 1);
  } finally {
    await close();
    await rm(dataDir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.COSMOS_TOKEN;
    else process.env.COSMOS_TOKEN = savedToken;
  }
});

test("COSMOS_TOKEN 설정 시 POST /ask는 헤더 누락·오답 시 401, 정답 Bearer 헤더는 200을 반환한다", async () => {
  const savedToken = process.env.COSMOS_TOKEN;
  process.env.COSMOS_TOKEN = "secret-m5-token";
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-server-test-"));
  const { base, close } = await startServer({ dataDir });
  try {
    const noAuthRes = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "인증 없이", mode: "fast" }),
    });
    assert.equal(noAuthRes.status, 401);
    const noAuthBody = (await noAuthRes.json()) as Record<string, unknown>;
    assert.equal(noAuthBody["message"], "인증 토큰이 필요합니다");

    const okRes = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-m5-token" },
      body: JSON.stringify({ question: "인증 포함", mode: "fast" }),
    });
    assert.equal(okRes.status, 200);

    const wrongAuthRes = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({ question: "잘못된 토큰", mode: "fast" }),
    });
    assert.equal(wrongAuthRes.status, 401);
  } finally {
    await close();
    await rm(dataDir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.COSMOS_TOKEN;
    else process.env.COSMOS_TOKEN = savedToken;
  }
});

test("POST /ingest는 토큰 인증 통과 시 요청 본문을 core.ingest에 그대로 전달하고 응답을 그대로 반환한다", async () => {
  const savedToken = process.env.COSMOS_TOKEN;
  process.env.COSMOS_TOKEN = "secret-m5-token";
  const core = new MockCoreClient();
  const { base, close } = await startServer({ core: core as unknown as CoreClient });
  try {
    const noAuthRes = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docs: [{ origin: "test://blocked", source_type: "manual", text: "차단돼야 함" }] }),
    });
    assert.equal(noAuthRes.status, 401);
    assert.equal(core.ingestCalls.length, 0);

    const reqBody = { docs: [{ origin: "test://ok", source_type: "manual", text: "허용돼야 함" }] };
    const okRes = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-m5-token" },
      body: JSON.stringify(reqBody),
    });
    assert.equal(okRes.status, 200);
    const okBody = (await okRes.json()) as Record<string, unknown>;
    assert.equal(core.ingestCalls.length, 1);
    assert.deepEqual(core.ingestCalls[0], reqBody);
    assert.ok(Array.isArray(okBody["ingested"]));
    assert.equal((okBody["ingested"] as unknown[]).length, 1);
  } finally {
    await close();
    if (savedToken === undefined) delete process.env.COSMOS_TOKEN;
    else process.env.COSMOS_TOKEN = savedToken;
  }
});

test("POST /search는 COSMOS_TOKEN 설정 상태에서도 인증 없이 통과하고, 요청 본문을 core.search로 그대로 전달하며 응답을 그대로 반환한다", async () => {
  const savedToken = process.env.COSMOS_TOKEN;
  process.env.COSMOS_TOKEN = "secret-m5-token";
  const core = new MockCoreClient();
  const { base, close } = await startServer({ core: core as unknown as CoreClient });
  try {
    const reqBody = { query: "형태소 클러스터링", k: 5 };
    const res = await fetch(`${base}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    assert.equal(res.status, 200);
    assert.equal(core.searchCalls.length, 1);
    // M9: 토큰 없음 -> null identity -> owner_scope="shared"를 서버가 덧붙여 core로 전달한다
    // (CONTRACT.md "# M9 확장" mind 절 — owner-scope.test.ts에서 별도로 자세히 검증).
    assert.deepEqual(core.searchCalls[0], { ...reqBody, owner_scope: "shared" });
    const body = (await res.json()) as SearchResponse;
    assert.deepEqual(body, { results: [], stats: { num_bm25: 0, num_vec: 0, pool: 0, reranked: 0, secs: 0 } });
  } finally {
    await close();
    if (savedToken === undefined) delete process.env.COSMOS_TOKEN;
    else process.env.COSMOS_TOKEN = savedToken;
  }
});
