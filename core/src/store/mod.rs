//! SQLite persistence (rusqlite, bundled). DDL is CONTRACT.md verbatim, with
//! `IF NOT EXISTS` added so `Store::open` is idempotent across restarts.
//!
//! The connection is held behind `Arc<Mutex<Connection>>` and exposed via
//! `conn_handle()` so `Engine` can share the exact same connection with
//! `vector::SqliteVectorStore` instead of opening a second connection to the
//! same file.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use crate::frontmatter::EntityFields;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS docs(
  id TEXT PRIMARY KEY, source_type TEXT NOT NULL, origin TEXT NOT NULL UNIQUE,
  title TEXT, hash TEXT NOT NULL, n_chars INTEGER NOT NULL,
  ingested_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS chunks(
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id),
  seq INTEGER NOT NULL, text TEXT NOT NULL,
  char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
  section TEXT, cluster_ids TEXT NOT NULL DEFAULT '[]',
  embedding BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS clusters(
  id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, description TEXT,
  status TEXT NOT NULL DEFAULT 'active', sensitivity TEXT,
  created_by TEXT, stats_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT);
CREATE TABLE IF NOT EXISTS concepts(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
  cluster_ids TEXT NOT NULL DEFAULT '[]', summary TEXT,
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS relations(
  id TEXT PRIMARY KEY, src_concept TEXT NOT NULL, dst_concept TEXT NOT NULL,
  rel_type TEXT NOT NULL, evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
  confidence REAL);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, inverse_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS entities(
  doc_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  description TEXT, status TEXT, phase TEXT, next_action TEXT,
  blocked_on TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS cluster_digests(
  cluster_id TEXT PRIMARY KEY, text TEXT NOT NULL, model TEXT,
  updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS branches(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT, created_at TEXT NOT NULL, merged_at TEXT);
"#;

/// Additive, idempotent migration: `clusters.centroid` (f32 LE BLOB) was
/// added for M1 cluster bootstrap. Safe to call on every `Store::open`.
fn migrate_cluster_centroid_column(conn: &Connection) -> Result<()> {
    let has_centroid = conn
        .prepare("PRAGMA table_info(clusters)")
        .context("preparing table_info(clusters)")?
        .query_map([], |row| row.get::<_, String>(1))
        .context("querying table_info(clusters)")?
        .filter_map(|r| r.ok())
        .any(|name| name == "centroid");
    if !has_centroid {
        conn.execute("ALTER TABLE clusters ADD COLUMN centroid BLOB", [])
            .context("adding clusters.centroid column")?;
    }
    Ok(())
}

/// M8: additive migration for branch (지식 PR) support — adds `docs.branch_id`
/// so existing rows are undamaged; `NULL` means the doc is on main.
fn migrate_docs_branch_id_column(conn: &Connection) -> Result<()> {
    let has_branch_id = conn
        .prepare("PRAGMA table_info(docs)")
        .context("preparing table_info(docs)")?
        .query_map([], |row| row.get::<_, String>(1))
        .context("querying table_info(docs)")?
        .filter_map(|r| r.ok())
        .any(|name| name == "branch_id");
    if !has_branch_id {
        conn.execute("ALTER TABLE docs ADD COLUMN branch_id TEXT", [])
            .context("adding docs.branch_id column")?;
    }
    Ok(())
}

/// M9: additive migration for personal-knowledge support — adds `docs.owner`
/// so existing rows are undamaged; `NULL` means the doc is shared (common).
fn migrate_docs_owner_column(conn: &Connection) -> Result<()> {
    let has_owner = conn
        .prepare("PRAGMA table_info(docs)")
        .context("preparing table_info(docs)")?
        .query_map([], |row| row.get::<_, String>(1))
        .context("querying table_info(docs)")?
        .filter_map(|r| r.ok())
        .any(|name| name == "owner");
    if !has_owner {
        conn.execute("ALTER TABLE docs ADD COLUMN owner TEXT", [])
            .context("adding docs.owner column")?;
    }
    Ok(())
}

/// M9: additive migration mirroring `migrate_docs_owner_column` for
/// `clusters.owner` — `NULL` means the cluster is shared (common); a
/// non-NULL value scopes a personal cluster (e.g. `personal-<owner>`) to
/// its owning member.
fn migrate_clusters_owner_column(conn: &Connection) -> Result<()> {
    let has_owner = conn
        .prepare("PRAGMA table_info(clusters)")
        .context("preparing table_info(clusters)")?
        .query_map([], |row| row.get::<_, String>(1))
        .context("querying table_info(clusters)")?
        .filter_map(|r| r.ok())
        .any(|name| name == "owner");
    if !has_owner {
        conn.execute("ALTER TABLE clusters ADD COLUMN owner TEXT", [])
            .context("adding clusters.owner column")?;
    }
    Ok(())
}

/// M10: additive migration — `docs.doc_name`(origin 스템, 소문자) 컬럼과
/// `doc_links` 테이블. 기존 행의 doc_name은 여기서 즉시 백필한다(문서 수백 건
/// 규모라 open 시 1회 순회 비용은 무시 가능).
fn migrate_doc_links(conn: &Connection) -> Result<()> {
    let has_doc_name = conn
        .prepare("PRAGMA table_info(docs)")
        .context("preparing table_info(docs)")?
        .query_map([], |row| row.get::<_, String>(1))
        .context("querying table_info(docs)")?
        .filter_map(|r| r.ok())
        .any(|name| name == "doc_name");
    if !has_doc_name {
        conn.execute("ALTER TABLE docs ADD COLUMN doc_name TEXT", [])
            .context("adding docs.doc_name column")?;
    }

    // 백필: doc_name이 비어 있는 행만(멱등).
    let pending: Vec<(String, String)> = conn
        .prepare("SELECT id, origin FROM docs WHERE doc_name IS NULL")
        .context("preparing doc_name backfill query")?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .context("querying doc_name backfill rows")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("collecting doc_name backfill rows")?;
    for (id, origin) in pending {
        let name = crate::wikilinks::doc_name_from_origin(&origin);
        conn.execute("UPDATE docs SET doc_name = ?1 WHERE id = ?2", params![name, id])
            .context("backfilling doc_name")?;
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS doc_links(
           id TEXT PRIMARY KEY,
           src_doc_id TEXT NOT NULL,
           rel_type TEXT NOT NULL,
           target_name TEXT NOT NULL,
           target_doc_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_doc_links_src ON doc_links(src_doc_id);
         CREATE INDEX IF NOT EXISTS idx_doc_links_target_doc ON doc_links(target_doc_id);
         CREATE INDEX IF NOT EXISTS idx_doc_links_target_name ON doc_links(target_name);
         CREATE INDEX IF NOT EXISTS idx_docs_doc_name ON docs(doc_name);",
    )
    .context("creating doc_links table")?;
    Ok(())
}

pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

/// A cluster row as stored, including the raw centroid embedding bytes
/// (used internally for bootstrap/route math; never serialized directly).
#[derive(Clone)]
pub struct ClusterRow {
    pub id: String,
    pub slug: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub centroid: Option<Vec<u8>>,
    pub updated_at: Option<String>,
    /// M9: personal-knowledge owner (`NULL` = shared/common cluster).
    pub owner: Option<String>,
}

/// A full cluster row snapshot (including columns not exposed by
/// `ClusterRow`), captured before a destructive op (e.g. `/clusters/merge`)
/// so `/rollback` can restore it verbatim.
#[derive(Debug, Clone)]
pub struct ClusterFullRow {
    pub id: String,
    pub slug: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub sensitivity: Option<String>,
    pub created_by: Option<String>,
    pub stats_json: String,
    pub centroid: Option<Vec<u8>>,
    pub updated_at: Option<String>,
}

/// A doc's pre-mutation `chunks.cluster_ids`/`docs.meta_json` snapshot, used
/// by both `/clusters/birth` and `/clusters/merge` inverse payloads so
/// `/rollback` can restore a doc's prior cluster assignment exactly.
#[derive(Debug, Clone)]
pub struct DocClusterSnapshot {
    pub doc_id: String,
    pub prev_cluster_ids_json: String,
    pub prev_meta_json: String,
}

/// A chunk hydrated with its parent doc's `origin`/`title`, for `SearchResult`.
pub struct ChunkRow {
    pub chunk_id: String,
    pub doc_id: String,
    pub origin: String,
    pub title: Option<String>,
    pub text: String,
    pub char_start: i64,
    pub char_end: i64,
    pub section: Option<String>,
}

#[derive(Clone)]
pub struct DocSummaryRow {
    pub doc_id: String,
    pub origin: String,
    pub source_type: String,
    pub title: Option<String>,
    pub n_chunks: i64,
    pub ingested_at: String,
    /// M3: raw `docs.meta_json` (e.g. `{"fit":0.87}`), for `Engine::list_docs`
    /// to parse `fit` out of without an extra per-doc query.
    pub meta_json: String,
    /// M9: personal-knowledge owner (`NULL` = shared/common doc).
    pub owner: Option<String>,
}

/// M8: a branch (지식 PR) row, with `n_docs` pre-joined so callers don't need
/// a second query.
#[derive(Debug, Clone)]
pub struct BranchRow {
    pub id: String,
    pub name: String,
    pub status: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub merged_at: Option<String>,
    pub n_docs: i64,
}

pub struct EventRow {
    pub seq: i64,
    pub ts: String,
    pub kind: String,
    pub payload_json: String,
    pub inverse_json: String,
}

/// A frontmatter-derived entity row, joined with `docs.origin` (M7).
pub struct EntityRow {
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
    /// M9: owning doc's `docs.owner` (`None` = shared).
    pub owner: Option<String>,
}

/// A cluster digest row, joined with `clusters.slug`/`clusters.name` (M7).
pub struct ClusterDigestRow {
    pub cluster_id: String,
    pub slug: Option<String>,
    pub name: Option<String>,
    pub text: String,
    pub model: Option<String>,
    pub updated_at: String,
    /// M9: owning cluster's `clusters.owner` (`None` = shared).
    pub owner: Option<String>,
}

/// M9: read-path owner scope — `Shared` sees only shared (`owner IS NULL`)
/// docs/clusters, `Named` additionally sees that owner's personal ones.
/// Parsed from the `owner_scope` request/query field: `"shared"` or absent
/// parses to `Shared`; `"shared+<name>"` parses to `Named(<name>)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerScope {
    Shared,
    Named(String),
}

impl OwnerScope {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some(s) => match s.strip_prefix("shared+") {
                Some(name) if !name.is_empty() => OwnerScope::Named(name.to_string()),
                _ => OwnerScope::Shared,
            },
            None => OwnerScope::Shared,
        }
    }

    /// The `?2`-style bind param for `(d.owner IS NULL OR d.owner = ?2)`
    /// predicates: `None` for `Shared` (matches nothing beyond the
    /// always-visible `IS NULL` shared rows), `Some(name)` for `Named`.
    pub fn sql_param(&self) -> Option<&str> {
        match self {
            OwnerScope::Shared => None,
            OwnerScope::Named(name) => Some(name.as_str()),
        }
    }

    /// Whether a row with the given `owner` column value is visible under
    /// this scope. Shared rows (`None`) are always visible.
    pub fn allows(&self, owner: Option<&str>) -> bool {
        match owner {
            None => true,
            Some(o) => match self {
                OwnerScope::Shared => false,
                OwnerScope::Named(name) => name == o,
            },
        }
    }
}

/// A single chunk to be inserted, paired with its precomputed embedding bytes.
pub struct NewChunk {
    pub id: String,
    pub seq: i64,
    pub text: String,
    pub char_start: i64,
    pub char_end: i64,
    pub section: Option<String>,
    pub embedding: Vec<u8>,
}

impl Store {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db parent dir {}", parent.display()))?;
        }
        let conn = Connection::open(db_path)
            .with_context(|| format!("opening sqlite db {}", db_path.display()))?;
        conn.execute_batch(DDL).context("running schema DDL")?;
        migrate_cluster_centroid_column(&conn).context("running cluster centroid migration")?;
        migrate_docs_branch_id_column(&conn).context("running docs branch_id migration")?;
        migrate_docs_owner_column(&conn).context("running docs owner migration")?;
        migrate_clusters_owner_column(&conn).context("running clusters owner migration")?;
        migrate_doc_links(&conn).context("running doc_links migration")?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    /// Shared connection handle, for `vector::SqliteVectorStore` to read the
    /// same `chunks.embedding` data without a second connection.
    pub fn conn_handle(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.conn)
    }

    /// `(docs, chunks, clusters)` counts for `/health`.
    pub fn health_counts(&self) -> Result<(i64, i64, i64)> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let docs: i64 = conn
            .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
            .context("counting docs")?;
        let chunks: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
            .context("counting chunks")?;
        let clusters: i64 = conn
            .query_row("SELECT COUNT(*) FROM clusters", [], |r| r.get(0))
            .context("counting clusters")?;
        Ok((docs, chunks, clusters))
    }
}

// ---------------------------------------------------------------------
// 테이블/관심사별 impl 분할 — DDL·행 타입·OwnerScope·Store는 이 파일에,
// 각 자식 모듈은 use super::*로 접근한다.
// ---------------------------------------------------------------------
mod branches; // 지식 PR 저장 계층
mod links; // M10 문서 관계 그래프(doc_links)
pub use links::DocLinkRow;
mod chunks; // 청크·임베딩·exclusion-set
mod clusters; // 클러스터 행 연산
mod docs; // 문서 행 연산·소유권
mod entities; // 엔티티 레지스트리·다이제스트
mod events; // 저널·롤백 역연산

#[cfg(test)]
mod tests;
