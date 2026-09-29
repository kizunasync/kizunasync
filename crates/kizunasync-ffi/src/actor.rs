//! The engine thread one created engine runs on.
//!
//! The thread owns the engine and runs a current-thread runtime with a
//! `LocalSet`. Every call the handle receives arrives as a job and runs as a
//! local task, so a call awaiting the network yields the thread and the local
//! calls issued after it answer in the meantime. Store transactions take
//! synchronous closures, so no transaction spans an await, and the engine's own
//! gate runs its syncs, pulls and pushes one at a time.

use crate::delivery::Deliveries;
use crate::types::{
    AttachmentListener, EventObserver, FfiAttachmentStatus, FfiEngineEvent, KizunaSyncFfiError,
};
use kizunasync_engine::error_catalog::ENGINE_UNAVAILABLE;
use kizunasync_engine::{
    AttachmentDelivery, AttachmentStatus, AttachmentWatchers, EventHandler, SyncEngine,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::thread::JoinHandle;
use tokio::runtime::Runtime;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::task::LocalSet;

/// One call, handed the engine on its thread and run there as a local task.
type Job = Box<dyn FnOnce(Rc<Hosted>) -> Pin<Box<dyn Future<Output = ()>>> + Send>;

/// The engine and the host registrations made against it. It lives on the
/// engine thread only, so its cells are never borrowed across an await.
pub(crate) struct Hosted {
    pub(crate) engine: SyncEngine,
    deliveries: Deliveries,
    observers: RefCell<HashMap<u64, EventHandler>>,
    watchers: RefCell<AttachmentWatchers>,
    watch_ids: RefCell<HashMap<u64, u64>>,
}

impl Hosted {
    /// Forward every event the engine emits to `observer` through the
    /// delivery thread, under the handle-wide `id`.
    pub(crate) fn subscribe(&self, id: u64, observer: Arc<dyn EventObserver>) {
        let deliveries = self.deliveries.clone();
        let handler: EventHandler = Arc::new(move |event| {
            let observer = Arc::clone(&observer);
            let event = FfiEngineEvent::from(event);
            deliveries.send(Box::new(move || observer.on_event(event)));
        });
        drop(self.engine.subscribe(Arc::clone(&handler)));
        self.observers.borrow_mut().insert(id, handler);
    }

    pub(crate) fn unsubscribe(&self, id: u64) {
        let removed = self.observers.borrow_mut().remove(&id);
        if let Some(handler) = removed {
            self.engine.remove_listener(&handler);
        }
    }

    /// Register `listener` under the handle-wide `id` and hand it, alone, the
    /// reference's current status.
    pub(crate) fn watch(&self, id: u64, reference: String, listener: Arc<dyn AttachmentListener>) {
        let status = AttachmentWatchers::status_or_missing(&self.engine, &reference);
        let registered = self
            .watchers
            .borrow_mut()
            .watch(reference, status_sink(&listener));
        self.watch_ids.borrow_mut().insert(id, registered);

        self.deliveries.send(Box::new(move || {
            listener.on_status(FfiAttachmentStatus::from(status));
        }));
    }

    pub(crate) fn unwatch(&self, id: u64) {
        let registered = self.watch_ids.borrow_mut().remove(&id);
        if let Some(registered) = registered {
            self.watchers.borrow_mut().unwatch(registered);
        }
    }

    /// Hand every watcher of `reference` its current status.
    pub(crate) fn notify(&self, reference: &str) {
        let payloads = self
            .watchers
            .borrow()
            .pending_payloads(&self.engine, reference);
        self.forward(payloads);
    }

    /// Hand every watcher its reference's current status.
    pub(crate) fn notify_all(&self) {
        let payloads = self.watchers.borrow().all_payloads(&self.engine);
        self.forward(payloads);
    }

    fn forward(&self, payloads: Vec<AttachmentDelivery>) {
        for (listener, status) in payloads {
            self.deliveries.send(Box::new(move || listener(status)));
        }
    }
}

/// Wrap a host listener as the plain callback the engine's watcher registry
/// stores, mapping the engine's status to the record the bindings expose.
fn status_sink(
    listener: &Arc<dyn AttachmentListener>,
) -> Box<dyn Fn(AttachmentStatus) + Send + Sync> {
    let listener = Arc::clone(listener);
    Box::new(move |status: AttachmentStatus| {
        listener.on_status(FfiAttachmentStatus::from(status));
    })
}

/// The `ENGINE_UNAVAILABLE` a call receives when the engine thread ended before
/// it answered.
pub(crate) fn stopped() -> KizunaSyncFfiError {
    KizunaSyncFfiError::engine(ENGINE_UNAVAILABLE, "the engine stopped before it answered")
}

/// The handle's side of one engine thread. Dropping it closes the job queue and
/// joins the thread, which first finishes every job already queued.
pub(crate) struct Actor {
    jobs: Option<UnboundedSender<Job>>,
    thread: Option<JoinHandle<()>>,
}

impl Actor {
    /// Move `engine` onto a new engine thread driven by `runtime`.
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when the thread cannot be spawned.
    pub(crate) fn start(
        engine: SyncEngine,
        runtime: Runtime,
        deliveries: Deliveries,
    ) -> Result<Self, KizunaSyncFfiError> {
        let (jobs, inbox) = unbounded_channel();
        let thread = std::thread::Builder::new()
            .name("kizunasync-engine".into())
            .spawn(move || serve(engine, &runtime, deliveries, inbox))
            .map_err(|error| {
                KizunaSyncFfiError::engine(ENGINE_UNAVAILABLE, format!("engine thread: {error}"))
            })?;
        Ok(Self {
            jobs: Some(jobs),
            thread: Some(thread),
        })
    }

    /// Queue `work` behind the jobs queued before it; `reply` receives its
    /// output on the engine thread.
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when the engine thread has ended.
    pub(crate) fn submit<T, F, Fut>(
        &self,
        work: F,
        reply: impl FnOnce(T) + Send + 'static,
    ) -> Result<(), KizunaSyncFfiError>
    where
        T: 'static,
        F: FnOnce(Rc<Hosted>) -> Fut + Send + 'static,
        Fut: Future<Output = T> + 'static,
    {
        let job: Job = Box::new(move |hosted| Box::pin(async move { reply(work(hosted).await) }));
        self.jobs
            .as_ref()
            .ok_or_else(stopped)?
            .send(job)
            .map_err(|_| stopped())
    }
}

impl Drop for Actor {
    fn drop(&mut self) {
        drop(self.jobs.take());
        if let Some(thread) = self.thread.take() {
            // The handle can be released from the engine thread itself, when a
            // dropped host observer held its last reference; that thread is
            // already finishing and cannot wait for itself.
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

/// The engine thread: run every job as a local task until the queue closes,
/// then let the tasks still running finish before the engine is dropped.
fn serve(
    engine: SyncEngine,
    runtime: &Runtime,
    deliveries: Deliveries,
    mut inbox: UnboundedReceiver<Job>,
) {
    let hosted = Rc::new(Hosted {
        engine,
        deliveries,
        observers: RefCell::new(HashMap::new()),
        watchers: RefCell::new(AttachmentWatchers::new()),
        watch_ids: RefCell::new(HashMap::new()),
    });
    let tasks = LocalSet::new();

    tasks.block_on(runtime, async {
        while let Some(job) = inbox.recv().await {
            drop(tokio::task::spawn_local(job(Rc::clone(&hosted))));
        }
    });
    runtime.block_on(tasks);
}
