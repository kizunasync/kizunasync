//! The config every bridge parses: what it accepts, and what it refuses.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::bridge::{database_path, open_store_at, parse_config};
use kizunasync_engine::{EngineDeps, EngineError, ProtocolRemote, ScriptedRemote, SyncEngine};
use kizunasync_store::VfsKind;
use serde_json::{Value, json};
use std::sync::Arc;

const ITEMS: &str = r#"{"client_id":"u","tables":{"items":{"bucket_column":"user_id","bucket_params":{"user_id":"u1"}}}}"#;

fn config_with(key: &str, value: Value) -> Value {
    let mut v: Value = serde_json::from_str(ITEMS).unwrap();
    v.as_object_mut().unwrap().insert(key.into(), value);
    v
}

#[test]
fn default_limit_is_read_and_invalid_values_are_rejected() {
    let absent: Value = serde_json::from_str(ITEMS).unwrap();
    assert_eq!(parse_config(&absent).unwrap().default_limit, None);
    assert_eq!(
        parse_config(&config_with("default_limit", Value::Null))
            .unwrap()
            .default_limit,
        None
    );
    assert_eq!(
        parse_config(&config_with("default_limit", json!(50)))
            .unwrap()
            .default_limit,
        Some(50)
    );
    assert_eq!(
        parse_config(&config_with("defaultLimit", json!(25)))
            .unwrap()
            .default_limit,
        Some(25)
    );
    let err = parse_config(&config_with("default_limit", json!("50"))).unwrap_err();
    assert!(matches!(err, EngineError::Config(_)), "{err}");
    for degenerate in [json!(0), json!(-5)] {
        let err = parse_config(&config_with("default_limit", degenerate.clone())).unwrap_err();
        assert!(matches!(err, EngineError::Config(_)), "{degenerate}: {err}");
    }
}

/// `bucket_column` is recorded for the embedder; the engine derives the pull
/// scope from `bucket_params`, and an empty map is the unbucketed table of
/// `docs/sync/sync-rules-and-buckets.md`. An absent or empty column is
/// therefore a legal config, never an error.
#[test]
fn a_table_without_a_bucket_column_parses_as_unbucketed() {
    let mut absent = serde_json::Map::new();
    absent.insert("items".into(), json!({}));
    let config = parse_config(&config_with("tables", Value::Object(absent))).unwrap();
    assert_eq!(config.tables["items"].bucket_column, "");
    assert!(config.tables["items"].bucket_params.is_empty());

    let mut empty = serde_json::Map::new();
    empty.insert("items".into(), json!({ "bucket_column": "" }));
    let config = parse_config(&config_with("tables", Value::Object(empty))).unwrap();
    assert_eq!(config.tables["items"].bucket_column, "");
    assert!(config.tables["items"].bucket_params.is_empty());
}

#[test]
fn a_wrong_typed_bucket_column_is_refused() {
    let mut wrong_type = serde_json::Map::new();
    wrong_type.insert("items".into(), json!({ "bucket_column": 123 }));
    let err = parse_config(&config_with("tables", Value::Object(wrong_type))).unwrap_err();
    assert!(matches!(err, EngineError::Config(_)), "{err}");
}

#[test]
fn soft_delete_column_is_read_and_an_empty_one_is_ignored() {
    let mut tables = serde_json::Map::new();
    tables.insert(
        "items".into(),
        json!({ "bucket_column": "user_id", "soft_delete_column": "deleted_at" }),
    );
    let config = parse_config(&config_with("tables", Value::Object(tables))).unwrap();
    assert_eq!(
        config.tables["items"].soft_delete_column.as_deref(),
        Some("deleted_at")
    );
    let mut empty = serde_json::Map::new();
    empty.insert(
        "items".into(),
        json!({ "bucket_column": "user_id", "soft_delete_column": "" }),
    );
    let ignored = parse_config(&config_with("tables", Value::Object(empty))).unwrap();
    assert_eq!(ignored.tables["items"].soft_delete_column, None);
}

#[tokio::test]
async fn configured_default_limit_reaches_the_pull_request() {
    let remote = Arc::new(ScriptedRemote::new());
    let protocol: Arc<dyn ProtocolRemote> = remote.clone();
    let engine = SyncEngine::new(
        open_store_at(None).unwrap(),
        parse_config(&config_with("default_limit", json!(50))).unwrap(),
        protocol,
        EngineDeps::default(),
    );
    engine
        .pull_once()
        .await
        .expect("pull against the scripted remote");
    let recorded = remote.last_pull.lock().unwrap();
    let emitted = serde_json::to_value(recorded.as_ref().expect("a pull was issued")).unwrap();
    assert_eq!(emitted.get("limit"), Some(&json!(50)));
}

/// A config that names no page size must put no `limit` on the wire at all:
/// `pull-request.schema.json` leaves it optional and the server defaults it.
#[tokio::test]
async fn an_unconfigured_page_size_omits_limit_from_the_pull_request() {
    let remote = Arc::new(ScriptedRemote::new());
    let protocol: Arc<dyn ProtocolRemote> = remote.clone();
    let engine = SyncEngine::new(
        open_store_at(None).unwrap(),
        parse_config(&serde_json::from_str::<Value>(ITEMS).unwrap()).unwrap(),
        protocol,
        EngineDeps::default(),
    );
    engine
        .pull_once()
        .await
        .expect("pull against the scripted remote");
    let recorded = remote.last_pull.lock().unwrap();
    let emitted = serde_json::to_value(recorded.as_ref().expect("a pull was issued")).unwrap();
    assert_eq!(emitted.get("limit"), None);
}

/// Read raw, so ffi, napi and the browser bridge refuse the same values and the
/// opener alone decides what a given string means.
#[test]
fn the_database_path_is_read_raw() {
    assert_eq!(database_path(&json!({})).unwrap(), None);
    assert_eq!(
        database_path(&json!({ "database_path": null })).unwrap(),
        None
    );
    assert_eq!(
        database_path(&json!({ "database_path": "" })).unwrap(),
        Some("")
    );
    assert_eq!(
        database_path(&json!({ "databasePath": "kizunasync.db" })).unwrap(),
        Some("kizunasync.db")
    );
    let err = database_path(&json!({ "database_path": 5 })).unwrap_err();
    assert!(matches!(err, EngineError::Config(_)), "{err}");
}

#[test]
fn the_store_path_selects_memory_or_a_file() {
    assert_eq!(open_store_at(None).unwrap().kind(), VfsKind::Memory);
    assert_eq!(
        open_store_at(Some(":memory:")).unwrap().kind(),
        VfsKind::Memory
    );

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("kizunasync.db");
    assert_eq!(
        open_store_at(Some(path.to_str().unwrap())).unwrap().kind(),
        VfsKind::File
    );

    let Err(err) = open_store_at(Some("")) else {
        panic!("an empty path is a configuration error");
    };
    assert!(matches!(err, EngineError::Config(_)), "{err}");
}
