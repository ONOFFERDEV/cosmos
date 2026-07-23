//! `cosmos-core` CLI: `index --manifest <path> --out <dir> [--models <dir>]`,
//! `search "<q>" --out <dir> [--k]`, `serve --port <p> --out <dir> [--models <dir>]`.

use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::Deserialize;

use cosmos_core::engine::{BootstrapRequest, Engine, EngineError};

#[derive(Parser)]
#[command(name = "cosmos-core", about = "Cosmos M0 hybrid search core engine")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Ingest all documents listed in a manifest JSON file.
    Index {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value = "D:\\cosmos\\models")]
        models: PathBuf,
    },
    /// Run a hybrid search query against an existing index.
    Search {
        query: String,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value_t = cosmos_core::FINAL_TOP_K)]
        k: usize,
    },
    /// Start the HTTP API server.
    Serve {
        #[arg(long, default_value_t = 8801u16)]
        port: u16,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value = "D:\\cosmos\\models")]
        models: PathBuf,
    },
    /// Bootstrap document clusters via spherical k-means over an existing index.
    Bootstrap {
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value = "D:\\cosmos\\models")]
        models: PathBuf,
        #[arg(long, default_value_t = 5usize)]
        k_min: usize,
        #[arg(long, default_value_t = 14usize)]
        k_max: usize,
        #[arg(long, default_value_t = 42u64)]
        seed: u64,
        #[arg(long, default_value_t = false)]
        force: bool,
        /// M9: bootstrap one personal scope's docs instead of the shared scope.
        #[arg(long)]
        owner: Option<String>,
    },
    /// M9: claim every still-shared doc of a source_type for an owner
    /// (session→admin migration). Journals `owner_migrate`; no models needed.
    MigrateOwner {
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value = "session")]
        source_type: String,
        #[arg(long, default_value = "admin")]
        owner: String,
        /// Report the affected doc count without writing.
        #[arg(long, default_value_t = false)]
        dry_run: bool,
    },
    /// P4: bulk-delete docs whose origin starts with a prefix (knowledge
    /// namespace switchover). Journals `docs_delete`; no models needed.
    DeleteOrigin {
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        prefix: String,
        /// Report the affected doc count without deleting.
        #[arg(long, default_value_t = false)]
        dry_run: bool,
    },
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[allow(dead_code)]
    #[serde(default)]
    generated_at: Option<String>,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    /// Path to the source text file, relative to the manifest's own directory.
    file: String,
    origin: String,
    source_type: String,
    #[serde(default)]
    title: Option<String>,
}

fn cmd_index(manifest_path: PathBuf, out: PathBuf, models: PathBuf) -> Result<()> {
    let started = Instant::now();

    let manifest_text = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("reading manifest {}", manifest_path.display()))?;
    let manifest: Manifest = serde_json::from_str(&manifest_text).context("parsing manifest JSON")?;
    let base_dir = manifest_path.parent().unwrap_or_else(|| std::path::Path::new("."));

    let engine = Engine::new(&out, &models).context("initializing engine")?;

    let mut docs = 0i64;
    let mut chunks = 0i64;
    let mut anchor_mismatches = 0usize;
    let mut duplicates = 0i64;
    let mut replaced = 0i64;

    for entry in &manifest.entries {
        let file_path = base_dir.join(&entry.file);
        let text = std::fs::read_to_string(&file_path)
            .with_context(|| format!("reading manifest entry file {}", file_path.display()))?;
        let outcome = engine
            .ingest_doc(&entry.origin, &entry.source_type, entry.title.as_deref(), &text, None, None)
            .with_context(|| format!("ingesting {}", entry.origin))?;

        docs += 1;
        chunks += outcome.chunks;
        anchor_mismatches += outcome.anchor_mismatches;
        if outcome.duplicate {
            duplicates += 1;
        }
        if outcome.replaced {
            replaced += 1;
        }
    }

    let secs = started.elapsed().as_secs_f64();
    let stats = serde_json::json!({
        "docs": docs,
        "chunks": chunks,
        "anchor_mismatches": anchor_mismatches,
        "duplicates": duplicates,
        "replaced": replaced,
        "secs": secs,
    });
    println!("{stats}");
    Ok(())
}

fn cmd_search(query: String, out: PathBuf, k: usize) -> Result<()> {
    // CONTRACT.md's `search` CLI usage exposes no `--models` flag; the
    // default models dir is used internally for this subcommand only.
    let models = PathBuf::from(cosmos_core::DEFAULT_MODELS_DIR);
    let engine = Engine::new(&out, &models).context("initializing engine")?;
    let resp = engine.search(&query, k, &[], None, None)?;
    println!("{}", serde_json::to_string(&resp)?);
    Ok(())
}

fn cmd_serve(port: u16, out: PathBuf, models: PathBuf) -> Result<()> {
    let rt = tokio::runtime::Runtime::new().context("building tokio runtime")?;
    rt.block_on(cosmos_core::serve::run(out, models, port))
}

#[allow(clippy::too_many_arguments)]
fn cmd_bootstrap(
    out: PathBuf,
    models: PathBuf,
    k_min: usize,
    k_max: usize,
    seed: u64,
    force: bool,
    owner: Option<String>,
) -> Result<()> {
    let engine = Engine::new(&out, &models).context("initializing engine")?;
    let req = BootstrapRequest { k_min, k_max, seed, force, owner };
    match engine.bootstrap_clusters(&req) {
        Ok(resp) => {
            println!("{}", serde_json::to_string(&resp)?);
            Ok(())
        }
        Err(EngineError::ClustersExist) => {
            eprintln!("clusters already exist; pass --force to regenerate");
            std::process::exit(1);
        }
        Err(EngineError::Other(e)) => Err(e).context("bootstrapping clusters"),
        Err(other) => unreachable!("bootstrap_clusters never returns {other:?}"),
    }
}

fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();
    match cli.command {
        Commands::Index { manifest, out, models } => cmd_index(manifest, out, models),
        Commands::Search { query, out, k } => cmd_search(query, out, k),
        Commands::Serve { port, out, models } => cmd_serve(port, out, models),
        Commands::Bootstrap { out, models, k_min, k_max, seed, force, owner } => {
            cmd_bootstrap(out, models, k_min, k_max, seed, force, owner)
        }
        Commands::MigrateOwner { out, source_type, owner, dry_run } => {
            cmd_migrate_owner(out, source_type, owner, dry_run)
        }
        Commands::DeleteOrigin { out, prefix, dry_run } => cmd_delete_origin(out, prefix, dry_run),
    }
}

/// P4: origin 접두 일괄 삭제(공용지식 네임스페이스 전환). Store 직접 오픈(모델 불요).
fn cmd_delete_origin(out: PathBuf, prefix: String, dry_run: bool) -> Result<()> {
    let db_path = out.join("cosmos.sqlite3");
    let store = cosmos_core::store::Store::open(&db_path).context("opening store")?;
    let ids = store.docs_ids_by_origin_prefix(&prefix)?;
    if dry_run {
        println!("{}", serde_json::json!({ "dry_run": true, "prefix": prefix, "would_delete": ids.len() }));
        return Ok(());
    }
    let n = store.delete_docs_by_ids(&ids)?;
    cosmos_core::journal::append_docs_delete(&store, &prefix, n)?;
    println!("{}", serde_json::json!({ "prefix": prefix, "deleted": n }));
    Ok(())
}

/// M9: session→admin ownership migration. Opens the Store directly (no
/// embed/rerank models) so it runs instantly on the server.
fn cmd_migrate_owner(out: PathBuf, source_type: String, owner: String, dry_run: bool) -> Result<()> {
    let db_path = out.join("cosmos.sqlite3");
    let store = cosmos_core::store::Store::open(&db_path).context("opening store")?;
    if dry_run {
        let n = store.count_unowned_docs_for_source_type(&source_type)?;
        println!("{}", serde_json::json!({ "dry_run": true, "source_type": source_type, "owner": owner, "would_tag": n }));
        return Ok(());
    }
    let n = store.set_owner_for_source_type(&source_type, &owner)?;
    cosmos_core::journal::append_owner_migrate(&store, &source_type, &owner, n)?;
    println!("{}", serde_json::json!({ "source_type": source_type, "owner": owner, "tagged": n }));
    Ok(())
}
