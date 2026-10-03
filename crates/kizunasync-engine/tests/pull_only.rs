//! A table the server owns takes no local write.
//!
//! The kernel refuses every op on a `pull-only` table with `LOCAL_UNSUPPORTED`
//! before the write reaches the outbox, so the refusal is the same on every
//! runtime and the server's own rule stays the backstop rather than the first
//! line. The refusal covers both write entry points: the low-level `apply` and
//! the filter-targeted `apply_where`.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    ApplyWhere, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps,
    ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_query::{Filter, QueryPlan};
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::sync::Arc;

const SERVER_OWNED: &str = "announcements";
const WRITABLE: &str = "todos";

fn table(sync_mode: SyncMode) -> TableConfig {
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("user-a"));
    TableConfig {
        bucket_column: "owner_id".into(),
        bucket_params: params,
        bucket_owner: false,
        attachments: BTreeMap::new(),
        soft_delete_column: None,
        sync_mode,
        conflict_mode: ConflictMode::Arrival,
        key: vec!["id".into()],
    }
}

fn engine() -> SyncEngine {
    let mut tables = BTreeMap::new();
    tables.insert(SERVER_OWNED.into(), table(SyncMode::PullOnly));
    tables.insert(WRITABLE.into(), table(SyncMode::ReadWrite));
    let deps = EngineDeps {
        now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
        uuid: Box::new(|| "00000000-0000-4000-8000-000000000001".into()),
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

fn mutation(table: &str, op: Op) -> LocalMutation {
    let mut columns = Map::new();
    if op != Op::Delete {
        columns.insert("owner_id".into(), json!("user-a"));
        columns.insert("title".into(), json!("works on a plane"));
    }
    LocalMutation {
        table: table.into(),
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
fn every_op_is_refused_on_a_pull_only_table() {
    let engine = engine();

    for op in [Op::Insert, Op::Update, Op::Delete] {
        let error = engine
            .apply(mutation(SERVER_OWNED, op))
            .expect_err("a pull-only table takes no write");
        assert_eq!(error.code(), error_catalog::LOCAL_UNSUPPORTED, "{op:?}");
    }

    assert_eq!(
        engine.get_outbox_depth().expect("depth"),
        0,
        "a refused write must not reach the outbox"
    );
}

#[test]
fn a_filter_targeted_write_on_a_pull_only_table_is_refused_with_the_typed_code() {
    let engine = engine();

    let error = engine
        .apply_where(ApplyWhere {
            table: SERVER_OWNED.into(),
            filters: vec![Filter::Eq {
                column: "id".into(),
                value: json!("p-1"),
            }],
            op: Op::Update,
            columns: Map::new(),
            precondition: None,
            transforms: None,
            include_deleted: false,
            max_affected: None,
            returning: false,
            cardinality: None,
        })
        .expect_err("a pull-only table takes no filter-targeted write either");

    assert_eq!(error.code(), error_catalog::LOCAL_UNSUPPORTED);
}

/// The refusal is the write's, not the table's: the server owns the rows, and
/// reading them locally is the whole point of pulling them.
#[test]
fn reads_still_answer_and_writable_tables_are_untouched() {
    let engine = engine();

    engine
        .query(SERVER_OWNED, &QueryPlan::default())
        .expect("a pull-only table is readable");
    engine
        .apply(mutation(WRITABLE, Op::Insert))
        .expect("the writable table is untouched");
    assert_eq!(engine.get_outbox_depth().expect("depth"), 1);
}
