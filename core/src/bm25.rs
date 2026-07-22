//! BM25 lexical search via tantivy, with a Korean-aware tokenizer (lindera,
//! ko-dic). Same tokenizer is used at index time and query time.
//!
//! `IndexWriter` is never stored as a struct field — a fresh one is created
//! per mutating call, committed, and dropped, guarded by `write_lock` to
//! serialize concurrent index mutations (relevant for concurrent /ingest
//! requests).

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use lindera_tantivy::tokenizer::LinderaTokenizer;
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, STORED, STRING};
use tantivy::{doc, Index, IndexReader, ReloadPolicy, TantivyDocument, Term};

const TOKENIZER_NAME: &str = "lang_ko";

pub struct Bm25Index {
    index: Index,
    reader: IndexReader,
    chunk_id_field: Field,
    text_field: Field,
    write_lock: Mutex<()>,
}

/// Strip a natural-language query down to unicode letters, digits, and
/// whitespace only, so tantivy's boolean-grammar QueryParser doesn't choke
/// on stray punctuation (quotes, colons, parens, etc.).
pub fn sanitize_query(q: &str) -> String {
    let cleaned: String = q
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn build_schema() -> (Schema, Field, Field) {
    let mut builder = Schema::builder();
    let chunk_id_field = builder.add_text_field("chunk_id", STRING | STORED);
    let text_indexing = TextFieldIndexing::default()
        .set_tokenizer(TOKENIZER_NAME)
        .set_index_option(IndexRecordOption::WithFreqsAndPositions);
    let text_options = TextOptions::default().set_indexing_options(text_indexing);
    let text_field = builder.add_text_field("text", text_options);
    (builder.build(), chunk_id_field, text_field)
}

fn korean_tokenizer() -> Result<LinderaTokenizer> {
    let dictionary = load_dictionary("embedded://ko-dic").context("loading embedded ko-dic dictionary")?;
    let segmenter = Segmenter::new(Mode::Normal, dictionary, None);
    Ok(LinderaTokenizer::from_segmenter(segmenter))
}

impl Bm25Index {
    pub fn open_or_create(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).with_context(|| format!("creating bm25 dir {}", dir.display()))?;
        let (schema, chunk_id_field, text_field) = build_schema();
        let mmap_dir = MmapDirectory::open(dir).with_context(|| format!("opening mmap dir {}", dir.display()))?;
        let index = Index::open_or_create(mmap_dir, schema).context("opening/creating tantivy index")?;
        index.tokenizers().register(TOKENIZER_NAME, korean_tokenizer()?);
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .context("building index reader")?;
        Ok(Self { index, reader, chunk_id_field, text_field, write_lock: Mutex::new(()) })
    }

    /// Add `(chunk_id, text)` pairs to the index and commit.
    pub fn add_chunks(&self, chunks: &[(String, String)]) -> Result<()> {
        let _guard = self.write_lock.lock().expect("bm25 write lock poisoned");
        let mut writer = self.index.writer::<TantivyDocument>(50_000_000).context("creating tantivy index writer")?;
        for (chunk_id, text) in chunks {
            writer.add_document(doc!(
                self.chunk_id_field => chunk_id.as_str(),
                self.text_field => text.as_str(),
            ))?;
        }
        writer.commit().context("committing bm25 add")?;
        self.reader.reload().context("reloading bm25 reader after add")?;
        Ok(())
    }

    /// Delete chunks by id (used when a doc is replaced on reindex).
    pub fn delete_chunks(&self, chunk_ids: &[String]) -> Result<()> {
        if chunk_ids.is_empty() {
            return Ok(());
        }
        let _guard = self.write_lock.lock().expect("bm25 write lock poisoned");
        let mut writer = self.index.writer::<TantivyDocument>(50_000_000).context("creating tantivy index writer")?;
        for chunk_id in chunk_ids {
            writer.delete_term(Term::from_field_text(self.chunk_id_field, chunk_id));
        }
        writer.commit().context("committing bm25 delete")?;
        self.reader.reload().context("reloading bm25 reader after delete")?;
        Ok(())
    }

    /// Search, returning `(chunk_id, score)` pairs sorted descending by score.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<(String, f32)>> {
        let sanitized = sanitize_query(query);
        if sanitized.is_empty() {
            return Ok(Vec::new());
        }
        let searcher = self.reader.searcher();
        let parser = QueryParser::for_index(&self.index, vec![self.text_field]);
        let parsed = parser.parse_query(&sanitized).context("parsing bm25 query")?;
        let top_docs = searcher.search(&parsed, &TopDocs::with_limit(limit)).context("running bm25 search")?;

        let mut out = Vec::with_capacity(top_docs.len());
        for (score, addr) in top_docs {
            let doc: tantivy::TantivyDocument = searcher.doc(addr).context("fetching bm25 doc")?;
            if let Some(chunk_id) = doc.get_first(self.chunk_id_field).and_then(|v| v.as_str()) {
                out.push((chunk_id.to_string(), score));
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_punctuation() {
        assert_eq!(sanitize_query("한국어 테스트: \"질의\"!"), "한국어 테스트 질의");
    }

    #[test]
    fn index_and_search_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("cosmos-bm25-test-{}", uuid::Uuid::new_v4()));
        let idx = Bm25Index::open_or_create(&tmp).expect("open_or_create");
        idx.add_chunks(&[
            ("c1".into(), "한국어 테스트 문장입니다".into()),
            ("c2".into(), "완전히 다른 내용의 문서".into()),
        ])
        .expect("add_chunks");
        let results = idx.search("한국어 테스트", 10).expect("search");
        assert!(!results.is_empty());
        assert_eq!(results[0].0, "c1");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
