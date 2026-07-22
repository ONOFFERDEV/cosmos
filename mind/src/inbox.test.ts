import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CoreClient, IngestRequest, IngestResponse } from "./core-client.js";
import type { PendingCandidate } from "./collect.js";
import { approveOne, rejectOne, approveMany, listPending, renderPendingTable } from "./inbox.js";

class MockCoreClient {
  ingestCalls: IngestRequest[] = [];
  private response: IngestResponse;
  private shouldFail: boolean;

  constructor(response?: IngestResponse, shouldFail = false) {
    this.response =
      response ?? {
        ingested: [
          { doc_id: "doc1", origin: "x", chunks: 1, duplicate: false, replaced: false, cluster_slug: "cluster-a", fit: 0.9 },
        ],
      };
    this.shouldFail = shouldFail;
  }

  async ingest(req: IngestRequest): Promise<IngestResponse> {
    this.ingestCalls.push(req);
    if (this.shouldFail) {
      throw new Error("ingest 실패(mock)");
    }
    return this.response;
  }
}

async function makeTempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-inbox-test-"));
  await mkdir(path.join(dir, "inbox", "pending"), { recursive: true });
  return dir;
}

function makeCandidate(id: string, overrides: Partial<PendingCandidate> = {}): PendingCandidate {
  return {
    id,
    source_type: "arxiv",
    origin: `https://arxiv.org/abs/${id}`,
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    score: 5,
    matched: ["llm"],
    fetched_at: new Date().toISOString(),
    text: `Full text ${id}`,
    status: "pending",
    ...overrides,
  };
}

test("pending 생성 시점에는 core.ingest가 0회 호출된다", async () => {
  const dataDir = await makeTempDataDir();
  const candidate = makeCandidate("abc123");
  await writeFile(path.join(dataDir, "inbox", "pending", "abc123.json"), JSON.stringify(candidate), "utf8");

  const core = new MockCoreClient();
  const pending = await listPending(dataDir);

  assert.equal(pending.length, 1);
  assert.equal(core.ingestCalls.length, 0);

  await rm(dataDir, { recursive: true, force: true });
});

test("approveOne은 core.ingest를 정확히 1회 호출하고 approved/로 이동시키며 cluster_slug/fit을 기록한다", async () => {
  const dataDir = await makeTempDataDir();
  const candidate = makeCandidate("def456");
  await writeFile(path.join(dataDir, "inbox", "pending", "def456.json"), JSON.stringify(candidate), "utf8");

  const core = new MockCoreClient({
    ingested: [
      { doc_id: "doc-x", origin: candidate.origin, chunks: 3, duplicate: false, replaced: false, cluster_slug: "cluster-agents", fit: 0.87 },
    ],
  });

  const result = await approveOne("def456", { core: core as unknown as CoreClient, dataDir });

  assert.equal(result.ok, true);
  assert.equal(core.ingestCalls.length, 1);
  assert.equal(core.ingestCalls[0].docs[0].origin, candidate.origin);
  assert.equal(core.ingestCalls[0].docs[0].source_type, "arxiv");

  const pendingFiles = await readdir(path.join(dataDir, "inbox", "pending"));
  assert.equal(pendingFiles.includes("def456.json"), false);

  const approvedRaw = await readFile(path.join(dataDir, "inbox", "approved", "def456.json"), "utf8");
  const approved = JSON.parse(approvedRaw);
  assert.equal(approved.status, "approved");
  assert.equal(approved.decision, "approved");
  assert.equal(approved.cluster_slug, "cluster-agents");
  assert.equal(approved.fit, 0.87);
  assert.ok(approved.decided_at);

  await rm(dataDir, { recursive: true, force: true });
});

test("rejectOne은 core.ingest를 호출하지 않고 rejected/로 이동시킨다", async () => {
  const dataDir = await makeTempDataDir();
  const candidate = makeCandidate("ghi789");
  await writeFile(path.join(dataDir, "inbox", "pending", "ghi789.json"), JSON.stringify(candidate), "utf8");

  const core = new MockCoreClient();
  const result = await rejectOne("ghi789", { dataDir });

  assert.equal(result.ok, true);
  assert.equal(core.ingestCalls.length, 0);

  const pendingFiles = await readdir(path.join(dataDir, "inbox", "pending"));
  assert.equal(pendingFiles.includes("ghi789.json"), false);

  const rejectedRaw = await readFile(path.join(dataDir, "inbox", "rejected", "ghi789.json"), "utf8");
  const rejected = JSON.parse(rejectedRaw);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.decision, "rejected");

  await rm(dataDir, { recursive: true, force: true });
});

test("approveMany은 존재하지 않는 id를 격리하고 유효한 id만 ingest를 호출한다", async () => {
  const dataDir = await makeTempDataDir();
  const candidate = makeCandidate("jkl012");
  await writeFile(path.join(dataDir, "inbox", "pending", "jkl012.json"), JSON.stringify(candidate), "utf8");

  const core = new MockCoreClient();
  const results = await approveMany(["jkl012", "nonexistent999"], { core: core as unknown as CoreClient, dataDir });

  assert.equal(results.length, 2);
  const okResult = results.find((r) => r.id === "jkl012");
  const failResult = results.find((r) => r.id === "nonexistent999");
  assert.equal(okResult?.ok, true);
  assert.equal(failResult?.ok, false);
  assert.equal(core.ingestCalls.length, 1);

  await rm(dataDir, { recursive: true, force: true });
});

test("approveOne은 ingest가 실패하면 pending 파일을 그대로 남겨둔다(부분 실패 격리)", async () => {
  const dataDir = await makeTempDataDir();
  const candidate = makeCandidate("mno345");
  await writeFile(path.join(dataDir, "inbox", "pending", "mno345.json"), JSON.stringify(candidate), "utf8");

  const core = new MockCoreClient(undefined, true);
  const result = await approveOne("mno345", { core: core as unknown as CoreClient, dataDir });

  assert.equal(result.ok, false);
  assert.equal(core.ingestCalls.length, 1);

  const pendingFiles = await readdir(path.join(dataDir, "inbox", "pending"));
  assert.equal(pendingFiles.includes("mno345.json"), true);

  await rm(dataDir, { recursive: true, force: true });
});

test("renderPendingTable은 빈 배열에 안내 문구를 반환한다", () => {
  assert.equal(renderPendingTable([]), "대기 중인 후보가 없습니다.");
});
