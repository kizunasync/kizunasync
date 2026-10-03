//! Event and attachment delivery: one thread per handle hands every callback
//! its payload in emission order, a callback may call back into the handle, a
//! failing callback reaches neither the engine nor the callbacks after it, and
//! subscription and watch ids never repeat on one handle.

use super::actor::{DEADLINE, handle_over, within};
use super::{INSERT, base_config};
use crate::{
    AttachmentListener, EventObserver, FfiAttachmentStatus, FfiEngineEvent, KizunaSyncEngine,
};
use kizunasync_engine::ScriptedRemote;
use kizunasync_protocol::{PullResponse, Signal};
use std::sync::{Arc, Condvar, Mutex};

const SECOND_INSERT: &str = r#"{"table":"items","pk":"p-second","op":"insert","mutation_id":"m-second","columns":{"title":"Delta","user_id":"u1"}}"#;
const REFERENCE: &str = "u1/p1/photo";

/// What a callback heard, with a way to wait until it heard enough.
pub(super) struct Heard<T> {
    seen: Mutex<Vec<T>>,
    changed: Condvar,
}

impl<T: Clone> Heard<T> {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            changed: Condvar::new(),
        })
    }

    pub(super) fn push(&self, item: T) {
        self.seen.lock().unwrap().push(item);
        self.changed.notify_all();
    }

    pub(super) fn snapshot(&self) -> Vec<T> {
        self.seen.lock().unwrap().clone()
    }

    /// Everything heard once `done` holds for it, or a failure after the deadline.
    pub(super) fn wait_until(&self, done: impl Fn(&[T]) -> bool) -> Vec<T> {
        let seen = self.seen.lock().unwrap();
        let (seen, timeout) = self
            .changed
            .wait_timeout_while(seen, DEADLINE, |seen| !done(seen))
            .unwrap();
        assert!(!timeout.timed_out(), "the delivery never arrived");
        seen.clone()
    }

    pub(super) fn wait_for(&self, count: usize) -> Vec<T> {
        self.wait_until(|seen| seen.len() >= count)
    }
}

impl EventObserver for Heard<FfiEngineEvent> {
    fn on_event(&self, event: FfiEngineEvent) {
        self.push(event);
    }
}

impl AttachmentListener for Heard<String> {
    fn on_status(&self, status: FfiAttachmentStatus) {
        self.push(status.state);
    }
}

fn depths(events: &[FfiEngineEvent]) -> Vec<u32> {
    events
        .iter()
        .filter_map(|event| match event {
            FfiEngineEvent::QueueDepth { depth } => Some(*depth),
            _ => None,
        })
        .collect()
}

fn created() -> Arc<KizunaSyncEngine> {
    let engine = Arc::new(KizunaSyncEngine::new());
    engine.create(base_config().to_string()).expect("create");
    engine
}

/// Reads the handle back from inside its own callback.
struct CallingBack {
    engine: Arc<KizunaSyncEngine>,
    depths: Arc<Heard<u32>>,
}

impl EventObserver for CallingBack {
    fn on_event(&self, event: FfiEngineEvent) {
        if matches!(event, FfiEngineEvent::QueueDepth { .. }) {
            let depth = self.engine.outbox_depth().expect("the reentrant read");
            self.depths.push(depth);
        }
    }
}

#[test]
fn an_observer_may_call_back_into_the_handle() {
    let engine = created();
    let depths = Heard::new();
    engine
        .subscribe(Arc::new(CallingBack {
            engine: Arc::clone(&engine),
            depths: Arc::clone(&depths),
        }))
        .expect("subscribe");

    let writer = Arc::clone(&engine);
    within(DEADLINE, move || writer.apply(INSERT.into()))
        .expect("apply never returned: the observer ran while the handle was held")
        .expect("apply");

    assert_eq!(depths.wait_for(1), vec![1]);
    engine.shutdown().expect("shutdown");
}

struct Failing;

impl EventObserver for Failing {
    fn on_event(&self, _event: FfiEngineEvent) {
        panic!("the host observer failed");
    }
}

impl AttachmentListener for Failing {
    fn on_status(&self, _status: FfiAttachmentStatus) {
        panic!("the host listener failed");
    }
}

#[test]
fn a_failing_observer_reaches_neither_the_engine_nor_the_next_observer() {
    let engine = created();
    engine
        .subscribe(Arc::new(Failing))
        .expect("subscribe failing");
    let heard = Heard::new();
    engine.subscribe(heard.clone()).expect("subscribe recorder");

    let writer = Arc::clone(&engine);
    within(DEADLINE, move || {
        writer.apply(INSERT.into()).expect("first apply");
        writer.apply(SECOND_INSERT.into()).expect("second apply");
    })
    .expect("a failing observer unwound into the caller");

    assert_eq!(
        depths(&heard.wait_until(|seen| depths(seen).len() >= 2)),
        vec![1, 2]
    );
    assert_eq!(engine.outbox_depth().expect("depth"), 2);
}

#[test]
fn a_failing_listener_does_not_stop_later_deliveries() {
    let engine = handle_over(Arc::new(ScriptedRemote::new()));
    engine
        .watch(REFERENCE.into(), Arc::new(Failing))
        .expect("watch failing");
    let heard: Arc<Heard<String>> = Heard::new();
    engine
        .watch(REFERENCE.into(), heard.clone())
        .expect("watch recorder");

    engine.sync().expect("sync");

    assert_eq!(heard.wait_for(2), vec!["missing", "missing"]);
}

#[test]
fn subscription_ids_never_repeat_on_one_handle() {
    let engine = created();
    let before: Arc<Heard<FfiEngineEvent>> = Heard::new();
    let first = engine.subscribe(before.clone()).expect("subscribe");

    engine.create(base_config().to_string()).expect("re-create");
    let after: Arc<Heard<FfiEngineEvent>> = Heard::new();
    let second = engine.subscribe(after.clone()).expect("subscribe again");
    assert_ne!(first, second, "a re-created engine handed out an id again");

    engine.unsubscribe(first).expect("a stale id is a no-op");
    engine.apply(INSERT.into()).expect("apply");

    assert_eq!(
        depths(&after.wait_until(|seen| !depths(seen).is_empty())),
        vec![1]
    );
    assert!(
        before.snapshot().is_empty(),
        "an observer of the replaced engine heard the new one"
    );
}

#[test]
fn watch_ids_never_repeat_on_one_handle() {
    let engine = handle_over(Arc::new(ScriptedRemote::new()));
    let before: Arc<Heard<String>> = Heard::new();
    let first = engine
        .watch(REFERENCE.into(), before.clone())
        .expect("watch");
    before.wait_for(1);

    engine
        .create_over(&base_config().to_string(), Arc::new(ScriptedRemote::new()))
        .expect("re-create");
    let after: Arc<Heard<String>> = Heard::new();
    let second = engine
        .watch(REFERENCE.into(), after.clone())
        .expect("watch again");
    assert_ne!(first, second, "a re-created engine handed out an id again");

    engine.unwatch(first).expect("a stale id is a no-op");
    engine.sync().expect("sync");

    assert_eq!(after.wait_for(2), vec!["missing", "missing"]);
    assert_eq!(before.snapshot(), vec!["missing"]);
}

/// One log for both kinds of callback, so their relative order is visible.
struct Log(Arc<Heard<String>>);

impl EventObserver for Log {
    fn on_event(&self, event: FfiEngineEvent) {
        self.0.push(format!("event {event:?}"));
    }
}

impl AttachmentListener for Log {
    fn on_status(&self, status: FfiAttachmentStatus) {
        self.0.push(format!("status {}", status.state));
    }
}

#[test]
fn events_and_statuses_arrive_in_emission_order() {
    let engine = handle_over(Arc::new(ScriptedRemote::new()));
    let log: Arc<Heard<String>> = Heard::new();
    engine
        .watch(REFERENCE.into(), Arc::new(Log(Arc::clone(&log))))
        .expect("watch");
    engine
        .subscribe(Arc::new(Log(Arc::clone(&log))))
        .expect("subscribe");

    engine.apply(INSERT.into()).expect("first apply");
    engine.apply(SECOND_INSERT.into()).expect("second apply");
    engine.sync().expect("sync");

    let entries =
        log.wait_until(|seen| seen.iter().filter(|e| e.starts_with("status")).count() == 2);
    assert_eq!(entries.first().map(String::as_str), Some("status missing"));
    assert_eq!(entries.last().map(String::as_str), Some("status missing"));
    let between = &entries[1..entries.len() - 1];
    assert!(
        between.iter().all(|entry| entry.starts_with("event")),
        "{entries:?}"
    );
    let queue: Vec<&String> = between
        .iter()
        .filter(|entry| entry.contains("QueueDepth"))
        .collect();
    assert_eq!(
        queue,
        [
            "event QueueDepth { depth: 1 }",
            "event QueueDepth { depth: 2 }"
        ],
        "{entries:?}"
    );
}

/// A compact JWS whose payload names `sub`; the engine decodes it without
/// verifying it.
pub(super) fn token_for(payload: &str) -> String {
    format!("e30.{payload}.signature")
}

/// `{"sub":"user-a"}` and `{"sub":"user-b"}`, base64url.
pub(super) const USER_A: &str = "eyJzdWIiOiJ1c2VyLWEifQ";
pub(super) const USER_B: &str = "eyJzdWIiOiJ1c2VyLWIifQ";

/// The reason of every `ResetRequired` event among `events`, in order.
fn reset_reasons(events: &[FfiEngineEvent]) -> Vec<Option<String>> {
    events
        .iter()
        .filter_map(|event| match event {
            FfiEngineEvent::ResetRequired { reason } => Some(reason.clone()),
            _ => None,
        })
        .collect()
}

fn heard_resets(heard: &Heard<FfiEngineEvent>) -> Vec<Option<String>> {
    reset_reasons(&heard.wait_until(|seen| !reset_reasons(seen).is_empty()))
}

#[test]
fn an_identity_change_names_its_reason_on_the_event_and_the_checkpoint() {
    let engine = created();
    let heard: Arc<Heard<FfiEngineEvent>> = Heard::new();
    engine.subscribe(heard.clone()).expect("subscribe");
    engine
        .set_access_token(Some(token_for(USER_A)))
        .expect("first token");
    let open = engine.checkpoint().expect("checkpoint");
    assert!(!open.soft_blocked);
    assert_eq!(open.soft_block_reason, None);

    engine
        .set_access_token(Some(token_for(USER_B)))
        .expect("second token");

    assert_eq!(heard_resets(&heard), vec![Some("identity_changed".into())]);
    let blocked = engine.checkpoint().expect("checkpoint");
    assert!(blocked.soft_blocked);
    assert_eq!(
        blocked.soft_block_reason.as_deref(),
        Some("identity_changed")
    );
}

#[test]
fn a_reset_signal_names_its_reason_on_the_event_and_the_checkpoint() {
    let remote = Arc::new(ScriptedRemote::new());
    remote.enqueue_pull(PullResponse {
        cursor: "0".into(),
        has_more: false,
        rows: vec![],
        tombstones: vec![],
        signal: Some(Signal {
            signal_type: "RESET_REQUIRED".into(),
        }),
        conflicts: None,
    });
    let engine = handle_over(remote);
    let heard: Arc<Heard<FfiEngineEvent>> = Heard::new();
    engine.subscribe(heard.clone()).expect("subscribe");

    engine.pull_once().expect("pull_once");

    assert_eq!(heard_resets(&heard), vec![Some("reset_required".into())]);
    let blocked = engine.checkpoint().expect("checkpoint");
    assert!(blocked.soft_blocked);
    assert_eq!(blocked.soft_block_reason.as_deref(), Some("reset_required"));
}
