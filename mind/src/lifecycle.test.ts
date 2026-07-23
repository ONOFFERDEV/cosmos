import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runLifecycle, lifecycleStatus, type LifecycleDeps } from "./lifecycle.js";
import type {
  CoreClient,
  LifecycleProposalsResponse,
  BirthClusterRequest,
  MergeClustersRequest,
  ClusterSummary,
  DocSummary,
  ClusterDigest,
} from "./core-client.js";
import type { LlmClient } from "./llm.js";
import type { LifecycleConfig } from "./config.js";

const CONFIG: LifecycleConfig = { birth_min: 12, birth_cohesion: 0.55, merge_sim: 0.85 };

class MockCoreClient {
  public birthClusterCalls: BirthClusterRequest[] = [];
  public mergeClustersCalls: MergeClustersRequest[] = [];
  public listClustersCalls = 0;
  public putClusterDigestCalls: { clusterId: string; text: string; model?: string }[] = [];
  private proposals: LifecycleProposalsResponse;

  constructor(proposals: LifecycleProposalsResponse) {
    this.proposals = proposals;
  }

  setProposals(proposals: LifecycleProposalsResponse): void {
    this.proposals = proposals;
  }

  async getLifecycleProposals(): Promise<LifecycleProposalsResponse> {
    return this.proposals;
  }

  // Methods that digest.ts (generateDigests) calls after lifecycle runs — this test file
  // only needs to observe "was it called", so leave these as minimal stubs returning empty arrays.
  async listClusters(): Promise<ClusterSummary[]> {
    this.listClustersCalls++;
    return [];
  }

  async listDocs(): Promise<DocSummary[]> {
    return [];
  }

  async listClusterDigests(): Promise<ClusterDigest[]> {
    return [];
  }

  async putClusterDigest(clusterId: string, text: string, model?: string): Promise<ClusterDigest> {
    this.putClusterDigestCalls.push({ clusterId, text, model });
    return { cluster_id: clusterId, slug: clusterId, text, model, updated_at: new Date().toISOString() };
  }

  async birthCluster(req: BirthClusterRequest): Promise<ClusterSummary> {
    this.birthClusterCalls.push(req);
    return {
      id: "new-cluster",
      slug: req.slug,
      name: req.name ?? null,
      description: req.description ?? null,
      status: "active",
      n_docs: req.doc_ids.length,
      n_chunks: 0,
    };
  }

  async mergeClusters(req: MergeClustersRequest): Promise<ClusterSummary> {
    this.mergeClustersCalls.push(req);
    return {
      id: req.dst_id,
      slug: "merged",
      name: null,
      description: null,
      status: "active",
      n_docs: 0,
      n_chunks: 0,
    };
  }
}

class MockLlmClient {
  readonly model = "mock";
  constructor(private readonly responder: (prompt: string) => string) {}

  async complete(prompt: string): Promise<string> {
    return this.responder(prompt);
  }
}

async function makeTempDataDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "cosmos-lifecycle-test-"));
}

function makeMergeProposal(aId: string, bId: string, sim = 0.9) {
  return { a_id: aId, b_id: bId, a_slug: `${aId}-slug`, b_slug: `${bId}-slug`, centroid_sim: sim };
}

async function readState(dataDir: string): Promise<{ merge_streaks: Record<string, number> }> {
  const raw = await readFile(path.join(dataDir, "lifecycle.state.json"), "utf8");
  return JSON.parse(raw) as { merge_streaks: Record<string, number> };
}

test("병합 후보를 1회만 관측하면 병합을 트리거하지 않는다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient({ births: [], merges: [makeMergeProposal("c1", "c2")] });
    const llm = new MockLlmClient(() => JSON.stringify({}));
    const deps: LifecycleDeps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, config: CONFIG, dataDir };

    const result = await runLifecycle(deps);

    assert.equal(result.merges.length, 1);
    assert.equal(result.merges[0]!.status, "observed");
    assert.equal(result.merges[0]!.streak, 1);
    assert.equal(core.mergeClustersCalls.length, 0, "1회 관측만으로는 병합 API가 호출되면 안 된다");

    const state = await readState(dataDir);
    assert.equal(state.merge_streaks["c1::c2"], 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("같은 병합 후보 쌍을 연속 2회 관측하면 병합을 트리거하고 스트릭을 초기화한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient({ births: [], merges: [makeMergeProposal("c1", "c2")] });
    const llm = new MockLlmClient(() => JSON.stringify({}));
    const deps: LifecycleDeps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, config: CONFIG, dataDir };

    await runLifecycle(deps); // run 1 — observation only
    const result = await runLifecycle(deps); // run 2 (consecutive) — triggers merge

    assert.equal(result.merges[0]!.status, "merged");
    assert.equal(result.merges[0]!.streak, 2);
    assert.equal(core.mergeClustersCalls.length, 1);
    assert.deepEqual(core.mergeClustersCalls[0], { src_id: "c1", dst_id: "c2" });

    const state = await readState(dataDir);
    assert.equal(state.merge_streaks["c1::c2"], 0, "병합 트리거 후 스트릭은 0으로 초기화되어야 한다");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("병합 후보 쌍이 관측에서 빠지면 스트릭이 끊기고, 재관측 시 처음부터 다시 센다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient({ births: [], merges: [makeMergeProposal("c1", "c2")] });
    const llm = new MockLlmClient(() => JSON.stringify({}));
    const deps: LifecycleDeps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, config: CONFIG, dataDir };

    await runLifecycle(deps); // run 1 — streak=1

    // Run 2: this pair drops out of the candidates this time (only a different merge exists) — the streak must break.
    core.setProposals({ births: [], merges: [makeMergeProposal("c3", "c4")] });
    await runLifecycle(deps);

    let state = await readState(dataDir);
    assert.equal(state.merge_streaks["c1::c2"], undefined, "관측이 끊긴 쌍은 상태에서 제거되어야 한다");

    // Run 3: the c1/c2 pair reappears — since no previous streak remains, it must restart at 1.
    core.setProposals({ births: [], merges: [makeMergeProposal("c1", "c2")] });
    const result = await runLifecycle(deps);

    assert.equal(result.merges[0]!.status, "observed", "끊긴 스트릭은 재관측 시 바로 병합을 트리거하면 안 된다");
    assert.equal(result.merges[0]!.streak, 1);
    assert.equal(core.mergeClustersCalls.length, 0);

    state = await readState(dataDir);
    assert.equal(state.merge_streaks["c1::c2"], 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("--dry-run은 병합을 트리거할 스트릭이어도 API를 호출하지 않고 상태 파일도 갱신하지 않는다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient({ births: [], merges: [makeMergeProposal("c1", "c2")] });
    const llm = new MockLlmClient(() => JSON.stringify({}));
    const deps: LifecycleDeps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, config: CONFIG, dataDir };

    await runLifecycle(deps); // real run — writes streak=1 to disk

    const result = await runLifecycle(deps, { dryRun: true }); // dry-run, run 2 — logically streak=2

    assert.equal(result.merges[0]!.status, "dry_run_would_merge");
    assert.equal(result.merges[0]!.streak, 2);
    assert.equal(core.mergeClustersCalls.length, 0, "dry-run은 병합 API를 호출하면 안 된다");

    const state = await readState(dataDir);
    assert.equal(state.merge_streaks["c1::c2"], 1, "dry-run은 상태 파일을 갱신하면 안 된다(부작용 없음)");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("탄생 후보 하나의 LLM 라벨링이 실패해도 다른 후보는 정상적으로 탄생 처리된다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient({
      births: [
        { doc_ids: ["d1"], cohesion: 0.9, sample_titles: ["FAIL_TITLE 실패용 논문"] },
        { doc_ids: ["d2", "d3"], cohesion: 0.8, sample_titles: ["정상 논문 제목"] },
      ],
      merges: [],
    });
    const llm = new MockLlmClient((prompt) => {
      if (prompt.includes("FAIL_TITLE")) {
        throw new Error("모의 LLM 실패");
      }
      return JSON.stringify({ slug: "normal-cluster", name: "정상 클러스터", description: "설명" });
    });
    const deps: LifecycleDeps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, config: CONFIG, dataDir };

    const result = await runLifecycle(deps);

    assert.equal(result.births.length, 2);
    assert.equal(result.births[0]!.status, "naming_failed");
    assert.equal(result.births[0]!.slug, null);
    assert.ok(result.births[0]!.error && result.births[0]!.error!.length > 0);

    assert.equal(result.births[1]!.status, "created");
    assert.equal(result.births[1]!.slug, "normal-cluster");

    assert.equal(core.birthClusterCalls.length, 1, "실패한 후보는 탄생 API가 호출되면 안 되고, 성공한 후보만 호출되어야 한다");
    assert.equal(core.birthClusterCalls[0]!.slug, "normal-cluster");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("--dry-run에서 탄생 후보는 라벨링만 하고 탄생 API를 호출하지 않는다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient({
      births: [{ doc_ids: ["d1", "d2"], cohesion: 0.9, sample_titles: ["논문 제목"] }],
      merges: [],
    });
    const llm = new MockLlmClient(() => JSON.stringify({ slug: "dry-cluster", name: "드라이런 클러스터", description: "설명" }));
    const deps: LifecycleDeps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, config: CONFIG, dataDir };

    const result = await runLifecycle(deps, { dryRun: true });

    assert.equal(result.births[0]!.status, "dry_run");
    assert.equal(result.births[0]!.slug, "dry-cluster");
    assert.equal(core.birthClusterCalls.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("같은 실행 내 탄생 후보 slug가 충돌하면 dedupSlug로 접미사를 붙인다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient({
      births: [
        { doc_ids: ["d1"], cohesion: 0.9, sample_titles: ["첫 논문"] },
        { doc_ids: ["d2"], cohesion: 0.9, sample_titles: ["둘째 논문"] },
      ],
      merges: [],
    });
    const llm = new MockLlmClient(() => JSON.stringify({ slug: "dup-cluster", name: "이름", description: "설명" }));
    const deps: LifecycleDeps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, config: CONFIG, dataDir };

    const result = await runLifecycle(deps);

    assert.equal(result.births[0]!.slug, "dup-cluster");
    assert.equal(result.births[1]!.slug, "dup-cluster-2");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("lifecycleStatus는 상태 파일을 변경하지 않고 현재 스트릭만 읽어 보고한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient({ births: [{ doc_ids: ["d1"], cohesion: 0.9, sample_titles: ["논문"] }], merges: [makeMergeProposal("c1", "c2")] });
    const llm = new MockLlmClient(() => JSON.stringify({}));
    const deps: LifecycleDeps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, config: CONFIG, dataDir };

    await runLifecycle(deps); // seed streak=1 (the 1 birth candidate is also processed normally here)
    const birthCallsAfterSeed = core.birthClusterCalls.length;
    const mergeCallsAfterSeed = core.mergeClustersCalls.length;

    const status1 = await lifecycleStatus({ core: core as unknown as CoreClient, config: CONFIG, dataDir });
    assert.equal(status1.births_pending, 1);
    assert.equal(status1.merges[0]!.streak, 1);
    assert.equal(status1.merges[0]!.would_trigger_next_run, true);

    const status2 = await lifecycleStatus({ core: core as unknown as CoreClient, config: CONFIG, dataDir });
    assert.deepEqual(status1, status2, "status 호출은 상태를 바꾸지 않으므로 반복 호출해도 결과가 같아야 한다");
    assert.equal(core.mergeClustersCalls.length, mergeCallsAfterSeed, "status 호출 자체는 병합 API를 호출하면 안 된다");
    assert.equal(core.birthClusterCalls.length, birthCallsAfterSeed, "status 호출 자체는 탄생 API를 호출하면 안 된다");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("lifecycle run은 dry-run이 아닐 때만 다이제스트 생성을 시도한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient({ births: [], merges: [] });
    const llm = new MockLlmClient(() => JSON.stringify({}));
    const deps: LifecycleDeps = { core: core as unknown as CoreClient, llm: llm as unknown as LlmClient, config: CONFIG, dataDir };

    await runLifecycle(deps, { dryRun: true });
    assert.equal(core.listClustersCalls, 0, "dry-run에서는 다이제스트 생성이 호출되면 안 된다");

    await runLifecycle(deps, { dryRun: false });
    // M9: generateDigests iterates over 2 scopes (shared, shared+admin), so listClusters is called twice.
    assert.equal(core.listClustersCalls, 2, "dry-run이 아니면 다이제스트 생성이 호출되어야 한다(2스코프 순회)");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
