//! Browser bridge: the same JSON request/response surface as `kizunasync-ffi`, over
//! wasm-bindgen.
//!
//! # Allocation
//!
//! Thin FFI boundary: no business logic. Allocation happens at the wasm-bindgen
//! crossing. Not heapless. This crate does not `forbid(unsafe_code)` because
//! `wasm-bindgen` glue needs `unsafe`.
//!
//! One class per engine, like the NAPI addon, because several clients coexist on
//! one page. Every call crosses as `(method, paramsJson)` and comes back as the
//! envelope `packages/core/src/query/rust-engine.ts` already parses, so a
//! failure is DATA the page reads, never a rejected promise.
#![cfg(target_arch = "wasm32")]

use kizunasync_engine::clock;
use kizunasync_engine::{EngineError, EngineEvent, EventHandler, SyncEngine, bridge, rpc};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

mod events;
mod remote;

use events::Observers;
use remote::JsRemote;

/// A call that arrived before the page built an engine.
const NOT_CREATED: &str = "create() has not been called on this engine";

/// The `ENGINE_UNAVAILABLE` envelope, built by the engine so it is byte-identical
/// to the one [`rpc::dispatch`] returns for every other failure and the page
/// keeps a single parser.
fn unavailable(message: &str) -> String {
    rpc::error_envelope(&EngineError::EngineUnavailable {
        message: message.to_string(),
    })
}

/// A rejected `create`, built by the engine so it is byte-identical to the
/// failure envelope [`rpc::dispatch`] answers a call with: the page parses one
/// shape and switches on one machine-readable code, `CONFIG_INVALID` for a
/// config it must respell and the store's own code for a database it cannot
/// open.
fn refused(error: &EngineError) -> JsValue {
    JsValue::from_str(&rpc::error_envelope(error))
}

/// One live engine: one database, one remote, one event stream.
#[wasm_bindgen]
pub struct KizunaSyncWasmEngine {
    inner: Rc<Cell<Option<Rc<SyncEngine>>>>,
    observers: Rc<RefCell<Observers>>,
}

/// The engine in `slot`, as a reference of the caller's own: the slot is never
/// borrowed, so nothing is held across an await and a later `create` or
/// `free()` leaves the caller's engine alive until it lets go.
fn current(slot: &Cell<Option<Rc<SyncEngine>>>) -> Option<Rc<SyncEngine>> {
    let engine = slot.take();
    slot.set(engine.clone());
    engine
}

impl Default for KizunaSyncWasmEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Fan every engine event out to the page's subscribers as the tagged event JSON
/// the `kizunasync` npm package consumes.
///
/// `EventHandler` is an `Arc` on every target; only its auto-trait bounds follow
/// the target, so the browser sink cannot be an `Rc` without changing the
/// engine's own signature.
#[expect(clippy::arc_with_non_send_sync)]
fn event_sink(observers: Rc<RefCell<Observers>>) -> EventHandler {
    Arc::new(move |event: EngineEvent| {
        let Ok(payload) = serde_json::to_string(&event) else {
            return;
        };

        // A busy borrow means a callback is re-entering the handle; delivering
        // from inside that borrow would panic, and an event is fire-and-forget.
        let Ok(borrowed) = observers.try_borrow() else {
            return;
        };

        let callbacks = borrowed.callbacks();
        drop(borrowed);

        let payload = JsValue::from_str(&payload);
        for callback in callbacks {
            drop(callback.call1(&JsValue::NULL, &payload));
        }
    })
}

#[wasm_bindgen]
impl KizunaSyncWasmEngine {
    /// A handle with no engine yet. Call [`Self::create`] before anything else.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self {
            inner: Rc::new(Cell::new(None)),
            observers: Rc::new(RefCell::new(Observers::default())),
        }
    }

    /// Open the engine described by `config_json`, with `pull` and `push` as the
    /// page's transport. Resolves with `undefined`, and rejects when the
    /// configuration or the store is refused: the page asked for the Rust
    /// engine, so a store it cannot open is fatal rather than a silent
    /// downgrade to memory.
    ///
    /// Every refusal rejects with the same failure envelope [`Self::call`]
    /// answers with, so the page reads a machine-readable code instead of
    /// classifying an opaque sentence: `CONFIG_INVALID` for a config it must
    /// respell, and the store's own code for a database that will not open
    /// (`STORE_BUSY` for a pool another context holds, `STORE_UNAVAILABLE` where
    /// no persistent VFS can be installed).
    ///
    /// The future owns its own handles to the engine cell, so a page that drops
    /// or frees the wrapper while this runs cannot leave it reading freed
    /// memory. The cell changes only once the engine is built: until then a
    /// call runs on the engine the handle already had, or answers
    /// `ENGINE_UNAVAILABLE` when there is none, and never sees a half-built
    /// one. Calls already running when it changes finish on the engine they
    /// started on.
    #[wasm_bindgen(unchecked_return_type = "Promise<void>")]
    pub fn create(
        &self,
        config_json: String,
        pull: js_sys::Function,
        push: js_sys::Function,
    ) -> js_sys::Promise {
        let inner = Rc::clone(&self.inner);
        let observers = Rc::clone(&self.observers);
        future_to_promise(async move {
            let raw: Value = serde_json::from_str(&config_json)
                .map_err(|e| refused(&EngineError::Config(e.to_string())))?;
            let config = bridge::parse_config(&raw).map_err(|e| refused(&e))?;
            let path = bridge::database_path(&raw).map_err(|e| refused(&e))?;
            let store = bridge::open_store_at_async(path)
                .await
                .map_err(|e| refused(&e))?;

            // The app stamps `now` on every call, so the engine's deps read the
            // clock the page pins per dispatch instead of the browser's.
            let engine = SyncEngine::new(
                store,
                config,
                Arc::new(JsRemote::new(pull, push)),
                clock::deps(),
            );
            // The engine drops its listeners with itself, so the unsubscribe
            // handle (which borrows the engine) is released before it is stored.
            drop(engine.subscribe(event_sink(observers)));
            inner.set(Some(Rc::new(engine)));
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Run one engine method and resolve with its envelope. Never rejects: a
    /// method failure and a missing engine are both `ok:false`.
    ///
    /// `params` may carry the embedder's clock (`now` / `now_ms`); the dispatch
    /// pins it, so the browser stamps rows, outbox entries and the rejection
    /// journal with the value the page sent.
    ///
    /// The call takes its own reference to the engine when it is made, so
    /// `free()` or a garbage collection of the wrapper while it is in flight
    /// drops one reference instead of the engine the call is still using.
    /// Nothing is borrowed across the await: a local call answers while a
    /// network call awaits the remote, and the engine runs the calls that pull
    /// or push one at a time.
    #[wasm_bindgen(unchecked_return_type = "Promise<string>")]
    pub fn call(&self, method: String, params: String) -> js_sys::Promise {
        let engine = current(&self.inner);
        future_to_promise(async move {
            let Some(engine) = engine else {
                return Ok(JsValue::from_str(&unavailable(NOT_CREATED)));
            };

            let response = rpc::dispatch(&engine, &method, &params).await;
            Ok(JsValue::from_str(&response))
        })
    }

    /// Receive engine events as JSON. The returned id is what `unsubscribe`
    /// takes; ids start at 1 and are never reused. `0` means no subscription was
    /// made, which happens only if the observer list is busy or its ids are
    /// exhausted.
    #[must_use]
    pub fn subscribe(&self, callback: js_sys::Function) -> u32 {
        self.observers
            .try_borrow_mut()
            .ok()
            .and_then(|mut observers| observers.add(callback))
            .unwrap_or(0)
    }

    /// Stop the subscription `id` names. Unknown ids are a no-op.
    pub fn unsubscribe(&self, id: u32) {
        // Unsubscribing from inside a delivery is the one busy case, and that
        // delivery already snapshotted its callbacks, so the drop is a no-op.
        if let Ok(mut observers) = self.observers.try_borrow_mut() {
            observers.remove(id);
        }
    }
}
