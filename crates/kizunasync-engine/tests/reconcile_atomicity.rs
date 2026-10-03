//! Reconciliation is all-or-nothing against the store.
//!
//! A reconcile applies compensating reverts, advances the exactly-once watermark,
//! journals the loss and only THEN clears the outbox. If a store fault lands in
//! between and those earlier writes survive, the next push replays mutations the
//! client already compensated. Same hazard on the pull side: a half-applied page
//! under an advanced cursor is a mirror that silently lost rows.
//!
//! Every test here injects a failure mid-reconcile (a `SQLite` trigger that
//! aborts ONE statement) and asserts that NOTHING moved: outbox, rows,
//! tombstones, watermark, journal, cursor, and the event stream. The boundary
//! under test is the `store.transaction(...)` wrapper each reconcile path opens.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use async_trait::async_trait;
use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ProtocolRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::{
    BatchOutcome, Op, PullRequest, PullResponse, PushRequest, PushResponse, RowChange, Signal,
    Verdict,
};
use kizunasync_store::{LocalMutation, LocalStore};
use rusqlite::Connection;
use serde_json::{Map, json};
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

const INJECTED: &str = "injected store fault";

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

const fn no_verdicts() -> PushResponse {
    PushResponse {
        verdicts: Some(vec![]),
        signal: None,
        batch: None,
    }
}

/// Answers the sent batch with the scripted verdicts, in request order.
struct VerdictRemote {
    verdicts: Vec<Verdict>,
}

#[async_trait]
impl ProtocolRemote for VerdictRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        Ok(empty_pull())
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        Ok(PushResponse {
            verdicts: Some(self.verdicts.clone()),
            ..no_verdicts()
        })
    }
}

/// Answers the sent atomic batch with a whole-batch abort.
struct AbortRemote {
    offender_mutation_id: String,
}

#[async_trait]
impl ProtocolRemote for AbortRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        Ok(empty_pull())
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        Ok(PushResponse {
            verdicts: None,
            batch: Some(BatchOutcome {
                outcome: "aborted".into(),
                offender_mutation_id: Some(self.offender_mutation_id.clone()),
                reason: Some("CONSTRAINT".into()),
                server_row: None,
            }),
            ..no_verdicts()
        })
    }
}

/// One complete page (`has_more: false`), so a pull commits its checkpoint.
struct PageRemote {
    pks: Vec<String>,
    cursor: String,
}

#[async_trait]
impl ProtocolRemote for PageRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        Ok(PullResponse {
            cursor: self.cursor.clone(),
            has_more: false,
            rows: self
                .pks
                .iter()
                .map(|pk| RowChange {
                    table: "todos".into(),
                    pk: pk.clone(),
                    seq: "1".into(),
                    columns: server_columns(pk),
                    deleted: false,
                })
                .collect(),
            tombstones: vec![],
            signal: None,
            conflicts: None,
        })
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        Ok(no_verdicts())
    }
}

/// Replays a scripted pull sequence, one response per call; an exhausted script
/// answers with an empty page.
struct ScriptedPullRemote {
    pages: Mutex<VecDeque<PullResponse>>,
}

impl ScriptedPullRemote {
    fn new(pages: Vec<PullResponse>) -> Self {
        Self {
            pages: Mutex::new(pages.into()),
        }
    }
}

#[async_trait]
impl ProtocolRemote for ScriptedPullRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        let mut pages = self.pages.lock().expect("script");
        Ok(pages.pop_front().unwrap_or_else(empty_pull))
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        Ok(no_verdicts())
    }
}

/// One page of a MULTI-page sequence: it stages rows and moves the keyset
/// position without committing anything.
fn partial_page(pk: &str, cursor: &str) -> PullResponse {
    PullResponse {
        cursor: cursor.into(),
        has_more: true,
        rows: vec![RowChange {
            table: "todos".into(),
            pk: pk.into(),
            seq: "1".into(),
            columns: server_columns(pk),
            deleted: false,
        }],
        tombstones: vec![],
        signal: None,
        conflicts: None,
    }
}

/// I-8 shape: a signalled response carries no rows and no tombstones.
fn signal_page(signal_type: &str) -> PullResponse {
    PullResponse {
        signal: Some(Signal {
            signal_type: signal_type.into(),
        }),
        ..empty_pull()
    }
}

fn server_columns(pk: &str) -> Map<String, serde_json::Value> {
    let mut columns = Map::new();
    columns.insert("id".into(), json!(pk));
    columns.insert("owner_id".into(), json!("user-a"));
    columns.insert("title".into(), json!("from server"));
    columns
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

/// A file-backed engine: the injected trigger has to live in the same database.
fn engine_at(path: &Path, remote: Arc<dyn ProtocolRemote>) -> SyncEngine {
    let store = LocalStore::open_path(path).expect("store");
    let deps = EngineDeps {
        now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
        now_millis: Box::new(|| 1_704_067_200_000),
        ..EngineDeps::default()
    };
    SyncEngine::new(store, config(), remote, deps)
}

fn insert_todo(engine: &SyncEngine, mutation_id: &str, pk: &str, batch_id: Option<&str>) {
    let mut columns = Map::new();
    columns.insert("owner_id".into(), json!("user-a"));
    columns.insert("title".into(), json!("local"));
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

/// Run DDL/queries on the engine's database from a second connection. Triggers
/// are schema objects, so they outlive the connection that created them.
fn with_raw<R>(path: &Path, work: impl FnOnce(&Connection) -> R) -> R {
    let conn = Connection::open(path).expect("open raw");
    work(&conn)
}

fn install_trigger(path: &Path, sql: &str) {
    with_raw(path, |conn| {
        conn.execute_batch(sql).expect("install trigger");
    });
}

fn meta(path: &Path, key: &str) -> String {
    with_raw(path, |conn| {
        conn.query_row(
            "SELECT value FROM _kizunasync_meta WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .expect("meta key")
    })
}

/// A key the engine may never have written, so the test can assert "still not
/// set" as well as "still the old value".
fn meta_opt(path: &Path, key: &str) -> Option<String> {
    with_raw(path, |conn| {
        conn.query_row(
            "SELECT value FROM _kizunasync_meta WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    })
}

/// Every staged page body, oldest first: the in-progress checkpoint's page
/// set as it sits on disk.
fn pull_pages(path: &Path) -> Vec<String> {
    with_raw(path, |conn| {
        let mut stmt = conn
            .prepare("SELECT body FROM _kizunasync_pull_pages ORDER BY page_no ASC")
            .expect("prepare pull pages");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query pull pages");
        rows.map(|r| r.expect("pull page row")).collect()
    })
}

/// Abort any write of ONE meta key. Both triggers are needed because `meta_set`
/// upserts: `SQLite` fires the INSERT triggers when the row is new and the
/// UPDATE ones when the conflict clause takes over.
fn fail_meta_write(path: &Path, key: &str) {
    install_trigger(
        path,
        &format!(
            "CREATE TRIGGER fail_meta_insert BEFORE INSERT ON _kizunasync_meta
             WHEN NEW.key = '{key}'
             BEGIN SELECT RAISE(ABORT, '{INJECTED}'); END;
             CREATE TRIGGER fail_meta_update BEFORE UPDATE ON _kizunasync_meta
             WHEN NEW.key = '{key}'
             BEGIN SELECT RAISE(ABORT, '{INJECTED}'); END;"
        ),
    );
}

fn cursor(path: &Path) -> String {
    meta(path, "cursor")
}

fn pks(engine: &SyncEngine) -> Vec<String> {
    let mut out: Vec<String> = engine
        .read_local_rows("todos")
        .expect("rows")
        .into_iter()
        .map(|row| row.pk)
        .collect();
    out.sort();
    out
}

fn verdict(mutation_id: &str, kind: &str, reason: Option<&str>) -> Verdict {
    Verdict {
        mutation_id: mutation_id.into(),
        verdict: kind.into(),
        reason: reason.map(str::to_string),
        server_row: None,
    }
}

#[tokio::test]
async fn a_store_fault_mid_verdict_reconcile_changes_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let engine = engine_at(
        &path,
        Arc::new(VerdictRemote {
            verdicts: vec![
                verdict("m1", "applied", None),
                verdict("m2", "rejected", Some("CONSTRAINT")),
            ],
        }),
    );
    insert_todo(&engine, "m1", "p1", None);
    insert_todo(&engine, "m2", "p2", None);

    // Fails the LAST statement of the reconcile: by then m1's watermark, m2's
    // revert and m2's journal row have all been written.
    install_trigger(
        &path,
        &format!(
            "CREATE TRIGGER fail_clear BEFORE DELETE ON _kizunasync_outbox
             WHEN OLD.mutation_id = 'm2'
             BEGIN SELECT RAISE(ABORT, '{INJECTED}'); END;"
        ),
    );

    let error = engine
        .push_once()
        .await
        .expect_err("the store fault must surface");
    assert!(error.to_string().contains(INJECTED), "{error}");

    // Nothing of the batch survived: both writes are still queued for the retry.
    assert_eq!(engine.get_outbox_depth().expect("depth"), 2);
    assert_eq!(pks(&engine), vec!["p1".to_string(), "p2".to_string()]);
    assert!(!engine.has_tombstone("todos", "p2").expect("tombstone"));
    assert_eq!(engine.last_mutation_id().expect("watermark"), None);
    assert!(engine.list_rejections(true).expect("journal").is_empty());
    // The rejection was never durable, so the app was never told about it.
    assert!(
        !engine
            .recent_event_names()
            .contains(&"MUTATION_REJECTED".to_string())
    );
}

#[tokio::test]
async fn a_store_fault_mid_batch_abort_changes_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let engine = engine_at(
        &path,
        Arc::new(AbortRemote {
            offender_mutation_id: "m1".into(),
        }),
    );
    insert_todo(&engine, "m1", "p1", Some("B"));
    insert_todo(&engine, "m2", "p2", Some("B"));

    // Both members have been reverted by the time the outbox clear runs.
    install_trigger(
        &path,
        &format!(
            "CREATE TRIGGER fail_clear BEFORE DELETE ON _kizunasync_outbox
             WHEN OLD.mutation_id = 'm1'
             BEGIN SELECT RAISE(ABORT, '{INJECTED}'); END;"
        ),
    );

    let error = engine
        .push_once()
        .await
        .expect_err("the store fault must surface");
    assert!(error.to_string().contains(INJECTED), "{error}");

    assert_eq!(engine.get_outbox_depth().expect("depth"), 2);
    assert_eq!(pks(&engine), vec!["p1".to_string(), "p2".to_string()]);
    assert!(!engine.has_tombstone("todos", "p1").expect("tombstone"));
    assert!(!engine.has_tombstone("todos", "p2").expect("tombstone"));
    assert!(engine.list_rejections(true).expect("journal").is_empty());
    assert!(
        !engine
            .recent_event_names()
            .contains(&"BATCH_ABORTED".to_string())
    );
}

#[tokio::test]
async fn a_store_fault_mid_pull_commit_changes_nothing_and_the_retry_recovers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let engine = engine_at(
        &path,
        Arc::new(PageRemote {
            pks: vec!["p1".into(), "p2".into()],
            cursor: "10".into(),
        }),
    );

    // The page's SECOND row fails, so the first row and the cursor would be the
    // half-applied checkpoint.
    install_trigger(
        &path,
        &format!(
            "CREATE TRIGGER fail_second_row BEFORE INSERT ON _kizunasync_rows
             WHEN NEW.pk = 'p2'
             BEGIN SELECT RAISE(ABORT, '{INJECTED}'); END;"
        ),
    );

    let error = engine
        .pull_once()
        .await
        .expect_err("the store fault must surface");
    assert!(error.to_string().contains(INJECTED), "{error}");

    assert!(pks(&engine).is_empty());
    assert_eq!(cursor(&path), "0");
    assert!(
        !engine
            .recent_event_names()
            .contains(&"LOCAL_CHANGED".to_string())
    );

    // The checkpoint stayed staged, so the retry commits the page WHOLE.
    install_trigger(&path, "DROP TRIGGER fail_second_row;");
    engine.pull_once().await.expect("retry commits");
    assert_eq!(pks(&engine), vec!["p1".to_string(), "p2".to_string()]);
    assert_eq!(cursor(&path), "10");
}

/// A committed rehydration boundary must not leave the keyset position and the
/// rehydration flag behind: the next page would be a SECOND snapshot replace and
/// would drop every row it does not carry.
#[tokio::test]
async fn a_committed_checkpoint_ends_the_pagination_sequence_atomically() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let engine = engine_at(
        &path,
        Arc::new(PageRemote {
            pks: vec!["p1".into()],
            cursor: "10".into(),
        }),
    );

    engine.pull_once().await.expect("commit");

    assert_eq!(meta(&path, "page_cursor"), "");
    assert_eq!(meta(&path, "rehydrating"), "0");
}

/// `CHECKPOINT_EXPIRED` arms a snapshot REPLACE and restarts the keyset from
/// '0'. Those two facts only make sense together: a fault after the flag and
/// before the reset would leave the replace armed over a MID-PAGINATION
/// position, so the next boundary would rebuild the survivor set from the tail
/// of the sequence and drop every live row the earlier pages carried.
#[tokio::test]
async fn a_store_fault_mid_checkpoint_expired_leaves_the_sequence_untouched() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let engine = engine_at(
        &path,
        Arc::new(ScriptedPullRemote::new(vec![
            partial_page("p1", "5"),
            signal_page("CHECKPOINT_EXPIRED"),
        ])),
    );

    // Mid-sequence: one page staged, the keyset parked at '5', nothing committed.
    engine.pull_once().await.expect("stage the first page");
    assert_eq!(meta(&path, "page_cursor"), "5");
    let staged = pull_pages(&path);
    assert!(!staged.is_empty());

    // Fails the LAST write of the handler: the staging drop and the rehydration
    // flag have both been written by then.
    fail_meta_write(&path, "page_cursor");

    let error = engine
        .pull_once()
        .await
        .expect_err("the store fault must surface");
    assert!(error.to_string().contains(INJECTED), "{error}");

    assert_ne!(
        meta_opt(&path, "rehydrating").as_deref(),
        Some("1"),
        "a half-set rehydration flag would arm a snapshot replace over a partial survivor set"
    );
    assert_eq!(meta(&path, "page_cursor"), "5");
    assert_eq!(pull_pages(&path), staged);
    assert!(
        !engine
            .recent_event_names()
            .contains(&"CHECKPOINT_EXPIRED".to_string())
    );
}

/// `RESET_REQUIRED` ends the sequence and latches the soft block. A fault
/// between them would leave a client blocked from every further RPC while its
/// meta still claims a pagination sequence is running.
#[tokio::test]
async fn a_store_fault_mid_reset_required_leaves_the_sequence_untouched() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let engine = engine_at(
        &path,
        Arc::new(ScriptedPullRemote::new(vec![
            partial_page("p1", "5"),
            signal_page("RESET_REQUIRED"),
        ])),
    );

    engine.pull_once().await.expect("stage the first page");
    let staged = pull_pages(&path);

    // Fails the LAST write of the handler: staging and the pagination clear are
    // already done, so only a transaction can undo them.
    fail_meta_write(&path, "soft_blocked");

    let error = engine
        .pull_once()
        .await
        .expect_err("the store fault must surface");
    assert!(error.to_string().contains(INJECTED), "{error}");

    assert!(!engine.is_soft_blocked().expect("soft block"));
    assert_eq!(meta(&path, "page_cursor"), "5");
    assert_eq!(pull_pages(&path), staged);
    assert!(
        !engine
            .recent_event_names()
            .contains(&"RESET_REQUIRED".to_string())
    );
}
