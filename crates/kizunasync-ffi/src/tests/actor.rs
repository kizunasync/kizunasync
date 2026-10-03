//! The handle's engine thread: local calls answer while a network call awaits
//! the remote, and `create` / `shutdown` retire the engine they replace.

use super::{INSERT, QUERY, base_config};
use crate::{KizunaSyncEngine, KizunaSyncFfiError};
use kizunasync_engine::{EngineError, ProtocolRemote, ScriptedRemote};
use kizunasync_protocol::{PullRequest, PullResponse, PushRequest, PushResponse, Verdict};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// How long a call that must answer may take before the test fails.
pub(super) const DEADLINE: Duration = Duration::from_secs(5);

/// How long a call that must still be waiting is watched.
const STILL_WAITING: Duration = Duration::from_millis(200);

type RemoteFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, EngineError>> + Send + 'a>>;

/// A remote whose pulls wait until the test opens its gate. Pushes answer at
/// once, applying every mutation.
///
/// `ProtocolRemote` is declared through `async_trait`, which this crate does
/// not depend on, so the impl spells out the boxed-future signature the macro
/// generates.
pub(super) struct HeldRemote {
    entered: Mutex<mpsc::Sender<()>>,
    pulls: Mutex<mpsc::Receiver<()>>,
    gate: tokio::sync::Semaphore,
}

impl HeldRemote {
    pub(super) fn new() -> Arc<Self> {
        let (entered, pulls) = mpsc::channel();
        Arc::new(Self {
            entered: Mutex::new(entered),
            pulls: Mutex::new(pulls),
            gate: tokio::sync::Semaphore::new(0),
        })
    }

    /// Block until a pull reached this remote.
    pub(super) fn await_pull(&self) {
        self.pulls
            .lock()
            .unwrap()
            .recv_timeout(DEADLINE)
            .expect("no pull reached the remote");
    }

    /// Let every held and later pull answer.
    pub(super) fn release(&self) {
        self.gate.add_permits(1);
    }
}

impl ProtocolRemote for HeldRemote {
    fn pull<'life0, 'async_trait>(
        &'life0 self,
        _req: PullRequest,
    ) -> RemoteFuture<'async_trait, PullResponse>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let _ = self.entered.lock().unwrap().send(());
            let _permit = self.gate.acquire().await;
            Ok(PullResponse {
                cursor: "7".into(),
                has_more: false,
                rows: vec![],
                tombstones: vec![],
                signal: None,
                conflicts: None,
            })
        })
    }

    fn push<'life0, 'async_trait>(
        &'life0 self,
        req: PushRequest,
    ) -> RemoteFuture<'async_trait, PushResponse>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let verdicts = req
                .batch
                .mutations
                .iter()
                .map(|mutation| Verdict {
                    mutation_id: mutation.mutation_id.clone(),
                    verdict: "applied".into(),
                    reason: None,
                    server_row: None,
                })
                .collect();
            Ok(PushResponse {
                verdicts: Some(verdicts),
                signal: None,
                batch: None,
            })
        })
    }
}

/// Run `work` on its own thread and wait for it up to `limit`. `None` means it
/// had not returned by then; the thread is left to finish on its own.
pub(super) fn within<T: Send + 'static>(
    limit: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (done, answer) = mpsc::channel();
    thread::spawn(move || {
        let _ = done.send(work());
    });
    match answer.recv_timeout(limit) {
        Ok(value) => Some(value),
        Err(RecvTimeoutError::Timeout) => None,
        Err(RecvTimeoutError::Disconnected) => panic!("the call panicked"),
    }
}

/// A handle whose engine pulls through `remote`.
pub(super) fn handle_over(remote: Arc<dyn ProtocolRemote>) -> Arc<KizunaSyncEngine> {
    let engine = Arc::new(KizunaSyncEngine::new());
    engine
        .create_over(&base_config().to_string(), remote)
        .expect("create");
    engine
}

fn start_sync(engine: &Arc<KizunaSyncEngine>) -> thread::JoinHandle<()> {
    let engine = Arc::clone(engine);
    thread::spawn(move || engine.sync().expect("sync"))
}

#[test]
fn local_calls_answer_while_a_sync_awaits_the_remote() {
    let remote = HeldRemote::new();
    let engine = handle_over(remote.clone());
    let syncing = start_sync(&engine);
    remote.await_pull();

    let local = Arc::clone(&engine);
    let answered = within(DEADLINE, move || {
        local.apply(INSERT.into()).expect("apply");
        let rows: Value =
            serde_json::from_str(&local.query(QUERY.into()).expect("query")).expect("rows json");
        (rows, local.outbox_depth().expect("depth"))
    });
    remote.release();
    syncing.join().expect("the sync thread");

    let (rows, depth) = answered.expect("a local call waited for the sync to finish");
    assert_eq!(rows.as_array().map(Vec::len), Some(1), "{rows}");
    assert_eq!(depth, 1);
    assert_eq!(engine.outbox_depth().expect("depth after the sync"), 1);
    assert_eq!(engine.checkpoint().expect("checkpoint").cursor, "7");
}

#[test]
fn create_waits_for_the_sync_the_replaced_engine_is_running() {
    let remote = HeldRemote::new();
    let engine = handle_over(remote.clone());
    let syncing = start_sync(&engine);
    remote.await_pull();

    let replacing = Arc::clone(&engine);
    let (created, answer) = mpsc::channel();
    thread::spawn(move || {
        let _ = created.send(replacing.create(base_config().to_string()));
    });
    assert!(
        matches!(
            answer.recv_timeout(STILL_WAITING),
            Err(RecvTimeoutError::Timeout)
        ),
        "create returned while the replaced engine was still syncing"
    );

    remote.release();
    answer
        .recv_timeout(DEADLINE)
        .expect("create never returned")
        .expect("create");
    syncing.join().expect("the sync thread");
    assert_eq!(engine.checkpoint().expect("checkpoint").cursor, "0");
}

/// A scripted remote that records when the engine holding it is dropped.
struct DropWitness {
    inner: ScriptedRemote,
    dropped: Arc<AtomicBool>,
}

impl Drop for DropWitness {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

impl ProtocolRemote for DropWitness {
    fn pull<'life0, 'async_trait>(
        &'life0 self,
        req: PullRequest,
    ) -> RemoteFuture<'async_trait, PullResponse>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        self.inner.pull(req)
    }

    fn push<'life0, 'async_trait>(
        &'life0 self,
        req: PushRequest,
    ) -> RemoteFuture<'async_trait, PushResponse>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        self.inner.push(req)
    }
}

fn witnessed_handle() -> (Arc<KizunaSyncEngine>, Arc<AtomicBool>) {
    let dropped = Arc::new(AtomicBool::new(false));
    let engine = handle_over(Arc::new(DropWitness {
        inner: ScriptedRemote::new(),
        dropped: Arc::clone(&dropped),
    }));
    (engine, dropped)
}

#[test]
fn create_retires_the_engine_it_replaces_before_it_returns() {
    let (engine, dropped) = witnessed_handle();
    engine.apply(INSERT.into()).expect("apply");

    engine.create(base_config().to_string()).expect("re-create");

    assert!(
        dropped.load(Ordering::SeqCst),
        "the replaced engine is still alive"
    );
    assert_eq!(
        engine.outbox_depth().expect("depth"),
        0,
        "a fresh in-memory store"
    );
}

#[test]
fn shutdown_retires_the_engine_before_it_returns() {
    let (engine, dropped) = witnessed_handle();

    engine.shutdown().expect("shutdown");

    assert!(
        dropped.load(Ordering::SeqCst),
        "the engine outlived shutdown"
    );
    let KizunaSyncFfiError::Engine { code, .. } = engine
        .outbox_depth()
        .expect_err("a shut down handle has no engine");
    assert_eq!(code, kizunasync_engine::error_catalog::ENGINE_UNAVAILABLE);
}

fn assert_send<T: Send>(_: &T) {}

fn call_async_blocking(
    engine: &KizunaSyncEngine,
    method: &str,
) -> Result<String, KizunaSyncFfiError> {
    let reply = engine.call_async(method.into(), "{}".into());
    assert_send(&reply);
    kizunasync_engine::current_thread_runtime()
        .expect("runtime")
        .block_on(reply)
}

#[test]
fn call_async_answers_what_call_answers() {
    let engine = handle_over(Arc::new(ScriptedRemote::new()));
    engine.apply(INSERT.into()).expect("apply");

    let answered = call_async_blocking(&engine, "outbox_depth").expect("call_async");

    assert_eq!(
        answered,
        engine
            .call("outbox_depth".into(), "{}".into())
            .expect("call")
    );
    let envelope: Value = serde_json::from_str(&answered).expect("envelope json");
    assert_eq!(envelope, serde_json::json!({"ok": true, "value": 1}));
}

#[test]
fn call_async_answers_while_a_sync_awaits_the_remote() {
    let remote = HeldRemote::new();
    let engine = handle_over(remote.clone());
    let syncing = start_sync(&engine);
    remote.await_pull();

    let local = Arc::clone(&engine);
    let answered = within(DEADLINE, move || {
        call_async_blocking(&local, "outbox_depth")
    });
    remote.release();
    syncing.join().expect("the sync thread");

    let envelope = answered
        .expect("call_async waited for the sync to finish")
        .expect("call_async");
    assert_eq!(envelope, r#"{"ok":true,"value":0}"#);
}

#[test]
fn call_async_without_an_engine_is_engine_unavailable() {
    let engine = KizunaSyncEngine::new();

    let KizunaSyncFfiError::Engine { code, .. } =
        call_async_blocking(&engine, "outbox_depth").expect_err("no engine to answer");

    assert_eq!(code, kizunasync_engine::error_catalog::ENGINE_UNAVAILABLE);
}
