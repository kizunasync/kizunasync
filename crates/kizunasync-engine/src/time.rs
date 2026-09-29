//! Std-only RFC3339 date helpers (no `chrono` dependency).

pub(crate) fn epoch_millis() -> i64 {
    // Unreachable on a supported host: the host clock would have to read past
    // 2^63 ms (year 292 million) to overflow the signed conversion.
    i64::try_from(crate::platform::now_unix_ms()).unwrap_or(0)
}

/// Current UTC instant as RFC3339 with milliseconds, std-only (no `chrono` dependency).
pub(crate) fn now_rfc3339() -> String {
    format_rfc3339_millis(epoch_millis())
}

/// Format epoch milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
///
/// POSIX time: leap seconds are not modeled, matching JavaScript `Date#toISOString`.
pub(crate) fn format_rfc3339_millis(epoch_millis: i64) -> String {
    let seconds = epoch_millis.div_euclid(1_000);
    let millis = epoch_millis.rem_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Days since 1970-01-01 to a proleptic Gregorian civil date.
///
/// Hinnant's `civil_from_days` (<http://howardhinnant.github.io/date_algorithms.html>),
/// shifting the era to start in March so the leap day lands at the end of a year.
const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}
