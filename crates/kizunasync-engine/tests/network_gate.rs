//! Local work never waits for the network.
//!
//! The calls that pull or push (`sync`, `sync_push`, `sync_pull`,
//! `push_once`, `pull_once`), the attachment download and vacuum, and the
//! calls that must not interleave with them (`reset`, `seed_checkpoint`) take
//! the engine's gate and run one at a time.
//! Local reads and writes never take it, so they answer while a network call
//! awaits the remote. Every test drives its futures on one current-thread
//! runtime, the way a bridge drives one engine on one thread.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use async_trait::async_trait;
use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ProtocolRemote, SyncEngine, SyncMode, TableConfig, clock, rpc,
};
use kizunasync_protocol::{
    Conflict, Op, PullRequest, PullResponse, PushRequest, PushResponse, RowChange, Verdict,
};
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;
use tokio::sync::{Notify, Semaphore};

/// How long a test waits for the engine before it fails instead of hanging.
const BOUND: Duration = Duration::from_secs(5);

// MARK: - A remote the test holds

/// A remote whose pulls wait until the test lets them through, counting how
/// many are in flight at once.
struct HeldRemote {
    /// One permit per pull the test lets through.
    released: Semaphore,
    /// Woken each time a pull reaches the remote.
    entered: Notify,
    in_flight: AtomicUsize,
    most_in_flight: AtomicUsize,
    pulls: Mutex<Vec<PullRequest>>,
    answers: Mutex<VecDeque<Result<PullResponse, EngineError>>>,
}

impl HeldRemote {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            released: Semaphore::new(0),
            entered: Notify::new(),
            in_flight: AtomicUsize::new(0),
            most_in_flight: AtomicUsize::new(0),
            pulls: Mutex::new(Vec::new()),
            answers: Mutex::new(VecDeque::new()),
        })
    }

    fn answer(&self, answer: Result<PullResponse, EngineError>) {
        self.answers.lock().unwrap().push_back(answer);
    }

    fn release(&self, pulls: usize) {
        self.released.add_permits(pulls);
    }

    fn pulls(&self) -> Vec<PullRequest> {
        self.pulls.lock().unwrap().clone()
    }

    fn last_pull(&self) -> PullRequest {
        self.pulls().pop().expect("a pull reached the remote")
    }
}

#[async_trait]
impl ProtocolRemote for HeldRemote {
    async fn pull(&self, req: PullRequest) -> Result<PullResponse, EngineError> {
        self.pulls.lock().unwrap().push(req);
        let now_in_flight = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_in_flight
            .fetch_max(now_in_flight, Ordering::SeqCst);
        self.entered.notify_one();

        self.released.acquire().await.unwrap().forget();
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(page("0", false, &[])))
    }

    async fn push(&self, req: PushRequest) -> Result<PushResponse, EngineError> {
        let verdicts = req
            .batch
            .mutations
            .iter()
            .map(|mutation| Verdict {
                mutation_id: mutation.mutation_id.clone(),
                verdict: "applied".into(),
                reason: None,
                server_row: Some(mutation.columns.clone()),
            })
            .collect();
        Ok(PushResponse {
            verdicts: Some(verdicts),
            signal: None,
            batch: None,
        })
    }
}

// MARK: - Engines, pages, and calls

fn params(pairs: &[(&str, &str)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), json!(value)))
        .collect()
}

fn todos_config() -> EngineConfig {
    let mut tables = BTreeMap::new();
    tables.insert(
        "todos".to_string(),
        TableConfig {
            bucket_column: "owner_id".into(),
            bucket_params: params(&[("owner_id", "u1")]),
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

/// `todos`, bucketed on `owner_id`, opened with `owner_id` set to `u1`.
fn engine(remote: &Arc<HeldRemote>) -> SyncEngine {
    SyncEngine::new(
        LocalStore::open_in_memory().unwrap(),
        todos_config(),
        Arc::clone(remote) as Arc<dyn ProtocolRemote>,
        EngineDeps {
            now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
            now_millis: Box::new(|| 1_704_067_200_000),
            ..EngineDeps::default()
        },
    )
}

fn page(cursor: &str, has_more: bool, rows: &[(&str, &str)]) -> PullResponse {
    PullResponse {
        cursor: cursor.into(),
        has_more,
        rows: rows
            .iter()
            .map(|(pk, owner)| RowChange {
                table: "todos".into(),
                pk: (*pk).into(),
                seq: cursor.into(),
                columns: params(&[("owner_id", owner)]),
                deleted: false,
            })
            .collect(),
        tombstones: vec![],
        signal: None,
        conflicts: None,
    }
}

fn insert(pk: &str) -> LocalMutation {
    LocalMutation {
        table: "todos".into(),
        pk: pk.into(),
        op: Op::Insert,
        columns: params(&[("owner_id", "u1"), ("title", "works on a plane")]),
        transforms: None,
        precondition: None,
        batch_id: None,
        hlc: None,
        mutation_id: Some(format!("m-{pk}")),
    }
}

fn local_pks(engine: &SyncEngine) -> Vec<String> {
    engine
        .read_local_rows("todos")
        .unwrap()
        .into_iter()
        .map(|row| row.pk)
        .collect()
}

/// One call through the JSON surface every bridge dispatches on, as its
/// decoded envelope.
async fn call(engine: &SyncEngine, method: &str, params: Value) -> Value {
    serde_json::from_str(&rpc::dispatch(engine, method, &params.to_string()).await).unwrap()
}

/// Poll `future` once and hand back what it answered, `Pending` included.
async fn poll_once<F: Future + Unpin>(future: &mut F) -> Poll<F::Output> {
    std::future::poll_fn(|cx| Poll::Ready(Pin::new(&mut *future).poll(cx))).await
}

// MARK: - Network calls run one at a time

/// The second sync reaches the remote only after the first one returned, so
/// the remote never holds two of this engine's pulls at once.
#[tokio::test]
async fn two_syncs_run_one_at_a_time() {
    let remote = HeldRemote::new();
    let engine = engine(&remote);

    let hold = async {
        remote.entered.notified().await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            remote.pulls().len(),
            1,
            "the second sync reached the remote while the first one awaited it"
        );
        remote.release(2);
    };
    let (first, second, ()) = tokio::join!(engine.sync(), engine.sync(), hold);

    first.expect("first sync");
    second.expect("second sync");
    assert_eq!(remote.pulls().len(), 2);
    assert_eq!(remote.most_in_flight.load(Ordering::SeqCst), 1);
}

/// A write, a read and the queue depth answer through the bridge surface
/// while a sync awaits the remote, and the write survives the page the sync
/// commits after them.
#[tokio::test]
async fn local_calls_answer_while_a_sync_awaits_the_remote() {
    let remote = HeldRemote::new();
    remote.answer(Ok(page("5", false, &[("p1", "u1")])));
    let engine = engine(&remote);

    let local = async {
        remote.entered.notified().await;
        let mutation = serde_json::to_value(insert("p2")).unwrap();
        let applied = call(&engine, "apply", mutation).await;
        let read = call(&engine, "query", json!({ "table": "todos" })).await;
        let depth = call(&engine, "outbox_depth", json!({})).await;
        let direct = engine
            .query("todos", &kizunasync_query::QueryPlan::default())
            .unwrap();
        remote.release(1);
        (applied, read, depth, direct)
    };
    let (synced, (applied, read, depth, direct)) = tokio::time::timeout(BOUND, async {
        tokio::join!(call(&engine, "sync", json!({})), local)
    })
    .await
    .expect("a local call waited for the sync");

    assert_eq!(applied, json!({ "ok": true, "value": null }));
    assert_eq!(read["value"][0]["id"], json!("p2"), "{read}");
    assert_eq!(depth, json!({ "ok": true, "value": 1 }));
    assert_eq!(serde_json::to_value(direct).unwrap()[0]["id"], json!("p2"));
    assert_eq!(synced, json!({ "ok": true, "value": null }));
    assert_eq!(local_pks(&engine), vec!["p1", "p2"]);
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
}

/// A reset waits for the sync in flight, so it wipes the page that sync
/// commits instead of being overwritten by it.
#[tokio::test]
async fn reset_waits_for_the_sync_in_flight() {
    let remote = HeldRemote::new();
    remote.answer(Ok(page("5", false, &[("p1", "u1")])));
    let engine = engine(&remote);

    let local = async {
        remote.entered.notified().await;
        let mut reset = pin!(engine.reset());
        assert!(
            poll_once(&mut reset).await.is_pending(),
            "the reset ran while a sync awaited the remote"
        );
        remote.release(1);
        reset.await
    };
    let (synced, reset) = tokio::join!(engine.sync(), local);

    synced.expect("sync");
    reset.expect("reset");
    assert!(local_pks(&engine).is_empty());
    assert_eq!(engine.get_checkpoint().unwrap(), "0");
}

/// A seeded checkpoint waits for the pull in flight, so the pull's commit
/// cannot overwrite it.
#[tokio::test]
async fn seeding_a_checkpoint_waits_for_the_pull_in_flight() {
    let remote = HeldRemote::new();
    remote.answer(Ok(page("5", false, &[])));
    let engine = engine(&remote);

    let local = async {
        remote.entered.notified().await;
        let mut seed = pin!(engine.seed_checkpoint("42"));
        assert!(
            poll_once(&mut seed).await.is_pending(),
            "the seed ran while a pull awaited the remote"
        );
        remote.release(1);
        seed.await
    };
    let (pulled, seeded) = tokio::join!(engine.pull_once(), local);

    pulled.expect("pull");
    seeded.expect("seed");
    assert_eq!(engine.get_checkpoint().unwrap(), "42");
}

/// A download waits for the sync in flight, so the attachment branch of that
/// sync can never reclaim the claim the download holds.
#[tokio::test]
async fn resolving_a_download_waits_for_the_sync_in_flight() {
    let remote = HeldRemote::new();
    let engine = engine(&remote);

    let local = async {
        remote.entered.notified().await;
        let mut download = pin!(engine.resolve_download("u1/p1/photo.png"));
        assert!(
            poll_once(&mut download).await.is_pending(),
            "the download ran while a sync awaited the remote"
        );
        remote.release(1);
        download.await
    };
    let (synced, resolved) = tokio::join!(engine.sync(), local);

    synced.expect("sync");
    assert_eq!(resolved.expect("resolve"), None);
}

/// The vacuum waits for the sync in flight like every call that reaches
/// Storage.
#[tokio::test]
async fn vacuuming_waits_for_the_sync_in_flight() {
    let remote = HeldRemote::new();
    let engine = engine(&remote);

    let local = async {
        remote.entered.notified().await;
        let mut vacuum = pin!(engine.vacuum_attachments());
        assert!(
            poll_once(&mut vacuum).await.is_pending(),
            "the vacuum ran while a sync awaited the remote"
        );
        remote.release(1);
        vacuum.await
    };
    let (synced, vacuumed) = tokio::join!(engine.sync(), local);

    synced.expect("sync");
    vacuumed.expect("vacuum");
}

// MARK: - A scope replaced while a pull awaits

/// `set_bucket` answers while a pull awaits the remote, and a new value
/// replaces the scope that pull was asked under: the answer commits nothing,
/// and the next pull starts over from `"0"` under the new scope.
#[tokio::test]
async fn a_pull_answered_under_a_replaced_scope_commits_nothing() {
    let remote = HeldRemote::new();
    let engine = engine(&remote);
    engine.seed_checkpoint("3").await.unwrap();
    remote.answer(Ok(page("5", false, &[("a1", "u1")])));

    let rescope = async {
        remote.entered.notified().await;
        let answered = call(
            &engine,
            "set_bucket",
            json!({ "params": { "owner_id": "u2" } }),
        )
        .await;
        remote.release(1);
        answered
    };
    let (pulled, rescoped) = tokio::join!(call(&engine, "pull_once", json!({})), rescope);

    assert_eq!(rescoped, json!({ "ok": true, "value": null }));
    assert_eq!(pulled, json!({ "ok": true, "value": null }));
    assert!(
        local_pks(&engine).is_empty(),
        "the old scope's page committed"
    );
    assert_eq!(engine.get_checkpoint().unwrap(), "3");

    remote.answer(Ok(page("9", false, &[("b1", "u2")])));
    remote.release(1);
    engine.pull_once().await.expect("the new scope's bootstrap");

    let bootstrap = remote.last_pull();
    assert_eq!(bootstrap.cursor, "0");
    assert_eq!(bootstrap.buckets[0].params["owner_id"], json!("u2"));
    assert_eq!(local_pks(&engine), vec!["b1"]);
    assert_eq!(engine.get_checkpoint().unwrap(), "9");
}

/// A page of a longer sequence answered under the replaced scope is not
/// staged, and its keyset position does not replace the restart from `"0"`.
#[tokio::test]
async fn a_page_answered_under_a_replaced_scope_is_not_staged() {
    let remote = HeldRemote::new();
    let engine = engine(&remote);
    engine.seed_checkpoint("3").await.unwrap();
    remote.answer(Ok(page("4", true, &[("a1", "u1")])));

    let rescope = async {
        remote.entered.notified().await;
        engine
            .set_bucket_params(&params(&[("owner_id", "u2")]))
            .unwrap();
        remote.release(1);
    };
    let (pulled, ()) = tokio::join!(engine.pull_once(), rescope);
    pulled.expect("pull");

    remote.answer(Ok(page("9", false, &[("b1", "u2")])));
    remote.release(1);
    engine.pull_once().await.expect("the new scope's bootstrap");

    assert_eq!(remote.last_pull().cursor, "0");
    assert_eq!(local_pks(&engine), vec!["b1"]);
    assert_eq!(engine.get_checkpoint().unwrap(), "9");
}

/// A pull that fails after its scope was replaced leaves the restart armed:
/// the next pull still starts over from `"0"`.
#[tokio::test]
async fn a_pull_that_fails_under_a_replaced_scope_keeps_the_restart() {
    let remote = HeldRemote::new();
    let engine = engine(&remote);
    engine.seed_checkpoint("3").await.unwrap();
    remote.answer(Err(EngineError::remote("offline")));

    let rescope = async {
        remote.entered.notified().await;
        engine
            .set_bucket_params(&params(&[("owner_id", "u2")]))
            .unwrap();
        remote.release(1);
    };
    let (pulled, ()) = tokio::join!(engine.pull_once(), rescope);
    assert!(
        matches!(
            pulled,
            Err(EngineError::Remote {
                retryable: true,
                ..
            })
        ),
        "{pulled:?}"
    );

    remote.answer(Ok(page("9", false, &[("b1", "u2")])));
    remote.release(1);
    engine.pull_once().await.expect("the new scope's bootstrap");

    assert_eq!(remote.last_pull().cursor, "0");
    assert_eq!(local_pks(&engine), vec!["b1"]);
}

/// A sync whose scope was replaced while its pull awaited goes on to pull the
/// new scope from `"0"` before it returns.
#[tokio::test]
async fn a_sync_whose_scope_was_replaced_pulls_the_new_scope_before_it_returns() {
    let remote = HeldRemote::new();
    let engine = engine(&remote);
    engine.seed_checkpoint("3").await.unwrap();
    remote.answer(Ok(page("5", false, &[("a1", "u1")])));
    remote.answer(Ok(page("9", false, &[("b1", "u2")])));

    let rescope = async {
        remote.entered.notified().await;
        engine
            .set_bucket_params(&params(&[("owner_id", "u2")]))
            .unwrap();
        remote.release(1);
        remote.entered.notified().await;
        remote.release(1);
    };
    let (synced, ()) = tokio::time::timeout(BOUND, async { tokio::join!(engine.sync(), rescope) })
        .await
        .expect("the sync never pulled the new scope");
    synced.expect("sync");

    let pulls = remote.pulls();
    assert_eq!(pulls.len(), 2);
    assert_eq!(pulls[1].cursor, "0");
    assert_eq!(pulls[1].buckets[0].params["owner_id"], json!("u2"));
    assert_eq!(local_pks(&engine), vec!["b1"]);
    assert_eq!(engine.get_checkpoint().unwrap(), "9");
}

// MARK: - The clock is per dispatch

const SYNC_NOW: &str = "2021-05-05T05:05:05.000Z";
const SYNC_NOW_MS: i64 = 1_620_191_105_000;
const WRITE_NOW: &str = "2021-06-06T06:06:06.000Z";
const WRITE_NOW_MS: i64 = 1_622_959_566_000;

/// A write dispatched while a sync awaits the remote stamps the clock its own
/// request carried, and the sync, resumed after it, journals with the clock
/// the sync's request carried: two dispatches in flight on one thread never
/// read each other's time.
#[tokio::test]
async fn interleaved_dispatches_each_stamp_their_own_clock() {
    let remote = HeldRemote::new();
    let engine = SyncEngine::new(
        LocalStore::open_in_memory().unwrap(),
        todos_config(),
        Arc::clone(&remote) as Arc<dyn ProtocolRemote>,
        clock::deps(),
    );
    let mut conflicted = page("5", false, &[("p1", "u1")]);
    conflicted.conflicts = Some(vec![Conflict {
        table: "todos".into(),
        pk: "p1".into(),
        column_name: "owner_id".into(),
        loser_value: json!("u1"),
        winner_mutation_id: "peer-1".into(),
        conflict_mode: "arrival".into(),
        winner_seq: "5".into(),
    }]);
    remote.answer(Ok(conflicted));
    engine.apply(insert("p1")).unwrap();
    engine.sync_push().await.unwrap();

    let write = async {
        remote.entered.notified().await;
        let targeted = call(
            &engine,
            "apply_where",
            json!({
                "table": "todos",
                "op": "update",
                "filters": [{ "kind": "eq", "column": "id", "value": "p1" }],
                "columns": { "title": "rewritten" },
                "now": WRITE_NOW,
                "now_ms": WRITE_NOW_MS,
            }),
        )
        .await;
        remote.release(1);
        targeted
    };
    let pinned_sync = json!({ "now": SYNC_NOW, "now_ms": SYNC_NOW_MS });
    let (synced, targeted) = tokio::join!(call(&engine, "sync", pinned_sync), write);

    assert_eq!(synced, json!({ "ok": true, "value": null }));
    assert_eq!(targeted, json!({ "ok": true, "value": ["p1"] }));
    let queued = engine.list_outbox(10).unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].created_at, WRITE_NOW);
    let overwrites = engine.list_overwrites(false).unwrap();
    assert_eq!(overwrites.len(), 1);
    assert_eq!(overwrites[0].at, SYNC_NOW_MS);
}
