// cosmos-core (Rust, :8801) HTTP contract client.
// Schema follows ../contract/openapi.yaml exactly (only includes endpoints mind actually uses:
// /health, /search, /clusters, /clusters/bootstrap, /clusters/{id} PATCH, /route).
// CoreClient is exposed as an interface so tests can inject a mock.

export interface HealthResponse {
  status: "ok";
  version: string;
  docs: number;
  chunks: number;
  clusters: number;
}

export interface SearchRequest {
  query: string;
  k?: number;
  cluster_ids?: string[];
  // M9: ownership scope ("shared" | "shared+<name>"). mind determines this from identity and fills it in.
  owner_scope?: string;
}

export interface SearchResultStages {
  bm25_rank: number | null;
  vec_rank: number | null;
  rrf_score: number;
  rerank_score: number;
}

export interface SearchResult {
  chunk_id: string;
  doc_id: string;
  origin: string;
  title?: string;
  text: string;
  char_start: number;
  char_end: number;
  section?: string | null;
  score: number;
  stages: SearchResultStages;
}

export interface SearchResponse {
  results: SearchResult[];
  stats: {
    num_bm25: number;
    num_vec: number;
    pool: number;
    reranked: number;
    secs: number;
  };
}

export interface ClusterSummary {
  id: string;
  slug: string;
  name?: string | null;
  description?: string | null;
  status: "active" | "dormant" | "merged";
  /** M9: owner of the personal knowledge space (null = shared). */
  owner?: string | null;
  n_docs: number;
  n_chunks: number;
  updated_at?: string;
}

export interface ClusterBootstrapSample {
  origin: string;
  title?: string;
  snippet?: string;
}

export interface ClusterBootstrapResult extends ClusterSummary {
  sample: ClusterBootstrapSample[];
}

export interface BootstrapOptions {
  k_min?: number;
  k_max?: number;
  seed?: number;
  force?: boolean;
  /** M9: personal scope to bootstrap (omit = shared docs only). force regenerates only that scope. */
  owner?: string;
}

export interface BootstrapResponse {
  clusters: ClusterBootstrapResult[];
  stats: {
    k: number;
    silhouette: number;
    docs_assigned: number;
  };
}

export interface UpdateClusterRequest {
  slug?: string;
  name?: string;
  description?: string;
}

export interface RouteScore {
  cluster_id: string;
  slug: string;
  name?: string | null;
  centroid_sim: number;
  bm25_hits: number;
}

export interface RouteResponse {
  scores: RouteScore[];
}

export type SourceType = "arxiv" | "rss" | "manual" | "session" | "repo" | "biz";

export interface IngestDoc {
  origin: string;
  source_type: SourceType;
  title?: string;
  text: string;
}

export interface IngestRequest {
  docs: IngestDoc[];
  branch_id?: string;
  // M9: specifies the personal space ("admin" or the requester's own name). Cannot be set together with branch_id (core returns 400).
  owner?: string;
}

export interface IngestedDoc {
  doc_id: string;
  origin: string;
  chunks: number;
  duplicate: boolean;
  replaced: boolean;
  cluster_slug?: string | null;
  fit?: number | null;
}

export interface IngestResponse {
  ingested: IngestedDoc[];
}

// M4: endpoints for cluster lifecycle (birth/merge) + universe assembly. See CONTRACT.md "# M4 확장" section.

export interface BirthProposal {
  doc_ids: string[];
  cohesion: number;
  sample_titles: string[];
}

export interface MergeProposal {
  a_id: string;
  b_id: string;
  a_slug: string;
  b_slug: string;
  centroid_sim: number;
}

export interface LifecycleProposalsResponse {
  births: BirthProposal[];
  merges: MergeProposal[];
}

export interface LifecycleProposalsParams {
  birth_min?: number;
  birth_cohesion?: number;
  merge_sim?: number;
}

export interface BirthClusterRequest {
  doc_ids: string[];
  slug: string;
  name?: string;
  description?: string;
}

export interface MergeClustersRequest {
  src_id: string;
  dst_id: string;
}

/** centroid: base64-encoded f32le vector (core GET /clusters/centroids). */
export interface ClusterCentroid {
  id: string;
  centroid: string;
}

export interface DocSummary {
  doc_id: string;
  origin: string;
  source_type: SourceType;
  title?: string;
  n_chunks: number;
  ingested_at: string;
  cluster_slug?: string | null;
  fit?: number | null;
}

// M7: registry (all entities) + full scan of cluster digests. See CONTRACT.md "# M7 확장" section.
// The global pipeline uses a full scan instead of similarity search to guarantee completeness.

export interface Entity {
  doc_id: string;
  name: string;
  kind: string;
  description?: string;
  status?: string;
  phase?: string;
  next_action?: string;
  blocked_on?: string;
  updated?: string;
  origin: string;
}

export interface ClusterDigest {
  cluster_id: string;
  slug: string;
  name?: string;
  text: string;
  model?: string;
  updated_at: string;
}

export interface PutClusterDigestRequest {
  text: string;
  model?: string;
}

// M8: branch (isolated change set) CRUD + merge/discard. See CONTRACT.md "# M8 확장" section.

export interface BranchSummary {
  id: string;
  name: string;
  status: "open" | "merged" | "discarded";
  created_by?: string;
  created_at: string;
  merged_at?: string;
}

export interface CreateBranchRequest {
  name: string;
  created_by?: string;
}

export interface MergeBranchRequest {
  doc_ids?: string[];
}

export interface MergeBranchResponse {
  merged: number;
  remaining: number;
}

/** M10: graph neighbor doc (includes first-chunk snippet). */
export interface GraphNeighborDoc {
  doc_id: string;
  origin: string;
  title?: string | null;
  snippet: string;
}

export interface GraphLinkItem {
  rel_type: string;
  target_name: string;
  doc?: { doc_id: string; origin: string; title?: string | null } | null;
}

export interface GraphDocResponse {
  doc_id: string;
  outbound: GraphLinkItem[];
  inbound: GraphLinkItem[];
}

/** M10 relation edge: a resolved link pair where both endpoints are visible within scope. */
export interface GraphLinkPair {
  src_doc_id: string;
  dst_doc_id: string;
  rel_type: string;
}

export interface CoreClient {
  health(): Promise<HealthResponse>;
  search(req: SearchRequest): Promise<SearchResponse>;
  // M10: optional methods — ask's graph expansion is silently skipped on a core that doesn't implement them (including test fakes).
  graphNeighbors?(docIds: string[], ownerScope?: string, limit?: number): Promise<GraphNeighborDoc[]>;
  graphDoc?(docId: string, ownerScope?: string): Promise<GraphDocResponse>;
  graphLinks?(ownerScope?: string): Promise<GraphLinkPair[]>;
  listClusters(ownerScope?: string): Promise<ClusterSummary[]>;
  bootstrapClusters(opts?: BootstrapOptions): Promise<BootstrapResponse>;
  updateCluster(clusterId: string, patch: UpdateClusterRequest): Promise<ClusterSummary>;
  route(query: string, ownerScope?: string): Promise<RouteResponse>;
  ingest(req: IngestRequest): Promise<IngestResponse>;
  getLifecycleProposals(params?: LifecycleProposalsParams): Promise<LifecycleProposalsResponse>;
  birthCluster(req: BirthClusterRequest): Promise<ClusterSummary>;
  mergeClusters(req: MergeClustersRequest): Promise<ClusterSummary>;
  getCentroids(): Promise<ClusterCentroid[]>;
  listDocs(ownerScope?: string): Promise<DocSummary[]>;
  listEntities(kind?: string, ownerScope?: string): Promise<Entity[]>;
  listClusterDigests(ownerScope?: string): Promise<ClusterDigest[]>;
  putClusterDigest(clusterId: string, text: string, model?: string): Promise<ClusterDigest>;
  listBranches(status?: string): Promise<BranchSummary[]>;
  getBranchDocs(branchId: string): Promise<DocSummary[]>;
  createBranch(req: CreateBranchRequest): Promise<BranchSummary>;
  mergeBranch(branchId: string, req?: MergeBranchRequest): Promise<MergeBranchResponse>;
  discardBranch(branchId: string): Promise<BranchSummary>;
}

/** Error thrown when a core HTTP request fails. Exposes status so callers can branch on e.g. 409 (duplicate). */
export class CoreHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "CoreHttpError";
  }
}

export const DEFAULT_CORE_BASE_URL = "http://127.0.0.1:8801";

export class CosmosCoreClient implements CoreClient {
  // Base URL can be overridden via env COSMOS_CORE_URL (default DEFAULT_CORE_BASE_URL). Removes hardcoding.
  constructor(private readonly baseUrl: string = process.env.COSMOS_CORE_URL || DEFAULT_CORE_BASE_URL) {}

  async health(): Promise<HealthResponse> {
    return this.getJson<HealthResponse>("/health");
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    return this.postJson<SearchResponse>("/search", req);
  }

  async listClusters(ownerScope?: string): Promise<ClusterSummary[]> {
    const suffix = ownerScope ? `?owner_scope=${encodeURIComponent(ownerScope)}` : "";
    return this.getJson<ClusterSummary[]>(`/clusters${suffix}`);
  }

  async graphNeighbors(docIds: string[], ownerScope?: string, limit?: number): Promise<GraphNeighborDoc[]> {
    return this.postJson<GraphNeighborDoc[]>("/graph/neighbors", {
      doc_ids: docIds,
      ...(ownerScope ? { owner_scope: ownerScope } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  async graphDoc(docId: string, ownerScope?: string): Promise<GraphDocResponse> {
    const suffix = ownerScope ? `?owner_scope=${encodeURIComponent(ownerScope)}` : "";
    return this.getJson<GraphDocResponse>(`/graph/docs/${encodeURIComponent(docId)}${suffix}`);
  }

  async graphLinks(ownerScope?: string): Promise<GraphLinkPair[]> {
    const suffix = ownerScope ? `?owner_scope=${encodeURIComponent(ownerScope)}` : "";
    const res = await this.getJson<{ links: GraphLinkPair[] }>(`/graph/links${suffix}`);
    return res.links;
  }

  async bootstrapClusters(opts: BootstrapOptions = {}): Promise<BootstrapResponse> {
    return this.postJson<BootstrapResponse>("/clusters/bootstrap", opts);
  }

  async updateCluster(clusterId: string, patch: UpdateClusterRequest): Promise<ClusterSummary> {
    return this.patchJson<ClusterSummary>(`/clusters/${encodeURIComponent(clusterId)}`, patch);
  }

  async route(query: string, ownerScope?: string): Promise<RouteResponse> {
    return this.postJson<RouteResponse>("/route", ownerScope ? { query, owner_scope: ownerScope } : { query });
  }

  async ingest(req: IngestRequest): Promise<IngestResponse> {
    return this.postJson<IngestResponse>("/ingest", req);
  }

  async getLifecycleProposals(params: LifecycleProposalsParams = {}): Promise<LifecycleProposalsResponse> {
    const qs = new URLSearchParams();
    if (params.birth_min !== undefined) qs.set("birth_min", String(params.birth_min));
    if (params.birth_cohesion !== undefined) qs.set("birth_cohesion", String(params.birth_cohesion));
    if (params.merge_sim !== undefined) qs.set("merge_sim", String(params.merge_sim));
    const suffix = qs.toString();
    return this.getJson<LifecycleProposalsResponse>(`/lifecycle/proposals${suffix ? `?${suffix}` : ""}`);
  }

  async birthCluster(req: BirthClusterRequest): Promise<ClusterSummary> {
    return this.postJson<ClusterSummary>("/clusters/birth", req);
  }

  async mergeClusters(req: MergeClustersRequest): Promise<ClusterSummary> {
    return this.postJson<ClusterSummary>("/clusters/merge", req);
  }

  async getCentroids(): Promise<ClusterCentroid[]> {
    return this.getJson<ClusterCentroid[]>("/clusters/centroids");
  }

  async listDocs(ownerScope?: string): Promise<DocSummary[]> {
    const suffix = ownerScope ? `?owner_scope=${encodeURIComponent(ownerScope)}` : "";
    return this.getJson<DocSummary[]>(`/docs${suffix}`);
  }

  async listEntities(kind?: string, ownerScope?: string): Promise<Entity[]> {
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    if (ownerScope) qs.set("owner_scope", ownerScope);
    const suffix = qs.toString();
    return this.getJson<Entity[]>(`/entities${suffix ? `?${suffix}` : ""}`);
  }

  async listClusterDigests(ownerScope?: string): Promise<ClusterDigest[]> {
    const suffix = ownerScope ? `?owner_scope=${encodeURIComponent(ownerScope)}` : "";
    return this.getJson<ClusterDigest[]>(`/clusters/digests${suffix}`);
  }

  async putClusterDigest(clusterId: string, text: string, model?: string): Promise<ClusterDigest> {
    const body: PutClusterDigestRequest = { text, ...(model ? { model } : {}) };
    return this.putJson<ClusterDigest>(`/clusters/${encodeURIComponent(clusterId)}/digest`, body);
  }

  async listBranches(status?: string): Promise<BranchSummary[]> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.getJson<BranchSummary[]>(`/branches${suffix}`);
  }

  async getBranchDocs(branchId: string): Promise<DocSummary[]> {
    return this.getJson<DocSummary[]>(`/branches/${encodeURIComponent(branchId)}/docs`);
  }

  async createBranch(req: CreateBranchRequest): Promise<BranchSummary> {
    return this.postJson<BranchSummary>("/branches", req);
  }

  async mergeBranch(branchId: string, req: MergeBranchRequest = {}): Promise<MergeBranchResponse> {
    return this.postJson<MergeBranchResponse>(`/branches/${encodeURIComponent(branchId)}/merge`, req);
  }

  async discardBranch(branchId: string): Promise<BranchSummary> {
    return this.postJson<BranchSummary>(`/branches/${encodeURIComponent(branchId)}/discard`, {});
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return this.parseOrThrow<T>(res, path);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parseOrThrow<T>(res, path);
  }

  private async patchJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parseOrThrow<T>(res, path);
  }

  private async putJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parseOrThrow<T>(res, path);
  }

  private async parseOrThrow<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CoreHttpError(`core ${path} 요청 실패 (status ${res.status}): ${body}`, res.status);
    }
    return (await res.json()) as T;
  }
}
