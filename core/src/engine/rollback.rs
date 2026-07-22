// 저널 롤백: kind별 inverse 적용(cluster_birth / cluster_merge / branch_merge).
// branch_merge는 M9부터 doc별 이전 owner까지 복원(승격 왕복 무손실).

use super::*;

impl Engine {
    /// `POST /rollback`: dispatches by journal event kind + inverse shape.
    /// Rejects re-rollback of an already-rolled-back `target_seq`
    /// (`EngineError::RollbackConflict`) and any event kind/shape without a
    /// supported inverse (`EngineError::RollbackUnsupported`).
    pub fn rollback(&self, req: &RollbackRequest) -> Result<RollbackResponse, EngineError> {
        let event = self.store.get_event(req.seq)?.ok_or(EngineError::EventNotFound)?;

        let all_events = journal::list_events(&self.store, 0)?;
        if find_rollback_conflict(&all_events, req.seq) {
            return Err(EngineError::RollbackConflict);
        }

        let inverse: Value = serde_json::from_str(&event.inverse_json).unwrap_or(Value::Null);

        match event.kind.as_str() {
            "cluster_birth" => {
                let (Some(new_cluster_id), Some(docs_value)) =
                    (inverse.get("new_cluster_id").and_then(Value::as_str), inverse.get("docs"))
                else {
                    return Err(EngineError::RollbackUnsupported("cluster_birth".to_string()));
                };
                let snapshots = parse_doc_snapshots(docs_value)?;
                self.store.rollback_cluster_birth(new_cluster_id, &snapshots)?;
            }
            "cluster_merge" => {
                let payload: Value = serde_json::from_str(&event.payload_json).unwrap_or(Value::Null);
                let dst_id = payload
                    .get("dst_id")
                    .and_then(Value::as_str)
                    .context("cluster_merge payload missing dst_id")?;
                let src_row_value = inverse.get("src_row").context("cluster_merge inverse missing src_row")?;
                let moved_value = inverse.get("moved").context("cluster_merge inverse missing moved")?;
                let dst_prev_centroid_b64 = inverse
                    .get("dst_prev_centroid")
                    .and_then(Value::as_str)
                    .context("cluster_merge inverse missing dst_prev_centroid")?;
                let src_row = parse_cluster_full_row(src_row_value)?;
                let moved = parse_doc_snapshots(moved_value)?;
                let dst_prev_centroid =
                    STANDARD.decode(dst_prev_centroid_b64.as_bytes()).context("decoding dst_prev_centroid")?;
                let updated_at = chrono::Utc::now().to_rfc3339();
                self.store.rollback_cluster_merge(&src_row, &moved, dst_id, &dst_prev_centroid, &updated_at)?;
            }
            "branch_merge" => {
                let branch_id = inverse
                    .get("branch_id")
                    .and_then(Value::as_str)
                    .context("branch_merge inverse missing branch_id")?;
                let doc_ids: Vec<String> = inverse
                    .get("doc_ids")
                    .and_then(Value::as_array)
                    .context("branch_merge inverse missing doc_ids")?
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect();
                let branch_closed = inverse.get("branch_closed").and_then(Value::as_bool).unwrap_or(false);
                self.store.retag_docs_to_branch(&doc_ids, branch_id)?;
                if branch_closed {
                    self.store.set_branch_status(branch_id, "open", None)?;
                }
                // M9: restore promoted docs' prior personal owner. Absent in
                // pre-M9 journals — treated as "no owners to restore".
                if let Some(owners) = inverse.get("doc_owners").and_then(Value::as_object) {
                    for (doc_id, owner) in owners {
                        if let Some(owner) = owner.as_str() {
                            self.store.update_doc_owner(doc_id, Some(owner))?;
                        }
                    }
                }
            }
            other => {
                return Err(EngineError::RollbackUnsupported(other.to_string()));
            }
        }

        let rollback_seq = journal::append_rollback(&self.store, req.seq)?;
        Ok(RollbackResponse { target_seq: req.seq, kind: event.kind, rollback_seq })
    }
}
