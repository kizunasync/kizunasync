//! Per-reference attachment status fan-out.
//!
//! A host watches one attachment reference and receives its status whenever the
//! engine touches it. The registry owns the bookkeeping so every bridge fans out
//! the same way, and so the one invariant that keeps a host from deadlocking is
//! written once: payloads are COLLECTED while the caller holds its engine, and
//! DELIVERED after the caller has released it, which is what lets a listener call
//! back into the handle from inside its own callback.

use crate::attachment_queue::AttachmentStatus;
use crate::engine::SyncEngine;
use kizunasync_store::AttachmentState;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

/// One host callback, shared because a delivery outlives the borrow that
/// collected it.
pub type AttachmentListenerFn = Arc<dyn Fn(AttachmentStatus) + Send + Sync>;

/// A host callback and the status it is owed. Collected under the caller's lock,
/// invoked after it is released.
pub type AttachmentDelivery = (AttachmentListenerFn, AttachmentStatus);

/// The registry of live attachment watchers, one per `watch` call.
#[derive(Default)]
pub struct AttachmentWatchers {
    watchers: HashMap<u64, (String, AttachmentListenerFn)>,
    next_id: u64,
}

impl AttachmentWatchers {
    /// An empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `listener` for `reference` and return the id [`Self::unwatch`]
    /// takes. Ids start at 1 and are never reused.
    pub fn watch(
        &mut self,
        reference: String,
        listener: Box<dyn Fn(AttachmentStatus) + Send + Sync>,
    ) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.watchers.insert(id, (reference, Arc::from(listener)));
        id
    }

    /// Drop the watcher `id` names. An unknown id is a no-op.
    pub fn unwatch(&mut self, id: u64) {
        self.watchers.remove(&id);
    }

    /// The reference's current status, or the `missing` placeholder when the row
    /// is gone: a watcher is always handed a status, never nothing.
    #[must_use]
    pub fn status_or_missing(engine: &SyncEngine, reference: &str) -> AttachmentStatus {
        // A watcher signature cannot carry a failure, and a store fault here is
        // the same news for the host as an absent row: no bytes for this ref.
        engine
            .attachment_status(reference)
            .ok()
            .flatten()
            .unwrap_or(AttachmentStatus {
                state: AttachmentState::Missing,
                progress: 0,
                error: None,
                local_path: None,
                permanent: false,
                error_code: None,
            })
    }

    /// One delivery per watcher of `reference`, all carrying the same status.
    #[must_use]
    pub fn pending_payloads(
        &self,
        engine: &SyncEngine,
        reference: &str,
    ) -> Vec<AttachmentDelivery> {
        let status = Self::status_or_missing(engine, reference);

        self.watchers
            .values()
            .filter(|(watched, _)| watched == reference)
            .map(|(_, listener)| (Arc::clone(listener), status.clone()))
            .collect()
    }

    /// One payload round for every watched reference. The references are
    /// deduplicated first: [`Self::pending_payloads`] already fans a reference out
    /// to each of its watchers, so walking the watchers instead would deliver one
    /// callback per watcher pair.
    #[must_use]
    pub fn all_payloads(&self, engine: &SyncEngine) -> Vec<AttachmentDelivery> {
        let references: BTreeSet<&str> = self
            .watchers
            .values()
            .map(|(reference, _)| reference.as_str())
            .collect();

        references
            .into_iter()
            .flat_map(|reference| self.pending_payloads(engine, reference))
            .collect()
    }

    /// Call the host listeners. The caller must have released its engine first: a
    /// listener that reads the handle back would otherwise deadlock against the
    /// lock its own delivery is still holding.
    pub fn notify(payloads: Vec<AttachmentDelivery>) {
        for (listener, status) in payloads {
            listener(status);
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{AttachmentStatus, AttachmentWatchers};
    use crate::engine::tests::memory_engine;
    use std::sync::{Arc, Mutex};

    type Seen = Arc<Mutex<Vec<String>>>;

    fn recorder(seen: &Seen, name: &'static str) -> Box<dyn Fn(AttachmentStatus) + Send + Sync> {
        let seen = Arc::clone(seen);
        Box::new(move |status: AttachmentStatus| {
            if let Ok(mut log) = seen.lock() {
                log.push(format!("{name}:{}", status.state.as_str()));
            }
        })
    }

    /// A reference the store has never heard of still hands its watchers a
    /// status, and an unwatched listener hears nothing more.
    #[test]
    fn watch_delivers_once_per_watcher_and_unwatch_stops_it() {
        let engine = memory_engine();
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let mut watchers = AttachmentWatchers::new();

        let first = watchers.watch("u1/p1/photo".into(), recorder(&seen, "first"));
        let second = watchers.watch("u1/p1/photo".into(), recorder(&seen, "second"));
        assert_ne!(first, second);

        AttachmentWatchers::notify(watchers.pending_payloads(&engine, "u1/p1/photo"));
        assert_eq!(seen.lock().unwrap().len(), 2);

        watchers.unwatch(first);
        seen.lock().unwrap().clear();
        AttachmentWatchers::notify(watchers.all_payloads(&engine));
        assert_eq!(*seen.lock().unwrap(), vec!["second:missing".to_string()]);

        watchers.unwatch(second);
        seen.lock().unwrap().clear();
        AttachmentWatchers::notify(watchers.all_payloads(&engine));
        assert!(seen.lock().unwrap().is_empty());
    }

    /// Two watchers on two references are one round, not one round per watcher
    /// pair: `all_payloads` deduplicates the references first.
    #[test]
    fn all_payloads_is_one_round_per_watcher() {
        let engine = memory_engine();
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let mut watchers = AttachmentWatchers::new();
        watchers.watch("u1/p1/photo".into(), recorder(&seen, "a"));
        watchers.watch("u1/p2/photo".into(), recorder(&seen, "b"));
        watchers.watch("u1/p2/photo".into(), recorder(&seen, "c"));

        AttachmentWatchers::notify(watchers.all_payloads(&engine));

        assert_eq!(seen.lock().unwrap().len(), 3);
    }
}
