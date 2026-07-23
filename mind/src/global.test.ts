// runGlobalAsk unit tests. Verifies that the registry (entities) + cluster digests + search()
// merge into a single envelope, and that digest citations carry a digest://<slug> origin.
// See CONTRACT.md "# M7 확장" section.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { CoreClient, Entity, ClusterDigest, SearchResponse } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import type { AskDeps } from "./ask.js";
import { runGlobalAsk } from "./global.js";

const ENTITIES: Entity[] = [
  { doc_id: "d1", name: "Psyfi", kind: "project", origin: "notion://psyfi", status: "출시 준비" },
  { doc_id: "d2", name: "Traxel", kind: "project", origin: "notion://traxel", status: "운영 중" },
  { doc_id: "d3", name: "Snipe Hub", kind: "project", origin: "notion://snipe-hub", status: "프로토타입" },
];

const DIGESTS: ClusterDigest[] = [
  {
    cluster_id: "c1",
    slug: "llm-agent-pipeline",
    name: "LLM 에이전트 파이프라인",
    text: "이 클러스터는 mind의 ask/global 파이프라인과 관련된 문서를 모은다.",
    updated_at: "2026-07-01T00:00:00Z",
  },
  {
    cluster_id: "c2",
    slug: "infra-cloudflare",
    name: "인프라/클라우드플레어",
    text: "이 클러스터는 Cloudflare 배포 관련 문서를 모은다.",
    updated_at: "2026-07-02T00:00:00Z",
  },
];

const SEARCH_RESPONSE: SearchResponse = {
  results: [
    {
      chunk_id: "sc1",
      doc_id: "d4",
      origin: "repo://readme.md",
      title: "README",
      text: "부가 검색 근거 1",
      char_start: 0,
      char_end: 20,
      score: 0.7,
      stages: { bm25_rank: 1, vec_rank: 1, rrf_score: 0.5, rerank_score: 0.7 },
    },
    {
      chunk_id: "sc2",
      doc_id: "d5",
      origin: "repo://notes.md",
      title: "Notes",
      text: "부가 검색 근거 2",
      char_start: 0,
      char_end: 20,
      score: 0.6,
      stages: { bm25_rank: 2, vec_rank: 2, rrf_score: 0.4, rerank_score: 0.6 },
    },
  ],
  stats: { num_bm25: 2, num_vec: 2, pool: 2, reranked: 2, secs: 0.01 },
};

function makeFakeCore(entities: Entity[], digests: ClusterDigest[], search: SearchResponse): CoreClient {
  return {
    async listEntities(): Promise<Entity[]> {
      return entities;
    },
    async listClusterDigests(): Promise<ClusterDigest[]> {
      return digests;
    },
    async search(): Promise<SearchResponse> {
      return search;
    },
  } as unknown as CoreClient;
}

test("entities+digests+search가 병합되고 digest 인용은 digest:// origin을 갖는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-mind-global-test-"));
  try {
    const core = makeFakeCore(ENTITIES, DIGESTS, SEARCH_RESPONSE);
    const llm: LlmClient = {
      model: "mock-sonnet",
      async complete(): Promise<string> {
        return JSON.stringify({
          sentences: [
            { text: "Psyfi는 출시 준비 상태다.", cites: [1] },
            { text: "LLM 에이전트 파이프라인 클러스터는 mind의 질의응답 파이프라인 관련 문서를 모은다.", cites: [4] },
          ],
          insufficient: false,
        });
      },
    };
    const deps: AskDeps = { core, llm, dataDir: dir };

    const envelope = await runGlobalAsk("우리 프로젝트 전체 현황 보여줘", deps);

    assert.equal(envelope.mode, "global");
    assert.equal(envelope.insufficient, false);
    assert.equal(envelope.cost.llm_calls, 1);

    assert.equal(envelope.sources.length, 2);
    assert.equal(envelope.sources[0].origin, "notion://psyfi");
    assert.equal(envelope.sources[1].origin, "digest://llm-agent-pipeline");

    // trace must mark every cluster that has a digest as consulted (exhaustiveness principle).
    assert.equal(envelope.trace.length, 2);
    assert.ok(envelope.trace.every((t) => t.action === "consulted" && t.why === "global digest"));
    const clusters = envelope.trace.map((t) => t.cluster).sort();
    assert.deepEqual(clusters, ["infra-cloudflare", "llm-agent-pipeline"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("레지스트리와 다이제스트가 모두 비어있으면 LLM 호출 없이 insufficient=true를 반환한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-mind-global-test-"));
  try {
    const emptySearch: SearchResponse = { results: [], stats: { num_bm25: 0, num_vec: 0, pool: 0, reranked: 0, secs: 0 } };
    const core = makeFakeCore([], [], emptySearch);
    const llm: LlmClient = {
      model: "mock",
      async complete(): Promise<string> {
        throw new Error("빈 레지스트리+다이제스트에서는 LLM이 호출되면 안 됩니다.");
      },
    };
    const deps: AskDeps = { core, llm, dataDir: dir };

    const envelope = await runGlobalAsk("전체 프로젝트 현황 보여줘", deps);

    assert.equal(envelope.insufficient, true);
    assert.equal(envelope.cost.llm_calls, 0);
    assert.equal(envelope.mode, "global");
    assert.equal(envelope.sources.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
