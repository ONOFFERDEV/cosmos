// Search & routing (search/route/misfits): BM25 + vector RRF + rerank hybrid.
// All of it is filtered by the exclusion-set (branch exclusion + owner scope) at the candidate stage — isolation without reindexing.

use super::*;

impl Engine {
    /// Hybrid search: BM25 top-M + vector top-N -> RRF fuse -> hydrate ->
    /// cross-encoder rerank -> final top-k. When `cluster_ids` is non-empty,
    /// candidates are restricted to chunks whose doc was assigned to one of
    /// those clusters by `/clusters/bootstrap` (BM25 pool doubled to 40
    /// before filtering, to compensate for members trimmed out).
    ///
    /// M8: candidates are always additionally scoped to main-branch docs
    /// (`branch_id IS NULL`), unless `include_branch_id` names a branch, in
    /// which case that branch's docs are un-excluded too (admin preview
    /// overlay) — other branches stay excluded either way.
    pub fn search(
        &self,
        query: &str,
        k: usize,
        cluster_ids: &[String],
        include_branch_id: Option<&str>,
        owner_scope: Option<&str>,
    ) -> Result<SearchResponse> {
        let started = Instant::now();

        let scope = OwnerScope::parse(owner_scope);
        let scoped_ids = self.store.scoped_chunk_ids(include_branch_id, &scope)?;
        let allowed_ids: Option<HashSet<String>> = if cluster_ids.is_empty() {
            Some(scoped_ids)
        } else {
            let cluster_scoped = self.build_membership()?.chunk_ids_in_clusters(cluster_ids);
            Some(cluster_scoped.intersection(&scoped_ids).cloned().collect())
        };

        let bm25_pool = if cluster_ids.is_empty() { TOP_M_BM25 } else { TOP_M_BM25 * 2 };
        let bm25_raw = self.bm25.search(query, bm25_pool)?;
        let bm25_results: Vec<(String, f32)> = match &allowed_ids {
            None => bm25_raw,
            Some(allowed) => bm25_raw.into_iter().filter(|(id, _)| allowed.contains(id)).collect(),
        };

        let query_embedding = self.embedder.embed_one(query)?;
        let vec_results = self.vector.search_filtered(&query_embedding, TOP_N_VEC, allowed_ids.as_ref())?;

        let num_bm25 = bm25_results.len();
        let num_vec = vec_results.len();

        let fused = crate::fuse::rrf_fuse(&bm25_results, &vec_results, RRF_POOL);
        let pool = fused.len();

        let pool_ids: Vec<String> = fused.iter().map(|e| e.chunk_id.clone()).collect();
        let hydrated = self.store.fetch_chunks_by_ids(&pool_ids)?;

        let rrf_by_id: std::collections::HashMap<&str, &crate::fuse::RrfEntry> =
            fused.iter().map(|e| (e.chunk_id.as_str(), e)).collect();

        let texts: Vec<String> = hydrated.iter().map(|c| c.text.clone()).collect();
        let reranked = if texts.is_empty() { Vec::new() } else { self.reranker.rerank(query, &texts)? };
        let reranked_count = reranked.len();

        // fastembed's rerank() returns results pre-sorted descending by
        // score, so no extra sort is needed here.
        let mut results: Vec<SearchResult> = reranked
            .into_iter()
            .filter_map(|(idx, score)| {
                let row = hydrated.get(idx)?;
                let rrf = rrf_by_id.get(row.chunk_id.as_str())?;
                Some(SearchResult {
                    chunk_id: row.chunk_id.clone(),
                    doc_id: row.doc_id.clone(),
                    origin: row.origin.clone(),
                    title: row.title.clone(),
                    text: row.text.clone(),
                    char_start: row.char_start,
                    char_end: row.char_end,
                    section: row.section.clone(),
                    score,
                    stages: SearchStages {
                        bm25_rank: rrf.bm25_rank,
                        vec_rank: rrf.vec_rank,
                        rrf_score: rrf.rrf_score,
                        rerank_score: score,
                    },
                })
            })
            .collect();
        results.truncate(k);

        let secs = started.elapsed().as_secs_f64();

        Ok(SearchResponse {
            results,
            stats: SearchStats { num_bm25, num_vec, pool, reranked: reranked_count, secs },
        })
    }

    /// `POST /route`: cosine(query, centroid) per active cluster + count of
    /// that cluster's chunks among the global BM25 top-`TOP_M_BM25`. Sorted
    /// descending by `centroid_sim`.
    ///
    /// M8: BM25 hits are scoped to main-branch docs (`branch_id IS NULL`) —
    /// unlike `search`, `route` has no overlay parameter, so branch docs are
    /// always excluded from cluster scoring.
    pub fn route(&self, query: &str, owner_scope: Option<&str>) -> Result<RouteResponse, EngineError> {
        let scope = OwnerScope::parse(owner_scope);
        let query_embedding = self.embedder.embed_one(query)?;
        let bm25_results = self.bm25.search(query, TOP_M_BM25)?;
        let scoped_ids = self.store.scoped_chunk_ids(None, &scope)?;
        let top_bm25_chunk_ids: HashSet<String> = bm25_results
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| scoped_ids.contains(id))
            .collect();
        let membership = self.build_membership()?;
        let clusters: Vec<ClusterRow> = self
            .store
            .active_clusters_with_centroid()?
            .into_iter()
            .filter(|row| scope.allows(row.owner.as_deref()))
            .collect();

        let mut scores: Vec<RouteScore> = clusters
            .into_iter()
            .map(|row| {
                let centroid = row.centroid.as_deref().map(bytes_to_f32_vec).unwrap_or_default();
                let centroid_sim = cosine(&query_embedding, &centroid);
                let bm25_hits = top_bm25_chunk_ids
                    .iter()
                    .filter(|chunk_id| {
                        membership
                            .chunk_clusters
                            .get(*chunk_id)
                            .is_some_and(|cids| cids.iter().any(|c| c == &row.id))
                    })
                    .count();
                RouteScore { cluster_id: row.id, slug: row.slug.unwrap_or_default(), name: row.name, centroid_sim, bm25_hits }
            })
            .collect();

        scores.sort_by(|a, b| b.centroid_sim.total_cmp(&a.centroid_sim));
        Ok(RouteResponse { scores })
    }

    /// `GET /misfits`: documents whose `meta_json.low_fit == true`.
    pub fn misfits(&self, owner_scope: Option<&str>) -> Result<Vec<MisfitDoc>> {
        let scope = OwnerScope::parse(owner_scope);
        let rows: Vec<DocSummaryRow> =
            self.store.list_docs()?.into_iter().filter(|r| scope.allows(r.owner.as_deref())).collect();
        let chunk_cluster_rows = self.store.all_chunk_cluster_rows()?;
        let cluster_rows = self.store.list_cluster_rows()?;
        Ok(build_misfits(&rows, &chunk_cluster_rows, &cluster_rows))
    }
}
