import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateDigests } from "./digest.js";
import type {
  CoreClient,
  ClusterSummary,
  DocSummary,
  ClusterDigest,
  HealthResponse,
  SearchRequest,
  SearchResponse,
  BootstrapOptions,
  BootstrapResponse,
  UpdateClusterRequest,
  RouteResponse,
  IngestRequest,
  IngestResponse,
  LifecycleProposalsParams,
  LifecycleProposalsResponse,
  BirthClusterRequest,
  MergeClustersRequest,
  ClusterCentroid,
  Entity,
  BranchSummary,
  CreateBranchRequest,
  MergeBranchRequest,
  MergeBranchResponse,
} from "./core-client.js";
import type { LlmClient, ModelAlias } from "./llm.js";

async function makeTempDataDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cosmos-mind-digest-"));
}

function makeCluster(overrides: Partial<ClusterSummary> = {}): ClusterSummary {
  return {
    id: overrides.id ?? "c1",
    slug: overrides.slug ?? "cluster-1",
    name: overrides.name ?? "클러스터 1",
    description: overrides.description ?? "설명",
    status: overrides.status ?? "active",
    n_docs: overrides.n_docs ?? 3,
    n_chunks: overrides.n_chunks ?? 10,
    ...overrides,
  };
}

function makeDoc(overrides: Partial<DocSummary> = {}): DocSummary {
  return {
    doc_id: overrides.doc_id ?? "d1",
    origin: overrides.origin ?? "origin-1",
    source_type: overrides.source_type ?? "manual",
    title: overrides.title ?? "문서 제목",
    n_chunks: overrides.n_chunks ?? 3,
    ingested_at: overrides.ingested_at ?? new Date().toISOString(),
    cluster_slug: overrides.cluster_slug ?? "cluster-1",
    ...overrides,
  };
}

class MockCoreClient implements CoreClient {
  putClusterDigestCalls: { clusterId: string; text: string; model?: string }[] = [];

  constructor(
    public clusters: ClusterSummary[] = [],
    public digests: ClusterDigest[] = [],
    public docs: DocSummary[] = []
  ) {}

  async health(): Promise<HealthResponse> {
    throw new Error("not implemented");
  }
  async search(_req: SearchRequest): Promise<SearchResponse> {
    throw new Error("not implemented");
  }
  async listClusters(): Promise<ClusterSummary[]> {
    return this.clusters;
  }
  async bootstrapClusters(_opts?: BootstrapOptions): Promise<BootstrapResponse> {
    throw new Error("not implemented");
  }
  async updateCluster(_clusterId: string, _patch: UpdateClusterRequest): Promise<ClusterSummary> {
    throw new Error("not implemented");
  }
  async route(_query: string): Promise<RouteResponse> {
    throw new Error("not implemented");
  }
  async ingest(_req: IngestRequest): Promise<IngestResponse> {
    throw new Error("not implemented");
  }
  async getLifecycleProposals(_params?: LifecycleProposalsParams): Promise<LifecycleProposalsResponse> {
    throw new Error("not implemented");
  }
  async birthCluster(_req: BirthClusterRequest): Promise<ClusterSummary> {
    throw new Error("not implemented");
  }
  async mergeClusters(_req: MergeClustersRequest): Promise<ClusterSummary> {
    throw new Error("not implemented");
  }
  async getCentroids(): Promise<ClusterCentroid[]> {
    throw new Error("not implemented");
  }
  async listDocs(): Promise<DocSummary[]> {
    return this.docs;
  }
  async listEntities(_kind?: string): Promise<Entity[]> {
    throw new Error("not implemented");
  }
  async listClusterDigests(): Promise<ClusterDigest[]> {
    return this.digests;
  }
  async putClusterDigest(clusterId: string, text: string, model?: string): Promise<ClusterDigest> {
    this.putClusterDigestCalls.push({ clusterId, text, model });
    const now = new Date().toISOString();
    const cluster = this.clusters.find((c) => c.id === clusterId);
    const digest: ClusterDigest = {
      cluster_id: clusterId,
      slug: cluster?.slug ?? clusterId,
      name: cluster?.name ?? undefined,
      text,
      model,
      updated_at: now,
    };
    this.digests = [...this.digests.filter((d) => d.cluster_id !== clusterId), digest];
    return digest;
  }
  async listBranches(_status?: string): Promise<BranchSummary[]> {
    throw new Error("not implemented");
  }
  async getBranchDocs(_branchId: string): Promise<DocSummary[]> {
    throw new Error("not implemented");
  }
  async createBranch(_req: CreateBranchRequest): Promise<BranchSummary> {
    throw new Error("not implemented");
  }
  async mergeBranch(_branchId: string, _req?: MergeBranchRequest): Promise<MergeBranchResponse> {
    throw new Error("not implemented");
  }
  async discardBranch(_branchId: string): Promise<BranchSummary> {
    throw new Error("not implemented");
  }
}

class MockLlmClient implements LlmClient {
  readonly model = "mock";
  prompts: string[] = [];
  constructor(private responder: (prompt: string) => string) {}

  async complete(prompt: string, _model?: ModelAlias): Promise<string> {
    this.prompts.push(prompt);
    return this.responder(prompt);
  }
}

test("다이제스트가 없는 클러스터만 생성한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const clusters = [makeCluster({ id: "c1", slug: "cluster-1" }), makeCluster({ id: "c2", slug: "cluster-2" })];
    const digests: ClusterDigest[] = [
      { cluster_id: "c1", slug: "cluster-1", text: "기존 다이제스트", updated_at: new Date().toISOString() },
    ];
    const core = new MockCoreClient(clusters, digests, []);
    const llm = new MockLlmClient(() => "생성된 다이제스트 텍스트");

    const result = await generateDigests({ core, llm, dataDir }, {});

    assert.equal(result.generated, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 0);
    assert.equal(core.putClusterDigestCalls.length, 1);
    assert.equal(core.putClusterDigestCalls[0].clusterId, "c2");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("n_docs가 변하면 재생성하고 변화 없으면 스킵한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const cluster = makeCluster({ id: "c1", slug: "cluster-1", n_docs: 5 });
    const core = new MockCoreClient([cluster], [], []);
    const llm = new MockLlmClient(() => "새 다이제스트");

    // 첫 실행: 다이제스트가 아직 없으므로 생성(스냅샷 기준선 확보).
    const first = await generateDigests({ core, llm, dataDir }, {});
    assert.equal(first.generated, 1);

    // 두 번째 실행: n_docs 변화 없음 -> 스킵.
    const second = await generateDigests({ core, llm, dataDir }, {});
    assert.equal(second.generated, 0);
    assert.equal(second.skipped, 1);

    // n_docs 변경 후 재실행: 재생성.
    core.clusters = [{ ...cluster, n_docs: 8 }];
    const third = await generateDigests({ core, llm, dataDir }, {});
    assert.equal(third.generated, 1);
    assert.equal(third.skipped, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("opts.all=true면 변화 없는 클러스터도 강제 재생성한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const cluster = makeCluster({ id: "c1", slug: "cluster-1", n_docs: 5 });
    const core = new MockCoreClient([cluster], [], []);
    const llm = new MockLlmClient(() => "새 다이제스트");

    await generateDigests({ core, llm, dataDir }, {});
    assert.equal(core.putClusterDigestCalls.length, 1);

    const result = await generateDigests({ core, llm, dataDir }, { all: true });
    assert.equal(result.generated, 1);
    assert.equal(result.skipped, 0);
    assert.equal(core.putClusterDigestCalls.length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LLM 호출이 실패한 클러스터는 건너뛰고 나머지는 계속 생성하며 failed로 집계한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const clusters = [makeCluster({ id: "c1", slug: "cluster-1" }), makeCluster({ id: "c2", slug: "cluster-2" })];
    const core = new MockCoreClient(clusters, [], []);
    const llm = new MockLlmClient((prompt) => {
      if (prompt.includes("cluster-1")) {
        throw new Error("LLM 호출 실패");
      }
      return "정상 다이제스트";
    });

    const result = await generateDigests({ core, llm, dataDir }, {});

    assert.equal(result.generated, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 0);
    const failedOutcome = result.outcomes.find((o) => o.status === "failed");
    assert.equal(failedOutcome?.cluster_id, "c1");
    assert.ok(failedOutcome?.error?.includes("LLM 호출 실패"));
    assert.equal(core.putClusterDigestCalls.length, 1);
    assert.equal(core.putClusterDigestCalls[0].clusterId, "c2");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("프롬프트에는 클러스터 멤버 문서의 제목만 포함되고 다른 클러스터 문서는 섞이지 않는다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const clusters = [makeCluster({ id: "c1", slug: "cluster-1" })];
    const docs = [
      makeDoc({ doc_id: "d1", title: "클러스터1 문서 A", cluster_slug: "cluster-1" }),
      makeDoc({ doc_id: "d2", title: "클러스터1 문서 B", cluster_slug: "cluster-1" }),
      makeDoc({ doc_id: "d3", title: "다른 클러스터 문서", cluster_slug: "cluster-2" }),
    ];
    const core = new MockCoreClient(clusters, [], docs);
    const llm = new MockLlmClient(() => "다이제스트");

    await generateDigests({ core, llm, dataDir }, {});

    assert.equal(llm.prompts.length, 1);
    const prompt = llm.prompts[0];
    assert.ok(prompt.includes("클러스터1 문서 A"));
    assert.ok(prompt.includes("클러스터1 문서 B"));
    assert.ok(!prompt.includes("다른 클러스터 문서"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
