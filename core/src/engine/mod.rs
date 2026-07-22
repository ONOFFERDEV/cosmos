//! Engine facade: ties parse/chunk/embed/bm25/vector/fuse/rerank/store/journal
//! together into `ingest_doc`/`search`/`health`/`list_docs`/`journal`, plus
//! the request/response types matching `contract/openapi.yaml` exactly.
//!
//! `Engine` holds no interior `unsafe impl Send/Sync` — every field
//! (`Store`, `Bm25Index`, `SqliteVectorStore`, `Embedder`, `Reranker`) is
//! independently Send+Sync (via `Arc<Mutex<..>>` / tantivy's native
//! Send+Sync / `Mutex<..>` wrapping), so the compiler derives Send+Sync for
//! `Engine` itself.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::bm25::Bm25Index;
use crate::embed::Embedder;
use crate::rerank::Reranker;
use crate::store::{
    BranchRow, ClusterDigestRow, ClusterFullRow, ClusterRow, DocClusterSnapshot, DocSummaryRow, EntityRow, NewChunk,
    OwnerScope, Store,
};
use crate::vector::{bytes_to_f32_vec, cosine, f32_vec_to_bytes, SqliteVectorStore, VectorStore};
use crate::{
    chunk, cluster, frontmatter, journal, parse, wikilinks, DEFAULT_BIRTH_COHESION, DEFAULT_BIRTH_MIN, DEFAULT_MERGE_SIM,
    RRF_POOL, TOP_M_BM25, TOP_N_VEC,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};

// ---------------------------------------------------------------------
// API types (contract/openapi.yaml)
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Health {
    pub status: String,
    pub version: String,
    pub docs: i64,
    pub chunks: i64,
    pub clusters: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    Arxiv,
    Rss,
    Manual,
    Session,
    Repo,
    Biz,
}

impl SourceType {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceType::Arxiv => "arxiv",
            SourceType::Rss => "rss",
            SourceType::Manual => "manual",
            SourceType::Session => "session",
            SourceType::Repo => "repo",
            SourceType::Biz => "biz",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct IngestDoc {
    pub origin: String,
    pub source_type: SourceType,
    #[serde(default)]
    pub title: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IngestRequest {
    pub docs: Vec<IngestDoc>,
    /// M8: when set, every doc in this batch is tagged into the given branch
    /// (지식 PR) instead of landing on main.
    #[serde(default)]
    pub branch_id: Option<String>,
    /// M9: when set, every doc in this batch is ingested into that member's
    /// personal knowledge space instead of the shared/common space. Mutually
    /// exclusive with `branch_id`.
    #[serde(default)]
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IngestedDoc {
    pub doc_id: String,
    pub origin: String,
    pub chunks: i64,
    pub duplicate: bool,
    pub replaced: bool,
    /// M2: cluster the doc was auto-assigned to at ingest time (null if no
    /// active clusters existed, or the doc was a duplicate).
    pub cluster_slug: Option<String>,
    /// M2: cosine similarity to the assigned cluster's centroid.
    pub fit: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IngestResponse {
    pub ingested: Vec<IngestedDoc>,
}

/// Richer, non-API-facing result of a single `Engine::ingest_doc` call.
/// `anchor_mismatches` is consumed by the CLI's `index` stats aggregate
/// (CONTRACT.md) but is intentionally not part of `IngestedDoc`, since
/// openapi.yaml's `IngestedDoc` schema has no such field.
#[derive(Debug, Clone)]
pub struct IngestOutcome {
    pub doc_id: String,
    pub origin: String,
    pub chunks: i64,
    pub duplicate: bool,
    pub replaced: bool,
    pub anchor_mismatches: usize,
    /// M2: cluster the doc was auto-assigned to at ingest time (see
    /// `IngestedDoc::cluster_slug`).
    pub cluster_slug: Option<String>,
    /// M2: cosine similarity to the assigned cluster's centroid.
    pub fit: Option<f32>,
}

impl From<IngestOutcome> for IngestedDoc {
    fn from(o: IngestOutcome) -> Self {
        IngestedDoc {
            doc_id: o.doc_id,
            origin: o.origin,
            chunks: o.chunks,
            duplicate: o.duplicate,
            replaced: o.replaced,
            cluster_slug: o.cluster_slug,
            fit: o.fit,
        }
    }
}

fn default_k() -> usize {
    crate::FINAL_TOP_K
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default = "default_k")]
    pub k: usize,
    #[serde(default)]
    pub cluster_ids: Vec<String>,
    /// M8: admin preview overlay — un-excludes this branch's docs from the
    /// candidate pool alongside main-scope docs. `None` means main-only.
    #[serde(default)]
    pub include_branch_id: Option<String>,
    /// M9: `"shared"` (default) excludes all personal docs; `"shared+<name>"`
    /// additionally includes that owner's personal docs.
    #[serde(default)]
    pub owner_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchStages {
    pub bm25_rank: Option<usize>,
    pub vec_rank: Option<usize>,
    pub rrf_score: f32,
    pub rerank_score: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub chunk_id: String,
    pub doc_id: String,
    pub origin: String,
    pub title: Option<String>,
    pub text: String,
    pub char_start: i64,
    pub char_end: i64,
    pub section: Option<String>,
    pub score: f32,
    pub stages: SearchStages,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchStats {
    pub num_bm25: usize,
    pub num_vec: usize,
    pub pool: usize,
    pub reranked: usize,
    pub secs: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub stats: SearchStats,
}

#[derive(Debug, Clone, Serialize)]
pub struct DocSummary {
    pub doc_id: String,
    pub origin: String,
    pub source_type: String,
    pub title: Option<String>,
    pub n_chunks: i64,
    pub ingested_at: String,
    /// M3: majority-vote cluster slug over the doc's chunks' `cluster_ids`
    /// (null if the doc has no assigned chunks).
    pub cluster_slug: Option<String>,
    /// M3: `meta_json.fit` (null if absent — normal for bootstrap-assigned
    /// docs, since `/clusters/bootstrap` never writes `meta_json`).
    pub fit: Option<f32>,
    /// M9: owner of this doc's personal knowledge space (null = shared/common).
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub seq: i64,
    pub ts: String,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct JournalResponse {
    pub events: Vec<Event>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterSample {
    pub origin: String,
    pub title: Option<String>,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterSummary {
    pub id: String,
    pub slug: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: String,
    /// M9: owner of this cluster's personal knowledge space (null = shared/common).
    pub owner: Option<String>,
    pub n_docs: i64,
    pub n_chunks: i64,
    pub updated_at: Option<String>,
}

/// M7: frontmatter-derived entity registry row (`GET /entities`).
#[derive(Debug, Clone, Serialize)]
pub struct Entity {
    pub doc_id: String,
    pub name: String,
    pub kind: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub phase: Option<String>,
    pub next_action: Option<String>,
    pub blocked_on: Option<String>,
    pub updated: Option<String>,
    pub origin: String,
}

impl From<EntityRow> for Entity {
    fn from(row: EntityRow) -> Self {
        Entity {
            doc_id: row.doc_id,
            name: row.name,
            kind: row.kind,
            description: row.description,
            status: row.status,
            phase: row.phase,
            next_action: row.next_action,
            blocked_on: row.blocked_on,
            updated: row.updated,
            origin: row.origin,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterBootstrapResult {
    #[serde(flatten)]
    pub summary: ClusterSummary,
    pub sample: Vec<ClusterSample>,
}

/// M9: response for `POST /branches/{branch_id}/docs` (promotion tagging).
#[derive(Debug, Clone, Serialize)]
pub struct TagBranchDocsResponse {
    pub tagged: usize,
    pub branch_id: String,
}

// ---------------------------------------------------------------------
// M10 관계 그래프 API 타입 (contract "관계 그래프 (M10 v1)")
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct GraphDocRef {
    pub doc_id: String,
    pub origin: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphLinkItem {
    pub rel_type: String,
    pub target_name: String,
    /// 해석된 상대 문서(스코프 안일 때만). None = dangling(코퍼스 밖 이름).
    pub doc: Option<GraphDocRef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphDocResponse {
    pub doc_id: String,
    pub outbound: Vec<GraphLinkItem>,
    pub inbound: Vec<GraphLinkItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphNeighborsRequest {
    pub doc_ids: Vec<String>,
    #[serde(default)]
    pub owner_scope: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNeighborDoc {
    pub doc_id: String,
    pub origin: String,
    pub title: Option<String>,
    pub snippet: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct BootstrapRequest {
    pub k_min: usize,
    pub k_max: usize,
    pub seed: u64,
    pub force: bool,
    /// M9: scope to bootstrap — `None` clusters shared docs (`owner IS
    /// NULL`) only; `Some(name)` clusters that owner's personal docs only.
    /// `force` regenerates only this scope's clusters.
    pub owner: Option<String>,
}

impl Default for BootstrapRequest {
    fn default() -> Self {
        Self { k_min: 5, k_max: 14, seed: 42, force: false, owner: None }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BootstrapStats {
    pub k: usize,
    pub silhouette: f64,
    pub docs_assigned: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BootstrapResponse {
    pub clusters: Vec<ClusterBootstrapResult>,
    pub stats: BootstrapStats,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateClusterRequest {
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// M7: active-cluster digest row (`GET /clusters/digests`, `PUT
/// /clusters/{cluster_id}/digest`). Derived data — never journaled.
#[derive(Debug, Clone, Serialize)]
pub struct ClusterDigest {
    pub cluster_id: String,
    pub slug: String,
    pub name: Option<String>,
    pub text: String,
    pub model: Option<String>,
    pub updated_at: String,
}

impl From<ClusterDigestRow> for ClusterDigest {
    fn from(row: ClusterDigestRow) -> Self {
        ClusterDigest {
            cluster_id: row.cluster_id,
            slug: row.slug.unwrap_or_default(),
            name: row.name,
            text: row.text,
            model: row.model,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateClusterDigestRequest {
    pub text: String,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RouteRequest {
    pub query: String,
    /// M9: see `SearchRequest::owner_scope`.
    #[serde(default)]
    pub owner_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteScore {
    pub cluster_id: String,
    pub slug: String,
    pub name: Option<String>,
    pub centroid_sim: f32,
    pub bm25_hits: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteResponse {
    pub scores: Vec<RouteScore>,
}

/// Errors distinguishing 409 (`ClustersExist`) / 404 (`ClusterNotFound`) from
/// generic 500s at the HTTP layer (`serve.rs`).
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("clusters already exist (use force=true to regenerate)")]
    ClustersExist,
    #[error("cluster not found")]
    ClusterNotFound,
    #[error("event not found")]
    EventNotFound,
    #[error("event already rolled back")]
    RollbackConflict,
    #[error("rollback not supported for event kind '{0}'")]
    RollbackUnsupported(String),
    #[error("branch not found")]
    BranchNotFound,
    #[error("branch name already exists")]
    BranchNameConflict,
    #[error("branch is not open")]
    BranchNotOpen,
    #[error("owner and branch_id cannot both be set")]
    OwnerBranchConflict,
    #[error("doc not found: {0}")]
    DocNotFound(String),
    #[error("only personal (owner) docs can be tagged for promotion: {0}")]
    PromoteSharedDoc(String),
    #[error("doc already tagged into a branch: {0}")]
    DocAlreadyInBranch(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

// ---------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------

/// In-memory cluster membership index built from `chunks.cluster_ids`
/// (populated by `/clusters/bootstrap`), used for cluster-scoped search
/// filtering, `/clusters` `n_docs`/`n_chunks` aggregation, and `/route`'s
/// `bm25_hits` count.
struct Membership {
    chunk_clusters: HashMap<String, Vec<String>>,
    cluster_docs: HashMap<String, HashSet<String>>,
    cluster_chunk_counts: HashMap<String, usize>,
}

impl Membership {
    fn chunk_ids_in_clusters(&self, cluster_ids: &[String]) -> HashSet<String> {
        let wanted: HashSet<&str> = cluster_ids.iter().map(|s| s.as_str()).collect();
        self.chunk_clusters
            .iter()
            .filter(|(_, cids)| cids.iter().any(|c| wanted.contains(c.as_str())))
            .map(|(chunk_id, _)| chunk_id.clone())
            .collect()
    }

    fn cluster_counts(&self, cluster_id: &str) -> (i64, i64) {
        let n_docs = self.cluster_docs.get(cluster_id).map(|s| s.len()).unwrap_or(0) as i64;
        let n_chunks = self.cluster_chunk_counts.get(cluster_id).copied().unwrap_or(0) as i64;
        (n_docs, n_chunks)
    }
}

/// Build the `docs.meta_json` payload for an ingest-time cluster assignment.
/// `fit < FIT_THRESHOLD` also sets `low_fit:true`.
fn doc_meta_json_for_fit(fit: f32) -> String {
    if fit < crate::FIT_THRESHOLD {
        serde_json::json!({ "fit": fit, "low_fit": true }).to_string()
    } else {
        serde_json::json!({ "fit": fit }).to_string()
    }
}

/// M3: per-document majority-vote cluster id from all its chunks'
/// `cluster_ids` (each chunk casts one vote per cluster_id it carries).
/// Ties are broken by lexicographically smallest cluster_id, for
/// determinism. Docs with no assigned chunks are absent from the result
/// (→ `cluster_slug: None` downstream).
fn doc_majority_cluster_ids(chunk_cluster_rows: &[(String, String, String)]) -> HashMap<String, String> {
    let mut votes: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for (_chunk_id, doc_id, cluster_ids_json) in chunk_cluster_rows {
        let cluster_ids: Vec<String> = serde_json::from_str(cluster_ids_json).unwrap_or_default();
        let doc_votes = votes.entry(doc_id.clone()).or_default();
        for cid in cluster_ids {
            *doc_votes.entry(cid).or_insert(0) += 1;
        }
    }
    votes
        .into_iter()
        .filter_map(|(doc_id, doc_votes)| {
            let mut candidates: Vec<(String, usize)> = doc_votes.into_iter().collect();
            candidates.sort_by(|a, b| a.0.cmp(&b.0));
            let winner = candidates.into_iter().fold(None::<(String, usize)>, |best, (cid, n)| match &best {
                Some((_, best_n)) if *best_n >= n => best,
                _ => Some((cid, n)),
            });
            winner.map(|(cid, _)| (doc_id, cid))
        })
        .collect()
}

/// M3: parse the `fit` key out of a doc's `meta_json` (see
/// `doc_meta_json_for_fit`). `None` when absent/unparseable — normal for
/// docs with no cluster assignment, or docs assigned via
/// `/clusters/bootstrap` (which records the assignment on
/// `chunks.cluster_ids` but never writes `meta_json.fit`).
fn fit_from_meta_json(meta_json: &str) -> Option<f32> {
    serde_json::from_str::<Value>(meta_json)
        .ok()
        .and_then(|v| v.get("fit").and_then(Value::as_f64))
        .map(|f| f as f32)
}

/// M3: batch-join doc rows with chunk cluster-membership + cluster slugs
/// into `DocSummary`s without per-document queries. `doc_majority_cluster_ids`
/// and the id->slug map are each built once from a single full-table scan,
/// so this stays at 3 total queries (`list_docs`, `all_chunk_cluster_rows`,
/// `list_cluster_rows`) regardless of document count.
fn build_doc_summaries(
    rows: Vec<DocSummaryRow>,
    chunk_cluster_rows: &[(String, String, String)],
    cluster_rows: &[ClusterRow],
) -> Vec<DocSummary> {
    let doc_cluster_ids = doc_majority_cluster_ids(chunk_cluster_rows);
    let cluster_slugs: HashMap<&str, &str> = cluster_rows
        .iter()
        .filter_map(|c| c.slug.as_deref().map(|slug| (c.id.as_str(), slug)))
        .collect();

    rows.into_iter()
        .map(|r| {
            let cluster_slug = doc_cluster_ids
                .get(&r.doc_id)
                .and_then(|cid| cluster_slugs.get(cid.as_str()))
                .map(|slug| slug.to_string());
            let fit = fit_from_meta_json(&r.meta_json);
            DocSummary {
                doc_id: r.doc_id,
                origin: r.origin,
                source_type: r.source_type,
                title: r.title,
                n_chunks: r.n_chunks,
                ingested_at: r.ingested_at,
                cluster_slug,
                fit,
                owner: r.owner,
            }
        })
        .collect()
}

/// M4: a single misfit document surfaced by `GET /misfits` — a doc whose
/// `meta_json.low_fit == true`.
#[derive(Debug, Clone, Serialize)]
pub struct MisfitDoc {
    pub doc_id: String,
    pub origin: String,
    pub title: Option<String>,
    pub fit: Option<f32>,
    pub cluster_slug: Option<String>,
}

/// M4: parse `meta_json.low_fit` (see `doc_meta_json_for_fit`). `false` when
/// absent/unparseable.
fn is_low_fit(meta_json: &str) -> bool {
    serde_json::from_str::<Value>(meta_json)
        .ok()
        .and_then(|v| v.get("low_fit").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// M4: batch-join doc rows into `MisfitDoc`s, filtered to
/// `meta_json.low_fit == true`, reusing the same single-scan doc/cluster
/// membership joins as `build_doc_summaries`.
fn build_misfits(
    rows: &[DocSummaryRow],
    chunk_cluster_rows: &[(String, String, String)],
    cluster_rows: &[ClusterRow],
) -> Vec<MisfitDoc> {
    let doc_cluster_ids = doc_majority_cluster_ids(chunk_cluster_rows);
    let cluster_slugs: HashMap<&str, &str> = cluster_rows
        .iter()
        .filter_map(|c| c.slug.as_deref().map(|slug| (c.id.as_str(), slug)))
        .collect();

    rows.iter()
        .filter(|r| is_low_fit(&r.meta_json))
        .map(|r| {
            let cluster_slug = doc_cluster_ids
                .get(&r.doc_id)
                .and_then(|cid| cluster_slugs.get(cid.as_str()))
                .map(|slug| slug.to_string());
            MisfitDoc {
                doc_id: r.doc_id.clone(),
                origin: r.origin.clone(),
                title: r.title.clone(),
                fit: fit_from_meta_json(&r.meta_json),
                cluster_slug,
            }
        })
        .collect()
}

/// M4: compute one mean-normalized vector per document from its chunks'
/// stored embeddings. Each chunk embedding is L2-normalized individually
/// before averaging, and the resulting per-doc mean is re-normalized, so the
/// result is comparable via plain dot-product cosine.
fn doc_vectors_from_chunk_embeddings(chunk_embeddings: &[(String, Vec<u8>)]) -> HashMap<String, Vec<f32>> {
    let mut sums: HashMap<String, Vec<f32>> = HashMap::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for (doc_id, bytes) in chunk_embeddings {
        let v = cluster::l2_normalize(&bytes_to_f32_vec(bytes));
        let entry = sums.entry(doc_id.clone()).or_insert_with(|| vec![0.0f32; v.len()]);
        for (i, x) in v.iter().enumerate() {
            entry[i] += x;
        }
        *counts.entry(doc_id.clone()).or_insert(0) += 1;
    }
    sums.into_iter()
        .map(|(doc_id, sum)| {
            let n = counts.get(&doc_id).copied().unwrap_or(1).max(1) as f32;
            let mean: Vec<f32> = sum.iter().map(|x| x / n).collect();
            (doc_id, cluster::l2_normalize(&mean))
        })
        .collect()
}

fn default_birth_min() -> usize {
    DEFAULT_BIRTH_MIN
}
fn default_birth_cohesion() -> f32 {
    DEFAULT_BIRTH_COHESION
}
fn default_merge_sim() -> f32 {
    DEFAULT_MERGE_SIM
}

/// M4: `GET /lifecycle/proposals` query parameters (all optional, defaulting
/// per CONTRACT.md / team-lead spec).
#[derive(Debug, Clone, Deserialize)]
pub struct LifecycleProposalsQuery {
    #[serde(default = "default_birth_min")]
    pub birth_min: usize,
    #[serde(default = "default_birth_cohesion")]
    pub birth_cohesion: f32,
    #[serde(default = "default_merge_sim")]
    pub merge_sim: f32,
}

impl Default for LifecycleProposalsQuery {
    fn default() -> Self {
        LifecycleProposalsQuery {
            birth_min: DEFAULT_BIRTH_MIN,
            birth_cohesion: DEFAULT_BIRTH_COHESION,
            merge_sim: DEFAULT_MERGE_SIM,
        }
    }
}

/// M4: a proposed new cluster — a group of misfit documents whose mean
/// pairwise cosine similarity clears `birth_cohesion` and whose size clears
/// `birth_min`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BirthProposal {
    pub doc_ids: Vec<String>,
    pub cohesion: f32,
    pub sample_titles: Vec<String>,
}

/// M4: a proposed merge of two active clusters whose centroid cosine
/// similarity clears `merge_sim`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MergeProposal {
    pub a_id: String,
    pub b_id: String,
    pub a_slug: Option<String>,
    pub b_slug: Option<String>,
    pub centroid_sim: f32,
}

/// M4: `GET /lifecycle/proposals` response.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct LifecycleProposalsResponse {
    pub births: Vec<BirthProposal>,
    pub merges: Vec<MergeProposal>,
}

/// M4: minimal union-find (disjoint-set) used as a candidate-grouping
/// heuristic for `birth_proposals`. `union` always attaches the
/// larger-indexed root under the smaller-indexed root so the resulting
/// grouping is deterministic regardless of iteration order.
struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        UnionFind { parent: (0..n).collect() }
    }

    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            self.parent[x] = self.find(self.parent[x]);
        }
        self.parent[x]
    }

    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra == rb {
            return;
        }
        let (lo, hi) = if ra < rb { (ra, rb) } else { (rb, ra) };
        self.parent[hi] = lo;
    }
}

/// M4: group misfit documents into birth candidates. Any mutually-reciprocal
/// pair (`cosine(a, b) >= birth_cohesion`) is unioned as a candidate edge;
/// each resulting connected component is then re-checked against the exact
/// acceptance bar (`size >= birth_min` AND mean intra-group pairwise cosine
/// `>= birth_cohesion`) since transitive union membership does not by itself
/// guarantee every pair — or the group mean — clears the bar. Output is
/// sorted by cohesion descending, tie-broken by the group's joined sorted
/// `doc_ids` ascending, for determinism.
fn birth_proposals(
    doc_vectors: &HashMap<String, Vec<f32>>,
    titles: &HashMap<String, String>,
    birth_min: usize,
    birth_cohesion: f32,
) -> Vec<BirthProposal> {
    let mut ids: Vec<&String> = doc_vectors.keys().collect();
    ids.sort();
    let n = ids.len();
    if n == 0 {
        return Vec::new();
    }

    let mut uf = UnionFind::new(n);
    for i in 0..n {
        for j in (i + 1)..n {
            let sim = cosine(&doc_vectors[ids[i]], &doc_vectors[ids[j]]);
            if sim >= birth_cohesion {
                uf.union(i, j);
            }
        }
    }

    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let root = uf.find(i);
        groups.entry(root).or_default().push(i);
    }

    let mut proposals: Vec<BirthProposal> = groups
        .into_values()
        .filter(|members| members.len() >= birth_min)
        .filter_map(|members| {
            let mut pair_sum = 0f32;
            let mut pair_count = 0usize;
            for a in 0..members.len() {
                for b in (a + 1)..members.len() {
                    pair_sum += cosine(&doc_vectors[ids[members[a]]], &doc_vectors[ids[members[b]]]);
                    pair_count += 1;
                }
            }
            let cohesion = if pair_count > 0 { pair_sum / pair_count as f32 } else { 0.0 };
            if cohesion < birth_cohesion {
                return None;
            }
            let mut doc_ids: Vec<String> = members.iter().map(|&i| ids[i].clone()).collect();
            doc_ids.sort();
            let sample_titles: Vec<String> = doc_ids
                .iter()
                .take(5)
                .map(|id| titles.get(id).cloned().unwrap_or_else(|| id.clone()))
                .collect();
            Some(BirthProposal { doc_ids, cohesion, sample_titles })
        })
        .collect();

    proposals.sort_by(|a, b| {
        b.cohesion
            .partial_cmp(&a.cohesion)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.doc_ids.join(",").cmp(&b.doc_ids.join(",")))
    });
    proposals
}

/// M4: propose merges for all active-cluster pairs whose centroid cosine
/// similarity clears `merge_sim`. Pairs are ordered `(a, b)` with `a.id <=
/// b.id`; output sorted by `centroid_sim` descending, tie-broken by
/// `(a_id, b_id)` ascending, for determinism.
fn merge_proposals(active_clusters: &[ClusterRow], merge_sim: f32) -> Vec<MergeProposal> {
    let mut rows: Vec<&ClusterRow> = active_clusters.iter().filter(|c| c.centroid.is_some()).collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));

    let mut proposals = Vec::new();
    for i in 0..rows.len() {
        for j in (i + 1)..rows.len() {
            let a = rows[i];
            let b = rows[j];
            let (Some(ac), Some(bc)) = (&a.centroid, &b.centroid) else { continue };
            let sim = cosine(&bytes_to_f32_vec(ac), &bytes_to_f32_vec(bc));
            if sim >= merge_sim {
                proposals.push(MergeProposal {
                    a_id: a.id.clone(),
                    b_id: b.id.clone(),
                    a_slug: a.slug.clone(),
                    b_slug: b.slug.clone(),
                    centroid_sim: sim,
                });
            }
        }
    }

    proposals.sort_by(|a, b| {
        b.centroid_sim
            .partial_cmp(&a.centroid_sim)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| (a.a_id.as_str(), a.b_id.as_str()).cmp(&(b.a_id.as_str(), b.b_id.as_str())))
    });
    proposals
}

/// M4: `POST /clusters/birth` request body.
#[derive(Debug, Clone, Deserialize)]
pub struct BirthClusterRequest {
    pub doc_ids: Vec<String>,
    pub slug: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// M4: `POST /clusters/merge` request body.
#[derive(Debug, Clone, Deserialize)]
pub struct MergeClustersRequest {
    pub src_id: String,
    pub dst_id: String,
}

/// M4: `GET /clusters/centroids` entry — base64-encoded little-endian f32
/// centroid vector.
#[derive(Debug, Clone, Serialize)]
pub struct CentroidEntry {
    pub id: String,
    pub centroid: String,
}

/// M4: `POST /rollback` request body.
#[derive(Debug, Clone, Deserialize)]
pub struct RollbackRequest {
    pub seq: i64,
}

/// M4: `POST /rollback` response.
#[derive(Debug, Clone, Serialize)]
pub struct RollbackResponse {
    pub target_seq: i64,
    pub kind: String,
    pub rollback_seq: i64,
}

/// M8: `POST /branches` request body.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateBranchRequest {
    pub name: String,
    #[serde(default)]
    pub created_by: Option<String>,
}

/// M8: a branch (지식 PR) — see `contract/openapi.yaml`'s `Branch` schema.
#[derive(Debug, Clone, Serialize)]
pub struct Branch {
    pub id: String,
    pub name: String,
    pub status: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub merged_at: Option<String>,
    pub n_docs: i64,
}

impl From<BranchRow> for Branch {
    fn from(r: BranchRow) -> Self {
        Branch {
            id: r.id,
            name: r.name,
            status: r.status,
            created_by: r.created_by,
            created_at: r.created_at,
            merged_at: r.merged_at,
            n_docs: r.n_docs,
        }
    }
}

/// M8: `POST /branches/{branch_id}/merge` request body — optional; omitted
/// or `null` `doc_ids` merges every doc currently tagged into the branch,
/// otherwise cherry-picks the given ids (intersected with actual branch
/// membership).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MergeBranchRequest {
    #[serde(default)]
    pub doc_ids: Option<Vec<String>>,
}

/// M8: `POST /branches/{branch_id}/merge` response.
#[derive(Debug, Clone, Serialize)]
pub struct MergeBranchResponse {
    pub merged: i64,
    pub remaining: i64,
}

/// M4: parse the `docs` array of a `cluster_birth`/`cluster_merge` inverse
/// payload back into `DocClusterSnapshot`s.
fn parse_doc_snapshots(docs_value: &Value) -> Result<Vec<DocClusterSnapshot>> {
    let arr = docs_value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("inverse `docs`/`moved` field is not an array"))?;
    arr.iter()
        .map(|d| {
            let doc_id = d
                .get("doc_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("doc snapshot missing `doc_id`"))?
                .to_string();
            let prev_cluster_ids = d.get("prev_cluster_ids").cloned().unwrap_or(Value::Array(Vec::new()));
            let prev_meta_json = d
                .get("prev_meta_json")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("doc snapshot missing `prev_meta_json`"))?
                .to_string();
            Ok(DocClusterSnapshot {
                doc_id,
                prev_cluster_ids_json: prev_cluster_ids.to_string(),
                prev_meta_json,
            })
        })
        .collect()
}

/// M4: parse a `cluster_merge` inverse's `src_row` field back into a
/// `ClusterFullRow`, decoding its base64 `centroid_b64` (if present) into
/// the row's own `centroid: Option<Vec<u8>>` field.
fn parse_cluster_full_row(v: &Value) -> Result<ClusterFullRow> {
    let get_str = |k: &str| -> Option<String> { v.get(k).and_then(Value::as_str).map(|s| s.to_string()) };
    let id = get_str("id").ok_or_else(|| anyhow::anyhow!("src_row missing `id`"))?;
    let status = get_str("status").ok_or_else(|| anyhow::anyhow!("src_row missing `status`"))?;
    let stats_json = get_str("stats_json").unwrap_or_else(|| "{}".to_string());
    let centroid = match get_str("centroid_b64") {
        Some(b64) => Some(STANDARD.decode(b64.as_bytes()).context("decoding src_row centroid_b64")?),
        None => None,
    };
    Ok(ClusterFullRow {
        id,
        slug: get_str("slug"),
        name: get_str("name"),
        description: get_str("description"),
        status,
        sensitivity: get_str("sensitivity"),
        created_by: get_str("created_by"),
        stats_json,
        centroid,
        updated_at: get_str("updated_at"),
    })
}

/// M4: has `target_seq` already been rolled back? Scans journal events for a
/// prior `kind=="rollback"` whose `payload.target_seq == target_seq`.
/// Extracted as a free function so it is directly unit-testable without an
/// `Engine`/`Store`.
fn find_rollback_conflict(events: &[journal::JournalEvent], target_seq: i64) -> bool {
    events
        .iter()
        .any(|e| e.kind == "rollback" && e.payload.get("target_seq").and_then(Value::as_i64) == Some(target_seq))
}

/// M4: build a `doc_id -> cluster_ids_json` map from `all_chunk_cluster_rows`,
/// used to snapshot a doc's pre-mutation `chunks.cluster_ids` for birth/merge
/// inverse payloads. Every chunk of a given doc carries the same `cluster_ids`
/// array (the bootstrap/birth/merge invariant); last-write-wins if not.
fn cluster_ids_json_by_doc(chunk_cluster_rows: &[(String, String, String)]) -> HashMap<String, String> {
    chunk_cluster_rows
        .iter()
        .map(|(_, doc_id, cluster_ids_json)| (doc_id.clone(), cluster_ids_json.clone()))
        .collect()
}

/// M4: mean of the given doc vectors, L2-normalized — used to (re)compute a
/// cluster centroid from its member docs' vectors for `cluster_birth`/
/// `cluster_merge`.
fn mean_centroid(vectors: &[&Vec<f32>]) -> Vec<f32> {
    if vectors.is_empty() {
        return Vec::new();
    }
    let dim = vectors[0].len();
    let mut sum = vec![0.0f32; dim];
    for v in vectors {
        for (i, x) in v.iter().enumerate() {
            sum[i] += x;
        }
    }
    let n = vectors.len() as f32;
    let mean: Vec<f32> = sum.iter().map(|x| x / n).collect();
    cluster::l2_normalize(&mean)
}

pub struct Engine {
    store: Store,
    bm25: Bm25Index,
    vector: SqliteVectorStore,
    embedder: Embedder,
    reranker: Reranker,
}

impl Engine {
    /// Open/create the store + bm25 index at `out_dir`, and load embed/rerank
    /// models from `models_dir` (downloaded on first run if not cached).
    pub fn new(out_dir: &Path, models_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(out_dir).with_context(|| format!("creating out dir {}", out_dir.display()))?;

        let db_path = out_dir.join("cosmos.sqlite3");
        let store = Store::open(&db_path)?;
        let vector = SqliteVectorStore::new(store.conn_handle());

        let bm25_dir = out_dir.join("tantivy");
        let bm25 = Bm25Index::open_or_create(&bm25_dir)?;

        let embedder = Embedder::new(models_dir)?;
        let reranker = Reranker::new(models_dir)?;

        Ok(Self { store, bm25, vector, embedder, reranker })
    }

    /// Build the in-memory chunk/doc -> cluster membership index from
    /// `chunks.cluster_ids` (see `Membership`).
    fn build_membership(&self) -> Result<Membership> {
        let rows = self.store.all_chunk_cluster_rows()?;
        let mut chunk_clusters = HashMap::new();
        let mut cluster_docs: HashMap<String, HashSet<String>> = HashMap::new();
        let mut cluster_chunk_counts: HashMap<String, usize> = HashMap::new();
        for (chunk_id, doc_id, cluster_ids_json) in rows {
            let cluster_ids: Vec<String> = serde_json::from_str(&cluster_ids_json).unwrap_or_default();
            for cid in &cluster_ids {
                cluster_docs.entry(cid.clone()).or_default().insert(doc_id.clone());
                *cluster_chunk_counts.entry(cid.clone()).or_insert(0) += 1;
            }
            chunk_clusters.insert(chunk_id, cluster_ids);
        }
        Ok(Membership { chunk_clusters, cluster_docs, cluster_chunk_counts })
    }
}

// ---------------------------------------------------------------------
// 관심사별 impl 분할 — 파일명이 곧 지도다. 타입·공유 헬퍼·Engine 구조체는
// 이 파일(mod.rs)에 있고, 각 자식 모듈은 use super::*로 접근한다.
// ---------------------------------------------------------------------
mod branches; // 지식 PR: 브랜치·승격·병합·폐기
mod clusters; // bootstrap·birth·merge·메타 갱신
mod graph; // M10 관계 그래프 조회
mod ingest; // 데이터 유입
mod lifecycle; // 탄생/병합 후보 판정
mod listing; // 읽기 목록 API
mod rollback; // 저널 inverse 적용
mod search; // 하이브리드 검색·라우팅·misfits

#[cfg(test)]
mod tests;
