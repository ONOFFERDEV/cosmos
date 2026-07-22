// cosmos-core(Rust, :8801) HTTP 계약 클라이언트.
// 스키마는 ../contract/openapi.yaml을 그대로 따른다 (mind가 실제로 쓰는 엔드포인트만 포함:
// /health, /search, /clusters, /clusters/bootstrap, /clusters/{id} PATCH, /route).
// CoreClient는 인터페이스로 노출해 테스트에서 mock 주입이 가능하게 한다.

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
  // M9: 소유권 스코프("shared" | "shared+<name>"). mind가 identity로 결정해 채운다.
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
  /** M9: 개인 지식 공간 소유자(null=공통). */
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
  /** M9: 부트스트랩할 개인 스코프(생략=공통 문서만). force는 해당 스코프만 재생성. */
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
  // M9: 개인 공간 지정("admin" 또는 요청자 본인 이름). branch_id와 동시 지정 금지(core 400).
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

// M4: 클러스터 생명주기(탄생/병합) + universe 조립용 엔드포인트. CONTRACT.md "# M4 확장" 절 참고.

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

/** centroid: base64 인코딩된 f32le 벡터 (core GET /clusters/centroids). */
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

// M7: 레지스트리(전체 개체) + 클러스터 다이제스트 전수 조회. CONTRACT.md "# M7 확장" 절 참고.
// global 파이프라인이 완전성 보장을 위해 유사도 검색 대신 전수 스캔에 쓴다.

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

// M8: 브랜치(격리된 변경 묶음) CRUD + 병합/폐기. CONTRACT.md "# M8 확장" 절 참고.

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

export interface CoreClient {
  health(): Promise<HealthResponse>;
  search(req: SearchRequest): Promise<SearchResponse>;
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

/** core HTTP 요청 실패 시 던지는 에러. status로 409(중복) 등을 호출부에서 분기할 수 있게 한다. */
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
  // 베이스 URL은 env COSMOS_CORE_URL로 override 가능(기본값 DEFAULT_CORE_BASE_URL). 하드코딩 제거.
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
