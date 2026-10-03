//! The local read and the filter-targeted write take a short path when the plan
//! allows one, and every short path answers what the full evaluation answers.
//!
//! An `eq` or `in` on `id`, at the root or inside a root `and`, reads only the
//! rows it names. A read with no `orders` and a `limit` or a one-row cardinality
//! stops once it holds enough matches; `single` and `maybeSingle` read on until a
//! second match. The first half proves the short paths leave every other row
//! unread: a row whose stored JSON does not decode fails any read that reaches
//! it. The second half replays seeded random tables and plans through `query`
//! and `apply_where` and compares every answer with `apply_query`, the oracle,
//! over the whole table.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::{
    ApplyWhere, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_query::{
    Filter, OrderBy, QueryError, QueryPlan, QueryResult, Row, apply_query, matches_filter,
};
use kizunasync_store::{LocalStore, StoreError};
use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

const TABLE: &str = "items";
const SOFT_DELETE: &str = "deleted_at";

fn config(soft_delete: bool) -> EngineConfig {
    let mut params = Map::new();
    params.insert("user_id".into(), json!("u1"));
    let mut tables = BTreeMap::new();
    tables.insert(
        TABLE.into(),
        TableConfig {
            bucket_column: "user_id".into(),
            bucket_params: params,
            bucket_owner: false,
            attachments: BTreeMap::new(),
            soft_delete_column: soft_delete.then(|| SOFT_DELETE.to_string()),
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

fn engine_over(store: LocalStore, soft_delete: bool) -> SyncEngine {
    SyncEngine::new(
        store,
        config(soft_delete),
        Arc::new(ScriptedRemote::new()),
        EngineDeps::default(),
    )
}

fn seed(store: &LocalStore, rows: &[(String, Map<String, Value>)]) {
    for (pk, columns) in rows {
        store.put_server_row(TABLE, pk, columns, "1").unwrap();
    }
}

fn eq(column: &str, value: Value) -> Filter {
    Filter::Eq {
        column: column.into(),
        value,
    }
}

fn is_in(column: &str, values: Vec<Value>) -> Filter {
    Filter::In {
        column: column.into(),
        values,
    }
}

fn filtered(filters: Vec<Filter>) -> QueryPlan {
    QueryPlan {
        filters,
        ..QueryPlan::default()
    }
}

fn id_of(row: &Row) -> String {
    row.get("id")
        .and_then(Value::as_str)
        .unwrap_or("<missing id>")
        .to_string()
}

fn ids(result: &QueryResult) -> Vec<String> {
    match result {
        QueryResult::Many(rows) => rows.iter().map(id_of).collect(),
        QueryResult::One(row) => vec![id_of(row)],
        QueryResult::Maybe(row) => row.iter().map(id_of).collect(),
        QueryResult::Counted { rows, .. } => ids(rows),
    }
}

// MARK: - Short paths read no other row

/// A file-backed engine over three live rows, beside rows whose stored JSON
/// does not decode, so a read that reaches one of them fails.
struct Broken {
    _dir: tempfile::TempDir,
    engine: SyncEngine,
}

fn columns(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

/// `p1` and `p2` are open, `p3` is done; with `soft_delete`, `p1` is marked.
fn broken(unreadable: &[&str], soft_delete: bool) -> Broken {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = LocalStore::open_path(&path).unwrap();
    let marked = if soft_delete {
        json!("2024-01-01T00:00:00.000Z")
    } else {
        Value::Null
    };
    seed(
        &store,
        &[
            (
                "p1".into(),
                columns(
                    &json!({"user_id":"u1","title":"alpha","rank":1,"done":false,"deleted_at":marked}),
                ),
            ),
            (
                "p2".into(),
                columns(&json!({"user_id":"u1","title":"beta","rank":2,"done":false})),
            ),
            (
                "p3".into(),
                columns(&json!({"user_id":"u1","title":"gamma","rank":3,"done":true})),
            ),
        ],
    );
    for pk in unreadable {
        write_unreadable_row(&path, pk);
    }
    Broken {
        _dir: dir,
        engine: engine_over(store, soft_delete),
    }
}

fn write_unreadable_row(path: &Path, pk: &str) {
    Connection::open(path)
        .unwrap()
        .execute(
            "INSERT INTO _kizunasync_rows(table_name, pk, row_json, deleted, updated_seq)
             VALUES (?1, ?2, '{not json', 0, '0')",
            params![TABLE, pk],
        )
        .unwrap();
}

fn assert_reached_the_broken_row(result: &Result<QueryResult, EngineError>) {
    assert!(
        matches!(result, Err(EngineError::Store(StoreError::Json(_)))),
        "expected the read to reach the unreadable row, got {result:?}"
    );
}

/// The control every other test here leans on: a read with no short path
/// reaches the unreadable rows.
#[test]
fn a_read_without_a_short_path_reaches_every_row() {
    let fixture = broken(&["p0", "p9"], false);
    let engine = &fixture.engine;

    assert_reached_the_broken_row(
        &engine.query(TABLE, &filtered(vec![eq("title", json!("beta"))])),
    );
    let ordered = QueryPlan {
        orders: vec![OrderBy {
            column: "rank".into(),
            ascending: true,
            nulls_first: None,
        }],
        limit: Some(1),
        ..QueryPlan::default()
    };
    assert_reached_the_broken_row(&engine.query(TABLE, &ordered));
    let either = Filter::Or {
        filters: vec![eq("id", json!("p2")), eq("id", json!("p3"))],
    };
    assert_reached_the_broken_row(&engine.query(TABLE, &filtered(vec![either])));
}

#[test]
fn an_id_lookup_reads_only_the_rows_it_names() {
    let fixture = broken(&["p0", "p9"], false);
    let engine = &fixture.engine;

    let one = engine
        .query(TABLE, &filtered(vec![eq("id", json!("p2"))]))
        .unwrap();
    assert_eq!(ids(&one), ["p2"]);

    let listed = is_in(
        "id",
        vec![
            json!("p3"),
            json!("p1"),
            json!("nope"),
            json!(7),
            Value::Null,
        ],
    );
    assert_eq!(
        ids(&engine.query(TABLE, &filtered(vec![listed])).unwrap()),
        ["p1", "p3"],
        "the named rows come back in pk order"
    );

    let beside = vec![eq("done", json!(false)), eq("id", json!("p1"))];
    assert_eq!(
        ids(&engine.query(TABLE, &filtered(beside)).unwrap()),
        ["p1"]
    );

    let nested = Filter::And {
        filters: vec![
            Filter::Gte {
                column: "rank".into(),
                value: json!(2),
            },
            Filter::And {
                filters: vec![is_in("id", vec![json!("p1"), json!("p2"), json!("p3")])],
            },
        ],
    };
    assert_eq!(
        ids(&engine.query(TABLE, &filtered(vec![nested])).unwrap()),
        ["p2", "p3"]
    );

    let single = QueryPlan {
        filters: vec![eq("id", json!("p3"))],
        cardinality: "single".into(),
        ..QueryPlan::default()
    };
    assert_eq!(ids(&engine.query(TABLE, &single).unwrap()), ["p3"]);

    let missing = engine
        .query(TABLE, &filtered(vec![eq("id", json!("p5"))]))
        .unwrap();
    assert_eq!(ids(&missing), Vec::<String>::new());
}

#[test]
fn a_limited_read_without_an_order_stops_at_the_limit() {
    let fixture = broken(&["p9"], false);
    let engine = &fixture.engine;

    let first_two = QueryPlan {
        limit: Some(2),
        ..QueryPlan::default()
    };
    assert_eq!(ids(&engine.query(TABLE, &first_two).unwrap()), ["p1", "p2"]);

    let open = QueryPlan {
        filters: vec![eq("done", json!(false))],
        limit: Some(2),
        projection: Some(vec!["id".into(), "title".into()]),
        ..QueryPlan::default()
    };
    let result = engine.query(TABLE, &open).unwrap();
    assert_eq!(ids(&result), ["p1", "p2"]);
    let QueryResult::Many(rows) = result else {
        panic!("expected many");
    };
    assert_eq!(
        rows[0],
        columns(&json!({"id":"p1","title":"alpha"})),
        "the projection still applies"
    );

    let none = QueryPlan {
        limit: Some(0),
        ..QueryPlan::default()
    };
    assert_eq!(
        ids(&engine.query(TABLE, &none).unwrap()),
        Vec::<String>::new()
    );

    let first_open = QueryPlan {
        filters: vec![eq("done", json!(false))],
        limit: Some(1),
        cardinality: "single".into(),
        ..QueryPlan::default()
    };
    assert_eq!(ids(&engine.query(TABLE, &first_open).unwrap()), ["p1"]);
}

/// The rows an offset skips are matches the read must hold before the window
/// it answers with even starts.
#[test]
fn an_offset_read_without_an_order_stops_after_the_rows_it_skips() {
    let fixture = broken(&["p9"], false);
    let engine = &fixture.engine;

    let second = QueryPlan {
        offset: Some(1),
        limit: Some(1),
        ..QueryPlan::default()
    };
    assert_eq!(ids(&engine.query(TABLE, &second).unwrap()), ["p2"]);

    let last_two = QueryPlan {
        offset: Some(1),
        limit: Some(2),
        ..QueryPlan::default()
    };
    assert_eq!(ids(&engine.query(TABLE, &last_two).unwrap()), ["p2", "p3"]);

    let third = QueryPlan {
        offset: Some(2),
        limit: Some(1),
        cardinality: "single".into(),
        ..QueryPlan::default()
    };
    assert_eq!(ids(&engine.query(TABLE, &third).unwrap()), ["p3"]);

    let past_the_offset = QueryPlan {
        offset: Some(1),
        cardinality: "single".into(),
        ..QueryPlan::default()
    };
    assert!(matches!(
        engine.query(TABLE, &past_the_offset),
        Err(EngineError::Query(QueryError::SingleCardinality(2)))
    ));

    let fourth = QueryPlan {
        offset: Some(3),
        limit: Some(1),
        ..QueryPlan::default()
    };
    assert_reached_the_broken_row(&engine.query(TABLE, &fourth));
}

#[test]
fn a_one_row_read_reads_on_until_a_second_match() {
    let fixture = broken(&["p9"], false);
    let engine = &fixture.engine;

    for cardinality in ["single", "maybeSingle"] {
        let two_open = QueryPlan {
            filters: vec![eq("done", json!(false))],
            cardinality: cardinality.into(),
            ..QueryPlan::default()
        };
        let error = engine.query(TABLE, &two_open).unwrap_err();
        assert!(
            matches!(
                error,
                EngineError::Query(
                    QueryError::SingleCardinality(2) | QueryError::MaybeSingleCardinality(2)
                )
            ),
            "{cardinality}: the second match decides the answer, got {error:?}"
        );

        let one_done = QueryPlan {
            filters: vec![eq("done", json!(true))],
            cardinality: cardinality.into(),
            ..QueryPlan::default()
        };
        assert_reached_the_broken_row(&engine.query(TABLE, &one_done));
    }
}

#[test]
fn a_short_path_hides_a_marked_row_row_by_row() {
    let fixture = broken(&["p0", "p9"], true);
    let engine = &fixture.engine;

    let marked = filtered(vec![eq("id", json!("p1"))]);
    assert_eq!(
        ids(&engine.query(TABLE, &marked).unwrap()),
        Vec::<String>::new()
    );
    let with_marked = QueryPlan {
        include_deleted: true,
        ..marked
    };
    assert_eq!(ids(&engine.query(TABLE, &with_marked).unwrap()), ["p1"]);

    let fixture = broken(&["p9"], true);
    let engine = &fixture.engine;
    let first = QueryPlan {
        limit: Some(1),
        ..QueryPlan::default()
    };
    assert_eq!(ids(&engine.query(TABLE, &first).unwrap()), ["p2"]);
    let first_of_all = QueryPlan {
        include_deleted: true,
        ..first
    };
    assert_eq!(ids(&engine.query(TABLE, &first_of_all).unwrap()), ["p1"]);
}

fn touch_where(filters: Vec<Filter>, include_deleted: bool) -> ApplyWhere {
    let mut columns = Map::new();
    columns.insert("touched".into(), json!(true));
    ApplyWhere {
        table: TABLE.into(),
        filters,
        op: Op::Update,
        columns,
        precondition: None,
        transforms: None,
        include_deleted,
        max_affected: None,
        returning: false,
        cardinality: None,
    }
}

/// A counted read needs every match, so it walks past the point where the
/// same plan without `count` stops, and still answers only its page.
#[test]
fn a_counted_read_reaches_every_row_and_counts_past_its_page() {
    let fixture = broken(&["p9"], false);
    let engine = &fixture.engine;
    let first = QueryPlan {
        limit: Some(1),
        ..QueryPlan::default()
    };
    assert_eq!(ids(&engine.query(TABLE, &first).unwrap()), ["p1"]);
    assert_reached_the_broken_row(&engine.query(
        TABLE,
        &QueryPlan {
            count: true,
            ..first.clone()
        },
    ));

    let fixture = broken(&[], false);
    let engine = &fixture.engine;
    let counted = QueryPlan {
        filters: vec![eq("done", json!(false))],
        offset: Some(1),
        count: true,
        ..first
    };
    assert_eq!(
        engine.query(TABLE, &counted).unwrap(),
        QueryResult::Counted {
            rows: Box::new(QueryResult::Many(vec![columns(
                &json!({"id":"p2","user_id":"u1","title":"beta","rank":2,"done":false})
            )])),
            count: 2,
        }
    );
}

#[test]
fn an_id_targeted_write_reads_only_the_rows_it_names() {
    let fixture = broken(&["p0", "p9"], false);
    let engine = &fixture.engine;

    let one = engine
        .apply_where(touch_where(vec![eq("id", json!("p2"))], false))
        .unwrap();
    assert_eq!(one.keys, ["p2"]);

    let listed = Filter::And {
        filters: vec![
            is_in("id", vec![json!("p3"), json!("p1")]),
            eq("done", json!(false)),
        ],
    };
    assert_eq!(
        engine
            .apply_where(touch_where(vec![listed], false))
            .unwrap()
            .keys,
        ["p1"]
    );

    let unfiltered_scan = engine.apply_where(touch_where(vec![eq("done", json!(true))], false));
    assert!(
        matches!(
            unfiltered_scan,
            Err(EngineError::Store(StoreError::Json(_)))
        ),
        "a write without an id conjunct scans the table, got {unfiltered_scan:?}"
    );
}

// MARK: - Every short path answers what the oracle answers

/// `SplitMix64`: a fixed seed replays the same tables and plans on every run.
struct Seeded(u64);

impl Seeded {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(bound).unwrap()).unwrap()
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn pick<T: Clone>(&mut self, items: &[T]) -> T {
        items[self.below(items.len())].clone()
    }
}

/// Byte order and the `SQLite` binary collation agree on these, including the
/// uppercase, digit-suffixed and multi-byte keys.
const PKS: [&str; 15] = [
    "a", "b", "c", "d", "e", "f", "A", "B", "a1", "a10", "a2", "z", "é", "ü", "日本",
];
const COLUMNS: [&str; 5] = ["rank", "title", "done", "nope", "id"];
const PATTERNS: [&str; 6] = ["a%", "%a%", "_eta", "%", "A%", "2"];
const REGEXES: [&str; 6] = ["^a", "a", "eta$", "^[0-9]+$", "(?:alpha|gamma)", "é|本"];

fn cell_values(column: &str) -> Vec<Value> {
    match column {
        "rank" => vec![
            json!(-1),
            json!(0),
            json!(1),
            json!(2),
            json!(2.0),
            json!(2.5),
            json!("2"),
            Value::Null,
        ],
        "title" => vec![
            json!("alpha"),
            json!("Beta"),
            json!("gamma"),
            json!("alpha beta"),
            json!("a,b"),
            json!("日本語"),
            Value::Null,
        ],
        "done" => vec![json!(true), json!(false), Value::Null],
        "tags" => vec![
            json!(["a"]),
            json!(["a", "b"]),
            json!([]),
            json!("[\"a\"]"),
            json!({"k": 1}),
            Value::Null,
        ],
        SOFT_DELETE => vec![json!("2024-01-01T00:00:00.000Z"), Value::Null],
        _ => vec![Value::Null],
    }
}

fn operands(column: &str) -> Vec<Value> {
    match column {
        "id" => {
            let mut values: Vec<Value> = PKS.iter().map(|pk| json!(pk)).collect();
            values.extend([json!("missing"), json!(3), Value::Null]);
            values
        }
        "nope" => vec![json!("x"), Value::Null],
        "done" => vec![json!(true), json!(false), json!("true"), Value::Null],
        other => cell_values(other),
    }
}

fn random_rows(rng: &mut Seeded) -> Vec<(String, Map<String, Value>)> {
    let mut rows = Vec::new();
    for pk in PKS {
        if !rng.chance(60) {
            continue;
        }
        let mut columns = Map::new();
        columns.insert("user_id".into(), json!("u1"));
        for column in ["rank", "title", "done", "tags", SOFT_DELETE] {
            if rng.chance(80) {
                columns.insert(column.into(), rng.pick(&cell_values(column)));
            }
        }
        rows.push((pk.to_string(), columns));
    }
    rows
}

/// A `regexMatch`, `regexIMatch`, `isDistinct` or `overlaps` leaf. A read may
/// carry an `overlaps` operand the kernel refuses; a write never does, since a
/// refused write would end the replay.
fn random_regex_or_set_leaf(rng: &mut Seeded, column: String, for_write: bool) -> Filter {
    match rng.below(4) {
        0 => Filter::RegexMatch {
            pattern: rng.pick(&REGEXES).into(),
            column,
        },
        1 => Filter::RegexIMatch {
            pattern: rng.pick(&REGEXES).into(),
            column,
        },
        2 => Filter::IsDistinct {
            value: rng.pick(&operands(&column)),
            column,
        },
        _ => {
            let mut operands = vec![json!(["a"]), json!(["b", "z"]), json!([]), json!("[\"a\"]")];
            if !for_write {
                operands.extend([json!("[1,5)"), Value::Null]);
            }
            Filter::Overlaps {
                column: "tags".into(),
                value: rng.pick(&operands),
            }
        }
    }
}

fn random_leaf(rng: &mut Seeded, for_write: bool) -> Filter {
    let column: String = rng.pick(&COLUMNS).into();
    let operand = |rng: &mut Seeded| rng.pick(&operands(&column));
    match rng.below(18) {
        14..=17 => random_regex_or_set_leaf(rng, column, for_write),
        0 => Filter::Eq {
            value: operand(rng),
            column,
        },
        1 => Filter::Neq {
            value: operand(rng),
            column,
        },
        2 => Filter::Gt {
            value: operand(rng),
            column,
        },
        3 => Filter::Gte {
            value: operand(rng),
            column,
        },
        4 => Filter::Lt {
            value: operand(rng),
            column,
        },
        5 => Filter::Lte {
            value: operand(rng),
            column,
        },
        6 => Filter::Like {
            pattern: rng.pick(&PATTERNS).into(),
            column,
        },
        7 => Filter::Ilike {
            pattern: rng.pick(&PATTERNS).into(),
            column,
        },
        8 => Filter::Is {
            value: rng.pick(&[Value::Null, json!(true), json!(false)]),
            column,
        },
        9 => {
            let count = rng.below(4);
            Filter::In {
                values: (0..count).map(|_| operand(rng)).collect(),
                column,
            }
        }
        10 => Filter::Contains {
            column: "tags".into(),
            value: rng.pick(&cell_values("tags")),
        },
        11 => Filter::ContainedBy {
            column: "tags".into(),
            value: rng.pick(&cell_values("tags")),
        },
        12 => Filter::Search {
            query: rng
                .pick(&if for_write {
                    vec!["alp", "a", "2", "zz"]
                } else {
                    vec!["alp", "a", "2", "zz", " "]
                })
                .into(),
            columns: rng.pick(&[
                None,
                Some(vec!["title".to_string(), "id".to_string()]),
                Some(vec!["rank".to_string(), "nope".to_string()]),
            ]),
        },
        _ => Filter::TextSearch {
            column: "title".into(),
            query: rng
                .pick(&if for_write {
                    vec!["alpha", "beta alpha", "\"alpha beta\""]
                } else {
                    vec!["alpha", "beta alpha", "\"alpha beta\"", " "]
                })
                .into(),
            r#type: rng.pick(&["plain", "phrase", "websearch"]).into(),
        },
    }
}

fn random_filter(rng: &mut Seeded, depth: usize, for_write: bool) -> Filter {
    if depth >= 2 || !rng.chance(30) {
        return random_leaf(rng, for_write);
    }

    let fewest = usize::from(for_write);
    match rng.below(3) {
        0 => Filter::And {
            filters: random_children(rng, depth + 1, fewest, for_write),
        },
        1 => Filter::Or {
            filters: random_children(rng, depth + 1, fewest, for_write),
        },
        _ => Filter::Not {
            filter: Box::new(random_filter(rng, depth + 1, for_write)),
        },
    }
}

fn random_children(rng: &mut Seeded, depth: usize, fewest: usize, for_write: bool) -> Vec<Filter> {
    let count = fewest + rng.below(3);
    (0..count)
        .map(|_| random_filter(rng, depth, for_write))
        .collect()
}

fn random_id_leaf(rng: &mut Seeded) -> Filter {
    if rng.chance(50) {
        eq("id", rng.pick(&operands("id")))
    } else {
        let count = rng.below(5);
        is_in(
            "id",
            (0..count).map(|_| rng.pick(&operands("id"))).collect(),
        )
    }
}

/// An `eq` or `in` on `id`, placed at the root, beside a sibling in a root
/// `and`, or inside an `and` nested in a root `and`.
fn random_id_conjunct(rng: &mut Seeded, for_write: bool) -> Filter {
    let conjunct = random_id_leaf(rng);
    match rng.below(3) {
        0 => conjunct,
        1 => Filter::And {
            filters: vec![random_filter(rng, 1, for_write), conjunct],
        },
        _ => Filter::And {
            filters: vec![Filter::And {
                filters: vec![conjunct],
            }],
        },
    }
}

/// An `eq` or `in` on `id` that is not a conjunct: under an `or` or a `not` it
/// narrows nothing, so it must not restrict the rows a read or a write scans.
fn random_id_decoy(rng: &mut Seeded, for_write: bool) -> Filter {
    let named = random_id_leaf(rng);
    if rng.chance(50) {
        Filter::Or {
            filters: vec![named, random_filter(rng, 1, for_write)],
        }
    } else {
        Filter::Not {
            filter: Box::new(named),
        }
    }
}

fn random_root(rng: &mut Seeded, for_write: bool) -> Vec<Filter> {
    let count = rng.below(3);
    let mut filters: Vec<Filter> = (0..count)
        .map(|_| random_filter(rng, 0, for_write))
        .collect();
    if rng.chance(45) {
        let at = rng.below(filters.len() + 1);
        filters.insert(at, random_id_conjunct(rng, for_write));
    }
    if rng.chance(25) {
        let at = rng.below(filters.len() + 1);
        filters.insert(at, random_id_decoy(rng, for_write));
    }
    if for_write && filters.is_empty() {
        filters.push(random_filter(rng, 0, true));
    }
    if !for_write && rng.chance(3) {
        filters.push(Filter::Is {
            column: "title".into(),
            value: json!("refused"),
        });
    }
    filters
}

fn random_plan(rng: &mut Seeded) -> QueryPlan {
    let orders = if rng.chance(30) {
        (0..=rng.below(2))
            .map(|_| OrderBy {
                column: rng.pick(&["rank", "title", "done"]).into(),
                ascending: rng.chance(50),
                nulls_first: rng.pick(&[None, Some(true), Some(false)]),
            })
            .collect()
    } else {
        Vec::new()
    };
    let limit = match rng.below(100) {
        0..=1 => Some(-1),
        2..=46 => Some(i64::try_from(rng.below(5)).unwrap()),
        _ => None,
    };
    let offset = match rng.below(100) {
        0..=1 => Some(-1),
        2..=31 => Some(i64::try_from(rng.below(4)).unwrap()),
        _ => None,
    };
    QueryPlan {
        filters: random_root(rng, false),
        orders,
        limit,
        offset,
        projection: rng
            .chance(15)
            .then(|| vec!["id".to_string(), "rank".to_string()]),
        cardinality: rng
            .pick(&["many", "many", "many", "single", "maybeSingle"])
            .into(),
        include_deleted: rng.chance(50),
        count: rng.chance(15),
    }
}

/// The rows a read may see, straight from the whole table, soft-deleted rows
/// hidden unless the caller asked for them.
fn visible_rows(engine: &SyncEngine, soft_delete: bool, include_deleted: bool) -> Vec<Row> {
    let mut rows = engine.read_all_rows(TABLE).unwrap();
    if soft_delete && !include_deleted {
        rows.retain(|row| row.get(SOFT_DELETE).is_none_or(Value::is_null));
    }
    rows
}

/// A read that stops at its second match reports the matches it read, so a
/// cardinality refusal of two stands for any count above one.
fn same_refusal(fast: &QueryError, full: &QueryError) -> bool {
    match (fast, full) {
        (QueryError::SingleCardinality(read), QueryError::SingleCardinality(all))
        | (QueryError::MaybeSingleCardinality(read), QueryError::MaybeSingleCardinality(all)) => {
            read == all || (*read == 2 && *all > 2)
        }
        _ => fast == full,
    }
}

fn names_an_id(filters: &[Filter]) -> bool {
    filters.iter().any(|filter| match filter {
        Filter::Eq { column, .. } | Filter::In { column, .. } => column == "id",
        Filter::And { filters } => names_an_id(filters),
        _ => false,
    })
}

fn stops_early(plan: &QueryPlan) -> bool {
    plan.orders.is_empty()
        && !plan.count
        && (plan.limit.is_some() || matches!(plan.cardinality.as_str(), "single" | "maybeSingle"))
}

const SEED: u64 = 0x4B49_5A55_4E41;
const TABLES: usize = 240;
const PLANS_PER_TABLE: usize = 14;
const WRITES_PER_TABLE: usize = 3;

#[test]
fn every_short_path_answers_what_the_full_evaluation_answers() {
    let mut rng = Seeded(SEED);
    let (mut by_id, mut streamed, mut read_all) = (0, 0, 0);

    for table in 0..TABLES {
        let soft_delete = rng.chance(50);
        let store = LocalStore::open_in_memory().unwrap();
        seed(&store, &random_rows(&mut rng));
        let engine = engine_over(store, soft_delete);

        for case in 0..PLANS_PER_TABLE {
            let plan = random_plan(&mut rng);
            if names_an_id(&plan.filters) {
                by_id += 1;
            } else if stops_early(&plan) {
                streamed += 1;
            } else {
                read_all += 1;
            }

            let full = apply_query(
                visible_rows(&engine, soft_delete, plan.include_deleted),
                &plan,
            );
            let fast = engine.query(TABLE, &plan);
            let context = format!("table {table}, plan {case}: {plan:?}");
            match (fast, full) {
                (Ok(fast), Ok(full)) => assert_eq!(fast, full, "{context}"),
                (Err(EngineError::Query(fast)), Err(full)) => {
                    assert!(
                        same_refusal(&fast, &full),
                        "{context}: {fast:?} vs {full:?}"
                    );
                }
                (fast, full) => panic!("{context}: {fast:?} vs {full:?}"),
            }
        }

        for case in 0..WRITES_PER_TABLE {
            let filters = random_root(&mut rng, true);
            let include_deleted = rng.chance(50);
            let root = Filter::And {
                filters: filters.clone(),
            };
            let expected: Vec<String> = visible_rows(&engine, soft_delete, include_deleted)
                .iter()
                .filter(|row| matches_filter(row, &root).unwrap())
                .map(id_of)
                .collect();
            let targets = engine
                .apply_where(touch_where(filters.clone(), include_deleted))
                .unwrap_or_else(|e| panic!("table {table}, write {case}: {filters:?}: {e}"))
                .keys;
            assert_eq!(
                targets, expected,
                "table {table}, write {case}: {filters:?}"
            );
        }
    }

    let total = TABLES * PLANS_PER_TABLE;
    for (path, count) in [("id", by_id), ("streamed", streamed), ("full", read_all)] {
        assert!(
            count * 8 >= total,
            "the generator covers the {path} path in {count} of {total} plans"
        );
    }
}
