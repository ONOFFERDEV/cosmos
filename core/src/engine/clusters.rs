// 클러스터 연산: bootstrap(스코프별 k-means, force도 스코프 국소)·메타 갱신·birth·merge.
// 파괴 연산은 저널 inverse 동반(rollback.rs가 되돌린다).

use super::*;

impl Engine {
    /// `POST /clusters/bootstrap`: spherical k-means over per-doc average
    /// embeddings (unit-normalized), k chosen by silhouette over
    /// `[k_min, k_max]`, deterministic for a given `seed`. 409s via
    /// `EngineError::ClustersExist` unless clusters don't exist yet or
    /// `force=true` (which deletes all clusters + resets `chunks.cluster_ids`
    /// before regenerating).
    pub fn bootstrap_clusters(&self, req: &BootstrapRequest) -> Result<BootstrapResponse, EngineError> {
        // M9: bootstrap operates on exactly one scope — shared (owner NULL)
        // or one owner's personal docs. Existence check, force-delete, and
        // chunk reset are all scope-local so other scopes stay untouched.
        let owner = req.owner.as_deref();
        let existing = self.store.count_clusters_for_owner_scope(owner)?;
        if existing > 0 {
            if !req.force {
                return Err(EngineError::ClustersExist);
            }
            self.store.delete_clusters_for_owner_scope(owner)?;
            let chunks_reset = self.store.reset_chunk_cluster_ids_for_owner_scope(owner)?;
            journal::append_unassign_reset(&self.store, chunks_reset)?;
        }

        struct DocMeta {
            origin: String,
            title: Option<String>,
            n_chunks: i64,
        }

        let doc_rows: Vec<_> =
            self.store.list_docs()?.into_iter().filter(|d| d.owner.as_deref() == owner).collect();
        let chunk_embeddings = self.store.all_chunk_embeddings()?;

        // Document vector = normalized average of its chunk embeddings.
        let mut sums: HashMap<String, (Vec<f32>, usize)> = HashMap::new();
        for (doc_id, blob) in &chunk_embeddings {
            let v = bytes_to_f32_vec(blob);
            let entry = sums.entry(doc_id.clone()).or_insert_with(|| (vec![0f32; v.len()], 0));
            if entry.0.len() < v.len() {
                entry.0.resize(v.len(), 0.0);
            }
            for (s, x) in entry.0.iter_mut().zip(v.iter()) {
                *s += x;
            }
            entry.1 += 1;
        }

        let mut doc_meta: HashMap<String, DocMeta> = HashMap::new();
        let mut doc_order: Vec<String> = Vec::new();
        for d in &doc_rows {
            doc_meta.insert(d.doc_id.clone(), DocMeta { origin: d.origin.clone(), title: d.title.clone(), n_chunks: d.n_chunks });
            if sums.contains_key(&d.doc_id) {
                doc_order.push(d.doc_id.clone());
            }
        }

        let vectors: Vec<Vec<f32>> = doc_order
            .iter()
            .map(|doc_id| {
                let (sum, count) = &sums[doc_id];
                let mean: Vec<f32> = sum.iter().map(|x| x / *count as f32).collect();
                cluster::l2_normalize(&mean)
            })
            .collect();

        if vectors.is_empty() {
            return Ok(BootstrapResponse {
                clusters: Vec::new(),
                stats: BootstrapStats { k: 0, silhouette: 0.0, docs_assigned: 0 },
            });
        }

        let choice = cluster::choose_best_k(&vectors, req.k_min, req.k_max, req.seed, 50, 4);
        let k = choice.k;
        let assignments = &choice.result.assignments;
        let centroids = &choice.result.centroids;

        let updated_at = chrono::Utc::now().to_rfc3339();
        // M9: personal-scope slugs are prefixed (`p-<owner>-c01`) so they
        // never collide with the shared scope's `c01`… slugs.
        let slug_for = |c: usize| match owner {
            Some(o) => format!("p-{o}-c{:02}", c + 1),
            None => format!("c{:02}", c + 1),
        };
        let mut cluster_ids_by_idx: Vec<String> = Vec::with_capacity(k);
        for c in 0..k {
            let slug = slug_for(c);
            let cluster_id = Uuid::new_v4().to_string();
            let centroid_bytes = f32_vec_to_bytes(&centroids[c]);
            self.store.insert_cluster(&cluster_id, &slug, "active", &centroid_bytes, &updated_at, owner)?;
            journal::append_cluster_birth(&self.store, &cluster_id, &slug)?;
            cluster_ids_by_idx.push(cluster_id);
        }

        for (i, doc_id) in doc_order.iter().enumerate() {
            let cluster_id = cluster_ids_by_idx[assignments[i]].clone();
            let cluster_ids_json =
                serde_json::to_string(&vec![cluster_id]).context("serializing chunk cluster_ids")?;
            self.store.update_chunk_cluster_ids_for_doc(doc_id, &cluster_ids_json)?;
        }
        journal::append_assign_bulk(&self.store, doc_order.len())?;

        let mut clusters = Vec::with_capacity(k);
        for c in 0..k {
            let member_indices: Vec<usize> = (0..doc_order.len()).filter(|&i| assignments[i] == c).collect();
            let n_docs = member_indices.len() as i64;
            let n_chunks: i64 = member_indices.iter().map(|&i| doc_meta[&doc_order[i]].n_chunks).sum();

            let mut members: Vec<(usize, f32)> =
                member_indices.iter().map(|&i| (i, cosine(&vectors[i], &centroids[c]))).collect();
            members.sort_by(|a, b| b.1.total_cmp(&a.1));

            let mut sample = Vec::new();
            for &(i, _sim) in members.iter().take(8) {
                let doc_id = &doc_order[i];
                let meta = &doc_meta[doc_id];
                let snippet: String = self
                    .store
                    .first_chunk_text_for_doc(doc_id)?
                    .map(|t| t.chars().take(200).collect())
                    .unwrap_or_default();
                sample.push(ClusterSample { origin: meta.origin.clone(), title: meta.title.clone(), snippet });
            }

            clusters.push(ClusterBootstrapResult {
                summary: ClusterSummary {
                    id: cluster_ids_by_idx[c].clone(),
                    slug: slug_for(c),
                    name: None,
                    description: None,
                    status: "active".to_string(),
                    owner: req.owner.clone(),
                    n_docs,
                    n_chunks,
                    updated_at: Some(updated_at.clone()),
                },
                sample,
            });
        }

        Ok(BootstrapResponse {
            clusters,
            stats: BootstrapStats { k, silhouette: choice.silhouette as f64, docs_assigned: doc_order.len() },
        })
    }

    /// `PATCH /clusters/{cluster_id}`: partial slug/name/description update,
    /// journaled as `cluster_rename`. `EngineError::ClusterNotFound` -> 404.
    pub fn update_cluster(&self, cluster_id: &str, req: &UpdateClusterRequest) -> Result<ClusterSummary, EngineError> {
        let existing = self.store.get_cluster_row(cluster_id)?.ok_or(EngineError::ClusterNotFound)?;
        let updated_at = chrono::Utc::now().to_rfc3339();
        let found = self.store.update_cluster_row(
            cluster_id,
            req.slug.as_deref(),
            req.name.as_deref(),
            req.description.as_deref(),
            &updated_at,
        )?;
        if !found {
            return Err(EngineError::ClusterNotFound);
        }
        journal::append_cluster_rename(
            &self.store,
            cluster_id,
            req.slug.as_deref(),
            req.name.as_deref(),
            req.description.as_deref(),
            existing.slug.as_deref(),
            existing.name.as_deref(),
            existing.description.as_deref(),
        )?;
        let row = self.store.get_cluster_row(cluster_id)?.ok_or(EngineError::ClusterNotFound)?;
        let membership = self.build_membership()?;
        let (n_docs, n_chunks) = membership.cluster_counts(&row.id);
        Ok(ClusterSummary {
            id: row.id,
            slug: row.slug.unwrap_or_default(),
            name: row.name,
            description: row.description,
            status: row.status,
            owner: row.owner,
            n_docs,
            n_chunks,
            updated_at: row.updated_at,
        })
    }

    /// M7: `PUT /clusters/{cluster_id}/digest`. Upserts, then returns the
    /// digest built from the request + the cluster's own slug/name, so a
    /// digest written for a non-active cluster is still returned here even
    /// though `list_cluster_digests` filters to active-only.
    /// `EngineError::ClusterNotFound` -> 404.
    pub fn update_cluster_digest(
        &self,
        cluster_id: &str,
        req: &UpdateClusterDigestRequest,
    ) -> Result<ClusterDigest, EngineError> {
        let existing = self.store.get_cluster_row(cluster_id)?.ok_or(EngineError::ClusterNotFound)?;
        let updated_at = chrono::Utc::now().to_rfc3339();
        self.store.upsert_cluster_digest(cluster_id, &req.text, req.model.as_deref(), &updated_at)?;
        Ok(ClusterDigest {
            cluster_id: cluster_id.to_string(),
            slug: existing.slug.unwrap_or_default(),
            name: existing.name,
            text: req.text.clone(),
            model: req.model.clone(),
            updated_at,
        })
    }

    /// `POST /clusters/birth`: materialize a birth proposal into a real
    /// cluster. Journals `kind=cluster_birth` with a full pre-birth snapshot
    /// of every affected doc's `chunks.cluster_ids`/`docs.meta_json`, so
    /// `/rollback` can restore them exactly.
    pub fn cluster_birth(&self, req: &BirthClusterRequest) -> Result<ClusterSummary, EngineError> {
        if req.doc_ids.is_empty() {
            return Err(EngineError::Other(anyhow::anyhow!("doc_ids must not be empty")));
        }

        let chunk_cluster_rows = self.store.all_chunk_cluster_rows()?;
        let prev_cluster_ids = cluster_ids_json_by_doc(&chunk_cluster_rows);
        let doc_rows = self.store.list_docs()?;
        let meta_json_by_doc: HashMap<&str, &str> =
            doc_rows.iter().map(|r| (r.doc_id.as_str(), r.meta_json.as_str())).collect();

        let snapshots: Vec<DocClusterSnapshot> = req
            .doc_ids
            .iter()
            .map(|doc_id| DocClusterSnapshot {
                doc_id: doc_id.clone(),
                prev_cluster_ids_json: prev_cluster_ids.get(doc_id).cloned().unwrap_or_else(|| "[]".to_string()),
                prev_meta_json: meta_json_by_doc.get(doc_id.as_str()).copied().unwrap_or("{}").to_string(),
            })
            .collect();

        let chunk_embeddings = self.store.all_chunk_embeddings()?;
        let doc_vectors = doc_vectors_from_chunk_embeddings(&chunk_embeddings);
        let member_vectors: Vec<&Vec<f32>> = req.doc_ids.iter().filter_map(|id| doc_vectors.get(id)).collect();
        let centroid = mean_centroid(&member_vectors);
        let centroid_bytes = f32_vec_to_bytes(&centroid);

        let cluster_id = Uuid::new_v4().to_string();
        let updated_at = chrono::Utc::now().to_rfc3339();
        self.store.insert_cluster(&cluster_id, &req.slug, "active", &centroid_bytes, &updated_at, None)?;
        if req.name.is_some() || req.description.is_some() {
            self.store
                .update_cluster_row(&cluster_id, None, req.name.as_deref(), req.description.as_deref(), &updated_at)?;
        }

        let new_cluster_ids_json = serde_json::to_string(&vec![cluster_id.clone()]).context("serializing new cluster_ids")?;
        for doc_id in &req.doc_ids {
            self.store.update_chunk_cluster_ids_for_doc(doc_id, &new_cluster_ids_json)?;
            let fit = doc_vectors.get(doc_id).map(|v| cosine(v, &centroid)).unwrap_or(1.0);
            self.store.update_doc_meta_json(doc_id, &doc_meta_json_for_fit(fit))?;
        }

        journal::append_cluster_birth_lifecycle(&self.store, &cluster_id, &req.slug, &snapshots)?;

        let membership = self.build_membership()?;
        let (n_docs, n_chunks) = membership.cluster_counts(&cluster_id);
        Ok(ClusterSummary {
            id: cluster_id,
            slug: req.slug.clone(),
            name: req.name.clone(),
            description: req.description.clone(),
            status: "active".to_string(),
            owner: None,
            n_docs,
            n_chunks,
            updated_at: Some(updated_at),
        })
    }

    /// `POST /clusters/merge`: fold `src_id` into `dst_id` — moves every doc
    /// from src to dst, recomputes dst's centroid from all its (old + moved)
    /// docs, and marks src `status='merged'` (not deleted — `/rollback` needs
    /// the row to still exist so it can `UPDATE` it back). Journals
    /// `kind=cluster_merge` with a full src-row snapshot, moved-doc
    /// snapshots, and dst's pre-merge centroid.
    pub fn cluster_merge(&self, req: &MergeClustersRequest) -> Result<ClusterSummary, EngineError> {
        let src_row = self.store.get_cluster_full_row(&req.src_id)?.ok_or(EngineError::ClusterNotFound)?;
        let dst_row = self.store.get_cluster_row(&req.dst_id)?.ok_or(EngineError::ClusterNotFound)?;
        let dst_prev_centroid = dst_row.centroid.clone().unwrap_or_default();

        let chunk_cluster_rows = self.store.all_chunk_cluster_rows()?;
        let prev_cluster_ids = cluster_ids_json_by_doc(&chunk_cluster_rows);
        let membership = self.build_membership()?;
        let mut moved_doc_ids: Vec<String> =
            membership.cluster_docs.get(&req.src_id).cloned().unwrap_or_default().into_iter().collect();
        moved_doc_ids.sort();

        let doc_rows = self.store.list_docs()?;
        let meta_json_by_doc: HashMap<&str, &str> =
            doc_rows.iter().map(|r| (r.doc_id.as_str(), r.meta_json.as_str())).collect();

        let moved: Vec<DocClusterSnapshot> = moved_doc_ids
            .iter()
            .map(|doc_id| DocClusterSnapshot {
                doc_id: doc_id.clone(),
                prev_cluster_ids_json: prev_cluster_ids.get(doc_id).cloned().unwrap_or_else(|| "[]".to_string()),
                prev_meta_json: meta_json_by_doc.get(doc_id.as_str()).copied().unwrap_or("{}").to_string(),
            })
            .collect();

        let mut all_dst_doc_ids: HashSet<String> =
            membership.cluster_docs.get(&req.dst_id).cloned().unwrap_or_default();
        all_dst_doc_ids.extend(moved_doc_ids.iter().cloned());

        let chunk_embeddings = self.store.all_chunk_embeddings()?;
        let doc_vectors = doc_vectors_from_chunk_embeddings(&chunk_embeddings);
        let member_vectors: Vec<&Vec<f32>> = all_dst_doc_ids.iter().filter_map(|id| doc_vectors.get(id)).collect();
        let new_dst_centroid = mean_centroid(&member_vectors);
        let new_dst_centroid_bytes = f32_vec_to_bytes(&new_dst_centroid);

        let updated_at = chrono::Utc::now().to_rfc3339();
        let dst_cluster_ids_json = serde_json::to_string(&vec![req.dst_id.clone()]).context("serializing dst cluster_ids")?;
        for doc_id in &moved_doc_ids {
            self.store.update_chunk_cluster_ids_for_doc(doc_id, &dst_cluster_ids_json)?;
            let fit = doc_vectors.get(doc_id).map(|v| cosine(v, &new_dst_centroid)).unwrap_or(1.0);
            self.store.update_doc_meta_json(doc_id, &doc_meta_json_for_fit(fit))?;
        }
        self.store.update_cluster_centroid(&req.dst_id, &new_dst_centroid_bytes, &updated_at)?;
        let stats_json = serde_json::json!({ "merged_into": req.dst_id }).to_string();
        self.store.set_cluster_status_and_stats(&req.src_id, "merged", &stats_json, &updated_at)?;

        let src_centroid_b64 = src_row.centroid.as_ref().map(|c| STANDARD.encode(c));
        let dst_prev_centroid_b64 = STANDARD.encode(&dst_prev_centroid);
        journal::append_cluster_merge(
            &self.store,
            &src_row,
            src_centroid_b64.as_deref(),
            &req.dst_id,
            &dst_prev_centroid_b64,
            &moved,
        )?;

        let dst_row_after = self.store.get_cluster_row(&req.dst_id)?.ok_or(EngineError::ClusterNotFound)?;
        let membership_after = self.build_membership()?;
        let (n_docs, n_chunks) = membership_after.cluster_counts(&req.dst_id);
        Ok(ClusterSummary {
            id: dst_row_after.id,
            slug: dst_row_after.slug.unwrap_or_default(),
            name: dst_row_after.name,
            description: dst_row_after.description,
            status: dst_row_after.status,
            owner: dst_row_after.owner,
            n_docs,
            n_chunks,
            updated_at: dst_row_after.updated_at,
        })
    }
}
