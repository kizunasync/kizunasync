//! The origin hybrid logical clock (HLC, Kulkarni et al. 2014) a device stamps
//! its `hlc`-table writes with, and the form the store keeps it in.
//!
//! The wire stamp is `<rfc3339 ms>|<counter>|<node>`; the store keeps
//! `<millis>|<counter>|<node>` under [`kizunasync_store::ORIGIN_HLC_KEY`], so
//! reading the last stamp back needs no RFC 3339 parser.

use crate::time::format_rfc3339_millis;

/// How far ahead of the wall clock a kept physical time may sit and still be
/// honored. Beyond it the kept time is read as a clock fault and discarded, the
/// paper's answer to a violated drift bound, rather than stamping every later
/// write under a time the device may never reach.
const MAX_DRIFT_MS: i64 = 3_600_000;

/// The last origin stamp a device minted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OriginClock {
    physical_ms: i64,
    counter: u64,
    node: String,
}

impl OriginClock {
    /// The kept stamp, or `None` when the store holds none. A value this engine
    /// cannot read is treated as none, so the device takes a fresh node rather
    /// than refusing every write to an `hlc` table.
    pub(crate) fn from_meta(value: &str) -> Option<Self> {
        let mut parts = value.splitn(3, '|');
        let physical_ms = parts.next()?.parse().ok()?;
        let counter = parts.next()?.parse().ok()?;
        let node = parts.next().filter(|node| !node.is_empty())?;
        Some(Self {
            physical_ms,
            counter,
            node: node.to_string(),
        })
    }

    /// The stamp that follows `last` at wall time `now_ms`: the physical part is
    /// the later of the two, the counter moves on while the physical part holds
    /// and starts over when the wall clock passes it. `mint_node` runs only for
    /// a device's first stamp.
    pub(crate) fn next(
        last: Option<Self>,
        now_ms: i64,
        mint_node: impl FnOnce() -> String,
    ) -> Self {
        let Some(last) = last else {
            return Self {
                physical_ms: now_ms,
                counter: 0,
                node: mint_node(),
            };
        };
        if last.physical_ms.saturating_sub(now_ms) > MAX_DRIFT_MS {
            return Self {
                physical_ms: now_ms,
                counter: 0,
                node: last.node,
            };
        }

        let physical_ms = last.physical_ms.max(now_ms);
        let counter = if physical_ms == last.physical_ms {
            last.counter.saturating_add(1)
        } else {
            0
        };
        Self {
            physical_ms,
            counter,
            node: last.node,
        }
    }

    /// The value the store keeps.
    pub(crate) fn to_meta(&self) -> String {
        format!("{}|{}|{}", self.physical_ms, self.counter, self.node)
    }

    /// The stamp the mutation carries on the wire.
    pub(crate) fn to_wire(&self) -> String {
        format!(
            "{}|{}|{}",
            format_rfc3339_millis(self.physical_ms),
            self.counter,
            self.node
        )
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{MAX_DRIFT_MS, OriginClock};

    const NOW_MS: i64 = 1_704_067_200_000;

    fn clock(physical_ms: i64, counter: u64) -> OriginClock {
        OriginClock {
            physical_ms,
            counter,
            node: "node".into(),
        }
    }

    fn no_mint() -> String {
        panic!("a device with a kept stamp minted a second node")
    }

    #[test]
    fn the_kept_value_round_trips() {
        let kept = clock(NOW_MS, 7);
        assert_eq!(kept.to_meta(), "1704067200000|7|node");
        assert_eq!(OriginClock::from_meta(&kept.to_meta()), Some(kept));
    }

    #[test]
    fn the_wire_stamp_renders_the_physical_part_as_rfc3339_milliseconds() {
        assert_eq!(
            clock(NOW_MS + 5, 2).to_wire(),
            "2024-01-01T00:00:00.005Z|2|node"
        );
    }

    #[test]
    fn an_absent_or_unreadable_value_reads_as_no_stamp() {
        for value in [
            "",
            "1704067200000",
            "1704067200000|7",
            "1704067200000|7|",
            "2024-01-01T00:00:00.000Z|7|node",
            "1704067200000|-1|node",
        ] {
            assert_eq!(OriginClock::from_meta(value), None, "{value:?}");
        }
    }

    #[test]
    fn the_first_stamp_mints_the_node_at_the_wall_clock() {
        assert_eq!(
            OriginClock::next(None, NOW_MS, || "node".into()),
            clock(NOW_MS, 0)
        );
    }

    #[test]
    fn the_counter_moves_on_while_the_physical_part_holds() {
        let last = Some(clock(NOW_MS, 3));
        assert_eq!(
            OriginClock::next(last.clone(), NOW_MS, no_mint),
            clock(NOW_MS, 4)
        );
        assert_eq!(
            OriginClock::next(last, NOW_MS - 1, no_mint),
            clock(NOW_MS, 4)
        );
    }

    #[test]
    fn the_counter_starts_over_when_the_wall_clock_passes_the_last_stamp() {
        assert_eq!(
            OriginClock::next(Some(clock(NOW_MS, 3)), NOW_MS + 1, no_mint),
            clock(NOW_MS + 1, 0)
        );
    }

    #[test]
    fn a_kept_time_beyond_the_drift_bound_is_discarded_and_the_node_kept() {
        let ahead = NOW_MS + MAX_DRIFT_MS;
        assert_eq!(
            OriginClock::next(Some(clock(ahead, 3)), NOW_MS, no_mint),
            clock(ahead, 4),
            "exactly at the bound is honored"
        );
        assert_eq!(
            OriginClock::next(Some(clock(ahead + 1, 3)), NOW_MS, no_mint),
            clock(NOW_MS, 0)
        );
    }
}
