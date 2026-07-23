//! Append-only event journal (event-sourcing pattern). M0: write + read only
//! — `inverse_json` is recorded for a future rollback capability, not yet
//! executed.

use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};

use crate::store::{ClusterFullRow, DocClusterSnapshot, Store};

#[derive(Debug, Clone, Serialize)]
pub struct JournalEvent {
    pub seq: i64,
    pub ts: String,
    pub kind: String,
    pub payload: Value,
}

/// Append a `kind=ingest` event: `payload={doc_id, origin, replaced}`,
/// `inverse={delete_doc_id}`. Returns the assigned `seq`.
pub fn append_ingest(store: &Store, doc_id: &str, origin: &str, replaced: bool) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "doc_id": doc_id, "origin": origin, "replaced": replaced });
    let inverse = json!({ "delete_doc_id": doc_id });
    store
        .append_event(&ts, "ingest", &payload.to_string(), &inverse.to_string())
        .context("appending ingest event")
}

/// Append a `kind=cluster_birth` event for a newly created cluster:
/// `payload={cluster_id, slug}`, `inverse={delete_cluster_id}`.
pub fn append_cluster_birth(store: &Store, cluster_id: &str, slug: &str) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "cluster_id": cluster_id, "slug": slug });
    let inverse = json!({ "delete_cluster_id": cluster_id });
    store
        .append_event(&ts, "cluster_birth", &payload.to_string(), &inverse.to_string())
        .context("appending cluster_birth event")
}

/// Append a single bulk `kind=assign` event covering an entire bootstrap
/// run: `payload={assignments: N}`.
pub fn append_assign_bulk(store: &Store, assignments: usize) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "assignments": assignments });
    store
        .append_event(&ts, "assign", &payload.to_string(), "{}")
        .context("appending assign event")
}

/// Append a `kind=assign` event for a single document's ingest-time cluster
/// assignment: `payload={doc_id, cluster_id, fit}`. Distinct from
/// `append_assign_bulk` (bootstrap's aggregate event) though both use
/// `kind="assign"` per openapi.yaml's `Event.kind` enum.
pub fn append_assign_doc(store: &Store, doc_id: &str, cluster_id: &str, fit: f32) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "doc_id": doc_id, "cluster_id": cluster_id, "fit": fit });
    store
        .append_event(&ts, "assign", &payload.to_string(), "{}")
        .context("appending assign event")
}

/// Append a `kind=cluster_rename` event: `payload` carries the new
/// slug/name/description, `inverse` carries the previous values, so a future
/// rollback can restore them verbatim.
pub fn append_cluster_rename(
    store: &Store,
    cluster_id: &str,
    new_slug: Option<&str>,
    new_name: Option<&str>,
    new_description: Option<&str>,
    old_slug: Option<&str>,
    old_name: Option<&str>,
    old_description: Option<&str>,
) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({
        "cluster_id": cluster_id,
        "slug": new_slug,
        "name": new_name,
        "description": new_description,
    });
    let inverse = json!({
        "cluster_id": cluster_id,
        "slug": old_slug,
        "name": old_name,
        "description": old_description,
    });
    store
        .append_event(&ts, "cluster_rename", &payload.to_string(), &inverse.to_string())
        .context("appending cluster_rename event")
}

/// Append a single bulk `kind=unassign` event for the `force=true` reset
/// step of cluster bootstrap (all prior clusters deleted, all chunks'
/// `cluster_ids` cleared before regenerating).
pub fn append_unassign_reset(store: &Store, cleared: usize) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "cleared": cleared });
    store
        .append_event(&ts, "unassign", &payload.to_string(), "{}")
        .context("appending unassign event")
}

/// Append a `kind=cluster_birth` event for the M4 lifecycle `/clusters/birth`
/// endpoint (distinct from `append_cluster_birth`, which is the M2 bootstrap
/// event with a different payload/inverse shape): `payload={new_cluster_id,
/// slug, doc_ids}`, `inverse={new_cluster_id, docs:[{doc_id,
/// prev_cluster_ids, prev_meta_json}]}` so a rollback can fully restore the
/// pre-birth state of every affected document and delete the new cluster.
pub fn append_cluster_birth_lifecycle(
    store: &Store,
    new_cluster_id: &str,
    slug: &str,
    snapshots: &[DocClusterSnapshot],
) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let doc_ids: Vec<&str> = snapshots.iter().map(|s| s.doc_id.as_str()).collect();
    let payload = json!({ "new_cluster_id": new_cluster_id, "slug": slug, "doc_ids": doc_ids });
    let docs: Vec<Value> = snapshots
        .iter()
        .map(|s| {
            let prev_cluster_ids: Value =
                serde_json::from_str(&s.prev_cluster_ids_json).unwrap_or(Value::Array(Vec::new()));
            json!({
                "doc_id": s.doc_id,
                "prev_cluster_ids": prev_cluster_ids,
                "prev_meta_json": s.prev_meta_json,
            })
        })
        .collect();
    let inverse = json!({ "new_cluster_id": new_cluster_id, "docs": docs });
    store
        .append_event(&ts, "cluster_birth", &payload.to_string(), &inverse.to_string())
        .context("appending cluster_birth (lifecycle) event")
}

/// Append a `kind=cluster_merge` event for `/clusters/merge`: `payload=
/// {src_id, dst_id, moved_docs}`, `inverse={src_row, moved, dst_prev_centroid}`
/// carrying a full snapshot of the source cluster row (so it can be
/// recreated verbatim), each moved document's prior cluster membership and
/// fit, and the destination cluster's pre-merge centroid.
pub fn append_cluster_merge(
    store: &Store,
    src_row: &ClusterFullRow,
    src_centroid_b64: Option<&str>,
    dst_id: &str,
    dst_prev_centroid_b64: &str,
    moved: &[DocClusterSnapshot],
) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let doc_ids: Vec<&str> = moved.iter().map(|s| s.doc_id.as_str()).collect();
    let payload = json!({ "src_id": src_row.id, "dst_id": dst_id, "moved_docs": doc_ids });
    let moved_json: Vec<Value> = moved
        .iter()
        .map(|s| {
            let prev_cluster_ids: Value =
                serde_json::from_str(&s.prev_cluster_ids_json).unwrap_or(Value::Array(Vec::new()));
            json!({
                "doc_id": s.doc_id,
                "prev_cluster_ids": prev_cluster_ids,
                "prev_meta_json": s.prev_meta_json,
            })
        })
        .collect();
    let src_row_json = json!({
        "id": src_row.id,
        "slug": src_row.slug,
        "name": src_row.name,
        "description": src_row.description,
        "status": src_row.status,
        "sensitivity": src_row.sensitivity,
        "created_by": src_row.created_by,
        "stats_json": src_row.stats_json,
        "centroid_b64": src_centroid_b64,
        "updated_at": src_row.updated_at,
    });
    let inverse = json!({
        "src_row": src_row_json,
        "moved": moved_json,
        "dst_prev_centroid": dst_prev_centroid_b64,
    });
    store
        .append_event(&ts, "cluster_merge", &payload.to_string(), &inverse.to_string())
        .context("appending cluster_merge event")
}

/// Append a `kind=rollback` event recording that event `target_seq` was
/// rolled back: `payload={target_seq}`, no inverse (a rollback of a rollback
/// is not supported — re-rollback of the same `target_seq` is rejected by
/// `Engine::rollback` before this is called).
pub fn append_rollback(store: &Store, target_seq: i64) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "target_seq": target_seq });
    store
        .append_event(&ts, "rollback", &payload.to_string(), "{}")
        .context("appending rollback event")
}

/// M8: append a `kind=branch_create` event: `payload={branch_id, name,
/// created_by}`, no inverse (the semantic "undo" of an open branch is
/// `discard`, not a rollback of this event).
pub fn append_branch_create(store: &Store, branch_id: &str, name: &str, created_by: Option<&str>) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "branch_id": branch_id, "name": name, "created_by": created_by });
    store
        .append_event(&ts, "branch_create", &payload.to_string(), "{}")
        .context("appending branch_create event")
}

/// M8: append a `kind=branch_merge` event: `payload={branch_id, doc_ids}`.
/// `inverse={branch_id, doc_ids, branch_closed}` carries enough to re-retag
/// the merged docs back into the branch and revert its status, for a future
/// rollback capability.
///
/// M9: `inverse.doc_owners` maps doc_id → prior personal owner for promoted
/// docs (merge clears `owner`), so rollback restores ownership losslessly.
pub fn append_branch_merge(
    store: &Store,
    branch_id: &str,
    doc_ids: &[String],
    branch_closed: bool,
    doc_owners: &[(String, String)],
) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "branch_id": branch_id, "doc_ids": doc_ids });
    let owners_map: serde_json::Map<String, serde_json::Value> = doc_owners
        .iter()
        .map(|(doc_id, owner)| (doc_id.clone(), serde_json::Value::String(owner.clone())))
        .collect();
    let inverse = json!({
        "branch_id": branch_id,
        "doc_ids": doc_ids,
        "branch_closed": branch_closed,
        "doc_owners": owners_map,
    });
    store
        .append_event(&ts, "branch_merge", &payload.to_string(), &inverse.to_string())
        .context("appending branch_merge event")
}

/// M9 migrate CLI: append a `kind=owner_migrate` event recording the bulk
/// ownership claim (`source_type` docs → `owner`). No inverse — the
/// migration is a one-way policy change ("session docs are personal"), and
/// the affected set is recoverable by the same `source_type` predicate.
pub fn append_owner_migrate(store: &Store, source_type: &str, owner: &str, n_docs: usize) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "source_type": source_type, "owner": owner, "n_docs": n_docs });
    store
        .append_event(&ts, "owner_migrate", &payload.to_string(), "{}")
        .context("appending owner_migrate event")
}

/// P4 (shared-knowledge migration): append a `kind=docs_delete` event recording a bulk
/// delete by origin prefix. No inverse — the deletion is the switchover step
/// after the same content re-enters under a new origin namespace (knowledge://).
pub fn append_docs_delete(store: &Store, origin_prefix: &str, n_docs: usize) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "origin_prefix": origin_prefix, "n_docs": n_docs });
    store
        .append_event(&ts, "docs_delete", &payload.to_string(), "{}")
        .context("appending docs_delete event")
}

/// M8: append a `kind=branch_discard` event: `payload={branch_id, origins}`,
/// no inverse — discard actually deletes the branch's docs, so there is
/// nothing to roll back to; only the list of `origin`s is kept, since doc
/// content itself isn't retained.
pub fn append_branch_discard(store: &Store, branch_id: &str, origins: &[String]) -> Result<i64> {
    let ts = Utc::now().to_rfc3339();
    let payload = json!({ "branch_id": branch_id, "origins": origins });
    store
        .append_event(&ts, "branch_discard", &payload.to_string(), "{}")
        .context("appending branch_discard event")
}

/// List events with `seq > after_seq`, parsing `payload_json` into a JSON
/// value for the API's `Event.payload` field.
pub fn list_events(store: &Store, after_seq: i64) -> Result<Vec<JournalEvent>> {
    let rows = store.list_events(after_seq).context("listing events")?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let payload = serde_json::from_str(&row.payload_json)
                .unwrap_or_else(|_| Value::Object(Default::default()));
            JournalEvent { seq: row.seq, ts: row.ts, kind: row.kind, payload }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_and_list_roundtrip() {
        let path = std::env::temp_dir().join(format!("cosmos-journal-test-{}.sqlite3", uuid::Uuid::new_v4()));
        let store = Store::open(&path).expect("open store");
        let seq = append_ingest(&store, "d1", "origin://a", false).expect("append_ingest");
        assert!(seq >= 1);
        let events = list_events(&store, 0).expect("list_events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "ingest");
        assert_eq!(events[0].payload["doc_id"], "d1");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn append_assign_doc_roundtrip() {
        let path = std::env::temp_dir().join(format!("cosmos-journal-test-{}.sqlite3", uuid::Uuid::new_v4()));
        let store = Store::open(&path).expect("open store");
        let seq = append_assign_doc(&store, "d1", "cl1", 0.63).expect("append_assign_doc");
        assert!(seq >= 1);
        let events = list_events(&store, 0).expect("list_events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "assign");
        assert_eq!(events[0].payload["doc_id"], "d1");
        assert_eq!(events[0].payload["cluster_id"], "cl1");
        assert!((events[0].payload["fit"].as_f64().unwrap() - 0.63).abs() < 1e-6);
        let _ = std::fs::remove_file(&path);
    }
}
