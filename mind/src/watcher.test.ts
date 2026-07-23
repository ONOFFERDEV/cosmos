import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CoreClient, IngestRequest, IngestResponse } from "./core-client.js";
import { isWatchedFile, listMarkdownFiles, scanOnce } from "./watcher.js";

test("isWatchedFile은 제외 파일명을 걸러내고 .md만 허용한다", () => {
  assert.equal(isWatchedFile("notes.md"), true);
  assert.equal(isWatchedFile("MEMORY.md"), false);
  assert.equal(isWatchedFile("dashboard.md"), false);
  assert.equal(isWatchedFile("index.md"), false);
  assert.equal(isWatchedFile("log.md"), false);
  assert.equal(isWatchedFile("notes.txt"), false);
});

class MockCoreClient {
  ingestCalls: IngestRequest[] = [];
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

async function makeTempTree(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-watcher-test-"));
  await writeFile(path.join(dir, "note1.md"), "첫 번째 노트", "utf8");
  await writeFile(path.join(dir, "MEMORY.md"), "제외되어야 함", "utf8");
  await writeFile(path.join(dir, "dashboard.md"), "제외되어야 함", "utf8");
  await writeFile(path.join(dir, "readme.txt"), "md 아님", "utf8");

  const sub = path.join(dir, "sub");
  await mkdir(sub, { recursive: true });
  await writeFile(path.join(sub, "note2.md"), "하위 디렉토리 노트", "utf8");

  const templatesDir = path.join(dir, "_templates");
  await mkdir(templatesDir, { recursive: true });
  await writeFile(path.join(templatesDir, "should-skip.md"), "스킵되어야 함", "utf8");

  return dir;
}

test("listMarkdownFiles는 재귀적으로 .md를 찾고 _templates 디렉토리는 건너뛴다", async () => {
  const dir = await makeTempTree();
  const files = await listMarkdownFiles(dir);
  const basenames = files.map((f) => path.basename(f)).sort();

  assert.deepEqual(basenames, ["note1.md", "note2.md"]);
  assert.equal(
    files.some((f) => f.includes("_templates")),
    false
  );

  await rm(dir, { recursive: true, force: true });
});

test("scanOnce는 매칭된 파일을 core.ingest에 벌크로 1회 전송하고 결과를 집계한다", async () => {
  const dir = await makeTempTree();
  const core = new MockCoreClient();

  const summary = await scanOnce({ dirs: [dir], interval_secs: 60 }, { core: core as unknown as CoreClient });

  assert.equal(summary.scanned, 2);
  assert.equal(core.ingestCalls.length, 1);
  assert.equal(core.ingestCalls[0].docs.length, 2);
  assert.equal(summary.ingested, 2);
  assert.equal(summary.duplicate, 0);
  assert.equal(summary.failed.length, 0);
  for (const doc of core.ingestCalls[0].docs) {
    assert.equal(doc.source_type, "session");
  }

  await rm(dir, { recursive: true, force: true });
});

test("scanOnce는 매칭된 파일이 없으면 core.ingest를 호출하지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-watcher-empty-"));
  const core = new MockCoreClient();

  const summary = await scanOnce({ dirs: [dir], interval_secs: 60 }, { core: core as unknown as CoreClient });

  assert.equal(summary.scanned, 0);
  assert.equal(core.ingestCalls.length, 0);

  await rm(dir, { recursive: true, force: true });
});

// M5: when COSMOS_MIND_URL is set, don't call core directly -- send through mind's own /ingest proxy instead.
test("scanOnce는 COSMOS_MIND_URL 설정 시 core.ingest 대신 mind의 /ingest로 POST한다", async () => {
  const savedMindUrl = process.env.COSMOS_MIND_URL;
  const savedToken = process.env.COSMOS_TOKEN;
  process.env.COSMOS_MIND_URL = "http://127.0.0.1:9999";
  process.env.COSMOS_TOKEN = "secret-remote-token";

  const dir = await makeTempTree();
  const core = new MockCoreClient();
  const fetchCalls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string } });
    return {
      ok: true,
      json: async () => ({
        ingested: [
          { doc_id: "remote-0", origin: "a", chunks: 1, duplicate: false, replaced: false },
          { doc_id: "remote-1", origin: "b", chunks: 1, duplicate: false, replaced: false },
        ],
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const summary = await scanOnce(
      { dirs: [dir], interval_secs: 60 },
      { core: core as unknown as CoreClient, fetchImpl }
    );

    assert.equal(core.ingestCalls.length, 0);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "http://127.0.0.1:9999/ingest");
    assert.equal(fetchCalls[0].init.method, "POST");
    const headers = fetchCalls[0].init.headers ?? {};
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Authorization"], "Bearer secret-remote-token");
    const sentBody = JSON.parse(fetchCalls[0].init.body ?? "{}") as IngestRequest;
    assert.equal(sentBody.docs.length, 2);
    assert.equal(summary.scanned, 2);
    assert.equal(summary.ingested, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (savedMindUrl === undefined) delete process.env.COSMOS_MIND_URL;
    else process.env.COSMOS_MIND_URL = savedMindUrl;
    if (savedToken === undefined) delete process.env.COSMOS_TOKEN;
    else process.env.COSMOS_TOKEN = savedToken;
  }
});

// M6a: config.sources extension tests.

test("scanOnce는 config.sources가 없으면 기존 dirs를 session 소스로 폴백한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-watcher-fallback-"));
  await writeFile(path.join(dir, "note.md"), "폴백 노트", "utf8");
  const core = new MockCoreClient();

  const summary = await scanOnce({ dirs: [dir], interval_secs: 60 }, { core: core as unknown as CoreClient });

  assert.equal(summary.scanned, 1);
  assert.equal(core.ingestCalls.length, 1);
  assert.equal(core.ingestCalls[0].docs[0].source_type, "session");

  await rm(dir, { recursive: true, force: true });
});

test("scanOnce는 docs_only 소스에서 루트 PLAN/README와 docs/ 하위만 수집하고 RESULTS.md·node_modules는 제외한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-watcher-docsonly-"));
  await writeFile(path.join(dir, "PLAN.md"), "플랜", "utf8");
  await writeFile(path.join(dir, "README.md"), "리드미", "utf8");
  await writeFile(path.join(dir, "RESULTS.md"), "결과(제외)", "utf8");
  await writeFile(path.join(dir, "notes.md"), "루트 기타(제외)", "utf8");

  const docsDir = path.join(dir, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "guide.md"), "가이드", "utf8");

  const nodeModulesDir = path.join(dir, "node_modules");
  await mkdir(nodeModulesDir, { recursive: true });
  await writeFile(path.join(nodeModulesDir, "ignored.md"), "제외", "utf8");

  const core = new MockCoreClient();
  const summary = await scanOnce(
    { dirs: [], interval_secs: 60, sources: [{ path: dir, source_type: "repo", docs_only: true }] },
    { core: core as unknown as CoreClient }
  );

  const origins = core.ingestCalls[0].docs.map((d) => path.basename(d.origin)).sort();
  assert.deepEqual(origins, ["PLAN.md", "README.md", "guide.md"]);
  assert.equal(summary.scanned, 3);
  for (const doc of core.ingestCalls[0].docs) {
    assert.equal(doc.source_type, "repo");
  }

  await rm(dir, { recursive: true, force: true });
});

test("scanOnce는 include_meta=true 소스에서 dashboard.md/MEMORY.md도 포함한다", async () => {
  const dir = await makeTempTree();
  const core = new MockCoreClient();

  const summary = await scanOnce(
    { dirs: [], interval_secs: 60, sources: [{ path: dir, source_type: "session", include_meta: true }] },
    { core: core as unknown as CoreClient }
  );

  const origins = core.ingestCalls[0].docs.map((d) => path.basename(d.origin)).sort();
  assert.deepEqual(origins, ["MEMORY.md", "dashboard.md", "note1.md", "note2.md"]);
  assert.equal(summary.scanned, 4);

  await rm(dir, { recursive: true, force: true });
});

test("scanOnce는 부재 경로 소스를 에러 없이 스킵한다", async () => {
  const core = new MockCoreClient();
  const missingPath = path.join(tmpdir(), "cosmos-watcher-missing-does-not-exist");

  const summary = await scanOnce(
    { dirs: [], interval_secs: 60, sources: [{ path: missingPath, source_type: "session" }] },
    { core: core as unknown as CoreClient }
  );

  assert.equal(summary.scanned, 0);
  assert.equal(core.ingestCalls.length, 0);
});
