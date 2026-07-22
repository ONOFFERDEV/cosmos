// GET /universe 페이로드 조립. CONTRACT.md "# M4 확장" 절 "GET /universe" 참고.
// core의 클러스터/centroid/문서 목록 + 로컬 data/queries.jsonl을 모아 3D 좌표를 계산한다.
// 좌표 산출은 전부 결정론(Math.random 금지) — 고전 MDS는 거듭제곱법(power iteration)+디플레이션으로
// 직접 구현한다(외부 선형대수 라이브러리 없이, zero-dependency 제약).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CoreClient, SourceType } from "./core-client.js";

export type Vec3 = [number, number, number];

export interface UniverseClusterNode {
  id: string;
  slug: string;
  name: string | null;
  description: string | null;
  status: "active" | "dormant" | "merged";
  /** M9: 개인 클러스터 소유자(null=공통) — 웹이 "개인 · " 라벨·링 구분에 사용. */
  owner: string | null;
  n_docs: number;
  n_chunks: number;
  pos: Vec3;
  radius: number;
}

export interface UniverseDocNode {
  doc_id: string;
  title: string | null;
  origin: string;
  source_type: SourceType;
  cluster_slug: string | null;
  fit: number | null;
  pos: Vec3;
}

export interface UniverseEdge {
  a: string;
  b: string;
  weight: number;
}

export interface UniverseRecentQuery {
  ts: string;
  question: string;
  mode: string;
  consulted: string[];
  skipped: string[];
}

export interface UniversePayload {
  generated_at: string;
  clusters: UniverseClusterNode[];
  docs: UniverseDocNode[];
  edges: UniverseEdge[];
  recent_queries: UniverseRecentQuery[];
}

// ---------- 벡터/유사도 ----------

/** base64로 인코딩된 f32le(little-endian float32) 바이트열을 숫자 배열로 디코드한다. */
export function decodeCentroid(base64: string): number[] {
  const buf = Buffer.from(base64, "base64");
  const out: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    out.push(buf.readFloatLE(i));
  }
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- 고전 MDS (결정론) ----------

function matVec(m: number[][], v: number[]): number[] {
  const n = m.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const row = m[i]!;
    for (let j = 0; j < n; j++) s += row[j]! * v[j]!;
    out[i] = s;
  }
  return out;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(dot(v, v));
  if (norm < 1e-12) return v.map(() => 0);
  return v.map((x) => x / norm);
}

/**
 * 대칭 행렬 m에 대해 결정론적 초기 벡터(Math.random 미사용)로 거듭제곱법을 수행,
 * 최대 절대값 고유벡터에 수렴시킨다. 초기 벡터는 sin() 기반 고정 패턴 — 올-1 벡터나
 * 단순 램프보다 임의 대칭행렬의 지배 고유벡터와 직교할 위험이 낮다.
 */
function powerIterationDominant(m: number[][], n: number, iterations = 200): number[] {
  let v = normalize(Array.from({ length: n }, (_, i) => Math.sin(i + 1) + 2));
  for (let iter = 0; iter < iterations; iter++) {
    const mv = matVec(m, v);
    const next = normalize(mv);
    if (dot(next, next) === 0) return v;
    v = next;
  }
  return v;
}

/**
 * 대칭 행렬 b의 상위 k개 고유값/고유벡터를 결정론적으로 구한다.
 * b가 음의 고유값을 가질 수 있어(비유클리드 거리 유래) 거듭제곱법이 최대 "절대값"
 * 고유값에 수렴하는 문제를, Gershgorin 상계로 b를 양의 방향으로 shift한 행렬에서
 * 거듭제곱법을 돌려 우회한다(고유벡터는 shift로 안 바뀌고, 고유값은 shift만큼 이동).
 */
function topEigenpairs(b: number[][], n: number, k: number): { values: number[]; vectors: number[][] } {
  const values: number[] = [];
  const vectors: number[][] = [];
  if (n === 0) return { values, vectors };

  let shift = 0;
  for (let i = 0; i < n; i++) {
    let rowAbsSum = 0;
    for (let j = 0; j < n; j++) rowAbsSum += Math.abs(b[i]![j]!);
    shift = Math.max(shift, rowAbsSum);
  }

  let work = b.map((row) => row.slice());
  for (let comp = 0; comp < k && comp < n; comp++) {
    const shifted = work.map((row, i) => row.map((x, j) => (i === j ? x + shift : x)));
    const v = powerIterationDominant(shifted, n);
    const wv = matVec(work, v);
    const lambda = dot(v, wv);
    values.push(lambda);
    vectors.push(v);
    // 디플레이션: work -= lambda * v vT
    work = work.map((row, i) => row.map((x, j) => x - lambda * v[i]! * v[j]!));
  }
  return { values, vectors };
}

function doubleCenter(d2: number[][], n: number): number[][] {
  const rowMean = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += d2[i]![j]!;
    rowMean[i] = s / n;
  }
  let grandMean = 0;
  for (let i = 0; i < n; i++) grandMean += rowMean[i]!;
  grandMean /= n;

  const b: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      row.push(-0.5 * (d2[i]![j]! - rowMean[i]! - rowMean[j]! + grandMean));
    }
    b.push(row);
  }
  return b;
}

/**
 * 코사인 거리(1-코사인유사도) 기반 고전 MDS로 벡터 목록을 3D 좌표로 투영한다.
 * 결정론: 동일 입력은 항상 동일 좌표. 좌표는 [-100,100] 균일 스케일로 정규화한다
 * (상대 거리/모양 보존을 위해 축마다 따로 스케일하지 않는다).
 */
export function classicalMds3D(vectors: number[][]): Vec3[] {
  const n = vectors.length;
  if (n === 0) return [];
  if (n === 1) return [[0, 0, 0]];

  const d2: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      const sim = i === j ? 1 : cosineSimilarity(vectors[i]!, vectors[j]!);
      const d = Math.max(0, 1 - sim);
      row.push(d * d);
    }
    d2.push(row);
  }

  const b = doubleCenter(d2, n);
  const { values, vectors: eigvecs } = topEigenpairs(b, n, 3);

  const raw: number[][] = Array.from({ length: n }, () => [0, 0, 0]);
  for (let c = 0; c < values.length; c++) {
    const lambda = Math.max(0, values[c]!);
    const scale = Math.sqrt(lambda);
    for (let i = 0; i < n; i++) {
      raw[i]![c] = eigvecs[c]![i]! * scale;
    }
  }

  let maxAbs = 0;
  for (const p of raw) for (const v of p) maxAbs = Math.max(maxAbs, Math.abs(v));
  const scaleFactor = maxAbs > 1e-9 ? 100 / maxAbs : 1;

  return raw.map((p) => [p[0]! * scaleFactor, p[1]! * scaleFactor, p[2]! * scaleFactor] as Vec3);
}

// ---------- 클러스터 반경 / 문서 위치 ----------

/** radius ∝ sqrt(n_chunks), 최소 6, 최대 40 (CONTRACT.md). */
export function clusterRadius(nChunks: number): number {
  const r = Math.sqrt(Math.max(0, nChunks)) * 2;
  return Math.min(40, Math.max(6, r));
}

/** doc_id의 sha256으로 결정론적 구면 단위 방향 벡터를 만든다 (Math.random 미사용). */
export function hashDirection(docId: string): Vec3 {
  const digest = createHash("sha256").update(docId).digest();
  const a = digest.readUInt32BE(0) / 0xffffffff;
  const b = digest.readUInt32BE(4) / 0xffffffff;
  const theta = a * 2 * Math.PI;
  const phi = Math.acos(2 * b - 1);
  const x = Math.sin(phi) * Math.cos(theta);
  const y = Math.sin(phi) * Math.sin(theta);
  const z = Math.cos(phi);
  return [x, y, z];
}

/** doc pos = 소속 클러스터 pos + hash(doc_id) 방향 × (1-fit)·radius·0.9 (fit null → 0.55). */
export function docPosition(clusterPos: Vec3, radius: number, docId: string, fit: number | null | undefined): Vec3 {
  const f = fit ?? 0.55;
  const dist = (1 - f) * radius * 0.9;
  const [dx, dy, dz] = hashDirection(docId);
  return [clusterPos[0] + dx * dist, clusterPos[1] + dy * dist, clusterPos[2] + dz * dist];
}

// ---------- 엣지 ----------

const EDGE_SIM_THRESHOLD = 0.3;

/** 클러스터 centroid 코사인 유사도 ≥0.3 쌍만 엣지로 만든다. i<j만 순회하므로 자동으로 대칭/중복없음. */
export function buildEdges(clusters: { slug: string; vector: number[] }[]): UniverseEdge[] {
  const edges: UniverseEdge[] = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const sim = cosineSimilarity(clusters[i]!.vector, clusters[j]!.vector);
      if (sim >= EDGE_SIM_THRESHOLD) {
        edges.push({ a: clusters[i]!.slug, b: clusters[j]!.slug, weight: sim });
      }
    }
  }
  return edges;
}

// ---------- recent_queries (data/queries.jsonl 마지막 20건) ----------

interface QueryLogLine {
  question: string;
  mode: string;
  trace: { cluster: string; action: "consulted" | "skipped" }[];
  timestamp: string;
}

const RECENT_QUERIES_LIMIT = 20;

function toRecentQuery(line: QueryLogLine): UniverseRecentQuery {
  const consulted = line.trace.filter((t) => t.action === "consulted").map((t) => t.cluster);
  const skipped = line.trace.filter((t) => t.action === "skipped").map((t) => t.cluster);
  return { ts: line.timestamp, question: line.question, mode: line.mode, consulted, skipped };
}

async function loadRecentQueries(dataDir: string): Promise<UniverseRecentQuery[]> {
  const logPath = path.join(dataDir, "queries.jsonl");
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-RECENT_QUERIES_LIMIT);
  const out: UniverseRecentQuery[] = [];
  for (const line of tail) {
    try {
      out.push(toRecentQuery(JSON.parse(line) as QueryLogLine));
    } catch {
      // 손상된 라인은 건너뛴다
    }
  }
  return out;
}

function defaultDataDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "data");
}

// ---------- 조립 ----------

export interface UniverseDeps {
  core: CoreClient;
  dataDir?: string;
  now?: () => Date;
  /** M9: 지식 소유권 스코프. 미지정=shared(공개 뷰). */
  ownerScope?: string;
}

export async function buildUniverse(deps: UniverseDeps): Promise<UniversePayload> {
  const [clusters, centroids, docs] = await Promise.all([
    deps.core.listClusters(deps.ownerScope),
    deps.core.getCentroids(),
    deps.core.listDocs(deps.ownerScope),
  ]);

  const centroidById = new Map<string, number[]>();
  for (const c of centroids) {
    centroidById.set(c.id, decodeCentroid(c.centroid));
  }

  const activeClusters = clusters.filter((c) => c.status !== "merged");
  const laidOut = activeClusters.filter((c) => centroidById.has(c.id));
  const vectors = laidOut.map((c) => centroidById.get(c.id)!);
  const positions = classicalMds3D(vectors);

  const posBySlug = new Map<string, Vec3>();
  const radiusBySlug = new Map<string, number>();
  const clusterNodes: UniverseClusterNode[] = laidOut.map((c, i) => {
    const pos = positions[i]!;
    const radius = clusterRadius(c.n_chunks);
    posBySlug.set(c.slug, pos);
    radiusBySlug.set(c.slug, radius);
    return {
      id: c.id,
      slug: c.slug,
      name: c.name ?? null,
      description: c.description ?? null,
      status: c.status,
      owner: c.owner ?? null,
      n_docs: c.n_docs,
      n_chunks: c.n_chunks,
      pos,
      radius,
    };
  });

  // centroid가 아직 없는 active 클러스터(방금 탄생 등)도 원점 배치로 목록엔 포함시켜 universe가
  // core의 재계산 지연과 무관하게 항상 완전한 클러스터 목록을 내도록 한다.
  for (const c of activeClusters) {
    if (centroidById.has(c.id)) continue;
    const radius = clusterRadius(c.n_chunks);
    const pos: Vec3 = [0, 0, 0];
    posBySlug.set(c.slug, pos);
    radiusBySlug.set(c.slug, radius);
    clusterNodes.push({
      id: c.id,
      slug: c.slug,
      name: c.name ?? null,
      description: c.description ?? null,
      status: c.status,
      owner: c.owner ?? null,
      n_docs: c.n_docs,
      n_chunks: c.n_chunks,
      pos,
      radius,
    });
  }

  const docNodes: UniverseDocNode[] = docs.map((d) => {
    const slug = d.cluster_slug ?? null;
    const clusterPos = slug ? posBySlug.get(slug) ?? ([0, 0, 0] as Vec3) : ([0, 0, 0] as Vec3);
    const radius = slug ? radiusBySlug.get(slug) ?? clusterRadius(0) : clusterRadius(0);
    return {
      doc_id: d.doc_id,
      title: d.title ?? null,
      origin: d.origin,
      source_type: d.source_type,
      cluster_slug: slug,
      fit: d.fit ?? null,
      pos: docPosition(clusterPos, radius, d.doc_id, d.fit),
    };
  });

  const edges = buildEdges(laidOut.map((c, i) => ({ slug: c.slug, vector: vectors[i]! })));

  const dataDir = deps.dataDir ?? defaultDataDir();
  const recentQueries = await loadRecentQueries(dataDir);
  const now = deps.now ? deps.now() : new Date();

  return {
    generated_at: now.toISOString(),
    clusters: clusterNodes,
    docs: docNodes,
    edges,
    recent_queries: recentQueries,
  };
}
