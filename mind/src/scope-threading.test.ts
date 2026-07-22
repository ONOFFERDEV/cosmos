// M9 B2: 파이프라인·워처가 owner_scope를 core 호출까지 정확히 전달하는지 검증.
// fake core가 수신 파라미터를 기록하는 방식 — 실 core 불요. CONTRACT.md "# M9 확장" 참고.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runAsk } from "./ask.js";
import { runGlobalAsk } from "./global.js";
import { buildUniverse } from "./universe.js";
import { generateDigests } from "./digest.js";
import { scanOnce } from "./watcher.js";
import type {
  CoreClient,
  SearchRequest,
  SearchResponse,
  RouteResponse,
  IngestRequest,
  IngestResponse,
  Entity,
  ClusterDigest,
  ClusterSummary,
  DocSummary,
} from "./core-client.js";
import type { LlmClient } from "./llm.js";

/** 호출 기록용 fake core — 필요한 메서드만 구현, 나머지는 미사용 시 throw. */
function recordingCore() {
  const calls: Record<string, unknown[]> = {
    search: [], route: [], listEntities: [], listClusterDigests: [], listClusters: [], listDocs: [], ingest: [],
  };
  const core = {
    async search(req: SearchRequest): Promise<SearchResponse> {
      calls.search.push(req);
      return { results: [], stats: { num_bm25: 0, num_vec: 0, pool: 0, reranked: 0, secs: 0 } };
    },
    async route(query: string, ownerScope?: string): Promise<RouteResponse> {
      calls.route.push({ query, ownerScope });
      return { scores: [] };
    },
    async listEntities(kind?: string, ownerScope?: string): Promise<Entity[]> {
      calls.listEntities.push({ kind, ownerScope });
      return [];
    },
    async listClusterDigests(ownerScope?: string): Promise<ClusterDigest[]> {
      calls.listClusterDigests.push({ ownerScope });
      return [];
    },
    async listClusters(ownerScope?: string): Promise<ClusterSummary[]> {
      calls.listClusters.push({ ownerScope });
      return [];
    },
    async listDocs(ownerScope?: string): Promise<DocSummary[]> {
      calls.listDocs.push({ ownerScope });
      return [];
    },
    async getCentroids() {
      return [] as Array<{ id: string; centroid: string }>;
    },
    async ingest(req: IngestRequest): Promise<IngestResponse> {
      calls.ingest.push(req);
      return { ingested: req.docs.map((d, i) => ({ doc_id: `d${i}`, origin: d.origin, chunks: 1, duplicate: false, replaced: false, cluster_slug: null, fit: null })) };
    },
  } as unknown as CoreClient;
  return { core, calls };
}

const stubLlm: LlmClient = {
  model: "stub",
  async complete() {
    return JSON.stringify({ sentences: [], insufficient: true });
  },
} as unknown as LlmClient;

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cosmos-scope-"));
}

test("runAsk는 ownerScope를 route와 search에 전달한다", async () => {
  const { core, calls } = recordingCore();
  await runAsk("질문", { core, llm: stubLlm, dataDir: await tempDir(), ownerScope: "shared+alice" });
  assert.equal((calls.route[0] as { ownerScope?: string }).ownerScope, "shared+alice");
  assert.equal((calls.search[0] as SearchRequest).owner_scope, "shared+alice");
});

test("runGlobalAsk는 ownerScope를 entities/digests/search에 전달한다", async () => {
  const { core, calls } = recordingCore();
  await runGlobalAsk("전체 현황", { core, llm: stubLlm, dataDir: await tempDir(), ownerScope: "shared+admin" });
  assert.equal((calls.listEntities[0] as { ownerScope?: string }).ownerScope, "shared+admin");
  assert.equal((calls.listClusterDigests[0] as { ownerScope?: string }).ownerScope, "shared+admin");
  assert.equal((calls.search[0] as SearchRequest).owner_scope, "shared+admin");
});

test("buildUniverse는 ownerScope를 listClusters/listDocs에 전달한다", async () => {
  const { core, calls } = recordingCore();
  await buildUniverse({ core, dataDir: await tempDir(), ownerScope: "shared+bob" });
  assert.equal((calls.listClusters[0] as { ownerScope?: string }).ownerScope, "shared+bob");
  assert.equal((calls.listDocs[0] as { ownerScope?: string }).ownerScope, "shared+bob");
});

test("generateDigests는 기본 2스코프(shared, shared+admin)를 순회한다", async () => {
  const { core, calls } = recordingCore();
  await generateDigests({ core, llm: stubLlm, dataDir: await tempDir() });
  const scopes = calls.listClusters.map((c) => (c as { ownerScope?: string }).ownerScope);
  assert.deepEqual(scopes, ["shared", "shared+admin"]);
});

test("scanOnce는 session 배치(owner=admin)와 repo 배치를 분리 전송한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-scan-"));
  const sessionDir = path.join(dir, "mem");
  const repoDir = path.join(dir, "repo", "docs");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(sessionDir, "a.md"), "세션 문서", "utf8");
  await writeFile(path.join(repoDir, "plan.md"), "레포 문서", "utf8");

  const { core, calls } = recordingCore();
  const summary = await scanOnce(
    {
      dirs: [],
      interval_secs: 60,
      sources: [
        { path: sessionDir, source_type: "session" },
        { path: path.join(dir, "repo"), source_type: "repo", docs_only: true },
      ],
    },
    { core }
  );
  assert.equal(summary.scanned, 2);
  assert.equal(calls.ingest.length, 2);
  const owners = calls.ingest.map((r) => (r as IngestRequest & { owner?: string }).owner);
  assert.deepEqual(owners.sort((a, b) => String(a).localeCompare(String(b))), ["admin", undefined]);
  const sessionBatch = calls.ingest.find((r) => (r as { owner?: string }).owner === "admin") as IngestRequest;
  assert.equal(sessionBatch.docs[0].source_type, "session");
});

test("scanOnce는 session 문서가 없으면 repo 배치 1콜만 보낸다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-scan2-"));
  const repoDir = path.join(dir, "repo", "docs");
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, "plan.md"), "레포 문서", "utf8");

  const { core, calls } = recordingCore();
  await scanOnce(
    { dirs: [], interval_secs: 60, sources: [{ path: path.join(dir, "repo"), source_type: "repo", docs_only: true }] },
    { core }
  );
  assert.equal(calls.ingest.length, 1);
  assert.equal((calls.ingest[0] as { owner?: string }).owner, undefined);
});

test("runAsk는 검색 히트가 있으면 graphNeighbors에 ownerScope를 전달하고 이웃을 인용 후보로 합류시킨다", async () => {
  const calls: { docIds?: string[]; ownerScope?: string } = {};
  const core = {
    async route() {
      return { scores: [] };
    },
    async search(): Promise<SearchResponse> {
      return {
        results: [
          {
            chunk_id: "c1", doc_id: "d1", origin: "origin://hit.md", title: "히트",
            text: "히트 본문", char_start: 0, char_end: 5, section: null, score: 1,
            stages: { bm25_rank: 1, vec_rank: 1, rrf_score: 1, rerank_score: 1 },
          },
        ],
        stats: { num_bm25: 1, num_vec: 1, pool: 1, reranked: 1, secs: 0 },
      };
    },
    async graphNeighbors(docIds: string[], ownerScope?: string) {
      calls.docIds = docIds;
      calls.ownerScope = ownerScope;
      return [{ doc_id: "d2", origin: "origin://neighbor.md", title: "이웃", snippet: "이웃 스니펫" }];
    },
  } as unknown as CoreClient;

  // sources는 "인용된 청크만" 담는 결정적 조립이므로, 이웃([2])을 실제로 인용하는 LLM 스텁을 쓴다.
  const citingLlm: LlmClient = {
    model: "stub",
    async complete() {
      return JSON.stringify({ sentences: [{ text: "이웃 근거 문장", cites: [2] }], insufficient: false });
    },
  } as unknown as LlmClient;

  const envelope = await runAsk("질문", { core, llm: citingLlm, dataDir: await tempDir(), ownerScope: "shared+admin" });
  assert.deepEqual(calls.docIds, ["d1"]);
  assert.equal(calls.ownerScope, "shared+admin");
  assert.ok(envelope.sources.some((s) => s.origin === "origin://neighbor.md"), "인용된 이웃이 sources에 등장");
  assert.ok(envelope.trace.some((t) => t.cluster === "graph"), "trace에 graph 확장 기록");
});
