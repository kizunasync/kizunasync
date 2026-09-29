//! `set_bucket` answers for the keys it is given.
//!
//! A key no table declares as its bucket column is refused with `BUCKET_UNSET`
//! naming the key and the configured columns, and nothing is written: routing on
//! a column the config does not carry would quietly pull a scope the app never
//! asked for. The configured columns are what makes `bucket_column` a value the
//! engine reads rather than one it only records.
//!
//! A value that replaces the last one the store kept for that key replaces the
//! local scope, across restarts too: the next pull re-bootstraps from `"0"` and
//! its boundary replaces the snapshot, while queued writes stay.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::{Op, PullResponse, RowChange};
use kizunasync_store::{LocalMutation, LocalStore};
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

fn table(column: &str, params: Map<String, Value>) -> TableConfig {
    TableConfig {
        bucket_column: column.into(),
        bucket_params: params,
        bucket_owner: false,
        attachments: BTreeMap::new(),
        soft_delete_column: None,
        sync_mode: SyncMode::ReadWrite,
        conflict_mode: ConflictMode::Arrival,
    }
}

fn engine_over(tables: BTreeMap<String, TableConfig>, remote: Arc<ScriptedRemote>) -> SyncEngine {
    engine_with_store(LocalStore::open_in_memory().expect("store"), tables, remote)
}

fn engine_with_store(
    store: LocalStore,
    tables: BTreeMap<String, TableConfig>,
    remote: Arc<ScriptedRemote>,
) -> SyncEngine {
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
        EngineDeps {
            now: Box::new(|| "2020-01-01T00:00:00.000Z".into()),
            ..EngineDeps::default()
        },
    )
}

fn engine() -> SyncEngine {
    let mut tables = BTreeMap::new();
    for (name, column) in [("todos", "owner_id"), ("boards", "team_id")] {
        tables.insert(name.to_string(), table(column, params(&[(column, "")])));
    }
    engine_over(tables, Arc::new(ScriptedRemote::new()))
}

fn todos_tables() -> BTreeMap<String, TableConfig> {
    let mut tables = BTreeMap::new();
    tables.insert(
        "todos".to_string(),
        table("owner_id", params(&[("owner_id", "")])),
    );
    tables
}

/// `todos`, bucketed on `owner_id` and routed on `owner` through `set_bucket`
/// the way a host does at sign-in (`""` leaves it unset), over `remote`.
fn todos_engine(owner: &str, remote: &Arc<ScriptedRemote>) -> SyncEngine {
    let engine = engine_over(todos_tables(), Arc::clone(remote));
    set_owner(&engine, owner);
    engine
}

/// One launch of the app over the store file at `path`: the engine opens with
/// `owner_id` unset, and the host sets it at sign-in.
fn launch(path: &Path, owner: &str, remote: &Arc<ScriptedRemote>) -> SyncEngine {
    let store = LocalStore::open_path(path).expect("store");
    let engine = engine_with_store(store, todos_tables(), Arc::clone(remote));
    set_owner(&engine, owner);
    engine
}

/// One launch over the store file at `path` whose table config names the
/// owner, the way a native app names a bucket value in its config.
fn launch_configured(path: &Path, owner: &str, remote: &Arc<ScriptedRemote>) -> SyncEngine {
    let mut tables = BTreeMap::new();
    tables.insert(
        "todos".to_string(),
        table("owner_id", params(&[("owner_id", owner)])),
    );
    let store = LocalStore::open_path(path).expect("store");
    engine_with_store(store, tables, Arc::clone(remote))
}

fn set_owner(engine: &SyncEngine, owner: &str) {
    engine
        .set_bucket_params(&params(&[("owner_id", owner)]))
        .expect("owner_id is configured");
}

fn page(cursor: &str, has_more: bool, rows: &[(&str, &str)]) -> PullResponse {
    PullResponse {
        cursor: cursor.into(),
        has_more,
        rows: rows
            .iter()
            .map(|(pk, owner)| RowChange {
                table: "todos".into(),
                pk: (*pk).into(),
                seq: cursor.into(),
                columns: params(&[("owner_id", owner)]),
                deleted: false,
            })
            .collect(),
        tombstones: vec![],
        signal: None,
        conflicts: None,
    }
}

fn pulled_owner(remote: &ScriptedRemote) -> Value {
    remote
        .last_pull
        .lock()
        .unwrap()
        .as_ref()
        .expect("a pull request was recorded")
        .buckets[0]
        .params["owner_id"]
        .clone()
}

fn pulled_cursor(remote: &ScriptedRemote) -> String {
    remote
        .last_pull
        .lock()
        .unwrap()
        .as_ref()
        .expect("a pull request was recorded")
        .cursor
        .clone()
}

fn local_pks(engine: &SyncEngine) -> Vec<String> {
    engine
        .read_local_rows("todos")
        .expect("rows")
        .into_iter()
        .map(|row| row.pk)
        .collect()
}

fn params(pairs: &[(&str, &str)]) -> Map<String, serde_json::Value> {
    let mut params = Map::new();
    for (key, value) in pairs {
        params.insert((*key).to_string(), json!(value));
    }
    params
}

#[test]
fn a_configured_bucket_column_is_filled() {
    let engine = engine();

    engine
        .set_bucket_params(&params(&[("owner_id", "u1"), ("team_id", "t1")]))
        .expect("both keys are configured");

    assert_eq!(
        engine
            .bucket_params("todos")
            .expect("todos")
            .get("owner_id"),
        Some(&json!("u1"))
    );
    assert_eq!(
        engine
            .bucket_params("boards")
            .expect("boards")
            .get("team_id"),
        Some(&json!("t1"))
    );
}

#[test]
fn an_unconfigured_key_is_refused_and_writes_nothing() {
    let engine = engine();

    let error = engine
        .set_bucket_params(&params(&[("owner_id", "u1"), ("tenant_id", "x")]))
        .expect_err("tenant_id is no table's bucket column");

    assert_eq!(error.code(), error_catalog::BUCKET_UNSET);
    let EngineError::BucketColumnUnknown { key, configured } = &error else {
        panic!("{error} is not an unknown-bucket-column fault");
    };
    assert_eq!(key, "tenant_id");
    for column in ["owner_id", "team_id"] {
        assert!(
            configured.contains(column),
            "{configured} does not name {column}"
        );
    }
    assert_eq!(
        engine
            .bucket_params("todos")
            .expect("todos")
            .get("owner_id"),
        Some(&json!("")),
        "a refused call leaves every parameter as it was"
    );
}

/// A bucketed table whose params never named its column still receives the key:
/// filling only the keys a map already holds would leave the pull unscoped.
#[test]
fn a_key_is_set_on_every_table_bucketed_on_it() {
    let mut tables = BTreeMap::new();
    for name in ["todos", "notes"] {
        tables.insert(name.to_string(), table("owner_id", Map::new()));
    }
    tables.insert(
        "boards".to_string(),
        table("team_id", params(&[("team_id", "t1")])),
    );
    let engine = engine_over(tables, Arc::new(ScriptedRemote::new()));

    engine
        .set_bucket_params(&params(&[("owner_id", "u1")]))
        .expect("owner_id is configured");

    for name in ["todos", "notes"] {
        assert_eq!(
            Value::Object(engine.bucket_params(name).expect("table")),
            json!({ "owner_id": "u1" }),
            "{name}"
        );
    }
    assert_eq!(
        Value::Object(engine.bucket_params("boards").expect("boards")),
        json!({ "team_id": "t1" })
    );
}

/// A new value replaces the local scope: the next pull starts over from "0",
/// its boundary drops the rows of the old scope, and a queued write stays.
#[tokio::test]
async fn a_changed_value_rebootstraps_the_next_pull_and_keeps_queued_writes() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = todos_engine("u1", &remote);
    remote.enqueue_pull(page("5", false, &[("p1", "u1")]));
    engine.pull_once().await.expect("first pull");
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p9".into(),
            op: Op::Insert,
            columns: params(&[("owner_id", "u2")]),
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m9".into()),
        })
        .expect("queued write");

    engine
        .set_bucket_params(&params(&[("owner_id", "u2")]))
        .expect("set");
    remote.enqueue_pull(page("7", false, &[("p2", "u2")]));
    engine.pull_once().await.expect("rebootstrap");

    assert_eq!(pulled_cursor(&remote), "0");
    assert_eq!(local_pks(&engine), vec!["p2", "p9"]);
    assert_eq!(engine.get_outbox_depth().expect("depth"), 1);
    assert_eq!(engine.get_checkpoint().expect("cursor"), "7");

    engine.pull_once().await.expect("next pull");
    assert_eq!(
        pulled_cursor(&remote),
        "7",
        "the replacement ended with its boundary"
    );
}

/// Pages staged under the old scope are dropped with it, so none of their rows
/// survives into the new snapshot.
#[tokio::test]
async fn a_changed_value_drops_the_pages_staged_under_the_old_scope() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = todos_engine("u1", &remote);
    remote.enqueue_pull(page("3", true, &[("p1", "u1")]));
    engine.pull_once().await.expect("staged page");

    engine
        .set_bucket_params(&params(&[("owner_id", "u2")]))
        .expect("set");
    remote.enqueue_pull(page("7", false, &[("p2", "u2")]));
    engine.pull_once().await.expect("rebootstrap");

    assert_eq!(pulled_cursor(&remote), "0");
    assert_eq!(local_pks(&engine), vec!["p2"]);
}

/// Filling an unset value, or repeating the current one, replaces no scope:
/// the next pull resumes from the durable cursor.
#[tokio::test]
async fn filling_or_repeating_a_value_keeps_the_cursor() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = todos_engine("", &remote);
    engine.seed_checkpoint("5").await.expect("seed");

    engine
        .set_bucket_params(&params(&[("owner_id", "u1")]))
        .expect("fill");
    remote.enqueue_pull(page("6", false, &[]));
    engine.pull_once().await.expect("pull");
    assert_eq!(pulled_cursor(&remote), "5");

    engine
        .set_bucket_params(&params(&[("owner_id", "u1")]))
        .expect("repeat");
    engine.pull_once().await.expect("pull");
    assert_eq!(pulled_cursor(&remote), "6");
}

/// A refused call changes nothing, the durable cursor included.
#[tokio::test]
async fn a_refused_call_arms_no_rebootstrap() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = todos_engine("u1", &remote);
    engine.seed_checkpoint("5").await.expect("seed");

    engine
        .set_bucket_params(&params(&[("owner_id", "u2"), ("tenant_id", "x")]))
        .expect_err("tenant_id is no table's bucket column");
    engine.pull_once().await.expect("pull");

    assert_eq!(pulled_cursor(&remote), "5");
}

/// Launch 1 pulls team a. Launch 2 opens with the bucket unset and signs into
/// team b: the scope the store kept is team a's, so the pull starts over and
/// the snapshot keeps team b's rows only. Launch 3 signs into team b again and
/// resumes where launch 2 stopped.
#[tokio::test]
async fn a_scope_changed_across_a_restart_rebootstraps_and_keeps_only_the_new_rows() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("scope.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = launch(&path, "team-a", &remote);
        remote.enqueue_pull(page("5", false, &[("a1", "team-a"), ("a2", "team-a")]));
        engine.pull_once().await.expect("team a's pull");
    }

    {
        let engine = launch(&path, "team-b", &remote);
        remote.enqueue_pull(page("9", false, &[("b1", "team-b")]));
        engine.pull_once().await.expect("team b's bootstrap");

        assert_eq!(pulled_cursor(&remote), "0");
        assert_eq!(pulled_owner(&remote), json!("team-b"));
        assert_eq!(local_pks(&engine), vec!["b1"]);
        assert_eq!(engine.get_checkpoint().expect("cursor"), "9");
    }

    let engine = launch(&path, "team-b", &remote);
    remote.enqueue_pull(page("10", false, &[]));
    engine.pull_once().await.expect("team b's next pull");

    assert_eq!(pulled_cursor(&remote), "9");
    assert_eq!(local_pks(&engine), vec!["b1"]);
}

/// Signing into the scope the store already holds after a restart resumes from
/// the durable cursor and keeps every row.
#[tokio::test]
async fn the_kept_scope_set_again_after_a_restart_keeps_the_cursor() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("scope.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = launch(&path, "team-a", &remote);
        remote.enqueue_pull(page("5", false, &[("a1", "team-a")]));
        engine.pull_once().await.expect("team a's pull");
    }

    let engine = launch(&path, "team-a", &remote);
    remote.enqueue_pull(page("6", false, &[]));
    engine.pull_once().await.expect("team a's next pull");

    assert_eq!(pulled_cursor(&remote), "5");
    assert_eq!(local_pks(&engine), vec!["a1"]);
}

/// Clearing a value keeps the scope the store holds, so setting it back later
/// replaces nothing.
#[tokio::test]
async fn an_unset_value_keeps_the_scope_the_store_holds() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = todos_engine("u1", &remote);
    remote.enqueue_pull(page("5", false, &[("p1", "u1")]));
    engine.pull_once().await.expect("first pull");

    set_owner(&engine, "");
    set_owner(&engine, "u1");
    engine.pull_once().await.expect("next pull");

    assert_eq!(pulled_cursor(&remote), "5");
}

/// A reset starts the store over with no scope, so the first value after it
/// fills the bucket instead of replacing the scope the store held before.
#[tokio::test]
async fn a_reset_forgets_the_kept_scope() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = todos_engine("u1", &remote);
    remote.enqueue_pull(page("5", false, &[("p1", "u1")]));
    engine.pull_once().await.expect("first pull");

    engine.reset().await.expect("reset");
    engine.seed_checkpoint("3").await.expect("seed");
    set_owner(&engine, "u2");
    engine.pull_once().await.expect("pull after the reset");

    assert_eq!(pulled_cursor(&remote), "3");
}

/// The kept scope and the re-bootstrap are one store write: a store that
/// cannot keep the new scope arms nothing and changes no parameter.
#[tokio::test]
async fn a_scope_the_store_cannot_keep_changes_nothing() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("scope.db");
    let remote = Arc::new(ScriptedRemote::new());
    let engine = launch(&path, "team-a", &remote);
    remote.enqueue_pull(page("5", false, &[("a1", "team-a")]));
    engine.pull_once().await.expect("team a's pull");
    Connection::open(&path)
        .expect("connection")
        .execute_batch(
            "CREATE TRIGGER fail_scope_update BEFORE UPDATE ON _kizunasync_meta
             WHEN NEW.key = 'bucket_scope'
             BEGIN SELECT RAISE(ABORT, 'injected store fault'); END;",
        )
        .expect("trigger");

    let refused = engine.set_bucket_params(&params(&[("owner_id", "team-b")]));

    assert_eq!(
        refused.expect_err("the scope cannot be kept").code(),
        error_catalog::STORE
    );
    engine.pull_once().await.expect("next pull");
    assert_eq!(pulled_cursor(&remote), "5");
    assert_eq!(pulled_owner(&remote), json!("team-a"));
}

/// A value the config names counts like a `set_bucket` call at open. Launch 1
/// names team a and pulls; launch 2 names team b, so the pull starts over and
/// the snapshot keeps team b's rows only; launch 3 names team b again and
/// resumes where launch 2 stopped.
#[tokio::test]
async fn a_configured_scope_changed_across_a_restart_rebootstraps_and_keeps_only_the_new_rows() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("scope.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = launch_configured(&path, "team-a", &remote);
        remote.enqueue_pull(page("5", false, &[("a1", "team-a"), ("a2", "team-a")]));
        engine.pull_once().await.expect("team a's pull");
    }

    {
        let engine = launch_configured(&path, "team-b", &remote);
        remote.enqueue_pull(page("9", false, &[("b1", "team-b")]));
        engine.pull_once().await.expect("team b's bootstrap");

        assert_eq!(pulled_cursor(&remote), "0");
        assert_eq!(pulled_owner(&remote), json!("team-b"));
        assert_eq!(local_pks(&engine), vec!["b1"]);
        assert_eq!(engine.get_checkpoint().expect("cursor"), "9");
    }

    let engine = launch_configured(&path, "team-b", &remote);
    remote.enqueue_pull(page("10", false, &[]));
    engine.pull_once().await.expect("team b's next pull");

    assert_eq!(pulled_cursor(&remote), "9");
    assert_eq!(local_pks(&engine), vec!["b1"]);
}

/// The config naming the scope the store already holds resumes from the
/// durable cursor and keeps every row.
#[tokio::test]
async fn the_configured_scope_named_again_after_a_restart_keeps_the_cursor() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("scope.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = launch_configured(&path, "team-a", &remote);
        remote.enqueue_pull(page("5", false, &[("a1", "team-a")]));
        engine.pull_once().await.expect("team a's pull");
    }

    let engine = launch_configured(&path, "team-a", &remote);
    remote.enqueue_pull(page("6", false, &[]));
    engine.pull_once().await.expect("team a's next pull");

    assert_eq!(pulled_cursor(&remote), "5");
    assert_eq!(local_pks(&engine), vec!["a1"]);
}

/// A config that names a value where the last launch's `set_bucket` kept
/// another replaces the scope the same way.
#[tokio::test]
async fn a_configured_value_replaces_the_scope_a_set_bucket_kept() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("scope.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = launch(&path, "team-a", &remote);
        remote.enqueue_pull(page("5", false, &[("a1", "team-a")]));
        engine.pull_once().await.expect("team a's pull");
    }

    let engine = launch_configured(&path, "team-b", &remote);
    remote.enqueue_pull(page("9", false, &[("b1", "team-b")]));
    engine.pull_once().await.expect("team b's bootstrap");

    assert_eq!(pulled_cursor(&remote), "0");
    assert_eq!(local_pks(&engine), vec!["b1"]);
}

/// The configured value is the kept scope from the open on, so a `set_bucket`
/// that names another value in the same launch replaces it.
#[tokio::test]
async fn a_set_bucket_that_replaces_a_configured_value_rebootstraps() {
    let remote = Arc::new(ScriptedRemote::new());
    let mut tables = BTreeMap::new();
    tables.insert(
        "todos".to_string(),
        table("owner_id", params(&[("owner_id", "team-a")])),
    );
    let engine = engine_over(tables, Arc::clone(&remote));
    remote.enqueue_pull(page("5", false, &[("a1", "team-a")]));
    engine.pull_once().await.expect("team a's pull");

    set_owner(&engine, "team-b");
    remote.enqueue_pull(page("9", false, &[("b1", "team-b")]));
    engine.pull_once().await.expect("team b's bootstrap");

    assert_eq!(pulled_cursor(&remote), "0");
    assert_eq!(local_pks(&engine), vec!["b1"]);
}

/// A store that cannot keep the scope the config names leaves that value
/// unset: the pull refuses with `BUCKET_UNSET` instead of pulling a scope the
/// store never recorded over rows of the one it did.
#[tokio::test]
async fn a_configured_scope_the_store_cannot_keep_leaves_the_bucket_unset() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("scope.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = launch_configured(&path, "team-a", &remote);
        remote.enqueue_pull(page("5", false, &[("a1", "team-a")]));
        engine.pull_once().await.expect("team a's pull");
    }
    Connection::open(&path)
        .expect("connection")
        .execute_batch(
            "CREATE TRIGGER fail_scope_update BEFORE UPDATE ON _kizunasync_meta
             WHEN NEW.key = 'bucket_scope'
             BEGIN SELECT RAISE(ABORT, 'injected store fault'); END;",
        )
        .expect("trigger");

    let engine = launch_configured(&path, "team-b", &remote);
    let refused = engine.pull_once().await;

    assert_eq!(
        refused.expect_err("the scope was never kept").code(),
        error_catalog::BUCKET_UNSET
    );
    assert_eq!(pulled_owner(&remote), json!("team-a"));
    assert_eq!(engine.get_checkpoint().expect("cursor"), "5");
    assert_eq!(local_pks(&engine), vec!["a1"]);
}
