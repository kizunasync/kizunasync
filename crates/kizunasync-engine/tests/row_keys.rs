//! A table syncs by its own key (D-row-key): the engine derives every row's pk
//! from the key columns, mints one only for a table keyed by `id` whose row
//! names none, refuses a write that changes a key column, and reads rows with
//! the key columns the row carries.
//!
//! `seats` is keyed by the pair `(hall, seat)`, `notices` by an integer `id`,
//! `slugs` by a text column, and `todos` by the default `id`.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    ApplyWhere, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_query::{Filter, QueryPlan, QueryResult, Row, apply_query};
use kizunasync_store::{LocalMutation, LocalStore, StoreError};
use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

const SEATS: &str = "seats";
const NOTICES: &str = "notices";
const SLUGS: &str = "slugs";
const TODOS: &str = "todos";
const GRANTS: &str = "grants";
const UPPER_UUID: &str = "5F0C1C2E-8F3A-4B6D-9C1E-2A7B3C4D5E6F";
const LOWER_UUID: &str = "5f0c1c2e-8f3a-4b6d-9c1e-2a7b3c4d5e6f";
const MINTED: &str = "00000000-0000-4000-8000-00000000c0de";

fn table(key: &[&str]) -> TableConfig {
    TableConfig {
        bucket_column: String::new(),
        bucket_params: Map::new(),
        bucket_owner: false,
        attachments: BTreeMap::new(),
        soft_delete_column: None,
        sync_mode: SyncMode::ReadWrite,
        conflict_mode: ConflictMode::Arrival,
        key: key.iter().map(|column| (*column).to_string()).collect(),
    }
}

fn config() -> EngineConfig {
    let mut tables = BTreeMap::new();
    tables.insert(SEATS.into(), table(&["hall", "seat"]));
    tables.insert(NOTICES.into(), table(&["id"]));
    tables.insert(SLUGS.into(), table(&["slug"]));
    tables.insert(TODOS.into(), table(&["id"]));
    tables.insert(GRANTS.into(), table(&["tenant", "slug"]));
    EngineConfig {
        tables,
        schema_version: 1,
        default_limit: None,
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
        client_id: "c1".into(),
    }
}

/// Every uuid the engine asks for is [`MINTED`], and every mutation here pins
/// its own id, so a minted pk is recognisable.
fn engine_over(store: LocalStore) -> SyncEngine {
    SyncEngine::new(
        store,
        config(),
        Arc::new(ScriptedRemote::new()),
        EngineDeps {
            uuid: Box::new(|| MINTED.into()),
            ..EngineDeps::default()
        },
    )
}

fn engine() -> SyncEngine {
    engine_over(LocalStore::open_in_memory().unwrap())
}

fn columns(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

fn mutation(table: &str, pk: &str, op: Op, written: &Value) -> LocalMutation {
    LocalMutation {
        table: table.into(),
        pk: pk.into(),
        op,
        columns: columns(written),
        transforms: None,
        precondition: None,
        batch_id: None,
        hlc: None,
        mutation_id: Some(format!("m-{table}-{pk}-{written}")),
    }
}

fn insert(table: &str, written: &Value) -> LocalMutation {
    mutation(table, "", Op::Insert, written)
}

fn refusal_message(error: &EngineError) -> &str {
    assert_eq!(error.code(), error_catalog::LOCAL_CONSTRAINT, "{error}");
    let EngineError::LocalConstraint(message) = error else {
        panic!("not a local constraint: {error}");
    };
    message
}

fn eq(column: &str, value: Value) -> Filter {
    Filter::Eq {
        column: column.into(),
        value,
    }
}

fn filtered(filters: Vec<Filter>) -> QueryPlan {
    QueryPlan {
        filters,
        ..QueryPlan::default()
    }
}

fn rows(result: QueryResult) -> Vec<Row> {
    match result {
        QueryResult::Many(rows) => rows,
        other => panic!("expected many rows, got {other:?}"),
    }
}

// MARK: - Insert

/// The pk of a composite key is the JSON array text of its columns, and the
/// row, its outbox entry and the push all carry it.
#[test]
fn a_composite_insert_is_stored_and_queued_under_its_key_text() {
    let engine = engine();
    engine
        .apply(insert(
            SEATS,
            &json!({"hall": 1, "seat": 12, "holder": "ada"}),
        ))
        .unwrap();

    let stored = engine
        .read_row(SEATS, r#"["1", "12"]"#)
        .unwrap()
        .expect("row");
    assert_eq!(
        Value::Object(stored.columns),
        json!({"hall": 1, "seat": 12, "holder": "ada"})
    );
    let queued = engine.list_outbox(10).unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].pk, r#"["1", "12"]"#);
}

/// A single-column key is the column's own text, an integer as its decimal.
#[test]
fn a_single_key_insert_takes_the_column_text_as_its_pk() {
    let engine = engine();
    engine
        .apply(insert(NOTICES, &json!({"id": 42, "body": "doors at ten"})))
        .unwrap();
    engine
        .apply(insert(SLUGS, &json!({"slug": "hello world"})))
        .unwrap();

    assert!(engine.read_row(NOTICES, "42").unwrap().is_some());
    assert!(engine.read_row(SLUGS, "hello world").unwrap().is_some());
}

/// Every key column the insert leaves out, sets to null, or fills with
/// something other than a string or an integer is named, and nothing is stored
/// or queued.
#[test]
fn an_insert_whose_key_columns_spell_no_pk_names_them() {
    let engine = engine();

    let missing = engine
        .apply(insert(SEATS, &json!({"hall": 1, "holder": "ada"})))
        .unwrap_err();
    let message = refusal_message(&missing);
    assert!(message.contains("\"seat\""), "{message}");
    assert!(!message.contains("\"hall\""), "{message}");

    let invalid = engine
        .apply(insert(SEATS, &json!({"hall": 1.5, "seat": null})))
        .unwrap_err();
    let message = refusal_message(&invalid);
    assert!(message.contains("\"hall\""), "{message}");
    assert!(message.contains("\"seat\""), "{message}");

    for written in [json!({"id": ""}), json!({"id": null}), json!({"id": true})] {
        let refused = engine.apply(insert(NOTICES, &written)).unwrap_err();
        assert!(refusal_message(&refused).contains("\"id\""), "{written}");
    }

    assert!(engine.read_all_rows(SEATS).unwrap().is_empty());
    assert!(engine.read_all_rows(NOTICES).unwrap().is_empty());
    assert_eq!(engine.get_outbox_depth().unwrap(), 0);
}

/// A pk the caller passes is the row's identity only when the key columns
/// spell it: the key columns decide, exactly as a divergent `id` is refused.
#[test]
fn a_passed_pk_must_be_the_one_the_key_columns_spell() {
    let engine = engine();

    let divergent = engine
        .apply(mutation(
            SEATS,
            r#"["1", "13"]"#,
            Op::Insert,
            &json!({"hall": 1, "seat": 14}),
        ))
        .unwrap_err();
    refusal_message(&divergent);
    assert_eq!(engine.get_outbox_depth().unwrap(), 0);

    engine
        .apply(mutation(
            SEATS,
            r#"["1", "14"]"#,
            Op::Insert,
            &json!({"hall": 1, "seat": 14}),
        ))
        .unwrap();
    engine
        .apply(mutation(NOTICES, "7", Op::Insert, &json!({"id": 7})))
        .unwrap();
    let integer_as_text = engine
        .apply(mutation(NOTICES, "07", Op::Insert, &json!({"id": 7})))
        .unwrap_err();
    refusal_message(&integer_as_text);
}

/// A table keyed by `id` mints the pk of a row that names no `id`, and keeps a
/// passed pk as it is; every other key needs its columns.
#[test]
fn only_an_id_key_row_without_an_id_is_minted() {
    let engine = engine();
    engine
        .apply(insert(TODOS, &json!({"title": "works on a plane"})))
        .unwrap();
    engine
        .apply(mutation(TODOS, "p1", Op::Insert, &json!({"title": "kept"})))
        .unwrap();

    let stored = engine.read_row(TODOS, MINTED).unwrap().expect("minted row");
    assert_eq!(
        Value::Object(stored.columns),
        json!({"title": "works on a plane"})
    );
    assert!(engine.read_row(TODOS, "p1").unwrap().is_some());

    let unkeyed = engine
        .apply(insert(SLUGS, &json!({"title": "no slug"})))
        .unwrap_err();
    assert!(refusal_message(&unkeyed).contains("\"slug\""));
    assert!(engine.read_row(SLUGS, MINTED).unwrap().is_none());
}

// MARK: - Immutable key

/// The server answers `COLUMN_DENIED` for a key column in an update, even one
/// that repeats the stored value, so the engine refuses it before it is queued.
#[test]
fn an_update_that_names_a_key_column_is_refused() {
    let engine = engine();
    engine
        .apply(insert(
            SEATS,
            &json!({"hall": 1, "seat": 12, "holder": "ada"}),
        ))
        .unwrap();
    engine
        .apply(mutation(TODOS, "p1", Op::Insert, &json!({"title": "x"})))
        .unwrap();
    let depth = engine.get_outbox_depth().unwrap();
    let pk = r#"["1", "12"]"#;

    for written in [json!({"seat": 12}), json!({"hall": 2, "holder": "grace"})] {
        let refused = engine
            .apply(mutation(SEATS, pk, Op::Update, &written))
            .unwrap_err();
        refusal_message(&refused);
    }
    let same_id = engine
        .apply(mutation(TODOS, "p1", Op::Update, &json!({"id": "p1"})))
        .unwrap_err();
    assert!(refusal_message(&same_id).contains("\"id\""));

    let mut transformed = mutation(SEATS, pk, Op::Update, &json!({"holder": "grace"}));
    transformed.transforms = Some(columns(&json!({"seat": {"op": "increment", "by": "1"}})));
    let refused = engine.apply(transformed).unwrap_err();
    assert!(refusal_message(&refused).contains("\"seat\""));

    assert_eq!(engine.get_outbox_depth().unwrap(), depth);
    assert_eq!(
        engine.read_row(SEATS, pk).unwrap().expect("row").columns["holder"],
        json!("ada")
    );

    engine
        .apply(mutation(SEATS, pk, Op::Update, &json!({"holder": "grace"})))
        .unwrap();
    engine
        .apply(mutation(SEATS, pk, Op::Delete, &json!({})))
        .unwrap();
}

/// A filter-targeted update naming a key column is refused whatever the
/// filters match, none included, so the answer never depends on local rows.
#[test]
fn a_targeted_update_that_names_a_key_column_is_refused() {
    let engine = engine();
    engine
        .apply(insert(
            SEATS,
            &json!({"hall": 1, "seat": 12, "holder": "ada"}),
        ))
        .unwrap();
    let depth = engine.get_outbox_depth().unwrap();

    for holder in ["ada", "nobody"] {
        let refused = engine
            .apply_where(ApplyWhere {
                table: SEATS.into(),
                filters: vec![eq("holder", json!(holder))],
                op: Op::Update,
                columns: columns(&json!({"seat": 13})),
                transforms: None,
                precondition: None,
                include_deleted: false,
                max_affected: None,
                returning: false,
                cardinality: None,
            })
            .unwrap_err();
        assert!(refusal_message(&refused).contains("\"seat\""), "{holder}");
    }
    assert_eq!(engine.get_outbox_depth().unwrap(), depth);
}

// MARK: - Reads

/// A read reports the key columns the row carries, an integer as an integer;
/// only a lone key column the row lacks is filled from the pk, and a composite
/// key adds nothing.
#[test]
fn a_read_keeps_the_row_key_columns_and_fills_only_a_missing_lone_one() {
    let store = LocalStore::open_in_memory().unwrap();
    store
        .put_server_row(NOTICES, "7", &columns(&json!({"id": 7, "body": "b"})), "1")
        .unwrap();
    store
        .put_server_row(TODOS, "p1", &columns(&json!({"title": "no id"})), "2")
        .unwrap();
    store
        .put_server_row(
            SEATS,
            r#"["1", "12"]"#,
            &columns(&json!({"hall": 1, "seat": 12})),
            "3",
        )
        .unwrap();
    let engine = engine_over(store);

    assert_eq!(
        engine.read_all_rows(NOTICES).unwrap(),
        [columns(&json!({"id": 7, "body": "b"}))]
    );
    assert_eq!(
        engine.read_all_rows(TODOS).unwrap(),
        [columns(&json!({"id": "p1", "title": "no id"}))]
    );
    assert_eq!(
        engine.read_all_rows(SEATS).unwrap(),
        [columns(&json!({"hall": 1, "seat": 12}))]
    );
    assert_eq!(
        rows(
            engine
                .query(SEATS, &filtered(vec![eq("seat", json!(12))]))
                .unwrap()
        ),
        [columns(&json!({"hall": 1, "seat": 12}))]
    );
}

// MARK: - Read paths

/// A file store holding readable rows beside one whose stored JSON does not
/// decode, so a read that reaches it fails.
struct Broken {
    _dir: tempfile::TempDir,
    engine: SyncEngine,
}

fn broken(table: &str, readable: &[(&str, Value)], unreadable: &str) -> Broken {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = LocalStore::open_path(&path).unwrap();
    for (pk, written) in readable {
        store
            .put_server_row(table, pk, &columns(written), "1")
            .unwrap();
    }
    write_unreadable_row(&path, table, unreadable);
    Broken {
        _dir: dir,
        engine: engine_over(store),
    }
}

fn write_unreadable_row(path: &Path, table: &str, pk: &str) {
    Connection::open(path)
        .unwrap()
        .execute(
            "INSERT INTO _kizunasync_rows(table_name, pk, row_json, deleted, updated_seq)
             VALUES (?1, ?2, '{not json', 0, '0')",
            params![table, pk],
        )
        .unwrap();
}

fn reached_the_broken_row(result: &Result<QueryResult, EngineError>) -> bool {
    matches!(result, Err(EngineError::Store(StoreError::Json(_))))
}

/// An `eq` or `in` on the one column of a single-column key reads only the
/// rows it names, whatever the column is called.
#[test]
fn a_lone_key_column_lookup_reads_only_the_rows_it_names() {
    let fixture = broken(
        SLUGS,
        &[("a", json!({"slug": "a"})), ("b", json!({"slug": "b"}))],
        "zz",
    );
    let engine = &fixture.engine;

    assert!(reached_the_broken_row(
        &engine.query(SLUGS, &filtered(vec![eq("title", json!("x"))]))
    ));
    assert_eq!(
        rows(
            engine
                .query(SLUGS, &filtered(vec![eq("slug", json!("b"))]))
                .unwrap()
        ),
        [columns(&json!({"slug": "b"}))]
    );
    let listed = Filter::In {
        column: "slug".into(),
        values: vec![json!("b"), json!("a"), json!("gone")],
    };
    assert_eq!(
        rows(engine.query(SLUGS, &filtered(vec![listed])).unwrap()).len(),
        2
    );
}

/// A composite key has no single column a filter names it by, so even an
/// `eq` on every key column reads the whole table, and `id` is an ordinary
/// column there.
#[test]
fn a_composite_key_lookup_takes_the_full_path() {
    let fixture = broken(
        SEATS,
        &[(r#"["1", "12"]"#, json!({"hall": 1, "seat": 12}))],
        r#"["9", "9"]"#,
    );
    let engine = &fixture.engine;

    let both = vec![eq("hall", json!(1)), eq("seat", json!(12))];
    assert!(reached_the_broken_row(
        &engine.query(SEATS, &filtered(both))
    ));
    assert!(reached_the_broken_row(&engine.query(
        SEATS,
        &filtered(vec![eq("id", json!(r#"["1", "12"]"#))])
    )));
}

fn is_in(column: &str, values: Vec<Value>) -> Filter {
    Filter::In {
        column: column.into(),
        values,
    }
}

fn target(table: &str, filters: Vec<Filter>) -> ApplyWhere {
    ApplyWhere {
        table: table.into(),
        filters,
        op: Op::Update,
        columns: columns(&json!({"body": "moved", "holder": "grace"})),
        transforms: None,
        precondition: None,
        include_deleted: false,
        max_affected: None,
        returning: false,
        cardinality: None,
    }
}

/// An `eq` or `in` on an integer key names rows by their decimal pk, and an
/// operand whose f64 comparison could equal another integer, a float or an
/// integer from 2^53 on, takes the full scan instead.
#[test]
fn an_integer_key_lookup_reads_only_the_rows_it_names() {
    let fixture = broken(
        NOTICES,
        &[("7", json!({"id": 7})), ("10", json!({"id": 10}))],
        "zz",
    );
    let engine = &fixture.engine;

    assert_eq!(
        rows(
            engine
                .query(NOTICES, &filtered(vec![eq("id", json!(7))]))
                .unwrap()
        ),
        [columns(&json!({"id": 7}))]
    );
    let listed = is_in(
        "id",
        vec![json!(10), json!(7), json!("7"), Value::Null, json!(true)],
    );
    assert_eq!(
        rows(engine.query(NOTICES, &filtered(vec![listed])).unwrap()),
        [columns(&json!({"id": 10})), columns(&json!({"id": 7}))],
        "the named rows come back in pk order, and the text \"7\" equals no integer"
    );

    for unbounded in [json!(7.0), json!(9_007_199_254_740_992_i64)] {
        assert!(
            reached_the_broken_row(
                &engine.query(NOTICES, &filtered(vec![eq("id", unbounded.clone())]))
            ),
            "{unbounded}"
        );
    }
}

/// Whichever path a lookup takes, it answers what the evaluator answers over
/// the whole table, the integers f64 cannot tell apart included.
#[test]
fn an_integer_key_lookup_answers_what_the_whole_table_answers() {
    let store = LocalStore::open_in_memory().unwrap();
    for id in [7_u64, 9_007_199_254_740_992, 9_007_199_254_740_993] {
        store
            .put_server_row(NOTICES, &id.to_string(), &columns(&json!({"id": id})), "1")
            .unwrap();
    }
    let engine = engine_over(store);
    let table = engine.read_all_rows(NOTICES).unwrap();

    for filter in [
        eq("id", json!(7)),
        eq("id", json!(7.0)),
        eq("id", json!("7")),
        eq("id", json!(-1)),
        eq("id", json!(9_007_199_254_740_992_u64)),
        eq("id", json!(9_007_199_254_740_993_u64)),
        is_in("id", vec![json!(7), json!(9_007_199_254_740_993_u64)]),
    ] {
        let plan = filtered(vec![filter.clone()]);
        assert_eq!(
            engine.query(NOTICES, &plan).unwrap(),
            apply_query(table.clone(), &plan).unwrap(),
            "{filter:?}"
        );
    }
}

/// A row inserted under an integer key reads back, and is targeted, by that
/// integer.
#[test]
fn an_integer_key_insert_reads_back_by_its_key() {
    let engine = engine();
    engine
        .apply(insert(NOTICES, &json!({"id": 42, "body": "doors at ten"})))
        .unwrap();

    let single = QueryPlan {
        cardinality: "single".into(),
        ..filtered(vec![eq("id", json!(42))])
    };
    assert_eq!(
        engine.query(NOTICES, &single).unwrap(),
        QueryResult::One(columns(&json!({"id": 42, "body": "doors at ten"})))
    );
    let applied = engine
        .apply_where(target(NOTICES, vec![is_in("id", vec![json!(42)])]))
        .unwrap();
    assert_eq!(applied.keys, ["42"]);
}

/// A row inserted under a composite key reads back, and is targeted, by its
/// key columns.
#[test]
fn a_composite_key_insert_reads_back_by_its_key_columns() {
    let engine = engine();
    engine
        .apply(insert(
            SEATS,
            &json!({"hall": 1, "seat": 12, "holder": "ada"}),
        ))
        .unwrap();
    engine
        .apply(insert(
            SEATS,
            &json!({"hall": 2, "seat": 12, "holder": "linus"}),
        ))
        .unwrap();

    let seat = vec![eq("hall", json!(1)), eq("seat", json!(12))];
    assert_eq!(
        rows(engine.query(SEATS, &filtered(seat.clone())).unwrap()),
        [columns(&json!({"hall": 1, "seat": 12, "holder": "ada"}))]
    );
    let row_of_hall_two = vec![
        eq("hall", json!(2)),
        is_in("seat", vec![json!(12), json!(13)]),
    ];
    assert_eq!(
        rows(engine.query(SEATS, &filtered(row_of_hall_two)).unwrap()),
        [columns(&json!({"hall": 2, "seat": 12, "holder": "linus"}))]
    );
    let applied = engine.apply_where(target(SEATS, seat)).unwrap();
    assert_eq!(applied.keys, [r#"["1", "12"]"#]);
}

// MARK: - Uuid keys

/// The server keeps a uuid in lowercase, so a uuid-shaped key value in any
/// case is lowercased before the pk is derived: the stored row, the queued
/// write and the push all carry the lowercase form, and a column outside the
/// key keeps what the app wrote.
#[tokio::test]
async fn an_uppercase_uuid_key_is_stored_queued_and_pushed_in_lowercase() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = SyncEngine::new(
        LocalStore::open_in_memory().unwrap(),
        config(),
        remote.clone(),
        EngineDeps::default(),
    );
    engine
        .apply(insert(
            TODOS,
            &json!({"id": UPPER_UUID, "note": UPPER_UUID}),
        ))
        .unwrap();
    engine
        .apply(insert(
            GRANTS,
            &json!({"tenant": UPPER_UUID, "slug": "Mixed-Case"}),
        ))
        .unwrap();

    let todo = engine.read_row(TODOS, LOWER_UUID).unwrap().expect("todo");
    assert_eq!(
        Value::Object(todo.columns),
        json!({"id": LOWER_UUID, "note": UPPER_UUID})
    );
    let grant_pk = format!(r#"["{LOWER_UUID}", "Mixed-Case"]"#);
    let grant = engine.read_row(GRANTS, &grant_pk).unwrap().expect("grant");
    assert_eq!(
        Value::Object(grant.columns),
        json!({"tenant": LOWER_UUID, "slug": "Mixed-Case"})
    );

    engine.push_once().await.unwrap();
    let pushed = remote.last_push.lock().unwrap().clone().expect("a push");
    let sent: Vec<(String, Value)> = pushed
        .batch
        .mutations
        .iter()
        .map(|mutation| (mutation.pk.clone(), Value::Object(mutation.columns.clone())))
        .collect();
    assert_eq!(
        sent,
        [
            (
                LOWER_UUID.to_string(),
                json!({"id": LOWER_UUID, "note": UPPER_UUID})
            ),
            (
                grant_pk,
                json!({"tenant": LOWER_UUID, "slug": "Mixed-Case"})
            ),
        ]
    );
    assert_eq!(engine.get_outbox_depth().unwrap(), 0);
}

/// Every pk the engine is handed is lowercased the same way: one it mints from
/// an uppercase uuid source, one the caller mints, one passed beside key
/// columns, and the pk an update or a delete targets.
#[test]
fn every_uuid_shaped_pk_the_engine_sees_is_lowercased() {
    let engine = SyncEngine::new(
        LocalStore::open_in_memory().unwrap(),
        config(),
        Arc::new(ScriptedRemote::new()),
        EngineDeps {
            uuid: Box::new(|| UPPER_UUID.into()),
            ..EngineDeps::default()
        },
    );
    engine
        .apply(insert(TODOS, &json!({"title": "minted by the engine"})))
        .unwrap();
    assert_eq!(
        engine.read_all_rows(TODOS).unwrap(),
        [columns(
            &json!({"id": LOWER_UUID, "title": "minted by the engine"})
        )]
    );

    let other_upper = "ABCDEF01-2345-4789-ABCD-EF0123456789";
    let other_lower = "abcdef01-2345-4789-abcd-ef0123456789";
    engine
        .apply(mutation(
            TODOS,
            other_upper,
            Op::Insert,
            &json!({"title": "minted by the host"}),
        ))
        .unwrap();
    assert!(engine.read_row(TODOS, other_lower).unwrap().is_some());

    let third_upper = "0123ABCD-0000-4000-8000-00000000C0DE";
    engine
        .apply(mutation(
            TODOS,
            third_upper,
            Op::Insert,
            &json!({"id": third_upper}),
        ))
        .unwrap();
    assert!(
        engine
            .read_row(TODOS, &third_upper.to_ascii_lowercase())
            .unwrap()
            .is_some()
    );

    let grant = format!(r#"["{UPPER_UUID}", "Mixed-Case"]"#);
    engine
        .apply(mutation(
            GRANTS,
            &grant,
            Op::Insert,
            &json!({"tenant": UPPER_UUID, "slug": "Mixed-Case"}),
        ))
        .unwrap();
    assert!(
        engine
            .read_row(GRANTS, &format!(r#"["{LOWER_UUID}", "Mixed-Case"]"#))
            .unwrap()
            .is_some()
    );

    engine
        .apply(mutation(
            TODOS,
            UPPER_UUID,
            Op::Update,
            &json!({"title": "renamed"}),
        ))
        .unwrap();
    engine
        .apply(mutation(TODOS, other_upper, Op::Delete, &json!({})))
        .unwrap();
    assert_eq!(
        engine
            .read_row(TODOS, LOWER_UUID)
            .unwrap()
            .expect("row")
            .columns["title"],
        json!("renamed")
    );
    assert!(engine.read_row(TODOS, other_lower).unwrap().is_none());

    let queued: Vec<String> = engine
        .list_outbox(10)
        .unwrap()
        .into_iter()
        .map(|entry| entry.pk)
        .collect();
    assert_eq!(
        queued,
        [
            LOWER_UUID.to_string(),
            other_lower.to_string(),
            third_upper.to_ascii_lowercase(),
            format!(r#"["{LOWER_UUID}", "Mixed-Case"]"#),
            LOWER_UUID.to_string(),
            other_lower.to_string(),
        ]
    );
}

/// A uuid-shaped operand of an `eq`, `neq` or `in` on a key column is
/// lowercased before the filter is evaluated, on the key path and on the full
/// path alike, so a caller spelling a uuid key in uppercase names the row the
/// engine stored under the lowercase form. A column outside the key compares
/// what the app wrote.
#[test]
fn a_uuid_operand_on_a_key_column_is_lowercased_before_evaluation() {
    let engine = engine();
    let other = "abcdef01-2345-4789-abcd-ef0123456789";
    engine
        .apply(insert(
            TODOS,
            &json!({"id": UPPER_UUID, "note": UPPER_UUID}),
        ))
        .unwrap();
    engine
        .apply(insert(TODOS, &json!({"id": other, "note": "plain"})))
        .unwrap();
    engine
        .apply(insert(GRANTS, &json!({"tenant": UPPER_UUID, "slug": "a"})))
        .unwrap();

    let ids = |table: &str, filters: Vec<Filter>| -> Vec<Value> {
        rows(engine.query(table, &filtered(filters)).unwrap())
            .into_iter()
            .map(|row| row.get("id").or_else(|| row.get("slug")).cloned().unwrap())
            .collect()
    };
    assert_eq!(
        ids(TODOS, vec![eq("id", json!(UPPER_UUID))]),
        [json!(LOWER_UUID)]
    );
    assert_eq!(
        ids(
            TODOS,
            vec![is_in("id", vec![json!(UPPER_UUID), json!("missing")])]
        ),
        [json!(LOWER_UUID)]
    );
    assert_eq!(
        ids(
            TODOS,
            vec![Filter::Neq {
                column: "id".into(),
                value: json!(UPPER_UUID)
            }]
        ),
        [json!(other)]
    );
    let either = Filter::Or {
        filters: vec![eq("id", json!(UPPER_UUID))],
    };
    assert_eq!(ids(TODOS, vec![either]), [json!(LOWER_UUID)]);
    let negated = Filter::Not {
        filter: Box::new(Filter::Neq {
            column: "id".into(),
            value: json!(UPPER_UUID),
        }),
    };
    assert_eq!(ids(TODOS, vec![negated]), [json!(LOWER_UUID)]);
    assert_eq!(
        ids(GRANTS, vec![eq("tenant", json!(UPPER_UUID))]),
        [json!("a")]
    );

    assert_eq!(
        ids(TODOS, vec![eq("note", json!(UPPER_UUID))]),
        [json!(LOWER_UUID)]
    );
    assert!(ids(TODOS, vec![eq("note", json!(LOWER_UUID))]).is_empty());

    let applied = engine
        .apply_where(target(TODOS, vec![eq("id", json!(UPPER_UUID))]))
        .unwrap();
    assert_eq!(applied.keys, [LOWER_UUID]);
}

/// The lowercased operand still takes the key path: an unreadable row beside
/// the named one is never reached.
#[test]
fn an_uppercase_uuid_key_lookup_reads_only_the_row_it_names() {
    let fixture = broken(TODOS, &[(LOWER_UUID, json!({"title": "x"}))], "zz");

    assert_eq!(
        rows(
            fixture
                .engine
                .query(TODOS, &filtered(vec![eq("id", json!(UPPER_UUID))]))
                .unwrap()
        ),
        [columns(&json!({"id": LOWER_UUID, "title": "x"}))]
    );
}
