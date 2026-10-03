use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, per the host clock.
#[must_use]
pub fn now_unix_ms() -> u64 {
    // Unreachable on a supported host: both fallbacks need a system clock set
    // before 1970 or past 2^64 ms (year 584 million).
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// A random UUID v4, per the host's `getrandom` source.
#[must_use]
pub fn random_uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}
