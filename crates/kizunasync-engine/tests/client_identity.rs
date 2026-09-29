//! The store keeps the identity this device registers under.
//!
//! The config's `client_id` seeds a store that keeps none; from then on the kept
//! identity wins on every open, and a reset replaces it with a minted one. A
//! host that passes a stable id therefore keeps the identity a reset minted
//! after a restart, and a host that passes a fresh id on every launch keeps
//! its first one instead of registering a new client each time.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, ScriptedRemote,
    SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_store::{CLIENT_ID_KEY, LocalMutation, LocalStore};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

const MINTED: &str = "00000000-0000-4000-8000-00000000000a";

fn config(client_id: &str) -> EngineConfig {
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("u1"));
    let mut tables = BTreeMap::new();
    tables.insert(
        "todos".to_string(),
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
        client_id: client_id.into(),
    }
}

fn open(path: &Path, client_id: &str, remote: &Arc<ScriptedRemote>) -> SyncEngine {
    SyncEngine::new(
        LocalStore::open_path(path).expect("store"),
        config(client_id),
        Arc::clone(remote) as Arc<_>,
        EngineDeps {
            uuid: Box::new(|| MINTED.to_string()),
            ..EngineDeps::default()
        },
    )
}

async fn pulled_identity(engine: &SyncEngine, remote: &ScriptedRemote) -> Option<String> {
    engine.pull_once().await.expect("pull");
    remote
        .last_pull
        .lock()
        .unwrap()
        .as_ref()
        .expect("a pull request was recorded")
        .client_id
        .clone()
}

async fn pushed_identity(engine: &SyncEngine, remote: &ScriptedRemote) -> Option<String> {
    let mut columns = Map::new();
    columns.insert("owner_id".into(), json!("u1"));
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
    engine.push_once().await.expect("push");
    remote
        .last_push
        .lock()
        .unwrap()
        .as_ref()
        .expect("a push request was recorded")
        .client_id
        .clone()
}

/// A store that keeps no identity takes the config's, and keeps it.
#[tokio::test]
async fn a_fresh_store_registers_under_the_config_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let remote = Arc::new(ScriptedRemote::new());

    let engine = open(&path, "c1", &remote);

    assert_eq!(
        pulled_identity(&engine, &remote).await.as_deref(),
        Some("c1")
    );
    drop(engine);
    let store = LocalStore::open_path(&path).expect("reopen");
    assert_eq!(store.meta_get(CLIENT_ID_KEY).expect("meta"), "c1");
}

/// The first open keeps its identity even when it never reached the server,
/// so a later launch with another id pulls and pushes under the first one.
#[tokio::test]
async fn a_reopen_registers_under_the_identity_the_first_open_kept() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let remote = Arc::new(ScriptedRemote::new());
    drop(open(&path, "c1", &remote));

    let reopened = open(&path, "c2", &remote);

    assert_eq!(
        pulled_identity(&reopened, &remote).await.as_deref(),
        Some("c1")
    );
    assert_eq!(
        pushed_identity(&reopened, &remote).await.as_deref(),
        Some("c1")
    );
}

/// The identity a reset minted outlives a restart: a host that passes the same
/// stable id again does not fall back to the registration the reset left.
#[tokio::test]
async fn the_identity_a_reset_minted_survives_a_restart() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let remote = Arc::new(ScriptedRemote::new());
    let engine = open(&path, "c1", &remote);
    engine.reset().await.expect("reset");
    drop(engine);

    let reopened = open(&path, "c1", &remote);

    assert_eq!(
        pulled_identity(&reopened, &remote).await.as_deref(),
        Some(MINTED)
    );
    assert_eq!(
        pushed_identity(&reopened, &remote).await.as_deref(),
        Some(MINTED)
    );
}
