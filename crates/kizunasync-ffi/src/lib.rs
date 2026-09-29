//! `UniFFI` surface over `kizunasync-engine`: the generation source for the Swift and
//! Kotlin `KizunaSyncEngine` object.
//!
//! # Allocation
//!
//! Thin FFI boundary: no business logic. Allocation happens at the host
//! crossing. Not heapless. This crate does not `forbid(unsafe_code)` because
//! `UniFFI` glue may need `unsafe`.
//!
//! One handle owns one engine. The typed methods map Rust values to the host's,
//! and [`KizunaSyncEngine::call`] carries the same JSON request/response surface
//! `kizunasync-napi` and `kizunasync-wasm` answer, which is what the React Native adapter
//! speaks.
//!
//! [`KizunaSyncEngine`] is `Send + Sync`, so a host may call one handle from
//! more than one thread at a time. `create` moves the engine onto a thread of
//! its own, and every call runs there as a local task: a call that awaits the
//! network yields that thread, so the local calls issued after it answer while
//! it waits. The typed methods block their caller until the engine thread
//! answers; [`KizunaSyncEngine::call_async`] returns a future instead. Engine
//! events and attachment statuses run on a second thread the handle owns, in
//! emission order, so a host callback may call back into the handle.
//!
//! Every failure crosses as [`KizunaSyncFfiError::Engine`], carrying the engine's
//! machine-readable code (a [`kizunasync_engine::error_catalog`] member) and its
//! message, so a host switches on `code` and never on English. A config the
//! caller spelled wrong is `CONFIG_INVALID`; a handle whose engine was never
//! created, or one whose lock is poisoned, is `ENGINE_UNAVAILABLE`.
//!
//! `create(config_json)` takes the `EngineConfig` object plus three optional keys
//! that leave the exported signature unchanged: `database_path`, `remote`
//! (`url` + `publishable_key`, with `anon_key` also accepted), and
//! `attachment_root` (the thin-client sandbox). A build with the `http` feature,
//! which every packaged library is, refuses a missing `remote` with
//! `CONFIG_INVALID`. A build without it has no HTTP remote: a config without the
//! key runs against the offline scripted remote, and one with the key is
//! `CONFIG_INVALID`. A table may also declare `conflict_mode`: `hlc` has the
//! engine stamp every local write with the origin HLC the server resolves the
//! column by, and `arrival` leaves the push without an origin stamp.
//!
//! `client_id` seeds the device identity the first time a store opens. The
//! store keeps that identity and every later open reuses it, whatever
//! `client_id` says then; [`KizunaSyncEngine::reset`] mints and keeps a new one.
//! `kizunasync._clients.client_id` is a `uuid` column, so an app that mints its
//! own seed must mint a uuid: a value of any other shape reaches the server and
//! is refused there.
//!
//! Node and Bun run `kizunasync-napi` and the browser runs `kizunasync-wasm`; neither
//! crosses this crate.

#![expect(
    clippy::needless_pass_by_value,
    reason = "UniFFI requires owned `String` parameters on every exported method"
)]

mod actor;
mod create;
mod delivery;
mod types;

pub use types::{
    AttachmentListener, EventObserver, FfiAttachmentStatus, FfiCheckpoint, FfiEngineEvent,
    FfiFromFileResult, FfiRejection, KizunaSyncFfiError,
};

use actor::{Actor, Hosted, stopped};
use create::{
    UNKNOWN_OP, apply_on, build_engine, config_value, new_runtime, query_on, unknown_op_message,
};
use delivery::Deliveries;
use kizunasync_engine::clock;
use kizunasync_engine::error_catalog::{ENGINE_UNAVAILABLE, JSON};
use kizunasync_engine::{ApplyWhere, SyncEngine};
use kizunasync_protocol::Op;
use kizunasync_query::Filter;
use serde_json::{Map, Value, json};
use std::future::Future;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

uniffi::setup_scaffolding!();

// MARK: - Argument parsing

fn lock_err() -> KizunaSyncFfiError {
    KizunaSyncFfiError::engine(ENGINE_UNAVAILABLE, "lock")
}

fn not_created() -> KizunaSyncFfiError {
    KizunaSyncFfiError::engine(ENGINE_UNAVAILABLE, "not created")
}

fn parse_op(op: &str) -> Result<Op, KizunaSyncFfiError> {
    match op {
        "insert" => Ok(Op::Insert),
        "update" => Ok(Op::Update),
        "delete" => Ok(Op::Delete),
        other => Err(KizunaSyncFfiError::engine(
            UNKNOWN_OP,
            unknown_op_message(other),
        )),
    }
}

fn parse_json_value(raw: &str) -> Result<Value, KizunaSyncFfiError> {
    serde_json::from_str(raw).map_err(|e| KizunaSyncFfiError::engine(JSON, e.to_string()))
}

fn parse_object(raw: &str) -> Result<Map<String, Value>, KizunaSyncFfiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(Map::new());
    }
    match parse_json_value(trimmed)? {
        Value::Object(map) => Ok(map),
        _ => Err(KizunaSyncFfiError::engine(JSON, "expected a JSON object")),
    }
}

fn parse_optional_object(raw: &str) -> Result<Option<Map<String, Value>>, KizunaSyncFfiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "{}" {
        return Ok(None);
    }
    Ok(Some(parse_object(trimmed)?))
}

fn parse_filters(raw: &str) -> Result<Vec<Filter>, KizunaSyncFfiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "[]" {
        return Ok(Vec::new());
    }
    serde_json::from_str(trimmed).map_err(|e| KizunaSyncFfiError::engine(JSON, e.to_string()))
}

// MARK: - UniFFI surface

/// The engine thread a handle runs its engine on, and the delivery thread its
/// host callbacks run on. The delivery thread outlives every `create`, so
/// callbacks keep one order across engines.
#[derive(Default)]
struct Hosting {
    actor: Option<Actor>,
    deliveries: Option<Deliveries>,
}

/// Instance-scoped engine handle for Swift/Kotlin (`UniFFI` object).
#[derive(uniffi::Object)]
pub struct KizunaSyncEngine {
    hosting: Mutex<Hosting>,
    next_subscription: AtomicU64,
    next_watch: AtomicU64,
}

impl Default for KizunaSyncEngine {
    fn default() -> Self {
        Self {
            hosting: Mutex::new(Hosting::default()),
            next_subscription: AtomicU64::new(1),
            next_watch: AtomicU64::new(1),
        }
    }
}

#[uniffi::export]
impl KizunaSyncEngine {
    /// A handle with no engine yet. Call [`Self::create`] before anything else.
    #[uniffi::constructor]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Create or replace this handle's engine from `EngineConfig` JSON.
    ///
    /// Replacing an engine waits for the calls it already accepted, then closes
    /// it; its subscriptions and watchers end with it.
    ///
    /// # Errors
    ///
    /// `CONFIG_INVALID` when the JSON, the `remote` object, a table's
    /// `conflict_mode` or the attachment root is refused, the store's own code
    /// when the database cannot be opened, and `ENGINE_UNAVAILABLE` when the
    /// runtime or a thread will not start.
    pub fn create(&self, config_json: String) -> Result<(), KizunaSyncFfiError> {
        let config = config_value(&config_json)?;
        let engine = build_engine(&config, clock::deps())?;
        self.install(engine)
    }

    /// Apply one local mutation and queue it for the next push.
    ///
    /// A mutation against a table whose `conflict_mode` is `hlc` carries the
    /// origin HLC the server resolves the column by: the one the caller put in
    /// `mutation_json`, or a freshly minted stamp. An arrival-mode table carries
    /// none.
    ///
    /// # Errors
    ///
    /// `UNKNOWN_OP` for an op outside insert/update/delete, and whatever the
    /// engine reports for the write itself.
    pub fn apply(&self, mutation_json: String) -> Result<(), KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            apply_on(&hosted.engine, &mutation_json).map_err(Into::into)
        })
    }

    /// Run one query against the local store and return its result as JSON: an
    /// array for `many`, an object or `null` for `single` and `maybeSingle`.
    ///
    /// # Errors
    ///
    /// `LOCAL_UNSUPPORTED` for a plan the local evaluator cannot run,
    /// `LOCAL_CONSTRAINT` when a cardinality is violated, and the store's code
    /// when the read itself fails.
    pub fn query(&self, req_json: String) -> Result<String, KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            let v = query_on(&hosted.engine, &req_json)?;
            serde_json::to_string(&v).map_err(|e| KizunaSyncFfiError::engine(JSON, e.to_string()))
        })
    }

    /// [`Self::query`] with the table and the plan as separate arguments, for
    /// hosts that build the plan and the table name apart. An empty `plan_json`
    /// is the empty plan.
    ///
    /// # Errors
    ///
    /// The same as [`Self::query`], plus `JSON` for a malformed plan.
    pub fn query_table(
        &self,
        table: String,
        plan_json: String,
    ) -> Result<String, KizunaSyncFfiError> {
        let plan = if plan_json.trim().is_empty() {
            json!({})
        } else {
            parse_json_value(&plan_json)?
        };
        self.query(json!({"table": table, "plan": plan}).to_string())
    }

    /// Push the outbox, pull the buckets, and drive the attachment queue, then
    /// hand every attachment watcher its reference's current status.
    ///
    /// # Errors
    ///
    /// Whatever the engine's push or pull reports. A transport failure arrives
    /// as `PERMANENT_TRANSPORT` or `REMOTE`, with the server's message in `msg`.
    pub fn sync(&self) -> Result<(), KizunaSyncFfiError> {
        self.run(|hosted| async move {
            hosted.engine.sync().await?;
            hosted.notify_all();
            Ok(())
        })
    }

    /// One JSON-RPC surface matching `kizunasync-napi` (`apply`, `sync`, `pull_once`,
    /// attachment rows, …). Envelope `{ok, value}` / `{ok:false, error}`.
    ///
    /// `params_json` may carry the embedder's clock (`now` / `now_ms`); it is
    /// pinned for this dispatch only, so every bridge stamps the same values from
    /// the same request and the typed methods keep stamping with the system
    /// clock.
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when this handle has no engine. A method that fails
    /// answers inside the envelope instead, as `ok:false`.
    pub fn call(&self, method: String, params_json: String) -> Result<String, KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            Ok(kizunasync_engine::rpc::dispatch(&hosted.engine, &method, &params_json).await)
        })
    }

    /// [`Self::call`] without blocking the caller: the future resolves once the
    /// engine thread answers, so a host that must keep its thread free (the
    /// React Native JavaScript thread) awaits it instead.
    ///
    /// # Errors
    ///
    /// The same as [`Self::call`].
    pub async fn call_async(
        &self,
        method: String,
        params_json: String,
    ) -> Result<String, KizunaSyncFfiError> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.submit(
            move |hosted| async move {
                kizunasync_engine::rpc::dispatch(&hosted.engine, &method, &params_json).await
            },
            move |envelope| {
                let _ = reply.send(envelope);
            },
        )?;
        answer.await.map_err(|_| stopped())
    }

    /// How many mutations are waiting to be pushed. Saturates at [`u32::MAX`].
    ///
    /// # Errors
    ///
    /// The store's code when the count cannot be read.
    pub fn outbox_depth(&self) -> Result<u32, KizunaSyncFfiError> {
        self.run(|hosted| async move {
            hosted
                .engine
                .get_outbox_depth()
                .map(|d| u32::try_from(d).unwrap_or(u32::MAX))
                .map_err(Into::into)
        })
    }

    /// Replace the user JWT the remote sends on its next call. `None` clears it.
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when this handle has no engine.
    pub fn set_access_token(&self, token: Option<String>) -> Result<(), KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            hosted.engine.set_remote_access_token(token);
            Ok(())
        })
    }

    /// Set the bucket parameters the object names, on every table bucketed on
    /// that key, leaving the others untouched. This is what a sign-in or a
    /// workspace switch calls.
    ///
    /// A non-empty value that differs from the one the store keeps for its key
    /// replaces the local scope: the next pull re-bootstraps every table and
    /// keeps only the new scope's rows, while queued writes stay.
    ///
    /// # Errors
    ///
    /// `JSON` when `params_json` is not an object, and `BUCKET_UNSET` when a key
    /// is not a configured bucket column.
    pub fn set_bucket(&self, params_json: String) -> Result<(), KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            let params = parse_object(&params_json)?;
            hosted.engine.set_bucket_params(&params)?;
            Ok(())
        })
    }

    /// Apply one op to every local row the filters select, and return their
    /// primary keys. Empty strings stand for absent `transforms` and
    /// `precondition`.
    ///
    /// # Errors
    ///
    /// `UNKNOWN_OP` for an op outside insert/update/delete, `JSON` for a
    /// malformed argument, and whatever the engine reports for the write.
    pub fn apply_where(
        &self,
        table: String,
        op: String,
        filters_json: String,
        columns_json: String,
        transforms_json: String,
        precondition_json: String,
    ) -> Result<Vec<String>, KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            hosted
                .engine
                .apply_where(ApplyWhere {
                    table,
                    filters: parse_filters(&filters_json)?,
                    op: parse_op(&op)?,
                    columns: parse_object(&columns_json)?,
                    transforms: parse_optional_object(&transforms_json)?,
                    precondition: parse_optional_object(&precondition_json)?,
                    // The typed surface carries no include-deleted modifier, so a
                    // write targets the rows a read on this surface reports.
                    include_deleted: false,
                })
                .map_err(Into::into)
        })
    }

    /// The rejection journal, newest first. `include_dismissed` also returns the
    /// entries the host already dismissed.
    ///
    /// # Errors
    ///
    /// The store's code when the journal cannot be read.
    pub fn rejections(
        &self,
        include_dismissed: bool,
    ) -> Result<Vec<FfiRejection>, KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            hosted
                .engine
                .list_rejections(include_dismissed)
                .map(|rows| rows.into_iter().map(FfiRejection::from).collect())
                .map_err(Into::into)
        })
    }

    /// Dismiss one journal entry. `false` means no entry carries that mutation id.
    ///
    /// # Errors
    ///
    /// The store's code when the journal cannot be written.
    pub fn dismiss_rejection(&self, mutation_id: String) -> Result<bool, KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            hosted
                .engine
                .dismiss_rejection(&mutation_id)
                .map_err(Into::into)
        })
    }

    /// Drop every local row, the outbox, the cursor and the journal, and return
    /// the sandbox paths the host must delete. The store then keeps a newly
    /// minted client identity, which the next registration uses.
    ///
    /// # Errors
    ///
    /// The store's code when the reset cannot be written.
    pub fn reset(&self) -> Result<Vec<String>, KizunaSyncFfiError> {
        self.run(|hosted| async move { hosted.engine.reset().await.map_err(Into::into) })
    }

    /// The current pull cursor and whether the engine is holding writes back,
    /// with the reason it is.
    ///
    /// # Errors
    ///
    /// The store's code when the cursor cannot be read.
    pub fn checkpoint(&self) -> Result<FfiCheckpoint, KizunaSyncFfiError> {
        self.run(|hosted| async move {
            Ok(FfiCheckpoint {
                cursor: hosted.engine.get_checkpoint()?,
                soft_blocked: hosted.engine.is_soft_blocked()?,
                soft_block_reason: hosted
                    .engine
                    .soft_block_reason()?
                    .map(|reason| reason.as_str().to_owned()),
            })
        })
    }

    /// Set the pull cursor without pulling, so a client resumes from a checkpoint
    /// the host already holds.
    ///
    /// # Errors
    ///
    /// The store's code when the cursor cannot be written.
    pub fn seed_checkpoint(&self, cursor: String) -> Result<(), KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            hosted
                .engine
                .seed_checkpoint(&cursor)
                .await
                .map_err(Into::into)
        })
    }

    /// Devtools snapshot of the local command queue: the queued page, the depth,
    /// the last mutation id, the cursor and the client identity. It is the payload
    /// `call("inspect", "{}")` answers with, unwrapped from the envelope, because
    /// the engine's own `inspect` is the one owner of those five fields.
    ///
    /// # Errors
    ///
    /// The code the engine reported inside the envelope, and `JSON` when the
    /// envelope itself cannot be read.
    pub fn inspect(&self) -> Result<String, KizunaSyncFfiError> {
        let envelope = parse_json_value(&self.call("inspect".into(), "{}".into())?)?;
        if envelope.get("ok") == Some(&json!(true)) {
            let value = envelope.get("value").unwrap_or(&Value::Null);
            return serde_json::to_string(value)
                .map_err(|error| KizunaSyncFfiError::engine(JSON, error.to_string()));
        }

        let error = envelope.get("error").unwrap_or(&Value::Null);
        Err(KizunaSyncFfiError::engine(
            error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or(ENGINE_UNAVAILABLE),
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("inspect failed"),
        ))
    }

    /// Drop the engine and its store, once the calls it already accepted have
    /// answered. Further typed calls fail `ENGINE_UNAVAILABLE` until `create`
    /// runs again. Named `shutdown` because `UniFFI` Kotlin already uses
    /// `close()` for `AutoCloseable`.
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when this handle's lock is poisoned.
    pub fn shutdown(&self) -> Result<(), KizunaSyncFfiError> {
        let mut hosting = self.hosting.lock().map_err(|_| lock_err())?;
        drop(hosting.actor.take());
        Ok(())
    }

    /// Run one pull round without pushing.
    ///
    /// # Errors
    ///
    /// Whatever the remote reports. A transport failure arrives as
    /// `PERMANENT_TRANSPORT` or `REMOTE`, with the server's message in `msg`.
    pub fn pull_once(&self) -> Result<(), KizunaSyncFfiError> {
        self.run(|hosted| async move { hosted.engine.pull_once().await.map_err(Into::into) })
    }

    /// Push one outbox batch without pulling.
    ///
    /// # Errors
    ///
    /// Whatever the remote reports. A transport failure arrives as
    /// `PERMANENT_TRANSPORT` or `REMOTE`, with the server's message in `msg`.
    pub fn push_once(&self) -> Result<(), KizunaSyncFfiError> {
        self.run(|hosted| async move { hosted.engine.push_once().await.map_err(Into::into) })
    }

    /// Register a host observer and return the id [`Self::unsubscribe`] takes.
    /// Ids never repeat on one handle, across `create` calls too. Events reach
    /// the observer on the handle's delivery thread, in emission order, so
    /// `on_event` may call back into this handle (see [`EventObserver`]).
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when this handle has no engine.
    pub fn subscribe(&self, observer: Arc<dyn EventObserver>) -> Result<u64, KizunaSyncFfiError> {
        let id = self.next_subscription.fetch_add(1, Ordering::Relaxed);
        self.run(move |hosted| async move {
            hosted.subscribe(id, observer);
            Ok(id)
        })
    }

    /// Stop the subscription `subscription_id` names. An unknown id is a no-op.
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when this handle has no engine.
    pub fn unsubscribe(&self, subscription_id: u64) -> Result<(), KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            hosted.unsubscribe(subscription_id);
            Ok(())
        })
    }

    /// Import a host file into the attachment sandbox, queue its upload, and
    /// return the Storage reference the column now holds. The reference's
    /// watchers then hear its new status on the delivery thread.
    ///
    /// # Errors
    ///
    /// `ATTACHMENT_PORTS_MISSING` when the handle was created without
    /// `attachment_root`, `ATTACHMENT_ROW_GONE` or `ATTACHMENT_OWNER_MISSING`
    /// when the row cannot carry the reference, and the transfer code when the
    /// bytes cannot be read.
    pub fn from_file(
        &self,
        table: String,
        column: String,
        pk: String,
        source_path: String,
        media_type: Option<String>,
    ) -> Result<FfiFromFileResult, KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            let result = hosted.engine.from_file(
                &table,
                &column,
                &pk,
                &source_path,
                media_type.as_deref(),
            )?;
            hosted.notify(&result.reference);
            Ok(FfiFromFileResult::from(result))
        })
    }

    /// The local path for `reference`, downloading the object when the sandbox
    /// does not hold it yet. `None` means the bytes are not on Storage yet. The
    /// reference's watchers then hear its new status on the delivery thread.
    /// The download waits for a `sync` in flight.
    ///
    /// # Errors
    ///
    /// The transfer code when the download fails, and
    /// `ATTACHMENT_PORTS_MISSING` when the handle has no sandbox.
    pub fn resolve_download(
        &self,
        reference: String,
    ) -> Result<Option<String>, KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            let path = hosted.engine.resolve_download(&reference).await?;
            hosted.notify(&reference);
            Ok(path)
        })
    }

    /// Delete the Storage object, the sandbox file and the row of every
    /// orphaned attachment, and the cached bytes of every evicted one without
    /// asking Storage. A removal Storage refuses with 401 or 403, or one still
    /// failing once the attachment budget is spent, leaves its row evicted.
    /// Does nothing without a session or on a soft-blocked store, and waits
    /// for a `sync` in flight.
    ///
    /// # Errors
    ///
    /// The store's code when a row cannot be read or written.
    pub fn vacuum(&self) -> Result<(), KizunaSyncFfiError> {
        self.run(
            |hosted| async move { hosted.engine.vacuum_attachments().await.map_err(Into::into) },
        )
    }

    /// The current status of `reference`, or `None` when no attachment row
    /// carries it.
    ///
    /// # Errors
    ///
    /// The store's code when the row cannot be read.
    pub fn get_status(
        &self,
        reference: String,
    ) -> Result<Option<FfiAttachmentStatus>, KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            hosted
                .engine
                .attachment_status(&reference)
                .map(|status| status.map(FfiAttachmentStatus::from))
                .map_err(Into::into)
        })
    }

    /// Watch one attachment reference and return the id [`Self::unwatch`] takes.
    /// Ids never repeat on one handle, across `create` calls too.
    ///
    /// This listener alone receives the current status right away, so
    /// registering never re-fires the reference's other watchers. After that,
    /// every watcher of the reference receives its status after each `sync`,
    /// and after a `from_file` or a `resolve_download` of that reference. Every
    /// status reaches the listener on the handle's delivery thread, in emission
    /// order, so `on_status` may call back into this handle (see
    /// [`AttachmentListener`]).
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when this handle has no engine.
    pub fn watch(
        &self,
        reference: String,
        listener: Arc<dyn AttachmentListener>,
    ) -> Result<u64, KizunaSyncFfiError> {
        let id = self.next_watch.fetch_add(1, Ordering::Relaxed);
        self.run(move |hosted| async move {
            hosted.watch(id, reference, listener);
            Ok(id)
        })
    }

    /// Drop the watcher `watch_id` names. An unknown id is a no-op.
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when this handle has no engine.
    pub fn unwatch(&self, watch_id: u64) -> Result<(), KizunaSyncFfiError> {
        self.run(move |hosted| async move {
            hosted.unwatch(watch_id);
            Ok(())
        })
    }
}

impl KizunaSyncEngine {
    /// Retire the current engine, if any, and start `engine` on a new engine
    /// thread. The lock is held throughout, so no call reaches either engine
    /// while one replaces the other.
    fn install(&self, engine: SyncEngine) -> Result<(), KizunaSyncFfiError> {
        let runtime = new_runtime()?;
        let mut hosting = self.hosting.lock().map_err(|_| lock_err())?;
        drop(hosting.actor.take());

        let deliveries = match &hosting.deliveries {
            Some(deliveries) => deliveries.clone(),
            None => hosting.deliveries.insert(Deliveries::start()?).clone(),
        };
        hosting.actor = Some(Actor::start(engine, runtime, deliveries)?);
        Ok(())
    }

    /// Queue `work` on the engine thread; `reply` receives its output there.
    fn submit<T, F, Fut>(
        &self,
        work: F,
        reply: impl FnOnce(T) + Send + 'static,
    ) -> Result<(), KizunaSyncFfiError>
    where
        T: 'static,
        F: FnOnce(Rc<Hosted>) -> Fut + Send + 'static,
        Fut: Future<Output = T> + 'static,
    {
        let hosting = self.hosting.lock().map_err(|_| lock_err())?;
        hosting
            .actor
            .as_ref()
            .ok_or_else(not_created)?
            .submit(work, reply)
    }

    /// Run `work` on the engine thread and block until it answers.
    fn run<T, F, Fut>(&self, work: F) -> Result<T, KizunaSyncFfiError>
    where
        T: Send + 'static,
        F: FnOnce(Rc<Hosted>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, KizunaSyncFfiError>> + 'static,
    {
        let (reply, answer) = std::sync::mpsc::sync_channel(1);
        self.submit(work, move |result| {
            let _ = reply.send(result);
        })?;
        answer.recv().map_err(|_| stopped())?
    }

    /// [`Self::create`] over a remote the test supplies.
    #[cfg(test)]
    pub(crate) fn create_over(
        &self,
        config_json: &str,
        remote: Arc<dyn kizunasync_engine::ProtocolRemote>,
    ) -> Result<(), KizunaSyncFfiError> {
        let config = config_value(config_json)?;
        let engine = create::build_engine_over(&config, remote, clock::deps())?;
        self.install(engine)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
