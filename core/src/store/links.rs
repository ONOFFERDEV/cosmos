// M10 document relationship graph (doc_links) storage layer: link replacement (idempotent), dangling
// reverse-resolution, in/out queries, 1-hop neighbors. Scope decisions are engine's job — here we just carry the owner along.

use super::*;

/// A row for graph queries — the link plus (if resolved) minimal metadata of the other document.
#[derive(Debug, Clone)]
pub struct DocLinkRow {
    pub rel_type: String,
    pub target_name: String,
    pub other_doc_id: Option<String>,
    pub other_origin: Option<String>,
    pub other_title: Option<String>,
    pub other_owner: Option<String>,
    pub other_branch_id: Option<String>,
}

impl Store {
    /// Replaces all of a document's links (idempotent on re-ingest). On insert,
    /// if a document with a doc_name matching target_name exists, resolves it immediately (target_doc_id).
    pub fn replace_doc_links(&self, src_doc_id: &str, links: &[(String, String)]) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute("DELETE FROM doc_links WHERE src_doc_id = ?1", params![src_doc_id])
            .context("deleting old doc_links")?;
        for (rel_type, target_name) in links {
            let target_doc_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM docs WHERE doc_name = ?1 AND id != ?2 LIMIT 1",
                    params![target_name, src_doc_id],
                    |row| row.get(0),
                )
                .optional()
                .context("resolving link target")?;
            conn.execute(
                "INSERT INTO doc_links(id, src_doc_id, rel_type, target_name, target_doc_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![uuid::Uuid::new_v4().to_string(), src_doc_id, rel_type, target_name, target_doc_id],
            )
            .context("inserting doc_link")?;
        }
        Ok(())
    }

    /// self-heal: when a new document (doc_name) arrives, resolves the dangling
    /// links that were waiting on that name. Return value = number of links resolved.
    pub fn resolve_dangling_links(&self, doc_name: &str, doc_id: &str) -> Result<usize> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let n = conn
            .execute(
                "UPDATE doc_links SET target_doc_id = ?1
                 WHERE target_doc_id IS NULL AND target_name = ?2 AND src_doc_id != ?1",
                params![doc_id, doc_name],
            )
            .context("resolving dangling links")?;
        Ok(n)
    }

    /// Outgoing links (+ resolved metadata of the other document).
    pub fn links_out(&self, doc_id: &str) -> Result<Vec<DocLinkRow>> {
        self.query_links(
            "SELECT l.rel_type, l.target_name, d.id, d.origin, d.title, d.owner, d.branch_id
             FROM doc_links l LEFT JOIN docs d ON d.id = l.target_doc_id
             WHERE l.src_doc_id = ?1 ORDER BY l.rel_type, l.target_name",
            doc_id,
        )
    }

    /// Incoming links (with source document metadata attached). Dangling links don't exist here by definition.
    pub fn links_in(&self, doc_id: &str) -> Result<Vec<DocLinkRow>> {
        self.query_links(
            "SELECT l.rel_type, d.doc_name, d.id, d.origin, d.title, d.owner, d.branch_id
             FROM doc_links l JOIN docs d ON d.id = l.src_doc_id
             WHERE l.target_doc_id = ?1 ORDER BY l.rel_type, d.doc_name",
            doc_id,
        )
    }

    fn query_links(&self, sql: &str, doc_id: &str) -> Result<Vec<DocLinkRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn.prepare(sql).context("preparing doc_links query")?;
        let rows = stmt
            .query_map(params![doc_id], |row| {
                Ok(DocLinkRow {
                    rel_type: row.get(0)?,
                    target_name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    other_doc_id: row.get(2)?,
                    other_origin: row.get(3)?,
                    other_title: row.get(4)?,
                    other_owner: row.get(5)?,
                    other_branch_id: row.get(6)?,
                })
            })
            .context("querying doc_links")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("collecting doc_links")?;
        Ok(rows)
    }

    /// 1-hop neighbor doc_ids (direction-agnostic, excludes the input set, deduplicated).
    pub fn neighbor_doc_ids(&self, doc_ids: &[String]) -> Result<Vec<String>> {
        if doc_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let placeholders = doc_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT DISTINCT other FROM (
               SELECT target_doc_id AS other FROM doc_links
                 WHERE src_doc_id IN ({placeholders}) AND target_doc_id IS NOT NULL
               UNION
               SELECT src_doc_id AS other FROM doc_links
                 WHERE target_doc_id IN ({placeholders})
             ) WHERE other NOT IN ({placeholders})"
        );
        let mut all_params: Vec<&dyn rusqlite::ToSql> = Vec::new();
        for _ in 0..3 {
            for id in doc_ids {
                all_params.push(id);
            }
        }
        let mut stmt = conn.prepare(&sql).context("preparing neighbors query")?;
        let rows = stmt
            .query_map(all_params.as_slice(), |row| row.get::<_, String>(0))
            .context("querying neighbors")?
            .collect::<rusqlite::Result<Vec<String>>>()
            .context("collecting neighbors")?;
        Ok(rows)
    }

    /// All resolved link pairs (+ owner/branch of both endpoint documents — scope decisions are engine's job).
    /// Meant for relationship-graph visualization, so dangling links (target NULL) are excluded.
    pub fn resolved_link_pairs(
        &self,
    ) -> Result<Vec<(String, String, String, Option<String>, Option<String>, Option<String>, Option<String>)>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT l.src_doc_id, l.target_doc_id, l.rel_type,
                        s.owner, s.branch_id, t.owner, t.branch_id
                 FROM doc_links l
                 JOIN docs s ON s.id = l.src_doc_id
                 JOIN docs t ON t.id = l.target_doc_id
                 ORDER BY l.src_doc_id, l.rel_type, l.target_name",
            )
            .context("preparing link pairs query")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
            })
            .context("querying link pairs")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("collecting link pairs")?;
        Ok(rows)
    }

    /// Document metadata for neighbor responses (includes owner/branch for scope decisions).
    pub fn docs_meta_by_ids(
        &self,
        ids: &[String],
    ) -> Result<Vec<(String, String, Option<String>, Option<String>, Option<String>)>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("SELECT id, origin, title, owner, branch_id FROM docs WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).context("preparing docs meta query")?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .context("querying docs meta")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("collecting docs meta")?;
        Ok(rows)
    }
}
