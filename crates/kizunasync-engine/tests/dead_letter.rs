//! The dead-letter budget: the only place a queued write is dropped.
//!
//! `sync()`'s budget is the only place a queued offline write can be DROPPED, so
//! it must (1) never strand the optimistic local row, (2) drop an atomic batch
//! whole, (3) never swallow a protocol fault as if it were transport, and (4)
//! never wedge the queue: a permanent failure is charged to the slice that was
//! actually sent, and a multi-entry slice is narrowed until the culprit stands
//! alone.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use async_trait::async_trait;
use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    AttachmentSpec, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps,
    EngineError, EngineEvent, EnqueueUpload, MapAttachmentBytes, ProtocolRemote, SyncEngine,
    SyncMode, TableConfig,
};
use kizunasync_protocol::{
    Op, PullRequest, PullResponse, PushRequest, PushResponse, RowChange, Verdict,
};
use kizunasync_store::{AttachmentState, LocalMutation, LocalStore, RejectionKind};
use kizunasync_transfer::FakeTransfer;
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// The TS budget: 5 consecutive permanent failures against the same head.
const BUDGET: usize = 5;

/// The pack's SQLSTATE for a push batch over `_settings.max_batch_size`.
const KZP02: &str = "KZP02";

fn empty_pull() -> PullResponse {
    PullResponse {
        cursor: "0".into(),
        has_more: false,
        rows: vec![],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    }
}

/// A remote whose push always fails with the given classification.
struct FailingRemote {
    retryable: bool,
}

#[async_trait]
impl ProtocolRemote for FailingRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        Ok(empty_pull())
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        Err(if self.retryable {
            EngineError::remote("network down")
        } else {
            EngineError::permanent_remote("bad request")
        })
    }
}

/// 0 verdicts for 1 mutation breaks the I-5 bijection: `push_once` fails loud and
/// clears nothing, so the write must stay queued forever.
#[derive(Default)]
struct EmptyVerdictRemote {
    pulls: AtomicUsize,
}

#[async_trait]
impl ProtocolRemote for EmptyVerdictRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        self.pulls.fetch_add(1, Ordering::SeqCst);
        Ok(empty_pull())
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        Ok(PushResponse {
            verdicts: Some(vec![]),
            signal: None,
            batch: None,
        })
    }
}

/// The fault a push answers with, decided from the mutation ids it carries.
type Refusal = Box<dyn Fn(&[String]) -> Option<EngineError> + Send + Sync>;

/// Refuses a push when `refuse` names a fault for it and otherwise applies every
/// mutation it carries. Records the mutation ids of every push, counts the
/// pulls, and hands out `page` on the first pull.
struct RuleRemote {
    refuse: Refusal,
    sent: Mutex<Vec<Vec<String>>>,
    pulls: AtomicUsize,
    page: Mutex<Option<PullResponse>>,
}

impl RuleRemote {
    fn new(refuse: Refusal) -> Self {
        Self {
            refuse,
            sent: Mutex::new(Vec::new()),
            pulls: AtomicUsize::new(0),
            page: Mutex::new(None),
        }
    }

    /// Every push containing `culprit` is refused for good.
    fn culprit(culprit: &'static str) -> Self {
        Self::new(Box::new(move |ids| {
            ids.iter()
                .any(|id| id == culprit)
                .then(|| EngineError::permanent_remote("bad request"))
        }))
    }

    /// The pack's batch cap: a push over `max` mutations is refused with the
    /// server's `KZP02` message and code.
    fn batch_limit(max: usize) -> Self {
        Self::new(Box::new(move |ids| {
            (ids.len() > max).then(|| {
                EngineError::permanent_remote(batch_message(ids.len(), max))
                    .with_code(Some(KZP02.into()))
            })
        }))
    }

    fn with_page(self, page: PullResponse) -> Self {
        *self.page.lock().unwrap() = Some(page);
        self
    }

    fn sent(&self) -> Vec<Vec<String>> {
        self.sent.lock().unwrap().clone()
    }

    fn sent_sizes(&self) -> Vec<usize> {
        self.sent().iter().map(Vec::len).collect()
    }

    fn pulls(&self) -> usize {
        self.pulls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl ProtocolRemote for RuleRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        self.pulls.fetch_add(1, Ordering::SeqCst);
        Ok(self.page.lock().unwrap().take().unwrap_or_else(empty_pull))
    }

    async fn push(&self, req: PushRequest) -> Result<PushResponse, EngineError> {
        let ids: Vec<String> = req
            .batch
            .mutations
            .iter()
            .map(|m| m.mutation_id.clone())
            .collect();
        self.sent.lock().unwrap().push(ids.clone());
        if let Some(error) = (self.refuse)(&ids) {
            return Err(error);
        }
        Ok(PushResponse {
            verdicts: Some(
                req.batch
                    .mutations
                    .iter()
                    .map(|m| Verdict {
                        mutation_id: m.mutation_id.clone(),
                        verdict: "applied".into(),
                        reason: None,
                        server_row: Some(m.columns.clone()),
                    })
                    .collect(),
            ),
            signal: None,
            batch: None,
        })
    }
}

/// The text `kizunasync.push()` raises with `KZP02`.
fn batch_message(size: usize, max: usize) -> String {
    format!("kizunasync.push(): batch of {size} mutations exceeds max_batch_size {max}")
}

fn ids(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_string()).collect()
}

fn config_with(attachments: BTreeMap<String, AttachmentSpec>) -> EngineConfig {
    let mut tables = BTreeMap::new();
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("user-a"));
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
    EngineConfig {
        tables,
        schema_version: 1,
        default_limit: None,
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
        client_id: "c1".into(),
    }
}

fn config() -> EngineConfig {
    config_with(BTreeMap::new())
}

fn deps() -> EngineDeps {
    EngineDeps {
        now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
        now_millis: Box::new(|| 1_704_067_200_000),
        ..EngineDeps::default()
    }
}

fn engine_with(remote: Arc<dyn ProtocolRemote>) -> SyncEngine {
    let store = LocalStore::open_in_memory().expect("store");
    SyncEngine::new(store, config(), remote, deps())
}

fn insert_todo(engine: &SyncEngine, mutation_id: &str, pk: &str, batch_id: Option<&str>) {
    let mut columns = Map::new();
    columns.insert("id".into(), json!(pk));
    columns.insert("owner_id".into(), json!("user-a"));
    columns.insert("title".into(), json!("hi"));
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

async fn sync_n(engine: &SyncEngine, times: usize) {
    for _ in 0..times {
        let _ = engine.sync().await;
    }
}

fn row_exists(engine: &SyncEngine, pk: &str) -> bool {
    engine
        .read_all_rows("todos")
        .expect("read")
        .iter()
        .any(|row| row.get("id").and_then(|v| v.as_str()) == Some(pk))
}

fn dead_lettered(engine: &SyncEngine) -> Vec<String> {
    engine
        .list_dead_letters()
        .expect("dead letters")
        .into_iter()
        .map(|entry| entry.mutation_id)
        .collect()
}

/// A page carrying one server row, `p9`, which only a pull can land.
fn page_with_p9() -> PullResponse {
    let mut columns = Map::new();
    columns.insert("id".into(), json!("p9"));
    columns.insert("owner_id".into(), json!("user-a"));
    columns.insert("title".into(), json!("from the server"));
    PullResponse {
        cursor: "9".into(),
        rows: vec![RowChange {
            table: "todos".into(),
            pk: "p9".into(),
            seq: "9".into(),
            columns,
            deleted: false,
        }],
        ..empty_pull()
    }
}

// MARK: - The five-attempt budget

#[tokio::test]
async fn dead_lettering_a_failed_write_reverts_the_optimistic_local_row() {
    let engine = engine_with(Arc::new(FailingRemote { retryable: false }));
    insert_todo(&engine, "m1", "p1", None);
    assert!(row_exists(&engine, "p1"));

    sync_n(&engine, BUDGET).await;

    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    assert!(
        engine
            .recent_event_names()
            .contains(&"DEAD_LETTER".to_string())
    );
    // Reverted to the pre-image (absent), not stranded.
    assert!(!row_exists(&engine, "p1"));

    let journal = engine.list_rejections(false).expect("journal");
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].mutation_id, "m1");
    assert_eq!(journal[0].kind, RejectionKind::DeadLetter);
    assert_eq!(journal[0].reason, "PERMANENT_TRANSPORT");
    assert_eq!(journal[0].at, 1_704_067_200_000);
    assert!(journal[0].changed_columns.contains(&"title".to_string()));
}

#[tokio::test]
async fn the_budget_only_burns_on_the_last_attempt() {
    let engine = engine_with(Arc::new(FailingRemote { retryable: false }));
    insert_todo(&engine, "m1", "p1", None);

    // One attempt short of the budget: still queued, and every attempt failed loud.
    for _ in 0..(BUDGET - 1) {
        assert!(engine.sync().await.is_err());
    }
    assert_eq!(engine.get_outbox_depth().expect("depth"), 1);
    assert!(
        !engine
            .recent_event_names()
            .contains(&"DEAD_LETTER".to_string())
    );

    // The budget-exhausting attempt drops the write instead of raising.
    engine.sync().await.expect("budget exhausted, not an error");
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    assert!(
        engine
            .recent_event_names()
            .contains(&"DEAD_LETTER".to_string())
    );
}

#[tokio::test]
async fn dead_lettering_an_atomic_batch_drops_and_reverts_the_whole_batch() {
    let engine = engine_with(Arc::new(FailingRemote { retryable: false }));
    insert_todo(&engine, "m1", "p1", Some("B"));
    insert_todo(&engine, "m2", "p2", Some("B"));

    sync_n(&engine, BUDGET).await;

    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    assert!(!row_exists(&engine, "p1"));
    assert!(!row_exists(&engine, "p2"));

    let dropped = engine.list_dead_letters().expect("dead letters");
    assert_eq!(dropped.len(), 2);
    // Reverted last-applied first, so the forensic rows land in reverse order.
    assert_eq!(dropped[0].mutation_id, "m2");
    assert_eq!(dropped[1].mutation_id, "m1");
}

#[tokio::test]
async fn a_retryable_transport_error_never_dead_letters() {
    let engine = engine_with(Arc::new(FailingRemote { retryable: true }));
    insert_todo(&engine, "m1", "p1", None);

    // Far past the budget.
    sync_n(&engine, 20).await;

    assert_eq!(engine.get_outbox_depth().expect("depth"), 1);
    assert!(
        !engine
            .recent_event_names()
            .contains(&"DEAD_LETTER".to_string())
    );
    assert!(row_exists(&engine, "p1"));
    assert!(engine.list_dead_letters().expect("dead letters").is_empty());
}

#[tokio::test]
async fn a_protocol_fault_is_never_dead_lettered() {
    let remote = Arc::new(EmptyVerdictRemote::default());
    let engine = engine_with(remote.clone());
    insert_todo(&engine, "m1", "p1", None);

    for _ in 0..(BUDGET + 2) {
        // Fails loud EVERY time (VERDICT_BIJECTION) and is never counted against
        // the budget: a protocol fault is not a transport fault, so it always
        // throws rather than counting toward a drop.
        let error = engine
            .sync()
            .await
            .expect_err("a protocol fault must throw");
        assert_eq!(error.code(), error_catalog::VERDICT_BIJECTION);
    }

    assert_eq!(engine.get_outbox_depth().expect("depth"), 1);
    assert!(
        !engine
            .recent_event_names()
            .contains(&"DEAD_LETTER".to_string())
    );
    assert!(row_exists(&engine, "p1"));
    // Not a transport fault, so the pull half still ran every time.
    assert_eq!(remote.pulls.load(Ordering::SeqCst), BUDGET + 2);
}

#[tokio::test]
async fn a_successful_push_resets_the_streak() {
    /// Fails permanently for the first `fail_times` pushes, then applies.
    struct FlakyRemote {
        fail_times: std::sync::Mutex<usize>,
    }

    #[async_trait]
    impl ProtocolRemote for FlakyRemote {
        async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
            Ok(empty_pull())
        }

        async fn push(&self, req: PushRequest) -> Result<PushResponse, EngineError> {
            let mut remaining = self
                .fail_times
                .lock()
                .map_err(|_| EngineError::remote("lock"))?;
            if *remaining > 0 {
                *remaining -= 1;
                return Err(EngineError::permanent_remote("bad request"));
            }
            Ok(PushResponse {
                verdicts: Some(
                    req.batch
                        .mutations
                        .iter()
                        .map(|m| kizunasync_protocol::Verdict {
                            mutation_id: m.mutation_id.clone(),
                            verdict: "applied".into(),
                            reason: None,
                            server_row: Some(m.columns.clone()),
                        })
                        .collect(),
                ),
                signal: None,
                batch: None,
            })
        }
    }

    let engine = engine_with(Arc::new(FlakyRemote {
        fail_times: std::sync::Mutex::new(BUDGET - 1),
    }));
    insert_todo(&engine, "m1", "p1", None);

    sync_n(&engine, BUDGET).await;

    // The 5th push succeeded, so the streak never reached the budget.
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    assert!(
        !engine
            .recent_event_names()
            .contains(&"DEAD_LETTER".to_string())
    );
    assert!(row_exists(&engine, "p1"));
}

// MARK: - Narrowing a multi-entry slice

/// The whole run fails, the head is sent alone, and only the head is charged:
/// once the budget drops it, the rest of the run applies.
#[tokio::test]
async fn a_failing_head_is_isolated_and_dead_lettered_while_its_siblings_apply() {
    let remote = Arc::new(RuleRemote::culprit("m1"));
    let engine = engine_with(remote.clone());
    insert_todo(&engine, "m1", "p1", None);
    insert_todo(&engine, "m2", "p2", None);
    insert_todo(&engine, "m3", "p3", None);

    sync_n(&engine, BUDGET).await;

    assert_eq!(dead_lettered(&engine), ids(&["m1"]));
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    assert!(!row_exists(&engine, "p1"));
    assert!(row_exists(&engine, "p2"));
    assert!(row_exists(&engine, "p3"));
    assert_eq!(
        remote.sent(),
        vec![
            ids(&["m1", "m2", "m3"]),
            ids(&["m1"]),
            ids(&["m1"]),
            ids(&["m1"]),
            ids(&["m1"]),
            ids(&["m1"]),
            ids(&["m2", "m3"]),
        ]
    );
}

/// A culprit behind the head: the isolated head applies, the rest of the run
/// fails again, and its new head is the one sent alone and charged.
#[tokio::test]
async fn a_culprit_behind_the_head_is_narrowed_to_and_dead_lettered_alone() {
    let remote = Arc::new(RuleRemote::culprit("m2"));
    let engine = engine_with(remote.clone());
    insert_todo(&engine, "m1", "p1", None);
    insert_todo(&engine, "m2", "p2", None);
    insert_todo(&engine, "m3", "p3", None);

    sync_n(&engine, BUDGET).await;

    assert_eq!(dead_lettered(&engine), ids(&["m2"]));
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    assert!(row_exists(&engine, "p1"));
    assert!(!row_exists(&engine, "p2"));
    assert!(row_exists(&engine, "p3"));
    assert_eq!(
        remote.sent(),
        vec![
            ids(&["m1", "m2", "m3"]),
            ids(&["m1"]),
            ids(&["m2", "m3"]),
            ids(&["m2"]),
            ids(&["m2"]),
            ids(&["m2"]),
            ids(&["m2"]),
            ids(&["m2"]),
            ids(&["m3"]),
        ]
    );
}

/// An unbatched head followed by an atomic batch rides alone, so the failure is
/// its own: it is charged, and dropping it lets the batch apply.
#[tokio::test]
async fn an_unbatched_head_ahead_of_a_batch_owns_its_failure() {
    let remote = Arc::new(RuleRemote::culprit("m1"));
    let engine = engine_with(remote.clone());
    insert_todo(&engine, "m1", "p1", None);
    insert_todo(&engine, "m2", "p2", Some("B"));
    insert_todo(&engine, "m3", "p3", Some("B"));

    sync_n(&engine, BUDGET).await;

    assert_eq!(dead_lettered(&engine), ids(&["m1"]));
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    assert!(row_exists(&engine, "p2"));
    assert!(row_exists(&engine, "p3"));
    let mut expected = vec![ids(&["m1"]); BUDGET];
    expected.push(ids(&["m2", "m3"]));
    assert_eq!(remote.sent(), expected);
}

/// An unbatched run ahead of an atomic batch is narrowed like any other run,
/// and the batch behind it never joins the unbatched slice.
#[tokio::test]
async fn an_unbatched_run_ahead_of_a_batch_is_narrowed_to_its_culprit() {
    let remote = Arc::new(RuleRemote::culprit("m2"));
    let engine = engine_with(remote.clone());
    insert_todo(&engine, "m1", "p1", None);
    insert_todo(&engine, "m2", "p2", None);
    insert_todo(&engine, "m3", "p3", Some("B"));

    sync_n(&engine, BUDGET).await;

    assert_eq!(dead_lettered(&engine), ids(&["m2"]));
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    assert!(row_exists(&engine, "p1"));
    assert!(row_exists(&engine, "p3"));
    let mut expected = vec![ids(&["m1", "m2"]), ids(&["m1"])];
    expected.extend(vec![ids(&["m2"]); BUDGET]);
    expected.push(ids(&["m3"]));
    assert_eq!(remote.sent(), expected);
}

/// `KZP02` names the slice size, not a write: the slice is halved and resent
/// at once until the server takes it, and the cap holds for the rest of the
/// drain, so nothing is charged and nothing is dropped.
#[tokio::test]
async fn kzp02_halves_the_slice_until_the_server_takes_it() {
    for (max, sizes) in [
        (1, vec![5, 2, 1, 1, 1, 1, 1]),
        (2, vec![5, 2, 2, 1]),
        (4, vec![5, 2, 2, 1]),
    ] {
        let remote = Arc::new(RuleRemote::batch_limit(max));
        let engine = engine_with(remote.clone());
        for i in 1..=5 {
            insert_todo(&engine, &format!("m{i}"), &format!("p{i}"), None);
        }

        engine
            .sync()
            .await
            .unwrap_or_else(|error| panic!("max {max}: {error}"));

        assert_eq!(remote.sent_sizes(), sizes, "max {max}");
        assert_eq!(engine.get_outbox_depth().expect("depth"), 0, "max {max}");
        assert!(dead_lettered(&engine).is_empty(), "max {max}");
        assert!(engine.list_rejections(true).expect("journal").is_empty());
    }
}

/// An atomic batch cannot be split, so a batch over the server's cap can never
/// apply: it is dropped whole on the first refusal, with the server's words.
#[tokio::test]
async fn kzp02_on_an_atomic_batch_dead_letters_it_at_once_with_the_server_message() {
    let remote = Arc::new(RuleRemote::batch_limit(2));
    let engine = engine_with(remote.clone());
    let reasons = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&reasons);
    let _unsubscribe = engine.subscribe(Arc::new(move |event: EngineEvent| {
        if let EngineEvent::DeadLetter {
            mutation_id,
            reason,
        } = event
        {
            recorder.lock().unwrap().push((mutation_id, reason));
        }
    }));
    insert_todo(&engine, "m1", "p1", Some("B"));
    insert_todo(&engine, "m2", "p2", Some("B"));
    insert_todo(&engine, "m3", "p3", Some("B"));

    engine.sync().await.expect("the drop settles the push");

    let message = batch_message(3, 2);
    assert_eq!(remote.sent(), vec![ids(&["m1", "m2", "m3"])]);
    assert_eq!(engine.get_outbox_depth().expect("depth"), 0);
    let dropped = engine.list_dead_letters().expect("dead letters");
    assert_eq!(
        dropped
            .iter()
            .map(|entry| (entry.mutation_id.as_str(), entry.reason.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("m3", message.as_str()),
            ("m2", message.as_str()),
            ("m1", message.as_str()),
        ]
    );
    for pk in ["p1", "p2", "p3"] {
        assert!(!row_exists(&engine, pk), "{pk} reverted");
    }
    let journal = engine.list_rejections(false).expect("journal");
    assert_eq!(journal.len(), 3);
    for record in &journal {
        assert_eq!(record.kind, RejectionKind::DeadLetter);
        assert_eq!(record.reason, message);
    }
    assert_eq!(
        *reasons.lock().unwrap(),
        vec![
            ("m1".to_string(), message.clone()),
            ("m2".to_string(), message.clone()),
            ("m3".to_string(), message),
        ]
    );
}

/// The narrowing is `sync()`'s alone: a raw `push_once`, which the conformance
/// corpus drives, sends the full slice whatever the budget learned.
#[tokio::test]
async fn a_raw_push_once_sends_the_full_slice_whatever_the_budget_narrowed() {
    let remote = Arc::new(RuleRemote::culprit("m1"));
    let engine = engine_with(remote.clone());
    insert_todo(&engine, "m1", "p1", None);
    insert_todo(&engine, "m2", "p2", None);
    insert_todo(&engine, "m3", "p3", None);

    engine.sync().await.expect_err("the isolated head fails");
    engine.push_once().await.expect_err("the full slice fails");

    assert_eq!(
        remote.sent(),
        vec![
            ids(&["m1", "m2", "m3"]),
            ids(&["m1"]),
            ids(&["m1", "m2", "m3"]),
        ]
    );
}

// MARK: - The pull half after a failed push

/// A permanent push failure does not hold remote rows back: the pull still
/// runs, and the push failure is what `sync()` reports.
#[tokio::test]
async fn a_permanent_push_failure_still_pulls_and_reports_the_push_failure() {
    let remote = Arc::new(RuleRemote::culprit("m1").with_page(page_with_p9()));
    let engine = engine_with(remote.clone());
    insert_todo(&engine, "m1", "p1", None);

    let error = engine.sync().await.expect_err("the push failure surfaces");

    assert_eq!(error.code(), error_catalog::PERMANENT_TRANSPORT);
    assert_eq!(remote.pulls(), 1);
    assert!(row_exists(&engine, "p9"));
    assert_eq!(engine.get_checkpoint().expect("checkpoint"), "9");
    assert_eq!(engine.get_outbox_depth().expect("depth"), 1);
}

/// A retryable failure is the network or the session, which the pull would hit
/// the same way: `sync()` stops at the push.
#[tokio::test]
async fn a_retryable_push_failure_skips_the_pull() {
    let remote = Arc::new(
        RuleRemote::new(Box::new(|_| Some(EngineError::remote("network down"))))
            .with_page(page_with_p9()),
    );
    let engine = engine_with(remote.clone());
    insert_todo(&engine, "m1", "p1", None);

    let error = engine.sync().await.expect_err("the push failure surfaces");

    assert_eq!(error.code(), error_catalog::REMOTE);
    assert_eq!(remote.pulls(), 0);
    assert!(!row_exists(&engine, "p9"));
    assert_eq!(engine.get_checkpoint().expect("checkpoint"), "0");
}

/// The bytes follow the ref column to the server, never ahead of it: a push
/// that failed keeps the attachment queue parked until a push lands.
#[tokio::test]
async fn the_attachment_drive_waits_for_a_clean_push() {
    const REFERENCE: &str = "user-a/p1/up1.png";
    let refusing = Arc::new(AtomicBool::new(true));
    let gate = Arc::clone(&refusing);
    let remote = Arc::new(RuleRemote::new(Box::new(move |_| {
        gate.load(Ordering::SeqCst)
            .then(|| EngineError::permanent_remote("bad request"))
    })));
    let transfer = Arc::new(FakeTransfer::new());
    let bytes = Arc::new(MapAttachmentBytes::new());
    bytes.insert("/sandbox/up1.png", b"png-bytes".to_vec());
    let mut attachments = BTreeMap::new();
    attachments.insert(
        "photo".to_string(),
        AttachmentSpec {
            storage_bucket: "media".into(),
            owner_column: "owner_id".into(),
        },
    );
    let engine = SyncEngine::new(
        LocalStore::open_in_memory().expect("store"),
        config_with(attachments),
        remote.clone(),
        deps(),
    )
    .with_transfer(transfer.clone())
    .with_attachment_bytes(bytes);
    engine.set_remote_access_token(Some(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWEifQ.c2ln".into(),
    ));
    let mut columns = Map::new();
    columns.insert("owner_id".into(), json!("user-a"));
    columns.insert("photo".into(), json!(REFERENCE));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m1".into()),
        })
        .expect("apply the ref");
    engine
        .enqueue_upload(EnqueueUpload {
            reference: REFERENCE.into(),
            upload_id: "up1".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "user-a".into(),
            local_path: "/sandbox/up1.png".into(),
            size: 9,
            sha256: Some("deadbeef".into()),
            content_type: Some("image/png".into()),
        })
        .expect("enqueue");

    engine.sync().await.expect_err("the push failure surfaces");

    assert_eq!(remote.pulls(), 1, "the pull half still ran");
    assert!(transfer.confirmed.lock().unwrap().is_empty());
    let parked = engine
        .attachment_status(REFERENCE)
        .expect("status")
        .expect("present");
    assert_eq!(parked.state, AttachmentState::Queued);

    refusing.store(false, Ordering::SeqCst);
    engine.sync().await.expect("a clean push");

    assert_eq!(transfer.confirmed.lock().unwrap().len(), 1);
    let synced = engine
        .attachment_status(REFERENCE)
        .expect("status")
        .expect("present");
    assert_eq!(synced.state, AttachmentState::Synced);
}
