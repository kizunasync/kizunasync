//! The remote the corpus harness drives, and the only place a transcript fault
//! becomes a failed RPC.
//!
//! `ScriptedRemote` already replays queued responses and records the last
//! request, which is everything the `rpc` steps need. What it has no notion of
//! is a dropped push acknowledgement: its `push` always answers. So this wraps
//! it and adds one thing (a pending push failure) rather than forking the
//! queues, the auto-applied verdicts and the `last_*` recording that the rest of
//! the harness reads through `inner()`.
//!
//! Mirrors `TranscriptRemote` in `packages/core/src/conformance/transcript-remote.ts`,
//! which fails the in-flight call for both fault kinds on both targets.

use async_trait::async_trait;
use kizunasync_engine::{EngineError, ProtocolRemote, ScriptedRemote};
use kizunasync_protocol::{PullRequest, PullResponse, PushRequest, PushResponse};
use std::sync::{Arc, Mutex};

/// `ScriptedRemote` plus a pending-push-failure queue.
pub struct TranscriptRemote {
    inner: Arc<ScriptedRemote>,
    push_errors: Mutex<Vec<EngineError>>,
}

impl TranscriptRemote {
    /// A remote with an empty response queue and no pending push failure.
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ScriptedRemote::new()),
            push_errors: Mutex::new(Vec::new()),
        }
    }

    /// The scripted remote underneath: response queues and `last_pull` /
    /// `last_push`, which the `rpc` steps prime and assert against.
    #[must_use]
    pub fn inner(&self) -> &ScriptedRemote {
        &self.inner
    }

    /// Fail the next `push` with a retryable remote error (FIFO).
    ///
    /// The drop-ack fault: the server APPLIED the request (its bytes are
    /// asserted by the caller after the call returns) and the acknowledgement
    /// was lost, so the engine must leave the mutation queued and replay it on
    /// the transcript's next push step (push/003).
    pub fn fail_next_push(&self, message: impl Into<String>) {
        self.push_errors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(EngineError::remote(message.into()));
    }

    /// Fail the next `pull` with a retryable remote error (FIFO).
    pub fn fail_next_pull(&self, message: impl Into<String>) {
        self.inner.fail_next_pull(message);
    }
}

impl Default for TranscriptRemote {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl ProtocolRemote for TranscriptRemote {
    async fn pull(&self, request: PullRequest) -> Result<PullResponse, EngineError> {
        self.inner.pull(request).await
    }

    async fn push(&self, request: PushRequest) -> Result<PushResponse, EngineError> {
        let pending = {
            let mut errors = self
                .push_errors
                .lock()
                .map_err(|_| EngineError::remote("lock"))?;
            if errors.is_empty() {
                None
            } else {
                Some(errors.remove(0))
            }
        };
        let Some(error) = pending else {
            return self.inner.push(request).await;
        };

        // A dropped acknowledgement still leaves the request recorded, so the
        // caller can assert the golden bytes the server saw. The response queue
        // is deliberately NOT consumed: the server applied this request and the
        // transcript's next push step replays it to collect the recorded verdicts.
        *self
            .inner
            .last_push
            .lock()
            .map_err(|_| EngineError::remote("lock"))? = Some(request);
        Err(error)
    }
}
