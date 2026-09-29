//! [`ProtocolRemote`] backed by the JavaScript remote the embedder injected.
//!
//! The whole point of the bridge: the Rust engine speaks the protocol, the
//! `TypeScript` adapter (`createRpcRemote`, a test fake, …) owns the transport,
//! its auth and its retry classification. Each call marshals the request to JSON,
//! invokes the JS function through a threadsafe function, and awaits the promise
//! it returns, so the JS event loop stays free while the engine thread waits.

use async_trait::async_trait;
use kizunasync_engine::{EngineError, ProtocolRemote, remote_envelope};
use kizunasync_protocol::{PullRequest, PullResponse, PushRequest, PushResponse};
use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use serde::de::DeserializeOwned;

/// A JS remote callback: `(requestJson) => Promise<envelopeJson>`.
pub type RemoteCallback = ThreadsafeFunction<String, ErrorStrategy::Fatal>;

pub struct JsRemote {
    pull: RemoteCallback,
    push: RemoteCallback,
}

impl JsRemote {
    #[must_use]
    pub const fn new(pull: RemoteCallback, push: RemoteCallback) -> Self {
        Self { pull, push }
    }

    async fn call<Response: DeserializeOwned>(
        callback: &RemoteCallback,
        operation: &str,
        request: String,
    ) -> Result<Response, EngineError> {
        let promise: Promise<String> = callback.call_async(request).await.map_err(|error| {
            // A closing/aborted threadsafe function or a synchronously throwing
            // callback: environmental, so the queued write stays queued.
            EngineError::remote(format!("{operation}: js remote unavailable ({error})"))
        })?;

        let raw = promise
            .await
            .map_err(|error| EngineError::remote(format!("{operation}: {error}")))?;

        remote_envelope::parse(&raw, operation)
    }
}

#[async_trait]
impl ProtocolRemote for JsRemote {
    async fn pull(&self, req: PullRequest) -> Result<PullResponse, EngineError> {
        Self::call(&self.pull, "pull", serde_json::to_string(&req)?).await
    }

    async fn push(&self, req: PushRequest) -> Result<PushResponse, EngineError> {
        Self::call(&self.push, "push", serde_json::to_string(&req)?).await
    }
}
