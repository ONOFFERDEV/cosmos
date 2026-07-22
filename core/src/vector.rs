//! Vector storage abstraction.
//!
//! M0 implementation: embeddings live in the `chunks.embedding` BLOB column
//! (f32 little-endian) of the shared SQLite database — no separate vector
//! table. Search loads all embeddings and brute-forces cosine similarity.
//! LanceDB is deferred to M2; do not add it now.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::Connection;

pub trait VectorStore: Send + Sync {
    /// Nearest chunks to `query` by cosine similarity, sorted descending,
    /// truncated to `limit`. Returns `(chunk_id, score)` pairs.
    fn search(&self, query: &[f32], limit: usize) -> Result<Vec<(String, f32)>>;

    /// Same as `search`, but restricted to `allowed_ids` when `Some`
    /// (cluster-scoped search). `None` behaves identically to `search`.
    fn search_filtered(
        &self,
        query: &[f32],
        limit: usize,
        allowed_ids: Option<&HashSet<String>>,
    ) -> Result<Vec<(String, f32)>>;
}

/// Serialize a f32 vector to little-endian bytes for the `embedding` BLOB column.
pub fn f32_vec_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Deserialize little-endian bytes back into a f32 vector.
pub fn bytes_to_f32_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut dot = 0f32;
    let mut na = 0f32;
    let mut nb = 0f32;
    for i in 0..n {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Brute-force cosine vector search reading directly from `chunks.embedding`.
pub struct SqliteVectorStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteVectorStore {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }
}

impl VectorStore for SqliteVectorStore {
    fn search(&self, query: &[f32], limit: usize) -> Result<Vec<(String, f32)>> {
        self.search_filtered(query, limit, None)
    }

    fn search_filtered(
        &self,
        query: &[f32],
        limit: usize,
        allowed_ids: Option<&HashSet<String>>,
    ) -> Result<Vec<(String, f32)>> {
        let conn = self.conn.lock().expect("sqlite connection mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT id, embedding FROM chunks")
            .context("preparing vector scan statement")?;
        let mut scored: Vec<(String, f32)> = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let blob: Vec<u8> = row.get(1)?;
                Ok((id, blob))
            })
            .context("querying chunks for vector search")?
            .filter_map(|r| r.ok())
            .filter(|(id, _)| allowed_ids.is_none_or(|allowed| allowed.contains(id)))
            .map(|(id, blob)| {
                let vec = bytes_to_f32_vec(&blob);
                let score = cosine(query, &vec);
                (id, score)
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored.truncate(limit);
        Ok(scored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_bytes() {
        let v = vec![0.1f32, -0.5, 1.0, 2.25];
        let bytes = f32_vec_to_bytes(&v);
        let back = bytes_to_f32_vec(&bytes);
        assert_eq!(v, back);
    }

    #[test]
    fn cosine_identical_is_one() {
        let v = vec![1.0f32, 2.0, 3.0];
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_is_zero() {
        let a = vec![1.0f32, 0.0];
        let b = vec![0.0f32, 1.0];
        assert!(cosine(&a, &b).abs() < 1e-6);
    }

    #[test]
    fn search_filtered_excludes_ids_outside_allowed_set() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch("CREATE TABLE chunks(id TEXT PRIMARY KEY, embedding BLOB NOT NULL);")
            .expect("create chunks table");
        let query = vec![1.0f32, 0.0, 0.0];
        for (id, v) in [
            ("a", vec![1.0f32, 0.0, 0.0]),
            ("b", vec![0.9f32, 0.1, 0.0]),
            ("c", vec![0.0f32, 1.0, 0.0]),
        ] {
            conn.execute(
                "INSERT INTO chunks(id, embedding) VALUES (?1, ?2)",
                rusqlite::params![id, f32_vec_to_bytes(&v)],
            )
            .expect("insert chunk");
        }
        let store = SqliteVectorStore::new(Arc::new(Mutex::new(conn)));

        let unfiltered = store.search_filtered(&query, 10, None).expect("unfiltered search");
        assert_eq!(unfiltered.len(), 3);

        let mut allowed = HashSet::new();
        allowed.insert("a".to_string());
        allowed.insert("c".to_string());
        let filtered = store.search_filtered(&query, 10, Some(&allowed)).expect("filtered search");
        let ids: HashSet<&str> = filtered.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("a"));
        assert!(ids.contains("c"));
        assert!(!ids.contains("b"));
    }
}
