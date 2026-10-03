//! An atomic batch is never split by the push scan bound.
//!
//! The outbox read that feeds one push is capped, but the cap must not fall
//! INSIDE an all-or-nothing group: a batch sent as two `atomic:true` requests
//! can half-apply (P:verdict-completeness-transforms-and-conflict-rejection / D-atomic-batch-abort), and a batch dead-lettered in half leaves its
//! tail to apply on the next push, so the read that feeds one push reads a
//! batched head whole.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use async_trait::async_trait;
use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ProtocolRemote, ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::{Op, PullRequest, PullResponse, PushRequest, PushResponse};
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::sync::Arc;

/// One over the 500-entry scan bound: a batch this size would split into a
/// 500-member request plus a 1-member one if the scan did not read a batched
/// head whole.
const OVERSIZED_BATCH: usize = 501;

/// The dead-letter budget: 5 consecutive permanent failures against the same head.
const BUDGET: usize = 5;

/// A remote whose push always fails permanently: the only classification the
/// dead-letter budget is allowed to drop.
struct PermanentlyFailingRemote;

#[async_trait]
impl ProtocolRemote for PermanentlyFailingRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        Ok(PullResponse {
            cursor: "0".into(),
            has_more: false,
            rows: vec![],
            tombstones: vec![],
            signal: None,
            conflicts: None,
        })
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        Err(EngineError::permanent_remote("bad request"))
    }
}

fn config() -> EngineConfig {
    let mut tables = BTreeMap::new();
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("user-a"));
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

fn engine_with(remote: Arc<dyn ProtocolRemote>) -> SyncEngine {
    let store = LocalStore::open_in_memory().expect("store");
    let deps = EngineDeps {
        now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
        now_millis: Box::new(|| 1_704_067_200_000),
        ..EngineDeps::default()
    };
    SyncEngine::new(store, config(), remote, deps)
}

fn insert_todo(engine: &SyncEngine, mutation_id: &str, pk: &str, batch_id: Option<&str>) {
    let mut columns = Map::new();
    columns.insert("owner_id".into(), json!("user-a"));
    columns.insert("title".into(), json!("hi"));
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
        .expect("apply");
}

fn fill_batch(engine: &SyncEngine, size: usize, batch_id: Option<&str>) {
    for n in 0..size {
        insert_todo(engine, &format!("m{n}"), &format!("p{n}"), batch_id);
    }
}

#[tokio::test]
async fn an_oversized_atomic_batch_goes_out_as_one_request() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine_with(remote.clone());
    fill_batch(&engine, OVERSIZED_BATCH, Some("B"));

    engine.push_once().await.expect("push");

    let sent = remote
        .last_push
        .lock()
        .expect("lock")
        .clone()
        .expect("sent");
    assert!(sent.batch.atomic, "a batched head pushes atomic:true");
    assert_eq!(sent.batch.mutations.len(), OVERSIZED_BATCH);
    // Every member left the queue on that one request: nothing trailed behind
    // for a second, separately-atomic push.
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
}

/// An un-batched backlog stays bounded: only a batch may exceed the scan bound.
#[tokio::test]
async fn an_unbatched_backlog_stays_capped() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine_with(remote.clone());
    fill_batch(&engine, OVERSIZED_BATCH, None);

    engine.push_once().await.expect("push");

    let sent = remote
        .last_push
        .lock()
        .expect("lock")
        .clone()
        .expect("sent");
    assert!(!sent.batch.atomic);
    assert_eq!(sent.batch.mutations.len(), 500);
    assert_eq!(engine.get_outbox_depth().expect("depth"), 1);
}

#[tokio::test]
async fn an_oversized_atomic_batch_dead_letters_whole() {
    let engine = engine_with(Arc::new(PermanentlyFailingRemote));
    fill_batch(&engine, OVERSIZED_BATCH, Some("B"));

    for _ in 0..BUDGET {
        let _ = engine.sync().await;
    }

    // The whole group died together: no member survives to apply later.
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    assert_eq!(
        engine.list_dead_letters().expect("dead letters").len(),
        OVERSIZED_BATCH
    );
    assert!(engine.read_all_rows("todos").expect("rows").is_empty());
}
