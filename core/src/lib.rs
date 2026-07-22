pub mod bm25;
pub mod chunk;
pub mod cluster;
pub mod embed;
pub mod engine;
pub mod frontmatter;
pub mod fuse;
pub mod journal;
pub mod parse;
pub mod rerank;
pub mod serve;
pub mod store;
pub mod vector;
pub mod wikilinks;

/// Search pipeline constants (CONTRACT.md).
pub const TOP_M_BM25: usize = 20;
pub const TOP_N_VEC: usize = 20;
pub const RRF_POOL: usize = 16;
pub const FINAL_TOP_K: usize = 6;
pub const RRF_K: f32 = 60.0;

/// Chunking constants (CONTRACT.md).
pub const CHUNK_TARGET_BYTES: usize = 1500;
pub const CHUNK_OVERLAP_BYTES: usize = 200;

/// Embedding dimensionality (BGE-M3).
pub const EMBED_DIM: usize = 1024;

/// M2: ingest-time cluster assignment fit threshold (CONTRACT.md). A doc's
/// argmax centroid cosine similarity below this marks `docs.meta_json.low_fit`.
pub const FIT_THRESHOLD: f32 = 0.5;

pub const DEFAULT_MODELS_DIR: &str = "D:\\cosmos\\models";

/// M4: lifecycle proposal defaults (team-lead spec). `birth_min` is the
/// minimum group size, `birth_cohesion` the minimum mean intra-group cosine,
/// and `merge_sim` the minimum active-cluster centroid cosine, for a
/// `GET /lifecycle/proposals` candidate to qualify.
pub const DEFAULT_BIRTH_MIN: usize = 12;
pub const DEFAULT_BIRTH_COHESION: f32 = 0.55;
pub const DEFAULT_MERGE_SIM: f32 = 0.85;
