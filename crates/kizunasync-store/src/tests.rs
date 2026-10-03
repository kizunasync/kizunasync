use super::*;
use kizunasync_protocol::Op;
use serde_json::{Map, Value, json};

#[test]
fn apply_insert_journals_the_write_and_clear_outbox_ids_empties_it() {
    let store = LocalStore::open_in_memory().expect("open");
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hello"));
    columns.insert("owner_id".into(), json!("u1"));
    store
        .apply(
            &LocalMutation {
                table: "todos".into(),
                pk: "p1".into(),
                op: Op::Insert,
                columns,
                transforms: None,
                precondition: None,
                batch_id: None,
                hlc: None,
                mutation_id: None,
            },
            "m1",
            "2020-01-01T00:00:00.000Z",
            None,
        )
        .expect("apply");

    assert_eq!(store.outbox_depth().unwrap(), 1);
    let row = store.read("todos", "p1").unwrap().expect("row");
    assert_eq!(row.columns.get("title").unwrap(), &json!("hello"));

    store.clear_outbox_ids(&["m1".into()]).unwrap();
    assert_eq!(store.outbox_depth().unwrap(), 0);
}

#[test]
fn increment_on_a_non_integer_cell_still_queues() {
    let store = LocalStore::open_in_memory().expect("open");
    let mut columns = Map::new();
    columns.insert("title".into(), json!("start"));
    store
        .apply(
            &LocalMutation {
                table: "todos".into(),
                pk: "p1".into(),
                op: Op::Insert,
                columns,
                transforms: None,
                precondition: None,
                batch_id: None,
                hlc: None,
                mutation_id: None,
            },
            "m1",
            "2020-01-01T00:00:00.000Z",
            None,
        )
        .expect("insert");
    store.clear_outbox_ids(&["m1".into()]).unwrap();

    let mut transforms = Map::new();
    transforms.insert("title".into(), json!({ "op": "increment", "by": 1 }));
    store
        .apply(
            &LocalMutation {
                table: "todos".into(),
                pk: "p1".into(),
                op: Op::Update,
                columns: Map::new(),
                transforms: Some(transforms),
                precondition: None,
                batch_id: None,
                hlc: None,
                mutation_id: None,
            },
            "m2",
            "2020-01-01T00:00:00.000Z",
            None,
        )
        .expect("increment queues");
    assert_eq!(store.outbox_depth().unwrap(), 1);
    let row = store.read("todos", "p1").unwrap().expect("row");
    assert_eq!(row.columns.get("title"), Some(&json!("start")));
}

#[test]
fn claim_attachment_blocks_a_second_claim_and_synced_state_removes_it_from_pending() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .enqueue_attachment(&AttachmentEntry {
            reference: "u1/p1/id.bin".into(),
            upload_id: "id".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            sha256: Some("abc".into()),
            content_type: Some("image/png".into()),
            size: Some(100),
            local_path: Some("/tmp/x".into()),
            direction: "upload".into(),
            state: AttachmentState::Queued,
            in_flight: false,
            fingerprint: None,
            progress: 0,
            attempts: 0,
            permanent: false,
            chunk_offset: 0,
            tus_url: None,
            error: None,
            created_at: now.into(),
            updated_at: now.into(),
            error_code: None,
        })
        .expect("enqueue");

    let pending = store.list_pending_attachments("upload", 10).expect("list");
    assert_eq!(pending.len(), 1);

    assert_eq!(
        store
            .claim_attachment("u1/p1/id.bin", AttachmentState::Uploading, now)
            .expect("claim"),
        Some(0),
        "a first claim reports no attempt consumed before it"
    );

    // second claim must fail while in_flight
    assert_eq!(
        store
            .claim_attachment("u1/p1/id.bin", AttachmentState::Uploading, now)
            .expect("claim2"),
        None
    );

    store
        .upsert_attachment_progress(
            "u1/p1/id.bin",
            40,
            40,
            Some("tus://x"),
            AttachmentState::Uploading,
            true,
            now,
        )
        .expect("progress");
    let entry = store
        .get_attachment("u1/p1/id.bin")
        .expect("get")
        .expect("present");
    assert_eq!(entry.chunk_offset, 40);
    assert_eq!(entry.tus_url.as_deref(), Some("tus://x"));
    // A mid-transfer progress write keeps the claim, so a crash before the
    // terminal write is still recoverable.
    assert!(entry.in_flight);
    store
        .update_attachment_state("u1/p1/id.bin", AttachmentState::Synced, false, None, now)
        .expect("synced");
    assert!(
        store
            .list_pending_attachments("upload", 10)
            .expect("list2")
            .is_empty()
    );
}

/// A queue row for the embedder-facing half of the queue: the patch surface
/// the `TypeScript` attachment queue drives through NAPI, plus the
/// re-enqueue contract that distinguishes [`LocalStore::put_attachment`]
/// from [`LocalStore::enqueue_attachment`].
fn download_attachment_fixture(now: &str) -> AttachmentEntry {
    AttachmentEntry {
        reference: "u1/p1/id.bin".into(),
        upload_id: "id".into(),
        table: "todos".into(),
        pk: "p1".into(),
        column: "photo".into(),
        bucket: "media".into(),
        owner: "u1".into(),
        sha256: None,
        content_type: None,
        size: None,
        local_path: None,
        direction: "download".into(),
        state: AttachmentState::Queued,
        in_flight: false,
        fingerprint: None,
        progress: 0,
        attempts: 0,
        permanent: false,
        chunk_offset: 0,
        tus_url: None,
        error: None,
        created_at: now.into(),
        updated_at: now.into(),
        error_code: None,
    }
}

#[test]
fn put_attachment_makes_the_row_visible_in_the_pending_list() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&download_attachment_fixture(now))
        .expect("put");
    assert_eq!(
        store
            .list_pending_attachments("download", 10)
            .expect("pending")
            .len(),
        1
    );
}

#[test]
fn claim_attachment_without_attempt_does_not_charge_an_attempt_and_blocks_a_second_claim() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&download_attachment_fixture(now))
        .expect("put");

    // Claiming does NOT charge an attempt: the embedder's queue counts its own.
    assert_eq!(
        store
            .claim_attachment_without_attempt("u1/p1/id.bin", AttachmentState::Downloading, now)
            .expect("claim"),
        Some(0)
    );
    assert!(
        store
            .claim_attachment_without_attempt("u1/p1/id.bin", AttachmentState::Downloading, now)
            .expect("claim twice")
            .is_none()
    );
    assert_eq!(
        store
            .get_attachment("u1/p1/id.bin")
            .expect("get")
            .expect("present")
            .attempts,
        0
    );
}

#[test]
fn update_attachment_patches_the_named_columns() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&download_attachment_fixture(now))
        .expect("put");

    let mut patch = Map::new();
    patch.insert("state".into(), json!("failed"));
    patch.insert("in_flight".into(), json!(false));
    patch.insert("attempts".into(), json!(1));
    patch.insert("error".into(), json!("boom"));
    patch.insert("local_path".into(), Value::Null);
    store
        .update_attachment("u1/p1/id.bin", &patch, "2020-01-01T00:00:01.000Z")
        .expect("patch");
    let patched = store
        .get_attachment("u1/p1/id.bin")
        .expect("get")
        .expect("present");
    assert_eq!(patched.state, AttachmentState::Failed);
    assert!(!patched.in_flight);
    assert_eq!(patched.attempts, 1);
    assert_eq!(patched.error.as_deref(), Some("boom"));
    assert_eq!(patched.updated_at, "2020-01-01T00:00:01.000Z");
}

// A column outside the patch allowlist is a caller bug, not a silent skip.
#[test]
fn update_attachment_rejects_a_column_outside_the_patch_allowlist() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&download_attachment_fixture(now))
        .expect("put");

    let mut illegal = Map::new();
    illegal.insert("ref".into(), json!("other"));
    assert!(
        store
            .update_attachment("u1/p1/id.bin", &illegal, now)
            .is_err()
    );
}

// Re-enqueue is a FRESH job: the failure bookkeeping is gone.
#[test]
fn put_attachment_on_an_existing_reference_resets_failure_bookkeeping() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    let entry = download_attachment_fixture(now);
    store.put_attachment(&entry).expect("put");

    let mut patch = Map::new();
    patch.insert("state".into(), json!("failed"));
    patch.insert("attempts".into(), json!(1));
    patch.insert("error".into(), json!("boom"));
    store
        .update_attachment("u1/p1/id.bin", &patch, now)
        .expect("patch");

    store.put_attachment(&entry).expect("re-put");
    let fresh = store
        .get_attachment("u1/p1/id.bin")
        .expect("get")
        .expect("present");
    assert_eq!(fresh.state, AttachmentState::Queued);
    assert_eq!(fresh.attempts, 0);
    assert_eq!(fresh.error, None);
}

#[test]
fn mark_attachment_orphaned_lists_the_row_as_orphaned() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&download_attachment_fixture(now))
        .expect("put");

    store
        .mark_attachment_orphaned("u1/p1/id.bin", now)
        .expect("orphan");
    assert_eq!(
        store.list_orphaned_attachments().expect("orphaned").len(),
        1
    );
}

/// An evicted row still caching its bytes is listed beside the orphans, so the
/// vacuum deletes those bytes; once they are gone the row is not listed again.
#[test]
fn evicted_rows_still_caching_bytes_are_listed_beside_the_orphans() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    let row = |reference: &str, local_path: Option<&str>| AttachmentEntry {
        reference: reference.into(),
        local_path: local_path.map(str::to_string),
        ..download_attachment_fixture(now)
    };
    store
        .put_attachment(&row("u1/p1/orphan.bin", None))
        .expect("put");
    store
        .put_attachment(&row("u2/p9/cached.bin", Some("downloads/cached")))
        .expect("put");
    store
        .put_attachment(&row("u2/p9/bare.bin", None))
        .expect("put");
    store
        .put_attachment(&row("u2/p9/live.bin", None))
        .expect("put");
    store
        .mark_attachment_orphaned("u1/p1/orphan.bin", now)
        .expect("orphan");
    store
        .mark_attachment_evicted("u2/p9/cached.bin", now)
        .expect("evict");
    store
        .mark_attachment_evicted("u2/p9/bare.bin", now)
        .expect("evict");

    let listed: Vec<(String, AttachmentState)> = store
        .list_orphaned_attachments()
        .expect("list")
        .into_iter()
        .map(|entry| (entry.reference, entry.state))
        .collect();

    assert_eq!(
        listed,
        vec![
            ("u1/p1/orphan.bin".to_string(), AttachmentState::Orphaned),
            ("u2/p9/cached.bin".to_string(), AttachmentState::Evicted),
        ]
    );
}

/// An eviction drops only this device's copy: the facts that verify the
/// object again stay, and an object already handed to the vacuum for removal
/// from Storage keeps that fate.
#[test]
fn mark_attachment_evicted_keeps_the_object_facts_and_never_undoes_an_orphan() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&AttachmentEntry {
            sha256: Some("a".repeat(64)),
            size: Some(9),
            content_type: Some("image/png".into()),
            local_path: Some("downloads/cached".into()),
            ..download_attachment_fixture(now)
        })
        .expect("put");
    store
        .put_attachment(&AttachmentEntry {
            reference: "u1/p1/orphan.bin".into(),
            ..download_attachment_fixture(now)
        })
        .expect("put");
    store
        .mark_attachment_orphaned("u1/p1/orphan.bin", now)
        .expect("orphan");

    store
        .mark_attachment_evicted("u1/p1/id.bin", "2020-01-01T00:00:01.000Z")
        .expect("evict");
    store
        .mark_attachment_evicted("u1/p1/orphan.bin", now)
        .expect("evict an orphan");

    let evicted = store
        .get_attachment("u1/p1/id.bin")
        .expect("get")
        .expect("the row stays");
    assert_eq!(evicted.state, AttachmentState::Evicted);
    assert_eq!(evicted.sha256, Some("a".repeat(64)));
    assert_eq!(evicted.size, Some(9));
    assert_eq!(evicted.content_type.as_deref(), Some("image/png"));
    assert_eq!(evicted.local_path.as_deref(), Some("downloads/cached"));
    assert!(!evicted.in_flight);
    assert_eq!(
        store
            .get_attachment("u1/p1/orphan.bin")
            .expect("get")
            .expect("present")
            .state,
        AttachmentState::Orphaned
    );
}

/// A failure writes its code beside its message; a transition that records
/// none clears both.
#[test]
fn a_recorded_failure_keeps_its_code_until_a_transition_clears_it() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&download_attachment_fixture(now))
        .expect("put");

    store
        .update_attachment_state(
            "u1/p1/id.bin",
            AttachmentState::Failed,
            false,
            Some(AttachmentFailure {
                message: "missing sandbox bytes",
                code: "STORE",
            }),
            now,
        )
        .expect("fail");
    let failed = store
        .get_attachment("u1/p1/id.bin")
        .expect("get")
        .expect("present");
    assert_eq!(failed.error.as_deref(), Some("missing sandbox bytes"));
    assert_eq!(failed.error_code.as_deref(), Some("STORE"));

    store
        .update_attachment_state("u1/p1/id.bin", AttachmentState::Queued, false, None, now)
        .expect("queue");
    let queued = store
        .get_attachment("u1/p1/id.bin")
        .expect("get")
        .expect("present");
    assert_eq!(queued.error, None);
    assert_eq!(queued.error_code, None);
}

/// Every write that clears a row's failure message clears its code with it:
/// a claim, a hand retry, and a fresh re-enqueue.
#[test]
fn a_claim_a_retry_and_a_re_enqueue_clear_the_failure_code() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    let fail = |store: &LocalStore| {
        let mut patch = Map::new();
        patch.insert("state".into(), json!("failed"));
        patch.insert("error".into(), json!("boom"));
        patch.insert("error_code".into(), json!("TRANSFER"));
        store
            .update_attachment("u1/p1/id.bin", &patch, now)
            .expect("patch");
        assert_eq!(
            store
                .get_attachment("u1/p1/id.bin")
                .expect("get")
                .expect("present")
                .error_code
                .as_deref(),
            Some("TRANSFER")
        );
    };
    let code = |store: &LocalStore| {
        store
            .get_attachment("u1/p1/id.bin")
            .expect("get")
            .expect("present")
            .error_code
    };
    store
        .put_attachment(&download_attachment_fixture(now))
        .expect("put");

    fail(&store);
    store
        .claim_attachment("u1/p1/id.bin", AttachmentState::Downloading, now)
        .expect("claim");
    assert_eq!(code(&store), None, "claim");

    fail(&store);
    store.retry_attachment("u1/p1/id.bin", now).expect("retry");
    assert_eq!(code(&store), None, "retry");

    fail(&store);
    store
        .put_attachment(&download_attachment_fixture(now))
        .expect("re-put");
    assert_eq!(code(&store), None, "re-enqueue");
}

/// A database created before the attachment table had its `error_code`
/// column gains it at open, with every row it already holds intact.
#[test]
fn opening_a_database_whose_attachment_table_lacks_error_code_adds_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("before.db");
    {
        let conn = rusqlite::Connection::open(&path).expect("open raw");
        conn.execute_batch(
            "CREATE TABLE _kizunasync_attachments (
               ref TEXT PRIMARY KEY, upload_id TEXT NOT NULL, table_name TEXT NOT NULL,
               pk TEXT NOT NULL, column_name TEXT NOT NULL, bucket TEXT NOT NULL,
               owner TEXT NOT NULL, sha256 TEXT, content_type TEXT, size INTEGER,
               local_path TEXT, direction TEXT NOT NULL, state TEXT NOT NULL,
               in_flight INTEGER NOT NULL DEFAULT 0, fingerprint TEXT,
               progress INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
               permanent INTEGER NOT NULL DEFAULT 0, chunk_offset INTEGER NOT NULL DEFAULT 0,
               tus_url TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             INSERT INTO _kizunasync_attachments
               (ref, upload_id, table_name, pk, column_name, bucket, owner, direction, state,
                error, created_at, updated_at)
             VALUES ('u1/p1/id.bin', 'id', 'todos', 'p1', 'photo', 'media', 'u1', 'download',
                     'failed', 'boom', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');",
        )
        .expect("the table as it was");
    }

    let store = LocalStore::open_path(&path).expect("open");
    let kept = store
        .get_attachment("u1/p1/id.bin")
        .expect("get")
        .expect("the row survives");
    assert_eq!(kept.error.as_deref(), Some("boom"));
    assert_eq!(kept.error_code, None);

    let mut coded = Map::new();
    coded.insert("error_code".into(), json!("TRANSFER"));
    store
        .update_attachment("u1/p1/id.bin", &coded, "2020-01-01T00:00:01.000Z")
        .expect("patch");
    drop(store);
    let reopened = LocalStore::open_path(&path).expect("reopen");
    assert_eq!(
        reopened
            .get_attachment("u1/p1/id.bin")
            .expect("get")
            .expect("present")
            .error_code
            .as_deref(),
        Some("TRANSFER")
    );
}

#[test]
fn purge_attachment_removes_the_row() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&download_attachment_fixture(now))
        .expect("put");

    store.purge_attachment("u1/p1/id.bin").expect("purge");
    assert!(store.get_attachment("u1/p1/id.bin").expect("get").is_none());
}

/// The claim the embedder's queue needs to survive a crash: recovery of a
/// claim nobody holds any more, without recharging the attempt it already
/// spent.
#[test]
fn recover_in_flight_attachments_resets_state_without_recharging_the_attempt() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&AttachmentEntry {
            reference: "u1/p1/a.bin".into(),
            upload_id: "id".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            sha256: None,
            content_type: None,
            size: None,
            local_path: Some("sandbox/shared".into()),
            direction: "upload".into(),
            state: AttachmentState::Queued,
            in_flight: false,
            fingerprint: None,
            progress: 0,
            attempts: 0,
            permanent: false,
            chunk_offset: 0,
            tus_url: None,
            error: None,
            created_at: now.into(),
            updated_at: now.into(),
            error_code: None,
        })
        .expect("put a");

    // A claim charged an attempt; the crash recovery must not spend another.
    assert!(
        store
            .claim_attachment("u1/p1/a.bin", AttachmentState::Uploading, now)
            .expect("claim")
            .is_some()
    );
    assert!(
        store
            .list_pending_attachments("upload", 10)
            .expect("pending")
            .iter()
            .all(|e| e.reference != "u1/p1/a.bin")
    );

    store
        .recover_in_flight_attachments("2020-01-01T00:00:05.000Z")
        .expect("recover");
    let recovered = store
        .get_attachment("u1/p1/a.bin")
        .expect("get")
        .expect("present");
    assert_eq!(recovered.state, AttachmentState::Queued);
    assert!(!recovered.in_flight);
    assert_eq!(recovered.attempts, 1);
    assert_eq!(recovered.updated_at, "2020-01-01T00:00:05.000Z");
    assert_eq!(
        store
            .claim_attachment("u1/p1/a.bin", AttachmentState::Uploading, now)
            .expect("re-claim"),
        Some(1),
        "the recovered row reports the attempt the first claim charged"
    );
}

/// The shared-path count the vacuum consults before deleting a file: two
/// references can share one sandboxed path, and an orphaned or evicted row
/// must never keep it alive.
#[test]
fn count_live_attachments_at_local_path_excludes_a_reference_and_rows_the_vacuum_owns() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    let entry = |reference: &str| AttachmentEntry {
        reference: reference.into(),
        upload_id: "id".into(),
        table: "todos".into(),
        pk: "p1".into(),
        column: "photo".into(),
        bucket: "media".into(),
        owner: "u1".into(),
        sha256: None,
        content_type: None,
        size: None,
        local_path: Some("sandbox/shared".into()),
        direction: "upload".into(),
        state: AttachmentState::Queued,
        in_flight: false,
        fingerprint: None,
        progress: 0,
        attempts: 0,
        permanent: false,
        chunk_offset: 0,
        tus_url: None,
        error: None,
        created_at: now.into(),
        updated_at: now.into(),
        error_code: None,
    };
    store.put_attachment(&entry("u1/p1/a.bin")).expect("put a");
    store.put_attachment(&entry("u1/p1/b.bin")).expect("put b");

    assert_eq!(
        store
            .count_live_attachments_at_local_path("sandbox/shared", None)
            .expect("count"),
        2
    );
    assert_eq!(
        store
            .count_live_attachments_at_local_path("sandbox/shared", Some("u1/p1/a.bin"))
            .expect("count excluding"),
        1
    );

    // An orphaned row is already GC bait: it must never keep the bytes alive.
    store
        .mark_attachment_orphaned("u1/p1/b.bin", now)
        .expect("orphan");
    assert_eq!(
        store
            .count_live_attachments_at_local_path("sandbox/shared", Some("u1/p1/a.bin"))
            .expect("count after orphan"),
        0
    );

    // Neither does an evicted one: its bytes are this device's to delete.
    store.put_attachment(&entry("u1/p1/c.bin")).expect("put c");
    store
        .mark_attachment_evicted("u1/p1/c.bin", now)
        .expect("evict");
    assert_eq!(
        store
            .count_live_attachments_at_local_path("sandbox/shared", Some("u1/p1/a.bin"))
            .expect("count after eviction"),
        0
    );
    assert_eq!(
        store
            .count_live_attachments_at_local_path("sandbox/other", None)
            .expect("count unknown path"),
        0
    );
}

/// A row left in a running state whose claim was already released is invisible
/// to the queue (`list_pending_attachments` selects 'queued'/'failed' only), so
/// recovery must reclaim it on the state too, not on `in_flight` alone.
#[test]
fn attachment_recovery_reclaims_a_released_running_row() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .enqueue_attachment(&AttachmentEntry {
            reference: "u1/p1/stranded.bin".into(),
            upload_id: "stranded".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            sha256: None,
            content_type: None,
            size: None,
            local_path: Some("/tmp/stranded".into()),
            direction: "upload".into(),
            state: AttachmentState::Queued,
            in_flight: false,
            fingerprint: None,
            progress: 0,
            attempts: 0,
            permanent: false,
            chunk_offset: 0,
            tus_url: None,
            error: None,
            created_at: now.into(),
            updated_at: now.into(),
            error_code: None,
        })
        .expect("enqueue");

    store
        .update_attachment_state(
            "u1/p1/stranded.bin",
            AttachmentState::Uploading,
            false,
            None,
            now,
        )
        .expect("strand");
    assert!(
        store
            .list_pending_attachments("upload", 10)
            .expect("pending")
            .is_empty()
    );

    store
        .recover_in_flight_attachments("2020-01-01T00:00:05.000Z")
        .expect("recover");
    let recovered = store
        .get_attachment("u1/p1/stranded.bin")
        .expect("get")
        .expect("present");
    assert_eq!(recovered.state, AttachmentState::Queued);
    assert!(!recovered.in_flight);
    assert_eq!(
        store
            .list_pending_attachments("upload", 10)
            .expect("pending after recovery")
            .len(),
        1
    );
}

/// The corpus pins a `local-row` column map exactly, so the store persists the
/// columns it was handed and nothing else: the pk lives in its own column and the
/// query seam derives `id` from it.
#[test]
fn put_server_row_stores_the_wire_columns_verbatim() {
    let store = LocalStore::open_in_memory().expect("open");
    let mut columns = Map::new();
    columns.insert("title".into(), json!("from server"));
    store
        .put_server_row("todos", "p1", &columns, "1")
        .expect("put");
    let row = store.read("todos", "p1").unwrap().expect("row");
    assert_eq!(row.columns, columns);
}

#[test]
fn overlay_local_insert_stores_the_given_columns_verbatim() {
    let store = LocalStore::open_in_memory().expect("open");
    let mut columns = Map::new();
    columns.insert("title".into(), json!("typed offline"));
    store
        .overlay_local(&OutboxEntry {
            seq: 1,
            mutation_id: "m3".into(),
            table: "todos".into(),
            pk: "p3".into(),
            op: Op::Insert,
            columns: columns.clone(),
            transforms: None,
            precondition: None,
            batch_id: None,
            pre_image: None,
            hlc: None,
            created_at: "2020-01-01T00:00:00.000Z".into(),
        })
        .expect("overlay");
    let row = store.read("todos", "p3").unwrap().expect("row");
    assert_eq!(row.columns, columns);
}

/// Insertion order is deliberately not pk order, so a store that forwarded the
/// select's natural order would fail this.
#[test]
fn read_all_returns_rows_ordered_by_pk() {
    let store = LocalStore::open_in_memory().expect("open");
    for pk in ["p3", "p1", "p2"] {
        let mut columns = Map::new();
        columns.insert("title".into(), json!(pk));
        store
            .put_server_row("todos", pk, &columns, "1")
            .expect("put");
    }
    let pks: Vec<String> = store
        .read_all("todos")
        .expect("read all")
        .into_iter()
        .map(|row| row.pk)
        .collect();
    assert_eq!(pks, vec!["p1", "p2", "p3"]);
}

#[test]
fn an_inserted_row_reads_back_with_exactly_the_columns_it_was_given() {
    let store = LocalStore::open_in_memory().expect("open");
    let mut columns = Map::new();
    columns.insert("done".into(), json!(false));
    columns.insert("owner_id".into(), json!("u1"));
    columns.insert("title".into(), json!("write it down"));
    store
        .apply(
            &LocalMutation {
                table: "todos".into(),
                pk: "p1".into(),
                op: Op::Insert,
                columns: columns.clone(),
                transforms: None,
                precondition: None,
                batch_id: None,
                hlc: None,
                mutation_id: None,
            },
            "m1",
            "2020-01-01T00:00:00.000Z",
            None,
        )
        .expect("apply");
    let row = store.read("todos", "p1").unwrap().expect("row");
    assert_eq!(row.columns, columns);
}

#[test]
fn the_rejection_journal_lists_newest_first_and_hides_dismissed_entries_unless_asked() {
    let store = LocalStore::open_in_memory().expect("open");
    let mut server_row = Map::new();
    server_row.insert("title".into(), json!("server wins"));
    let record = RejectionRecord {
        mutation_id: "m1".into(),
        table: "todos".into(),
        pk: "p1".into(),
        kind: RejectionKind::Rejected,
        reason: "PRECONDITION".into(),
        changed_columns: vec!["title".into(), "done".into()],
        server_row: Some(server_row),
        at: 1_700_000_000_000,
        dismissed: false,
    };
    store.insert_rejection(&record).expect("insert");

    let listed = store.list_rejections(false).expect("list");
    assert_eq!(listed, vec![record.clone()]);

    // Newest first, and a second journal entry does not disturb the first.
    let older = RejectionRecord {
        mutation_id: "m0".into(),
        reason: "RLS_DENIED".into(),
        changed_columns: vec![],
        server_row: None,
        at: 1_600_000_000_000,
        ..record
    };
    store.insert_rejection(&older).expect("insert older");
    let listed = store.list_rejections(false).expect("list2");
    assert_eq!(
        listed
            .iter()
            .map(|r| r.mutation_id.as_str())
            .collect::<Vec<_>>(),
        vec!["m1", "m0"]
    );
    assert_eq!(listed[1], older);

    assert!(store.dismiss_rejection("m1").expect("dismiss"));
    assert!(!store.dismiss_rejection("missing").expect("dismiss missing"));
    let visible = store.list_rejections(false).expect("list3");
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].mutation_id, "m0");
    let all = store.list_rejections(true).expect("list4");
    assert_eq!(all.len(), 2);
    assert!(all.iter().any(|r| r.mutation_id == "m1" && r.dismissed));
}

#[test]
fn the_overwrite_journal_lists_newest_first_and_hides_dismissed_entries_unless_asked() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .record_overwrite(&NewOverwrite {
            table: "todos",
            pk: "p1",
            column: "title",
            loser_value: &json!("mine"),
            winner_mutation_id: "peer-1",
            conflict_mode: "arrival",
            winner_seq: Some("42"),
            at: 1_600_000_000_000,
        })
        .expect("record older");
    store
        .record_overwrite(&NewOverwrite {
            table: "todos",
            pk: "p2",
            column: "done",
            loser_value: &json!(true),
            winner_mutation_id: "peer-2",
            conflict_mode: "hlc",
            winner_seq: None,
            at: 1_700_000_000_000,
        })
        .expect("record newer");

    let listed = store.list_overwrites(false).expect("list");
    assert_eq!(
        listed.iter().map(|o| o.pk.as_str()).collect::<Vec<_>>(),
        vec!["p2", "p1"]
    );
    assert_eq!(listed[1].column, "title");
    assert_eq!(listed[1].loser_value, json!("mine"));
    assert_eq!(listed[1].winner_mutation_id, "peer-1");
    assert_eq!(listed[1].conflict_mode, "arrival");
    assert_eq!(listed[1].winner_seq.as_deref(), Some("42"));
    assert!(!listed[1].dismissed);
    assert_eq!(listed[0].winner_seq, None);

    let newest_id = listed[0].id;
    assert!(store.dismiss_overwrite(newest_id).expect("dismiss"));
    assert!(!store.dismiss_overwrite(-1).expect("dismiss missing"));
    let visible = store.list_overwrites(false).expect("list2");
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].pk, "p1");
    let all = store.list_overwrites(true).expect("list3");
    assert_eq!(all.len(), 2);
    assert!(all.iter().any(|o| o.id == newest_id && o.dismissed));
}

#[test]
fn reset_clears_overwrite_journal_rows() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .record_overwrite(&NewOverwrite {
            table: "todos",
            pk: "p1",
            column: "title",
            loser_value: &json!("mine"),
            winner_mutation_id: "peer-1",
            conflict_mode: "arrival",
            winner_seq: Some("42"),
            at: 1_700_000_000_000,
        })
        .expect("record");
    assert_eq!(store.list_overwrites(true).expect("list").len(), 1);
    store.reset(1, "c2").expect("reset");
    assert!(store.list_overwrites(true).expect("list2").is_empty());
}

#[test]
fn reset_rolls_back_and_leaves_no_open_transaction_when_a_delete_fails() {
    let store = LocalStore::open_in_memory().expect("open");
    let mut columns = Map::new();
    columns.insert("title".into(), json!("keep"));
    store
        .apply(
            &LocalMutation {
                table: "todos".into(),
                pk: "p1".into(),
                op: Op::Insert,
                columns,
                transforms: None,
                precondition: None,
                batch_id: None,
                hlc: None,
                mutation_id: None,
            },
            "m1",
            "2020-01-01T00:00:00.000Z",
            None,
        )
        .expect("apply");
    store
        .insert_rejection(&RejectionRecord {
            mutation_id: "m1".into(),
            table: "todos".into(),
            pk: "p1".into(),
            kind: RejectionKind::Rejected,
            reason: "stale".into(),
            changed_columns: vec!["title".into()],
            server_row: None,
            at: 1_700_000_000_000,
            dismissed: false,
        })
        .expect("insert rejection");
    store.meta_set(CLIENT_ID_KEY, "c1").expect("identity");

    // `_kizunasync_rejections` is wiped after `_kizunasync_rows`, so aborting its delete
    // proves the earlier deletes were undone rather than never attempted.
    store
        .connection()
        .execute_batch(
            "CREATE TRIGGER fail_rejection_delete BEFORE DELETE ON _kizunasync_rejections
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .expect("install trigger");

    let error = store
        .reset(1, "c2")
        .expect_err("the injected fault must surface");
    assert!(matches!(error, StoreError::Sqlite(_)), "{error}");
    assert!(
        store.connection().is_autocommit(),
        "reset left the connection inside a transaction"
    );
    assert!(store.read("todos", "p1").expect("read").is_some());
    assert_eq!(store.list_rejections(true).expect("list").len(), 1);
    assert_eq!(store.meta_get(CLIENT_ID_KEY).expect("identity"), "c1");

    store
        .connection()
        .execute_batch("DROP TRIGGER fail_rejection_delete;")
        .expect("drop trigger");

    store
        .reset(1, "c2")
        .expect("reset after the fault is removed");
    assert!(store.read("todos", "p1").expect("read again").is_none());
    assert!(store.list_rejections(true).expect("list again").is_empty());
    assert_eq!(store.meta_get(CLIENT_ID_KEY).expect("identity"), "c2");
}

#[test]
fn apply_insert_on_an_existing_pk_fails_with_store_error_constraint() {
    let store = LocalStore::open_in_memory().expect("open");
    let mut columns = Map::new();
    columns.insert("title".into(), json!("first"));
    let mutation = LocalMutation {
        table: "todos".into(),
        pk: "p1".into(),
        op: Op::Insert,
        columns,
        transforms: None,
        precondition: None,
        batch_id: None,
        hlc: None,
        mutation_id: None,
    };
    store
        .apply(&mutation, "m1", "2020-01-01T00:00:00.000Z", None)
        .expect("insert");
    let err = store
        .apply(&mutation, "m2", "2020-01-01T00:00:00.000Z", None)
        .expect_err("duplicate insert must fail");
    assert!(matches!(err, StoreError::Constraint(_)), "{err}");
}

/// The schema holds the outbox to one entry per mutation id even for a writer
/// that skips `apply`'s own check.
#[test]
fn the_outbox_refuses_a_second_entry_for_a_mutation_id() {
    let store = LocalStore::open_in_memory().expect("open");
    let insert =
        "INSERT INTO _kizunasync_outbox(mutation_id, table_name, pk, op, columns_json, created_at)
                  VALUES ('m1', 'todos', 'p1', 'insert', '{}', '2020-01-01T00:00:00.000Z')";
    store.connection().execute(insert, []).expect("first entry");

    let err = store
        .connection()
        .execute(insert, [])
        .expect_err("a second entry for m1 must be refused");
    assert!(
        err.to_string().contains("UNIQUE"),
        "{err} is not a uniqueness refusal"
    );
}

// The read path decodes `row_json` through `serde_json`, so a row written
// outside this crate's own encoders (here, a raw SQL insert standing in for
// on-disk corruption) surfaces as `StoreError::Json`.
#[test]
fn read_a_row_with_corrupted_json_fails_with_store_error_json() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .connection()
        .execute(
            "INSERT INTO _kizunasync_rows(table_name, pk, row_json, deleted, updated_seq)
             VALUES ('todos', 'p1', 'not json', 0, '0')",
            [],
        )
        .expect("insert raw row");
    let err = store
        .read("todos", "p1")
        .expect_err("corrupted json must fail");
    assert!(matches!(err, StoreError::Json(_)), "{err}");
}

#[test]
fn a_blocked_insert_trigger_fails_with_store_error_sqlite() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .connection()
        .execute_batch(
            "CREATE TRIGGER block_row_insert BEFORE INSERT ON _kizunasync_rows
             BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        )
        .expect("install trigger");
    let mut columns = Map::new();
    columns.insert("title".into(), json!("first"));
    let err = store
        .apply(
            &LocalMutation {
                table: "todos".into(),
                pk: "p1".into(),
                op: Op::Insert,
                columns,
                transforms: None,
                precondition: None,
                batch_id: None,
                hlc: None,
                mutation_id: None,
            },
            "m1",
            "2020-01-01T00:00:00.000Z",
            None,
        )
        .expect_err("blocked insert must fail");
    assert!(matches!(err, StoreError::Sqlite(_)), "{err}");
}

#[test]
fn vfs_kind_reports_the_backing_store() {
    let memory = LocalStore::open_in_memory().expect("open in memory");
    assert_eq!(memory.kind(), VfsKind::Memory);

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("store.db");
    let file = LocalStore::open_path(&path).expect("open path");
    assert_eq!(file.kind(), VfsKind::File);
}

#[test]
fn every_vfs_kind_reports_its_own_durability_and_stable_name() {
    assert_eq!(VfsKind::Memory.durability(), "none");
    assert_eq!(VfsKind::File.durability(), "full");
    assert_eq!(VfsKind::OpfsSahPool.durability(), "full");
    assert_eq!(VfsKind::RelaxedIdb.durability(), "relaxed");

    assert_eq!(VfsKind::Memory.name(), "memory");
    assert_eq!(VfsKind::File.name(), "file");
    assert_eq!(VfsKind::OpfsSahPool.name(), "opfs-sahpool");
    assert_eq!(VfsKind::RelaxedIdb.name(), "relaxed-idb");
}

/// Every closed vocabulary survives `as_str` → `FromStr`, refuses a value
/// outside the set, and spells each member exactly as the column and the wire
/// do. The literals are written out rather than derived from `as_str` so a
/// rename that silently changes stored text fails here.
#[test]
fn attachment_state_round_trips_every_member_and_rejects_an_unknown_one() {
    let members = [
        (AttachmentState::Queued, "queued"),
        (AttachmentState::Uploading, "uploading"),
        (AttachmentState::Downloading, "downloading"),
        (AttachmentState::Synced, "synced"),
        (AttachmentState::Failed, "failed"),
        (AttachmentState::Orphaned, "orphaned"),
        (AttachmentState::Evicted, "evicted"),
        (AttachmentState::Missing, "missing"),
    ];
    for (state, text) in members {
        assert_eq!(state.as_str(), text);
        assert_eq!(text.parse::<AttachmentState>().expect("round trip"), state);
        assert_eq!(serde_json::to_value(state).expect("encode"), json!(text));
        assert_eq!(
            serde_json::from_value::<AttachmentState>(json!(text)).expect("decode"),
            state
        );
    }

    let rejected = "uploaded".parse::<AttachmentState>().expect_err("unknown");
    assert!(matches!(rejected, StoreError::Constraint(_)));
}

#[test]
fn rejection_kind_round_trips_every_member_and_rejects_an_unknown_one() {
    let members = [
        (RejectionKind::Rejected, "REJECTED"),
        (RejectionKind::Superseded, "SUPERSEDED"),
        (RejectionKind::BatchAborted, "BATCH_ABORTED"),
        (RejectionKind::DeadLetter, "DEAD_LETTER"),
    ];
    for (kind, text) in members {
        assert_eq!(kind.as_str(), text);
        assert_eq!(text.parse::<RejectionKind>().expect("round trip"), kind);
        assert_eq!(serde_json::to_value(kind).expect("encode"), json!(text));
        assert_eq!(
            serde_json::from_value::<RejectionKind>(json!(text)).expect("decode"),
            kind
        );
    }
    assert_eq!(DEAD_LETTER_KIND, RejectionKind::DeadLetter.as_str());

    let rejected = "PRECONDITION"
        .parse::<RejectionKind>()
        .expect_err("unknown");
    assert!(matches!(rejected, StoreError::Constraint(_)));
}

#[test]
fn outbox_op_round_trips_every_member_and_rejects_an_unknown_one() {
    for (op, text) in [
        (Op::Insert, "insert"),
        (Op::Update, "update"),
        (Op::Delete, "delete"),
    ] {
        assert_eq!(op_as_str(op), text);
        assert_eq!(text.parse::<Op>().expect("round trip"), op);
        assert_eq!(serde_json::to_value(op).expect("encode"), json!(text));
    }

    assert!("upsert".parse::<Op>().is_err());
}

/// A patch is the one write path that could still put unpersisted text in the
/// state column, which would make every later read of that row fail.
#[test]
fn an_attachment_patch_refuses_a_state_outside_the_vocabulary() {
    let store = LocalStore::open_in_memory().expect("open");
    let now = "2020-01-01T00:00:00.000Z";
    store
        .put_attachment(&AttachmentEntry {
            reference: "u1/p1/id.bin".into(),
            upload_id: "id".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            sha256: None,
            content_type: None,
            size: None,
            local_path: None,
            direction: "upload".into(),
            state: AttachmentState::Queued,
            in_flight: false,
            fingerprint: None,
            progress: 0,
            attempts: 0,
            permanent: false,
            chunk_offset: 0,
            tus_url: None,
            error: None,
            created_at: now.into(),
            updated_at: now.into(),
            error_code: None,
        })
        .expect("put");

    let mut patch = kizunasync_protocol::ColumnValues::new();
    patch.insert("state".into(), json!("uploaded"));
    let refused = store
        .update_attachment("u1/p1/id.bin", &patch, now)
        .expect_err("unknown state");
    assert!(matches!(refused, StoreError::Constraint(_)));

    let unchanged = store
        .get_attachment("u1/p1/id.bin")
        .expect("read")
        .expect("row");
    assert_eq!(unchanged.state, AttachmentState::Queued);
}

/// The attachment queries fence on the state column in SQL text, which no type
/// checks, so every literal they name has to be a member of the enum the same
/// column is read back as.
#[test]
fn every_quoted_literal_in_the_attachment_sql_is_an_attachment_state() {
    const SOURCE: &str = include_str!("store/attachments.rs");
    // The queries the scan has to cover, so a fence that stops being read as a
    // quoted literal cannot pass by going unseen.
    const FENCED_QUERIES: usize = 9;

    // A bare word between two apostrophes on ONE line is a SQL literal; a pair
    // that spans lines or holds a space is prose (`the row's state`), and the
    // enum's own renames guarantee a real member is always a bare word.
    let is_sql_literal = |text: &str| {
        !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    };

    let mut fences = 0usize;
    for line in SOURCE.lines() {
        let mut rest = line;
        while let Some(open) = rest.find('\'') {
            let after = &rest[open + 1..];
            let Some(close) = after.find('\'') else { break };
            let literal = &after[..close];
            rest = &after[close + 1..];
            if !is_sql_literal(literal) {
                continue;
            }
            assert!(
                literal.parse::<AttachmentState>().is_ok(),
                "SQL literal {literal:?} in store/attachments.rs is not an AttachmentState member"
            );
            fences += 1;
        }
    }

    assert!(
        fences >= FENCED_QUERIES,
        "expected at least {FENCED_QUERIES} state literals in the attachment SQL, found {fences}"
    );
}
