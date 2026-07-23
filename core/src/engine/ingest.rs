// Data ingestion (ingest_doc): normalize · hash dedup · chunk · embed · index + argmax cluster assignment.
// Personal docs (owner) go only into clusters matching that owner; the first personal doc auto-births personal-<owner>.
// See the ingestion section of CONTRACT.md "현재 계약 스냅샷".

use super::*;

impl Engine {
    /// Ingest one document: normalize, hash, dedup/replace-check, chunk,
    /// self-verify anchor invariants, embed, persist (sqlite + bm25),
    /// journal.
    /// `branch_id`: `None` ingests onto main; `Some(id)` tags the doc into
    /// that branch (knowledge PR), 404-ing via `EngineError::BranchNotFound` if it
    /// doesn't exist. Checked unconditionally up front so a bad branch_id
    /// 404s regardless of duplicate-doc status below.
    /// `owner`: `None` ingests as shared/common; `Some(name)` scopes the doc
    /// to that member's personal knowledge space, restricting cluster
    /// assignment to `owner`'s own clusters (auto-birthing `personal-<name>`
    /// on first ingest). Mutually exclusive with `branch_id` —
    /// `EngineError::OwnerBranchConflict` if both are set.
    pub fn ingest_doc(
        &self,
        origin: &str,
        source_type: &str,
        title: Option<&str>,
        text: &str,
        branch_id: Option<&str>,
        owner: Option<&str>,
    ) -> Result<IngestOutcome, EngineError> {
        if branch_id.is_some() && owner.is_some() {
            return Err(EngineError::OwnerBranchConflict);
        }
        if let Some(bid) = branch_id {
            if self.store.get_branch_row(bid)?.is_none() {
                return Err(EngineError::BranchNotFound);
            }
        }

        let normalized = parse::normalize(text);
        let hash = parse::sha256_hex(normalized.as_bytes());
        // M7: parsed once up front; entity is upserted on both the
        // duplicate-return path and the new/replaced path below, so daily
        // rescans self-heal the registry without a backfill command.
        let entity_fields = frontmatter::parse(text);
        // M10: deterministic relation extraction is also replaced on both paths (idempotent) — the daily rescan is effectively the graph backfill.
        let doc_name = wikilinks::doc_name_from_origin(origin);
        let doc_links = wikilinks::extract_links(text, &doc_name);
        let link_pairs: Vec<(String, String)> =
            doc_links.into_iter().map(|l| (l.rel_type, l.target_name)).collect();

        let mut replaced = false;
        if let Some((existing_id, existing_hash)) = self.store.find_doc_by_origin(origin)? {
            if existing_hash == hash {
                let n_chunks = self.store.list_chunk_ids_for_doc(&existing_id)?.len() as i64;
                if let Some(fields) = &entity_fields {
                    self.store.upsert_entity(&existing_id, fields)?;
                }
                self.store.replace_doc_links(&existing_id, &link_pairs)?;
                // M9: self-heal ownership — re-ingesting an existing (e.g.
                // common) doc under a personal request claims it.
                self.store.update_doc_owner(&existing_id, owner)?;
                return Ok(IngestOutcome {
                    doc_id: existing_id,
                    origin: origin.to_string(),
                    chunks: n_chunks,
                    duplicate: true,
                    replaced: false,
                    anchor_mismatches: 0,
                    cluster_slug: None,
                    fit: None,
                });
            }
            let old_chunk_ids = self.store.list_chunk_ids_for_doc(&existing_id)?;
            self.bm25.delete_chunks(&old_chunk_ids)?;
            self.store.delete_doc(&existing_id)?;
            replaced = true;
        }

        let doc_id = Uuid::new_v4().to_string();
        let ingested_at = chrono::Utc::now().to_rfc3339();
        self.store.insert_doc(
            &doc_id,
            source_type,
            origin,
            title,
            &hash,
            normalized.len() as i64,
            &ingested_at,
            branch_id,
            owner,
        )?;
        if let Some(fields) = &entity_fields {
            self.store.upsert_entity(&doc_id, fields)?;
        }
        // M10: store this doc's links + resolve any dangling links that were waiting on this doc's name (self-heal).
        self.store.replace_doc_links(&doc_id, &link_pairs)?;
        self.store.resolve_dangling_links(&doc_name, &doc_id)?;

        let chunks = chunk::chunk_text(&normalized);

        let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
        let embeddings = if texts.is_empty() { Vec::new() } else { self.embedder.embed(&texts)? };

        let mut anchor_mismatches = 0usize;
        let mut new_chunks: Vec<NewChunk> = Vec::with_capacity(chunks.len());
        let mut bm25_batch: Vec<(String, String)> = Vec::with_capacity(chunks.len());

        for (i, c) in chunks.iter().enumerate() {
            let anchor_ok = c.text.len() == c.char_end - c.char_start
                && normalized.get(c.char_start..c.char_end) == Some(c.text.as_str());
            if !anchor_ok {
                anchor_mismatches += 1;
            }

            let chunk_id = Uuid::new_v4().to_string();
            let embedding_bytes = embeddings.get(i).map(|v| f32_vec_to_bytes(v)).unwrap_or_default();
            new_chunks.push(NewChunk {
                id: chunk_id.clone(),
                seq: i as i64,
                text: c.text.clone(),
                char_start: c.char_start as i64,
                char_end: c.char_end as i64,
                section: c.section.clone(),
                embedding: embedding_bytes,
            });
            bm25_batch.push((chunk_id, c.text.clone()));
        }

        self.store.insert_chunks(&doc_id, &new_chunks)?;
        if !bm25_batch.is_empty() {
            self.bm25.add_chunks(&bm25_batch)?;
        }

        let mut assigned_cluster_slug: Option<String> = None;
        let mut assigned_fit: Option<f32> = None;

        if !embeddings.is_empty() {
            let dim = embeddings[0].len();
            let mut mean = vec![0f32; dim];
            for v in &embeddings {
                for (m, x) in mean.iter_mut().zip(v.iter()) {
                    *m += x;
                }
            }
            let n = embeddings.len() as f32;
            for m in mean.iter_mut() {
                *m /= n;
            }
            let doc_vector = cluster::l2_normalize(&mean);

            // M9: owner-scoped ingest argmaxes only over that owner's own
            // clusters (auto-birthing `personal-<owner>` on first ingest);
            // shared ingest keeps the original common-cluster argmax.
            let candidate_clusters = if let Some(owner_name) = owner {
                self.store.clusters_for_owner(Some(owner_name))?
            } else {
                self.store.active_clusters_with_centroid()?
            };

            let assignment: Option<(String, Option<String>, f32)> = if candidate_clusters.is_empty() {
                if let Some(owner_name) = owner {
                    let cluster_id = Uuid::new_v4().to_string();
                    let slug = format!("personal-{owner_name}");
                    let name = format!("개인 · {owner_name}");
                    let centroid_bytes = f32_vec_to_bytes(&doc_vector);
                    let updated_at = chrono::Utc::now().to_rfc3339();
                    self.store
                        .insert_cluster(&cluster_id, &slug, "active", &centroid_bytes, &updated_at, Some(owner_name))?;
                    self.store.update_cluster_row(&cluster_id, None, Some(&name), None, &updated_at)?;
                    journal::append_cluster_birth(&self.store, &cluster_id, &slug)?;
                    Some((cluster_id, Some(slug), 1.0f32))
                } else {
                    None
                }
            } else {
                let mut best: Option<(&ClusterRow, f32)> = None;
                for row in &candidate_clusters {
                    let centroid = row.centroid.as_deref().map(bytes_to_f32_vec).unwrap_or_default();
                    let sim = cosine(&doc_vector, &centroid);
                    if best.as_ref().map(|(_, best_sim)| sim > *best_sim).unwrap_or(true) {
                        best = Some((row, sim));
                    }
                }
                best.map(|(row, fit)| (row.id.clone(), row.slug.clone(), fit))
            };

            if let Some((cluster_id, slug, fit)) = assignment {
                let cluster_ids_json =
                    serde_json::to_string(&vec![cluster_id.clone()]).context("serializing chunk cluster_ids")?;
                self.store.update_chunk_cluster_ids_for_doc(&doc_id, &cluster_ids_json)?;

                let meta_json = doc_meta_json_for_fit(fit);
                self.store.update_doc_meta_json(&doc_id, &meta_json)?;

                journal::append_assign_doc(&self.store, &doc_id, &cluster_id, fit)?;

                assigned_cluster_slug = slug;
                assigned_fit = Some(fit);
            }
        }

        journal::append_ingest(&self.store, &doc_id, origin, replaced)?;

        Ok(IngestOutcome {
            doc_id,
            origin: origin.to_string(),
            chunks: new_chunks.len() as i64,
            duplicate: false,
            replaced,
            anchor_mismatches,
            cluster_slug: assigned_cluster_slug,
            fit: assigned_fit,
        })
    }
}
