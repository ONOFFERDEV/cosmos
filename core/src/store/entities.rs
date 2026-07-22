// entities(frontmatter 파생 레지스트리) + cluster_digests(클러스터 자기소개문).

use super::*;

impl Store {
    /// M7: insert or refresh a doc's frontmatter-derived entity row. Called
    /// on every `ingest_doc` (including duplicates) so daily rescans
    /// self-heal without a backfill command.
    pub fn upsert_entity(&self, doc_id: &str, fields: &EntityFields) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "INSERT INTO entities(doc_id, name, kind, description, status, phase, next_action, blocked_on, updated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(doc_id) DO UPDATE SET
               name = excluded.name, kind = excluded.kind, description = excluded.description,
               status = excluded.status, phase = excluded.phase, next_action = excluded.next_action,
               blocked_on = excluded.blocked_on, updated = excluded.updated",
            params![
                doc_id,
                fields.name,
                fields.kind,
                fields.description,
                fields.status,
                fields.phase,
                fields.next_action,
                fields.blocked_on,
                fields.updated,
            ],
        )
        .context("upserting entity")?;
        Ok(())
    }

    /// M7: remove a doc's entity row, if any (no-op if it never had one).
    pub fn delete_entity(&self, doc_id: &str) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute("DELETE FROM entities WHERE doc_id = ?1", params![doc_id])
            .context("deleting entity")?;
        Ok(())
    }

    /// M7: list entities, optionally filtered to a single `kind`, joined
    /// with `docs.origin`.
    pub fn list_entities(&self, kind: Option<&str>) -> Result<Vec<EntityRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let base = "SELECT e.doc_id, e.name, e.kind, e.description, e.status, e.phase,
                            e.next_action, e.blocked_on, e.updated, d.origin, d.owner
                     FROM entities e JOIN docs d ON d.id = e.doc_id
                     WHERE d.branch_id IS NULL";
        let map_row = |row: &rusqlite::Row| {
            Ok(EntityRow {
                doc_id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                description: row.get(3)?,
                status: row.get(4)?,
                phase: row.get(5)?,
                next_action: row.get(6)?,
                blocked_on: row.get(7)?,
                updated: row.get(8)?,
                origin: row.get(9)?,
                owner: row.get(10)?,
            })
        };
        let rows: Vec<EntityRow> = match kind {
            Some(k) => {
                let mut stmt = conn
                    .prepare(&format!("{base} AND e.kind = ?1"))
                    .context("preparing entity listing query")?;
                let rows = stmt
                    .query_map(params![k], map_row)
                    .context("querying entities")?
                    .collect::<rusqlite::Result<Vec<EntityRow>>>()
                    .context("collecting entities")?;
                rows
            }
            None => {
                let mut stmt = conn.prepare(base).context("preparing entity listing query")?;
                let rows = stmt
                    .query_map([], map_row)
                    .context("querying entities")?
                    .collect::<rusqlite::Result<Vec<EntityRow>>>()
                    .context("collecting entities")?;
                rows
            }
        };
        Ok(rows)
    }

    /// M7: insert or refresh a cluster's digest text (derived data — no
    /// journal event).
    pub fn upsert_cluster_digest(
        &self,
        cluster_id: &str,
        text: &str,
        model: Option<&str>,
        updated_at: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "INSERT INTO cluster_digests(cluster_id, text, model, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(cluster_id) DO UPDATE SET
               text = excluded.text, model = excluded.model, updated_at = excluded.updated_at",
            params![cluster_id, text, model, updated_at],
        )
        .context("upserting cluster digest")?;
        Ok(())
    }

    /// M7: list digests for active clusters only (merged/dormant clusters'
    /// stale digests are shadowed via the join).
    pub fn list_active_cluster_digests(&self) -> Result<Vec<ClusterDigestRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT cd.cluster_id, c.slug, c.name, cd.text, cd.model, cd.updated_at, c.owner
                 FROM cluster_digests cd JOIN clusters c ON c.id = cd.cluster_id
                 WHERE c.status = 'active'",
            )
            .context("preparing cluster digest listing query")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ClusterDigestRow {
                    cluster_id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    text: row.get(3)?,
                    model: row.get(4)?,
                    updated_at: row.get(5)?,
                    owner: row.get(6)?,
                })
            })
            .context("querying cluster digests")?
            .collect::<rusqlite::Result<Vec<ClusterDigestRow>>>()
            .context("collecting cluster digests")?;
        Ok(rows)
    }
}
