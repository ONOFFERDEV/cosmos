// mind HTTP server routing tests. GET /universe, GET /, GET /web/* static serving (including path traversal defense).
// mind/web/ is the real build output directory already populated by the designer lane — this test only reads
// those files and never writes or creates them (verifies exactly what the server actually serves).

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
  // M5: records calls so the /ingest proxy tests can verify the request passed through to core.
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
  // Leaving route/search empty short-circuits runAsk to insufficient=true without any LLM call,
  // so auth tests can get a 200 without ever triggering MockLlmClient.complete()'s throw.
  async route(): Promise<RouteResponse> {
    return { scores: [] };
  }
  // M5: records calls so the /search proxy tests can verify the request passed through to core.
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

// M5: accepts overrides so auth/ingest tests can inject a custom core mock or an isolated dataDir.
// Called with no arguments, it behaves like the existing tests with the default MockCoreClient/MockLlmClient.
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
    // mind/package.json is a file that actually exists in web/'s parent (mind/) — targeting a real
    // file that exists, so the test proves "exists but blocked" rather than an accidental 404.
    await assert.doesNotReject(readFile(path.join(MIND_ROOT, "package.json"), "utf8"));

    const res = await fetch(`${base}/web/..%5Cpackage.json`);
    // Judges by both the response status and body (reflects the lesson that a catch-all can masquerade as 200).
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
    // Note: the WHATWG URL parser already collapses the literal '../' during parsing, so pathname
    // becomes '/package.json' (validated by new URL) — the /web/* handler's path-traversal defense
    // code is never reached. This request hits a path undefined on the server and gets a 404 — the
    // defense logic itself is verified by the %5C/%2F tests above.
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

// M5: token auth + /ingest proxy. -------------------------------------------------------

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
    // M9: no token -> null identity -> the server appends owner_scope="shared" before forwarding to core
    // (CONTRACT.md "# M9 확장" mind section — verified in detail separately in owner-scope.test.ts).
    assert.deepEqual(core.searchCalls[0], { ...reqBody, owner_scope: "shared" });
    const body = (await res.json()) as SearchResponse;
    assert.deepEqual(body, { results: [], stats: { num_bm25: 0, num_vec: 0, pool: 0, reranked: 0, secs: 0 } });
  } finally {
    await close();
    if (savedToken === undefined) delete process.env.COSMOS_TOKEN;
    else process.env.COSMOS_TOKEN = savedToken;
  }
});
