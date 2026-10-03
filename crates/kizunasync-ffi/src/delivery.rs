//! The thread that runs host callbacks.
//!
//! Engine events and attachment statuses are queued here by the engine thread
//! and run one at a time, in the order they were queued, on a thread that never
//! holds the engine. A callback may therefore call back into the handle: its
//! call is served by the engine thread while this one waits for the answer.

use crate::types::KizunaSyncFfiError;
use kizunasync_engine::error_catalog::ENGINE_UNAVAILABLE;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{Sender, channel};

/// One host callback, bound to the payload it is owed.
pub(crate) type Delivery = Box<dyn FnOnce() + Send>;

/// The queue of the handle's delivery thread. The thread ends once every clone
/// is dropped and the queued callbacks have run.
#[derive(Clone)]
pub(crate) struct Deliveries(Sender<Delivery>);

impl Deliveries {
    /// Start the delivery thread.
    ///
    /// # Errors
    ///
    /// `ENGINE_UNAVAILABLE` when the thread cannot be spawned.
    pub(crate) fn start() -> Result<Self, KizunaSyncFfiError> {
        let (queue, inbox) = channel::<Delivery>();
        std::thread::Builder::new()
            .name("kizunasync-deliveries".into())
            .spawn(move || {
                for delivery in inbox {
                    // A failing host callback drops its own delivery; catching it
                    // keeps this loop alive for the callbacks queued after it.
                    let _ = catch_unwind(AssertUnwindSafe(delivery));
                }
            })
            .map_err(|error| {
                KizunaSyncFfiError::engine(ENGINE_UNAVAILABLE, format!("delivery thread: {error}"))
            })?;
        Ok(Self(queue))
    }

    /// Queue one callback behind every callback queued before it.
    pub(crate) fn send(&self, delivery: Delivery) {
        // The thread outlives every sender, so a refused send cannot happen
        // while this queue exists.
        let _ = self.0.send(delivery);
    }
}
