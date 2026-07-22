// 지식 PR(브랜치): 생성/목록/문서 조회, 승격 태깅(tag_branch_docs, owner≠NULL만),
// 체리픽 merge(branch_id=NULL+owner=NULL 동시 전환+inverse), discard(비가역).

use super::*;

impl Engine {
    /// M8: `POST /branches`. `EngineError::BranchNameConflict` (409) if a
    /// branch with this `name` already exists.
    pub fn create_branch(&self, req: &CreateBranchRequest) -> Result<Branch, EngineError> {
        let id = Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();
        let name_conflict = self.store.create_branch(&id, &req.name, req.created_by.as_deref(), &created_at)?;
        if name_conflict {
            return Err(EngineError::BranchNameConflict);
        }
        journal::append_branch_create(&self.store, &id, &req.name, req.created_by.as_deref())?;
        let row = self.store.get_branch_row(&id)?.ok_or(EngineError::BranchNotFound)?;
        Ok(Branch::from(row))
    }

    /// M8: `GET /branches?status=`.
    pub fn list_branches(&self, status: Option<&str>) -> Result<Vec<Branch>> {
        Ok(self.store.list_branches(status)?.into_iter().map(Branch::from).collect())
    }

    /// M8: `GET /branches/{branch_id}/docs`. `EngineError::BranchNotFound` (404)
    /// if the branch doesn't exist.
    pub fn branch_docs(&self, branch_id: &str) -> Result<Vec<DocSummary>, EngineError> {
        self.store.get_branch_row(branch_id)?.ok_or(EngineError::BranchNotFound)?;
        let rows = self.store.docs_for_branch(branch_id)?;
        let chunk_cluster_rows = self.store.all_chunk_cluster_rows()?;
        let cluster_rows = self.store.list_cluster_rows()?;
        Ok(build_doc_summaries(rows, &chunk_cluster_rows, &cluster_rows))
    }

    /// M9: `POST /branches/{branch_id}/docs` — tag existing personal docs
    /// into an open branch for promotion review (지식 PR 재사용). While
    /// tagged, branch exclusion hides them even from the owner's own scope
    /// (intended: "under review"). Rejects shared docs
    /// (`EngineError::PromoteSharedDoc`, 400 — demoting common knowledge is
    /// not a thing), docs already tagged into any branch
    /// (`EngineError::DocAlreadyInBranch`, 400), and missing docs
    /// (`EngineError::DocNotFound`, 404). Validation is all-or-nothing: no
    /// doc is tagged unless every doc passes.
    pub fn tag_branch_docs(&self, branch_id: &str, doc_ids: &[String]) -> Result<TagBranchDocsResponse, EngineError> {
        let branch = self.store.get_branch_row(branch_id)?.ok_or(EngineError::BranchNotFound)?;
        if branch.status != "open" {
            return Err(EngineError::BranchNotOpen);
        }
        if doc_ids.is_empty() {
            return Err(EngineError::Other(anyhow::anyhow!("doc_ids must not be empty")));
        }

        for doc_id in doc_ids {
            let (owner, doc_branch) = self
                .store
                .doc_owner_and_branch(doc_id)?
                .ok_or_else(|| EngineError::DocNotFound(doc_id.clone()))?;
            if doc_branch.is_some() {
                return Err(EngineError::DocAlreadyInBranch(doc_id.clone()));
            }
            if owner.is_none() {
                return Err(EngineError::PromoteSharedDoc(doc_id.clone()));
            }
        }

        self.store.retag_docs_to_branch(doc_ids, branch_id)?;
        Ok(TagBranchDocsResponse { tagged: doc_ids.len(), branch_id: branch_id.to_string() })
    }

    /// M8: `POST /branches/{branch_id}/merge`. Omitted/`null` `doc_ids`
    /// merges every doc currently tagged into the branch; otherwise
    /// cherry-picks the given ids (intersected with actual branch
    /// membership). Retags merged docs to main (`branch_id = NULL`); once no
    /// docs remain in the branch, marks it `status="merged"`.
    /// `EngineError::BranchNotFound` (404) if missing,
    /// `EngineError::BranchNotOpen` (409) if already merged/discarded.
    ///
    /// M9: merged docs also go shared (`owner = NULL` — promotion landing);
    /// each doc's prior owner is recorded in the `branch_merge` inverse so
    /// `/rollback` restores personal ownership losslessly.
    pub fn merge_branch(&self, branch_id: &str, req: &MergeBranchRequest) -> Result<MergeBranchResponse, EngineError> {
        let branch = self.store.get_branch_row(branch_id)?.ok_or(EngineError::BranchNotFound)?;
        if branch.status != "open" {
            return Err(EngineError::BranchNotOpen);
        }

        let branch_docs = self.store.docs_for_branch(branch_id)?;
        let branch_doc_ids: HashSet<String> = branch_docs.iter().map(|d| d.doc_id.clone()).collect();
        let target_ids: Vec<String> = match &req.doc_ids {
            Some(ids) => ids.iter().filter(|id| branch_doc_ids.contains(*id)).cloned().collect(),
            None => branch_doc_ids.into_iter().collect(),
        };

        // M9: capture prior owners before clearing — the inverse needs them.
        let doc_owners = self.store.owners_for_docs(&target_ids)?;
        self.store.retag_docs_to_main(&target_ids)?;
        for (doc_id, _) in &doc_owners {
            self.store.update_doc_owner(doc_id, None)?;
        }

        let merged = target_ids.len() as i64;
        let remaining = branch.n_docs - merged;

        if remaining == 0 {
            let merged_at = chrono::Utc::now().to_rfc3339();
            self.store.set_branch_status(branch_id, "merged", Some(&merged_at))?;
        }

        journal::append_branch_merge(&self.store, branch_id, &target_ids, remaining == 0, &doc_owners)?;

        Ok(MergeBranchResponse { merged, remaining })
    }

    /// M8: `POST /branches/{branch_id}/discard`. Irreversible — deletes
    /// every doc still tagged into the branch (chunks + bm25 + docs row),
    /// then marks the branch `status="discarded"`. Only the list of
    /// `origin`s (not doc content) is journaled, since deleted docs can't be
    /// reconstructed. `EngineError::BranchNotFound` (404) if missing,
    /// `EngineError::BranchNotOpen` (409) if already merged/discarded.
    pub fn discard_branch(&self, branch_id: &str) -> Result<(), EngineError> {
        let branch = self.store.get_branch_row(branch_id)?.ok_or(EngineError::BranchNotFound)?;
        if branch.status != "open" {
            return Err(EngineError::BranchNotOpen);
        }

        let docs = self.store.docs_for_branch(branch_id)?;
        let origins: Vec<String> = docs.iter().map(|d| d.origin.clone()).collect();
        for doc in &docs {
            let old_chunk_ids = self.store.list_chunk_ids_for_doc(&doc.doc_id)?;
            self.bm25.delete_chunks(&old_chunk_ids)?;
            self.store.delete_doc(&doc.doc_id)?;
        }

        self.store.set_branch_status(branch_id, "discarded", None)?;
        journal::append_branch_discard(&self.store, branch_id, &origins)?;
        Ok(())
    }
}
