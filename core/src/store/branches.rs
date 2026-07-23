// branches (knowledge PR) + doc re-tagging (main↔branch) — the storage layer for promotion/merge/discard.

use super::*;

impl Store {
    /// Creates a branch (knowledge PR) in `status = 'open'`. Returns `Ok(true)` if
    /// `name` already exists (UNIQUE violation), letting the Engine layer map
    /// that to a 409 without parsing SQL error text; `Ok(false)` on success.
    pub fn create_branch(
        &self,
        id: &str,
        name: &str,
        created_by: Option<&str>,
        created_at: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let result = conn.execute(
            "INSERT INTO branches(id, name, status, created_by, created_at)
             VALUES (?1, ?2, 'open', ?3, ?4)",
            params![id, name, created_by, created_at],
        );
        match result {
            Ok(_) => Ok(false),
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Ok(true)
            }
            Err(e) => Err(e).context("inserting branch"),
        }
    }

    pub fn get_branch_row(&self, id: &str) -> Result<Option<BranchRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.query_row(
            "SELECT b.id, b.name, b.status, b.created_by, b.created_at, b.merged_at,
                    (SELECT COUNT(*) FROM docs d WHERE d.branch_id = b.id) AS n_docs
             FROM branches b WHERE b.id = ?1",
            params![id],
            |row| {
                Ok(BranchRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    status: row.get(2)?,
                    created_by: row.get(3)?,
                    created_at: row.get(4)?,
                    merged_at: row.get(5)?,
                    n_docs: row.get(6)?,
                })
            },
        )
        .optional()
        .context("querying branch by id")
    }

    pub fn list_branches(&self, status: Option<&str>) -> Result<Vec<BranchRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let base = "SELECT b.id, b.name, b.status, b.created_by, b.created_at, b.merged_at,
                            (SELECT COUNT(*) FROM docs d WHERE d.branch_id = b.id) AS n_docs
                     FROM branches b";
        let map_row = |row: &rusqlite::Row| {
            Ok(BranchRow {
                id: row.get(0)?,
                name: row.get(1)?,
                status: row.get(2)?,
                created_by: row.get(3)?,
                created_at: row.get(4)?,
                merged_at: row.get(5)?,
                n_docs: row.get(6)?,
            })
        };
        let rows: Vec<BranchRow> = match status {
            Some(s) => {
                let mut stmt = conn
                    .prepare(&format!("{base} WHERE b.status = ?1 ORDER BY b.created_at ASC"))
                    .context("preparing branch listing query")?;
                let rows = stmt
                    .query_map(params![s], map_row)
                    .context("querying branches")?
                    .collect::<rusqlite::Result<Vec<BranchRow>>>()
                    .context("collecting branches")?;
                rows
            }
            None => {
                let mut stmt = conn
                    .prepare(&format!("{base} ORDER BY b.created_at ASC"))
                    .context("preparing branch listing query")?;
                let rows = stmt
                    .query_map([], map_row)
                    .context("querying branches")?
                    .collect::<rusqlite::Result<Vec<BranchRow>>>()
                    .context("collecting branches")?;
                rows
            }
        };
        Ok(rows)
    }

    /// Docs currently tagged into `branch_id`. Additive counterpart to
    /// `list_docs()` (main-only, `branch_id IS NULL`) — does not touch that
    /// function or its query.
    pub fn docs_for_branch(&self, branch_id: &str) -> Result<Vec<DocSummaryRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT d.id, d.origin, d.source_type, d.title, COUNT(c.id) AS n_chunks, d.ingested_at, d.meta_json, d.owner
                 FROM docs d LEFT JOIN chunks c ON c.doc_id = d.id
                 WHERE d.branch_id = ?1
                 GROUP BY d.id ORDER BY d.ingested_at ASC",
            )
            .context("preparing branch doc listing query")?;
        let rows = stmt
            .query_map(params![branch_id], |row| {
                Ok(DocSummaryRow {
                    doc_id: row.get(0)?,
                    origin: row.get(1)?,
                    source_type: row.get(2)?,
                    title: row.get(3)?,
                    n_chunks: row.get(4)?,
                    ingested_at: row.get(5)?,
                    meta_json: row.get(6)?,
                    owner: row.get(7)?,
                })
            })
            .context("querying branch docs")?
            .collect::<rusqlite::Result<Vec<DocSummaryRow>>>()
            .context("collecting branch doc summaries")?;
        Ok(rows)
    }

    /// Cherry-pick merge support: clears `branch_id` on the given docs,
    /// moving them to main. Empty `doc_ids` is a no-op.
    pub fn retag_docs_to_main(&self, doc_ids: &[String]) -> Result<()> {
        if doc_ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let placeholders = doc_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("UPDATE docs SET branch_id = NULL WHERE id IN ({placeholders})");
        conn.execute(&sql, params_from_iter(doc_ids.iter()))
            .context("retagging docs to main")?;
        Ok(())
    }

    /// Sets `branch_id` on the given docs. Counterpart to
    /// `retag_docs_to_main`; used when moving docs onto a branch.
    pub fn retag_docs_to_branch(&self, doc_ids: &[String], branch_id: &str) -> Result<()> {
        if doc_ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let placeholders = doc_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("UPDATE docs SET branch_id = ? WHERE id IN ({placeholders})");
        let mut all_params: Vec<&str> = Vec::with_capacity(doc_ids.len() + 1);
        all_params.push(branch_id);
        all_params.extend(doc_ids.iter().map(|s| s.as_str()));
        conn.execute(&sql, params_from_iter(all_params.iter()))
            .context("retagging docs to branch")?;
        Ok(())
    }

    /// Sets `branches.status` (and optionally `merged_at`). Used by merge
    /// (→ "merged" + merged_at) and discard (→ "discarded", merged_at left
    /// NULL).
    pub fn set_branch_status(&self, branch_id: &str, status: &str, merged_at: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "UPDATE branches SET status = ?1, merged_at = ?2 WHERE id = ?3",
            params![status, merged_at, branch_id],
        )
        .context("updating branch status")?;
        Ok(())
    }

    /// All `(doc_id, branch_id)` pairs currently on a branch (main docs,
    /// where `branch_id IS NULL`, are excluded). Helper for the rollback-
    /// application lane — not yet consumed here.
    pub fn branch_doc_ids(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT id, branch_id FROM docs WHERE branch_id IS NOT NULL")
            .context("preparing branch doc id query")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .context("querying branch doc ids")?
            .collect::<rusqlite::Result<Vec<(String, String)>>>()
            .context("collecting branch doc ids")?;
        Ok(rows)
    }
}
