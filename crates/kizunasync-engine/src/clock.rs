//! The embedder's clock, forwarded into [`EngineDeps`].
//!
//! The app owns `now`: a suite under test freezes it, and a host that stamps its
//! own requests expects the rows, outbox entries and rejection journal the engine
//! writes to carry the value the request carried. Each call brings the caller's
//! clock as a [`ClockEnvelope`], [`crate::rpc::dispatch`] pins it on the thread
//! for every poll of that call's future, and the deps [`deps`] builds read the
//! pinned value.
//!
//! The pin is set when a poll starts and restored when it ends, so two
//! dispatches in flight on one thread each read their own clock, and a typed
//! method called between their polls reads the system clock.

use crate::EngineDeps;
use serde::Deserialize;
use std::cell::Cell;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

thread_local! {
    /// The clock of the dispatch this thread is polling, empty between polls.
    static PINNED: Cell<ClockEnvelope> = const {
        Cell::new(ClockEnvelope {
            now: None,
            now_ms: None,
        })
    };
}

/// The embedder's clock as it travels on the JSON call surface. Every bridge
/// reads the same two optional keys off `params`, so a request means the same
/// thing on Swift, Kotlin, Node, Bun and the browser.
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct ClockEnvelope {
    /// RFC 3339 timestamp the engine stamps rows and journal entries with.
    #[serde(default)]
    pub now: Option<String>,
    /// Epoch milliseconds the engine stamps numeric times with.
    #[serde(default)]
    pub now_ms: Option<i64>,
}

/// A future that runs with its own [`ClockEnvelope`] pinned on the thread
/// for the length of each poll.
pub(crate) struct ClockPinned<F> {
    envelope: ClockEnvelope,
    // Boxed so this wrapper is `Unpin` and swaps its envelope without
    // projecting the pin into the inner future.
    future: Pin<Box<F>>,
}

impl<F: Future> Future for ClockPinned<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        let this = self.get_mut();
        let _pinned = Installed::swap_in(&mut this.envelope);
        this.future.as_mut().poll(cx)
    }
}

/// Wrap `future` so the clock `params` carries is pinned during each of its
/// polls. A body that is not a clock envelope pins no clock, so the deps read
/// the system clock rather than another call's time.
#[must_use]
pub(crate) fn pin_for_dispatch<F: Future>(params: &str, future: F) -> ClockPinned<F> {
    ClockPinned {
        envelope: serde_json::from_str(params).unwrap_or_default(),
        future: Box::pin(future),
    }
}

/// The envelope of one poll, swapped into the thread's pin and swapped back
/// out on drop, so a poll that unwinds still restores the pin it found.
struct Installed<'a>(&'a mut ClockEnvelope);

impl<'a> Installed<'a> {
    fn swap_in(envelope: &'a mut ClockEnvelope) -> Self {
        swap_pinned(envelope);
        Self(envelope)
    }
}

impl Drop for Installed<'_> {
    fn drop(&mut self) {
        swap_pinned(self.0);
    }
}

fn swap_pinned(envelope: &mut ClockEnvelope) {
    // A thread tearing down its locals polls no dispatch, so it has no pin to swap.
    let _ = PINNED.try_with(|pinned| pinned.swap(Cell::from_mut(envelope)));
}

/// What `read` answers about the pinned envelope, `None` outside a dispatch.
fn pinned<T>(read: impl FnOnce(&ClockEnvelope) -> Option<T>) -> Option<T> {
    PINNED
        .try_with(|pinned| {
            let envelope = pinned.take();
            let value = read(&envelope);
            pinned.set(envelope);
            value
        })
        .ok()
        .flatten()
}

/// Engine deps that read the clock the dispatch being polled pinned, falling
/// back to the defaults.
#[must_use]
pub fn deps() -> EngineDeps {
    let EngineDeps {
        now,
        now_millis,
        uuid,
    } = EngineDeps::default();

    EngineDeps {
        now: Box::new(move || pinned(|clock| clock.now.clone()).unwrap_or_else(&now)),
        now_millis: Box::new(move || pinned(|clock| clock.now_ms).unwrap_or_else(&now_millis)),
        uuid,
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{ClockEnvelope, deps, pin_for_dispatch};
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    const PINNED_NOW: &str = "2021-05-05T05:05:05.000Z";
    const PINNED_PARAMS: &str = r#"{"now":"2021-05-05T05:05:05.000Z","now_ms":1620191105000}"#;

    fn envelope(params: &str) -> ClockEnvelope {
        serde_json::from_str(params).expect("the envelope tolerates any object")
    }

    /// Answers `Pending` on its first poll only, so a pinned future can be
    /// suspended between two reads of the clock.
    struct YieldOnce(bool);

    impl Future for YieldOnce {
        type Output = ();

        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
            if self.0 {
                return Poll::Ready(());
            }
            self.0 = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }

    #[test]
    fn an_envelope_reads_both_keys_off_a_request_that_carries_other_fields() {
        let parsed = envelope(
            r#"{"table":"items","now":"2021-05-05T05:05:05.000Z","now_ms":1620190005000}"#,
        );
        assert_eq!(
            parsed,
            ClockEnvelope {
                now: Some("2021-05-05T05:05:05.000Z".into()),
                now_ms: Some(1_620_190_005_000),
            }
        );
    }

    #[test]
    fn a_request_without_a_clock_parses_as_an_unpinned_envelope() {
        assert_eq!(envelope("{}"), ClockEnvelope::default());
        assert_eq!(envelope(r#"{"table":"items"}"#), ClockEnvelope::default());
    }

    /// The pin reaches the deps the engine reads while the dispatch is polled,
    /// and only then: a read after the dispatch returned is the system clock's,
    /// so a later request never stamps with this one's timestamp.
    #[tokio::test]
    async fn the_deps_read_the_pin_only_while_its_dispatch_is_polled() {
        let deps = deps();

        let seen =
            pin_for_dispatch(PINNED_PARAMS, async { ((deps.now)(), (deps.now_millis)()) }).await;

        assert_eq!(seen, (PINNED_NOW.to_string(), 1_620_191_105_000));
        assert_ne!((deps.now)(), PINNED_NOW);
        assert_ne!((deps.now_millis)(), 1_620_191_105_000);
    }

    /// A body that is not a clock envelope pins nothing: its dispatch reads
    /// the system clock, not a time some other call pinned.
    #[tokio::test]
    async fn a_dispatch_without_a_clock_reads_the_system_clock() {
        let deps = deps();

        let seen = pin_for_dispatch("not json", async { (deps.now)() }).await;

        assert_ne!(seen, PINNED_NOW);
    }

    /// Two dispatches suspended and resumed in turn on one thread each read
    /// their own clock before and after the other one ran.
    #[tokio::test]
    async fn interleaved_dispatches_each_read_their_own_clock() {
        let deps = deps();
        let read = |label: &'static str| {
            let deps = &deps;
            async move {
                let before = (deps.now)();
                YieldOnce(false).await;
                (label, before, (deps.now)(), (deps.now_millis)())
            }
        };

        let (first, second) = tokio::join!(
            pin_for_dispatch(r#"{"now":"first","now_ms":1}"#, read("first")),
            pin_for_dispatch(r#"{"now":"second","now_ms":2}"#, read("second")),
        );

        assert_eq!(first, ("first", "first".into(), "first".into(), 1));
        assert_eq!(second, ("second", "second".into(), "second".into(), 2));
    }

    /// A dispatch polled from inside another one reads its own clock, and the
    /// outer one reads its own again once the inner one returned.
    #[tokio::test]
    async fn a_nested_dispatch_restores_the_outer_clock() {
        let deps = deps();

        let seen = pin_for_dispatch(r#"{"now":"outer"}"#, async {
            let inner = pin_for_dispatch(r#"{"now":"inner"}"#, async { (deps.now)() }).await;
            (inner, (deps.now)())
        })
        .await;

        assert_eq!(seen, ("inner".to_string(), "outer".to_string()));
    }
}
