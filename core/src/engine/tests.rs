// engine 통합 테스트 — 원 engine.rs의 #[cfg(test)] mod tests 본문 그대로 이동.

    use super::*;

    fn temp_engine() -> (Engine, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("cosmos-engine-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let out_dir = dir.join("out");
        let models_dir = std::path::PathBuf::from(crate::DEFAULT_MODELS_DIR);
        let engine = Engine::new(&out_dir, &models_dir).expect("Engine::new");
        (engine, dir)
    }

    /// Exercises ingest_doc's anchor-invariant self-check and dedup/replace
    /// logic end-to-end. Requires network access on first run (fastembed
    /// model download) — marked `#[ignore]` so `cargo test` stays offline
    /// by default; run explicitly via `cargo test -- --ignored` when models
    /// are cached or network is available.
    #[test]
    #[ignore]
    fn ingest_dedup_and_replace() {
        let (engine, dir) = temp_engine();

        let out1 = engine.ingest_doc("origin://a", "manual", Some("T"), "Hello world.\n\nSecond para.", None, None).unwrap();
        assert!(!out1.duplicate);
        assert!(!out1.replaced);
        assert_eq!(out1.anchor_mismatches, 0);

        let out2 = engine.ingest_doc("origin://a", "manual", Some("T"), "Hello world.\n\nSecond para.", None, None).unwrap();
        assert!(out2.duplicate);

        let out3 = engine.ingest_doc("origin://a", "manual", Some("T"), "Different content entirely.", None, None).unwrap();
        assert!(out3.replaced);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pure boundary-condition check for the `low_fit` threshold: `fit <
    /// FIT_THRESHOLD` (0.5) sets `low_fit:true`; `fit == FIT_THRESHOLD` and
    /// `fit > FIT_THRESHOLD` do not. No Engine/model dependency, so this runs
    /// under plain `cargo test` (not `#[ignore]`).
    #[test]
    fn low_fit_flag_boundary() {
        let below = doc_meta_json_for_fit(0.49);
        assert!(below.contains("\"low_fit\":true"), "expected low_fit at 0.49, got: {below}");

        let at = doc_meta_json_for_fit(0.5);
        assert!(!at.contains("low_fit"), "expected no low_fit at exactly 0.5, got: {at}");

        let above = doc_meta_json_for_fit(0.51);
        assert!(!above.contains("low_fit"), "expected no low_fit at 0.51, got: {above}");
    }

    /// M3 pure-aggregation check: a doc with an assigned chunk + a matching
    /// `meta_json.fit` gets both `cluster_slug` and `fit` filled; a doc with
    /// no chunk cluster_ids and empty `meta_json` gets both as `None`. No
    /// `Engine`/model construction, so this runs under plain `cargo test`.
    #[test]
    fn doc_summaries_fill_slug_and_fit_when_assigned_null_when_not() {
        let rows = vec![
            DocSummaryRow {
                doc_id: "d1".into(),
                origin: "origin://d1".into(),
                source_type: "manual".into(),
                title: Some("Assigned".into()),
                n_chunks: 2,
                ingested_at: "2026-07-13T00:00:00Z".into(),
                meta_json: r#"{"fit":0.87}"#.into(),
                owner: None,
            },
            DocSummaryRow {
                doc_id: "d2".into(),
                origin: "origin://d2".into(),
                source_type: "manual".into(),
                title: Some("Unassigned".into()),
                n_chunks: 1,
                ingested_at: "2026-07-13T00:00:01Z".into(),
                meta_json: "{}".into(),
                owner: None,
            },
        ];
        let chunk_cluster_rows = vec![
            ("c1".to_string(), "d1".to_string(), r#"["cl-coffee"]"#.to_string()),
            ("c2".to_string(), "d1".to_string(), r#"["cl-coffee"]"#.to_string()),
            ("c3".to_string(), "d2".to_string(), "[]".to_string()),
        ];
        let cluster_rows = vec![ClusterRow {
            id: "cl-coffee".into(),
            slug: Some("coffee".into()),
            name: None,
            description: None,
            status: "active".into(),
            centroid: None,
            updated_at: None,
            owner: None,
        }];

        let summaries = build_doc_summaries(rows, &chunk_cluster_rows, &cluster_rows);

        let d1 = summaries.iter().find(|s| s.doc_id == "d1").unwrap();
        assert_eq!(d1.cluster_slug.as_deref(), Some("coffee"), "assigned doc should get its cluster slug");
        assert_eq!(d1.fit, Some(0.87), "assigned doc should get its recorded fit");

        let d2 = summaries.iter().find(|s| s.doc_id == "d2").unwrap();
        assert!(d2.cluster_slug.is_none(), "unassigned doc should have null cluster_slug");
        assert!(d2.fit.is_none(), "unassigned doc should have null fit");
    }

    /// M3: bootstrap-assigned docs get `cluster_slug` from chunk
    /// `cluster_ids` but never `fit` (`/clusters/bootstrap` never writes
    /// `meta_json`) — confirms "부트스트랩 배정 문서는 null 정상" is exactly
    /// what the aggregation produces.
    #[test]
    fn doc_summary_slug_without_fit_for_bootstrap_only_assignment() {
        let rows = vec![DocSummaryRow {
            doc_id: "d3".into(),
            origin: "origin://d3".into(),
            source_type: "manual".into(),
            title: None,
            n_chunks: 1,
            ingested_at: "2026-07-13T00:00:02Z".into(),
            meta_json: "{}".into(),
            owner: None,
        }];
        let chunk_cluster_rows = vec![("c4".to_string(), "d3".to_string(), r#"["cl-rocket"]"#.to_string())];
        let cluster_rows = vec![ClusterRow {
            id: "cl-rocket".into(),
            slug: Some("rocket".into()),
            name: None,
            description: None,
            status: "active".into(),
            centroid: None,
            updated_at: None,
            owner: None,
        }];

        let summaries = build_doc_summaries(rows, &chunk_cluster_rows, &cluster_rows);
        let d3 = &summaries[0];
        assert_eq!(d3.cluster_slug.as_deref(), Some("rocket"));
        assert!(d3.fit.is_none(), "bootstrap-only assignment should not set fit");
    }

    /// M3: majority-vote tie-break is deterministic — a doc whose chunks
    /// split evenly across two clusters resolves to the lexicographically
    /// smallest cluster id's slug every time.
    #[test]
    fn doc_majority_cluster_tie_break_is_deterministic() {
        let chunk_cluster_rows = vec![
            ("c1".to_string(), "d1".to_string(), r#"["cl-b"]"#.to_string()),
            ("c2".to_string(), "d1".to_string(), r#"["cl-a"]"#.to_string()),
        ];
        let winners = doc_majority_cluster_ids(&chunk_cluster_rows);
        assert_eq!(winners.get("d1").map(String::as_str), Some("cl-a"));
    }

    /// With zero active clusters, ingest must leave `cluster_slug`/`fit`
    /// unset and must not emit an `assign` journal event — behavior
    /// identical to pre-M2. Requires the real Embedder (network on first
    /// run), so `#[ignore]`.
    #[test]
    #[ignore]
    fn ingest_no_assignment_when_no_clusters() {
        let (engine, dir) = temp_engine();

        let out = engine
            .ingest_doc("origin://no-clusters", "manual", Some("T"), "Some standalone document text.", None, None)
            .unwrap();
        assert!(out.cluster_slug.is_none());
        assert!(out.fit.is_none());

        let journal = engine.journal(0).unwrap();
        assert!(journal.events.iter().all(|e| e.kind != "assign"));
        assert!(journal.events.iter().any(|e| e.kind == "ingest"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End-to-end: bootstrap two topic clusters (coffee vs. rocketry), ingest
    /// a new coffee-topic doc and confirm it's argmax-assigned to the coffee
    /// cluster with a recorded fit + assign journal event, then resend the
    /// identical doc and confirm duplicate detection short-circuits before
    /// embedding is ever invoked (proven via `embed_call_count`). Requires
    /// the real Embedder, so `#[ignore]`.
    #[test]
    #[ignore]
    fn ingest_assigns_to_argmax_cluster_and_skips_embed_on_duplicate() {
        let (engine, dir) = temp_engine();

        engine
            .ingest_doc(
                "origin://coffee-1",
                "manual",
                Some("Pour-over"),
                "Pour-over coffee brewing requires a slow, steady pour of hot water over ground coffee beans in a paper filter, extracting oils and flavor compounds over about three minutes.",
                None,
                None,
            )
            .unwrap();
        engine
            .ingest_doc(
                "origin://coffee-2",
                "manual",
                Some("Cold brew"),
                "Cold brew coffee is made by steeping coarse coffee grounds in room-temperature water for twelve to twenty-four hours, producing a smooth, low-acid concentrate.",
                None,
                None,
            )
            .unwrap();
        engine
            .ingest_doc(
                "origin://rocket-1",
                "manual",
                Some("Orbital mechanics"),
                "Orbital mechanics describes how spacecraft trajectories are governed by gravitational forces, requiring precise delta-v burns to transfer between elliptical orbits.",
                None,
                None,
            )
            .unwrap();
        engine
            .ingest_doc(
                "origin://rocket-2",
                "manual",
                Some("Rocket engine"),
                "A rocket engine achieves thrust by expelling propellant at high velocity through a converging-diverging nozzle, converting thermal energy into kinetic energy.",
                None,
                None,
            )
            .unwrap();

        let bootstrap = engine
            .bootstrap_clusters(&BootstrapRequest { k_min: 2, k_max: 2, seed: 42, force: false, owner: None })
            .unwrap();

        let coffee_slug = bootstrap
            .clusters
            .iter()
            .find(|c| c.sample.iter().any(|s| s.origin.starts_with("origin://coffee")))
            .map(|c| c.summary.slug.clone())
            .expect("a cluster should contain the coffee-topic docs");

        let calls_before_new_doc = engine.embedder.embed_call_count();

        let out = engine
            .ingest_doc(
                "origin://coffee-3",
                "manual",
                Some("French press"),
                "French press coffee brewing involves steeping coarse coffee grounds in hot water for four minutes before pressing a metal mesh filter down to separate the grounds.",
                None,
                None,
            )
            .unwrap();

        assert!(!out.duplicate);
        assert_eq!(out.cluster_slug.as_deref(), Some(coffee_slug.as_str()));
        assert!(out.fit.is_some());
        assert!(calls_before_new_doc < engine.embedder.embed_call_count(), "new doc ingest should call embed");

        let journal = engine.journal(0).unwrap();
        assert!(journal
            .events
            .iter()
            .any(|e| e.kind == "assign" && e.payload["doc_id"] == out.doc_id && e.payload["fit"].is_number()));

        let calls_before_resend = engine.embedder.embed_call_count();

        let resend = engine
            .ingest_doc(
                "origin://coffee-3",
                "manual",
                Some("French press"),
                "French press coffee brewing involves steeping coarse coffee grounds in hot water for four minutes before pressing a metal mesh filter down to separate the grounds.",
                None,
                None,
            )
            .unwrap();

        assert!(resend.duplicate);
        assert_eq!(
            calls_before_resend,
            engine.embedder.embed_call_count(),
            "duplicate resend must not invoke embed"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M7: confirms the duplicate-ingest path (early-return branch) still
    /// upserts the entity, so daily rescans self-heal an entity row without
    /// needing a backfill command. Deletes the entity after the first
    /// ingest so the re-ingest's self-heal — not the original insert — is
    /// what proves the row reappears. Requires the real Embedder, so
    /// `#[ignore]`.
    #[test]
    #[ignore]
    fn ingest_duplicate_path_upserts_entity() {
        let (engine, dir) = temp_engine();

        let text = "---\ntitle: Pour-over guide\ncategory: brewing\nupdated: 2026-01-01\n---\n\nPour-over coffee brewing requires a slow, steady pour of hot water over ground coffee beans in a paper filter.";

        let out1 = engine.ingest_doc("origin://pourover", "manual", Some("Pour-over"), text, None, None).unwrap();
        assert!(!out1.duplicate);

        let entities = engine.list_entities(None, None).unwrap();
        let entity = entities.iter().find(|e| e.doc_id == out1.doc_id).expect("entity should exist after first ingest");
        assert_eq!(entity.name, "Pour-over guide");
        assert_eq!(entity.kind, "brewing");

        engine.store.delete_entity(&out1.doc_id).unwrap();
        assert!(engine.list_entities(None, None).unwrap().iter().all(|e| e.doc_id != out1.doc_id));

        let out2 = engine.ingest_doc("origin://pourover", "manual", Some("Pour-over"), text, None, None).unwrap();
        assert!(out2.duplicate);
        assert_eq!(out2.doc_id, out1.doc_id);

        let entities_after = engine.list_entities(None, None).unwrap();
        let entity_after = entities_after
            .iter()
            .find(|e| e.doc_id == out1.doc_id)
            .expect("duplicate-path re-ingest should self-heal the entity row");
        assert_eq!(entity_after.name, "Pour-over guide");
        assert_eq!(entity_after.kind, "brewing");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: `owner` and `branch_id` are mutually exclusive on ingest. The
    /// conflict check runs before the chunk/embed step, so no real Embedder
    /// call is ever reached; no `#[ignore]` needed.
    #[test]
    fn ingest_owner_and_branch_id_conflict() {
        let (engine, dir) = temp_engine();

        let branch = engine
            .create_branch(&CreateBranchRequest { name: "feature-owner-conflict".to_string(), created_by: None })
            .expect("create_branch");

        let err = engine
            .ingest_doc("origin://conflict", "manual", None, "Some text.", Some(branch.id.as_str()), Some("alice"))
            .unwrap_err();
        assert!(matches!(err, EngineError::OwnerBranchConflict));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: an owner's first ingest with no existing personal cluster should
    /// auto-birth a `personal-<owner>` cluster (centroid = the doc's own
    /// vector, fit = 1.0), assign the doc to it, and journal `cluster_birth`.
    /// Requires the real Embedder, so `#[ignore]`.
    #[test]
    #[ignore]
    fn ingest_owner_first_doc_auto_births_personal_cluster() {
        let (engine, dir) = temp_engine();

        let out = engine
            .ingest_doc(
                "origin://alice-note-1",
                "manual",
                Some("Alice's first note"),
                "Alice keeps a private journal about her weekend hiking trips in the mountains.",
                None,
                Some("alice"),
            )
            .unwrap();

        assert!(!out.duplicate);
        assert_eq!(out.cluster_slug.as_deref(), Some("personal-alice"));
        assert_eq!(out.fit, Some(1.0));

        let clusters = engine.store.clusters_for_owner(Some("alice")).unwrap();
        assert_eq!(clusters.len(), 1, "exactly one personal cluster should exist for alice");
        assert_eq!(clusters[0].slug.as_deref(), Some("personal-alice"));

        let journal = engine.journal(0).unwrap();
        let birth = journal.events.iter().find(|e| e.kind == "cluster_birth").expect("cluster_birth event recorded");
        assert_eq!(birth.payload["slug"], "personal-alice");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: a second doc from the same owner should join the existing
    /// personal cluster via argmax rather than birthing a second one.
    /// Requires the real Embedder, so `#[ignore]`.
    #[test]
    #[ignore]
    fn ingest_owner_second_doc_joins_existing_personal_cluster() {
        let (engine, dir) = temp_engine();

        let out1 = engine
            .ingest_doc(
                "origin://bob-note-1",
                "manual",
                Some("Bob's first note"),
                "Bob writes about his home vegetable garden and composting routine every weekend.",
                None,
                Some("bob"),
            )
            .unwrap();
        let out2 = engine
            .ingest_doc(
                "origin://bob-note-2",
                "manual",
                Some("Bob's second note"),
                "Bob also tracks how his tomato and pepper plants are doing in the garden this season.",
                None,
                Some("bob"),
            )
            .unwrap();

        assert_eq!(out1.cluster_slug.as_deref(), Some("personal-bob"));
        assert_eq!(
            out2.cluster_slug.as_deref(),
            Some("personal-bob"),
            "second doc should join the same personal cluster, not birth a new one"
        );

        let clusters = engine.store.clusters_for_owner(Some("bob")).unwrap();
        assert_eq!(clusters.len(), 1, "only one personal cluster should exist for bob after two ingests");

        let journal = engine.journal(0).unwrap();
        let births = journal.events.iter().filter(|e| e.kind == "cluster_birth").count();
        assert_eq!(births, 1, "only the first ingest should journal a cluster_birth");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: re-ingesting a duplicate doc under a new owner should self-heal
    /// the `docs.owner` column via `update_doc_owner`, mirroring the
    /// existing entity self-heal path. Requires the real Embedder for the
    /// first ingest, so `#[ignore]`.
    #[test]
    #[ignore]
    fn ingest_duplicate_path_upserts_owner() {
        let (engine, dir) = temp_engine();

        let text = "Shared onboarding doc describing how the team's build pipeline works end to end.";

        let out1 = engine.ingest_doc("origin://shared-build-doc", "manual", Some("Build pipeline"), text, None, None).unwrap();
        assert!(!out1.duplicate);

        let docs_before = engine.store.list_docs().unwrap();
        let doc_before = docs_before.iter().find(|d| d.doc_id == out1.doc_id).expect("doc should exist after first ingest");
        assert!(doc_before.owner.is_none(), "doc should have no owner before the personal re-ingest");

        let out2 = engine
            .ingest_doc("origin://shared-build-doc", "manual", Some("Build pipeline"), text, None, Some("carol"))
            .unwrap();
        assert!(out2.duplicate);
        assert_eq!(out2.doc_id, out1.doc_id);

        let docs_after = engine.store.list_docs().unwrap();
        let doc_after = docs_after.iter().find(|d| d.doc_id == out1.doc_id).expect("doc should still exist after duplicate re-ingest");
        assert_eq!(doc_after.owner.as_deref(), Some("carol"), "duplicate re-ingest should self-heal the owner claim");

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn doc_state(engine: &Engine, doc_id: &str) -> (String, String) {
        let cluster_ids_json = engine
            .store
            .all_chunk_cluster_rows()
            .unwrap()
            .into_iter()
            .find(|(_, d, _)| d == doc_id)
            .map(|(_, _, c)| c)
            .unwrap_or_else(|| "[]".to_string());
        let meta_json = engine
            .store
            .list_docs()
            .unwrap()
            .into_iter()
            .find(|r| r.doc_id == doc_id)
            .map(|r| r.meta_json)
            .unwrap_or_default();
        (cluster_ids_json, meta_json)
    }

    fn seed_misfit_doc(engine: &Engine, doc_id: &str, vector: &[f32]) {
        engine
            .store
            .insert_doc(doc_id, "manual", &format!("origin://{doc_id}"), None, "hash", 10, "2026-01-01T00:00:00Z", None, None)
            .unwrap();
        let chunk = NewChunk {
            id: format!("{doc_id}-c0"),
            seq: 0,
            text: "t".to_string(),
            char_start: 0,
            char_end: 1,
            section: None,
            embedding: f32_vec_to_bytes(vector),
        };
        engine.store.insert_chunks(doc_id, &[chunk]).unwrap();
        engine.store.update_chunk_cluster_ids_for_doc(doc_id, "[]").unwrap();
        engine.store.update_doc_meta_json(doc_id, r#"{"low_fit":true}"#).unwrap();
    }

    /// M8: seed a doc directly via the store (bypassing `ingest_doc`, so
    /// these tests stay network-free) already tagged into `branch_id`.
    fn seed_branch_doc(engine: &Engine, doc_id: &str, branch_id: &str) {
        engine
            .store
            .insert_doc(doc_id, "manual", &format!("origin://{doc_id}"), None, "hash", 10, "2026-01-01T00:00:00Z", Some(branch_id), None)
            .unwrap();
    }

    /// M4: birth materializes a real cluster from misfit docs; rollback must
    /// restore every affected doc's chunk cluster_ids/meta_json and remove
    /// the new cluster, leaving `list_clusters()` identical to pre-birth.
    #[test]
    fn birth_and_rollback_round_trip_restores_prior_state() {
        let (engine, dir) = temp_engine();

        seed_misfit_doc(&engine, "d1", &[1.0, 0.0, 0.0, 0.0]);
        seed_misfit_doc(&engine, "d2", &[0.99, 0.05, 0.0, 0.0]);

        let before_d1 = doc_state(&engine, "d1");
        let before_d2 = doc_state(&engine, "d2");
        let clusters_before = serde_json::to_string(&engine.list_clusters(None).unwrap()).unwrap();

        let req = BirthClusterRequest {
            doc_ids: vec!["d1".to_string(), "d2".to_string()],
            slug: "c-test".to_string(),
            name: None,
            description: None,
        };
        let summary = engine.cluster_birth(&req).expect("cluster_birth");
        assert_eq!(summary.n_docs, 2);
        assert_ne!(doc_state(&engine, "d1"), before_d1, "birth should mutate d1's state");

        let events = engine.journal(0).expect("journal").events;
        let birth_seq = events.iter().find(|e| e.kind == "cluster_birth").expect("birth event recorded").seq;

        engine.rollback(&RollbackRequest { seq: birth_seq }).expect("rollback");

        assert_eq!(doc_state(&engine, "d1"), before_d1);
        assert_eq!(doc_state(&engine, "d2"), before_d2);
        assert!(engine.store.get_cluster_row(&summary.id).unwrap().is_none(), "birthed cluster should be gone");
        let clusters_after = serde_json::to_string(&engine.list_clusters(None).unwrap()).unwrap();
        assert_eq!(clusters_after, clusters_before);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M4: merge folds src into dst and recentroids dst, marking src
    /// `status='merged'` without deleting it; rollback must restore src's
    /// original status/centroid, dst's pre-merge centroid, and every moved
    /// doc's chunk cluster_ids/meta_json.
    #[test]
    fn merge_and_rollback_round_trip_is_lossless() {
        let (engine, dir) = temp_engine();

        engine
            .store
            .insert_cluster("src", "c-src", "active", &f32_vec_to_bytes(&[1.0, 0.0, 0.0, 0.0]), "2026-01-01T00:00:00Z", None)
            .unwrap();
        engine
            .store
            .insert_cluster("dst", "c-dst", "active", &f32_vec_to_bytes(&[0.0, 1.0, 0.0, 0.0]), "2026-01-01T00:00:00Z", None)
            .unwrap();

        engine.store.insert_doc("d1", "manual", "origin://d1", None, "hash", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
        engine
            .store
            .insert_chunks(
                "d1",
                &[NewChunk {
                    id: "d1-c0".to_string(),
                    seq: 0,
                    text: "t".to_string(),
                    char_start: 0,
                    char_end: 1,
                    section: None,
                    embedding: f32_vec_to_bytes(&[1.0, 0.0, 0.0, 0.0]),
                }],
            )
            .unwrap();
        engine.store.update_chunk_cluster_ids_for_doc("d1", r#"["src"]"#).unwrap();
        engine.store.update_doc_meta_json("d1", r#"{"fit":0.9}"#).unwrap();

        let src_before = engine.store.get_cluster_row("src").unwrap().expect("src exists");
        let dst_before = engine.store.get_cluster_row("dst").unwrap().expect("dst exists");
        let d1_before = doc_state(&engine, "d1");

        let req = MergeClustersRequest { src_id: "src".to_string(), dst_id: "dst".to_string() };
        engine.cluster_merge(&req).expect("cluster_merge");

        let events = engine.journal(0).expect("journal").events;
        let merge_seq = events.iter().find(|e| e.kind == "cluster_merge").expect("merge event recorded").seq;
        engine.rollback(&RollbackRequest { seq: merge_seq }).expect("rollback");

        let src_after = engine.store.get_cluster_row("src").unwrap().expect("src still exists");
        let dst_after = engine.store.get_cluster_row("dst").unwrap().expect("dst still exists");
        assert_eq!(src_after.status, src_before.status);
        assert_eq!(src_after.centroid, src_before.centroid);
        assert_eq!(dst_after.centroid, dst_before.centroid);
        assert_eq!(doc_state(&engine, "d1"), d1_before);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M4: `birth_proposals`/`merge_proposals` sort inputs before any
    /// HashMap-iteration-dependent comparison and apply a final deterministic
    /// tie-broken sort, so identical seeded state must yield identical
    /// responses across repeated calls (guards against HashMap iteration
    /// order randomization flakiness).
    #[test]
    fn lifecycle_proposals_are_deterministic() {
        let (engine, dir) = temp_engine();

        seed_misfit_doc(&engine, "d1", &[1.0, 0.0, 0.0, 0.0]);
        seed_misfit_doc(&engine, "d2", &[0.99, 0.02, 0.0, 0.0]);
        seed_misfit_doc(&engine, "d3", &[0.98, 0.03, 0.0, 0.0]);

        engine
            .store
            .insert_cluster("cl-a", "c-a", "active", &f32_vec_to_bytes(&[0.0, 1.0, 0.0, 0.0]), "2026-01-01T00:00:00Z", None)
            .unwrap();
        engine
            .store
            .insert_cluster("cl-b", "c-b", "active", &f32_vec_to_bytes(&[0.0, 0.99, 0.02, 0.0]), "2026-01-01T00:00:00Z", None)
            .unwrap();

        let query = LifecycleProposalsQuery { birth_min: 2, birth_cohesion: 0.9, merge_sim: 0.9 };

        let resp1 = engine.lifecycle_proposals(&query).expect("lifecycle_proposals #1");
        let resp2 = engine.lifecycle_proposals(&query).expect("lifecycle_proposals #2");

        assert_eq!(resp1, resp2);
        assert_eq!(resp1.births.len(), 1);
        assert_eq!(resp1.births[0].doc_ids, vec!["d1".to_string(), "d2".to_string(), "d3".to_string()]);
        assert_eq!(resp1.merges.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M4: rolling back the same event twice must be rejected — the second
    /// call should surface `EngineError::RollbackConflict`, not silently
    /// re-apply the inverse.
    #[test]
    fn rollback_of_already_rolled_back_event_is_rejected() {
        let (engine, dir) = temp_engine();

        seed_misfit_doc(&engine, "d1", &[1.0, 0.0, 0.0, 0.0]);

        let req = BirthClusterRequest {
            doc_ids: vec!["d1".to_string()],
            slug: "c-test".to_string(),
            name: None,
            description: None,
        };
        engine.cluster_birth(&req).expect("cluster_birth");

        let events = engine.journal(0).expect("journal").events;
        let birth_seq = events.iter().find(|e| e.kind == "cluster_birth").expect("birth event recorded").seq;

        engine.rollback(&RollbackRequest { seq: birth_seq }).expect("first rollback");
        let second = engine.rollback(&RollbackRequest { seq: birth_seq });
        assert!(matches!(second, Err(EngineError::RollbackConflict)), "expected RollbackConflict, got {second:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M8: creating a branch with a name that already exists must surface
    /// `EngineError::BranchNameConflict` (409), and `list_branches` must
    /// filter correctly by `status`.
    #[test]
    fn create_branch_rejects_duplicate_name_and_lists_filter_by_status() {
        let (engine, dir) = temp_engine();

        let req = CreateBranchRequest { name: "feature-x".to_string(), created_by: Some("alice".to_string()) };
        let branch = engine.create_branch(&req).expect("create_branch");
        assert_eq!(branch.status, "open");
        assert_eq!(branch.n_docs, 0);

        let dup = engine.create_branch(&req);
        assert!(matches!(dup, Err(EngineError::BranchNameConflict)), "expected BranchNameConflict, got {dup:?}");

        let all = engine.list_branches(None).expect("list_branches all");
        assert_eq!(all.len(), 1);
        let open_only = engine.list_branches(Some("open")).expect("list_branches open");
        assert_eq!(open_only.len(), 1);
        let merged_only = engine.list_branches(Some("merged")).expect("list_branches merged");
        assert!(merged_only.is_empty());

        let events = engine.journal(0).expect("journal").events;
        assert!(events.iter().any(|e| e.kind == "branch_create"), "branch_create event recorded");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M8: `ingest_doc`'s `branch_id` param tags the new doc into the branch
    /// so it shows up via `branch_docs` (not on main). Requires network
    /// access on first run (fastembed model download) — marked `#[ignore]`
    /// per the same convention as `ingest_dedup_and_replace`.
    #[test]
    #[ignore]
    fn ingest_doc_with_branch_id_is_scoped_to_branch() {
        let (engine, dir) = temp_engine();

        let branch = engine
            .create_branch(&CreateBranchRequest { name: "feature-ingest".to_string(), created_by: None })
            .expect("create_branch");

        let outcome = engine
            .ingest_doc("origin://branch-doc", "manual", Some("T"), "Branch content.", Some(branch.id.as_str()), None)
            .unwrap();
        assert!(!outcome.duplicate);

        let docs = engine.branch_docs(&branch.id).expect("branch_docs");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].origin, "origin://branch-doc");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M8: `merge_branch` with an explicit `doc_ids` subset cherry-picks
    /// only those docs, leaves the branch `open` while docs remain, and
    /// flips it to `merged` once the last doc is merged (via a follow-up
    /// call with `doc_ids: None`, meaning "merge everything left").
    #[test]
    fn merge_branch_cherry_picks_then_completes() {
        let (engine, dir) = temp_engine();

        let branch = engine
            .create_branch(&CreateBranchRequest { name: "feature-y".to_string(), created_by: None })
            .expect("create_branch");

        seed_branch_doc(&engine, "d1", &branch.id);
        seed_branch_doc(&engine, "d2", &branch.id);
        seed_branch_doc(&engine, "d3", &branch.id);

        let docs = engine.branch_docs(&branch.id).expect("branch_docs");
        assert_eq!(docs.len(), 3);

        let partial = engine
            .merge_branch(&branch.id, &MergeBranchRequest { doc_ids: Some(vec!["d1".to_string(), "d2".to_string()]) })
            .expect("merge_branch partial");
        assert_eq!(partial.merged, 2);
        assert_eq!(partial.remaining, 1);
        let still_open = engine.list_branches(Some("open")).expect("list_branches open");
        assert_eq!(still_open.len(), 1, "branch stays open while docs remain");

        let rest = engine.merge_branch(&branch.id, &MergeBranchRequest::default()).expect("merge_branch rest");
        assert_eq!(rest.merged, 1);
        assert_eq!(rest.remaining, 0);
        let merged_now = engine.list_branches(Some("merged")).expect("list_branches merged");
        assert_eq!(merged_now.len(), 1);

        let events = engine.journal(0).expect("journal").events;
        assert_eq!(events.iter().filter(|e| e.kind == "branch_merge").count(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M8: once a branch is `merged`, merging or discarding it again must
    /// surface `EngineError::BranchNotOpen` (409) rather than silently
    /// no-op or re-apply.
    #[test]
    fn merge_branch_rejects_when_not_open() {
        let (engine, dir) = temp_engine();

        let branch = engine
            .create_branch(&CreateBranchRequest { name: "feature-z".to_string(), created_by: None })
            .expect("create_branch");
        seed_branch_doc(&engine, "d1", &branch.id);

        let first = engine.merge_branch(&branch.id, &MergeBranchRequest::default()).expect("first merge");
        assert_eq!(first.remaining, 0);

        let second = engine.merge_branch(&branch.id, &MergeBranchRequest::default());
        assert!(matches!(second, Err(EngineError::BranchNotOpen)), "expected BranchNotOpen, got {second:?}");

        let discard_after_merge = engine.discard_branch(&branch.id);
        assert!(matches!(discard_after_merge, Err(EngineError::BranchNotOpen)), "expected BranchNotOpen, got {discard_after_merge:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M8: `discard_branch` deletes every doc still tagged into the branch
    /// (they must vanish from `list_docs`, not just from `branch_docs`),
    /// flips the branch to `discarded`, and journals the deleted docs'
    /// `origin`s (since content itself can't be reconstructed).
    #[test]
    fn discard_branch_deletes_docs_and_journals_origins() {
        let (engine, dir) = temp_engine();

        let branch = engine
            .create_branch(&CreateBranchRequest { name: "feature-w".to_string(), created_by: None })
            .expect("create_branch");
        seed_branch_doc(&engine, "d1", &branch.id);
        seed_branch_doc(&engine, "d2", &branch.id);

        engine.discard_branch(&branch.id).expect("discard_branch");

        let branch_docs = engine.branch_docs(&branch.id).expect("branch_docs after discard");
        assert!(branch_docs.is_empty());

        let all_docs = engine.store.list_docs().expect("list_docs");
        assert!(!all_docs.iter().any(|d| d.doc_id == "d1" || d.doc_id == "d2"), "discarded docs should be deleted, not just untagged");

        let discarded = engine.list_branches(Some("discarded")).expect("list_branches discarded");
        assert_eq!(discarded.len(), 1);
        assert_eq!(discarded[0].id, branch.id);

        let events = engine.journal(0).expect("journal").events;
        let discard_event = events.iter().find(|e| e.kind == "branch_discard").expect("branch_discard event recorded");
        let origins: Vec<String> =
            discard_event.payload["origins"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(origins.len(), 2);
        assert!(origins.contains(&"origin://d1".to_string()));
        assert!(origins.contains(&"origin://d2".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M8 isolation: docs tagged into a branch must be invisible to every
    /// main-scope listing/aggregation surface — `list_docs`, `list_entities`,
    /// and `misfits` — while remaining visible via `branch_docs`. Both the
    /// main-scope and branch-scope docs are seeded `low_fit:true` so the
    /// branch doc's absence from `misfits()` is attributable to branch
    /// scoping, not the fit heuristic. No Engine/model dependency (docs are
    /// seeded directly via the store), so this runs under plain `cargo test`.
    #[test]
    fn branch_docs_are_excluded_from_main_scope_queries() {
        let (engine, dir) = temp_engine();

        let branch = engine
            .create_branch(&CreateBranchRequest { name: "feature-iso".to_string(), created_by: None })
            .expect("create_branch");

        seed_misfit_doc(&engine, "main-doc", &[1.0, 0.0, 0.0, 0.0]);
        engine
            .store
            .upsert_entity("main-doc", &frontmatter::EntityFields { name: "Main Entity".into(), kind: "project".into(), ..Default::default() })
            .unwrap();

        seed_branch_doc(&engine, "branch-doc", &branch.id);
        engine.store.update_doc_meta_json("branch-doc", r#"{"low_fit":true}"#).unwrap();
        engine
            .store
            .upsert_entity("branch-doc", &frontmatter::EntityFields { name: "Branch Entity".into(), kind: "project".into(), ..Default::default() })
            .unwrap();

        let docs = engine.store.list_docs().expect("list_docs");
        assert!(docs.iter().any(|d| d.doc_id == "main-doc"), "main-scope doc should be listed");
        assert!(!docs.iter().any(|d| d.doc_id == "branch-doc"), "branch doc should be excluded from list_docs");

        let entities = engine.list_entities(None, None).expect("list_entities");
        assert!(entities.iter().any(|e| e.doc_id == "main-doc"), "main-scope entity should be listed");
        assert!(!entities.iter().any(|e| e.doc_id == "branch-doc"), "branch entity should be excluded from list_entities");

        let misfits = engine.misfits(None).expect("misfits");
        assert!(misfits.iter().any(|m| m.doc_id == "main-doc"), "main-scope misfit should be listed");
        assert!(!misfits.iter().any(|m| m.doc_id == "branch-doc"), "branch misfit should be excluded");

        let branch_docs = engine.branch_docs(&branch.id).expect("branch_docs");
        assert!(branch_docs.iter().any(|d| d.doc_id == "branch-doc"), "branch doc should still be visible via branch_docs, not lost");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M8: `merge_branch`'s retagging must be reversible via `rollback` —
    /// merged docs disappear from main scope again, reappear in
    /// `branch_docs`, and the branch's `status` returns to `"open"` (the
    /// merge closed the branch since all of its docs were merged in one
    /// call, so this also exercises the `branch_closed=true` inverse path).
    /// No Engine/model dependency, so this runs under plain `cargo test`.
    #[test]
    fn merge_branch_and_rollback_round_trip_is_lossless() {
        let (engine, dir) = temp_engine();

        let branch = engine
            .create_branch(&CreateBranchRequest { name: "feature-rb".to_string(), created_by: None })
            .expect("create_branch");
        seed_branch_doc(&engine, "d1", &branch.id);
        seed_branch_doc(&engine, "d2", &branch.id);

        let merge = engine.merge_branch(&branch.id, &MergeBranchRequest::default()).expect("merge_branch");
        assert_eq!(merge.merged, 2);
        assert_eq!(merge.remaining, 0);

        let docs_after_merge = engine.store.list_docs().expect("list_docs after merge");
        assert!(docs_after_merge.iter().any(|d| d.doc_id == "d1"), "d1 should be in main scope after merge");
        assert!(docs_after_merge.iter().any(|d| d.doc_id == "d2"), "d2 should be in main scope after merge");
        assert_eq!(engine.list_branches(Some("merged")).expect("list_branches merged").len(), 1);

        let events = engine.journal(0).expect("journal").events;
        let merge_seq = events.iter().find(|e| e.kind == "branch_merge").expect("branch_merge event recorded").seq;
        engine.rollback(&RollbackRequest { seq: merge_seq }).expect("rollback");

        let docs_after_rollback = engine.store.list_docs().expect("list_docs after rollback");
        assert!(!docs_after_rollback.iter().any(|d| d.doc_id == "d1"), "d1 should be back on the branch, not main");
        assert!(!docs_after_rollback.iter().any(|d| d.doc_id == "d2"), "d2 should be back on the branch, not main");

        let branch_docs = engine.branch_docs(&branch.id).expect("branch_docs after rollback");
        assert_eq!(branch_docs.len(), 2);
        assert!(branch_docs.iter().any(|d| d.doc_id == "d1"));
        assert!(branch_docs.iter().any(|d| d.doc_id == "d2"));

        let reopened = engine.store.get_branch_row(&branch.id).expect("get_branch_row").expect("branch still exists");
        assert_eq!(reopened.status, "open", "branch status should be restored to open");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M8: `search()` must exclude branch-scoped docs from results by
    /// default, and include them when `include_branch_id` names that branch
    /// (the admin preview overlay) — while a *different* branch's docs stay
    /// excluded even under that overlay. Requires network access (fastembed
    /// + cross-encoder), so `#[ignore]`d per the same convention as
    /// `ingest_dedup_and_replace`.
    #[test]
    #[ignore]
    fn search_excludes_branch_docs_unless_included_via_overlay() {
        let (engine, dir) = temp_engine();

        let branch_a = engine
            .create_branch(&CreateBranchRequest { name: "feature-search-a".to_string(), created_by: None })
            .expect("create_branch a");
        let branch_b = engine
            .create_branch(&CreateBranchRequest { name: "feature-search-b".to_string(), created_by: None })
            .expect("create_branch b");

        engine
            .ingest_doc("origin://search-branch-a", "manual", Some("A"), "Quokka wombat marsupial content unique to branch a.", Some(branch_a.id.as_str()), None)
            .unwrap();
        engine
            .ingest_doc("origin://search-branch-b", "manual", Some("B"), "Quokka wombat marsupial content unique to branch b.", Some(branch_b.id.as_str()), None)
            .unwrap();

        let default_resp = engine.search("Quokka wombat marsupial", 10, &[], None, None).expect("search default");
        assert!(!default_resp.results.iter().any(|r| r.origin == "origin://search-branch-a"), "branch a doc must be excluded by default");
        assert!(!default_resp.results.iter().any(|r| r.origin == "origin://search-branch-b"), "branch b doc must be excluded by default");

        let overlay_resp = engine.search("Quokka wombat marsupial", 10, &[], Some(branch_a.id.as_str()), None).expect("search overlay");
        assert!(overlay_resp.results.iter().any(|r| r.origin == "origin://search-branch-a"), "branch a doc should appear via its own overlay");
        assert!(!overlay_resp.results.iter().any(|r| r.origin == "origin://search-branch-b"), "branch b doc should stay excluded even under a's overlay");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M8: `route()`'s BM25-hit cluster scoring must exclude branch docs —
    /// it reuses the same `scoped_chunk_ids` primitive as `search()`, but
    /// has no overlay parameter (branch docs never contribute to routing).
    /// Seeds two topic clusters, bootstraps them, records the coffee
    /// cluster's `bm25_hits` for a coffee query, then ingests a
    /// branch-scoped doc with near-identical coffee content and asserts the
    /// hit count is unchanged. Requires network access (fastembed), so
    /// `#[ignore]`d per the same convention as
    /// `ingest_assigns_to_argmax_cluster_and_skips_embed_on_duplicate`.
    #[test]
    #[ignore]
    fn route_excludes_branch_docs_from_bm25_hit_scoring() {
        let (engine, dir) = temp_engine();

        engine
            .ingest_doc(
                "origin://route-coffee-1",
                "manual",
                Some("Pour-over"),
                "Pour-over coffee brewing requires a slow, steady pour of hot water over ground coffee beans in a paper filter, extracting oils and flavor compounds over about three minutes.",
                None,
                None,
            )
            .unwrap();
        engine
            .ingest_doc(
                "origin://route-coffee-2",
                "manual",
                Some("French press"),
                "French press coffee steeps coarsely ground beans directly in hot water for four minutes before a metal mesh plunger separates the grounds from the finished brew.",
                None,
                None,
            )
            .unwrap();
        engine
            .ingest_doc(
                "origin://route-astronomy-1",
                "manual",
                Some("Nebulae"),
                "Nebulae are vast interstellar clouds of dust and ionized gas, some of which collapse under gravity to form new stars over millions of years.",
                None,
                None,
            )
            .unwrap();
        engine
            .ingest_doc(
                "origin://route-astronomy-2",
                "manual",
                Some("Exoplanets"),
                "Exoplanets orbiting distant stars are detected through subtle dips in starlight as they transit, or through tiny gravitational wobbles in their host star.",
                None,
                None,
            )
            .unwrap();

        let bootstrap = engine.bootstrap_clusters(&BootstrapRequest { k_min: 2, k_max: 2, seed: 42, force: false, owner: None }).unwrap();
        let coffee_slug = bootstrap
            .clusters
            .iter()
            .find(|c| c.sample.iter().any(|s| s.origin.starts_with("origin://route-coffee")))
            .map(|c| c.summary.slug.clone())
            .expect("a cluster should contain the coffee-topic docs");

        let before = engine.route("pour-over coffee brewing", None).expect("route before branch doc");
        let hits_before = before.scores.iter().find(|s| s.slug == coffee_slug).map(|s| s.bm25_hits).unwrap_or(0);

        let branch = engine
            .create_branch(&CreateBranchRequest { name: "feature-route".to_string(), created_by: None })
            .expect("create_branch");
        engine
            .ingest_doc(
                "origin://route-coffee-branch",
                "manual",
                Some("Cold brew"),
                "Pour-over coffee brewing requires a slow, steady pour of hot water over ground coffee beans in a paper filter, extracting oils and flavor compounds over about three minutes.",
                Some(branch.id.as_str()),
                None,
            )
            .unwrap();

        let after = engine.route("pour-over coffee brewing", None).expect("route after branch doc");
        let hits_after = after.scores.iter().find(|s| s.slug == coffee_slug).map(|s| s.bm25_hits).unwrap_or(0);

        assert_eq!(hits_after, hits_before, "branch doc's chunk must not contribute to bm25_hits scoring");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: `list_docs()` must exclude personal-owner docs under the default
    /// shared scope, and include only the matching owner's docs once
    /// `owner_scope` names them (`"shared+<name>"`) — a different owner's
    /// docs stay excluded even under that scope. Network-free (direct store
    /// insertion, no `ingest_doc`/embedder).
    #[test]
    fn list_docs_respects_owner_scope() {
        let (engine, dir) = temp_engine();

        engine
            .store
            .insert_doc("d-shared", "manual", "origin://shared", None, "hash1", 10, "2026-01-01T00:00:00Z", None, None)
            .unwrap();
        engine
            .store
            .insert_doc("d-alice", "manual", "origin://alice", None, "hash2", 10, "2026-01-01T00:00:00Z", None, Some("alice"))
            .unwrap();
        engine
            .store
            .insert_doc("d-bob", "manual", "origin://bob", None, "hash3", 10, "2026-01-01T00:00:00Z", None, Some("bob"))
            .unwrap();

        let shared_ids: Vec<String> = engine.list_docs(None).unwrap().into_iter().map(|d| d.doc_id).collect();
        assert!(shared_ids.contains(&"d-shared".to_string()));
        assert!(!shared_ids.contains(&"d-alice".to_string()));
        assert!(!shared_ids.contains(&"d-bob".to_string()));

        let alice_ids: Vec<String> = engine
            .list_docs(Some("shared+alice"))
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .collect();
        assert!(alice_ids.contains(&"d-shared".to_string()));
        assert!(alice_ids.contains(&"d-alice".to_string()));
        assert!(!alice_ids.contains(&"d-bob".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: `list_clusters()` must exclude personal-owner clusters under the
    /// default shared scope, and include only the matching owner's clusters
    /// once `owner_scope` names them.
    #[test]
    fn list_clusters_respects_owner_scope() {
        let (engine, dir) = temp_engine();

        engine.store.insert_cluster("cl-shared", "c-shared", "active", &[], "2026-01-01T00:00:00Z", None).unwrap();
        engine
            .store
            .insert_cluster("cl-alice", "c-alice", "active", &[], "2026-01-01T00:00:00Z", Some("alice"))
            .unwrap();
        engine
            .store
            .insert_cluster("cl-bob", "c-bob", "active", &[], "2026-01-01T00:00:00Z", Some("bob"))
            .unwrap();

        let shared_ids: Vec<String> = engine.list_clusters(None).unwrap().into_iter().map(|c| c.id).collect();
        assert!(shared_ids.contains(&"cl-shared".to_string()));
        assert!(!shared_ids.contains(&"cl-alice".to_string()));
        assert!(!shared_ids.contains(&"cl-bob".to_string()));

        let alice_ids: Vec<String> = engine
            .list_clusters(Some("shared+alice"))
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert!(alice_ids.contains(&"cl-shared".to_string()));
        assert!(alice_ids.contains(&"cl-alice".to_string()));
        assert!(!alice_ids.contains(&"cl-bob".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: `list_entities()` must exclude personal-owner entities under the
    /// default shared scope, and include only the matching owner's entities
    /// once `owner_scope` names them. `Entity` itself carries no `owner`
    /// field (dropped by `From<EntityRow>`), so assertions key on `doc_id`.
    #[test]
    fn list_entities_respects_owner_scope() {
        let (engine, dir) = temp_engine();

        engine
            .store
            .insert_doc("d-shared", "manual", "origin://shared", None, "hash1", 10, "2026-01-01T00:00:00Z", None, None)
            .unwrap();
        engine
            .store
            .insert_doc("d-alice", "manual", "origin://alice", None, "hash2", 10, "2026-01-01T00:00:00Z", None, Some("alice"))
            .unwrap();
        engine
            .store
            .insert_doc("d-bob", "manual", "origin://bob", None, "hash3", 10, "2026-01-01T00:00:00Z", None, Some("bob"))
            .unwrap();

        engine
            .store
            .upsert_entity("d-shared", &frontmatter::EntityFields { name: "Shared".into(), kind: "project".into(), ..Default::default() })
            .unwrap();
        engine
            .store
            .upsert_entity("d-alice", &frontmatter::EntityFields { name: "Alice".into(), kind: "project".into(), ..Default::default() })
            .unwrap();
        engine
            .store
            .upsert_entity("d-bob", &frontmatter::EntityFields { name: "Bob".into(), kind: "project".into(), ..Default::default() })
            .unwrap();

        let shared_ids: Vec<String> = engine.list_entities(None, None).unwrap().into_iter().map(|e| e.doc_id).collect();
        assert!(shared_ids.contains(&"d-shared".to_string()));
        assert!(!shared_ids.contains(&"d-alice".to_string()));
        assert!(!shared_ids.contains(&"d-bob".to_string()));

        let alice_ids: Vec<String> = engine
            .list_entities(None, Some("shared+alice"))
            .unwrap()
            .into_iter()
            .map(|e| e.doc_id)
            .collect();
        assert!(alice_ids.contains(&"d-shared".to_string()));
        assert!(alice_ids.contains(&"d-alice".to_string()));
        assert!(!alice_ids.contains(&"d-bob".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: `list_cluster_digests()` must exclude personal-owner digests
    /// under the default shared scope, and include only the matching
    /// owner's digest once `owner_scope` names them. `ClusterDigest` itself
    /// carries no `owner` field (dropped by `From<ClusterDigestRow>`), so
    /// assertions key on `cluster_id`. Clusters must be `status = "active"`
    /// for `list_active_cluster_digests` to surface them at all.
    #[test]
    fn list_cluster_digests_respects_owner_scope() {
        let (engine, dir) = temp_engine();

        engine.store.insert_cluster("cl-shared", "c-shared", "active", &[], "2026-01-01T00:00:00Z", None).unwrap();
        engine
            .store
            .insert_cluster("cl-alice", "c-alice", "active", &[], "2026-01-01T00:00:00Z", Some("alice"))
            .unwrap();
        engine
            .store
            .insert_cluster("cl-bob", "c-bob", "active", &[], "2026-01-01T00:00:00Z", Some("bob"))
            .unwrap();

        engine.store.upsert_cluster_digest("cl-shared", "shared digest", Some("test-model"), "2026-01-01T00:00:00Z").unwrap();
        engine.store.upsert_cluster_digest("cl-alice", "alice digest", Some("test-model"), "2026-01-01T00:00:00Z").unwrap();
        engine.store.upsert_cluster_digest("cl-bob", "bob digest", Some("test-model"), "2026-01-01T00:00:00Z").unwrap();

        let shared_ids: Vec<String> = engine
            .list_cluster_digests(None)
            .unwrap()
            .into_iter()
            .map(|d| d.cluster_id)
            .collect();
        assert!(shared_ids.contains(&"cl-shared".to_string()));
        assert!(!shared_ids.contains(&"cl-alice".to_string()));
        assert!(!shared_ids.contains(&"cl-bob".to_string()));

        let alice_ids: Vec<String> = engine
            .list_cluster_digests(Some("shared+alice"))
            .unwrap()
            .into_iter()
            .map(|d| d.cluster_id)
            .collect();
        assert!(alice_ids.contains(&"cl-shared".to_string()));
        assert!(alice_ids.contains(&"cl-alice".to_string()));
        assert!(!alice_ids.contains(&"cl-bob".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: `search()` must exclude personal-owner docs from results by
    /// default (shared scope), and include them once `owner_scope` names
    /// that owner (`"shared+<name>"`) — a different owner's docs stay
    /// excluded even under that scope. Mirrors
    /// `search_excludes_branch_docs_unless_included_via_overlay`. Requires
    /// network access (fastembed + cross-encoder), so `#[ignore]`d.
    #[test]
    #[ignore]
    fn search_excludes_owner_docs_unless_scoped_to_that_owner() {
        let (engine, dir) = temp_engine();

        engine
            .ingest_doc(
                "origin://search-owner-alice",
                "manual",
                Some("Alice"),
                "Quokka wombat marsupial content unique to alice.",
                None,
                Some("alice"),
            )
            .unwrap();
        engine
            .ingest_doc(
                "origin://search-owner-bob",
                "manual",
                Some("Bob"),
                "Quokka wombat marsupial content unique to bob.",
                None,
                Some("bob"),
            )
            .unwrap();

        let default_resp = engine.search("Quokka wombat marsupial", 10, &[], None, None).expect("search default");
        assert!(
            !default_resp.results.iter().any(|r| r.origin == "origin://search-owner-alice"),
            "alice's doc must be excluded under shared scope"
        );
        assert!(
            !default_resp.results.iter().any(|r| r.origin == "origin://search-owner-bob"),
            "bob's doc must be excluded under shared scope"
        );

        let alice_resp = engine
            .search("Quokka wombat marsupial", 10, &[], None, Some("shared+alice"))
            .expect("search alice scope");
        assert!(
            alice_resp.results.iter().any(|r| r.origin == "origin://search-owner-alice"),
            "alice's doc should appear under her own scope"
        );
        assert!(
            !alice_resp.results.iter().any(|r| r.origin == "origin://search-owner-bob"),
            "bob's doc should stay excluded even under alice's scope"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9: `route()` must exclude an owner's personal cluster under the
    /// default shared scope, and include it — with correct `bm25_hits` —
    /// once `owner_scope` names that owner. An owner-scoped `ingest_doc`
    /// argmaxes only over that owner's own clusters (see the M9 comment at
    /// this file's `candidate_clusters` assignment), so a first personal doc
    /// auto-births a dedicated `personal-<owner>` cluster rather than
    /// joining any shared topic cluster; this test verifies scoping against
    /// that actual cluster, not a shared one. Requires network access
    /// (fastembed), so `#[ignore]`d.
    #[test]
    #[ignore]
    fn route_excludes_owner_docs_from_bm25_hit_scoring_unless_scoped() {
        let (engine, dir) = temp_engine();

        engine
            .ingest_doc(
                "origin://route-owner-alice-1",
                "manual",
                Some("Alice's note"),
                "Quokka wombat marsupial content unique to alice's personal cluster.",
                None,
                Some("alice"),
            )
            .unwrap();

        let shared = engine.route("Quokka wombat marsupial", None).expect("route shared scope");
        assert!(
            !shared.scores.iter().any(|s| s.slug == "personal-alice"),
            "alice's personal cluster must not appear under shared scope"
        );

        let alice_scoped = engine
            .route("Quokka wombat marsupial", Some("shared+alice"))
            .expect("route alice scope");
        let alice_cluster = alice_scoped
            .scores
            .iter()
            .find(|s| s.slug == "personal-alice")
            .expect("alice's personal cluster should appear once scoped to her own owner");
        assert!(alice_cluster.bm25_hits > 0, "alice's own doc should contribute to her own personal cluster's bm25_hits");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9 A2: seed a doc with one embedded chunk directly via the store —
    /// network-free (no embedder), optionally owned. Bootstrap/lifecycle
    /// tests use these vectors as the k-means/misfit inputs.
    fn seed_vec_doc(engine: &Engine, doc_id: &str, vector: &[f32], owner: Option<&str>) {
        engine
            .store
            .insert_doc(doc_id, "manual", &format!("origin://{doc_id}"), None, "hash", 10, "2026-01-01T00:00:00Z", None, owner)
            .unwrap();
        let chunk = NewChunk {
            id: format!("{doc_id}-c0"),
            seq: 0,
            text: "t".to_string(),
            char_start: 0,
            char_end: 1,
            section: None,
            embedding: f32_vec_to_bytes(vector),
        };
        engine.store.insert_chunks(doc_id, &[chunk]).unwrap();
    }

    /// M9 A2: scoped bootstrap must cluster exactly one scope's docs, stamp
    /// the scope's owner on the new clusters (with `p-<owner>-` slugs), and
    /// — including under `force=true` — leave every other scope's clusters
    /// and assignments untouched. A first personal bootstrap must not
    /// require `force` just because shared clusters already exist.
    #[test]
    fn scoped_bootstrap_clusters_one_scope_and_preserves_others() {
        let (engine, dir) = temp_engine();

        seed_vec_doc(&engine, "s1", &[1.0, 0.0, 0.0, 0.0], None);
        seed_vec_doc(&engine, "s2", &[0.9, 0.1, 0.0, 0.0], None);
        seed_vec_doc(&engine, "a1", &[0.0, 1.0, 0.0, 0.0], Some("alice"));
        seed_vec_doc(&engine, "a2", &[0.0, 0.9, 0.1, 0.0], Some("alice"));

        let shared = engine
            .bootstrap_clusters(&BootstrapRequest { k_min: 1, k_max: 1, seed: 42, force: false, owner: None })
            .expect("shared bootstrap");
        assert_eq!(shared.stats.docs_assigned, 2, "shared bootstrap must only see the 2 shared docs");
        assert!(shared.clusters.iter().all(|c| c.summary.owner.is_none()));

        // First personal bootstrap: shared clusters exist, but alice's scope
        // is empty — no force needed.
        let alice = engine
            .bootstrap_clusters(&BootstrapRequest { k_min: 1, k_max: 1, seed: 42, force: false, owner: Some("alice".to_string()) })
            .expect("alice bootstrap without force");
        assert_eq!(alice.stats.docs_assigned, 2, "alice bootstrap must only see her 2 docs");
        assert!(alice.clusters.iter().all(|c| c.summary.owner.as_deref() == Some("alice")));
        assert!(alice.clusters.iter().all(|c| c.summary.slug.starts_with("p-alice-")), "personal slugs are prefixed");

        let shared_before = engine.store.count_clusters_for_owner_scope(None).unwrap();
        let alice_re = engine
            .bootstrap_clusters(&BootstrapRequest { k_min: 1, k_max: 1, seed: 7, force: true, owner: Some("alice".to_string()) })
            .expect("alice force re-bootstrap");
        assert_eq!(alice_re.stats.docs_assigned, 2);
        let shared_after = engine.store.count_clusters_for_owner_scope(None).unwrap();
        assert_eq!(shared_before, shared_after, "force on alice's scope must not touch shared clusters");

        // Shared docs keep their assignment through alice's force pass.
        let shared_docs = engine.list_docs(None).expect("list_docs shared");
        assert!(
            shared_docs.iter().filter(|d| d.doc_id == "s1" || d.doc_id == "s2").all(|d| d.cluster_slug.is_some()),
            "shared docs must stay assigned after a personal-scope force bootstrap"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9 A2: promotion tagging (`POST /branches/{id}/docs`) accepts only
    /// existing, personal (owner ≠ NULL), not-yet-tagged docs into an open
    /// branch — and validation is all-or-nothing.
    #[test]
    fn tag_branch_docs_promotes_only_personal_docs() {
        let (engine, dir) = temp_engine();

        let branch = engine
            .create_branch(&CreateBranchRequest { name: "promote-a".to_string(), created_by: None })
            .expect("create_branch");

        engine
            .store
            .insert_doc("p1", "session", "origin://p1", None, "h1", 10, "2026-01-01T00:00:00Z", None, Some("alice"))
            .unwrap();
        engine
            .store
            .insert_doc("shared1", "manual", "origin://shared1", None, "h2", 10, "2026-01-01T00:00:00Z", None, None)
            .unwrap();

        let shared_reject = engine.tag_branch_docs(&branch.id, &["shared1".to_string()]);
        assert!(matches!(shared_reject, Err(EngineError::PromoteSharedDoc(_))), "expected PromoteSharedDoc, got {shared_reject:?}");

        let missing = engine.tag_branch_docs(&branch.id, &["nope".to_string()]);
        assert!(matches!(missing, Err(EngineError::DocNotFound(_))), "expected DocNotFound, got {missing:?}");

        // All-or-nothing: a bad doc in the batch must leave the good one untagged.
        let mixed = engine.tag_branch_docs(&branch.id, &["p1".to_string(), "shared1".to_string()]);
        assert!(mixed.is_err());
        assert_eq!(engine.branch_docs(&branch.id).unwrap().len(), 0, "failed batch must tag nothing");

        let ok = engine.tag_branch_docs(&branch.id, &["p1".to_string()]).expect("tag personal doc");
        assert_eq!(ok.tagged, 1);
        assert_eq!(engine.branch_docs(&branch.id).unwrap().len(), 1);

        let retag = engine.tag_branch_docs(&branch.id, &["p1".to_string()]);
        assert!(matches!(retag, Err(EngineError::DocAlreadyInBranch(_))), "expected DocAlreadyInBranch, got {retag:?}");

        engine.merge_branch(&branch.id, &MergeBranchRequest::default()).expect("merge");
        let closed = engine.tag_branch_docs(&branch.id, &["p1".to_string()]);
        assert!(matches!(closed, Err(EngineError::BranchNotOpen)), "expected BranchNotOpen, got {closed:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9 A2 gate 4 (승격 왕복): personal doc → tag → merge lands it shared
    /// (`owner = NULL`, `branch_id = NULL`) — then rollback restores both the
    /// branch tag and the prior owner, losslessly.
    #[test]
    fn promote_merge_and_rollback_restore_owner() {
        let (engine, dir) = temp_engine();

        engine
            .store
            .insert_doc("p1", "session", "origin://p1", None, "h1", 10, "2026-01-01T00:00:00Z", None, Some("alice"))
            .unwrap();
        let branch = engine
            .create_branch(&CreateBranchRequest { name: "promote-rt".to_string(), created_by: None })
            .expect("create_branch");
        engine.tag_branch_docs(&branch.id, &["p1".to_string()]).expect("tag");

        engine.merge_branch(&branch.id, &MergeBranchRequest::default()).expect("merge");
        let (owner, doc_branch) = engine.store.doc_owner_and_branch("p1").unwrap().expect("doc exists");
        assert_eq!(owner, None, "merge must clear owner (promotion to shared)");
        assert_eq!(doc_branch, None, "merge must retag to main");

        let events = engine.journal(0).expect("journal").events;
        let merge_event = events.iter().rev().find(|e| e.kind == "branch_merge").expect("branch_merge event");
        engine.rollback(&RollbackRequest { seq: merge_event.seq }).expect("rollback merge");

        let (owner, doc_branch) = engine.store.doc_owner_and_branch("p1").unwrap().expect("doc exists");
        assert_eq!(owner.as_deref(), Some("alice"), "rollback must restore the prior personal owner");
        assert_eq!(doc_branch.as_deref(), Some(branch.id.as_str()), "rollback must re-tag the doc into the branch");
        let reopened = engine.list_branches(Some("open")).expect("list_branches open");
        assert_eq!(reopened.len(), 1, "rollback must reopen the branch");

        // 왕복 반복: merge again lands it shared again.
        engine.merge_branch(&branch.id, &MergeBranchRequest::default()).expect("re-merge");
        let (owner, _) = engine.store.doc_owner_and_branch("p1").unwrap().expect("doc exists");
        assert_eq!(owner, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9 A2: lifecycle proposals are judged per scope — identical vectors
    /// across scopes must never be grouped into one birth proposal, and a
    /// scope whose own misfit count is below `birth_min` proposes nothing.
    #[test]
    fn lifecycle_proposals_do_not_cross_scopes() {
        let (engine, dir) = temp_engine();

        // Shared misfits d1/d2 and alice's misfit a1 share the same vector:
        // unscoped grouping would happily merge all three.
        seed_misfit_doc(&engine, "d1", &[1.0, 0.0, 0.0, 0.0]);
        seed_misfit_doc(&engine, "d2", &[0.99, 0.05, 0.0, 0.0]);
        seed_misfit_doc(&engine, "a1", &[1.0, 0.0, 0.0, 0.0]);
        engine.store.update_doc_owner("a1", Some("alice")).unwrap();

        let query = LifecycleProposalsQuery { birth_min: 3, birth_cohesion: 0.5, merge_sim: 0.9 };
        let resp = engine.lifecycle_proposals(&query).expect("lifecycle birth_min=3");
        assert!(
            resp.births.is_empty(),
            "no scope holds 3 misfits on its own — cross-scope grouping would wrongly propose one: {:?}",
            resp.births
        );

        let query2 = LifecycleProposalsQuery { birth_min: 2, birth_cohesion: 0.5, merge_sim: 0.9 };
        let resp2 = engine.lifecycle_proposals(&query2).expect("lifecycle birth_min=2");
        assert_eq!(resp2.births.len(), 1, "only the shared scope has ≥2 misfits");
        let proposal = &resp2.births[0];
        assert!(!proposal.doc_ids.contains(&"a1".to_string()), "alice's doc must not join a shared birth proposal");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M9 A2 migrate CLI primitive: only still-shared docs of the given
    /// source_type are claimed; other source_types and already-owned docs
    /// are untouched. Dry-run count matches.
    #[test]
    fn migrate_owner_tags_only_matching_source_type() {
        let (engine, dir) = temp_engine();

        engine.store.insert_doc("s1", "session", "origin://s1", None, "h1", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
        engine.store.insert_doc("s2", "session", "origin://s2", None, "h2", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
        engine.store.insert_doc("m1", "manual", "origin://m1", None, "h3", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
        engine.store.insert_doc("s3", "session", "origin://s3", None, "h4", 10, "2026-01-01T00:00:00Z", None, Some("bob")).unwrap();

        assert_eq!(engine.store.count_unowned_docs_for_source_type("session").unwrap(), 2);

        let n = engine.store.set_owner_for_source_type("session", "admin").unwrap();
        assert_eq!(n, 2);

        let owner_of = |id: &str| engine.store.doc_owner_and_branch(id).unwrap().expect("doc").0;
        assert_eq!(owner_of("s1").as_deref(), Some("admin"));
        assert_eq!(owner_of("s2").as_deref(), Some("admin"));
        assert_eq!(owner_of("m1"), None, "other source_types stay shared");
        assert_eq!(owner_of("s3").as_deref(), Some("bob"), "already-owned docs keep their owner");

        let _ = std::fs::remove_dir_all(&dir);
    }

/// M10: 관계 그래프 — dangling 저장→새 문서 인제스트 시 역해석(self-heal),
/// in/out 조회, 그리고 **스코프 격리**(타인 개인 문서는 관계 항목째 비노출).
/// insert_doc이 doc_name(origin 스템)을 저장하므로 store 시딩만으로 검증 가능.
#[test]
fn graph_links_resolve_and_respect_owner_scope() {
    let (engine, dir) = temp_engine();

    // 공통 문서 a가 아직 없는 b와 타인 개인 문서 p를 가리킨다.
    engine.store.insert_doc("a", "session", "origin://notes/a.md", Some("A"), "h1", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
    engine.store.insert_doc("p", "session", "origin://notes/p.md", Some("P"), "h2", 10, "2026-01-01T00:00:00Z", None, Some("alice")).unwrap();
    engine.store.replace_doc_links("a", &[
        ("links".to_string(), "b".to_string()),
        ("related".to_string(), "p".to_string()),
    ]).unwrap();

    // b가 없을 땐 dangling.
    let g = engine.graph_doc("a", None).unwrap();
    let b_link = g.outbound.iter().find(|l| l.target_name == "b").expect("b 링크 존재");
    assert!(b_link.doc.is_none(), "미해석(dangling)이어야 함");
    // 공통 스코프에서 alice 개인 문서 p는 항목째 제외(이름도 유출 금지).
    assert!(!g.outbound.iter().any(|l| l.target_name == "p"), "타인 개인 링크 비노출: {:?}", g.outbound);

    // b 인제스트 → a의 dangling이 역해석돼야 한다(resolve_dangling_links).
    engine.store.insert_doc("b", "session", "origin://notes/b.md", Some("B"), "h3", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
    engine.store.resolve_dangling_links("b", "b").unwrap();
    let g2 = engine.graph_doc("a", None).unwrap();
    let b_link2 = g2.outbound.iter().find(|l| l.target_name == "b").unwrap();
    assert_eq!(b_link2.doc.as_ref().map(|d| d.doc_id.as_str()), Some("b"), "self-heal 해석");

    // inbound: b 입장에서 a가 들어온다.
    let gb = engine.graph_doc("b", None).unwrap();
    assert!(gb.inbound.iter().any(|l| l.doc.as_ref().map(|d| d.doc_id.as_str()) == Some("a")));

    // alice 스코프에선 p 링크가 보인다.
    let ga = engine.graph_doc("a", Some("shared+alice")).unwrap();
    assert!(ga.outbound.iter().any(|l| l.target_name == "p" && l.doc.is_some()));

    // 타인 개인 문서 자체 조회는 공통 스코프에서 404 동급.
    assert!(matches!(engine.graph_doc("p", None), Err(EngineError::DocNotFound(_))));

    let _ = std::fs::remove_dir_all(&dir);
}

/// M10: 1-hop 이웃 확장 — 방향 무관 수집, 입력 제외, 스코프 격리, limit 상한.
#[test]
fn graph_neighbors_expand_one_hop_with_scope() {
    let (engine, dir) = temp_engine();
    engine.store.insert_doc("a", "manual", "origin://n/a.md", Some("A"), "h1", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
    engine.store.insert_doc("b", "manual", "origin://n/b.md", Some("B"), "h2", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
    engine.store.insert_doc("c", "manual", "origin://n/c.md", Some("C"), "h3", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
    engine.store.insert_doc("p", "manual", "origin://n/p.md", Some("P"), "h4", 10, "2026-01-01T00:00:00Z", None, Some("alice")).unwrap();
    // a→b, c→a, a→p (p는 alice 개인)
    engine.store.replace_doc_links("a", &[("links".into(), "b".into()), ("links".into(), "p".into())]).unwrap();
    engine.store.replace_doc_links("c", &[("links".into(), "a".into())]).unwrap();

    let shared = engine.graph_neighbors(&GraphNeighborsRequest {
        doc_ids: vec!["a".into()],
        owner_scope: None,
        limit: None,
    }).unwrap();
    let ids: Vec<&str> = shared.iter().map(|d| d.doc_id.as_str()).collect();
    assert!(ids.contains(&"b"), "out 이웃");
    assert!(ids.contains(&"c"), "in 이웃");
    assert!(!ids.contains(&"p"), "타인 개인 이웃 비노출");
    assert!(!ids.contains(&"a"), "입력 자신 제외");

    let alice = engine.graph_neighbors(&GraphNeighborsRequest {
        doc_ids: vec!["a".into()],
        owner_scope: Some("shared+alice".into()),
        limit: Some(1),
    }).unwrap();
    assert_eq!(alice.len(), 1, "limit 상한");

    let _ = std::fs::remove_dir_all(&dir);
}

/// P4: origin 접두 일괄 삭제 — chunks·entity·나가는 링크 동반 삭제,
/// 들어오는 링크는 dangling(NULL) 복귀(새 origin 재인제스트 시 역해석 self-heal).
#[test]
fn delete_docs_by_origin_prefix_redangles_inbound_links() {
    let (engine, dir) = temp_engine();
    engine.store.insert_doc("w1", "session", "C:\\hub\\wiki\\alpha.md", Some("A"), "h1", 10, "2026-01-01T00:00:00Z", None, Some("admin")).unwrap();
    engine.store.insert_doc("w2", "session", "C:\\hub\\wiki\\beta.md", Some("B"), "h2", 10, "2026-01-01T00:00:00Z", None, Some("admin")).unwrap();
    engine.store.insert_doc("keep", "manual", "origin://keep.md", Some("K"), "h3", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
    // keep→alpha (삭제 후 dangling 복귀 대상), w1→beta (동반 삭제 대상)
    engine.store.replace_doc_links("keep", &[("links".into(), "alpha".into())]).unwrap();
    engine.store.replace_doc_links("w1", &[("links".into(), "beta".into())]).unwrap();

    let ids = engine.store.docs_ids_by_origin_prefix("C:\\hub\\wiki\\").unwrap();
    assert_eq!(ids.len(), 2, "접두 매칭 2건: {ids:?}");
    let n = engine.store.delete_docs_by_ids(&ids).unwrap();
    assert_eq!(n, 2);

    assert!(engine.store.find_doc_by_origin("C:\\hub\\wiki\\alpha.md").unwrap().is_none(), "삭제 확인");
    assert!(engine.store.find_doc_by_origin("origin://keep.md").unwrap().is_some(), "비대상 보존");

    // keep→alpha는 dangling으로 복귀했다가, alpha가 새 origin으로 들어오면 역해석.
    let g = engine.graph_doc("keep", None).unwrap();
    let link = g.outbound.iter().find(|l| l.target_name == "alpha").expect("링크 유지");
    assert!(link.doc.is_none(), "dangling 복귀");
    engine.store.insert_doc("w1b", "session", "knowledge://shared/kc/wiki/alpha.md", Some("A"), "h1", 10, "2026-01-02T00:00:00Z", None, None).unwrap();
    engine.store.resolve_dangling_links("alpha", "w1b").unwrap();
    let g2 = engine.graph_doc("keep", None).unwrap();
    let link2 = g2.outbound.iter().find(|l| l.target_name == "alpha").unwrap();
    assert_eq!(link2.doc.as_ref().map(|d| d.doc_id.as_str()), Some("w1b"), "새 origin으로 self-heal");

    let _ = std::fs::remove_dir_all(&dir);
}

/// M10 관계선: /graph/links는 해석된 쌍만 내고, 한쪽 끝이라도 스코프 밖이면
/// 쌍째 제외한다(dangling도 정의상 제외 — target 미해석).
#[test]
fn graph_links_pairs_exclude_out_of_scope_endpoints() {
    let (engine, dir) = temp_engine();
    engine.store.insert_doc("a", "manual", "origin://n/a.md", Some("A"), "h1", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
    engine.store.insert_doc("b", "manual", "origin://n/b.md", Some("B"), "h2", 10, "2026-01-01T00:00:00Z", None, None).unwrap();
    engine.store.insert_doc("p", "manual", "origin://n/p.md", Some("P"), "h3", 10, "2026-01-01T00:00:00Z", None, Some("alice")).unwrap();
    // a→b(공용-공용), a→p(공용-개인), a→x(dangling), p→b(개인-공용)
    engine.store.replace_doc_links("a", &[
        ("links".into(), "b".into()),
        ("related".into(), "p".into()),
        ("links".into(), "x".into()),
    ]).unwrap();
    engine.store.replace_doc_links("p", &[("up".into(), "b".into())]).unwrap();

    // 공통 스코프: a→b 하나만(개인이 낀 쌍·dangling 전부 제외).
    let shared = engine.graph_links(None).unwrap();
    assert_eq!(shared.links.len(), 1, "공통 스코프 쌍 수: {:?}", shared.links);
    assert_eq!(shared.links[0].src_doc_id, "a");
    assert_eq!(shared.links[0].dst_doc_id, "b");
    assert_eq!(shared.links[0].rel_type, "links");

    // alice 스코프: a→b, a→p, p→b 셋 다(dangling만 제외).
    let alice = engine.graph_links(Some("shared+alice")).unwrap();
    assert_eq!(alice.links.len(), 3, "alice 스코프 쌍 수: {:?}", alice.links);
    assert!(alice.links.iter().any(|l| l.src_doc_id == "p" && l.dst_doc_id == "b" && l.rel_type == "up"));

    let _ = std::fs::remove_dir_all(&dir);
}
