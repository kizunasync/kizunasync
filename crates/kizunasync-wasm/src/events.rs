//! The page's engine-event subscribers.
//!
//! Keyed by an opaque id rather than by the `Function` itself: two JS closures
//! can be equal by reference and the page still expects two subscriptions, and
//! `unsubscribe` has to name exactly one of them.

use js_sys::Function;

#[derive(Default)]
pub struct Observers {
    next_id: u32,
    entries: Vec<(u32, Function)>,
}

impl Observers {
    /// Register `callback` and return the id `remove` takes. Ids start at 1 and
    /// are never reused; `None` means the counter is exhausted, which no real
    /// session reaches but which must not silently hand out a live id twice.
    pub fn add(&mut self, callback: Function) -> Option<u32> {
        let id = self.next_id.checked_add(1)?;
        self.next_id = id;
        self.entries.push((id, callback));
        Some(id)
    }

    /// Drop the subscription `id` names. Unknown ids are a no-op: a page that
    /// unsubscribes twice is not an error.
    pub fn remove(&mut self, id: u32) {
        self.entries.retain(|(entry, _)| *entry != id);
    }

    /// The callbacks to notify, detached from the borrow: a callback that
    /// unsubscribes while it runs would otherwise mutate the list being walked.
    pub fn callbacks(&self) -> Vec<Function> {
        self.entries.iter().map(|(_, cb)| cb.clone()).collect()
    }
}
