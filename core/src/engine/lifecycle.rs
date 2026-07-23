// Lifecycle evaluation (lifecycle_proposals): iterates scopes (shared + every owner holding docs) to
// propose birth/merge candidates — no cross-scope proposals. Execution and scheduling are the mind daemon's job.

use super::*;

impl Engine {
    /// `GET /lifecycle/proposals`: birth candidates grouped from misfit docs
    /// by cohesion threshold, and merge candidates between active clusters by
    /// centroid similarity.
    pub fn lifecycle_proposals(&self, query: &LifecycleProposalsQuery) -> Result<LifecycleProposalsResponse> {
        // M9: judged per scope — shared (owner NULL) plus every owner that
        // holds docs. Birth grouping and merge pairing never cross scopes,
        // so one owner's misfits can't seed a cluster with another's docs.
        let rows = self.store.list_docs()?;
        let chunk_cluster_rows = self.store.all_chunk_cluster_rows()?;
        let cluster_rows = self.store.list_cluster_rows()?;
        let chunk_embeddings = self.store.all_chunk_embeddings()?;
        let doc_vectors = doc_vectors_from_chunk_embeddings(&chunk_embeddings);
        let titles: HashMap<String, String> =
            rows.iter().filter_map(|r| r.title.clone().map(|t| (r.doc_id.clone(), t))).collect();
        let active_clusters = self.store.active_clusters_with_centroid()?;

        let mut scopes: Vec<Option<String>> = vec![None];
        scopes.extend(self.store.distinct_doc_owners()?.into_iter().map(Some));

        let mut births = Vec::new();
        let mut merges = Vec::new();
        for scope in &scopes {
            let scope_rows: Vec<DocSummaryRow> =
                rows.iter().filter(|r| r.owner.as_deref() == scope.as_deref()).cloned().collect();
            let misfits = build_misfits(&scope_rows, &chunk_cluster_rows, &cluster_rows);
            let misfit_ids: HashSet<&str> = misfits.iter().map(|m| m.doc_id.as_str()).collect();
            let misfit_vectors: HashMap<String, Vec<f32>> = doc_vectors
                .iter()
                .filter(|(doc_id, _)| misfit_ids.contains(doc_id.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            births.extend(birth_proposals(&misfit_vectors, &titles, query.birth_min, query.birth_cohesion));

            let scope_clusters: Vec<ClusterRow> = active_clusters
                .iter()
                .filter(|c| c.owner.as_deref() == scope.as_deref())
                .cloned()
                .collect();
            merges.extend(merge_proposals(&scope_clusters, query.merge_sim));
        }

        Ok(LifecycleProposalsResponse { births, merges })
    }
}
