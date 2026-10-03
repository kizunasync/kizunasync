//! Filter-targeted local writes address the row a read reports, and every refusal
//! carries one code.
//!
//! A pulled row carries no `id` inside its column map: the server sends the
//! columns, the primary key lives in its own store column, and the query seam
//! derives `id` from the pk. A write that scanned the raw column map instead would
//! match nothing on `eq("id", pk)` beside another filter, nothing on
//! `in("id", [..])`, and everything on `neq("id", keep)`, so a delete would take
//! the one row the caller meant to spare. Every test here seeds rows through a
//! pull and then targets them by `id`.
//!
//! The second half pins the code each refusal carries, because an app switches on
//! the code and never on the message.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    ApplyWhere, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ScriptedRemote, SyncEngine, SyncMode, TableConfig, WriteCardinality,
};
use kizunasync_protocol::{Op, PullResponse, RowChange};
use kizunasync_query::{Filter, OrderBy, QueryPlan, QueryResult};
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

const TABLE: &str = "todos";
const KEEP: &str = "p3";

fn config() -> EngineConfig {
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("user-a"));
    let mut tables = BTreeMap::new();
    tables.insert(
        TABLE.into(),
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

/// The columns a server sends for one row. No `id`: the wire row is the column
/// map and the pk travels beside it.
fn server_columns(title: &str, done: bool) -> Map<String, Value> {
    let mut columns = Map::new();
    columns.insert("owner_id".into(), json!("user-a"));
    columns.insert("title".into(), json!(title));
    columns.insert("done".into(), json!(done));
    columns
}

fn row_change(pk: &str, title: &str, done: bool) -> RowChange {
    RowChange {
        table: TABLE.into(),
        pk: pk.into(),
        seq: "1".into(),
        columns: server_columns(title, done),
        deleted: false,
    }
}

/// An engine holding `p1` (open), `p2` (shut) and `p3` (open), every one of them
/// delivered by a pull, so none of their column maps carries `id`.
async fn pulled_engine() -> SyncEngine {
    let remote = Arc::new(ScriptedRemote::new());
    remote.enqueue_pull(PullResponse {
        cursor: "1".into(),
        has_more: false,
        rows: vec![
            row_change("p1", "Alpha", false),
            row_change("p2", "Bravo", true),
            row_change(KEEP, "Charlie", false),
        ],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    });
    let engine = SyncEngine::new(
        LocalStore::open_in_memory().expect("store"),
        config(),
        remote,
        EngineDeps::default(),
    );
    engine.pull_once().await.expect("pull");
    for pk in ["p1", "p2", KEEP] {
        assert!(
            engine
                .read_row(TABLE, pk)
                .expect("read")
                .expect("pulled row")
                .columns
                .get("id")
                .is_none(),
            "{pk}: a pulled row must not carry id inside its column map"
        );
    }
    engine
}

fn update_where(filters: Vec<Filter>) -> ApplyWhere {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("targeted"));
    ApplyWhere {
        table: TABLE.into(),
        filters,
        op: Op::Update,
        columns,
        precondition: None,
        transforms: None,
        include_deleted: false,
        max_affected: None,
        returning: false,
        cardinality: None,
    }
}

fn delete_where(filters: Vec<Filter>) -> ApplyWhere {
    ApplyWhere {
        table: TABLE.into(),
        filters,
        op: Op::Delete,
        columns: Map::new(),
        precondition: None,
        transforms: None,
        include_deleted: false,
        max_affected: None,
        returning: false,
        cardinality: None,
    }
}

fn eq(column: &str, value: Value) -> Filter {
    Filter::Eq {
        column: column.into(),
        value,
    }
}

fn live_pks(engine: &SyncEngine) -> Vec<String> {
    let mut pks: Vec<String> = engine
        .read_local_rows(TABLE)
        .expect("rows")
        .into_iter()
        .map(|row| row.pk)
        .collect();
    pks.sort();
    pks
}

fn code(error: &EngineError) -> String {
    error.code()
}

// MARK: - Targeting a pulled row by id

#[tokio::test]
async fn an_in_filter_on_id_targets_pulled_rows() {
    let engine = pulled_engine().await;

    let targets = engine
        .apply_where(update_where(vec![Filter::In {
            column: "id".into(),
            values: vec![json!("p1"), json!(KEEP), json!("absent")],
        }]))
        .expect("apply_where");

    assert_eq!(targets.keys, vec!["p1".to_string(), KEEP.to_string()]);
}

#[tokio::test]
async fn an_id_filter_beside_another_filter_targets_the_pulled_row() {
    let engine = pulled_engine().await;

    let targets = engine
        .apply_where(update_where(vec![
            eq("id", json!("p1")),
            eq("done", json!(false)),
        ]))
        .expect("apply_where");

    assert_eq!(targets.keys, vec!["p1".to_string()]);

    let no_match = engine
        .apply_where(update_where(vec![
            eq("id", json!("p2")),
            eq("done", json!(false)),
        ]))
        .expect("apply_where");
    assert!(no_match.keys.is_empty(), "{no_match:?}");
}

#[tokio::test]
async fn an_or_clause_containing_an_id_targets_the_pulled_row() {
    let engine = pulled_engine().await;

    let targets = engine
        .apply_where(update_where(vec![Filter::Or {
            filters: vec![eq("id", json!("p1")), eq("title", json!("nothing"))],
        }]))
        .expect("apply_where");

    assert_eq!(targets.keys, vec!["p1".to_string()]);
}

/// The direction that loses data: an absent column satisfies `neq`, so a raw
/// column map made `neq("id", keep)` match `keep` itself and the delete took it.
#[tokio::test]
async fn a_neq_delete_on_id_spares_the_kept_row() {
    let engine = pulled_engine().await;

    let targets = engine
        .apply_where(delete_where(vec![Filter::Neq {
            column: "id".into(),
            value: json!(KEEP),
        }]))
        .expect("apply_where");

    assert_eq!(targets.keys, vec!["p1".to_string(), "p2".to_string()]);
    assert_eq!(live_pks(&engine), vec![KEEP.to_string()]);
}

// MARK: - One code per refusal

#[tokio::test]
async fn a_cardinality_miss_is_a_local_constraint() {
    let engine = pulled_engine().await;

    let many = QueryPlan {
        filters: vec![eq("done", json!(false))],
        cardinality: "single".into(),
        ..Default::default()
    };
    let error = engine
        .query(TABLE, &many)
        .expect_err("single over two rows");
    assert_eq!(code(&error), error_catalog::LOCAL_CONSTRAINT);

    let none = QueryPlan {
        filters: vec![eq("id", json!("absent"))],
        cardinality: "single".into(),
        ..Default::default()
    };
    let error = engine.query(TABLE, &none).expect_err("single over no row");
    assert_eq!(code(&error), error_catalog::LOCAL_CONSTRAINT);

    let maybe = QueryPlan {
        filters: vec![eq("done", json!(false))],
        cardinality: "maybeSingle".into(),
        ..Default::default()
    };
    let error = engine
        .query(TABLE, &maybe)
        .expect_err("maybeSingle over two rows");
    assert_eq!(code(&error), error_catalog::LOCAL_CONSTRAINT);
}

#[tokio::test]
async fn an_unfiltered_write_is_local_unsupported() {
    let engine = pulled_engine().await;

    let error = engine
        .apply_where(update_where(vec![]))
        .expect_err("unfiltered update");

    assert_eq!(code(&error), error_catalog::LOCAL_UNSUPPORTED);
    assert_eq!(live_pks(&engine), vec!["p1", "p2", KEEP]);
}

/// A node that names no rows is not a target: an empty `and`, an empty `or`
/// under a `not`, or a blank search matches every row, so a write carrying one
/// would rewrite the whole table like an unfiltered one. It is refused at any
/// depth, beside a real filter too, and nothing is written or queued.
#[tokio::test]
async fn a_filter_that_names_no_rows_is_refused_for_a_write() {
    let engine = pulled_engine().await;
    let empty_and = || Filter::And { filters: vec![] };
    let empty_or = || Filter::Or { filters: vec![] };
    let blank_search = || Filter::Search {
        query: "  ".into(),
        columns: None,
    };
    let blank_text_search = || Filter::TextSearch {
        column: "title".into(),
        query: String::new(),
        r#type: "plain".into(),
    };

    for (label, filters) in [
        ("empty and", vec![empty_and()]),
        ("empty or", vec![empty_or()]),
        (
            "not(or())",
            vec![Filter::Not {
                filter: Box::new(empty_or()),
            }],
        ),
        (
            "not(and()) beside a filter",
            vec![
                eq("done", json!(false)),
                Filter::Not {
                    filter: Box::new(empty_and()),
                },
            ],
        ),
        (
            "empty and inside or",
            vec![Filter::Or {
                filters: vec![eq("id", json!("p1")), empty_and()],
            }],
        ),
        ("blank search", vec![blank_search()]),
        ("blank textSearch", vec![blank_text_search()]),
        (
            "blank search under not",
            vec![Filter::Not {
                filter: Box::new(blank_search()),
            }],
        ),
    ] {
        for request in [update_where(filters.clone()), delete_where(filters.clone())] {
            let error = engine.apply_where(request).expect_err(label);
            assert_eq!(code(&error), error_catalog::LOCAL_UNSUPPORTED, "{label}");
        }
    }

    assert_eq!(live_pks(&engine), vec!["p1", "p2", KEEP]);
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
}

/// Reads keep the evaluator's meaning for the same nodes: an empty `and` and a
/// blank search match every row, an empty `or` matches none.
#[tokio::test]
async fn a_read_keeps_its_meaning_for_a_filter_that_names_no_rows() {
    let engine = pulled_engine().await;
    let count = |filters: Vec<Filter>| {
        let plan = QueryPlan {
            filters,
            ..Default::default()
        };
        match engine.query(TABLE, &plan).expect("query") {
            QueryResult::Many(rows) => rows.len(),
            other => panic!("expected many, got {other:?}"),
        }
    };

    assert_eq!(count(vec![Filter::And { filters: vec![] }]), 3);
    assert_eq!(count(vec![Filter::Or { filters: vec![] }]), 0);
    assert_eq!(
        count(vec![Filter::Search {
            query: String::new(),
            columns: None,
        }]),
        3
    );
}

/// The key is immutable, so an update naming `id` is refused even when it
/// repeats the pk: the server denies the column whatever its value.
#[tokio::test]
async fn an_id_column_in_an_update_is_a_local_constraint() {
    let engine = pulled_engine().await;

    let mut columns = Map::new();
    columns.insert("id".into(), json!("somewhere-else"));
    let error = engine
        .apply(LocalMutation {
            table: TABLE.into(),
            pk: "p1".into(),
            op: Op::Update,
            columns: columns.clone(),
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m-update-id".into()),
        })
        .expect_err("update carrying id");
    assert_eq!(code(&error), error_catalog::LOCAL_CONSTRAINT);

    // `apply_where` refuses the same write before it matches a row.
    let error = engine
        .apply_where(ApplyWhere {
            table: TABLE.into(),
            filters: vec![eq("id", json!("p1"))],
            op: Op::Update,
            columns,
            precondition: None,
            transforms: None,
            include_deleted: false,
            max_affected: None,
            returning: false,
            cardinality: None,
        })
        .expect_err("apply_where carrying id");
    assert_eq!(code(&error), error_catalog::LOCAL_CONSTRAINT);

    let mut repeated = Map::new();
    repeated.insert("id".into(), json!("p1"));
    repeated.insert("title".into(), json!("still p1"));
    let error = engine
        .apply(LocalMutation {
            table: TABLE.into(),
            pk: "p1".into(),
            op: Op::Update,
            columns: repeated,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m-update-same-id".into()),
        })
        .expect_err("an update repeating the id");
    assert_eq!(code(&error), error_catalog::LOCAL_CONSTRAINT);
    assert_eq!(engine.get_outbox_depth().unwrap(), 0);
}

#[tokio::test]
async fn an_insert_whose_id_contradicts_its_pk_is_a_local_constraint() {
    let engine = pulled_engine().await;

    let mut columns = server_columns("Delta", false);
    columns.insert("id".into(), json!("not-the-pk"));
    let error = engine
        .apply(LocalMutation {
            table: TABLE.into(),
            pk: "p4".into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m-insert-divergent".into()),
        })
        .expect_err("insert with a divergent id");
    assert_eq!(code(&error), error_catalog::LOCAL_CONSTRAINT);

    let mut agreeing = server_columns("Delta", false);
    agreeing.insert("id".into(), json!("p4"));
    engine
        .apply(LocalMutation {
            table: TABLE.into(),
            pk: "p4".into(),
            op: Op::Insert,
            columns: agreeing,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m-insert-agreeing".into()),
        })
        .expect("an id equal to the pk is the same identity");
}

#[tokio::test]
async fn every_construct_outside_the_local_subset_is_local_unsupported() {
    let engine = pulled_engine().await;

    let negative_limit = QueryPlan {
        limit: Some(-1),
        ..Default::default()
    };
    let bad_text_search = QueryPlan {
        filters: vec![Filter::TextSearch {
            column: "title".into(),
            query: "alpha".into(),
            r#type: "phrsae".into(),
        }],
        ..Default::default()
    };
    let embed = QueryPlan {
        projection: Some(vec!["author(name)".into()]),
        ..Default::default()
    };
    let rename = QueryPlan {
        projection: Some(vec!["title:name".into()]),
        ..Default::default()
    };
    let string_is = QueryPlan {
        filters: vec![Filter::Is {
            column: "title".into(),
            value: json!("Alpha"),
        }],
        ..Default::default()
    };

    for (label, plan) in [
        ("negative limit", negative_limit),
        ("unknown textSearch type", bad_text_search),
        ("relational embed", embed),
        ("projection rename", rename),
        ("string is operand", string_is),
    ] {
        let error = engine.query(TABLE, &plan).expect_err(label);
        assert_eq!(code(&error), error_catalog::LOCAL_UNSUPPORTED, "{label}");
    }

    // A write refuses the same constructs, through the same validation pass.
    let error = engine
        .apply_where(update_where(vec![Filter::Is {
            column: "title".into(),
            value: json!("Alpha"),
        }]))
        .expect_err("string is operand on a write");
    assert_eq!(code(&error), error_catalog::LOCAL_UNSUPPORTED);
}

/// The sort key is closed and `camelCase` on the wire, so the `snake_case`
/// spelling is a deserialization failure with the `JSON` code, never a key
/// silently dropped into the default.
#[tokio::test]
async fn an_unknown_order_key_is_a_json_fault() {
    let engine = pulled_engine().await;

    let snake = r#"{"table":"todos","plan":{"orders":[{"column":"title","nulls_first":true}]}}"#;
    let envelope: Value =
        serde_json::from_str(&kizunasync_engine::rpc::dispatch(&engine, "query", snake).await)
            .expect("envelope");
    assert_eq!(envelope["ok"], json!(false), "{envelope}");
    assert_eq!(envelope["error"]["code"], json!(error_catalog::JSON));

    let camel = r#"{"table":"todos","plan":{"orders":[{"column":"title","nullsFirst":true}]}}"#;
    let envelope: Value =
        serde_json::from_str(&kizunasync_engine::rpc::dispatch(&engine, "query", camel).await)
            .expect("envelope");
    assert_eq!(envelope["ok"], json!(true), "{envelope}");
}

/// The evaluator both paths run is one pass over one row shape: a read and a write
/// naming `id` agree on which rows they mean.
#[tokio::test]
async fn a_read_and_a_write_see_the_same_id_bearing_rows() {
    let engine = pulled_engine().await;

    let plan = QueryPlan {
        filters: vec![eq("id", json!("p1"))],
        orders: vec![OrderBy {
            column: "id".into(),
            ascending: true,
            nulls_first: None,
        }],
        ..Default::default()
    };
    let read = match engine.query(TABLE, &plan).expect("query") {
        QueryResult::Many(rows) => rows,
        other => panic!("expected many, got {other:?}"),
    };
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].get("id"), Some(&json!("p1")));

    let written = engine
        .apply_where(update_where(vec![eq("id", json!("p1"))]))
        .expect("apply_where");
    assert_eq!(written.keys, vec!["p1".to_string()]);
}

// MARK: - Affected-row cap and returned rows

fn capped(request: ApplyWhere, cap: u32) -> ApplyWhere {
    ApplyWhere {
        max_affected: Some(cap),
        ..request
    }
}

fn returning(request: ApplyWhere) -> ApplyWhere {
    ApplyWhere {
        returning: true,
        ..request
    }
}

fn titles(engine: &SyncEngine) -> Vec<Value> {
    ["p1", "p2", KEEP]
        .iter()
        .map(|pk| {
            engine
                .read_row(TABLE, pk)
                .expect("read")
                .and_then(|row| row.columns.get("title").cloned())
                .unwrap_or(Value::Null)
        })
        .collect()
}

/// `PostgREST` `max-affected` with strict handling: a write that would reach
/// more rows than its cap reaches none, and the refusal names both numbers.
#[tokio::test]
async fn a_write_past_its_cap_applies_nothing_and_names_the_count_and_the_cap() {
    let engine = pulled_engine().await;
    let open = || vec![eq("done", json!(false))];

    for request in [
        capped(update_where(open()), 1),
        capped(delete_where(open()), 1),
        capped(returning(update_where(open())), 0),
    ] {
        let cap = request.max_affected.expect("capped");
        let error = engine
            .apply_where(request)
            .expect_err("two matches past the cap");
        assert_eq!(code(&error), error_catalog::LOCAL_CONSTRAINT);
        let message = error.to_string();
        assert!(message.contains("matched 2 rows"), "{message}");
        assert!(
            message.contains(&format!("maxAffected({cap})")),
            "{message}"
        );
    }

    assert_eq!(live_pks(&engine), vec!["p1", "p2", KEEP]);
    assert_eq!(
        titles(&engine),
        [json!("Alpha"), json!("Bravo"), json!("Charlie")]
    );
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
}

#[tokio::test]
async fn a_write_within_its_cap_applies_as_usual() {
    let engine = pulled_engine().await;

    let at_cap = engine
        .apply_where(capped(update_where(vec![eq("done", json!(false))]), 2))
        .expect("two matches at a cap of two");
    assert_eq!(at_cap.keys, vec!["p1".to_string(), KEEP.to_string()]);

    let nothing = engine
        .apply_where(capped(delete_where(vec![eq("id", json!("absent"))]), 0))
        .expect("no match under a cap of zero");
    assert!(nothing.keys.is_empty(), "{nothing:?}");
    assert_eq!(live_pks(&engine), vec!["p1", "p2", KEEP]);
    assert_eq!(engine.get_outbox_depth().expect("depth"), 2);
}

fn one_row(request: ApplyWhere, cardinality: WriteCardinality) -> ApplyWhere {
    ApplyWhere {
        cardinality: Some(cardinality),
        returning: true,
        ..request
    }
}

/// A returning write that ends in `single()` or `maybeSingle()` is refused
/// before anything is written when the match count breaks the terminal, with
/// the message a read gives for the same count.
#[tokio::test]
async fn a_one_row_write_names_its_terminal_and_writes_nothing() {
    let engine = pulled_engine().await;
    let open = || vec![eq("done", json!(false))];
    let absent = || vec![eq("id", json!("absent"))];

    for (request, message) in [
        (
            one_row(update_where(open()), WriteCardinality::Single),
            "single() requires exactly one row; got 2",
        ),
        (
            one_row(delete_where(absent()), WriteCardinality::Single),
            "single() requires exactly one row; got 0",
        ),
        (
            one_row(delete_where(open()), WriteCardinality::MaybeSingle),
            "maybeSingle() requires at most one row; got 2",
        ),
    ] {
        let error = engine.apply_where(request).expect_err(message);
        assert_eq!(code(&error), error_catalog::LOCAL_CONSTRAINT, "{message}");
        assert!(error.to_string().contains(message), "{error}");
    }
    assert_eq!(live_pks(&engine), vec!["p1", "p2", KEEP]);
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);

    let none = engine
        .apply_where(one_row(
            update_where(absent()),
            WriteCardinality::MaybeSingle,
        ))
        .expect("maybeSingle over no row");
    assert_eq!(none.rows, Some(Vec::new()));
    let one = engine
        .apply_where(one_row(
            update_where(vec![eq("id", json!("p2"))]),
            WriteCardinality::Single,
        ))
        .expect("single over one row");
    assert_eq!(one.keys, vec!["p2".to_string()]);
}

/// An update answers its rows as a read reports them once the write landed:
/// with `id`, and with the new columns.
#[tokio::test]
async fn an_update_returns_the_rows_as_they_read_after_the_write() {
    let engine = pulled_engine().await;

    let applied = engine
        .apply_where(returning(update_where(vec![eq("done", json!(false))])))
        .expect("returning update");

    assert_eq!(applied.keys, vec!["p1".to_string(), KEEP.to_string()]);
    let rows = applied.rows.expect("rows were asked for");
    assert_eq!(
        Value::Array(rows.into_iter().map(Value::Object).collect()),
        json!([
            {"id":"p1","owner_id":"user-a","title":"targeted","done":false},
            {"id":KEEP,"owner_id":"user-a","title":"targeted","done":false},
        ])
    );
}

/// A delete answers its rows as they read before it, since afterwards there
/// is nothing left to read.
#[tokio::test]
async fn a_delete_returns_the_rows_as_they_read_before_it() {
    let engine = pulled_engine().await;

    let applied = engine
        .apply_where(returning(delete_where(vec![eq("done", json!(false))])))
        .expect("returning delete");

    assert_eq!(applied.keys, vec!["p1".to_string(), KEEP.to_string()]);
    let rows = applied.rows.expect("rows were asked for");
    assert_eq!(
        Value::Array(rows.into_iter().map(Value::Object).collect()),
        json!([
            {"id":"p1","owner_id":"user-a","title":"Alpha","done":false},
            {"id":KEEP,"owner_id":"user-a","title":"Charlie","done":false},
        ])
    );
    assert_eq!(live_pks(&engine), vec!["p2".to_string()]);
}

#[tokio::test]
async fn a_write_that_asks_for_no_rows_returns_only_its_keys() {
    let engine = pulled_engine().await;

    let applied = engine
        .apply_where(update_where(vec![eq("id", json!("p2"))]))
        .expect("update");

    assert_eq!(applied.keys, vec!["p2".to_string()]);
    assert_eq!(applied.rows, None);
}

/// The wire keys are `maxAffected` and `returning`: the envelope carries the
/// keys without `returning`, the rows with it, and the cap refusal's code.
#[tokio::test]
async fn the_apply_where_envelope_carries_the_cap_and_the_returned_rows() {
    let engine = pulled_engine().await;
    let call = |params: Value| {
        let engine = &engine;
        async move {
            let raw =
                kizunasync_engine::rpc::dispatch(engine, "apply_where", &params.to_string()).await;
            serde_json::from_str::<Value>(&raw).expect("envelope")
        }
    };
    let request = |extra: Value| {
        let mut params = json!({
            "table": TABLE,
            "op": "update",
            "filters": [{"kind":"eq","column":"done","value":false}],
            "columns": {"title":"wired"},
        });
        for (key, value) in extra.as_object().expect("object") {
            params[key] = value.clone();
        }
        params
    };

    let refused = call(request(json!({"maxAffected": 1}))).await;
    assert_eq!(refused["ok"], json!(false), "{refused}");
    assert_eq!(
        refused["error"]["code"],
        json!(error_catalog::LOCAL_CONSTRAINT)
    );

    let keys = call(request(json!({"maxAffected": 2}))).await;
    assert_eq!(keys["value"], json!(["p1", KEEP]), "{keys}");

    let single = call(request(json!({"returning": true, "cardinality": "single"}))).await;
    assert_eq!(single["ok"], json!(false), "{single}");
    assert_eq!(
        single["error"]["code"],
        json!(error_catalog::LOCAL_CONSTRAINT)
    );

    let rows = call(request(json!({"returning": true}))).await;
    assert_eq!(
        rows["value"],
        json!([
            {"id":"p1","owner_id":"user-a","title":"wired","done":false},
            {"id":KEEP,"owner_id":"user-a","title":"wired","done":false},
        ]),
        "{rows}"
    );
}

/// A counted read answers `{"rows", "count"}` through the envelope; an
/// uncounted one keeps the bare array.
#[tokio::test]
async fn the_query_envelope_carries_the_count_beside_the_rows() {
    let engine = pulled_engine().await;
    let query = |plan: Value| {
        let engine = &engine;
        async move {
            let params = json!({"table": TABLE, "plan": plan}).to_string();
            let raw = kizunasync_engine::rpc::dispatch(engine, "query", &params).await;
            serde_json::from_str::<Value>(&raw).expect("envelope")
        }
    };

    let counted = query(json!({"projection":["id"],"limit":1,"count":true})).await;
    assert_eq!(
        counted["value"],
        json!({"rows":[{"id":"p1"}],"count":3}),
        "{counted}"
    );

    let plain = query(json!({"projection":["id"],"limit":1})).await;
    assert_eq!(plain["value"], json!([{"id":"p1"}]), "{plain}");
}
