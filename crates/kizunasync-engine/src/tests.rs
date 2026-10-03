use super::*;
use crate::engine::RECENT_EVENT_CAPACITY;
use crate::time::format_rfc3339_millis;
use crate::{ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, SyncMode};
use kizunasync_protocol::{Op, PullResponse, PushResponse, Verdict};
use kizunasync_query::{Filter, QueryPlan, QueryResult};
use kizunasync_store::{
    AttachmentEntry, AttachmentState, LocalMutation, LocalStore, RejectionKind,
};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::sync::Arc;

/// N-API owns an engine on a dedicated thread, so the handle has to be `Send`.
/// It is not `Sync`: the store's `SQLite` connection keeps its statement cache in
/// a `RefCell`, which is why the `UniFFI` client guards its engine with an inner
/// mutex rather than sharing it.
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn the_engine_moves_between_threads_on_a_threaded_host() {
    const fn assert_send<T: Send>() {}
    assert_send::<SyncEngine>();
}

fn test_config() -> EngineConfig {
    let mut tables = BTreeMap::new();
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("u1"));
    tables.insert(
        "todos".into(),
        TableConfig {
            bucket_column: "owner_id".into(),
            bucket_params: params,
            bucket_owner: false,
            attachments: BTreeMap::new(),
            soft_delete_column: None,
            sync_mode: SyncMode::ReadWrite,
            conflict_mode: ConflictMode::Arrival,
            key: vec!["id".into()],
        },
    );
    EngineConfig {
        tables,
        schema_version: 1,
        default_limit: None,
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
        client_id: "c1".into(),
    }
}

#[tokio::test]
async fn an_applied_insert_drains_on_push_and_stays_queryable() {
    let store = LocalStore::open_in_memory().unwrap();
    let remote = Arc::new(ScriptedRemote::new());
    let n = std::sync::atomic::AtomicU32::new(0);
    let deps = EngineDeps {
        now: Box::new(|| "2020-01-01T00:00:00.000Z".into()),
        uuid: Box::new(move || {
            let v = n.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            format!("00000000-0000-4000-8000-{v:012}")
        }),
        ..Default::default()
    };
    let engine = SyncEngine::new(store, test_config(), remote.clone(), deps);

    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    columns.insert("done".into(), json!(false));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m1".into()),
        })
        .unwrap();
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
    engine.push_once().await.unwrap();
    assert_eq!(engine.get_outbox_depth().unwrap(), 0);

    let plan = QueryPlan {
        filters: vec![Filter::Eq {
            column: "title".into(),
            value: json!("hi"),
        }],
        ..Default::default()
    };
    match engine.query("todos", &plan).unwrap() {
        QueryResult::Many(rows) => assert_eq!(rows.len(), 1),
        _ => panic!("many"),
    }

    assert_eq!(
        engine.recent_event_names(),
        vec!["LOCAL_CHANGED", "QUEUE_DEPTH", "LOCAL_CHANGED"]
    );
}

/// The store persists only the columns a write carried, and the query layer still
/// addresses the row by `id`: the seam derives it from the pk.
#[tokio::test]
async fn a_query_exposes_id_although_the_stored_row_does_not_carry_it() {
    let store = LocalStore::open_in_memory().unwrap();
    let remote = Arc::new(ScriptedRemote::new());
    let engine = SyncEngine::new(store, test_config(), remote, EngineDeps::default());

    let mut columns = Map::new();
    columns.insert("done".into(), json!(false));
    columns.insert("owner_id".into(), json!("u1"));
    columns.insert("title".into(), json!("write it down"));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Insert,
            columns: columns.clone(),
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m1".into()),
        })
        .unwrap();

    let stored = engine.read_row("todos", "p1").unwrap().expect("row");
    assert_eq!(stored.columns, columns);

    let plan = QueryPlan {
        filters: vec![Filter::Eq {
            column: "id".into(),
            value: json!("p1"),
        }],
        ..Default::default()
    };
    match engine.query("todos", &plan).unwrap() {
        QueryResult::Many(rows) => {
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].get("id"), Some(&json!("p1")));
        }
        _ => panic!("many"),
    }
}

/// A divergent `columns.id` is refused and nothing is stored; an `id` equal to
/// the pk, or absent, is accepted and reads back with `id` equal to the pk
/// through both `read_all_rows` and `query`.
#[tokio::test]
async fn insert_refuses_a_divergent_id_and_accepts_one_equal_to_the_pk() {
    let store = LocalStore::open_in_memory().unwrap();
    let remote = Arc::new(ScriptedRemote::new());
    let engine = SyncEngine::new(store, test_config(), remote, EngineDeps::default());

    let mut divergent = Map::new();
    divergent.insert("id".into(), json!("not-the-pk"));
    divergent.insert("owner_id".into(), json!("u1"));
    divergent.insert("title".into(), json!("write it down"));
    let error = engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Insert,
            columns: divergent,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m1".into()),
        })
        .expect_err("divergent id");
    assert_eq!(error.code(), error_catalog::LOCAL_CONSTRAINT);
    assert_eq!(
        engine.read_all_rows("todos").unwrap(),
        Vec::<serde_json::Map<String, serde_json::Value>>::new()
    );

    let mut equal_id = Map::new();
    equal_id.insert("id".into(), json!("p2"));
    equal_id.insert("owner_id".into(), json!("u1"));
    equal_id.insert("title".into(), json!("write it down"));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p2".into(),
            op: Op::Insert,
            columns: equal_id,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m2".into()),
        })
        .unwrap();

    let mut absent_id = Map::new();
    absent_id.insert("owner_id".into(), json!("u1"));
    absent_id.insert("title".into(), json!("no id column"));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p3".into(),
            op: Op::Insert,
            columns: absent_id,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m3".into()),
        })
        .unwrap();

    let rows = engine.read_all_rows("todos").unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|row| row.get("id") == Some(&json!("p2"))));
    assert!(rows.iter().any(|row| row.get("id") == Some(&json!("p3"))));

    for pk in ["p2", "p3"] {
        let plan = QueryPlan {
            filters: vec![Filter::Eq {
                column: "id".into(),
                value: json!(pk),
            }],
            ..Default::default()
        };
        match engine.query("todos", &plan).unwrap() {
            QueryResult::Many(found) => {
                assert_eq!(found.len(), 1);
                assert_eq!(found[0].get("id"), Some(&json!(pk)));
            }
            _ => panic!("many"),
        }
    }
}

#[tokio::test]
async fn sync_drains_an_outbox_larger_than_one_push_slice() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote);
    for i in 0..501 {
        insert_todo(&engine, &format!("m{i}"), &format!("p{i}"));
    }

    assert_eq!(engine.get_outbox_depth().unwrap(), 501);
    engine.sync().await.unwrap();

    assert_eq!(engine.get_outbox_depth().unwrap(), 0);
}

/// The scripted remote answers an applied delete without a row, as the
/// server does, so the delete stays deleted once its verdict lands.
#[tokio::test]
async fn a_delete_the_scripted_remote_applies_leaves_no_row() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    insert_todo(&engine, "m1", "p1");
    engine.sync().await.unwrap();

    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Delete,
            columns: Map::new(),
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m2".into()),
        })
        .unwrap();
    engine.sync().await.unwrap();

    assert!(engine.read_row("todos", "p1").unwrap().is_none());
    let pushed = remote.last_push.lock().unwrap().clone().unwrap();
    assert_eq!(pushed.batch.mutations[0].op, Op::Delete);
}

/// The one id [`pinned_engine`]'s injected source answers, so a test that
/// asserts on a minted identifier names the value instead of repeating it.
const PINNED_UUID: &str = "00000000-0000-4000-8000-000000000001";

fn pinned_engine(remote: Arc<ScriptedRemote>) -> SyncEngine {
    let store = LocalStore::open_in_memory().unwrap();
    let deps = EngineDeps {
        now: Box::new(|| "2020-01-01T00:00:00.000Z".into()),
        now_millis: Box::new(|| 1_577_836_800_000),
        uuid: Box::new(|| PINNED_UUID.into()),
    };
    SyncEngine::new(store, test_config(), remote, deps)
}

fn insert_todo(engine: &SyncEngine, mutation_id: &str, pk: &str) {
    insert_todo_in_batch(engine, mutation_id, pk, None);
}

fn insert_todo_in_batch(engine: &SyncEngine, mutation_id: &str, pk: &str, batch_id: Option<&str>) {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: pk.into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: batch_id.map(str::to_string),
            hlc: None,
            mutation_id: Some(mutation_id.into()),
        })
        .unwrap();
}

#[tokio::test]
async fn push_reset_required_emits_and_holds_outbox() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    insert_todo(&engine, "m1", "p1");
    remote.enqueue_push(PushResponse {
        verdicts: None,
        signal: Some(kizunasync_protocol::Signal {
            signal_type: "RESET_REQUIRED".into(),
        }),
        batch: None,
    });
    engine.push_once().await.unwrap();

    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
    assert!(
        engine
            .recent_event_names()
            .contains(&"RESET_REQUIRED".to_string())
    );
}

#[tokio::test]
async fn pull_checkpoint_expired_emits() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    remote.enqueue_pull(PullResponse {
        cursor: "0".into(),
        has_more: false,
        rows: vec![],
        tombstones: vec![],
        signal: Some(kizunasync_protocol::Signal {
            signal_type: "CHECKPOINT_EXPIRED".into(),
        }),
        conflicts: None,
    });
    engine.pull_once().await.unwrap();

    assert_eq!(engine.recent_event_names(), vec!["CHECKPOINT_EXPIRED"]);
}

fn server_row(pk: &str, seq: &str) -> kizunasync_protocol::RowChange {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    kizunasync_protocol::RowChange {
        table: "todos".into(),
        pk: pk.into(),
        seq: seq.into(),
        columns,
        deleted: false,
    }
}

/// Corrupt staging is NOT the same as absent staging: parsing it away would
/// drop page 1 and commit a cursor covering rows the mirror never got.
#[tokio::test]
async fn a_corrupt_staged_page_fails_loud_and_holds_the_cursor() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    remote.enqueue_pull(PullResponse {
        cursor: "1".into(),
        has_more: true,
        rows: vec![server_row("p1", "1")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    engine.pull_once().await.unwrap();
    assert_eq!(engine.get_checkpoint().unwrap(), "0");
    assert_eq!(engine.page_cursor().unwrap().as_deref(), Some("1"));

    engine.store.insert_pull_page("{not json").unwrap();
    remote.enqueue_pull(PullResponse {
        cursor: "2".into(),
        has_more: false,
        rows: vec![server_row("p2", "2")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    let error = engine.pull_once().await.expect_err("corruption must raise");
    assert!(matches!(error, EngineError::Json(_)), "{error}");

    // Nothing moved: the cursor still predates page 1, and every staged page
    // is left exactly as found for an operator to inspect, including the
    // legitimate page this failed call still staged before its commit read
    // the corrupt row.
    assert_eq!(engine.get_checkpoint().unwrap(), "0");
    let pages = engine.store.list_pull_pages().unwrap();
    assert_eq!(pages.len(), 3);
    assert_eq!(pages[1], "{not json");
    assert_eq!(
        engine.read_all_rows("todos").unwrap(),
        Vec::<serde_json::Map<String, serde_json::Value>>::new()
    );
}

/// The same read serves the first page, whose page set is empty: no row has
/// been staged yet.
#[tokio::test]
async fn absent_staged_pages_are_an_empty_page_set() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    remote.enqueue_pull(PullResponse {
        cursor: "1".into(),
        has_more: false,
        rows: vec![server_row("p1", "1")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    engine.pull_once().await.unwrap();
    assert_eq!(engine.get_checkpoint().unwrap(), "1");
    assert_eq!(engine.read_all_rows("todos").unwrap().len(), 1);
}

/// Continuation pages may carry tombstones as well as rows (the paging
/// protocol rule in `paging-design.md`). Staging many pages and committing
/// them in order must land the same rows and tombstones a single page
/// carrying the same content would.
#[tokio::test]
async fn many_staged_pages_commit_the_same_state_a_single_page_would() {
    let multi_remote = Arc::new(ScriptedRemote::new());
    let multi = pinned_engine(multi_remote.clone());
    multi_remote.enqueue_pull(PullResponse {
        cursor: "1".into(),
        has_more: true,
        rows: vec![server_row("p1", "1")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    multi_remote.enqueue_pull(PullResponse {
        cursor: "4".into(),
        has_more: true,
        rows: vec![server_row("p2", "3")],
        tombstones: vec![kizunasync_protocol::Tombstone {
            table: "todos".into(),
            pk: "p3".into(),
            seq: "4".into(),
        }],
        signal: None,
        conflicts: None,
    });
    multi_remote.enqueue_pull(PullResponse {
        cursor: "5".into(),
        has_more: false,
        rows: vec![server_row("p4", "5")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    for _ in 0..3 {
        multi.pull_once().await.unwrap();
    }

    let single_remote = Arc::new(ScriptedRemote::new());
    let single = pinned_engine(single_remote.clone());
    single_remote.enqueue_pull(PullResponse {
        cursor: "5".into(),
        has_more: false,
        rows: vec![
            server_row("p1", "1"),
            server_row("p2", "3"),
            server_row("p4", "5"),
        ],
        tombstones: vec![kizunasync_protocol::Tombstone {
            table: "todos".into(),
            pk: "p3".into(),
            seq: "4".into(),
        }],
        signal: None,
        conflicts: None,
    });
    single.pull_once().await.unwrap();

    assert_eq!(
        multi.get_checkpoint().unwrap(),
        single.get_checkpoint().unwrap()
    );
    let mut multi_rows = multi.read_all_rows("todos").unwrap();
    let mut single_rows = single.read_all_rows("todos").unwrap();
    multi_rows.sort_by_key(|row| {
        row.get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    });
    single_rows.sort_by_key(|row| {
        row.get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    });
    assert_eq!(multi_rows, single_rows);
    assert_eq!(multi_rows.len(), 3);
    assert!(multi.has_tombstone("todos", "p3").unwrap());
    assert!(single.has_tombstone("todos", "p3").unwrap());
    assert!(multi.page_cursor().unwrap().is_none());
    assert_eq!(multi.store.list_pull_pages().unwrap(), Vec::<String>::new());
}

/// A reset mid-pagination must not leave orphaned staged pages behind: staging
/// is a blind insert (no read of prior pages), so a later sequence's commit
/// would read and apply an un-wiped leftover page as if it belonged to the new
/// sequence.
#[tokio::test]
async fn reset_mid_pagination_drops_staged_pages_and_the_next_sequence_commits_alone() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    remote.enqueue_pull(PullResponse {
        cursor: "1".into(),
        has_more: true,
        rows: vec![server_row("stale1", "1")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    remote.enqueue_pull(PullResponse {
        cursor: "2".into(),
        has_more: true,
        rows: vec![server_row("stale2", "2")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    engine.pull_once().await.unwrap();
    engine.pull_once().await.unwrap();
    assert_eq!(engine.store.list_pull_pages().unwrap().len(), 2);

    engine.reset().await.unwrap();
    assert_eq!(
        engine.store.list_pull_pages().unwrap(),
        Vec::<String>::new()
    );

    remote.enqueue_pull(PullResponse {
        cursor: "10".into(),
        has_more: false,
        rows: vec![server_row("fresh1", "10")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    engine.pull_once().await.unwrap();

    assert_eq!(engine.get_checkpoint().unwrap(), "10");
    let rows = engine.read_all_rows("todos").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get("id"), Some(&json!("fresh1")));
    assert_eq!(
        engine.store.list_pull_pages().unwrap(),
        Vec::<String>::new()
    );
}

/// A failed pull mid-pagination must drop the keyset so the retry uses the
/// durable checkpoint, not the mid-flight cursor (fencing/001, D-visibility-horizon).
#[tokio::test]
async fn transport_error_abandons_pagination_and_retries_from_checkpoint() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    remote.enqueue_pull(PullResponse {
        cursor: "6".into(),
        has_more: true,
        rows: vec![server_row("p1", "5")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    engine.pull_once().await.unwrap();
    assert_eq!(engine.get_checkpoint().unwrap(), "0");
    assert_eq!(engine.page_cursor().unwrap().as_deref(), Some("6"));

    remote.fail_next_pull("injected transport");
    let error = engine
        .pull_once()
        .await
        .expect_err("transport fault must raise");
    assert!(matches!(
        error,
        EngineError::Remote {
            retryable: true,
            ..
        }
    ));
    assert_eq!(engine.get_checkpoint().unwrap(), "0");
    assert_eq!(engine.page_cursor().unwrap(), None);
    assert_eq!(
        engine.store.list_pull_pages().unwrap(),
        Vec::<String>::new()
    );

    remote.enqueue_pull(PullResponse {
        cursor: "4".into(),
        has_more: false,
        rows: vec![server_row("p1", "4")],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    engine.pull_once().await.unwrap();
    let last = remote.last_pull.lock().unwrap();
    assert_eq!(last.as_ref().map(|r| r.cursor.as_str()), Some("0"));
    assert_eq!(engine.get_checkpoint().unwrap(), "4");
}

fn attachment_engine(remote: Arc<ScriptedRemote>) -> SyncEngine {
    let store = LocalStore::open_in_memory().unwrap();
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("u1"));
    let mut attachments = BTreeMap::new();
    attachments.insert(
        "image_path".into(),
        AttachmentSpec {
            storage_bucket: "todos".into(),
            owner_column: "owner_id".into(),
        },
    );
    let mut tables = BTreeMap::new();
    tables.insert(
        "todos".into(),
        TableConfig {
            bucket_column: "owner_id".into(),
            bucket_params: params,
            bucket_owner: false,
            attachments,
            soft_delete_column: None,
            sync_mode: SyncMode::ReadWrite,
            conflict_mode: ConflictMode::Arrival,
            key: vec!["id".into()],
        },
    );
    let deps = EngineDeps {
        now: Box::new(|| "2020-01-01T00:00:00.000Z".into()),
        now_millis: Box::new(|| 1_577_836_800_000),
        uuid: Box::new(|| "00000000-0000-4000-8000-000000000001".into()),
    };
    SyncEngine::new(
        store,
        EngineConfig {
            tables,
            schema_version: 1,
            default_limit: None,
            attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
            client_id: "c1".into(),
        },
        remote,
        deps,
    )
}

#[tokio::test]
async fn pulled_row_reregisters_an_orphaned_attachment_ref() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = attachment_engine(remote.clone());
    engine
        .store
        .enqueue_attachment(&AttachmentEntry {
            reference: "u1/p1/refA.bin".into(),
            upload_id: "u".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "image_path".into(),
            bucket: "todos".into(),
            owner: "u1".into(),
            sha256: None,
            content_type: None,
            size: None,
            local_path: Some("attachments/refA".into()),
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
            created_at: "t0".into(),
            updated_at: "t0".into(),
            error_code: None,
        })
        .unwrap();
    engine
        .store
        .mark_attachment_orphaned("u1/p1/refA.bin", "t1")
        .unwrap();
    assert_eq!(
        engine
            .store
            .get_attachment("u1/p1/refA.bin")
            .unwrap()
            .unwrap()
            .state,
        AttachmentState::Orphaned
    );

    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    columns.insert("image_path".into(), json!("u1/p1/refA.bin"));
    remote.enqueue_pull(PullResponse {
        cursor: "2".into(),
        has_more: false,
        rows: vec![kizunasync_protocol::RowChange {
            table: "todos".into(),
            pk: "p1".into(),
            seq: "2".into(),
            columns,
            deleted: false,
        }],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    engine.pull_once().await.unwrap();
    let entry = engine
        .store
        .get_attachment("u1/p1/refA.bin")
        .unwrap()
        .unwrap();
    assert_eq!(entry.state, AttachmentState::Queued);
    assert!(!entry.in_flight);
}

#[tokio::test]
async fn aborted_batch_emits_and_reverts() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    // A batch abort only ever answers an atomic:true push, so the queued write
    // must carry a batch_id: otherwise the reply is malformed by contract.
    insert_todo_in_batch(&engine, "m1", "p1", Some("B"));
    remote.enqueue_push(PushResponse {
        verdicts: None,
        signal: None,
        batch: Some(kizunasync_protocol::BatchOutcome {
            outcome: "aborted".into(),
            offender_mutation_id: Some("m1".into()),
            reason: Some("CONSTRAINT".into()),
            server_row: None,
        }),
    });
    engine.push_once().await.unwrap();

    assert_eq!(engine.get_outbox_depth().unwrap(), 0);
    assert_eq!(
        engine.read_all_rows("todos").unwrap(),
        Vec::<serde_json::Map<String, serde_json::Value>>::new()
    );
    assert!(
        engine
            .recent_event_names()
            .contains(&"BATCH_ABORTED".to_string())
    );
}

#[tokio::test]
async fn rejected_verdict_is_journalled() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    insert_todo(&engine, "m1", "p1");
    remote.enqueue_push(PushResponse {
        verdicts: Some(vec![Verdict {
            mutation_id: "m1".into(),
            verdict: "rejected".into(),
            reason: Some("RLS_DENIED".into()),
            server_row: None,
        }]),
        signal: None,
        batch: None,
    });
    engine.push_once().await.unwrap();

    let journal = engine.list_rejections(false).unwrap();
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].mutation_id, "m1");
    assert_eq!(journal[0].kind, RejectionKind::Rejected);
    assert_eq!(journal[0].reason, "RLS_DENIED");
    assert_eq!(journal[0].at, 1_577_836_800_000);
    assert!(journal[0].changed_columns.contains(&"title".to_string()));
    assert!(
        engine
            .recent_event_names()
            .contains(&"MUTATION_REJECTED".to_string())
    );
}

#[tokio::test]
async fn column_denied_verdict_reverts_to_server_row_and_is_journalled() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    insert_todo(&engine, "m1", "p1");

    let mut server_row = Map::new();
    server_row.insert("title".into(), json!("server title"));
    server_row.insert("owner_id".into(), json!("u1"));

    remote.enqueue_push(PushResponse {
        verdicts: Some(vec![Verdict {
            mutation_id: "m1".into(),
            verdict: "rejected".into(),
            reason: Some("COLUMN_DENIED".into()),
            server_row: Some(server_row.clone()),
        }]),
        signal: None,
        batch: None,
    });
    engine.push_once().await.unwrap();

    let rows = engine.read_all_rows("todos").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get("id"), Some(&json!("p1")));
    for (column, value) in &server_row {
        assert_eq!(rows[0].get(column), Some(value));
    }

    let journal = engine.list_rejections(false).unwrap();
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].mutation_id, "m1");
    assert_eq!(journal[0].kind, RejectionKind::Rejected);
    assert_eq!(journal[0].reason, "COLUMN_DENIED");
    assert!(
        engine
            .recent_event_names()
            .contains(&"MUTATION_REJECTED".to_string())
    );
}

#[test]
fn ring_buffer_keeps_only_the_last_events() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote);
    for _ in 0..(RECENT_EVENT_CAPACITY + 10) {
        engine.emit(&EngineEvent::LocalChanged);
    }
    engine.emit(&EngineEvent::ResetRequired { reason: None });
    let names = engine.recent_event_names();
    assert_eq!(names.len(), RECENT_EVENT_CAPACITY);
    assert_eq!(names.last().map(String::as_str), Some("RESET_REQUIRED"));
}

#[test]
fn a_millisecond_epoch_formats_as_rfc3339_across_leap_and_year_end_dates() {
    assert_eq!(format_rfc3339_millis(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(
        format_rfc3339_millis(1_700_000_000_000),
        "2023-11-14T22:13:20.000Z"
    );
    // Leap day and end-of-year boundaries.
    assert_eq!(
        format_rfc3339_millis(1_582_934_400_123),
        "2020-02-29T00:00:00.123Z"
    );
    assert_eq!(
        format_rfc3339_millis(1_735_689_599_999),
        "2024-12-31T23:59:59.999Z"
    );
}

fn likes_of(engine: &SyncEngine) -> serde_json::Value {
    engine
        .read_all_rows("todos")
        .unwrap()
        .into_iter()
        .next()
        .and_then(|row| row.get("likes").cloned())
        .expect("likes")
}

fn increment_likes(engine: &SyncEngine, mutation_id: &str, pk: &str) {
    let mut transforms = Map::new();
    transforms.insert("likes".into(), json!({ "op": "increment", "by": 1 }));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: pk.into(),
            op: Op::Update,
            columns: Map::new(),
            transforms: Some(transforms),
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some(mutation_id.into()),
        })
        .unwrap();
}

/// D-outbox-rebase overlay must not re-apply a pending increment onto a row the page did
/// not replace: `apply()` already wrote it locally.
#[tokio::test]
async fn a_pull_that_misses_a_pk_does_not_reapply_pending_increments() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    columns.insert("likes".into(), json!(0));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m-insert".into()),
        })
        .unwrap();
    engine.push_once().await.unwrap();
    increment_likes(&engine, "m-inc", "p1");
    assert_eq!(likes_of(&engine), json!(1));

    remote.enqueue_pull(PullResponse {
        cursor: "9".into(),
        has_more: false,
        rows: vec![],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    engine.pull_once().await.unwrap();
    assert_eq!(likes_of(&engine), json!(1));
}

/// A pulled server row is a new base: the pending increment applies once onto it.
#[tokio::test]
async fn a_pulled_row_replays_pending_increments_onto_the_server_base() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(remote.clone());
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    columns.insert("likes".into(), json!(0));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m-insert".into()),
        })
        .unwrap();
    engine.push_once().await.unwrap();
    increment_likes(&engine, "m-inc", "p1");
    assert_eq!(likes_of(&engine), json!(1));

    let mut server = Map::new();
    server.insert("title".into(), json!("hi"));
    server.insert("owner_id".into(), json!("u1"));
    server.insert("likes".into(), json!(10));
    remote.enqueue_pull(PullResponse {
        cursor: "11".into(),
        has_more: false,
        rows: vec![kizunasync_protocol::RowChange {
            table: "todos".into(),
            pk: "p1".into(),
            seq: "11".into(),
            columns: server,
            deleted: false,
        }],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    engine.pull_once().await.unwrap();
    assert_eq!(likes_of(&engine), json!(11));
}

/// A reset is the point where a device starts over, so it starts over as a new
/// registered client too: the minted identity is what the next pull and push
/// carry, which is what lets an account switch register under the new user
/// instead of colliding with the previous user's registration. The identity
/// comes from the injected id source, so a pinned source pins it.
#[tokio::test]
async fn reset_mints_the_injected_client_identity_the_next_pull_and_push_carry() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = pinned_engine(Arc::clone(&remote));

    assert_eq!(inspected_client_id(&engine).await, "c1");
    engine.pull_once().await.unwrap();
    assert_eq!(pulled_client_id(&remote), Some("c1".to_string()));

    engine.reset().await.unwrap();

    assert_eq!(inspected_client_id(&engine).await, PINNED_UUID);
    engine.pull_once().await.unwrap();
    assert_eq!(pulled_client_id(&remote), Some(PINNED_UUID.to_string()));

    insert_todo(&engine, "m1", "p1");
    engine.push_once().await.unwrap();
    assert_eq!(pushed_client_id(&remote), Some(PINNED_UUID.to_string()));
}

/// The host's own id source is what a real client carries, and it answers a
/// uuid no test pinned: the identity after a reset is a fresh one rather than
/// the configured id.
#[tokio::test]
async fn reset_mints_a_fresh_uuid_on_the_default_id_source() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = SyncEngine::new(
        LocalStore::open_in_memory().unwrap(),
        test_config(),
        remote.clone(),
        EngineDeps::default(),
    );

    engine.reset().await.unwrap();

    let minted = inspected_client_id(&engine).await;
    assert_ne!(minted, "c1");
    uuid::Uuid::parse_str(&minted).expect("reset mints a uuid");

    engine.pull_once().await.unwrap();
    assert_eq!(pulled_client_id(&remote), Some(minted));
}

/// The live identity is read the way a host reads it, through the dispatch
/// table, rather than off the engine's own field.
async fn inspected_client_id(engine: &SyncEngine) -> String {
    let response = crate::rpc::dispatch(engine, "inspect", "{}").await;
    let envelope: serde_json::Value = serde_json::from_str(&response).unwrap();
    assert_eq!(envelope["ok"], json!(true));
    envelope["value"]["client_id"]
        .as_str()
        .expect("inspect answers a client_id")
        .to_string()
}

fn pulled_client_id(remote: &ScriptedRemote) -> Option<String> {
    remote
        .last_pull
        .lock()
        .unwrap()
        .as_ref()
        .expect("a pull request was recorded")
        .client_id
        .clone()
}

fn pushed_client_id(remote: &ScriptedRemote) -> Option<String> {
    remote
        .last_push
        .lock()
        .unwrap()
        .as_ref()
        .expect("a push request was recorded")
        .client_id
        .clone()
}
