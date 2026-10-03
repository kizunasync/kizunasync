//! Conflict parity vectors.
//!
//! The one runner of `packages/protocol/vectors/conflict-vectors.json`, the
//! frozen conflict oracle. Every vector replays against `SyncEngine` and every
//! vector runs: a disagreement here is an engine bug, never a vector to relax.
//!
//! One vector crosses four axes: the queued local op, the server verdict, the
//! concurrent pull state (before / after the verdict), and the full local effect
//! (exact rows, tombstone shadows, outbox depth, rejection journal, events,
//! cursor). Every assertion is exact: a vector that only checked the row under
//! test would miss the collateral damage this suite exists to catch.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use async_trait::async_trait;
use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ProtocolRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::{
    BatchOutcome, ColumnValues, Op, PullRequest, PullResponse, PushRequest, PushResponse, Signal,
    Verdict,
};
use kizunasync_store::{LocalMutation, LocalStore};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// The floor the oracle file must keep carrying (the documented conflict matrix).
const MINIMUM_VECTORS: usize = 80;
const OWNER: &str = "user-a";

/// The event names that carry conflict meaning, plus `QUEUE_DEPTH`, which the
/// vectors pin at once per `apply()` call and so assert like any other event.
/// `LOCAL_CHANGED` is excluded: the vectors pin it at a granularity the engine
/// does not promise, so this runner does not compare it.
const SIGNIFICANT_EVENTS: [&str; 6] = [
    "BATCH_ABORTED",
    "CHECKPOINT_EXPIRED",
    "DEAD_LETTER",
    "MUTATION_REJECTED",
    "QUEUE_DEPTH",
    "RESET_REQUIRED",
];

// MARK: - Vector shape

#[derive(Debug, Deserialize)]
struct Oracle {
    vectors: Vec<Vector>,
}

#[derive(Debug, Deserialize)]
struct Vector {
    name: String,
    #[serde(default)]
    tables: Option<Vec<String>>,
    #[serde(default)]
    seed_rows: Vec<RowSeed>,
    #[serde(default)]
    seed_tombstones: Vec<TombSeed>,
    #[serde(default)]
    seed_cursor: Option<String>,
    local_mutations: Vec<MutationSpec>,
    #[serde(default)]
    pull_before: Option<PullResponse>,
    #[serde(default)]
    verdicts: Option<Vec<Verdict>>,
    #[serde(default)]
    pushes: Option<Vec<PushStep>>,
    #[serde(default)]
    pull_after: Vec<PullResponse>,
    expect: Expect,
    #[serde(default)]
    expect_error: Option<ExpectError>,
}

#[derive(Debug, Deserialize)]
struct RowSeed {
    table: String,
    pk: String,
    row: ColumnValues,
    seq: String,
}

#[derive(Debug, Deserialize)]
struct TombSeed {
    table: String,
    pk: String,
    seq: String,
}

#[derive(Debug, Deserialize)]
struct MutationSpec {
    mutation_id: String,
    table: String,
    pk: String,
    op: String,
    columns: ColumnValues,
    #[serde(default)]
    precondition: Option<ColumnValues>,
    #[serde(default)]
    batch_id: Option<String>,
}

/// One scripted push RPC: verdicts, a batch abort, a signal, or a transport fault.
#[derive(Debug, Clone, Deserialize)]
struct PushStep {
    #[serde(default)]
    verdicts: Option<Vec<Verdict>>,
    #[serde(default)]
    batch: Option<BatchOutcome>,
    #[serde(default)]
    signal: Option<Signal>,
    #[serde(default)]
    transport_error: Option<TransportError>,
}

#[derive(Debug, Clone, Deserialize)]
struct TransportError {
    retryable: bool,
}

#[derive(Debug, Deserialize)]
struct Expect {
    rows: Vec<RowExpect>,
    tombstones: Vec<String>,
    outbox_depth: usize,
    rejections: Vec<RejectionExpect>,
    events: Vec<String>,
    cursor: String,
    #[serde(default)]
    soft_blocked: bool,
}

#[derive(Debug, Deserialize)]
struct RowExpect {
    table: String,
    pk: String,
    row: ColumnValues,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct RejectionExpect {
    mutation_id: String,
    kind: String,
    reason: String,
    changed_columns: Vec<String>,
    server_row: Option<ColumnValues>,
}

#[derive(Debug, Deserialize)]
struct ExpectError {
    code: String,
    stage: String,
    index: usize,
}

fn load_oracle() -> Oracle {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/vectors/conflict-vectors.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

// MARK: - Engine wiring

/// A remote that answers strictly from the vector's script. A step the engine
/// never reaches (a soft-blocked push, a push over an already-drained outbox) is
/// simply left unconsumed: that IS the behavior under test.
struct VectorRemote {
    pulls: Mutex<VecDeque<PullResponse>>,
    pushes: Mutex<VecDeque<PushStep>>,
}

#[async_trait]
impl ProtocolRemote for VectorRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        self.pulls
            .lock()
            .map_err(|_| EngineError::remote("lock"))?
            .pop_front()
            .ok_or_else(|| EngineError::remote("the engine made an unscripted pull"))
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        let step = self
            .pushes
            .lock()
            .map_err(|_| EngineError::remote("lock"))?
            .pop_front()
            .ok_or_else(|| EngineError::remote("the engine made an unscripted push"))?;
        if let Some(transport) = step.transport_error {
            return Err(if transport.retryable {
                EngineError::remote("scripted transport failure")
            } else {
                EngineError::permanent_remote("scripted transport failure")
            });
        }
        Ok(PushResponse {
            verdicts: step.verdicts,
            signal: step.signal,
            batch: step.batch,
        })
    }
}

fn tables_of(vector: &Vector) -> Vec<String> {
    vector
        .tables
        .clone()
        .unwrap_or_else(|| vec!["todos".to_string()])
}

/// `verdicts` is sugar for a single `{ verdicts }` push.
fn push_steps(vector: &Vector) -> Vec<PushStep> {
    if let Some(pushes) = &vector.pushes {
        return pushes.clone();
    }
    vector.verdicts.as_ref().map_or_else(Vec::new, |verdicts| {
        vec![PushStep {
            verdicts: Some(verdicts.clone()),
            batch: None,
            signal: None,
            transport_error: None,
        }]
    })
}

fn build_engine(vector: &Vector) -> SyncEngine {
    let mut tables = BTreeMap::new();
    for table in tables_of(vector) {
        let mut params = Map::new();
        params.insert("owner_id".into(), json!(OWNER));
        tables.insert(
            table,
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
    }
    let config = EngineConfig {
        tables,
        schema_version: 1,
        default_limit: None,
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
        client_id: "c1".into(),
    };
    let steps = push_steps(vector);
    let mut pulls: VecDeque<PullResponse> = VecDeque::new();
    if let Some(page) = &vector.pull_before {
        pulls.push_back(page.clone());
    }
    for page in &vector.pull_after {
        pulls.push_back(page.clone());
    }
    let remote = Arc::new(VectorRemote {
        pulls: Mutex::new(pulls),
        pushes: Mutex::new(steps.into()),
    });
    let deps = EngineDeps {
        now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
        now_millis: Box::new(|| 1_704_067_200_000),
        // Every vector pins its mutation_ids and pks, so nothing is ever minted.
        uuid: Box::new(|| panic!("the engine minted an unscripted uuid")),
    };
    SyncEngine::new(
        LocalStore::open_in_memory().expect("store"),
        config,
        remote,
        deps,
    )
}

// MARK: - Vector execution

async fn seed(engine: &SyncEngine, vector: &Vector) {
    for row in &vector.seed_rows {
        engine
            .seed_row(&row.table, &row.pk, &row.row, &row.seq)
            .expect("seed row");
    }
    for tomb in &vector.seed_tombstones {
        // A shadow means the row is gone: `apply_tombstone` deletes it and writes
        // the shadow, exactly like the pulled-tombstone path.
        engine
            .seed_tombstone(&tomb.table, &tomb.pk, &tomb.seq)
            .expect("seed tombstone");
    }
    if let Some(cursor) = &vector.seed_cursor {
        engine.seed_checkpoint(cursor).await.expect("seed cursor");
    }
    for spec in &vector.local_mutations {
        let op = match spec.op.as_str() {
            "update" => Op::Update,
            "delete" => Op::Delete,
            "insert" => Op::Insert,
            other => panic!("unknown local op {other:?}"),
        };
        engine
            .apply(LocalMutation {
                table: spec.table.clone(),
                pk: spec.pk.clone(),
                op,
                columns: spec.columns.clone(),
                transforms: None,
                precondition: spec.precondition.clone(),
                batch_id: spec.batch_id.clone(),
                hlc: None,
                mutation_id: Some(spec.mutation_id.clone()),
            })
            .expect("apply local mutation");
    }
}

fn assert_loud(result: Result<(), EngineError>, code: &str, what: &str) {
    let error = result.expect_err(&format!("{what} must fail loud with {code}"));
    assert_eq!(error.code(), code, "{what}: expected {code}, got {error}");
}

/// The RPC sequence, stopping at (and asserting) the expected loud failure.
async fn drive(engine: &SyncEngine, vector: &Vector) {
    let fails_at = |stage: &str, index: usize| -> Option<&str> {
        vector
            .expect_error
            .as_ref()
            .filter(|e| e.stage == stage && e.index == index)
            .map(|e| e.code.as_str())
    };
    let steps = push_steps(vector);

    if vector.pull_before.is_some() {
        if let Some(code) = fails_at("pull_before", 0) {
            assert_loud(engine.pull_once().await, code, "pull_before");
            return;
        }
        engine.pull_once().await.expect("pull_before");
    }
    for (index, step) in steps.iter().enumerate() {
        if let Some(code) = fails_at("push", index) {
            assert_loud(engine.push_once().await, code, "push");
            return;
        }
        if step.transport_error.is_some() {
            // A transport failure always propagates: the outbox must survive it.
            engine
                .push_once()
                .await
                .expect_err("a scripted transport failure must propagate");
            continue;
        }
        engine.push_once().await.expect("push");
    }
    for index in 0..vector.pull_after.len() {
        if let Some(code) = fails_at("pull_after", index) {
            assert_loud(engine.pull_once().await, code, "pull_after");
            return;
        }
        engine.pull_once().await.expect("pull_after");
    }
}

// MARK: - Assertions

/// Every (table, pk) the vector names anywhere: the tombstone probe set.
fn touched_keys(vector: &Vector) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for row in &vector.seed_rows {
        keys.insert(format!("{}/{}", row.table, row.pk));
    }
    for tomb in &vector.seed_tombstones {
        keys.insert(format!("{}/{}", tomb.table, tomb.pk));
    }
    for spec in &vector.local_mutations {
        keys.insert(format!("{}/{}", spec.table, spec.pk));
    }
    for page in vector.pull_before.iter().chain(vector.pull_after.iter()) {
        for row in &page.rows {
            keys.insert(format!("{}/{}", row.table, row.pk));
        }
        for tomb in &page.tombstones {
            keys.insert(format!("{}/{}", tomb.table, tomb.pk));
        }
    }
    for row in &vector.expect.rows {
        keys.insert(format!("{}/{}", row.table, row.pk));
    }
    for key in &vector.expect.tombstones {
        keys.insert(key.clone());
    }
    keys
}

fn check(failures: &mut Vec<String>, vector: &Vector, what: &str, got: &Value, want: &Value) {
    if got != want {
        failures.push(format!(
            "{}: {what}\n     got  {got}\n     want {want}",
            vector.name
        ));
    }
}

fn assert_rows(vector: &Vector, engine: &SyncEngine, failures: &mut Vec<String>) {
    let mut rows: Vec<Value> = Vec::new();
    for table in tables_of(vector) {
        for row in engine.read_local_rows(&table).expect("read rows") {
            rows.push(json!({ "table": table, "pk": row.pk, "row": row.columns }));
        }
    }
    rows.sort_by_key(|row| {
        format!(
            "{}/{}",
            row["table"].as_str().unwrap_or_default(),
            row["pk"].as_str().unwrap_or_default()
        )
    });
    let expected_rows: Vec<Value> = vector
        .expect
        .rows
        .iter()
        .map(|row| json!({ "table": row.table, "pk": row.pk, "row": row.row }))
        .collect();
    check(
        failures,
        vector,
        "rows",
        &Value::Array(rows),
        &Value::Array(expected_rows),
    );
}

fn assert_shadows(vector: &Vector, engine: &SyncEngine, failures: &mut Vec<String>) {
    let shadows: Vec<String> = touched_keys(vector)
        .into_iter()
        .filter(|key| {
            let (table, pk) = key.split_once('/').unwrap_or_default();
            engine.has_tombstone(table, pk).expect("has_tombstone")
        })
        .collect();
    let mut want_shadows = vector.expect.tombstones.clone();
    want_shadows.sort();
    check(
        failures,
        vector,
        "tombstones",
        &json!(shadows),
        &json!(want_shadows),
    );
}

fn assert_journal(vector: &Vector, engine: &SyncEngine, failures: &mut Vec<String>) {
    let mut journal: Vec<RejectionExpect> = engine
        .list_rejections(true)
        .expect("journal")
        .into_iter()
        .map(|record| {
            let mut changed = record.changed_columns;
            changed.sort();
            RejectionExpect {
                mutation_id: record.mutation_id,
                kind: record.kind.as_str().to_string(),
                reason: record.reason,
                changed_columns: changed,
                server_row: record.server_row,
            }
        })
        .collect();
    journal.sort_by(|a, b| a.mutation_id.cmp(&b.mutation_id));
    let want_journal: Vec<Value> = vector
        .expect
        .rejections
        .iter()
        .map(|record| {
            let mut changed = record.changed_columns.clone();
            changed.sort();
            json!({
                "mutation_id": record.mutation_id,
                "kind": record.kind,
                "reason": record.reason,
                "changed_columns": changed,
                "server_row": record.server_row,
            })
        })
        .collect();
    let got_journal: Vec<Value> = journal
        .iter()
        .map(|record| {
            json!({
                "mutation_id": record.mutation_id,
                "kind": record.kind,
                "reason": record.reason,
                "changed_columns": record.changed_columns,
                "server_row": record.server_row,
            })
        })
        .collect();
    check(
        failures,
        vector,
        "rejections",
        &Value::Array(got_journal),
        &Value::Array(want_journal),
    );
}

fn assert_vector(vector: &Vector, engine: &SyncEngine, failures: &mut Vec<String>) {
    assert_rows(vector, engine, failures);
    assert_shadows(vector, engine, failures);
    assert_journal(vector, engine, failures);

    check(
        failures,
        vector,
        "outbox_depth",
        &json!(engine.get_outbox_depth().expect("depth")),
        &json!(vector.expect.outbox_depth),
    );

    let events: Vec<String> = engine
        .recent_event_names()
        .into_iter()
        .filter(|name| SIGNIFICANT_EVENTS.contains(&name.as_str()))
        .collect();
    check(
        failures,
        vector,
        "events",
        &json!(events),
        &json!(vector.expect.events),
    );

    check(
        failures,
        vector,
        "cursor",
        &json!(engine.get_checkpoint().expect("cursor")),
        &json!(vector.expect.cursor),
    );
    check(
        failures,
        vector,
        "soft_blocked",
        &json!(engine.is_soft_blocked().expect("soft blocked")),
        &json!(vector.expect.soft_blocked),
    );
}

// MARK: - Suite

#[test]
fn the_oracle_has_the_minimum_vectors_unique_names_and_one_push_spelling() {
    let oracle = load_oracle();
    assert!(
        oracle.vectors.len() >= MINIMUM_VECTORS,
        "{} vectors, expected at least {MINIMUM_VECTORS}",
        oracle.vectors.len()
    );
    let names: BTreeSet<&str> = oracle.vectors.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names.len(), oracle.vectors.len(), "duplicate vector name");
    for vector in &oracle.vectors {
        assert!(
            !(vector.verdicts.is_some() && vector.pushes.is_some()),
            "{}: \"verdicts\" is sugar for a single push, use one or the other",
            vector.name
        );
    }
}

#[tokio::test]
async fn conflict_vectors_match_the_frozen_oracle() {
    let oracle = load_oracle();
    let mut failures: Vec<String> = Vec::new();
    let mut ran = 0usize;
    for vector in &oracle.vectors {
        let engine = build_engine(vector);
        seed(&engine, vector).await;
        drive(&engine, vector).await;
        assert_vector(vector, &engine, &mut failures);
        ran += 1;
    }
    eprintln!("conflict vectors: {ran} ran");
    assert!(
        failures.is_empty(),
        "{} of {ran} conflict vectors diverge from the frozen conflict oracle \
         `packages/protocol/vectors/conflict-vectors.json`:\n  - {}",
        failures.len(),
        failures.join("\n  - ")
    );
    assert!(ran >= MINIMUM_VECTORS, "only {ran} vectors ran");
}
