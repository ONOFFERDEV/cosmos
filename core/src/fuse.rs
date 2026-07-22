//! Reciprocal Rank Fusion (RRF) of BM25 and vector search rankings.

use std::collections::HashMap;

use crate::RRF_K;

#[derive(Debug, Clone)]
pub struct RrfEntry {
    pub chunk_id: String,
    /// 1-based rank in the BM25 result list, if present there.
    pub bm25_rank: Option<usize>,
    /// 1-based rank in the vector result list, if present there.
    pub vec_rank: Option<usize>,
    pub rrf_score: f32,
}

/// Fuse BM25 and vector results (both `(chunk_id, score)`, already sorted
/// descending) via Reciprocal Rank Fusion (k = `RRF_K`). Returns entries
/// sorted descending by `rrf_score`, truncated to `pool_size`.
pub fn rrf_fuse(bm25: &[(String, f32)], vec: &[(String, f32)], pool_size: usize) -> Vec<RrfEntry> {
    let mut ranks: HashMap<String, (Option<usize>, Option<usize>)> = HashMap::new();

    for (i, (chunk_id, _)) in bm25.iter().enumerate() {
        ranks.entry(chunk_id.clone()).or_insert((None, None)).0 = Some(i + 1);
    }
    for (i, (chunk_id, _)) in vec.iter().enumerate() {
        ranks.entry(chunk_id.clone()).or_insert((None, None)).1 = Some(i + 1);
    }

    let mut entries: Vec<RrfEntry> = ranks
        .into_iter()
        .map(|(chunk_id, (bm25_rank, vec_rank))| {
            let mut score = 0f32;
            if let Some(r) = bm25_rank {
                score += 1.0 / (RRF_K + r as f32);
            }
            if let Some(r) = vec_rank {
                score += 1.0 / (RRF_K + r as f32);
            }
            RrfEntry { chunk_id, bm25_rank, vec_rank, rrf_score: score }
        })
        .collect();

    entries.sort_by(|a, b| b.rrf_score.total_cmp(&a.rrf_score));
    entries.truncate(pool_size);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agreeing_top_result_wins() {
        let bm25 = vec![("a".to_string(), 5.0), ("b".to_string(), 3.0)];
        let vec = vec![("a".to_string(), 0.9), ("c".to_string(), 0.5)];
        let fused = rrf_fuse(&bm25, &vec, 10);
        assert_eq!(fused[0].chunk_id, "a");
        assert_eq!(fused[0].bm25_rank, Some(1));
        assert_eq!(fused[0].vec_rank, Some(1));
    }

    #[test]
    fn pool_size_truncates() {
        let bm25: Vec<(String, f32)> = (0..30).map(|i| (format!("c{i}"), 1.0)).collect();
        let vec: Vec<(String, f32)> = Vec::new();
        let fused = rrf_fuse(&bm25, &vec, 16);
        assert_eq!(fused.len(), 16);
    }

    #[test]
    fn union_of_both_lists() {
        let bm25 = vec![("a".to_string(), 1.0)];
        let vec = vec![("b".to_string(), 1.0)];
        let fused = rrf_fuse(&bm25, &vec, 10);
        assert_eq!(fused.len(), 2);
    }
}
