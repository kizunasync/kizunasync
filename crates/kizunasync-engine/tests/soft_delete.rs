//! Soft delete end to end on a table that declares the column.
//!
//! The app's delete is an update stamping that column, so a filter-targeted
//! `delete()` marks its rows and the outbox carries ordinary updates; the
//! low-level `apply` keeps refusing `op: delete` with `SOFT_DELETE_VIOLATION`
//! BEFORE anything is written; and a marked row is neither a read result nor a
//! write target unless the caller asks for `includeDeleted`.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    ApplyWhere, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_query::{Filter, QueryPlan, QueryResult};
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

/// The one stamp the fixed clock writes, so a marked row is recognizable.
const NOW: &str = "2024-01-01T00:00:00.000Z";

fn engine(soft_delete_column: Option<&str>) -> SyncEngine {
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
            soft_delete_column: soft_delete_column.map(str::to_string),
            sync_mode: SyncMode::ReadWrite,
            conflict_mode: ConflictMode::Arrival,
            key: vec!["id".into()],
        },
    );
    let minted = AtomicU32::new(0);
    let deps = EngineDeps {
        now: Box::new(|| NOW.into()),
        uuid: Box::new(move || {
            let n = minted.fetch_add(1, Ordering::SeqCst) + 1;
            format!("00000000-0000-4000-8000-{n:012}")
        }),
        ..EngineDeps::default()
    };
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
        deps,
    )
}

fn mutation(op: Op) -> LocalMutation {
    let mut columns = Map::new();
    if op != Op::Delete {
        columns.insert("owner_id".into(), json!("user-a"));
        columns.insert("title".into(), json!("works on a plane"));
    }
    LocalMutation {
        table: "todos".into(),
        pk: "p-1".into(),
        op,
        columns,
        transforms: None,
        precondition: None,
        batch_id: None,
        hlc: None,
        mutation_id: None,
    }
}

#[test]
fn delete_on_a_soft_delete_table_is_refused_and_writes_nothing() {
    let engine = engine(Some("deleted_at"));
    engine.apply(mutation(Op::Insert)).expect("insert");
    let depth_before = engine.get_outbox_depth().expect("depth");

    let error = engine.apply(mutation(Op::Delete)).expect_err("refused");
    assert!(
        matches!(&error, EngineError::SoftDeleteViolation { table } if table == "todos"),
        "expected SoftDeleteViolation, got {error:?}"
    );
    assert_eq!(error.code(), error_catalog::SOFT_DELETE_VIOLATION);
    assert!(!error.is_budget_exempt());

    assert!(
        engine.read_row("todos", "p-1").expect("read").is_some(),
        "the refused delete must leave the row in place"
    );
    assert_eq!(
        engine.get_outbox_depth().expect("depth"),
        depth_before,
        "the refused delete must not enqueue anything"
    );
}

#[test]
fn an_update_that_marks_the_column_is_still_accepted() {
    let engine = engine(Some("deleted_at"));
    engine.apply(mutation(Op::Insert)).expect("insert");
    let mut marked = mutation(Op::Update);
    marked
        .columns
        .insert("deleted_at".into(), json!("2024-01-01T00:00:00.000Z"));
    engine.apply(marked).expect("soft delete rides an update");
    assert_eq!(engine.get_outbox_depth().expect("depth"), 2);
}

#[test]
fn a_table_without_the_column_still_hard_deletes() {
    let engine = engine(None);
    engine.apply(mutation(Op::Insert)).expect("insert");
    engine.apply(mutation(Op::Delete)).expect("hard delete");
    assert!(engine.read_row("todos", "p-1").expect("read").is_none());
}

// MARK: - The filter-targeted surface

fn insert(engine: &SyncEngine, pk: &str) {
    let mut insert = mutation(Op::Insert);
    insert.pk = pk.to_string();
    insert.mutation_id = Some(format!("m-{pk}"));
    engine.apply(insert).expect("insert");
}

fn delete_where(pk: &str, include_deleted: bool) -> ApplyWhere {
    ApplyWhere {
        table: "todos".into(),
        filters: vec![Filter::Eq {
            column: "id".into(),
            value: json!(pk),
        }],
        op: Op::Delete,
        columns: Map::new(),
        precondition: None,
        transforms: None,
        include_deleted,
        max_affected: None,
        returning: false,
        cardinality: None,
    }
}

fn plan(include_deleted: bool) -> QueryPlan {
    QueryPlan {
        include_deleted,
        ..QueryPlan::default()
    }
}

fn answered_ids(engine: &SyncEngine, include_deleted: bool) -> Vec<String> {
    let QueryResult::Many(rows) = engine
        .query("todos", &plan(include_deleted))
        .expect("query")
    else {
        panic!("a many plan answers many");
    };
    rows.iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// The app's delete: the row stays, the column carries the engine's `now`, and
/// the server sees an ordinary update.
#[test]
fn a_targeted_delete_marks_the_row_and_queues_an_update() {
    let engine = engine(Some("deleted_at"));
    insert(&engine, "p-1");

    let targeted = engine
        .apply_where(delete_where("p-1", false))
        .expect("targeted delete");

    assert_eq!(targeted.keys, vec!["p-1".to_string()]);
    let row = engine
        .read_row("todos", "p-1")
        .expect("read")
        .expect("the marked row is still there");
    assert_eq!(row.columns.get("deleted_at"), Some(&json!(NOW)));
    let queued = engine.list_outbox(10).expect("outbox");
    let marked = queued.last().expect("the delete queued something");
    assert_eq!(marked.op, Op::Update);
    assert_eq!(marked.columns.get("deleted_at"), Some(&json!(NOW)));
}

/// A marked row is not a row any more: the default read skips it, and the same
/// plan with `includeDeleted` brings it back.
#[test]
fn a_marked_row_leaves_the_default_read_and_returns_with_include_deleted() {
    let engine = engine(Some("deleted_at"));
    insert(&engine, "p-1");
    insert(&engine, "p-2");
    engine
        .apply_where(delete_where("p-1", false))
        .expect("targeted delete");

    assert_eq!(answered_ids(&engine, false), vec!["p-2".to_string()]);
    assert_eq!(
        answered_ids(&engine, true),
        vec!["p-1".to_string(), "p-2".to_string()]
    );
}

/// A marked row is no more a write target than a read result, so a second
/// `delete()` matches nothing until the caller asks for the marked rows.
#[test]
fn a_marked_row_is_targeted_again_only_with_include_deleted() {
    let engine = engine(Some("deleted_at"));
    insert(&engine, "p-1");
    engine
        .apply_where(delete_where("p-1", false))
        .expect("targeted delete");

    assert_eq!(
        engine
            .apply_where(delete_where("p-1", false))
            .expect("second delete")
            .keys,
        Vec::<String>::new()
    );
    assert_eq!(
        engine
            .apply_where(delete_where("p-1", true))
            .expect("second delete over the marked rows")
            .keys,
        vec!["p-1".to_string()]
    );
}

/// The conversion is the column's, not the op's: a table that declares none
/// still hard deletes through the same call.
#[test]
fn a_table_without_the_column_hard_deletes_through_apply_where() {
    let engine = engine(None);
    insert(&engine, "p-1");

    engine
        .apply_where(delete_where("p-1", false))
        .expect("targeted delete");

    assert!(engine.read_row("todos", "p-1").expect("read").is_none());
    let queued = engine.list_outbox(10).expect("outbox");
    assert_eq!(queued.last().expect("queued").op, Op::Delete);
}

/// The app's delete answers the row as it read before the mark, as a hard
/// delete does, although the row stays in the store.
#[test]
fn a_returning_soft_delete_answers_the_row_before_the_mark() {
    let engine = engine(Some("deleted_at"));
    insert(&engine, "p-1");

    let applied = engine
        .apply_where(ApplyWhere {
            returning: true,
            ..delete_where("p-1", false)
        })
        .expect("targeted delete");

    assert_eq!(applied.keys, vec!["p-1".to_string()]);
    let rows = applied.rows.expect("rows were asked for");
    assert_eq!(
        Value::Array(rows.into_iter().map(Value::Object).collect()),
        json!([{"id":"p-1","owner_id":"user-a","title":"works on a plane"}])
    );
    let marked = engine
        .read_row("todos", "p-1")
        .expect("read")
        .expect("the marked row is still there");
    assert_eq!(marked.columns.get("deleted_at"), Some(&json!(NOW)));
}
