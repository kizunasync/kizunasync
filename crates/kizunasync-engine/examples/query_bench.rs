//! Local query timings over 1k, 10k and 100k rows. Each plan runs through
//! `SyncEngine::query`, which takes the short paths, beside `apply_query` over
//! every row of the table, the full evaluation; an `id`-targeted `apply_where`
//! runs beside the whole-table match it replaces. Each figure is the median of
//! five runs.
//!
//! `cargo run -p kizunasync-engine --example query_bench --release`

// Every unwrap below is on an in-memory store this program opened itself and
// filled with rows it wrote, answering plans it built to be answerable, so a
// failure is a broken build rather than an input the program has to survive.
#![allow(clippy::unwrap_used)]

use kizunasync_engine::{
    ApplyWhere, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps,
    ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_query::{Filter, OrderBy, QueryPlan, apply_query, matches_filters};
use kizunasync_store::{LocalStore, StoreError};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const TABLE: &str = "items";
const SIZES: [usize; 3] = [1_000, 10_000, 100_000];
const REPEATS: usize = 5;

fn main() {
    println!(
        "{:>8}  {:<32}  {:>12}  {:>12}",
        "rows", "plan", "short path", "whole table"
    );
    for size in SIZES {
        let engine = seeded_engine(size);
        for (name, plan) in plans(size) {
            let short = median(|| {
                engine.query(TABLE, &plan).unwrap();
            });
            let whole = median(|| {
                apply_query(engine.read_all_rows(TABLE).unwrap(), &plan).unwrap();
            });
            report(size, name, short, whole);
        }

        let target = vec![eq("id", json!(pk(size / 2)))];
        let short = median(|| {
            engine.apply_where(touch(target.clone())).unwrap();
        });
        let whole = median(|| {
            let rows = engine.read_all_rows(TABLE).unwrap();
            let matched = rows
                .iter()
                .filter(|row| matches_filters(row, &target).unwrap());
            assert_eq!(matched.count(), 1);
        });
        report(size, "apply_where eq(id)", short, whole);
    }
}

fn report(size: usize, name: &str, short: Duration, whole: Duration) {
    println!(
        "{size:>8}  {name:<32}  {:>9.3} ms  {:>9.3} ms",
        short.as_secs_f64() * 1000.0,
        whole.as_secs_f64() * 1000.0
    );
}

fn median(mut run: impl FnMut()) -> Duration {
    let mut samples: Vec<Duration> = (0..REPEATS)
        .map(|_| {
            let start = Instant::now();
            run();
            start.elapsed()
        })
        .collect();
    samples.sort();
    samples[REPEATS / 2]
}

fn pk(index: usize) -> String {
    format!("row-{index:07}")
}

fn eq(column: &str, value: Value) -> Filter {
    Filter::Eq {
        column: column.into(),
        value,
    }
}

/// Plans that take each short path, then two that read every row either way.
fn plans(size: usize) -> Vec<(&'static str, QueryPlan)> {
    let middle = size / 2;
    let open = eq("done", json!(false));
    vec![
        ("eq(id)", filtered(vec![eq("id", json!(pk(middle)))])),
        (
            "in(id), ten keys",
            filtered(vec![Filter::In {
                column: "id".into(),
                values: (0..10).map(|step| json!(pk(step * size / 10))).collect(),
            }]),
        ),
        (
            "eq(id) single",
            QueryPlan {
                cardinality: "single".into(),
                ..filtered(vec![eq("id", json!(pk(middle)))])
            },
        ),
        (
            "limit(20)",
            QueryPlan {
                limit: Some(20),
                ..QueryPlan::default()
            },
        ),
        (
            "eq(done) limit(20)",
            QueryPlan {
                limit: Some(20),
                ..filtered(vec![open.clone()])
            },
        ),
        ("eq(done)", filtered(vec![open])),
        (
            "order(rank) limit(20)",
            QueryPlan {
                orders: vec![OrderBy {
                    column: "rank".into(),
                    ascending: true,
                    nulls_first: None,
                }],
                limit: Some(20),
                ..QueryPlan::default()
            },
        ),
    ]
}

fn filtered(filters: Vec<Filter>) -> QueryPlan {
    QueryPlan {
        filters,
        ..QueryPlan::default()
    }
}

fn touch(filters: Vec<Filter>) -> ApplyWhere {
    let mut columns = Map::new();
    columns.insert("touched".into(), json!(true));
    ApplyWhere {
        table: TABLE.into(),
        filters,
        op: Op::Update,
        columns,
        precondition: None,
        transforms: None,
        include_deleted: false,
    }
}

fn seeded_engine(size: usize) -> SyncEngine {
    let store = LocalStore::open_in_memory().unwrap();
    store
        .transaction(|| {
            for index in 0..size {
                let mut columns = Map::new();
                columns.insert("user_id".into(), json!("u1"));
                columns.insert("title".into(), json!(format!("works on a plane {index}")));
                columns.insert("rank".into(), json!(index % 100));
                columns.insert("done".into(), json!(index % 3 == 0));
                store.put_server_row(TABLE, &pk(index), &columns, "1")?;
            }
            Ok::<_, StoreError>(())
        })
        .unwrap();

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
            soft_delete_column: None,
            sync_mode: SyncMode::ReadWrite,
            conflict_mode: ConflictMode::Arrival,
        },
    );
    let config = EngineConfig {
        tables,
        schema_version: 1,
        default_limit: None,
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
        client_id: "bench".into(),
    };
    SyncEngine::new(
        store,
        config,
        Arc::new(ScriptedRemote::new()),
        EngineDeps::default(),
    )
}
