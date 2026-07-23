// docs 테이블: 삽입/조회/삭제 + M9 소유권(owner 갱신·마이그레이션·소유자 열거).

use super::*;

impl Store {
    /// Look up an existing doc by `origin`. Returns `(id, hash)` if found.
    pub fn find_doc_by_origin(&self, origin: &str) -> Result<Option<(String, String)>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.query_row(
            "SELECT id, hash FROM docs WHERE origin = ?1",
            params![origin],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .context("querying doc by origin")
    }

    /// Delete a doc and its chunks (chunks first, no FK cascade in the DDL),
    /// plus its M7 entity row (frontmatter-derived data must not outlive
    /// the doc it was parsed from).
    pub fn delete_doc(&self, doc_id: &str) -> Result<()> {
        {
            let conn = self.conn.lock().expect("sqlite mutex poisoned");
            conn.execute("DELETE FROM chunks WHERE doc_id = ?1", params![doc_id])
                .context("deleting chunks for doc")?;
            conn.execute("DELETE FROM docs WHERE id = ?1", params![doc_id])
                .context("deleting doc")?;
        }
        self.delete_entity(doc_id)?;
        Ok(())
    }

    /// origin 접두로 문서를 일괄 삭제한다(P4 공용지식 이관 전환용).
    /// chunks·entity·나가는 링크는 함께 삭제, 들어오는 링크는 dangling(NULL)으로
    /// 되돌려 같은 이름의 문서가 새 origin으로 들어오면 역해석되게 한다.
    /// tantivy 잔존 항목은 무해(검색이 scoped_chunk_ids로 SQLite와 교차 검증).
    /// 반환 = 삭제된 doc_id 목록(dry-run은 호출부에서 이 목록만 쓰고 중단).
    pub fn docs_ids_by_origin_prefix(&self, prefix: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let like = format!("{}%", prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = conn
            .prepare("SELECT id FROM docs WHERE origin LIKE ?1 ESCAPE '\\'")
            .context("preparing origin prefix query")?;
        let rows = stmt
            .query_map(params![like], |row| row.get::<_, String>(0))
            .context("querying docs by origin prefix")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("collecting docs by origin prefix")?;
        Ok(rows)
    }

    pub fn delete_docs_by_ids(&self, ids: &[String]) -> Result<usize> {
        for id in ids {
            {
                let conn = self.conn.lock().expect("sqlite mutex poisoned");
                conn.execute("DELETE FROM doc_links WHERE src_doc_id = ?1", params![id])
                    .context("deleting outgoing links")?;
                conn.execute("UPDATE doc_links SET target_doc_id = NULL WHERE target_doc_id = ?1", params![id])
                    .context("re-dangling incoming links")?;
            }
            self.delete_doc(id)?;
        }
        Ok(ids.len())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_doc(
        &self,
        id: &str,
        source_type: &str,
        origin: &str,
        title: Option<&str>,
        hash: &str,
        n_chars: i64,
        ingested_at: &str,
        branch_id: Option<&str>,
        owner: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        // M10: doc_name(origin 스템)은 관계 그래프의 링크 해석 키 — 삽입 시 항상 계산해 둔다.
        let doc_name = crate::wikilinks::doc_name_from_origin(origin);
        conn.execute(
            "INSERT INTO docs(id, source_type, origin, title, hash, n_chars, ingested_at, meta_json, branch_id, owner, doc_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}', ?8, ?9, ?10)",
            params![id, source_type, origin, title, hash, n_chars, ingested_at, branch_id, owner, doc_name],
        )
        .context("inserting doc")?;
        Ok(())
    }

    /// M9: set/clear a doc's personal-knowledge `owner`. Used to self-heal
    /// ownership on duplicate re-ingest (a common doc claimed personally).
    pub fn update_doc_owner(&self, doc_id: &str, owner: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute("UPDATE docs SET owner = ?1 WHERE id = ?2", params![owner, doc_id])
            .context("updating doc owner")?;
        Ok(())
    }

    /// M9 promotion: each doc's `(owner, branch_id)`, or `None` if the doc
    /// doesn't exist — lets the Engine validate promotion preconditions
    /// (owner ≠ NULL, not already tagged) without a full row fetch.
    pub fn doc_owner_and_branch(&self, doc_id: &str) -> Result<Option<(Option<String>, Option<String>)>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.query_row(
            "SELECT owner, branch_id FROM docs WHERE id = ?1",
            params![doc_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .context("querying doc owner/branch")
    }

    /// M9 promotion: `(doc_id, owner)` for every doc in `doc_ids` that has a
    /// non-NULL owner — recorded into the `branch_merge` inverse so rollback
    /// can restore personal ownership.
    pub fn owners_for_docs(&self, doc_ids: &[String]) -> Result<Vec<(String, String)>> {
        if doc_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let placeholders = doc_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("SELECT id, owner FROM docs WHERE owner IS NOT NULL AND id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).context("preparing doc owners query")?;
        let rows = stmt
            .query_map(params_from_iter(doc_ids.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .context("querying doc owners")?
            .collect::<rusqlite::Result<Vec<(String, String)>>>()
            .context("collecting doc owners")?;
        Ok(rows)
    }

    /// M9 migrate: owners that currently hold at least one main-branch doc —
    /// drives the lifecycle scope traversal (shared + every personal scope).
    pub fn distinct_doc_owners(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT DISTINCT owner FROM docs WHERE owner IS NOT NULL AND branch_id IS NULL ORDER BY owner ASC")
            .context("preparing distinct owners query")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .context("querying distinct owners")?
            .collect::<rusqlite::Result<Vec<String>>>()
            .context("collecting distinct owners")?;
        Ok(rows)
    }

    /// M9 migrate CLI: claim every still-shared doc of `source_type` for
    /// `owner`. Returns the number of docs updated.
    pub fn set_owner_for_source_type(&self, source_type: &str, owner: &str) -> Result<usize> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let n = conn
            .execute(
                "UPDATE docs SET owner = ?1 WHERE source_type = ?2 AND owner IS NULL",
                params![owner, source_type],
            )
            .context("migrating doc owners by source_type")?;
        Ok(n)
    }

    /// M9 migrate CLI dry-run: how many docs `set_owner_for_source_type`
    /// would touch.
    pub fn count_unowned_docs_for_source_type(&self, source_type: &str) -> Result<i64> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.query_row(
            "SELECT COUNT(*) FROM docs WHERE source_type = ?1 AND owner IS NULL",
            params![source_type],
            |r| r.get(0),
        )
        .context("counting unowned docs by source_type")
    }

    pub fn list_docs(&self) -> Result<Vec<DocSummaryRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT d.id, d.origin, d.source_type, d.title, COUNT(c.id) AS n_chunks, d.ingested_at, d.meta_json, d.owner
                 FROM docs d LEFT JOIN chunks c ON c.doc_id = d.id
                 WHERE d.branch_id IS NULL
                 GROUP BY d.id ORDER BY d.ingested_at ASC",
            )
            .context("preparing doc listing query")?;
        let rows = stmt
            .query_map([], |row| {
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
            .context("querying docs")?
            .collect::<rusqlite::Result<Vec<DocSummaryRow>>>()
            .context("collecting doc summaries")?;
        Ok(rows)
    }

    /// Overwrite a doc's `meta_json` (M2: ingest-time cluster assignment
    /// records `{"fit":..}` / `{"fit":..,"low_fit":true}` here).
    pub fn update_doc_meta_json(&self, doc_id: &str, meta_json: &str) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute("UPDATE docs SET meta_json = ?1 WHERE id = ?2", params![meta_json, doc_id])
            .context("updating doc meta_json")?;
        Ok(())
    }
}
