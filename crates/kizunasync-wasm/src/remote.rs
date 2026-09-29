//! [`ProtocolRemote`] backed by the two JavaScript callbacks the page injected.
//!
//! Same split as the NAPI bridge: the engine speaks the protocol, the page owns
//! the transport, its auth and its retry classification, and the outcome comes
//! back as the envelope [`remote_envelope::parse`] decodes. `fetch` is never
//! called from Rust, so a page keeps whatever client and session handling it
//! already has.

use async_trait::async_trait;
use js_sys::{Function, Promise};
use kizunasync_engine::{EngineError, ProtocolRemote, remote_envelope};
use kizunasync_protocol::{PullRequest, PullResponse, PushRequest, PushResponse};
use serde::Serialize;
use serde::de::DeserializeOwned;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

/// A thrown or rejected `JsValue` as text. An `Error` stringifies through its
/// own `toString`, anything else through its debug form.
fn describe(value: &JsValue) -> String {
    value
        .as_string()
        .or_else(|| {
            value
                .dyn_ref::<js_sys::Error>()
                .map(|e| e.to_string().into())
        })
        .unwrap_or_else(|| format!("{value:?}"))
}

/// The page's two transport callbacks, held for the life of the engine.
pub struct JsRemote {
    pull: Function,
    push: Function,
}

impl JsRemote {
    #[must_use]
    pub const fn new(pull: Function, push: Function) -> Self {
        Self { pull, push }
    }

    /// Marshal `request`, await the promise the page returns, and decode the
    /// envelope. A callback that throws or rejects is environmental, so the
    /// queued write stays queued.
    async fn round_trip<Response: DeserializeOwned>(
        callback: &Function,
        operation: &str,
        request: &impl Serialize,
    ) -> Result<Response, EngineError> {
        let payload = serde_json::to_string(request)?;

        let returned = callback
            .call1(&JsValue::NULL, &JsValue::from_str(&payload))
            .map_err(|error| {
                EngineError::remote(format!(
                    "{operation}: js remote unavailable ({})",
                    describe(&error)
                ))
            })?;

        let promise = returned.dyn_into::<Promise>().map_err(|_| {
            EngineError::remote(format!("{operation}: remote callback returned no promise"))
        })?;

        let resolved = JsFuture::from(promise)
            .await
            .map_err(|error| EngineError::remote(format!("{operation}: {}", describe(&error))))?;

        let raw = resolved.as_string().ok_or_else(|| {
            EngineError::remote(format!(
                "{operation}: remote callback resolved a non-string"
            ))
        })?;

        remote_envelope::parse(&raw, operation)
    }
}

#[async_trait(?Send)]
impl ProtocolRemote for JsRemote {
    async fn pull(&self, req: PullRequest) -> Result<PullResponse, EngineError> {
        Self::round_trip(&self.pull, "pull", &req).await
    }

    async fn push(&self, req: PushRequest) -> Result<PushResponse, EngineError> {
        Self::round_trip(&self.push, "push", &req).await
    }
}
