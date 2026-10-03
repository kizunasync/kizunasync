//! Node-API surface for the Kizuna engine: the engine the `kizunasync` npm package runs on Node
//! and Bun. React Native runs `kizunasync-ffi` and the browser runs `kizunasync-wasm`.
//!
//! # Allocation
//!
//! Thin FFI boundary: no business logic. Allocation happens at the N-API
//! crossing. Not heapless. This crate does not `forbid(unsafe_code)` because
//! `N-API` glue needs `unsafe`.
//!
//! One class, one method: `new KizunaSyncEngine(...)` owns an engine instance and
//! `call(method, paramsJson)` runs everything. The instance shape is what lets
//! several `createKizunaSync` clients coexist in one process (tests do it
//! constantly), each with its own database, remote and event stream, which a
//! process-global engine could never give.
//!
//! The exported `KizunaSyncEngine` class is `Send + Sync`: its one field is a
//! `Mutex<Option<Live>>`, and every field `Live` carries (`Sender<Command>`,
//! `oneshot::Receiver<()>`, `JoinHandle<()>`) is `Send`, which is what a
//! `Mutex` needs to grant both bounds to the type it guards.
//!
//! The `pull` / `push` / `onEvent` callbacks are the port bridge: transport, auth
//! and retry classification stay in `TypeScript` where the app injected them, and
//! the engine calls back into them across a threadsafe function.
//!
//! Two lifecycle invariants hold for every handle. The work between JS and the
//! engine thread is bounded: the thread runs a capped number of calls at once
//! and the queue in front of it is capped too, so a caller that issues calls
//! faster than they answer waits on the next `call` instead of growing the
//! queue until the process is out of memory. And `close` is awaitable: it
//! resolves only after the calls already running have answered and the engine
//! thread has dropped its engine and released the database file, so reopening
//! the same file is safe on the next line. Both wait on napi-rs's own runtime
//! rather than the JS thread, which is what keeps the event loop free to
//! resolve the promise a `pull` or `push` is parked on.

#![expect(
    clippy::needless_pass_by_value,
    reason = "napi-rs requires owned `String` parameters on every exported function"
)]

mod actor;
mod remote;
mod rpc;

pub use engine_object::KizunaSyncEngine;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction};
use napi_derive::napi;

/// Health check. The `kizunasync` package's addon loader calls it to confirm a module it
/// resolved is this addon.
#[napi]
#[must_use]
pub fn ping() -> String {
    "pong".into()
}

// The `#[napi]` object macro expands to reference and object conversions that
// carry no rustdoc of their own, so the lint is confined to this module.
mod engine_object {
    #![allow(missing_docs)]

    use crate::actor::{self, Command, EngineSpec};
    use crate::forwarder;
    use napi::bindgen_prelude::*;
    use napi_derive::napi;
    use std::sync::Mutex;
    use std::thread::JoinHandle;
    use tokio::sync::mpsc::{Sender, channel};
    use tokio::sync::oneshot;

    /// Slots in the JS-to-engine command queue, one per `call` the engine thread
    /// has not taken yet. The thread caps the calls it runs at once, so once both
    /// are full a caller that issues calls faster than they answer waits on the
    /// next `call` instead of growing the queue without bound.
    const ENGINE_COMMAND_QUEUE_CAPACITY: usize = 256;

    /// The three things `close` needs: the queue it asks the thread to stop
    /// through, the signal the thread completes once the engine value is gone,
    /// and the thread itself. Taken as one, so a second `close` finds nothing and
    /// a `call` that arrives after one is refused rather than queued against a
    /// thread that is leaving.
    struct Live {
        commands: Sender<Command>,
        stopped: oneshot::Receiver<()>,
        thread: JoinHandle<()>,
    }

    /// A live engine: one database, one remote, one event stream.
    #[napi]
    pub struct KizunaSyncEngine {
        live: Mutex<Option<Live>>,
    }

    #[napi]
    impl KizunaSyncEngine {
        /// Open the engine. Throws when the config is refused or the database cannot
        /// be opened or migrated: the caller asked for the Rust engine, so a broken
        /// store is fatal, never a silent downgrade.
        ///
        /// N-API can only throw a JS `Error`, which carries no structured fields, so
        /// the thrown message starts with the engine's catalog code: a refused config
        /// reads `CONFIG_INVALID: …` and the store's own codes reach the caller the
        /// same way.
        ///
        /// `pull` and `push` receive a request JSON string and resolve the response
        /// envelope; `on_event` receives engine events as JSON.
        ///
        /// # Errors
        ///
        /// A JS error whose message is `<code>: <detail>` when the engine cannot be
        /// built, and a plain message when the engine thread will not start.
        #[napi(constructor)]
        pub fn new(
            env: Env,
            config_json: String,
            database_path: Option<String>,
            pull: JsFunction,
            push: JsFunction,
            on_event: JsFunction,
        ) -> Result<Self> {
            let spec = EngineSpec {
                config_json,
                database_path,
                pull: forwarder(env, pull)?,
                push: forwarder(env, push)?,
                on_event: forwarder(env, on_event)?,
            };

            let (commands, inbox) = channel(ENGINE_COMMAND_QUEUE_CAPACITY);
            let (ready, started) = std::sync::mpsc::channel();
            let (done, stopped) = oneshot::channel();
            let thread = std::thread::Builder::new()
                .name("kizunasync-engine".into())
                .spawn(move || actor::run(spec, inbox, &ready, done))
                .map_err(|error| Error::from_reason(format!("spawn engine thread: {error}")))?;

            match started.recv() {
                Ok(Ok(())) => Ok(Self {
                    live: Mutex::new(Some(Live {
                        commands,
                        stopped,
                        thread,
                    })),
                }),
                Ok(Err(message)) => Err(Error::from_reason(message)),
                Err(_) => Err(Error::from_reason("engine thread died during startup")),
            }
        }

        /// Run one engine method. Resolves with the response envelope; rejects only
        /// when the engine handle itself is gone (a method failure is `ok:false`).
        ///
        /// A local read or write answers while another call awaits the JS remote;
        /// the calls that pull or push, `reset`, and `seed_checkpoint` run one at
        /// a time, in arrival order.
        ///
        /// Waits for a free queue slot when the engine thread is behind. The wait
        /// happens on the runtime napi-rs drives this future on, never on the JS
        /// thread, so a saturated queue slows the caller's promise down instead of
        /// blocking the event loop.
        ///
        /// # Errors
        ///
        /// A JS error when the engine thread is closed or died before replying.
        #[napi]
        pub async fn call(&self, method: String, params: String) -> Result<String> {
            let commands = self.sender().ok_or_else(closed)?;
            let (reply, response) = oneshot::channel();
            commands
                .send(Command::Call {
                    method,
                    params,
                    reply,
                })
                .await
                .map_err(|_| closed())?;

            response
                .await
                .map_err(|_| Error::from_reason("kizunasync engine stopped before replying"))
        }

        /// Stop the engine thread and close the database. Idempotent.
        ///
        /// The returned promise resolves once the calls already running have
        /// answered, the engine value is gone and `SQLite` has released the
        /// database file, so a caller may reopen the same file on the next line.
        /// A second close resolves immediately.
        ///
        /// Asynchronous because the engine thread finishes a `pull` or `push` by
        /// awaiting a JS promise: napi-rs drives this future on its own runtime,
        /// which leaves the event loop free to resolve that promise while the
        /// thread waits for the call to answer.
        #[napi]
        pub async fn close(&self) {
            let Some(live) = self.take_live() else {
                return;
            };
            drop(live.commands.send(Command::Close).await);
            drop(live.commands);
            drop(live.stopped.await);
            // The thread has dropped its engine and is on its way out, so this
            // join only collects it.
            drop(tokio::task::spawn_blocking(move || live.thread.join()).await);
        }
    }

    impl KizunaSyncEngine {
        /// A sender for one command, or `None` once `close` took the handle's own.
        fn sender(&self) -> Option<Sender<Command>> {
            self.live
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(|live| live.commands.clone()))
        }

        /// Everything `close` needs, exactly once.
        fn take_live(&self) -> Option<Live> {
            self.live.lock().ok().and_then(|mut slot| slot.take())
        }
    }

    /// What a call reaching a closed handle is told. One sentence for both the
    /// taken sender and the closed channel: the handle is gone either way.
    fn closed() -> Error {
        Error::from_reason("kizunasync engine is closed")
    }
}

/// Wrap a JS callback so the engine thread can invoke it.
///
/// Unreferenced from the event loop on purpose: a live engine must not by itself
/// keep the process alive, or every test that forgets `close()` would hang.
///
/// # Errors
///
/// A JS error when the threadsafe function cannot be created or unreferenced.
fn forwarder(
    env: Env,
    callback: JsFunction,
) -> Result<ThreadsafeFunction<String, ErrorStrategy::Fatal>> {
    let mut tsfn = callback
        .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<String>| Ok(vec![ctx.value]))?;
    tsfn.unref(&env)?;
    Ok(tsfn)
}
