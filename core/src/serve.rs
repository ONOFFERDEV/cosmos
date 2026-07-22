//! HTTP API (axum) covering `/health`, `/ingest`, `/search`, `/docs`,
//! `/journal` exactly per `contract/openapi.yaml`. `Engine` is loaded once
//! at startup and shared as `Arc<Engine>` state.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde::Deserialize;

use crate::engine::{
    BirthClusterRequest, BootstrapRequest, BootstrapResponse, Branch, CentroidEntry, ClusterDigest, ClusterSummary,
    CreateBranchRequest, DocSummary, Engine, EngineError, Entity, Health, IngestRequest, IngestResponse, IngestedDoc,
    JournalResponse, LifecycleProposalsQuery, LifecycleProposalsResponse, MergeBranchRequest, MergeBranchResponse,
    GraphDocResponse, GraphLinksResponse, GraphNeighborDoc, GraphNeighborsRequest, MergeClustersRequest, MisfitDoc,
    RollbackRequest,
    RollbackResponse, RouteRequest, RouteResponse, SearchRequest, SearchResponse, TagBranchDocsResponse,
    UpdateClusterDigestRequest, UpdateClusterRequest,
};

/// Wraps a status code + `anyhow::Error` for ergonomic `?`-based error
/// handling in handlers; renders as a JSON body with that status code.
/// Plain `?` (via the blanket `From<E>` below) always yields 500; handlers
/// returning `EngineError` map 409/404 explicitly via `engine_error_to_app_error`.
struct AppError(StatusCode, anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = Json(serde_json::json!({ "error": self.1.to_string() }));
        (self.0, body).into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        AppError(StatusCode::INTERNAL_SERVER_ERROR, err.into())
    }
}

/// Maps `EngineError` to the correct HTTP status: 409 for `ClustersExist`,
/// 404 for `ClusterNotFound`, 500 for everything else.
fn engine_error_to_app_error(err: EngineError) -> AppError {
    let msg = err.to_string();
    match err {
        EngineError::ClustersExist => AppError(StatusCode::CONFLICT, anyhow::anyhow!(msg)),
        EngineError::ClusterNotFound => AppError(StatusCode::NOT_FOUND, anyhow::anyhow!(msg)),
        EngineError::EventNotFound => AppError(StatusCode::NOT_FOUND, anyhow::anyhow!(msg)),
        EngineError::RollbackConflict => AppError(StatusCode::CONFLICT, anyhow::anyhow!(msg)),
        EngineError::RollbackUnsupported(_) => AppError(StatusCode::BAD_REQUEST, anyhow::anyhow!(msg)),
        EngineError::BranchNotFound => AppError(StatusCode::NOT_FOUND, anyhow::anyhow!(msg)),
        EngineError::BranchNameConflict => AppError(StatusCode::CONFLICT, anyhow::anyhow!(msg)),
        EngineError::BranchNotOpen => AppError(StatusCode::CONFLICT, anyhow::anyhow!(msg)),
        EngineError::OwnerBranchConflict => AppError(StatusCode::BAD_REQUEST, anyhow::anyhow!(msg)),
        EngineError::DocNotFound(_) => AppError(StatusCode::NOT_FOUND, anyhow::anyhow!(msg)),
        EngineError::PromoteSharedDoc(_) => AppError(StatusCode::BAD_REQUEST, anyhow::anyhow!(msg)),
        EngineError::DocAlreadyInBranch(_) => AppError(StatusCode::BAD_REQUEST, anyhow::anyhow!(msg)),
        EngineError::Other(e) => AppError(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn health_handler(State(engine): State<Arc<Engine>>) -> Result<Json<Health>, AppError> {
    Ok(Json(engine.health()?))
}

async fn ingest_handler(
    State(engine): State<Arc<Engine>>,
    Json(req): Json<IngestRequest>,
) -> Result<Json<IngestResponse>, AppError> {
    let mut ingested = Vec::with_capacity(req.docs.len());
    let branch_id = req.branch_id.as_deref();
    let owner = req.owner.as_deref();
    for doc in req.docs {
        let outcome =
            engine.ingest_doc(&doc.origin, doc.source_type.as_str(), doc.title.as_deref(), &doc.text, branch_id, owner)?;
        ingested.push(IngestedDoc::from(outcome));
    }
    Ok(Json(IngestResponse { ingested }))
}

async fn search_handler(
    State(engine): State<Arc<Engine>>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<SearchResponse>, AppError> {
    Ok(Json(engine.search(
        &req.query,
        req.k,
        &req.cluster_ids,
        req.include_branch_id.as_deref(),
        req.owner_scope.as_deref(),
    )?))
}

/// M9: shared query params for GET listing endpoints — `?owner_scope=`.
#[derive(Debug, Deserialize)]
struct OwnerScopeQuery {
    owner_scope: Option<String>,
}

async fn docs_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<OwnerScopeQuery>,
) -> Result<Json<Vec<DocSummary>>, AppError> {
    Ok(Json(engine.list_docs(q.owner_scope.as_deref())?))
}

async fn list_clusters_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<OwnerScopeQuery>,
) -> Result<Json<Vec<ClusterSummary>>, AppError> {
    Ok(Json(engine.list_clusters(q.owner_scope.as_deref())?))
}

/// `POST /clusters/bootstrap`: request body is optional (`{}` if omitted),
/// so this takes raw `Bytes` rather than `Json<BootstrapRequest>` — an empty
/// body is not valid JSON and would otherwise be rejected by axum's `Json`
/// extractor before the handler runs.
async fn bootstrap_clusters_handler(
    State(engine): State<Arc<Engine>>,
    body: Bytes,
) -> Result<Json<BootstrapResponse>, AppError> {
    let req: BootstrapRequest = if body.is_empty() {
        BootstrapRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|e| AppError(StatusCode::BAD_REQUEST, e.into()))?
    };
    engine.bootstrap_clusters(&req).map(Json).map_err(engine_error_to_app_error)
}

async fn update_cluster_handler(
    State(engine): State<Arc<Engine>>,
    Path(cluster_id): Path<String>,
    Json(req): Json<UpdateClusterRequest>,
) -> Result<Json<ClusterSummary>, AppError> {
    engine.update_cluster(&cluster_id, &req).map(Json).map_err(engine_error_to_app_error)
}

async fn route_handler(
    State(engine): State<Arc<Engine>>,
    Json(req): Json<RouteRequest>,
) -> Result<Json<RouteResponse>, AppError> {
    engine.route(&req.query, req.owner_scope.as_deref()).map(Json).map_err(engine_error_to_app_error)
}

#[derive(Debug, Deserialize)]
struct JournalQuery {
    #[serde(default)]
    after_seq: i64,
}

async fn journal_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<JournalQuery>,
) -> Result<Json<JournalResponse>, AppError> {
    Ok(Json(engine.journal(q.after_seq)?))
}

async fn misfits_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<OwnerScopeQuery>,
) -> Result<Json<Vec<MisfitDoc>>, AppError> {
    Ok(Json(engine.misfits(q.owner_scope.as_deref())?))
}

async fn lifecycle_proposals_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<LifecycleProposalsQuery>,
) -> Result<Json<LifecycleProposalsResponse>, AppError> {
    Ok(Json(engine.lifecycle_proposals(&q)?))
}

async fn cluster_centroids_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<OwnerScopeQuery>,
) -> Result<Json<Vec<CentroidEntry>>, AppError> {
    Ok(Json(engine.cluster_centroids(q.owner_scope.as_deref())?))
}

async fn cluster_birth_handler(
    State(engine): State<Arc<Engine>>,
    Json(req): Json<BirthClusterRequest>,
) -> Result<Json<ClusterSummary>, AppError> {
    engine.cluster_birth(&req).map(Json).map_err(engine_error_to_app_error)
}

async fn cluster_merge_handler(
    State(engine): State<Arc<Engine>>,
    Json(req): Json<MergeClustersRequest>,
) -> Result<Json<ClusterSummary>, AppError> {
    engine.cluster_merge(&req).map(Json).map_err(engine_error_to_app_error)
}

async fn rollback_handler(
    State(engine): State<Arc<Engine>>,
    Json(req): Json<RollbackRequest>,
) -> Result<Json<RollbackResponse>, AppError> {
    engine.rollback(&req).map(Json).map_err(engine_error_to_app_error)
}

#[derive(Debug, Deserialize)]
struct EntitiesQuery {
    kind: Option<String>,
    owner_scope: Option<String>,
}

/// M7: `GET /entities?kind=`.
async fn entities_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<EntitiesQuery>,
) -> Result<Json<Vec<Entity>>, AppError> {
    Ok(Json(engine.list_entities(q.kind.as_deref(), q.owner_scope.as_deref())?))
}

/// M7: `GET /clusters/digests` — active clusters only.
async fn cluster_digests_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<OwnerScopeQuery>,
) -> Result<Json<Vec<ClusterDigest>>, AppError> {
    Ok(Json(engine.list_cluster_digests(q.owner_scope.as_deref())?))
}

/// M7: `PUT /clusters/{cluster_id}/digest`.
async fn update_cluster_digest_handler(
    State(engine): State<Arc<Engine>>,
    Path(cluster_id): Path<String>,
    Json(req): Json<UpdateClusterDigestRequest>,
) -> Result<Json<ClusterDigest>, AppError> {
    engine.update_cluster_digest(&cluster_id, &req).map(Json).map_err(engine_error_to_app_error)
}

/// M8: `POST /branches` — 201 on success, 409 via `engine_error_to_app_error`
/// on duplicate name.
async fn create_branch_handler(
    State(engine): State<Arc<Engine>>,
    Json(req): Json<CreateBranchRequest>,
) -> Result<(StatusCode, Json<Branch>), AppError> {
    let branch = engine.create_branch(&req).map_err(engine_error_to_app_error)?;
    Ok((StatusCode::CREATED, Json(branch)))
}

#[derive(Debug, Deserialize)]
struct ListBranchesQuery {
    status: Option<String>,
}

/// M8: `GET /branches?status=`.
async fn list_branches_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<ListBranchesQuery>,
) -> Result<Json<Vec<Branch>>, AppError> {
    Ok(Json(engine.list_branches(q.status.as_deref())?))
}

/// M8: `GET /branches/{branch_id}/docs` — 404 via `engine_error_to_app_error`
/// if the branch doesn't exist.
async fn branch_docs_handler(
    State(engine): State<Arc<Engine>>,
    Path(branch_id): Path<String>,
) -> Result<Json<Vec<DocSummary>>, AppError> {
    engine.branch_docs(&branch_id).map(Json).map_err(engine_error_to_app_error)
}

/// M10: `GET /graph/docs/{doc_id}?owner_scope=` — 문서의 in/out 관계(스코프 격리).
async fn graph_doc_handler(
    State(engine): State<Arc<Engine>>,
    Path(doc_id): Path<String>,
    Query(q): Query<OwnerScopeQuery>,
) -> Result<Json<GraphDocResponse>, AppError> {
    engine.graph_doc(&doc_id, q.owner_scope.as_deref()).map(Json).map_err(engine_error_to_app_error)
}

/// M10: `GET /graph/links?owner_scope=` — 스코프 안 해석 링크 쌍 전량(관계선 시각화용).
async fn graph_links_handler(
    State(engine): State<Arc<Engine>>,
    Query(q): Query<OwnerScopeQuery>,
) -> Result<Json<GraphLinksResponse>, AppError> {
    Ok(Json(engine.graph_links(q.owner_scope.as_deref())?))
}

/// M10: `POST /graph/neighbors` — 1-hop 이웃(mind fast 그래프 확장용).
async fn graph_neighbors_handler(
    State(engine): State<Arc<Engine>>,
    Json(req): Json<GraphNeighborsRequest>,
) -> Result<Json<Vec<GraphNeighborDoc>>, AppError> {
    Ok(Json(engine.graph_neighbors(&req)?))
}

/// M9: `POST /branches/{branch_id}/docs` — tag personal docs into an open
/// branch for promotion review. 400 for shared/already-tagged docs, 404 for
/// missing docs/branch, 409 for a non-open branch.
#[derive(Debug, Deserialize)]
struct TagBranchDocsRequest {
    doc_ids: Vec<String>,
}

async fn tag_branch_docs_handler(
    State(engine): State<Arc<Engine>>,
    Path(branch_id): Path<String>,
    Json(req): Json<TagBranchDocsRequest>,
) -> Result<Json<TagBranchDocsResponse>, AppError> {
    engine.tag_branch_docs(&branch_id, &req.doc_ids).map(Json).map_err(engine_error_to_app_error)
}

/// M8: `POST /branches/{branch_id}/merge` — request body is optional
/// (omitted/`{}` means "merge all"), so this takes raw `Bytes` rather than
/// `Json<MergeBranchRequest>` for the same reason as `bootstrap_clusters_handler`.
async fn merge_branch_handler(
    State(engine): State<Arc<Engine>>,
    Path(branch_id): Path<String>,
    body: Bytes,
) -> Result<Json<MergeBranchResponse>, AppError> {
    let req: MergeBranchRequest = if body.is_empty() {
        MergeBranchRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|e| AppError(StatusCode::BAD_REQUEST, e.into()))?
    };
    engine.merge_branch(&branch_id, &req).map(Json).map_err(engine_error_to_app_error)
}

/// M8: `POST /branches/{branch_id}/discard` — no body.
async fn discard_branch_handler(
    State(engine): State<Arc<Engine>>,
    Path(branch_id): Path<String>,
) -> Result<StatusCode, AppError> {
    engine.discard_branch(&branch_id).map_err(engine_error_to_app_error)?;
    Ok(StatusCode::OK)
}

fn build_router(engine: Arc<Engine>) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/ingest", post(ingest_handler))
        .route("/search", post(search_handler))
        .route("/docs", get(docs_handler))
        .route("/journal", get(journal_handler))
        .route("/clusters", get(list_clusters_handler))
        .route("/clusters/bootstrap", post(bootstrap_clusters_handler))
        .route("/clusters/{cluster_id}", patch(update_cluster_handler))
        .route("/route", post(route_handler))
        .route("/misfits", get(misfits_handler))
        .route("/lifecycle/proposals", get(lifecycle_proposals_handler))
        .route("/clusters/centroids", get(cluster_centroids_handler))
        .route("/clusters/birth", post(cluster_birth_handler))
        .route("/clusters/merge", post(cluster_merge_handler))
        .route("/clusters/digests", get(cluster_digests_handler))
        .route("/clusters/{cluster_id}/digest", put(update_cluster_digest_handler))
        .route("/entities", get(entities_handler))
        .route("/graph/docs/{doc_id}", get(graph_doc_handler))
        .route("/graph/links", get(graph_links_handler))
        .route("/graph/neighbors", post(graph_neighbors_handler))
        .route("/rollback", post(rollback_handler))
        .route("/branches", get(list_branches_handler).post(create_branch_handler))
        .route("/branches/{branch_id}/docs", get(branch_docs_handler).post(tag_branch_docs_handler))
        .route("/branches/{branch_id}/merge", post(merge_branch_handler))
        .route("/branches/{branch_id}/discard", post(discard_branch_handler))
        .with_state(engine)
}

/// Load models + open store/bm25 once, then serve on `port` until the
/// process is stopped.
pub async fn run(out_dir: PathBuf, models_dir: PathBuf, port: u16) -> Result<()> {
    let engine = Engine::new(&out_dir, &models_dir).context("initializing engine")?;
    let app = build_router(Arc::new(engine));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.context("binding listener")?;
    tracing::info!("cosmos-core serve listening on {addr}");
    axum::serve(listener, app).await.context("axum serve")?;
    Ok(())
}
