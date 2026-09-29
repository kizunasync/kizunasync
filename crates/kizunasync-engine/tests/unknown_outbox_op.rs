//! A queued write whose stored `op` is outside the closed insert/update/delete
//! union is local corruption, and shipping it as an insert would send a DIFFERENT
//! write than the app made. Reading the row fails loud with `UNKNOWN_OP`, so
//! `push_once` and the pull-side overlay both refuse it and the write stays
//! queued.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, ScriptedRemote,
    SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_store::{LocalMutation, LocalStore};
use rusqlite::Connection;
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

fn config() -> EngineConfig {
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("user-a"));
    let mut tables = BTreeMap::new();
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

/// A file-backed engine: the corruption is written from a second connection to
/// the same database.
fn engine_at(path: &Path) -> SyncEngine {
    let store = LocalStore::open_path(path).expect("store");
    let deps = EngineDeps {
        now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
        now_millis: Box::new(|| 1_704_067_200_000),
        ..EngineDeps::default()
    };
    SyncEngine::new(store, config(), Arc::new(ScriptedRemote::new()), deps)
}

#[tokio::test]
async fn a_corrupted_outbox_op_fails_the_push_loud() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let engine = engine_at(&path);

    let mut columns = Map::new();
    columns.insert("owner_id".into(), json!("user-a"));
    columns.insert("title".into(), json!("local"));
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
        .expect("apply");

    let conn = Connection::open(&path).expect("open raw");
    let corrupted = conn
        .execute("UPDATE _kizunasync_outbox SET op = 'bogus'", [])
        .expect("corrupt op");
    assert_eq!(corrupted, 1);

    let err = engine.push_once().await.expect_err("push must fail loud");
    assert_eq!(err.code(), error_catalog::UNKNOWN_OP);
    assert_eq!(engine.get_outbox_depth().expect("depth"), 1);
}
