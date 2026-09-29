//! A table flagged `bucket_owner` belongs to the user who owns the store.
//!
//! The engine fills that table's bucket value with the owner's `sub` claim: at
//! open when the store already has an owner, and when a token first records
//! one. A token that names another user latches `identity_changed` and leaves
//! the value alone, a reset unsets it together with the owner, and an explicit
//! `set_bucket` still sets it. An insert that leaves the bucket column out gets
//! the owner written into it before the mirror row and the outbox entry are
//! stored, so the app never passes its own user id.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod attachment_fixtures;

use attachment_fixtures::sign_in;
use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, ProtocolRemote,
    ScriptedRemote, SoftBlockReason, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::{Op, PullResponse};
use kizunasync_store::{LocalMutation, LocalStore};
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, PoisonError};

const USER_A: &str = "00000000-0000-4000-8000-0000000000a1";
const USER_B: &str = "00000000-0000-4000-8000-0000000000b2";

// MARK: - Engines

/// A table bucketed on `owner_id`, left unset, with or without the owner flag.
fn table(bucket_owner: bool) -> TableConfig {
    table_on("owner_id", bucket_owner)
}

/// A table bucketed on `column`, left unset, with or without the owner flag.
fn table_on(column: &str, bucket_owner: bool) -> TableConfig {
    let mut params = Map::new();
    params.insert(column.into(), json!(""));
    TableConfig {
        bucket_column: column.into(),
        bucket_params: params,
        bucket_owner,
        attachments: BTreeMap::new(),
        soft_delete_column: None,
        sync_mode: SyncMode::ReadWrite,
        conflict_mode: ConflictMode::Arrival,
    }
}

/// `todos` only, whose bucket belongs to the store's owner.
fn owner_tables() -> BTreeMap<String, TableConfig> {
    BTreeMap::from([("todos".to_string(), table(true))])
}

/// `todos` owned by the store's owner beside `notes`, bucketed on the same
/// column without the flag.
fn mixed_tables() -> BTreeMap<String, TableConfig> {
    BTreeMap::from([
        ("todos".to_string(), table(true)),
        ("notes".to_string(), table(false)),
    ])
}

fn engine_with(
    store: LocalStore,
    tables: BTreeMap<String, TableConfig>,
    remote: &Arc<ScriptedRemote>,
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
        Arc::clone(remote) as Arc<dyn ProtocolRemote>,
        EngineDeps {
            now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
            now_millis: Box::new(|| 1_704_067_200_000),
            ..EngineDeps::default()
        },
    )
}

fn memory_engine(remote: &Arc<ScriptedRemote>) -> SyncEngine {
    engine_with(
        LocalStore::open_in_memory().unwrap(),
        owner_tables(),
        remote,
    )
}

fn file_engine(path: &Path, remote: &Arc<ScriptedRemote>) -> SyncEngine {
    engine_with(LocalStore::open_path(path).unwrap(), owner_tables(), remote)
}

// MARK: - Writes and observations

/// Insert `columns` into `table` as row `pk`.
fn insert(engine: &SyncEngine, table: &str, pk: &str, columns: Map<String, Value>) {
    write(engine, table, pk, Op::Insert, columns);
}

fn write(engine: &SyncEngine, table: &str, pk: &str, op: Op, columns: Map<String, Value>) {
    engine
        .apply(LocalMutation {
            table: table.into(),
            pk: pk.into(),
            op,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some(format!("m-{table}-{pk}-{op:?}")),
        })
        .unwrap();
}

fn titled(title: &str) -> Map<String, Value> {
    let mut columns = Map::new();
    columns.insert("title".into(), json!(title));
    columns
}

fn stored_columns(engine: &SyncEngine, table: &str, pk: &str) -> Value {
    Value::Object(
        engine
            .read_row(table, pk)
            .unwrap()
            .expect("the row")
            .columns,
    )
}

fn owner_param(engine: &SyncEngine, table: &str) -> Value {
    engine.bucket_params(table).unwrap()["owner_id"].clone()
}

fn pulled_owner(remote: &ScriptedRemote) -> Value {
    remote
        .last_pull
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .expect("a pull request was recorded")
        .buckets[0]
        .params["owner_id"]
        .clone()
}

/// Every bucket the last pull named, as `{ table: params }`.
fn pulled_buckets(remote: &ScriptedRemote) -> Value {
    let request = remote
        .last_pull
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .expect("a pull request was recorded");
    request
        .buckets
        .into_iter()
        .map(|bucket| (bucket.table, Value::Object(bucket.params)))
        .collect::<Map<String, Value>>()
        .into()
}

fn set_owner_column(engine: &SyncEngine, column: &str, value: &str) {
    let mut params = Map::new();
    params.insert(column.into(), json!(value));
    engine.set_bucket_params(&params).unwrap();
}

fn pulled_cursor(remote: &ScriptedRemote) -> String {
    remote
        .last_pull
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .expect("a pull request was recorded")
        .cursor
        .clone()
}

/// Every write of the kept bucket scope fails until the triggers are dropped.
fn fail_scope_writes(path: &Path) {
    Connection::open(path)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fail_scope_insert BEFORE INSERT ON _kizunasync_meta
             WHEN NEW.key = 'bucket_scope'
             BEGIN SELECT RAISE(ABORT, 'injected store fault'); END;
             CREATE TRIGGER fail_scope_update BEFORE UPDATE ON _kizunasync_meta
             WHEN NEW.key = 'bucket_scope'
             BEGIN SELECT RAISE(ABORT, 'injected store fault'); END;",
        )
        .unwrap();
}

fn heal_scope_writes(path: &Path) {
    Connection::open(path)
        .unwrap()
        .execute_batch(
            "DROP TRIGGER fail_scope_insert;
             DROP TRIGGER fail_scope_update;",
        )
        .unwrap();
}

// MARK: - Bucket fill

#[tokio::test]
async fn a_store_without_an_owner_leaves_the_owner_bucket_unset() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);

    let refused = engine.pull_once().await;

    assert_eq!(owner_param(&engine, "todos"), json!(""));
    assert_eq!(
        refused.expect_err("no owner, no bucket").code(),
        error_catalog::BUCKET_UNSET
    );
}

#[tokio::test]
async fn the_first_token_fills_the_owner_bucket() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);

    sign_in(&engine, USER_A);
    engine.pull_once().await.unwrap();

    assert_eq!(owner_param(&engine, "todos"), json!(USER_A));
    assert_eq!(pulled_owner(&remote), json!(USER_A));
}

/// The next launch opens with the owner the store kept, so it pulls before the
/// host has handed it any token.
#[tokio::test]
async fn an_open_over_a_store_with_an_owner_fills_the_owner_bucket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owner.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = file_engine(&path, &remote);
        sign_in(&engine, USER_A);
    }

    let engine = file_engine(&path, &remote);
    engine.pull_once().await.unwrap();

    assert_eq!(owner_param(&engine, "todos"), json!(USER_A));
    assert_eq!(pulled_owner(&remote), json!(USER_A));
}

#[tokio::test]
async fn a_token_of_another_user_leaves_the_owner_bucket_as_it_was() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);

    sign_in(&engine, USER_B);

    assert_eq!(
        engine.soft_block_reason().unwrap(),
        Some(SoftBlockReason::IdentityChanged)
    );
    assert_eq!(owner_param(&engine, "todos"), json!(USER_A));
}

/// A reset forgets the owner and unsets the bucket with it: an insert made
/// before the next token keeps the row as written, and the next token fills
/// both again.
#[tokio::test]
async fn a_reset_clears_the_owner_and_unsets_the_owner_bucket() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);
    sign_in(&engine, USER_B);

    engine.reset().await.unwrap();

    assert_eq!(owner_param(&engine, "todos"), json!(""));
    insert(&engine, "todos", "r1", titled("after the reset"));
    assert_eq!(
        stored_columns(&engine, "todos", "r1"),
        json!({ "title": "after the reset" })
    );

    sign_in(&engine, USER_B);

    assert!(!engine.is_soft_blocked().unwrap());
    assert_eq!(owner_param(&engine, "todos"), json!(USER_B));
}

/// `set_bucket` on the owner column still sets the value, and a refreshed
/// token of the same owner does not put the owner back.
#[tokio::test]
async fn an_explicit_set_bucket_wins_over_the_owner() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);

    let mut params = Map::new();
    params.insert("owner_id".into(), json!("team-x"));
    engine.set_bucket_params(&params).unwrap();
    sign_in(&engine, USER_A);
    engine.pull_once().await.unwrap();

    assert_eq!(owner_param(&engine, "todos"), json!("team-x"));
    assert_eq!(pulled_owner(&remote), json!("team-x"));
}

#[tokio::test]
async fn a_table_without_the_flag_keeps_its_bucket_unset() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine_with(
        LocalStore::open_in_memory().unwrap(),
        mixed_tables(),
        &remote,
    );

    sign_in(&engine, USER_A);

    assert_eq!(owner_param(&engine, "todos"), json!(USER_A));
    assert_eq!(owner_param(&engine, "notes"), json!(""));
}

/// The bridge refuses this config, and a config built in Rust skips that
/// check: the flagged table has nowhere to put the owner, so it stays
/// unbucketed and pulls like one.
#[tokio::test]
async fn a_flagged_table_without_a_bucket_column_stays_unbucketed() {
    let remote = Arc::new(ScriptedRemote::new());
    let mut shared = table(true);
    shared.bucket_column = String::new();
    shared.bucket_params = Map::new();
    let engine = engine_with(
        LocalStore::open_in_memory().unwrap(),
        BTreeMap::from([("shared".to_string(), shared)]),
        &remote,
    );

    sign_in(&engine, USER_A);
    insert(&engine, "shared", "s1", titled("for everyone"));
    engine.pull_once().await.unwrap();

    assert!(engine.bucket_params("shared").unwrap().is_empty());
    assert_eq!(
        stored_columns(&engine, "shared", "s1"),
        json!({ "title": "for everyone" })
    );
}

/// The owner fill is kept as the store's scope like any `set_bucket` value, so
/// a later value that replaces it re-bootstraps the next pull.
#[tokio::test]
async fn a_value_that_replaces_the_filled_owner_rebootstraps() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);
    engine.seed_checkpoint("5").await.unwrap();

    let mut params = Map::new();
    params.insert("owner_id".into(), json!("team-x"));
    engine.set_bucket_params(&params).unwrap();
    engine.pull_once().await.unwrap();

    assert_eq!(pulled_cursor(&remote), "0");
}

/// The owner is recorded only once the fill is kept, so a store that could not
/// keep it fills and records both on the next pull.
#[tokio::test]
async fn an_owner_the_store_could_not_fill_is_filled_before_the_next_pull() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owner.db");
    let remote = Arc::new(ScriptedRemote::new());
    let engine = file_engine(&path, &remote);
    fail_scope_writes(&path);

    sign_in(&engine, USER_A);

    assert_eq!(owner_param(&engine, "todos"), json!(""));
    assert_eq!(
        engine.pull_once().await.unwrap_err().code(),
        error_catalog::STORE
    );

    heal_scope_writes(&path);
    engine.pull_once().await.unwrap();

    assert_eq!(pulled_owner(&remote), json!(USER_A));
    sign_in(&engine, USER_B);
    assert!(
        engine.is_soft_blocked().unwrap(),
        "the pull recorded user a as the owner"
    );
}

/// Once the store has an owner, the owner overwrites a value set before it.
#[tokio::test]
async fn the_owner_overwrites_a_value_set_before_it_was_recorded() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    set_owner_column(&engine, "owner_id", "team-x");

    sign_in(&engine, USER_A);
    engine.pull_once().await.unwrap();

    assert_eq!(owner_param(&engine, "todos"), json!(USER_A));
    assert_eq!(pulled_owner(&remote), json!(USER_A));
}

/// An owner bucket set back to unset is filled again when the pull builds its
/// buckets.
#[tokio::test]
async fn a_pull_fills_an_owner_bucket_set_back_to_unset() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);
    set_owner_column(&engine, "owner_id", "");

    engine.pull_once().await.unwrap();

    assert_eq!(owner_param(&engine, "todos"), json!(USER_A));
    assert_eq!(pulled_owner(&remote), json!(USER_A));
}

/// Only the owner buckets still unset are filled: a value set on another
/// owner column stays.
#[tokio::test]
async fn a_pull_fills_only_the_owner_buckets_still_unset() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine_with(
        LocalStore::open_in_memory().unwrap(),
        BTreeMap::from([
            ("todos".to_string(), table_on("owner_id", true)),
            ("boards".to_string(), table_on("created_by", true)),
        ]),
        &remote,
    );
    sign_in(&engine, USER_A);
    set_owner_column(&engine, "owner_id", "team-x");
    set_owner_column(&engine, "created_by", "");

    engine.pull_once().await.unwrap();

    assert_eq!(
        pulled_buckets(&remote),
        json!({
            "boards": { "created_by": USER_A },
            "todos": { "owner_id": "team-x" },
        })
    );
}

/// A fill the store could not keep at open is retried by every pull until it
/// is kept, through the same path, so a fill that replaces the kept scope
/// re-bootstraps.
#[tokio::test]
async fn a_pull_retries_an_owner_fill_the_open_could_not_keep() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owner.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = file_engine(&path, &remote);
        sign_in(&engine, USER_A);
        set_owner_column(&engine, "owner_id", "team-x");
        remote.enqueue_pull(PullResponse {
            cursor: "5".into(),
            has_more: false,
            rows: vec![],
            tombstones: vec![],
            signal: None,
            conflicts: None,
        });
        engine.pull_once().await.unwrap();
    }
    fail_scope_writes(&path);

    let engine = file_engine(&path, &remote);

    assert_eq!(owner_param(&engine, "todos"), json!(""));
    assert_eq!(
        engine.pull_once().await.unwrap_err().code(),
        error_catalog::STORE
    );

    heal_scope_writes(&path);
    engine.pull_once().await.unwrap();

    assert_eq!(owner_param(&engine, "todos"), json!(USER_A));
    assert_eq!(pulled_owner(&remote), json!(USER_A));
    assert_eq!(pulled_cursor(&remote), "0");
}

/// After a reset the pull under the session the host still holds records the
/// owner and fills the bucket before it builds the request.
#[tokio::test]
async fn after_a_reset_the_next_pull_fills_the_owner_bucket_again() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);
    engine.reset().await.unwrap();

    engine.pull_once().await.unwrap();

    assert_eq!(pulled_owner(&remote), json!(USER_A));
}

/// A store latched on another user sends nothing, so its pull fills nothing
/// either.
#[tokio::test]
async fn a_pull_of_a_blocked_store_fills_nothing() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);
    set_owner_column(&engine, "owner_id", "");
    sign_in(&engine, USER_B);

    engine.pull_once().await.unwrap();

    assert_eq!(owner_param(&engine, "todos"), json!(""));
    assert!(remote.last_pull.lock().unwrap().is_none());
}

// MARK: - Insert fill

/// The owner reaches the mirror row and every read of it.
#[tokio::test]
async fn an_insert_without_the_owner_column_gets_the_owner() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);

    insert(&engine, "todos", "r1", titled("buy milk"));

    assert_eq!(
        stored_columns(&engine, "todos", "r1"),
        json!({ "title": "buy milk", "owner_id": USER_A })
    );
    assert_eq!(
        engine.read_all_rows("todos").unwrap(),
        vec![
            json!({ "id": "r1", "title": "buy milk", "owner_id": USER_A })
                .as_object()
                .unwrap()
                .clone()
        ]
    );
}

/// The queued write and the push that sends it carry the owner too, so the
/// server row matches the optimistic one.
#[tokio::test]
async fn the_outbox_entry_carries_the_filled_owner() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);

    insert(&engine, "todos", "r1", titled("buy milk"));

    let queued = engine.list_outbox(10).unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(
        Value::Object(queued[0].columns.clone()),
        json!({ "title": "buy milk", "owner_id": USER_A })
    );

    engine.push_once().await.unwrap();

    let pushed = remote
        .last_push
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .expect("a push request was recorded");
    assert_eq!(
        Value::Object(pushed.batch.mutations[0].columns.clone()),
        json!({ "title": "buy milk", "owner_id": USER_A })
    );
}

#[tokio::test]
async fn an_insert_after_a_restart_gets_the_owner_the_store_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owner.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = file_engine(&path, &remote);
        sign_in(&engine, USER_A);
    }

    let engine = file_engine(&path, &remote);
    insert(&engine, "todos", "r1", titled("offline at launch"));

    assert_eq!(
        stored_columns(&engine, "todos", "r1"),
        json!({ "title": "offline at launch", "owner_id": USER_A })
    );
}

/// With no owner yet the row stays as written, and the server's column
/// default decides.
#[test]
fn an_insert_with_no_owner_known_is_left_as_written() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);

    insert(&engine, "todos", "r1", titled("before sign-in"));

    assert_eq!(
        stored_columns(&engine, "todos", "r1"),
        json!({ "title": "before sign-in" })
    );
    assert_eq!(
        Value::Object(engine.list_outbox(10).unwrap()[0].columns.clone()),
        json!({ "title": "before sign-in" })
    );
}

/// A column the row already names is the app's value, an explicit null
/// included.
#[test]
fn an_insert_that_names_the_owner_column_is_left_alone() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);

    let mut named = titled("shared");
    named.insert("owner_id".into(), json!(USER_B));
    insert(&engine, "todos", "r1", named);
    let mut null = titled("unowned");
    null.insert("owner_id".into(), Value::Null);
    insert(&engine, "todos", "r2", null);

    assert_eq!(
        stored_columns(&engine, "todos", "r1"),
        json!({ "title": "shared", "owner_id": USER_B })
    );
    assert_eq!(
        stored_columns(&engine, "todos", "r2"),
        json!({ "title": "unowned", "owner_id": null })
    );
}

#[test]
fn an_insert_into_a_table_without_the_flag_is_left_as_written() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine_with(
        LocalStore::open_in_memory().unwrap(),
        mixed_tables(),
        &remote,
    );
    sign_in(&engine, USER_A);

    insert(&engine, "notes", "n1", titled("not owned"));

    assert_eq!(
        stored_columns(&engine, "notes", "n1"),
        json!({ "title": "not owned" })
    );
}

/// An update is a patch: leaving the owner column out keeps the stored value,
/// so nothing is written into it.
#[test]
fn an_update_is_left_as_written() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    insert(&engine, "todos", "r1", titled("before sign-in"));
    sign_in(&engine, USER_A);

    write(&engine, "todos", "r1", Op::Update, titled("renamed"));

    assert_eq!(
        stored_columns(&engine, "todos", "r1"),
        json!({ "title": "renamed" })
    );
    let queued = engine.list_outbox(10).unwrap();
    assert_eq!(
        Value::Object(queued[1].columns.clone()),
        json!({ "title": "renamed" })
    );
}
