//! One real call sequence per engine refusal the other suites never reach.
//!
//! Each case drives the public API until the engine answers, then pins the typed
//! variant AND its catalog code: an app switches on the code, and a bridge
//! rebuilds the typed error from that same code.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    AttachmentSpec, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps,
    EngineError, ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use tempfile::tempdir;

/// The path handed to `from_file`: every case here is refused before the source
/// file is read, so the path never has to exist.
const SOURCE: &str = "/unread/photo.png";

/// A one-table engine whose `photo` column is an attachment owned by `owner_id`,
/// pulling under the bucket value the caller passes.
fn engine(bucket_value: &str) -> SyncEngine {
    let mut attachments = BTreeMap::new();
    attachments.insert(
        "photo".to_string(),
        AttachmentSpec {
            storage_bucket: "media".into(),
            owner_column: "owner_id".into(),
        },
    );
    let mut params = Map::new();
    params.insert("owner_id".into(), json!(bucket_value));
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
        },
    );
    SyncEngine::new(
        LocalStore::open_in_memory().expect("store"),
        EngineConfig {
            tables,
            schema_version: 1,
            default_limit: None,
            attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
            client_id: "c1".into(),
        },
        Arc::new(ScriptedRemote::new()),
        EngineDeps {
            now: Box::new(|| "2020-01-01T00:00:00.000Z".into()),
            ..EngineDeps::default()
        },
    )
}

fn insert(engine: &SyncEngine, table: &str, pk: &str, columns: Map<String, Value>) {
    engine
        .apply(LocalMutation {
            table: table.into(),
            pk: pk.into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some(format!("m-{pk}")),
        })
        .expect("apply row");
}

/// An empty bucket value is a parameter the app never filled, so the engine
/// refuses the whole pull instead of asking the server for a scope nobody chose.
#[tokio::test]
async fn a_pull_under_an_unfilled_bucket_value_is_refused_as_bucket_unset() {
    let engine = engine("");

    let error = engine
        .pull_once()
        .await
        .expect_err("the pull must be refused");

    assert!(matches!(&error, EngineError::BucketUnset), "{error:?}");
    assert_eq!(error.code(), error_catalog::BUCKET_UNSET);
}

/// A table the config does not carry has no bucket, no sync mode and no conflict
/// rule, so the write is refused before it can reach the local mirror.
#[test]
fn a_write_naming_a_table_outside_the_config_is_refused_as_unknown_table() {
    let engine = engine("u1");
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));

    let error = engine
        .apply(LocalMutation {
            table: "ghosts".into(),
            pk: "p1".into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m1".into()),
        })
        .expect_err("the write must be refused");

    assert!(
        matches!(&error, EngineError::UnknownTable(table) if table == "ghosts"),
        "{error:?}"
    );
    assert_eq!(error.code(), error_catalog::UNKNOWN_TABLE);
}

/// A host that reuses a mutation id would have its second write answered and
/// cleared as the first, so the write is refused before the row changes and
/// nothing new is queued.
#[test]
fn a_write_reusing_a_queued_mutation_id_is_refused_as_local_constraint() {
    let engine = engine("u1");
    let mut columns = Map::new();
    columns.insert("title".into(), json!("first"));
    insert(&engine, "todos", "p1", columns);

    let mut renamed = Map::new();
    renamed.insert("title".into(), json!("renamed"));
    let error = engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Update,
            columns: renamed,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m-p1".into()),
        })
        .expect_err("the reused id must be refused");

    assert_eq!(error.code(), error_catalog::LOCAL_CONSTRAINT);
    assert_eq!(engine.get_outbox_depth().expect("depth"), 1);
    assert_eq!(
        engine
            .read_row("todos", "p1")
            .expect("read")
            .expect("row")
            .columns
            .get("title"),
        Some(&json!("first"))
    );
}

/// `from_file` copies host bytes into the sandbox, so a client created without a
/// sandbox root has nowhere to put them and refuses before reading the source.
#[test]
fn an_import_without_a_sandbox_root_is_refused_as_ports_missing() {
    let engine = engine("u1");

    let error = engine
        .from_file("todos", "photo", "p1", SOURCE, None)
        .expect_err("the import must be refused");

    assert!(
        matches!(&error, EngineError::AttachmentPortsMissing),
        "{error:?}"
    );
    assert_eq!(error.code(), error_catalog::ATTACHMENT_PORTS_MISSING);
}

/// The import ends by stamping the reference onto its row, so with no local row
/// it would queue an upload nothing points at.
#[test]
fn an_import_for_a_row_that_is_not_local_is_refused_as_row_gone() {
    let sandbox = tempdir().expect("sandbox");
    let engine = engine("u1").with_attachment_root(sandbox.path().to_path_buf());

    let error = engine
        .from_file("todos", "photo", "p1", SOURCE, None)
        .expect_err("the import must be refused");

    assert!(
        matches!(&error, EngineError::AttachmentRowGone(reference) if reference == "todos/p1"),
        "{error:?}"
    );
    assert_eq!(error.code(), error_catalog::ATTACHMENT_ROW_GONE);
}

/// The object key is owner-scoped, so a row carrying no owner cannot name a path
/// Storage would accept.
#[test]
fn an_import_from_a_row_without_its_owner_column_is_refused_as_owner_missing() {
    let sandbox = tempdir().expect("sandbox");
    let engine = engine("u1").with_attachment_root(sandbox.path().to_path_buf());
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    insert(&engine, "todos", "p1", columns);

    let error = engine
        .from_file("todos", "photo", "p1", SOURCE, None)
        .expect_err("the import must be refused");

    assert!(
        matches!(&error, EngineError::AttachmentOwnerMissing(column) if column == "todos.owner_id"),
        "{error:?}"
    );
    assert_eq!(error.code(), error_catalog::ATTACHMENT_OWNER_MISSING);
}

/// A missing host file is a transfer fault, not a retryable remote one: there
/// is nothing on the network to retry.
#[test]
fn an_import_from_a_missing_source_file_is_refused_as_transfer() {
    let sandbox = tempdir().expect("sandbox");
    let engine = engine("u1").with_attachment_root(sandbox.path().to_path_buf());
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    insert(&engine, "todos", "p1", columns);

    let error = engine
        .from_file("todos", "photo", "p1", SOURCE, None)
        .expect_err("the import must be refused");

    assert!(
        matches!(
            &error,
            EngineError::Transfer(kizunasync_transfer::TransferError::LocalBytesMissing { path })
                if path == SOURCE
        ),
        "{error:?}"
    );
    assert_eq!(error.code(), error_catalog::TRANSFER);
    assert!(!error.is_budget_exempt());
}
