//! A failed host envelope must reach the engine as the same typed fault the
//! adapter classified, transport code included.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::EngineError;
use kizunasync_engine::remote_envelope::parse;

/// Pull the transport code out of a `Remote` error, or `None` for any
/// other variant.
fn remote_code(error: &EngineError) -> Option<String> {
    match error {
        EngineError::Remote { code, .. } => code.clone(),
        _ => None,
    }
}

fn failure(raw: &str, operation: &str) -> EngineError {
    parse::<serde_json::Value>(raw, operation).expect_err("a not-ok envelope is a failure")
}

#[test]
fn code_survives_into_the_engine_error() {
    let error = failure(
        r#"{"ok":false,"message":"no session","retryable":true,"code":"AUTH_SESSION_MISSING"}"#,
        "pull",
    );
    assert!(error.is_budget_exempt());
    assert_eq!(
        remote_code(&error),
        Some("AUTH_SESSION_MISSING".to_string())
    );
}

#[test]
fn permanent_classification_is_unchanged_by_a_code() {
    let error = failure(
        r#"{"ok":false,"message":"duplicate key","retryable":false,"code":"23505"}"#,
        "push",
    );
    assert!(!error.is_budget_exempt());
    assert_eq!(remote_code(&error), Some("23505".to_string()));
}

#[test]
fn a_codeless_envelope_carries_no_code() {
    let error = failure(r#"{"ok":false,"message":"boom","retryable":true}"#, "push");
    assert!(error.is_budget_exempt());
    assert_eq!(remote_code(&error), None);
}

#[test]
fn an_ok_envelope_without_data_is_budget_exempt() {
    let error = failure(r#"{"ok":true}"#, "pull");
    assert!(error.is_budget_exempt());
    assert!(matches!(error, EngineError::Remote { .. }), "{error}");
    assert_eq!(remote_code(&error), None);
}
