// M10 문서 관계 그래프(doc_links) 저장 계층: 링크 교체(멱등)·dangling 역해석·
// in/out 조회·1-hop 이웃. 스코프 판정은 engine 몫 — 여기서는 owner를 실어 나른다.

use super::*;

/// 그래프 조회용 행 — 링크 + (해석됐다면) 상대 문서의 최소 메타.
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
    /// 문서의 링크 전체를 교체한다(재인제스트 멱등). 삽입 시 target_name과
    /// 일치하는 doc_name을 가진 문서가 있으면 즉시 해석(target_doc_id)한다.
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

    /// self-heal: 새 문서(doc_name)가 들어오면 그 이름을 기다리던 dangling
    /// 링크들을 해석한다. 반환값 = 해석된 링크 수.
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

    /// 나가는 링크(+해석된 상대 문서 메타).
    pub fn links_out(&self, doc_id: &str) -> Result<Vec<DocLinkRow>> {
        self.query_links(
            "SELECT l.rel_type, l.target_name, d.id, d.origin, d.title, d.owner, d.branch_id
             FROM doc_links l LEFT JOIN docs d ON d.id = l.target_doc_id
             WHERE l.src_doc_id = ?1 ORDER BY l.rel_type, l.target_name",
            doc_id,
        )
    }

    /// 들어오는 링크(출발 문서 메타 동봉). dangling은 정의상 존재하지 않는다.
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

    /// 1-hop 이웃 doc_id들(방향 무관, 입력 집합 제외, 중복 제거).
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

    /// 해석된 링크 쌍 전량(+양끝 문서의 owner/branch — 스코프 판정은 engine 몫).
    /// 관계선 시각화용이라 dangling(target NULL)은 제외한다.
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

    /// 이웃 응답용 문서 메타(스코프 판정용 owner/branch 포함).
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
