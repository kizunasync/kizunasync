//! The checked-in error-code spec must match the Rust catalog that produced it.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::EngineEvent;
use kizunasync_engine::error_catalog::CATALOG;

fn quoted_catalog_codes(text: &str) -> Vec<&str> {
    let mut codes = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            let start = index + 1;
            let Some(end) = text[start..].find('"') else {
                break;
            };
            let token = &text[start..start + end];
            if token
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b == b'_' || b.is_ascii_digit())
                && token.contains('_')
            {
                codes.push(token);
            }
            index = start + end + 1;
        } else {
            index += 1;
        }
    }
    codes
}

#[test]
fn swift_and_kotlin_hand_written_codes_are_in_the_catalog() {
    let swift = std::fs::read_to_string(
        "../../crates/kizunasync-ffi/bindings/swift/Sources/KizunaSync/KizunaSync.swift",
    )
    .expect("KizunaSync.swift");
    let kotlin = std::fs::read_to_string(
        "../../crates/kizunasync-ffi/bindings/kotlin/src/main/kotlin/com/kizunasync/kizunasync/KizunaSyncError.kt",
    )
    .expect("KizunaSyncError.kt");
    for (path, text) in [
        ("KizunaSync.swift", swift.as_str()),
        ("KizunaSyncError.kt", kotlin.as_str()),
    ] {
        for code in quoted_catalog_codes(text) {
            assert!(
                kizunasync_engine::error_catalog::contains(code),
                "{path} quotes {code}, which is not in error_catalog"
            );
        }
    }
}

#[test]
fn engine_event_names_match_the_protocol_list() {
    let json = std::fs::read_to_string("../../packages/protocol/spec/engine-events.json")
        .expect("engine-events.json");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("json");
    let producer: Vec<&str> = parsed["producer"]
        .as_array()
        .expect("producer")
        .iter()
        .map(|value| value.as_str().expect("name"))
        .collect();
    assert_eq!(EngineEvent::all_names(), producer.as_slice());
    let from_variants = [
        EngineEvent::LocalChanged.name(),
        EngineEvent::MutationRejected {
            mutation_id: String::new(),
            reason: String::new(),
        }
        .name(),
        EngineEvent::QueueDepth { depth: 0 }.name(),
        EngineEvent::ResetRequired { reason: None }.name(),
        EngineEvent::CheckpointExpired.name(),
        EngineEvent::BatchAborted {
            offender_mutation_id: String::new(),
            reason: String::new(),
        }
        .name(),
        EngineEvent::DeadLetter {
            mutation_id: String::new(),
            reason: String::new(),
        }
        .name(),
        EngineEvent::ColumnOverwritten {
            table: String::new(),
            pk: String::new(),
            column: String::new(),
            loser_value: serde_json::Value::Null,
            winner_mutation_id: String::new(),
            conflict_mode: String::new(),
        }
        .name(),
    ];
    assert_eq!(from_variants, EngineEvent::all_names());
}

#[test]
fn catalog_matches_checked_in_json() {
    let json = std::fs::read_to_string("../../packages/protocol/spec/engine-errors.json")
        .expect("catalog json");
    let checked_in: Vec<serde_json::Value> = serde_json::from_str(&json).expect("valid json");
    let generated: Vec<serde_json::Value> = CATALOG
        .iter()
        .map(|e| {
            serde_json::json!({ "code": e.code, "retryable": e.retryable, "description": e.description })
        })
        .collect();
    assert_eq!(
        generated, checked_in,
        "run `cargo run -p kizunasync-bindgen -- engine-errors` and commit the JSON"
    );
}
