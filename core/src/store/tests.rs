// store unit tests — moved verbatim from the #[cfg(test)] mod tests body of the original store.rs.

    use super::*;

    fn temp_db() -> (Store, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("cosmos-store-test-{}.sqlite3", uuid::Uuid::new_v4()));
        let store = Store::open(&path).expect("open store");
        (store, path)
    }

    #[test]
    fn doc_insert_and_lookup_roundtrip() {
        let (store, path) = temp_db();
        store
            .insert_doc("d1", "manual", "origin://a", Some("Title"), "hash1", 100, "2026-01-01T00:00:00Z", None, None)
            .expect("insert_doc");
        let found = store.find_doc_by_origin("origin://a").expect("find_doc_by_origin");
        assert_eq!(found, Some(("d1".to_string(), "hash1".to_string())));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn chunk_insert_and_fetch_preserves_order() {
        let (store, path) = temp_db();
        store
            .insert_doc("d1", "manual", "origin://a", None, "hash1", 100, "2026-01-01T00:00:00Z", None, None)
            .expect("insert_doc");
        let chunks = vec![
            NewChunk { id: "c2".into(), seq: 1, text: "second".into(), char_start: 10, char_end: 16, section: None, embedding: vec![] },
            NewChunk { id: "c1".into(), seq: 0, text: "first".into(), char_start: 0, char_end: 5, section: None, embedding: vec![] },
        ];
        store.insert_chunks("d1", &chunks).expect("insert_chunks");
        let hydrated = store.fetch_chunks_by_ids(&["c1".to_string(), "c2".to_string()]).expect("fetch_chunks_by_ids");
        assert_eq!(hydrated.len(), 2);
        assert_eq!(hydrated[0].chunk_id, "c1");
        assert_eq!(hydrated[1].chunk_id, "c2");
        assert_eq!(hydrated[0].origin, "origin://a");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn event_append_and_list() {
        let (store, path) = temp_db();
        let seq = store.append_event("2026-01-01T00:00:00Z", "ingest", "{}", "{}").expect("append_event");
        assert!(seq >= 1);
        let events = store.list_events(0).expect("list_events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "ingest");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn update_doc_meta_json_roundtrip() {
        let (store, path) = temp_db();
        store
            .insert_doc("d1", "manual", "origin://a", None, "hash1", 100, "2026-01-01T00:00:00Z", None, None)
            .expect("insert_doc");
        store.update_doc_meta_json("d1", r#"{"fit":0.63}"#).expect("update_doc_meta_json");
        let conn = store.conn.lock().expect("sqlite mutex poisoned");
        let meta_json: String = conn
            .query_row("SELECT meta_json FROM docs WHERE id = ?1", params!["d1"], |row| row.get(0))
            .expect("querying meta_json");
        drop(conn);
        assert_eq!(meta_json, r#"{"fit":0.63}"#);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cluster_centroid_migration_is_idempotent() {
        let (store, path) = temp_db();
        // Store::open already ran the migration once; reopening the same
        // file must not error even though the column already exists.
        let store2 = Store::open(&path).expect("reopen store runs migration again");
        store2
            .insert_cluster("cl1", "c01-test", "active", &[1, 2, 3, 4], "2026-01-01T00:00:00Z", None)
            .expect("insert_cluster after migration");
        let row = store.get_cluster_row("cl1").expect("get_cluster_row").expect("cluster exists");
        assert_eq!(row.centroid, Some(vec![1, 2, 3, 4]));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn branch_migration_is_idempotent() {
        let (store, path) = temp_db();
        // Store::open already ran the migration once (branches table +
        // docs.branch_id column); reopening the same file must not error
        // even though both already exist.
        let store2 = Store::open(&path).expect("reopen store runs migration again");
        let name_conflict = store2
            .create_branch("b1", "feature-x", None, "2026-01-01T00:00:00Z")
            .expect("create_branch after migration");
        assert!(!name_conflict);
        store2
            .insert_doc("d1", "manual", "origin://d1", None, "hash", 10, "2026-01-01T00:00:00Z", Some("b1"), None)
            .expect("insert_doc with branch_id after migration");
        let row = store.get_branch_row("b1").expect("get_branch_row").expect("branch exists");
        assert_eq!(row.n_docs, 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn owner_columns_migration_is_idempotent() {
        let (store, path) = temp_db();
        // Store::open already ran migrate_docs_owner_column and
        // migrate_clusters_owner_column once; reopening the same file must
        // not error even though both columns already exist.
        let store2 = Store::open(&path).expect("reopen store runs owner migrations again");

        store2
            .insert_doc("d1", "manual", "origin://d1", None, "hash", 10, "2026-01-01T00:00:00Z", None, Some("alice"))
            .expect("insert_doc with owner after migration");
        store2
            .insert_cluster("cl1", "personal-alice", "active", &[1, 2, 3, 4], "2026-01-01T00:00:00Z", Some("alice"))
            .expect("insert_cluster with owner after migration");

        let docs = store.list_docs().expect("list_docs");
        let doc = docs.iter().find(|d| d.doc_id == "d1").expect("doc exists");
        assert_eq!(doc.owner.as_deref(), Some("alice"));

        let clusters = store.clusters_for_owner(Some("alice")).expect("clusters_for_owner");
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].id, "cl1");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn owner_scope_parses_three_variants() {
        assert_eq!(OwnerScope::parse(None), OwnerScope::Shared);
        assert_eq!(OwnerScope::parse(Some("shared")), OwnerScope::Shared);
        assert_eq!(OwnerScope::parse(Some("shared+alice")), OwnerScope::Named("alice".to_string()));
    }

    #[test]
    fn scoped_chunk_ids_excludes_other_owners_chunks() {
        let (store, path) = temp_db();
        store
            .insert_doc("d-shared", "manual", "origin://shared", None, "hash1", 10, "2026-01-01T00:00:00Z", None, None)
            .expect("insert shared doc");
        store
            .insert_doc("d-alice", "manual", "origin://alice", None, "hash2", 10, "2026-01-01T00:00:00Z", None, Some("alice"))
            .expect("insert alice doc");
        store
            .insert_doc("d-bob", "manual", "origin://bob", None, "hash3", 10, "2026-01-01T00:00:00Z", None, Some("bob"))
            .expect("insert bob doc");

        store
            .insert_chunks("d-shared", &[NewChunk { id: "c-shared".into(), seq: 0, text: "s".into(), char_start: 0, char_end: 1, section: None, embedding: vec![] }])
            .expect("insert shared chunk");
        store
            .insert_chunks("d-alice", &[NewChunk { id: "c-alice".into(), seq: 0, text: "a".into(), char_start: 0, char_end: 1, section: None, embedding: vec![] }])
            .expect("insert alice chunk");
        store
            .insert_chunks("d-bob", &[NewChunk { id: "c-bob".into(), seq: 0, text: "b".into(), char_start: 0, char_end: 1, section: None, embedding: vec![] }])
            .expect("insert bob chunk");

        let shared_scope = store.scoped_chunk_ids(None, &OwnerScope::Shared).expect("scoped_chunk_ids shared");
        assert!(shared_scope.contains("c-shared"));
        assert!(!shared_scope.contains("c-alice"));
        assert!(!shared_scope.contains("c-bob"));

        let alice_scope = store
            .scoped_chunk_ids(None, &OwnerScope::Named("alice".to_string()))
            .expect("scoped_chunk_ids alice");
        assert!(alice_scope.contains("c-shared"));
        assert!(alice_scope.contains("c-alice"));
        assert!(!alice_scope.contains("c-bob"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn get_event_fetches_single_seq() {
        let (store, path) = temp_db();
        let seq1 = store.append_event("2026-01-01T00:00:00Z", "ingest", "{}", "{}").expect("append_event 1");
        let seq2 = store.append_event("2026-01-01T00:00:01Z", "assign", "{}", "{}").expect("append_event 2");
        let ev1 = store.get_event(seq1).expect("get_event 1").expect("event 1 exists");
        assert_eq!(ev1.kind, "ingest");
        let ev2 = store.get_event(seq2).expect("get_event 2").expect("event 2 exists");
        assert_eq!(ev2.kind, "assign");
        assert!(store.get_event(9999).expect("get_event missing").is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn get_cluster_full_row_reads_all_columns() {
        let (store, path) = temp_db();
        store.insert_cluster("cl1", "c01-test", "active", &[1, 2, 3, 4], "2026-01-01T00:00:00Z", None).expect("insert_cluster");
        let row = store.get_cluster_full_row("cl1").expect("get_cluster_full_row").expect("cluster exists");
        assert_eq!(row.id, "cl1");
        assert_eq!(row.slug.as_deref(), Some("c01-test"));
        assert_eq!(row.status, "active");
        assert_eq!(row.centroid, Some(vec![1, 2, 3, 4]));
        assert_eq!(row.stats_json, "{}");
        assert!(row.name.is_none());
        assert!(store.get_cluster_full_row("missing").expect("get_cluster_full_row missing").is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rollback_cluster_birth_restores_prior_state() {
        let (store, path) = temp_db();
        store
            .insert_doc("d1", "manual", "origin://a", None, "hash1", 100, "2026-01-01T00:00:00Z", None, None)
            .expect("insert_doc");
        let chunks = vec![NewChunk {
            id: "c1".into(),
            seq: 0,
            text: "text".into(),
            char_start: 0,
            char_end: 4,
            section: None,
            embedding: vec![],
        }];
        store.insert_chunks("d1", &chunks).expect("insert_chunks");
        // pre-birth: unassigned, low_fit meta_json.
        store.update_chunk_cluster_ids_for_doc("d1", "[]").expect("seed cluster_ids");
        store.update_doc_meta_json("d1", r#"{"low_fit":true}"#).expect("seed meta_json");
        // simulate birth having already run: new cluster + reassigned doc.
        store.insert_cluster("cl-new", "c-new", "active", &[9, 9, 9, 9], "2026-01-02T00:00:00Z", None).expect("insert_cluster");
        store.update_chunk_cluster_ids_for_doc("d1", r#"["cl-new"]"#).expect("post-birth cluster_ids");
        store.update_doc_meta_json("d1", r#"{"fit":0.9}"#).expect("post-birth meta_json");

        let snapshot = DocClusterSnapshot {
            doc_id: "d1".to_string(),
            prev_cluster_ids_json: "[]".to_string(),
            prev_meta_json: r#"{"low_fit":true}"#.to_string(),
        };
        store.rollback_cluster_birth("cl-new", &[snapshot]).expect("rollback_cluster_birth");

        assert!(store.get_cluster_row("cl-new").expect("get_cluster_row").is_none());
        let conn = store.conn.lock().expect("sqlite mutex poisoned");
        let cluster_ids: String =
            conn.query_row("SELECT cluster_ids FROM chunks WHERE doc_id='d1'", [], |r| r.get(0)).expect("cluster_ids");
        let meta_json: String =
            conn.query_row("SELECT meta_json FROM docs WHERE id='d1'", [], |r| r.get(0)).expect("meta_json");
        drop(conn);
        assert_eq!(cluster_ids, "[]");
        assert_eq!(meta_json, r#"{"low_fit":true}"#);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rollback_cluster_merge_restores_src_and_dst() {
        let (store, path) = temp_db();
        store.insert_cluster("src", "c-src", "active", &[1, 1, 1, 1], "2026-01-01T00:00:00Z", None).expect("insert src");
        store.insert_cluster("dst", "c-dst", "active", &[2, 2, 2, 2], "2026-01-01T00:00:00Z", None).expect("insert dst");
        let src_snapshot = store.get_cluster_full_row("src").expect("get_cluster_full_row").expect("src exists");

        store
            .insert_doc("d1", "manual", "origin://a", None, "hash1", 100, "2026-01-01T00:00:00Z", None, None)
            .expect("insert_doc");
        store
            .insert_chunks("d1", &[NewChunk { id: "c1".into(), seq: 0, text: "t".into(), char_start: 0, char_end: 1, section: None, embedding: vec![] }])
            .expect("insert_chunks");
        store.update_chunk_cluster_ids_for_doc("d1", r#"["src"]"#).expect("seed cluster_ids");
        store.update_doc_meta_json("d1", r#"{"fit":0.7}"#).expect("seed meta_json");

        // simulate merge having already run.
        store.set_cluster_status_and_stats("src", "merged", r#"{"merged_into":"dst"}"#, "2026-01-03T00:00:00Z").expect("mark merged");
        store.update_cluster_centroid("dst", &[3, 3, 3, 3], "2026-01-03T00:00:00Z").expect("recompute dst centroid");
        store.update_chunk_cluster_ids_for_doc("d1", r#"["dst"]"#).expect("move chunk");
        store.update_doc_meta_json("d1", r#"{"fit":0.95}"#).expect("post-merge meta_json");

        let moved = vec![DocClusterSnapshot {
            doc_id: "d1".to_string(),
            prev_cluster_ids_json: r#"["src"]"#.to_string(),
            prev_meta_json: r#"{"fit":0.7}"#.to_string(),
        }];
        store
            .rollback_cluster_merge(&src_snapshot, &moved, "dst", &[2, 2, 2, 2], "2026-01-04T00:00:00Z")
            .expect("rollback_cluster_merge");

        let src_row = store.get_cluster_row("src").expect("get_cluster_row src").expect("src still exists");
        assert_eq!(src_row.status, "active");
        let dst_row = store.get_cluster_row("dst").expect("get_cluster_row dst").expect("dst exists");
        assert_eq!(dst_row.centroid, Some(vec![2, 2, 2, 2]));
        let conn = store.conn.lock().expect("sqlite mutex poisoned");
        let cluster_ids: String =
            conn.query_row("SELECT cluster_ids FROM chunks WHERE doc_id='d1'", [], |r| r.get(0)).expect("cluster_ids");
        let meta_json: String =
            conn.query_row("SELECT meta_json FROM docs WHERE id='d1'", [], |r| r.get(0)).expect("meta_json");
        drop(conn);
        assert_eq!(cluster_ids, r#"["src"]"#);
        assert_eq!(meta_json, r#"{"fit":0.7}"#);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rollback_cluster_rename_can_null_out_a_field() {
        let (store, path) = temp_db();
        store.insert_cluster("cl1", "c01", "active", &[1, 2, 3, 4], "2026-01-01T00:00:00Z", None).expect("insert_cluster");
        // rename: name goes from NULL -> "New Name".
        store.update_cluster_row("cl1", None, Some("New Name"), None, "2026-01-02T00:00:00Z").expect("update_cluster_row");
        let renamed = store.get_cluster_row("cl1").expect("get_cluster_row").expect("cluster exists");
        assert_eq!(renamed.name.as_deref(), Some("New Name"));

        // rollback must restore name to NULL, which COALESCE-based
        // update_cluster_row cannot do (a `None` param there means "leave
        // unchanged", not "set to NULL").
        let found = store
            .rollback_cluster_rename("cl1", Some("c01"), None, None, "2026-01-03T00:00:00Z")
            .expect("rollback_cluster_rename");
        assert!(found);
        let restored = store.get_cluster_row("cl1").expect("get_cluster_row").expect("cluster exists");
        assert!(restored.name.is_none());
        assert_eq!(restored.slug.as_deref(), Some("c01"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn list_entities_filters_by_kind() {
        let (store, path) = temp_db();
        store
            .insert_doc("d1", "manual", "origin://a", Some("A"), "hash1", 10, "2026-01-01T00:00:00Z", None, None)
            .expect("insert_doc d1");
        store
            .insert_doc("d2", "manual", "origin://b", Some("B"), "hash2", 10, "2026-01-01T00:00:00Z", None, None)
            .expect("insert_doc d2");
        store
            .upsert_entity(
                "d1",
                &EntityFields { name: "Entity A".into(), kind: "project".into(), ..Default::default() },
            )
            .expect("upsert_entity d1");
        store
            .upsert_entity(
                "d2",
                &EntityFields { name: "Entity B".into(), kind: "debugging".into(), ..Default::default() },
            )
            .expect("upsert_entity d2");

        let projects = store.list_entities(Some("project")).expect("list_entities kind filter");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].doc_id, "d1");
        assert_eq!(projects[0].name, "Entity A");
        assert_eq!(projects[0].origin, "origin://a");

        let all = store.list_entities(None).expect("list_entities no filter");
        assert_eq!(all.len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cluster_digest_upsert_and_list_roundtrip() {
        let (store, path) = temp_db();
        store
            .insert_cluster("cl1", "c01-active", "active", &[], "2026-01-01T00:00:00Z", None)
            .expect("insert_cluster");
        store
            .upsert_cluster_digest("cl1", "초기 다이제스트", Some("test-model"), "2026-01-01T00:00:00Z")
            .expect("upsert_cluster_digest insert");

        let digests = store.list_active_cluster_digests().expect("list_active_cluster_digests");
        assert_eq!(digests.len(), 1);
        assert_eq!(digests[0].cluster_id, "cl1");
        assert_eq!(digests[0].slug.as_deref(), Some("c01-active"));
        assert_eq!(digests[0].text, "초기 다이제스트");
        assert_eq!(digests[0].model.as_deref(), Some("test-model"));

        // Re-upsert with new text must update in place (ON CONFLICT), not
        // duplicate the row.
        store
            .upsert_cluster_digest("cl1", "갱신된 다이제스트", None, "2026-01-02T00:00:00Z")
            .expect("upsert_cluster_digest update");
        let digests2 = store.list_active_cluster_digests().expect("list_active_cluster_digests after update");
        assert_eq!(digests2.len(), 1);
        assert_eq!(digests2[0].text, "갱신된 다이제스트");
        assert_eq!(digests2[0].model, None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn list_active_cluster_digests_excludes_non_active() {
        let (store, path) = temp_db();
        store
            .insert_cluster("cl1", "c01-dormant", "dormant", &[], "2026-01-01T00:00:00Z", None)
            .expect("insert_cluster");
        store
            .upsert_cluster_digest("cl1", "휴면 클러스터 다이제스트", None, "2026-01-01T00:00:00Z")
            .expect("upsert_cluster_digest");

        let digests = store.list_active_cluster_digests().expect("list_active_cluster_digests");
        assert!(digests.is_empty());
        let _ = std::fs::remove_file(&path);
    }
