// M10 관계 그래프 조회: 문서의 in/out 링크와 1-hop 이웃(그래프 확장용).
// 스코프 격리가 관계에도 적용된다 — 스코프 밖 개인 문서는 항목째 제외
// (제목·이름도 유출이다). dangling(코퍼스 밖 이름)은 노출 무해라 그대로 낸다.
// CONTRACT.md "관계 그래프 (M10 v1)" 참고.

use super::*;

impl Engine {
    /// `GET /graph/docs/{doc_id}` — 문서의 나가는/들어오는 링크.
    pub fn graph_doc(&self, doc_id: &str, owner_scope: Option<&str>) -> Result<GraphDocResponse, EngineError> {
        let scope = OwnerScope::parse(owner_scope);
        // 대상 문서 자체가 스코프 밖이면 존재를 확인해 주지 않는다(404와 동일 응답).
        let (owner, branch) =
            self.store.doc_owner_and_branch(doc_id)?.ok_or_else(|| EngineError::DocNotFound(doc_id.to_string()))?;
        if branch.is_some() || !scope.allows(owner.as_deref()) {
            return Err(EngineError::DocNotFound(doc_id.to_string()));
        }

        let to_item = |row: crate::store::DocLinkRow| -> Option<GraphLinkItem> {
            match &row.other_doc_id {
                Some(_) => {
                    // 해석된 상대 문서: 브랜치 격리 + 스코프 격리 둘 다 통과해야 노출.
                    if row.other_branch_id.is_some() || !scope.allows(row.other_owner.as_deref()) {
                        return None;
                    }
                    Some(GraphLinkItem {
                        rel_type: row.rel_type,
                        target_name: row.target_name,
                        doc: Some(GraphDocRef {
                            doc_id: row.other_doc_id.unwrap_or_default(),
                            origin: row.other_origin.unwrap_or_default(),
                            title: row.other_title,
                        }),
                    })
                }
                None => Some(GraphLinkItem { rel_type: row.rel_type, target_name: row.target_name, doc: None }),
            }
        };

        let outbound: Vec<GraphLinkItem> = self.store.links_out(doc_id)?.into_iter().filter_map(to_item).collect();
        let inbound: Vec<GraphLinkItem> = self.store.links_in(doc_id)?.into_iter().filter_map(to_item).collect();
        Ok(GraphDocResponse { doc_id: doc_id.to_string(), outbound, inbound })
    }

    /// `POST /graph/neighbors` — 입력 문서들의 1-hop 이웃(스코프·브랜치 격리,
    /// limit 상한, 첫 청크 스니펫 동봉). mind의 fast 그래프 확장이 쓴다.
    pub fn graph_neighbors(&self, req: &GraphNeighborsRequest) -> Result<Vec<GraphNeighborDoc>> {
        let scope = OwnerScope::parse(req.owner_scope.as_deref());
        let limit = req.limit.unwrap_or(4).min(20);
        let ids = self.store.neighbor_doc_ids(&req.doc_ids)?;
        let metas = self.store.docs_meta_by_ids(&ids)?;

        let mut out = Vec::new();
        for (doc_id, origin, title, owner, branch_id) in metas {
            if out.len() >= limit {
                break;
            }
            if branch_id.is_some() || !scope.allows(owner.as_deref()) {
                continue;
            }
            let snippet: String = self
                .store
                .first_chunk_text_for_doc(&doc_id)?
                .map(|t| t.chars().take(400).collect())
                .unwrap_or_default();
            out.push(GraphNeighborDoc { doc_id, origin, title, snippet });
        }
        Ok(out)
    }
}
