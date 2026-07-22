//! Cross-encoder reranking via fastembed's bge-reranker-v2-m3.
//!
//! Same Mutex-wrapping rationale as `embed.rs`: `TextRerank::rerank` takes
//! `&mut self`, so it's wrapped in a `Mutex` to stay `Sync` without unsafe.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use fastembed::{RerankInitOptions, RerankerModel, TextRerank};

pub struct Reranker {
    model: Mutex<TextRerank>,
}

impl Reranker {
    pub fn new(models_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(models_dir)
            .with_context(|| format!("creating models dir {}", models_dir.display()))?;
        let options = RerankInitOptions::new(RerankerModel::BGERerankerV2M3)
            .with_cache_dir(models_dir.to_path_buf())
            .with_show_download_progress(true);
        let model = TextRerank::try_new(options).context("loading bge-reranker-v2-m3 model")?;
        Ok(Self { model: Mutex::new(model) })
    }

    /// Rerank `documents` against `query`. Returns `(original_index, score)`
    /// pairs already sorted descending by score (per fastembed's contract).
    pub fn rerank(&self, query: &str, documents: &[String]) -> Result<Vec<(usize, f32)>> {
        let doc_refs: Vec<&str> = documents.iter().map(String::as_str).collect();
        let mut model = self.model.lock().expect("reranker mutex poisoned");
        let results = model
            .rerank(query, doc_refs, false, None)
            .context("reranking candidates")?;
        Ok(results.into_iter().map(|r| (r.index, r.score)).collect())
    }
}
