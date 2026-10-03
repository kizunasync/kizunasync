//! The engine thread.
//!
//! [`SyncEngine`] is `Send` and not `Sync` (its store owns a
//! `rusqlite::Connection`), so calls cannot share it across the threads Node
//! hands us. It lives on one owned thread instead and every call is a message
//! the thread runs as its own task on a `LocalSet`, over an `Rc<SyncEngine>`.
//! A local read or write therefore answers while a `pull` or `push` awaits the
//! promise the JS remote returns; the engine's own gate runs the calls that
//! pull or push one at a time. The JS side never blocks on `SQLite`, and the
//! engine never touches the JS thread.

use crate::remote::{JsRemote, RemoteCallback};
use crate::rpc;
use kizunasync_engine::bridge::{open_store_at, parse_config};
use kizunasync_engine::clock;
use kizunasync_engine::{EngineError, EngineEvent, EventHandler, SyncEngine};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::Value;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::Sender as ReadySender;
use tokio::sync::mpsc::Receiver;
use tokio::sync::{Semaphore, oneshot};
use tokio::task::LocalSet;

/// Calls the engine thread runs at once, one semaphore permit each. Past it the
/// next call waits for a running one to answer, and the command queue in front
/// of the thread fills until `call` waits too, so a burst never grows the work
/// without bound.
const MAX_RUNNING_CALLS: usize = 256;

/// Everything the thread needs to build its engine, moved across once.
pub struct EngineSpec {
    pub config_json: String,
    /// `None` ⇒ private in-memory store (the embedder had no file to hand us).
    pub database_path: Option<String>,
    pub pull: RemoteCallback,
    pub push: RemoteCallback,
    pub on_event: RemoteCallback,
}

pub enum Command {
    Call {
        method: String,
        params: String,
        reply: oneshot::Sender<String>,
    },
    Close,
}

/// Completes a handle's `close` once the engine value is gone and `SQLite` has
/// released the database file.
///
/// A guard rather than a send at the end of [`run`], so every exit signals: a
/// runtime that will not build and a store that will not open both leave the
/// thread immediately, and a `close` awaiting either would otherwise never
/// resolve.
struct Stopped(Option<oneshot::Sender<()>>);

impl Drop for Stopped {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            // A dropped receiver means nobody awaited this close; the thread is
            // ending either way.
            let _ = sender.send(());
        }
    }
}

/// Own the engine until the handle closes or is dropped.
///
/// `ready` reports construction (opening the database, applying migrations) so a
/// failure surfaces as a thrown constructor rather than a handle that fails on
/// first use. `stopped` reports the end, after the calls already running have
/// answered and the engine value has been dropped.
///
/// The thread stops taking calls on [`Command::Close`] or on the last sender
/// dropping, so a handle that closes with the queue full still stops this
/// thread.
pub fn run(
    spec: EngineSpec,
    commands: Receiver<Command>,
    ready: &ReadySender<Result<(), String>>,
    stopped: oneshot::Sender<()>,
) {
    // Declared first, so it is dropped last: after the runtime and the engine.
    let _stopped = Stopped(Some(stopped));

    let runtime = match kizunasync_engine::current_thread_runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            drop(ready.send(Err(format!("{}: {error}", error.code()))));
            return;
        }
    };

    let (engine, on_event) = match build(spec) {
        Ok(built) => built,
        Err(error) => {
            // N-API can only throw a JS `Error`, which carries no structured
            // fields, so the catalog code leads the message a host reads.
            drop(ready.send(Err(format!("{}: {error}", error.code()))));
            return;
        }
    };

    // The engine drops its listeners with itself, so the unsubscribe handle (which
    // borrows the engine) is released right away.
    drop(engine.subscribe(event_forwarder(on_event)));
    drop(ready.send(Ok(())));

    let engine = Rc::new(engine);
    let tasks = LocalSet::new();
    runtime.block_on(tasks.run_until(serve(Rc::clone(&engine), commands)));
    // Only a running call holds the engine's gate, so once every call has
    // answered no `pull` or `push` is left in flight when the engine drops.
    runtime.block_on(tasks);
}

/// Run each call as its own task until the handle closes, at most
/// [`MAX_RUNNING_CALLS`] at once. The tasks share the `LocalSet` this future
/// runs in, which outlives it: a close stops the intake, not the calls.
async fn serve(engine: Rc<SyncEngine>, mut commands: Receiver<Command>) {
    let permits = Arc::new(Semaphore::new(MAX_RUNNING_CALLS));

    while let Some(command) = commands.recv().await {
        match command {
            Command::Call {
                method,
                params,
                reply,
            } => {
                // Acquiring fails only on a closed semaphore, and this one is
                // never closed.
                let Ok(permit) = Arc::clone(&permits).acquire_owned().await else {
                    return;
                };
                let engine = Rc::clone(&engine);

                tokio::task::spawn_local(async move {
                    let response = rpc::dispatch(&engine, &method, &params).await;
                    drop(reply.send(response));
                    drop(permit);
                });
            }
            Command::Close => return,
        }
    }
}

fn build(spec: EngineSpec) -> Result<(SyncEngine, RemoteCallback), EngineError> {
    let raw: Value = serde_json::from_str(&spec.config_json)
        .map_err(|error| EngineError::Config(format!("engine config: {error}")))?;
    let config = parse_config(&raw)?;

    let store = open_store_at(spec.database_path.as_deref())?;
    let remote = Arc::new(JsRemote::new(spec.pull, spec.push));
    let engine = SyncEngine::new(store, config, remote, clock::deps());

    Ok((engine, spec.on_event))
}

/// Forward engine events to JS as the tagged event JSON `@kizunasync/core` consumes.
/// Non-blocking: an event is a notification, never backpressure on sync.
fn event_forwarder(on_event: RemoteCallback) -> EventHandler {
    Arc::new(move |event: EngineEvent| {
        // `EngineEvent` is a closed serde enum of owned scalars, so the encode
        // cannot fail; a notification is never worth failing an engine call for.
        if let Ok(payload) = serde_json::to_string(&event) {
            on_event.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
        }
    })
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
