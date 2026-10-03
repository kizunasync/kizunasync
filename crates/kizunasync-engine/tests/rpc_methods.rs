//! The shared method table must name real dispatch arms, exactly once each.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::rpc_methods::METHODS;

#[test]
fn every_dispatch_arm_is_listed_once() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/rpc.rs");
    let src = std::fs::read_to_string(path).expect("rpc.rs");
    for m in METHODS {
        assert!(
            src.contains(&format!("\"{}\" =>", m.name)),
            "{} missing from dispatch",
            m.name
        );
    }
    let mut names: Vec<&str> = METHODS.iter().map(|m| m.name).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), METHODS.len(), "duplicate method names");
}
