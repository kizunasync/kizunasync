//! A malformed batch reply fails loud and reverts nothing.
//!
//! The abort path rewrites every member of the batch, so a reply the client
//! misreads does not merely return the wrong answer: it clears local writes the
//! server may still hold. Every guard therefore runs BEFORE the first store
//! write, and each case here proves one of them by asserting the typed code AND
//! that the outbox, the rows and the rejection journal are exactly as they were.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use async_trait::async_trait;
use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ProtocolRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::{
    BatchOutcome, ColumnValues, Op, PullRequest, PullResponse, PushRequest, PushResponse,
};
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::sync::Arc;

/// The authoritative row an abort would revert the offender to, if the client
/// ever got as far as reverting.
fn server_row() -> ColumnValues {
    let mut row = Map::new();
    row.insert("owner_id".into(), json!("user-a"));
    row.insert("title".into(), json!("server wins"));
    row
}

/// A remote that answers every push with the batch envelope the case is about,
/// built from the request so the offender id can name a real member.
struct AbortingRemote {
    build: Box<dyn Fn(&PushRequest) -> PushResponse + Send + Sync>,
}

impl AbortingRemote {
    fn new(build: impl Fn(&PushRequest) -> PushResponse + Send + Sync + 'static) -> Self {
        Self {
            build: Box::new(build),
        }
    }
}

#[async_trait]
impl ProtocolRemote for AbortingRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        Ok(PullResponse {
            cursor: "0".into(),
            has_more: false,
            rows: vec![],
            tombstones: vec![],
            signal: None,
            conflicts: None,
        })
    }

    async fn push(&self, req: PushRequest) -> Result<PushResponse, EngineError> {
        Ok((self.build)(&req))
    }
}

fn config() -> EngineConfig {
    let mut tables = BTreeMap::new();
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("user-a"));
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

fn engine_with(remote: Arc<dyn ProtocolRemote>) -> SyncEngine {
    let store = LocalStore::open_in_memory().expect("store");
    let deps = EngineDeps {
        now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
        now_millis: Box::new(|| 1_704_067_200_000),
        ..EngineDeps::default()
    };
    SyncEngine::new(store, config(), remote, deps)
}

/// Two writes on two rows. `batch_id` present makes the push atomic, which is
/// the only shape a conforming abort may answer.
fn apply_pair(engine: &SyncEngine, batch_id: Option<&str>) {
    for (mutation_id, pk, title) in [("m1", "p1", "a"), ("m2", "p2", "b")] {
        let mut columns = Map::new();
        columns.insert("owner_id".into(), json!("user-a"));
        columns.insert("title".into(), json!(title));
        engine
            .apply(LocalMutation {
                table: "todos".into(),
                pk: pk.into(),
                op: Op::Insert,
                columns,
                transforms: None,
                precondition: None,
                batch_id: batch_id.map(str::to_string),
                hlc: None,
                mutation_id: Some(mutation_id.into()),
            })
            .expect("apply");
    }
}

/// Nothing moved: both writes are still queued, both rows still hold what the
/// client wrote, and no rejection was journalled. A guard that fired after the
/// first store write would fail at least one of these.
fn assert_untouched(engine: &SyncEngine) {
    assert_eq!(engine.get_outbox_depth().expect("depth"), 2, "outbox");
    assert!(
        engine
            .list_rejections(false)
            .expect("rejections")
            .is_empty(),
        "a refused reply journalled a rejection"
    );
    for (pk, title) in [("p1", "a"), ("p2", "b")] {
        let row = engine
            .read_row("todos", pk)
            .expect("read")
            .expect("row present");
        assert_eq!(row.columns.get("title"), Some(&json!(title)), "row {pk}");
    }
}

/// The abort envelope every case starts from; each test spoils one field.
fn abort_naming(offender: &str) -> BatchOutcome {
    BatchOutcome {
        outcome: "aborted".into(),
        offender_mutation_id: Some(offender.into()),
        reason: Some("PRECONDITION".into()),
        server_row: Some(server_row()),
    }
}

fn second_mutation_id(req: &PushRequest) -> String {
    req.batch.mutations[1].mutation_id.clone()
}

#[tokio::test]
async fn a_batch_abort_answering_a_non_atomic_push_fails_loud_and_reverts_nothing() {
    let remote = Arc::new(AbortingRemote::new(|req| PushResponse {
        verdicts: None,
        signal: None,
        batch: Some(abort_naming(&second_mutation_id(req))),
    }));
    let engine = engine_with(remote);
    // No batch_id, so the request goes out atomic:false and cannot legally abort.
    apply_pair(&engine, None);

    let error = engine.push_once().await.expect_err("push must fail");

    assert_eq!(error.code(), error_catalog::MALFORMED_PUSH_RESPONSE);
    assert_untouched(&engine);
}

#[tokio::test]
async fn a_batch_outcome_outside_the_closed_union_fails_loud() {
    let remote = Arc::new(AbortingRemote::new(|req| PushResponse {
        verdicts: None,
        signal: None,
        batch: Some(BatchOutcome {
            outcome: "applied".into(),
            ..abort_naming(&second_mutation_id(req))
        }),
    }));
    let engine = engine_with(remote);
    apply_pair(&engine, Some("B"));

    let error = engine.push_once().await.expect_err("push must fail");

    assert_eq!(error.code(), error_catalog::MALFORMED_PUSH_RESPONSE);
    assert_untouched(&engine);
}

#[tokio::test]
async fn a_batch_reply_carrying_no_outcome_at_all_fails_loud() {
    let remote = Arc::new(AbortingRemote::new(|req| PushResponse {
        verdicts: None,
        signal: None,
        batch: Some(BatchOutcome {
            outcome: String::new(),
            ..abort_naming(&second_mutation_id(req))
        }),
    }));
    let engine = engine_with(remote);
    apply_pair(&engine, Some("B"));

    let error = engine.push_once().await.expect_err("push must fail");

    assert_eq!(error.code(), error_catalog::MALFORMED_PUSH_RESPONSE);
    assert_untouched(&engine);
}

/// A reply with neither verdicts nor a batch envelope: the client has nothing to
/// reconcile against and must say so rather than treat silence as success.
#[tokio::test]
async fn a_reply_with_neither_verdicts_nor_a_batch_fails_loud() {
    let remote = Arc::new(AbortingRemote::new(|_req| PushResponse {
        verdicts: None,
        signal: None,
        batch: None,
    }));
    let engine = engine_with(remote);
    apply_pair(&engine, Some("B"));

    let error = engine.push_once().await.expect_err("push must fail");

    assert_eq!(error.code(), error_catalog::MALFORMED_PUSH_RESPONSE);
    assert_untouched(&engine);
}

/// D-atomic-batch-abort: the abort names the one member the server refused, and the client
/// reverts every member relative to it. An offender that is not in the batch
/// leaves the client no anchor, so reverting anything would be a half-revert of
/// writes the server may still hold.
#[tokio::test]
async fn an_abort_naming_an_offender_outside_the_batch_fails_loud_never_a_half_revert() {
    let remote = Arc::new(AbortingRemote::new(|_req| PushResponse {
        verdicts: None,
        signal: None,
        batch: Some(abort_naming("00000000-0000-4000-8000-not-in-batch")),
    }));
    let engine = engine_with(remote);
    apply_pair(&engine, Some("B"));

    let error = engine.push_once().await.expect_err("push must fail");

    assert_eq!(error.code(), error_catalog::UNKNOWN_BATCH_OFFENDER);
    assert_untouched(&engine);
}
