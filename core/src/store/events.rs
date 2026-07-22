// events(저널): append/list/get + rollback_* 역연산(생명주기 되돌리기의 저장 계층).

use super::*;

impl Store {
    /// Append an event, returning its assigned `seq`.
    pub fn append_event(&self, ts: &str, kind: &str, payload_json: &str, inverse_json: &str) -> Result<i64> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "INSERT INTO events(ts, kind, payload_json, inverse_json) VALUES (?1, ?2, ?3, ?4)",
            params![ts, kind, payload_json, inverse_json],
        )
        .context("inserting event")?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_events(&self, after_seq: i64) -> Result<Vec<EventRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT seq, ts, kind, payload_json, inverse_json FROM events WHERE seq > ?1 ORDER BY seq ASC")
            .context("preparing journal query")?;
        let rows = stmt
            .query_map(params![after_seq], |row| {
                Ok(EventRow {
                    seq: row.get(0)?,
                    ts: row.get(1)?,
                    kind: row.get(2)?,
                    payload_json: row.get(3)?,
                    inverse_json: row.get(4)?,
                })
            })
            .context("querying events")?
            .collect::<rusqlite::Result<Vec<EventRow>>>()
            .context("collecting events")?;
        Ok(rows)
    }

    /// Fetch a single event by `seq` (used by `/rollback` to look up the
    /// target event's `inverse_json`).
    pub fn get_event(&self, seq: i64) -> Result<Option<EventRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.query_row(
            "SELECT seq, ts, kind, payload_json, inverse_json FROM events WHERE seq = ?1",
            params![seq],
            |row| {
                Ok(EventRow {
                    seq: row.get(0)?,
                    ts: row.get(1)?,
                    kind: row.get(2)?,
                    payload_json: row.get(3)?,
                    inverse_json: row.get(4)?,
                })
            },
        )
        .optional()
        .context("querying event by seq")
    }

    /// Transactional rollback of a `cluster_birth` event: deletes the newly
    /// created cluster and restores every affected doc's chunk `cluster_ids`
    /// + `meta_json` to its pre-birth snapshot.
    pub fn rollback_cluster_birth(&self, new_cluster_id: &str, docs: &[DocClusterSnapshot]) -> Result<()> {
        let mut conn = self.conn.lock().expect("sqlite mutex poisoned");
        let tx = conn.transaction().context("beginning birth rollback transaction")?;
        tx.execute("DELETE FROM clusters WHERE id = ?1", params![new_cluster_id])
            .context("deleting birthed cluster")?;
        for d in docs {
            tx.execute(
                "UPDATE chunks SET cluster_ids = ?1 WHERE doc_id = ?2",
                params![d.prev_cluster_ids_json, d.doc_id],
            )
            .context("restoring chunk cluster_ids")?;
            tx.execute(
                "UPDATE docs SET meta_json = ?1 WHERE id = ?2",
                params![d.prev_meta_json, d.doc_id],
            )
            .context("restoring doc meta_json")?;
        }
        tx.commit().context("committing birth rollback")?;
        Ok(())
    }

    /// Transactional rollback of a `cluster_merge` event: restores the full
    /// src cluster row, restores dst's prior centroid, and restores every
    /// moved doc's chunk `cluster_ids` + `meta_json`.
    #[allow(clippy::too_many_arguments)]
    pub fn rollback_cluster_merge(
        &self,
        src_row: &ClusterFullRow,
        moved: &[DocClusterSnapshot],
        dst_id: &str,
        dst_prev_centroid: &[u8],
        dst_updated_at: &str,
    ) -> Result<()> {
        let mut conn = self.conn.lock().expect("sqlite mutex poisoned");
        let tx = conn.transaction().context("beginning merge rollback transaction")?;
        tx.execute(
            "UPDATE clusters SET slug=?1, name=?2, description=?3, status=?4, sensitivity=?5,
                created_by=?6, stats_json=?7, centroid=?8, updated_at=?9 WHERE id=?10",
            params![
                src_row.slug,
                src_row.name,
                src_row.description,
                src_row.status,
                src_row.sensitivity,
                src_row.created_by,
                src_row.stats_json,
                src_row.centroid,
                src_row.updated_at,
                src_row.id,
            ],
        )
        .context("restoring src cluster row")?;
        tx.execute(
            "UPDATE clusters SET centroid = ?1, updated_at = ?2 WHERE id = ?3",
            params![dst_prev_centroid, dst_updated_at, dst_id],
        )
        .context("restoring dst centroid")?;
        for d in moved {
            tx.execute(
                "UPDATE chunks SET cluster_ids = ?1 WHERE doc_id = ?2",
                params![d.prev_cluster_ids_json, d.doc_id],
            )
            .context("restoring moved chunk cluster_ids")?;
            tx.execute(
                "UPDATE docs SET meta_json = ?1 WHERE id = ?2",
                params![d.prev_meta_json, d.doc_id],
            )
            .context("restoring moved doc meta_json")?;
        }
        tx.commit().context("committing merge rollback")?;
        Ok(())
    }

    /// Transactional rollback of a `cluster_rename` event. Unconditional
    /// (unlike `update_cluster_row`'s COALESCE semantics) so a field that was
    /// renamed FROM `NULL` can be restored back to `NULL`. Returns `true` if
    /// the cluster row still exists.
    pub fn rollback_cluster_rename(
        &self,
        cluster_id: &str,
        old_slug: Option<&str>,
        old_name: Option<&str>,
        old_description: Option<&str>,
        updated_at: &str,
    ) -> Result<bool> {
        let mut conn = self.conn.lock().expect("sqlite mutex poisoned");
        let tx = conn.transaction().context("beginning rename rollback transaction")?;
        let affected = tx
            .execute(
                "UPDATE clusters SET slug=?1, name=?2, description=?3, updated_at=?4 WHERE id=?5",
                params![old_slug, old_name, old_description, updated_at, cluster_id],
            )
            .context("restoring cluster identity")?;
        tx.commit().context("committing rename rollback")?;
        Ok(affected > 0)
    }
}
