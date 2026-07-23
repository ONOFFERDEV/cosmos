// Assembles the GET /universe payload. See CONTRACT.md "# M4 확장" section "GET /universe".
// Gathers core's cluster/centroid/doc lists + the local data/queries.jsonl to compute 3D coordinates.
// Coordinate derivation is fully deterministic (no Math.random) — classical MDS is implemented
// directly via power iteration + deflation (no external linear-algebra library, zero-dependency constraint).

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
  /** M9: personal cluster owner (null=shared) — used by the web UI to distinguish the "개인 · " label/ring. */
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

/** M10 relationship lines: links to draw between doc points (both endpoint doc_ids are guaranteed to exist in docs). */
export interface UniverseLink {
  src: string;
  dst: string;
  rel_type: string;
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
  /** M10 relationship lines. Empty array if core /graph/links is unavailable (older version or test fake). */
  links: UniverseLink[];
  recent_queries: UniverseRecentQuery[];
}

// ---------- Vectors/similarity ----------

/** Decodes a base64-encoded f32le (little-endian float32) byte sequence into a number array. */
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

// ---------- Classical MDS (deterministic) ----------

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
 * Runs power iteration on symmetric matrix m with a deterministic initial vector (no Math.random),
 * converging to the eigenvector with the largest absolute eigenvalue. The initial vector is a fixed
 * sin()-based pattern — lower risk of being orthogonal to an arbitrary symmetric matrix's dominant
 * eigenvector than an all-1s vector or a simple ramp.
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
 * Deterministically computes the top k eigenvalues/eigenvectors of symmetric matrix b.
 * Since b can have negative eigenvalues (arising from non-Euclidean distances), power iteration
 * would converge to the largest-absolute-value eigenvalue — this is worked around by running
 * power iteration on a matrix shifted positive by the Gershgorin upper bound (eigenvectors are
 * unchanged by the shift, and eigenvalues shift by that amount).
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
    // Deflation: work -= lambda * v vT
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
 * Projects a list of vectors into 3D coordinates via classical MDS based on cosine distance (1-cosine similarity).
 * Deterministic: identical input always yields identical coordinates. Coordinates are normalized to a
 * uniform [-100,100] scale (not scaled per-axis separately, to preserve relative distances/shape).
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

// ---------- Cluster radius / doc position ----------

/** radius ∝ sqrt(n_chunks), min 6, max 40 (CONTRACT.md). */
export function clusterRadius(nChunks: number): number {
  const r = Math.sqrt(Math.max(0, nChunks)) * 2;
  return Math.min(40, Math.max(6, r));
}

/** Builds a deterministic unit direction vector on a sphere from doc_id's sha256 (no Math.random). */
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

/** doc pos = parent cluster pos + hash(doc_id) direction × (1-fit)·radius·0.9 (fit null → 0.55). */
export function docPosition(clusterPos: Vec3, radius: number, docId: string, fit: number | null | undefined): Vec3 {
  const f = fit ?? 0.55;
  const dist = (1 - f) * radius * 0.9;
  const [dx, dy, dz] = hashDirection(docId);
  return [clusterPos[0] + dx * dist, clusterPos[1] + dy * dist, clusterPos[2] + dz * dist];
}

// ---------- Edges ----------

const EDGE_SIM_THRESHOLD = 0.3;

/** Only cluster centroid pairs with cosine similarity ≥0.3 become edges. Iterates i<j only, so automatically symmetric/no duplicates. */
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

// ---------- recent_queries (last 20 entries from data/queries.jsonl) ----------

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
      // Skip corrupted lines
    }
  }
  return out;
}

function defaultDataDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "data");
}

// ---------- Assembly ----------

export interface UniverseDeps {
  core: CoreClient;
  dataDir?: string;
  now?: () => Date;
  /** M9: knowledge ownership scope. Unspecified=shared (public view). */
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

  // Active clusters that don't have a centroid yet (e.g. just created) are still included in the
  // list at the origin, so universe always emits a complete cluster list regardless of core's recompute lag.
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

  // M10 relationship lines: core already enforces scope isolation, but we filter once more against
  // this view's doc set to satisfy the payload contract ("both endpoints exist in docs"). Unavailable core → silently empty array.
  let links: UniverseLink[] = [];
  const graphLinksFn = deps.core.graphLinks?.bind(deps.core);
  if (graphLinksFn) {
    try {
      const docIds = new Set(docNodes.map((d) => d.doc_id));
      const pairs = await graphLinksFn(deps.ownerScope);
      links = pairs
        .filter((p) => docIds.has(p.src_doc_id) && docIds.has(p.dst_doc_id))
        .map((p) => ({ src: p.src_doc_id, dst: p.dst_doc_id, rel_type: p.rel_type }));
    } catch {
      links = [];
    }
  }

  const dataDir = deps.dataDir ?? defaultDataDir();
  const recentQueries = await loadRecentQueries(dataDir);
  const now = deps.now ? deps.now() : new Date();

  return {
    generated_at: now.toISOString(),
    clusters: clusterNodes,
    docs: docNodes,
    edges,
    links,
    recent_queries: recentQueries,
  };
}
