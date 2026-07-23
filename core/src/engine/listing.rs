// Read-only listing API (health/journal/docs/clusters/entities/digests/centroids).
// owner_scope filtering is shared across all of these — personal knowledge outside the scope never appears in any listing.

use super::*;

impl Engine {
    pub fn health(&self) -> Result<Health> {
        let (docs, chunks, clusters) = self.store.health_counts()?;
        Ok(Health {
            status: "ok".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            docs,
            chunks,
            clusters,
        })
    }

    pub fn list_docs(&self, owner_scope: Option<&str>) -> Result<Vec<DocSummary>> {
        let scope = OwnerScope::parse(owner_scope);
        let rows: Vec<DocSummaryRow> =
            self.store.list_docs()?.into_iter().filter(|r| scope.allows(r.owner.as_deref())).collect();
        let chunk_cluster_rows = self.store.all_chunk_cluster_rows()?;
        let cluster_rows = self.store.list_cluster_rows()?;
        Ok(build_doc_summaries(rows, &chunk_cluster_rows, &cluster_rows))
    }

    pub fn journal(&self, after_seq: i64) -> Result<JournalResponse> {
        let events = journal::list_events(&self.store, after_seq)?;
        Ok(JournalResponse {
            events: events.into_iter().map(|e| Event { seq: e.seq, ts: e.ts, kind: e.kind, payload: e.payload }).collect(),
        })
    }

    /// `GET /clusters`: all clusters with `n_docs`/`n_chunks` aggregated from
    /// current chunk membership.
    pub fn list_clusters(&self, owner_scope: Option<&str>) -> Result<Vec<ClusterSummary>> {
        let scope = OwnerScope::parse(owner_scope);
        let rows: Vec<ClusterRow> =
            self.store.list_cluster_rows()?.into_iter().filter(|r| scope.allows(r.owner.as_deref())).collect();
        let membership = self.build_membership()?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let (n_docs, n_chunks) = membership.cluster_counts(&r.id);
                ClusterSummary {
                    id: r.id,
                    slug: r.slug.unwrap_or_default(),
                    name: r.name,
                    description: r.description,
                    status: r.status,
                    owner: r.owner,
                    n_docs,
                    n_chunks,
                    updated_at: r.updated_at,
                }
            })
            .collect())
    }

    /// M7: `GET /entities?kind=`. Frontmatter-derived registry, joined with
    /// `docs` for `origin`. Not journaled — purely derived data.
    pub fn list_entities(&self, kind: Option<&str>, owner_scope: Option<&str>) -> Result<Vec<Entity>> {
        let scope = OwnerScope::parse(owner_scope);
        Ok(self
            .store
            .list_entities(kind)?
            .into_iter()
            .filter(|r| scope.allows(r.owner.as_deref()))
            .map(Entity::from)
            .collect())
    }

    /// M7: `GET /clusters/digests`. Active clusters only.
    pub fn list_cluster_digests(&self, owner_scope: Option<&str>) -> Result<Vec<ClusterDigest>> {
        let scope = OwnerScope::parse(owner_scope);
        Ok(self
            .store
            .list_active_cluster_digests()?
            .into_iter()
            .filter(|r| scope.allows(r.owner.as_deref()))
            .map(ClusterDigest::from)
            .collect())
    }

    /// `GET /clusters/centroids`: base64 little-endian f32 centroid for every
    /// active cluster that has one.
    pub fn cluster_centroids(&self, owner_scope: Option<&str>) -> Result<Vec<CentroidEntry>> {
        let scope = OwnerScope::parse(owner_scope);
        let rows = self.store.active_clusters_with_centroid()?;
        Ok(rows
            .into_iter()
            .filter(|r| scope.allows(r.owner.as_deref()))
            .filter_map(|r| r.centroid.map(|c| CentroidEntry { id: r.id, centroid: STANDARD.encode(c) }))
            .collect())
    }
}
