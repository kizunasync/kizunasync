//! Wall clock and the migration-timestamp format, owned once.
//!
//! Migration filenames are the only thing in the CLI that needs a calendar; the
//! standard library has none, so `migration_version` uses `jiff`, the way the
//! Supabase CLI uses Go's time package.

use jiff::Timestamp;

/// The current UTC instant as epoch seconds, or `0` when the clock reads before
/// the epoch.
///
/// The one impure function here: callers thread the value through so every name
/// a run produces derives from a single instant a test can fix.
#[must_use]
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_secs()).ok())
        .unwrap_or_default()
}

/// UTC `YYYYMMDDHHMMSS`, the way the Supabase CLI names a migration file.
///
/// `unix_secs` is clamped into `Timestamp::MIN..=Timestamp::MAX` first, so
/// `from_second` cannot fail; the unreachable error arm falls back to the Unix
/// epoch.
#[must_use]
pub fn migration_version(unix_secs: i64) -> String {
    let clamped = unix_secs.clamp(Timestamp::MIN.as_second(), Timestamp::MAX.as_second());
    let instant = Timestamp::from_second(clamped).unwrap_or(Timestamp::UNIX_EPOCH);

    instant.strftime("%Y%m%d%H%M%S").to_string()
}

/// The UTC second a [`migration_version`]-shaped version names, `None` for a
/// version of any other shape.
#[must_use]
pub fn migration_second(version: &str) -> Option<i64> {
    if version.len() != 14 {
        return None;
    }

    let civil = jiff::civil::DateTime::strptime("%Y%m%d%H%M%S", version).ok()?;

    civil
        .to_zoned(jiff::tz::TimeZone::UTC)
        .ok()
        .map(|zoned| zoned.timestamp().as_second())
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn the_epoch_and_a_known_instant_convert_exactly() {
        assert_eq!(migration_version(0), "19700101000000");
        assert_eq!(migration_version(1_700_000_000), "20231114221320");
    }

    #[test]
    fn a_leap_day_is_not_off_by_one() {
        // 2024-02-29T00:00:00Z
        assert_eq!(migration_version(1_709_164_800), "20240229000000");
    }

    #[test]
    fn a_negative_second_stays_gregorian_the_day_before_the_epoch() {
        assert_eq!(migration_version(-1), "19691231235959");
    }

    #[test]
    fn a_version_reads_back_as_the_second_it_names() {
        for second in [0, 1_700_000_000, 1_709_164_800, 951_827_696] {
            assert_eq!(
                migration_second(&migration_version(second)),
                Some(second),
                "{second}"
            );
        }
    }

    #[test]
    fn a_version_of_another_shape_names_no_second() {
        for version in [
            "0001",
            "2023111422132",
            "202311142213201",
            "20231314221320",
            "",
        ] {
            assert_eq!(migration_second(version), None, "{version:?}");
        }
    }
}
