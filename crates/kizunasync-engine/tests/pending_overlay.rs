//! A pending write stays visible whichever path resets its row.
//!
//! `apply()` writes a queued mutation onto the local row at once. Every path
//! that later replaces that row (a pull boundary, a push reconcile installing a
//! server row or reverting a rejected write, an atomic-batch abort, a dead
//! letter) wipes the pending effect with it, so each one must replay the queued
//! mutations over the row it installed, FIFO and without resurrecting a row a
//! tombstone removed (D-outbox-rebase).

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use async_trait::async_trait;
use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ProtocolRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::{
    BatchOutcome, ColumnValues, Op, PullRequest, PullResponse, PushRequest, PushResponse,
    RowChange, Verdict,
};
use kizunasync_store::{LocalMutation, LocalStore, RejectionKind};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

/// The dead-letter budget `sync()` spends on one head.
const BUDGET: usize = 5;

/// Replays scripted answers in order. An exhausted pull script answers an
/// empty page; an exhausted push script is a test that pushed more than it
/// planned, so it fails loud.
#[derive(Default)]
struct Script {
    pulls: Mutex<VecDeque<PullResponse>>,
    pushes: Mutex<VecDeque<Result<PushResponse, EngineError>>>,
}

impl Script {
    fn pull(&self, page: PullResponse) {
        self.pulls.lock().unwrap().push_back(page);
    }

    fn push(&self, answer: Result<PushResponse, EngineError>) {
        self.pushes.lock().unwrap().push_back(answer);
    }
}

#[async_trait]
impl ProtocolRemote for Script {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        Ok(self
            .pulls
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| page("0", vec![])))
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        self.pushes
            .lock()
            .unwrap()
            .pop_front()
            .expect("a push the script did not plan")
    }
}

fn config() -> EngineConfig {
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("u1"));
    let mut tables = BTreeMap::new();
    tables.insert(
        "todos".into(),
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

fn engine_with(remote: Arc<Script>) -> SyncEngine {
    let deps = EngineDeps {
        now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
        now_millis: Box::new(|| 1_704_067_200_000),
        ..EngineDeps::default()
    };
    SyncEngine::new(
        LocalStore::open_in_memory().expect("store"),
        config(),
        remote,
        deps,
    )
}

/// The object `value` names, as a column map.
fn columns(value: Value) -> ColumnValues {
    match value {
        Value::Object(map) => map,
        other => panic!("columns must be an object, got {other}"),
    }
}

/// A server row of `todos` owned by `u1`, carrying `extra` on top.
fn server_row(extra: Value) -> ColumnValues {
    let mut row = columns(json!({ "owner_id": "u1" }));
    row.extend(columns(extra));
    row
}

fn page(cursor: &str, rows: Vec<RowChange>) -> PullResponse {
    PullResponse {
        cursor: cursor.into(),
        has_more: false,
        rows,
        tombstones: vec![],
        signal: None,
        conflicts: None,
    }
}

fn pulled(pk: &str, seq: &str, row: ColumnValues) -> RowChange {
    RowChange {
        table: "todos".into(),
        pk: pk.into(),
        seq: seq.into(),
        columns: row,
        deleted: false,
    }
}

/// The server's copy of `p1` lands locally through a committed pull.
async fn seed(engine: &SyncEngine, remote: &Script, row: ColumnValues) {
    remote.pull(page("1", vec![pulled("p1", "1", row)]));
    engine.pull_once().await.expect("seed pull");
}

struct Write<'a> {
    mutation_id: &'a str,
    op: Op,
    columns: Value,
    transforms: Option<Value>,
    precondition: Option<Value>,
    batch_id: Option<&'a str>,
}

impl<'a> Write<'a> {
    const fn update(mutation_id: &'a str, columns: Value) -> Self {
        Self {
            mutation_id,
            op: Op::Update,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
        }
    }

    const fn in_batch(mut self, batch_id: &'a str) -> Self {
        self.batch_id = Some(batch_id);
        self
    }

    fn apply(self, engine: &SyncEngine) {
        engine
            .apply(LocalMutation {
                table: "todos".into(),
                pk: "p1".into(),
                op: self.op,
                columns: columns(self.columns),
                transforms: self.transforms.map(columns),
                precondition: self.precondition.map(columns),
                batch_id: self.batch_id.map(str::to_string),
                hlc: None,
                mutation_id: Some(self.mutation_id.into()),
            })
            .expect("apply");
    }
}

fn p1(engine: &SyncEngine) -> Option<ColumnValues> {
    engine
        .read_row("todos", "p1")
        .expect("read")
        .map(|row| row.columns)
}

fn verdicts(verdicts: Vec<Verdict>) -> PushResponse {
    PushResponse {
        verdicts: Some(verdicts),
        signal: None,
        batch: None,
    }
}

fn applied(mutation_id: &str, server_row: Option<ColumnValues>) -> Verdict {
    Verdict {
        mutation_id: mutation_id.into(),
        verdict: "applied".into(),
        reason: None,
        server_row,
    }
}

fn rejected(mutation_id: &str, reason: &str, server_row: Option<ColumnValues>) -> Verdict {
    Verdict {
        mutation_id: mutation_id.into(),
        verdict: "rejected".into(),
        reason: Some(reason.into()),
        server_row,
    }
}

fn abort(offender: &str, server_row: Option<ColumnValues>) -> PushResponse {
    PushResponse {
        verdicts: None,
        signal: None,
        batch: Some(BatchOutcome {
            outcome: "aborted".into(),
            offender_mutation_id: Some(offender.into()),
            reason: Some("PRECONDITION".into()),
            server_row,
        }),
    }
}

// MARK: - Atomic-batch abort

/// The abort reverts the batch's row, and the later write queued behind the
/// batch is still the local truth: through the abort, a failed later push, a
/// pull that does not carry the row, and a pull that does.
#[tokio::test]
async fn an_aborted_batch_keeps_a_later_pending_write_on_its_row_visible() {
    let remote = Arc::new(Script::default());
    let engine = engine_with(remote.clone());
    seed(&engine, &remote, server_row(json!({ "title": "orig" }))).await;
    Write::update("m1", json!({ "title": "one" }))
        .in_batch("b1")
        .apply(&engine);
    Write::update("m2", json!({ "title": "two" })).apply(&engine);

    remote.push(Ok(abort(
        "m1",
        Some(server_row(json!({ "title": "orig" }))),
    )));
    engine.push_once().await.expect("the abort reconciles");
    assert_eq!(p1(&engine), Some(server_row(json!({ "title": "two" }))));
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);

    remote.push(Err(EngineError::remote("network down")));
    engine
        .push_once()
        .await
        .expect_err("the later push fails in transit");
    assert_eq!(p1(&engine), Some(server_row(json!({ "title": "two" }))));

    remote.pull(page("2", vec![]));
    engine.pull_once().await.expect("a pull without the row");
    assert_eq!(p1(&engine), Some(server_row(json!({ "title": "two" }))));

    remote.pull(page(
        "3",
        vec![pulled("p1", "3", server_row(json!({ "title": "orig" })))],
    ));
    engine.pull_once().await.expect("a pull carrying the row");
    assert_eq!(p1(&engine), Some(server_row(json!({ "title": "two" }))));
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
}

/// An abort that restores the row must not bring back a row a later queued
/// delete removed: the pending delete replays over the restored row.
#[tokio::test]
async fn an_abort_does_not_resurrect_a_row_a_pending_delete_removed() {
    let remote = Arc::new(Script::default());
    let engine = engine_with(remote.clone());
    seed(&engine, &remote, server_row(json!({ "title": "orig" }))).await;
    Write::update("m1", json!({ "title": "one" }))
        .in_batch("b1")
        .apply(&engine);
    Write {
        op: Op::Delete,
        ..Write::update("m2", json!({}))
    }
    .apply(&engine);

    remote.push(Ok(abort(
        "m1",
        Some(server_row(json!({ "title": "orig" }))),
    )));
    engine.push_once().await.expect("the abort reconciles");

    assert_eq!(p1(&engine), None);
    assert!(engine.has_tombstone("todos", "p1").unwrap());
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
}

/// An abort with no server row leaves the no-resurrection shadow, and a pending
/// update on that row stays queued without bringing the row back.
#[tokio::test]
async fn an_abort_without_a_server_row_keeps_the_row_gone_under_a_pending_update() {
    let remote = Arc::new(Script::default());
    let engine = engine_with(remote.clone());
    seed(&engine, &remote, server_row(json!({ "title": "orig" }))).await;
    Write::update("m1", json!({ "title": "one" }))
        .in_batch("b1")
        .apply(&engine);
    Write::update("m2", json!({ "title": "two" })).apply(&engine);

    remote.push(Ok(abort("m1", None)));
    engine.push_once().await.expect("the abort reconciles");

    assert_eq!(p1(&engine), None);
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
}

// MARK: - Per-mutation verdicts

/// A rejected write reverts the row to the server's copy, and the next write
/// of the same batch, which the server applied, is laid back over it.
#[tokio::test]
async fn a_rejected_write_keeps_the_applied_later_write_of_the_same_batch() {
    let remote = Arc::new(Script::default());
    let engine = engine_with(remote.clone());
    seed(
        &engine,
        &remote,
        server_row(json!({ "title": "orig", "note": null })),
    )
    .await;
    Write {
        precondition: Some(json!({ "title": "x" })),
        ..Write::update("m1", json!({ "title": "three" }))
    }
    .apply(&engine);
    Write::update("m2", json!({ "note": "four" })).apply(&engine);

    remote.push(Ok(verdicts(vec![
        rejected(
            "m1",
            "PRECONDITION",
            Some(server_row(json!({ "title": "orig", "note": null }))),
        ),
        applied("m2", None),
    ])));
    engine.push_once().await.expect("the verdicts reconcile");

    assert_eq!(
        p1(&engine),
        Some(server_row(json!({ "title": "orig", "note": "four" })))
    );
    assert_eq!(engine.get_outbox_depth().unwrap(), 0);
    let journal = engine.list_rejections(false).unwrap();
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].mutation_id, "m1");
    assert_eq!(journal[0].kind, RejectionKind::Rejected);
}

/// Only a write the server applied AFTER the row was reset is laid back over
/// it: a server row rendered after an applied increment already counts that
/// increment, and replaying it would count it twice.
#[tokio::test]
async fn an_applied_write_ahead_of_the_reset_is_not_replayed_onto_the_server_row() {
    let remote = Arc::new(Script::default());
    let engine = engine_with(remote.clone());
    seed(&engine, &remote, server_row(json!({ "likes": 0 }))).await;
    Write {
        transforms: Some(json!({ "likes": { "op": "increment", "by": 1 } })),
        ..Write::update("m1", json!({}))
    }
    .apply(&engine);
    Write {
        precondition: Some(json!({ "title": "x" })),
        ..Write::update("m2", json!({ "title": "t" }))
    }
    .apply(&engine);

    remote.push(Ok(verdicts(vec![
        applied("m1", None),
        rejected(
            "m2",
            "PRECONDITION",
            Some(server_row(json!({ "likes": 1 }))),
        ),
    ])));
    engine.push_once().await.expect("the verdicts reconcile");

    assert_eq!(p1(&engine), Some(server_row(json!({ "likes": 1 }))));
}

/// An applied verdict that installs the server's row resets it too: a write
/// still queued behind the pushed slice is laid back over that row.
#[tokio::test]
async fn an_applied_server_row_keeps_a_later_pending_write_on_its_row_visible() {
    let remote = Arc::new(Script::default());
    let engine = engine_with(remote.clone());
    seed(&engine, &remote, server_row(json!({ "title": "orig" }))).await;
    Write::update("m1", json!({ "title": "one" }))
        .in_batch("b1")
        .apply(&engine);
    Write::update("m2", json!({ "title": "two" })).apply(&engine);

    remote.push(Ok(verdicts(vec![applied(
        "m1",
        Some(server_row(json!({ "title": "one" }))),
    )])));
    engine.push_once().await.expect("the verdict reconciles");

    assert_eq!(p1(&engine), Some(server_row(json!({ "title": "two" }))));
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
}

// MARK: - Dead letter

/// Dropping the head reverts its row to the head's pre-image, and the later
/// write on that row, still queued, is laid back over it.
#[tokio::test]
async fn dead_lettering_a_write_keeps_a_later_pending_write_on_its_row_visible() {
    let remote = Arc::new(Script::default());
    let engine = engine_with(remote.clone());
    seed(
        &engine,
        &remote,
        server_row(json!({ "title": "orig", "note": null })),
    )
    .await;
    Write::update("m1", json!({ "title": "one" }))
        .in_batch("b1")
        .apply(&engine);
    Write::update("m2", json!({ "note": "two" })).apply(&engine);

    for _ in 0..BUDGET {
        remote.push(Err(EngineError::permanent_remote("bad request")));
    }
    // After the drop the loop pushes the survivor, which fails in transit.
    remote.push(Err(EngineError::remote("network down")));
    for _ in 0..BUDGET {
        let _ = engine.sync().await;
    }

    let dropped = engine.list_dead_letters().unwrap();
    assert_eq!(dropped.len(), 1);
    assert_eq!(dropped[0].mutation_id, "m1");
    assert_eq!(
        p1(&engine),
        Some(server_row(json!({ "title": "orig", "note": "two" })))
    );
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
}
