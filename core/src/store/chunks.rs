// chunks 테이블: 삽입/조회/임베딩 + scoped_chunk_ids(브랜치·owner exclusion-set의 심장).

use super::*;

impl Store {
    pub fn list_chunk_ids_for_doc(&self, doc_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT id FROM chunks WHERE doc_id = ?1")
            .context("preparing chunk id lookup")?;
        let ids = stmt
            .query_map(params![doc_id], |row| row.get::<_, String>(0))
            .context("querying chunk ids for doc")?
            .collect::<rusqlite::Result<Vec<String>>>()
            .context("collecting chunk ids")?;
        Ok(ids)
    }

    pub fn insert_chunks(&self, doc_id: &str, chunks: &[NewChunk]) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        for c in chunks {
            conn.execute(
                "INSERT INTO chunks(id, doc_id, seq, text, char_start, char_end, section, cluster_ids, embedding)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', ?8)",
                params![c.id, doc_id, c.seq, c.text, c.char_start, c.char_end, c.section, c.embedding],
            )
            .context("inserting chunk")?;
        }
        Ok(())
    }

    /// Fetch chunks by id, joined with their parent doc's `origin`/`title`.
    /// Results are reordered to match the input `ids` order (missing ids are
    /// silently skipped); this preserves RRF pool ordering for the reranker.
    pub fn fetch_chunks_by_ids(&self, ids: &[String]) -> Result<Vec<ChunkRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT c.id, c.doc_id, d.origin, d.title, c.text, c.char_start, c.char_end, c.section
             FROM chunks c JOIN docs d ON c.doc_id = d.id
             WHERE c.id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).context("preparing chunk hydration query")?;
        let rows = stmt
            .query_map(params_from_iter(ids.iter()), |row| {
                Ok(ChunkRow {
                    chunk_id: row.get(0)?,
                    doc_id: row.get(1)?,
                    origin: row.get(2)?,
                    title: row.get(3)?,
                    text: row.get(4)?,
                    char_start: row.get(5)?,
                    char_end: row.get(6)?,
                    section: row.get(7)?,
                })
            })
            .context("querying chunks by id")?
            .collect::<rusqlite::Result<Vec<ChunkRow>>>()
            .context("collecting hydrated chunks")?;

        let mut by_id: std::collections::HashMap<String, ChunkRow> =
            rows.into_iter().map(|r| (r.chunk_id.clone(), r)).collect();
        let ordered = ids.iter().filter_map(|id| by_id.remove(id)).collect();
        Ok(ordered)
    }

    /// M8: chunk ids visible to search/route scoring — chunks of main docs
    /// (`branch_id IS NULL`), plus chunks of `include_branch_id`'s docs when
    /// given (admin preview overlay). Other branches' docs stay excluded.
    /// M9: also excludes chunks of docs owned by anyone outside `owner_scope`
    /// (shared docs, `docs.owner IS NULL`, are always visible).
    pub fn scoped_chunk_ids(
        &self,
        include_branch_id: Option<&str>,
        owner_scope: &OwnerScope,
    ) -> Result<HashSet<String>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT c.id FROM chunks c JOIN docs d ON d.id = c.doc_id
                 WHERE (d.branch_id IS NULL OR d.branch_id = ?1)
                   AND (d.owner IS NULL OR d.owner = ?2)",
            )
            .context("preparing scoped chunk id query")?;
        let rows = stmt
            .query_map(params![include_branch_id, owner_scope.sql_param()], |row| {
                row.get::<_, String>(0)
            })
            .context("querying scoped chunk ids")?
            .collect::<rusqlite::Result<HashSet<String>>>()
            .context("collecting scoped chunk ids")?;
        Ok(rows)
    }

    /// All chunks' `(doc_id, embedding)` pairs, for computing per-doc average
    /// vectors during cluster bootstrap.
    pub fn all_chunk_embeddings(&self) -> Result<Vec<(String, Vec<u8>)>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT doc_id, embedding FROM chunks")
            .context("preparing embedding scan")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))
            .context("querying chunk embeddings")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("collecting chunk embeddings")?;
        Ok(rows)
    }

    pub fn update_chunk_cluster_ids_for_doc(&self, doc_id: &str, cluster_ids_json: &str) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "UPDATE chunks SET cluster_ids = ?1 WHERE doc_id = ?2",
            params![cluster_ids_json, doc_id],
        )
        .context("updating chunk cluster_ids for doc")?;
        Ok(())
    }

    /// `(chunk_id, doc_id, cluster_ids_json)` for every chunk — used to build
    /// the in-memory cluster membership map for scoped search and for
    /// `ClusterSummary.n_docs`/`n_chunks` aggregation.
    pub fn all_chunk_cluster_rows(&self) -> Result<Vec<(String, String, String)>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT id, doc_id, cluster_ids FROM chunks")
            .context("preparing chunk cluster_ids scan")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })
            .context("querying chunk cluster_ids")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("collecting chunk cluster_ids")?;
        Ok(rows)
    }

    /// The earliest chunk (by `seq`) for a doc, used for bootstrap sample
    /// snippets.
    pub fn first_chunk_text_for_doc(&self, doc_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.query_row(
            "SELECT text FROM chunks WHERE doc_id = ?1 ORDER BY seq ASC LIMIT 1",
            params![doc_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("querying first chunk text for doc")
    }

    pub fn reset_all_chunk_cluster_ids(&self) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute("UPDATE chunks SET cluster_ids = '[]'", [])
            .context("resetting chunk cluster_ids")?;
        Ok(())
    }

    /// M9 scoped bootstrap (force=true): reset chunk assignments only for
    /// main-branch docs in the given scope. Returns the number of chunks
    /// reset (journaled as the unassign count).
    pub fn reset_chunk_cluster_ids_for_owner_scope(&self, owner: Option<&str>) -> Result<usize> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let n = match owner {
            Some(o) => conn
                .execute(
                    "UPDATE chunks SET cluster_ids = '[]' WHERE doc_id IN
                     (SELECT id FROM docs WHERE branch_id IS NULL AND owner = ?1)",
                    params![o],
                )
                .context("resetting chunk cluster_ids for owner")?,
            None => conn
                .execute(
                    "UPDATE chunks SET cluster_ids = '[]' WHERE doc_id IN
                     (SELECT id FROM docs WHERE branch_id IS NULL AND owner IS NULL)",
                    [],
                )
                .context("resetting shared chunk cluster_ids")?,
        };
        Ok(n)
    }
}
