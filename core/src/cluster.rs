//! Spherical k-means clustering over unit-normalized embedding vectors
//! (cosine distance), with k-means++ initialization, deterministic seeded
//! restarts (`n_init`), and silhouette-based k selection.
//!
//! Pure math, no I/O, no external RNG/clustering crate — only ~600 vectors
//! expected (M1 corpus scale), so brute-force distance computation is fine.

use crate::vector::cosine;

/// L2-normalize a vector. Zero vectors are returned unchanged (avoids NaN).
pub fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm <= f32::EPSILON {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

/// Minimal deterministic PRNG (SplitMix64) — avoids pulling in the `rand`
/// crate for a handful of seeded draws.
struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// k-means++ weighted initialization: pick the first centroid uniformly
/// (deterministically, via `rng`), then repeatedly pick the next centroid
/// with probability proportional to squared cosine distance from the
/// nearest already-chosen centroid.
fn kmeans_plus_plus_init(vectors: &[Vec<f32>], k: usize, rng: &mut SplitMix64) -> Vec<Vec<f32>> {
    let n = vectors.len();
    let mut centroids: Vec<Vec<f32>> = Vec::with_capacity(k);

    let first_idx = (rng.next_f64() * n as f64) as usize;
    let first_idx = first_idx.min(n - 1);
    centroids.push(vectors[first_idx].clone());

    while centroids.len() < k {
        let mut dist_sq = vec![0f32; n];
        let mut total = 0f64;
        for (i, v) in vectors.iter().enumerate() {
            let best_sim = centroids
                .iter()
                .map(|c| cosine(v, c))
                .fold(f32::NEG_INFINITY, f32::max);
            let d = (1.0 - best_sim).max(0.0);
            let d_sq = d * d;
            dist_sq[i] = d_sq;
            total += d_sq as f64;
        }

        if total <= 0.0 {
            // All remaining points are identical to an existing centroid;
            // fall back to deterministic round-robin selection.
            let idx = (rng.next_f64() * n as f64) as usize;
            centroids.push(vectors[idx.min(n - 1)].clone());
            continue;
        }

        let target = rng.next_f64() * total;
        let mut acc = 0f64;
        let mut chosen = n - 1;
        for (i, &d_sq) in dist_sq.iter().enumerate() {
            acc += d_sq as f64;
            if acc >= target {
                chosen = i;
                break;
            }
        }
        centroids.push(vectors[chosen].clone());
    }

    centroids
}

pub struct KMeansResult {
    pub assignments: Vec<usize>,
    pub centroids: Vec<Vec<f32>>,
    pub inertia: f32,
}

fn kmeans_single_run(vectors: &[Vec<f32>], k: usize, seed: u64, max_iter: usize) -> KMeansResult {
    let n = vectors.len();
    let mut rng = SplitMix64::new(seed);
    let mut centroids = kmeans_plus_plus_init(vectors, k, &mut rng);
    let mut assignments = vec![0usize; n];

    for _ in 0..max_iter {
        // Assign step: each point to the centroid with highest cosine similarity.
        let mut changed = false;
        for (i, v) in vectors.iter().enumerate() {
            let mut best_c = 0usize;
            let mut best_sim = f32::NEG_INFINITY;
            for (c_idx, c) in centroids.iter().enumerate() {
                let sim = cosine(v, c);
                if sim > best_sim {
                    best_sim = sim;
                    best_c = c_idx;
                }
            }
            if assignments[i] != best_c {
                changed = true;
            }
            assignments[i] = best_c;
        }

        // Update step: normalized mean of assigned points.
        let mut sums: Vec<Vec<f32>> = vec![vec![0f32; vectors[0].len()]; k];
        let mut counts = vec![0usize; k];
        for (i, v) in vectors.iter().enumerate() {
            let c = assignments[i];
            counts[c] += 1;
            for (s, x) in sums[c].iter_mut().zip(v.iter()) {
                *s += x;
            }
        }

        for c_idx in 0..k {
            if counts[c_idx] == 0 {
                // Empty cluster: reassign the point farthest (lowest cosine
                // similarity) from its own current centroid to seed this
                // cluster's new centroid.
                let mut worst_i = 0usize;
                let mut worst_sim = f32::INFINITY;
                for (i, v) in vectors.iter().enumerate() {
                    let own_c = assignments[i];
                    let sim = cosine(v, &centroids[own_c]);
                    if sim < worst_sim {
                        worst_sim = sim;
                        worst_i = i;
                    }
                }
                centroids[c_idx] = vectors[worst_i].clone();
                assignments[worst_i] = c_idx;
                changed = true;
            } else {
                let mean = &sums[c_idx];
                centroids[c_idx] = l2_normalize(mean);
            }
        }

        if !changed {
            break;
        }
    }

    let inertia: f32 = vectors
        .iter()
        .enumerate()
        .map(|(i, v)| 1.0 - cosine(v, &centroids[assignments[i]]))
        .sum();

    KMeansResult { assignments, centroids, inertia }
}

/// Run k-means `n_init` times with distinct deterministic seeds derived from
/// `seed`, `k`, and the restart index, and keep the lowest-inertia run.
/// Deterministic: identical inputs always produce identical output.
pub fn best_kmeans(vectors: &[Vec<f32>], k: usize, seed: u64, max_iter: usize, n_init: usize) -> KMeansResult {
    let mut best: Option<KMeansResult> = None;
    for init_idx in 0..n_init.max(1) {
        let run_seed = seed
            ^ (k as u64).wrapping_mul(0x9E3779B97F4A7C15)
            ^ (init_idx as u64).wrapping_mul(0xC2B2AE3D27D4EB4F);
        let result = kmeans_single_run(vectors, k, run_seed, max_iter);
        match &best {
            None => best = Some(result),
            Some(b) if result.inertia < b.inertia => best = Some(result),
            _ => {}
        }
    }
    best.expect("n_init.max(1) guarantees at least one run")
}

/// Silhouette score (cosine-distance based). Returns `f32::MIN` for
/// degenerate cases (`k < 2` or `n <= k`) where silhouette is undefined.
pub fn silhouette_score(vectors: &[Vec<f32>], assignments: &[usize], k: usize) -> f32 {
    let n = vectors.len();
    if k < 2 || n <= k {
        return f32::MIN;
    }

    let mut total = 0f32;
    for i in 0..n {
        let own_cluster = assignments[i];
        let mut a_sum = 0f32;
        let mut a_count = 0usize;
        let mut b_sums = vec![0f32; k];
        let mut b_counts = vec![0usize; k];

        for j in 0..n {
            if i == j {
                continue;
            }
            let dist = 1.0 - cosine(&vectors[i], &vectors[j]);
            if assignments[j] == own_cluster {
                a_sum += dist;
                a_count += 1;
            } else {
                b_sums[assignments[j]] += dist;
                b_counts[assignments[j]] += 1;
            }
        }

        let a = if a_count > 0 { a_sum / a_count as f32 } else { 0.0 };
        let b = (0..k)
            .filter(|&c| c != own_cluster && b_counts[c] > 0)
            .map(|c| b_sums[c] / b_counts[c] as f32)
            .fold(f32::INFINITY, f32::min);

        let s = if a.max(b) > 0.0 { (b - a) / a.max(b) } else { 0.0 };
        total += s;
    }

    total / n as f32
}

pub struct ClusterChoice {
    pub k: usize,
    pub result: KMeansResult,
    pub silhouette: f32,
}

/// Try every k in `[k_min, k_max]` (clamped to a valid range for `n`
/// vectors), run `best_kmeans` for each, and return the choice with the
/// highest silhouette score. Ties favor the smaller k (strict `>` compare).
pub fn choose_best_k(
    vectors: &[Vec<f32>],
    k_min: usize,
    k_max: usize,
    seed: u64,
    max_iter: usize,
    n_init: usize,
) -> ClusterChoice {
    let n = vectors.len();
    let lo = k_min.max(1).min(n.max(1));
    let hi = k_max.max(lo).min(n.max(1));

    let mut best: Option<ClusterChoice> = None;
    for k in lo..=hi {
        let result = best_kmeans(vectors, k, seed, max_iter, n_init);
        let silhouette = silhouette_score(vectors, &result.assignments, k);
        match &best {
            None => best = Some(ClusterChoice { k, result, silhouette }),
            Some(b) if silhouette > b.silhouette => best = Some(ClusterChoice { k, result, silhouette }),
            _ => {}
        }
    }

    best.expect("lo..=hi is always non-empty since lo <= hi")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_two_blobs() -> Vec<Vec<f32>> {
        // Two clearly separated blobs in a small-dim space, unit-normalized.
        let mut vectors = Vec::new();
        for i in 0..10 {
            let jitter = (i as f32) * 0.001;
            vectors.push(l2_normalize(&[1.0 + jitter, 0.01, 0.0, 0.0]));
        }
        for i in 0..10 {
            let jitter = (i as f32) * 0.001;
            vectors.push(l2_normalize(&[0.0, 0.0, 0.01, 1.0 + jitter]));
        }
        vectors
    }

    #[test]
    fn kmeans_is_deterministic_for_same_seed() {
        let vectors = synthetic_two_blobs();
        let r1 = best_kmeans(&vectors, 2, 42, 50, 4);
        let r2 = best_kmeans(&vectors, 2, 42, 50, 4);
        assert_eq!(r1.assignments, r2.assignments);
        assert_eq!(r1.centroids, r2.centroids);
    }

    #[test]
    fn silhouette_selects_k_two_for_clearly_separated_blobs() {
        let vectors = synthetic_two_blobs();
        let choice = choose_best_k(&vectors, 2, 5, 42, 50, 4);
        assert_eq!(choice.k, 2);

        // All points in the first blob share one cluster label, all points
        // in the second blob share the other (order-agnostic).
        let first_label = choice.result.assignments[0];
        for &a in &choice.result.assignments[0..10] {
            assert_eq!(a, first_label);
        }
        let second_label = choice.result.assignments[10];
        assert_ne!(first_label, second_label);
        for &a in &choice.result.assignments[10..20] {
            assert_eq!(a, second_label);
        }
    }
}
