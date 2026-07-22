import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ClusterCentroid, ClusterSummary, CoreClient, DocSummary } from "./core-client.js";
import {
  buildEdges,
  buildUniverse,
  classicalMds3D,
  cosineSimilarity,
  decodeCentroid,
  docPosition,
  hashDirection,
} from "./universe.js";

function encodeCentroid(vec: number[]): string {
  const buf = Buffer.alloc(vec.length * 4);
  vec.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString("base64");
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

class MockCoreClient {
  constructor(
    private clustersData: ClusterSummary[],
    private centroidsData: ClusterCentroid[],
    private docsData: DocSummary[]
  ) {}

  async listClusters(): Promise<ClusterSummary[]> {
    return this.clustersData;
  }

  async getCentroids(): Promise<ClusterCentroid[]> {
    return this.centroidsData;
  }

  async listDocs(): Promise<DocSummary[]> {
    return this.docsData;
  }
}

async function makeTempDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cosmos-universe-test-"));
}

// ---------- decodeCentroid / cosineSimilarity ----------

test("decodeCentroid는 base64 f32le를 왕복 디코드한다", () => {
  const vec = [1, -2.5, 0.25, 100];
  const decoded = decodeCentroid(encodeCentroid(vec));
  assert.equal(decoded.length, 4);
  decoded.forEach((v, i) => assert.ok(Math.abs(v - vec[i]!) < 1e-4));
});

test("cosineSimilarity는 동일 벡터에서 1을, 직교 벡터에서 0을 반환한다", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 1e-9);
});

// ---------- classicalMds3D ----------

test("classicalMds3D는 동일 입력에 대해 항상 동일 좌표를 낸다(결정론)", () => {
  const vectors = [
    [1, 0, 0, 0, 0],
    [0.9, 0.1, 0, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0.9, 0.1, 0],
  ];
  const a = classicalMds3D(vectors);
  const b = classicalMds3D(vectors);
  assert.deepEqual(a, b);
});

test("classicalMds3D는 코사인 거리가 가까운 쌍을 먼 쌍보다 3D에서 더 가깝게 배치하는 경향을 보인다", () => {
  // v0,v1: 거의 동일 방향(가까움). v2: v0과 거의 직교(멀음).
  const v0 = [1, 0, 0, 0];
  const v1 = [0.95, 0.05, 0, 0];
  const v2 = [0, 0, 1, 0];
  const positions = classicalMds3D([v0, v1, v2]);
  const dNear = dist3(positions[0]!, positions[1]!);
  const dFar = dist3(positions[0]!, positions[2]!);
  assert.ok(dNear < dFar, `가까운 쌍 거리(${dNear})가 먼 쌍 거리(${dFar})보다 작아야 한다`);
});

test("classicalMds3D는 n=0/1일 때 안전하게 처리한다", () => {
  assert.deepEqual(classicalMds3D([]), []);
  assert.deepEqual(classicalMds3D([[1, 2, 3]]), [[0, 0, 0]]);
});

// ---------- hashDirection / docPosition ----------

test("hashDirection은 동일 doc_id에 대해 항상 동일한 단위 벡터를 반환한다", () => {
  const a = hashDirection("doc-abc");
  const b = hashDirection("doc-abc");
  assert.deepEqual(a, b);
  const norm = Math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2);
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test("docPosition은 동일 입력에 대해 결정론적이다", () => {
  const p1 = docPosition([10, 20, 30], 10, "doc-1", 0.7);
  const p2 = docPosition([10, 20, 30], 10, "doc-1", 0.7);
  assert.deepEqual(p1, p2);
});

test("docPosition은 fit이 높을수록 클러스터 중심에 더 가깝다(오프셋이 작다)", () => {
  const center: [number, number, number] = [0, 0, 0];
  const radius = 20;
  const highFit = docPosition(center, radius, "doc-x", 0.95);
  const lowFit = docPosition(center, radius, "doc-x", 0.1);
  const dHigh = dist3(center, highFit);
  const dLow = dist3(center, lowFit);
  assert.ok(dHigh < dLow, `fit 높은 문서 오프셋(${dHigh})이 fit 낮은 문서 오프셋(${dLow})보다 작아야 한다`);
});

test("docPosition은 fit이 null이면 0.55로 취급한다", () => {
  const center: [number, number, number] = [0, 0, 0];
  const radius = 20;
  const nullFit = docPosition(center, radius, "doc-y", null);
  const explicit = docPosition(center, radius, "doc-y", 0.55);
  assert.deepEqual(nullFit, explicit);
});

// ---------- buildEdges ----------

test("buildEdges는 코사인 유사도 0.3 이상인 쌍만, 중복/역방향 없이 만든다", () => {
  const clusters = [
    { slug: "a", vector: [1, 0, 0] },
    { slug: "b", vector: [0.9, 0.1, 0] }, // a와 유사도 높음 (>=0.3)
    { slug: "c", vector: [0, 1, 0] }, // a와 직교 (0, <0.3)
  ];
  const edges = buildEdges(clusters);

  const ab = edges.find((e) => (e.a === "a" && e.b === "b") || (e.a === "b" && e.b === "a"));
  assert.ok(ab, "a-b 엣지가 있어야 한다");

  const ac = edges.find((e) => (e.a === "a" && e.b === "c") || (e.a === "c" && e.b === "a"));
  assert.equal(ac, undefined, "a-c 엣지는 임계값 미달로 없어야 한다");

  const reverseDup = edges.filter(
    (e) => (e.a === "a" && e.b === "b") || (e.a === "b" && e.b === "a")
  );
  assert.equal(reverseDup.length, 1, "a-b 쌍은 정확히 1개만 존재해야 한다(역방향 중복 없음)");
});

test("buildEdges는 0.3 바로 위 유사도는 포함하고 바로 아래 유사도는 제외한다(>= 경계)", () => {
  // 정확히 0.3인 부동소수점 값을 삼각함수로 재현하려 하면 IEEE754 반올림 오차로
  // 근소하게 어긋날 수 있으므로, 임계값 바로 위/아래로 뚜렷이 분리된 두 값으로 검증한다.
  const above = Math.cos(Math.acos(0.31)); // ~0.31
  const below = Math.cos(Math.acos(0.29)); // ~0.29
  const a = [1, 0];
  const bAbove = [above, Math.sqrt(1 - above * above)];
  const bBelow = [below, Math.sqrt(1 - below * below)];

  const edgesAbove = buildEdges([
    { slug: "x", vector: a },
    { slug: "y", vector: bAbove },
  ]);
  assert.equal(edgesAbove.length, 1, "0.3보다 뚜렷이 큰 유사도는 엣지에 포함되어야 한다");

  const edgesBelow = buildEdges([
    { slug: "x", vector: a },
    { slug: "y", vector: bBelow },
  ]);
  assert.equal(edgesBelow.length, 0, "0.3보다 뚜렷이 작은 유사도는 엣지에서 제외되어야 한다");
});

// ---------- buildUniverse (통합) ----------

test("buildUniverse는 클러스터/문서 좌표를 계산하고 recent_queries를 CONTRACT 형식으로 변환한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const clusters: ClusterSummary[] = [
      { id: "c1", slug: "agents", name: "Agents", description: "d1", status: "active", n_docs: 5, n_chunks: 20 },
      { id: "c2", slug: "robotics", name: "Robotics", description: "d2", status: "active", n_docs: 3, n_chunks: 8 },
      { id: "c3", slug: "merged-away", name: "Old", description: null, status: "merged", n_docs: 0, n_chunks: 0 },
      { id: "c4", slug: "no-centroid", name: "New", description: null, status: "active", n_docs: 1, n_chunks: 2 },
    ];
    const centroids: ClusterCentroid[] = [
      { id: "c1", centroid: encodeCentroid([1, 0, 0, 0]) },
      { id: "c2", centroid: encodeCentroid([0.9, 0.1, 0, 0]) },
      { id: "c3", centroid: encodeCentroid([0, 0, 1, 0]) },
    ];
    const docs: DocSummary[] = [
      { doc_id: "doc-1", origin: "https://x", source_type: "arxiv", title: "T1", n_chunks: 4, ingested_at: "2026-01-01T00:00:00Z", cluster_slug: "agents", fit: 0.8 },
      { doc_id: "doc-2", origin: "https://y", source_type: "manual", title: "T2", n_chunks: 2, ingested_at: "2026-01-02T00:00:00Z", cluster_slug: null, fit: null },
    ];

    const core = new MockCoreClient(clusters, centroids, docs);

    const logLines = [
      JSON.stringify({
        question: "agents란?",
        mode: "shallow",
        trace: [
          { cluster: "agents", action: "consulted" },
          { cluster: "robotics", action: "skipped" },
        ],
        timestamp: "2026-01-03T00:00:00Z",
      }),
      JSON.stringify({
        question: "로보틱스 최신 동향은?",
        mode: "deep",
        trace: [{ cluster: "robotics", action: "consulted" }],
        timestamp: "2026-01-04T00:00:00Z",
      }),
    ];
    await appendFile(path.join(dataDir, "queries.jsonl"), logLines.join("\n") + "\n", "utf8");

    const payload = await buildUniverse({ core: core as unknown as CoreClient, dataDir });

    // merged 클러스터는 제외되어야 한다
    assert.equal(payload.clusters.find((c) => c.slug === "merged-away"), undefined);

    // centroid 없는 active 클러스터는 원점에 포함되어야 한다
    const noCentroid = payload.clusters.find((c) => c.slug === "no-centroid");
    assert.ok(noCentroid);
    assert.deepEqual(noCentroid!.pos, [0, 0, 0]);

    // agents/robotics는 centroid 기반 MDS 좌표를 가져야 한다
    const agents = payload.clusters.find((c) => c.slug === "agents")!;
    const robotics = payload.clusters.find((c) => c.slug === "robotics")!;
    assert.ok(agents.pos.some((v) => v !== 0) || robotics.pos.some((v) => v !== 0));

    // 반경은 sqrt(n_chunks)*2, clamp[6,40]
    assert.ok(agents.radius >= 6 && agents.radius <= 40);

    // 문서 위치는 소속 클러스터 중심 근방
    const doc1 = payload.docs.find((d) => d.doc_id === "doc-1")!;
    assert.ok(doc1.pos.every((v) => Number.isFinite(v)));

    // recent_queries 변환 검증: timestamp -> ts, trace -> consulted/skipped
    assert.equal(payload.recent_queries.length, 2);
    const q1 = payload.recent_queries.find((q) => q.question === "agents란?")!;
    assert.equal(q1.ts, "2026-01-03T00:00:00Z");
    assert.deepEqual(q1.consulted, ["agents"]);
    assert.deepEqual(q1.skipped, ["robotics"]);

    assert.ok(payload.generated_at);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("buildUniverse는 queries.jsonl이 없으면 recent_queries를 빈 배열로 반환한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient([], [], []);
    const payload = await buildUniverse({ core: core as unknown as CoreClient, dataDir });
    assert.deepEqual(payload.recent_queries, []);
    assert.deepEqual(payload.clusters, []);
    assert.deepEqual(payload.docs, []);
    assert.deepEqual(payload.edges, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("buildUniverse는 queries.jsonl 마지막 20건만 recent_queries로 반환한다", async () => {
  const dataDir = await makeTempDataDir();
  try {
    const core = new MockCoreClient([], [], []);
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(
        JSON.stringify({
          question: `q${i}`,
          mode: "shallow",
          trace: [],
          timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
        })
      );
    }
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "queries.jsonl"), lines.join("\n") + "\n", "utf8");

    const payload = await buildUniverse({ core: core as unknown as CoreClient, dataDir });
    assert.equal(payload.recent_queries.length, 20);
    assert.equal(payload.recent_queries[0]!.question, "q5");
    assert.equal(payload.recent_queries[19]!.question, "q24");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
