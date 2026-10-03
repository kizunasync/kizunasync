/// Milliseconds since the Unix epoch, per `Date.now()`.
#[must_use]
// `Date.now()` is a non-negative, finite millisecond count; float-to-int casts
// have saturated (not wrapped or panicked) since Rust 1.45.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn now_unix_ms() -> u64 {
    js_sys::Date::now() as u64
}

/// A random UUID v4, sourced from `WebCrypto` through `uuid`'s `js` feature.
///
/// # Panics
/// Panics if `WebCrypto` is unreachable (any non-secure browsing context), per
/// `uuid`'s wasm backend.
#[must_use]
pub fn random_uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}
