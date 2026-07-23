// M10 relationship graph lookup: a document's in/out links and 1-hop neighbors (for graph expansion).
// Scope isolation applies to relationships too — documents outside scope (personal) are excluded entirely
// (even the title/name would be a leak). dangling (names outside the corpus) are harmless to expose, so they pass through as-is.
// See CONTRACT.md "관계 그래프 (M10 v1)".

use super::*;

impl Engine {
    /// `GET /graph/docs/{doc_id}` — a document's outbound/inbound links.
    pub fn graph_doc(&self, doc_id: &str, owner_scope: Option<&str>) -> Result<GraphDocResponse, EngineError> {
        let scope = OwnerScope::parse(owner_scope);
        // If the target document itself is out of scope, don't confirm its existence (respond the same as 404).
        let (owner, branch) =
            self.store.doc_owner_and_branch(doc_id)?.ok_or_else(|| EngineError::DocNotFound(doc_id.to_string()))?;
        if branch.is_some() || !scope.allows(owner.as_deref()) {
            return Err(EngineError::DocNotFound(doc_id.to_string()));
        }

        let to_item = |row: crate::store::DocLinkRow| -> Option<GraphLinkItem> {
            match &row.other_doc_id {
                Some(_) => {
                    // Resolved target document: must pass both branch isolation and scope isolation to be exposed.
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

    /// `GET /graph/links` — all resolved link pairs where both endpoints are exposable
    /// within scope (for relationship-line visualization). If either endpoint is out of scope (personal) or on a branch, the whole pair is excluded.
    pub fn graph_links(&self, owner_scope: Option<&str>) -> Result<GraphLinksResponse> {
        let scope = OwnerScope::parse(owner_scope);
        let pairs = self.store.resolved_link_pairs()?;
        let links = pairs
            .into_iter()
            .filter(|(_, _, _, src_owner, src_branch, dst_owner, dst_branch)| {
                src_branch.is_none()
                    && dst_branch.is_none()
                    && scope.allows(src_owner.as_deref())
                    && scope.allows(dst_owner.as_deref())
            })
            .map(|(src, dst, rel_type, ..)| GraphLinkPair { src_doc_id: src, dst_doc_id: dst, rel_type })
            .collect();
        Ok(GraphLinksResponse { links })
    }

    /// `POST /graph/neighbors` — 1-hop neighbors of the input documents (scope/branch isolation,
    /// capped by limit, with the first chunk's snippet attached). Used by mind's fast graph expansion.
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
