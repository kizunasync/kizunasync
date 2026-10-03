//! The crontab grammar the pack accepts, judged before a migration is written.
//!
//! `kizunasync._settings` guards its three schedule columns with a check
//! constraint calling `kizunasync._is_cron_schedule`, so a bad value written by
//! this CLI would be refused at `supabase db push` with a file already on disk.
//! [`is_cron_schedule`] is that function's rules in Rust, field for field, so a
//! typo is a usage error at the flag or the prompt instead.
//!
//! Pure: a string in, a verdict out. No clock, no database.

use std::sync::OnceLock;

use regex::Regex;

/// Where a schedule can be read back in words.
pub const CRONTAB_GURU: &str = "https://crontab.guru/#";

/// How many whitespace-separated fields a schedule carries.
const FIELDS: usize = 5;

/// The inclusive bounds of each field, in order: minute, hour, day of month,
/// month, day of week. `7` is Sunday a second time, which is what the pack
/// accepts.
const BOUNDS: [(u8, u8); FIELDS] = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];

/// Whether `schedule` is a five-field crontab the pack's check constraint
/// accepts.
///
/// Refused, exactly as the SQL refuses them: a field count other than five,
/// month or weekday names, a seconds field, an `@` macro, a step on a lone
/// number (`16/2`), a step of zero, an inverted range (`5-1`), and any number
/// outside its field's bounds.
#[must_use]
pub fn is_cron_schedule(schedule: &str) -> bool {
    let Some(patterns) = patterns() else {
        return false;
    };
    // `btrim` strips spaces only, so other whitespace at either end survives into the split as an empty field.
    let fields: Vec<&str> = patterns
        .separator
        .split(schedule.trim_matches(' '))
        .collect();

    fields.len() == FIELDS
        && fields.iter().zip(BOUNDS).all(|(field, bounds)| {
            field
                .split(',')
                .all(|item| item_is_valid(&patterns.item, item, bounds))
        })
}

/// The crontab.guru page for `schedule`: its spaces become underscores, which
/// is the anchor that site reads.
#[must_use]
pub fn guru_link(schedule: &str) -> String {
    format!("{CRONTAB_GURU}{}", schedule.trim().replace(' ', "_"))
}

/// The refusal a bad schedule earns, naming the field it came from and where to
/// read the value back.
#[must_use]
pub fn refusal(field: &str, schedule: &str) -> String {
    format!(
        "{field} \"{schedule}\" is not a five-field UTC crontab (minute hour day-of-month month day-of-week, each a comma list of *, n, n-m or */k). Read yours back at {}",
        guru_link(schedule)
    )
}

/// The SQL judge's two patterns, compiled once. `[0-9]` stands in for the SQL's
/// `\d` (ASCII there; Unicode digits in Rust's `\d`), and the separator is
/// Postgres `[[:space:]]`, vertical tab included. Splitting on it keeps an empty
/// field for a whitespace run at either end, as `regexp_split_to_array` does.
struct Patterns {
    separator: Regex,
    item: Regex,
}

fn patterns() -> Option<&'static Patterns> {
    static PATTERNS: OnceLock<Option<Patterns>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            Some(Patterns {
                separator: Regex::new(r"[ \t\n\x0B\x0C\r]+").ok()?,
                item: Regex::new(r"^(?:\*|([0-9]{1,2})(?:-([0-9]{1,2}))?)(?:/([0-9]{1,2}))?$")
                    .ok()?,
            })
        })
        .as_ref()
}

/// One comma item against the SQL pattern, then the three rules the SQL applies on top of it.
fn item_is_valid(pattern: &Regex, item: &str, (low_bound, high_bound): (u8, u8)) -> bool {
    let Some(parts) = pattern.captures(item) else {
        return false;
    };
    let number = |group: usize| {
        parts
            .get(group)
            .and_then(|found| found.as_str().parse::<u8>().ok())
    };
    let step = number(3);

    if step == Some(0) {
        return false;
    }

    // `*` takes any step.
    let Some(low) = number(1) else {
        return true;
    };
    let high = number(2);

    // A step qualifies `*` or an explicit `n-m` range, never a lone `n`.
    if step.is_some() && high.is_none() {
        return false;
    }

    let high = high.unwrap_or(low);

    low >= low_bound && high <= high_bound && low <= high
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn every_shared_vector_the_pack_accepts_is_accepted_here_and_every_refused_one_refused() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/supabase-pack/tests/fixtures/cron-schedule-vectors.json"
        ));
        let json: serde_json::Value = serde_json::from_str(raw).expect("vectors json");
        for schedule in json["accepted"].as_array().expect("accepted") {
            let schedule = schedule.as_str().expect("accepted string");
            assert!(
                is_cron_schedule(schedule),
                "{schedule:?} should be accepted"
            );
        }
        for schedule in json["refused"].as_array().expect("refused") {
            let schedule = schedule.as_str().expect("refused string");
            assert!(
                !is_cron_schedule(schedule),
                "{schedule:?} should be refused"
            );
        }
    }

    /// `btrim` strips spaces only, so leading whitespace that is not a space
    /// survives into the field split and makes the count wrong. The two judges
    /// have to agree on that too.
    #[test]
    fn a_tab_is_not_trimmed_away_the_way_a_space_is() {
        assert!(!is_cron_schedule("\t16 3 * * *"));
        assert!(is_cron_schedule(" 16 3 * * * "));
    }

    #[test]
    fn a_three_digit_number_is_outside_the_shape_not_just_the_bounds() {
        assert!(!is_cron_schedule("100 3 * * *"));
        assert!(!is_cron_schedule("*/100 * * * *"));
    }

    #[test]
    fn the_guru_link_carries_the_schedule_with_underscores_for_spaces() {
        assert_eq!(guru_link("16 3 * * *"), "https://crontab.guru/#16_3_*_*_*");
        assert_eq!(
            guru_link("  */5 * * * *  "),
            "https://crontab.guru/#*/5_*_*_*_*"
        );
    }

    #[test]
    fn the_refusal_names_the_field_and_the_link() {
        let message = refusal("--reap-schedule", "@daily");

        assert!(message.contains("--reap-schedule"));
        assert!(message.contains("@daily"));
        assert!(message.contains("https://crontab.guru/#@daily"));
    }
}
