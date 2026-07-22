//! Dense text embedding via fastembed's BGE-M3 (1024-dim).
//!
//! `TextEmbedding` requires `&mut self` for `embed`, so it is wrapped in a
//! `Mutex` here. `Mutex<T>: Sync` only requires `T: Send`, so as long as
//! `TextEmbedding` is `Send` this makes `Embedder` safely shareable across
//! axum handlers without any `unsafe impl`.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use anyhow::{Context, Result};
use fastembed::{EmbeddingModel, InitOptionsWithLength, TextEmbedding};

pub struct Embedder {
    model: Mutex<TextEmbedding>,
    /// Number of `embed` calls made so far. `AtomicUsize` is `Send + Sync` by
    /// construction, preserving `Embedder`'s no-`unsafe impl` Send+Sync
    /// guarantee. Used as test evidence that duplicate-doc ingests skip
    /// embedding entirely.
    call_count: AtomicUsize,
}

impl Embedder {
    pub fn new(models_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(models_dir)
            .with_context(|| format!("creating models dir {}", models_dir.display()))?;
        let options = InitOptionsWithLength::new(EmbeddingModel::BGEM3)
            .with_cache_dir(models_dir.to_path_buf())
            .with_show_download_progress(true);
        let model = TextEmbedding::try_new(options).context("loading BGE-M3 embedding model")?;
        Ok(Self { model: Mutex::new(model), call_count: AtomicUsize::new(0) })
    }

    /// Embed a batch of texts, returning one 1024-dim vector per input.
    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.call_count.fetch_add(1, Ordering::SeqCst);
        let mut model = self.model.lock().expect("embedder mutex poisoned");
        model.embed(texts.to_vec(), None).context("embedding batch")
    }

    /// Embed a single text (e.g. a search query).
    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        let mut vecs = self.embed(&[text.to_string()])?;
        vecs.pop().context("embedder returned no vectors")
    }

    /// Number of times `embed` has been called (test evidence).
    pub fn embed_call_count(&self) -> usize {
        self.call_count.load(Ordering::SeqCst)
    }
}
