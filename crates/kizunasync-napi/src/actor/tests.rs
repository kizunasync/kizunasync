//! The engine thread runs each call as its own task, at most
//! [`MAX_RUNNING_CALLS`] at once. Every test drives [`serve`] on one
//! current-thread runtime inside a `LocalSet`, the way [`super::run`] does, with
//! a remote whose pulls wait until the test lets them through.

use super::{Command, MAX_RUNNING_CALLS, serve};
use async_trait::async_trait;
use kizunasync_engine::bridge::{open_store_at, parse_config};
use kizunasync_engine::{EngineDeps, EngineError, ProtocolRemote, SyncEngine};
use kizunasync_protocol::{PullRequest, PullResponse, PushRequest, PushResponse};
use serde_json::json;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Notify, Semaphore, mpsc, oneshot};
use tokio::task::LocalSet;
use tokio::time::timeout;

/// How long a test waits for an answer before it fails instead of hanging.
const BOUND: Duration = Duration::from_secs(5);

/// How long a call past the bound is watched to show it is still waiting.
const STILL_WAITING: Duration = Duration::from_millis(100);

const QUERY: &str = r#"{"table":"items","plan":{}}"#;

// MARK: - A remote the test holds

struct HeldRemote {
    /// One permit lets every pull through: each pull hands it back.
    released: Semaphore,
    /// Woken when a pull reaches the remote.
    entered: Notify,
}

impl HeldRemote {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            released: Semaphore::new(0),
            entered: Notify::new(),
        })
    }

    fn release(&self) {
        self.released.add_permits(1);
    }
}

#[async_trait]
impl ProtocolRemote for HeldRemote {
    async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
        self.entered.notify_one();
        drop(self.released.acquire().await.unwrap());

        Ok(PullResponse {
            cursor: "0".into(),
            has_more: false,
            rows: vec![],
            tombstones: vec![],
            signal: None,
            conflicts: None,
        })
    }

    async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
        Ok(PushResponse {
            verdicts: Some(vec![]),
            signal: None,
            batch: None,
        })
    }
}

// MARK: - The engine and its calls

/// `items`, bucketed on `user_id`, opened with `user_id` set to `u1`.
fn engine(remote: &Arc<HeldRemote>) -> Rc<SyncEngine> {
    let config = parse_config(&json!({
        "tables": {
            "items": { "bucket_column": "user_id", "bucket_params": { "user_id": "u1" } },
        },
        "schema_version": 1,
        "client_id": "napi-actor-test",
    }))
    .unwrap();

    Rc::new(SyncEngine::new(
        open_store_at(None).unwrap(),
        config,
        Arc::clone(remote) as Arc<dyn ProtocolRemote>,
        EngineDeps::default(),
    ))
}

async fn send(
    commands: &mpsc::Sender<Command>,
    method: &str,
    params: &str,
) -> oneshot::Receiver<String> {
    let (reply, answer) = oneshot::channel();
    commands
        .send(Command::Call {
            method: method.into(),
            params: params.into(),
            reply,
        })
        .await
        .unwrap();

    answer
}

async fn answered(answer: oneshot::Receiver<String>) -> String {
    timeout(BOUND, answer).await.unwrap().unwrap()
}

/// A `sync` that awaits the held remote, then `pull_once` calls waiting behind
/// it on the engine's gate until `running` calls hold a permit.
async fn hold_running_calls(
    commands: &mpsc::Sender<Command>,
    remote: &HeldRemote,
    running: usize,
) -> Vec<oneshot::Receiver<String>> {
    let mut held = vec![send(commands, "sync", "{}").await];
    timeout(BOUND, remote.entered.notified()).await.unwrap();

    for _ in 1..running {
        held.push(send(commands, "pull_once", "{}").await);
    }

    held
}

async fn assert_every_call_answers_ok(held: Vec<oneshot::Receiver<String>>) {
    for answer in held {
        let answer = answered(answer).await;
        assert!(answer.starts_with(r#"{"ok":true"#), "{answer}");
    }
}

// MARK: - Tests

#[tokio::test]
async fn a_local_call_answers_while_every_other_permit_waits_on_the_network() {
    LocalSet::new()
        .run_until(async {
            let remote = HeldRemote::new();
            let (commands, inbox) = mpsc::channel(2 * MAX_RUNNING_CALLS);
            tokio::task::spawn_local(serve(engine(&remote), inbox));

            let held = hold_running_calls(&commands, &remote, MAX_RUNNING_CALLS - 1).await;
            let query = answered(send(&commands, "query", QUERY).await).await;
            assert_eq!(query, r#"{"ok":true,"value":[]}"#);

            remote.release();
            assert_every_call_answers_ok(held).await;
        })
        .await;
}

#[tokio::test]
async fn a_call_past_the_bound_waits_for_a_running_call_to_answer() {
    LocalSet::new()
        .run_until(async {
            let remote = HeldRemote::new();
            let (commands, inbox) = mpsc::channel(2 * MAX_RUNNING_CALLS);
            tokio::task::spawn_local(serve(engine(&remote), inbox));

            let held = hold_running_calls(&commands, &remote, MAX_RUNNING_CALLS).await;
            let mut query = send(&commands, "query", QUERY).await;
            assert!(timeout(STILL_WAITING, &mut query).await.is_err());

            remote.release();
            assert_eq!(answered(query).await, r#"{"ok":true,"value":[]}"#);
            assert_every_call_answers_ok(held).await;
        })
        .await;
}

#[tokio::test]
async fn serving_stops_at_close_and_the_running_calls_answer() {
    LocalSet::new()
        .run_until(async {
            let remote = HeldRemote::new();
            let (commands, inbox) = mpsc::channel(8);
            let serving = tokio::task::spawn_local(serve(engine(&remote), inbox));

            let held = hold_running_calls(&commands, &remote, 1).await;
            commands.send(Command::Close).await.unwrap();
            timeout(BOUND, serving).await.unwrap().unwrap();

            remote.release();
            assert_every_call_answers_ok(held).await;
        })
        .await;
}
