//! The host clock and UUID source behave like a real clock and a real UUID v4.

use kizunasync_engine::platform;

#[test]
fn now_is_monotonic_enough_and_recent() {
    let a = platform::now_unix_ms();
    let b = platform::now_unix_ms();
    assert!(b >= a);
    assert!(a > 1_700_000_000_000, "unix ms after 2023");
}

#[test]
fn a_generated_uuid_carries_the_v4_shape() {
    let id = platform::random_uuid_v4();
    assert_eq!(id.len(), 36);
    assert_eq!(&id[14..15], "4");
}
