//! In-memory `ProtocolRemote` for tests and transcript scripting.

use crate::config::ProtocolRemote;
use crate::error::EngineError;
use async_trait::async_trait;
use kizunasync_protocol::{Op, PullRequest, PullResponse, PushRequest, PushResponse, Verdict};
use std::sync::{Mutex, PoisonError};

/// Simple in-memory remote for tests / transcript scripting.
pub struct ScriptedRemote {
    /// Queued pull responses, consumed FIFO by this remote's `pull`.
    pub pull_responses: Mutex<Vec<PullResponse>>,
    /// Queued push responses, consumed FIFO by this remote's `push`.
    pub push_responses: Mutex<Vec<PushResponse>>,
    /// Queued pull errors, consumed FIFO before any queued response.
    pub pull_errors: Mutex<Vec<EngineError>>,
    /// The most recent push request this remote received.
    pub last_push: Mutex<Option<PushRequest>>,
    /// The most recent pull request this remote received.
    pub last_pull: Mutex<Option<PullRequest>>,
}

impl ScriptedRemote {
    /// An empty remote: no scripted responses, no scripted errors, no recorded requests.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            pull_responses: Mutex::new(Vec::new()),
            push_responses: Mutex::new(Vec::new()),
            pull_errors: Mutex::new(Vec::new()),
            last_push: Mutex::new(None),
            last_pull: Mutex::new(None),
        }
    }

    /// Fail the next `pull` with a retryable remote error (FIFO).
    pub fn fail_next_pull(&self, message: impl Into<String>) {
        self.pull_errors
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(EngineError::remote(message.into()));
    }

    /// Queue a pull response for the next `pull_once` (FIFO).
    pub fn enqueue_pull(&self, response: PullResponse) {
        self.pull_responses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(response);
    }

    /// Queue a push response for the next `push_once` (FIFO).
    pub fn enqueue_push(&self, response: PushResponse) {
        self.push_responses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(response);
    }
}

impl Default for ScriptedRemote {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl ProtocolRemote for ScriptedRemote {
    async fn pull(&self, req: PullRequest) -> Result<PullResponse, EngineError> {
        *self
            .last_pull
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(req);

        {
            let mut errs = self
                .pull_errors
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if !errs.is_empty() {
                return Err(errs.remove(0));
            }
        }

        let mut q = self
            .pull_responses
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if q.is_empty() {
            return Ok(PullResponse {
                cursor: "0".into(),
                has_more: false,
                rows: vec![],
                tombstones: vec![],
                signal: None,
                conflicts: None,
            });
        }
        Ok(q.remove(0))
    }

    async fn push(&self, req: PushRequest) -> Result<PushResponse, EngineError> {
        *self
            .last_push
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(req.clone());

        let mut q = self
            .push_responses
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if q.is_empty() {
            // Every mutation applies, and the row comes back as the server
            // answers it: a delete leaves no row to render.
            let verdicts = req
                .batch
                .mutations
                .iter()
                .map(|m| Verdict {
                    mutation_id: m.mutation_id.clone(),
                    verdict: "applied".into(),
                    reason: None,
                    server_row: (m.op != Op::Delete).then(|| m.columns.clone()),
                })
                .collect();
            return Ok(PushResponse {
                verdicts: Some(verdicts),
                signal: None,
                batch: None,
            });
        }
        Ok(q.remove(0))
    }
}
