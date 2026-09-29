//! Shared-scenario runner over the `UniFFI` `KizunaSyncEngine` object.
//!
//! Same `crates/kizunasync-scenarios/scenarios.json` oracle that the generated Swift
//! and Kotlin binding suites execute, so Rust validates the declarative data the
//! other languages are graded against.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_ffi::{KizunaSyncEngine, KizunaSyncFfiError};
use serde_json::Value;
#[cfg(not(feature = "http"))]
use serde_json::{Map, json};
use std::path::PathBuf;

/// Guards against a silent shrink of the shared oracle.
const MIN_SCENARIOS: usize = 12;

fn scenarios_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../kizunasync-scenarios/scenarios.json")
}

fn load_scenarios() -> Value {
    let path = scenarios_path();
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

#[cfg(not(feature = "http"))]
fn rows_of<'a>(ctx: &str, value: &'a Value) -> &'a Vec<Value> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{ctx}: expected a row array, got {value}"))
}

#[cfg(not(feature = "http"))]
fn row_of<'a>(ctx: &str, value: &'a Value) -> &'a Value {
    match value {
        Value::Object(_) => value,
        Value::Array(rows) => rows
            .first()
            .unwrap_or_else(|| panic!("{ctx}: expected at least one row")),
        other => panic!("{ctx}: expected a row, got {other}"),
    }
}

#[cfg(not(feature = "http"))]
fn assert_expected_failure(ctx: &str, step: &Value, error: &KizunaSyncFfiError) {
    // Typed discriminant, not free-text: the binding suites assert the same shape.
    let KizunaSyncFfiError::Engine { code, .. } = error;
    if let Some(expected) = step.get("expect_code").and_then(Value::as_str) {
        assert_eq!(code, expected, "{ctx}: expect_code");
    }
}

#[cfg(not(feature = "http"))]
fn step_create(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let mut config = json!({
        "client_id": "rust-scenario",
        "schema_version": 1,
        "tables": step.get("tables").cloned().unwrap_or_else(|| json!({})),
    });
    // `build_remote` refuses a config without a `remote` key under the `http`
    // feature, so this carries a placeholder that satisfies the shape check
    // without ever resolving; without the feature the extra key is inert.
    if cfg!(feature = "http") {
        config["remote"] = json!({"url": "https://127.0.0.1:1", "publishable_key": "pub-xxx"});
    }
    engine
        .create(config.to_string())
        .unwrap_or_else(|e| panic!("{ctx}: create failed: {e}"));
}

#[cfg(not(feature = "http"))]
fn step_apply(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let mut mutation = Map::new();
    mutation.insert("table".into(), step["table"].clone());
    mutation.insert("pk".into(), step["pk"].clone());
    mutation.insert(
        "op".into(),
        json!(
            step.get("mutation_op")
                .and_then(Value::as_str)
                .unwrap_or("insert")
        ),
    );
    mutation.insert(
        "mutation_id".into(),
        json!(
            step.get("mutation_id")
                .and_then(Value::as_str)
                .unwrap_or(ctx)
        ),
    );
    if let Some(columns) = step.get("columns") {
        mutation.insert("columns".into(), columns.clone());
    }
    if let Some(transforms) = step.get("transforms") {
        mutation.insert("transforms".into(), transforms.clone());
    }
    if let Some(precondition) = step.get("precondition") {
        mutation.insert("precondition".into(), precondition.clone());
    }

    let result = engine.apply(Value::Object(mutation).to_string());
    if step.get("expect_error").and_then(Value::as_bool) == Some(true) {
        let err = result
            .err()
            .unwrap_or_else(|| panic!("{ctx}: expected apply to fail"));
        assert_expected_failure(ctx, step, &err);
    } else {
        result.unwrap_or_else(|e| panic!("{ctx}: apply failed: {e}"));
    }
}

#[cfg(not(feature = "http"))]
fn step_query(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let mut request = Map::new();
    request.insert("table".into(), step["table"].clone());
    if let Some(plan) = step.get("plan") {
        request.insert("plan".into(), plan.clone());
    }

    let result = engine.query(Value::Object(request).to_string());
    if step.get("expect_error").and_then(Value::as_bool) == Some(true) {
        let err = result
            .err()
            .unwrap_or_else(|| panic!("{ctx}: expected query to fail"));
        assert_expected_failure(ctx, step, &err);
        return;
    }

    let raw = result.unwrap_or_else(|e| panic!("{ctx}: query failed: {e}"));
    let value: Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{ctx}: query json: {e}"));

    if let Some(expected) = step.get("expect_count").and_then(Value::as_u64) {
        let rows = rows_of(ctx, &value);
        assert_eq!(rows.len() as u64, expected, "{ctx}: expect_count");
    }
    if step.get("expect_null").and_then(Value::as_bool) == Some(true) {
        assert!(value.is_null(), "{ctx}: expect_null, got {value}");
    }
    if let Some(expected) = step.get("expect_single_title").and_then(Value::as_str) {
        let row = row_of(ctx, &value);
        assert_eq!(
            row.get("title").and_then(Value::as_str),
            Some(expected),
            "{ctx}: expect_single_title"
        );
    }
    if let Some(expected) = step.get("expect_column_values") {
        let column = expected["column"]
            .as_str()
            .unwrap_or_else(|| panic!("{ctx}: expect_column_values.column"));
        let wanted = rows_of(ctx, &expected["values"]);
        let actual: Vec<Value> = rows_of(ctx, &value)
            .iter()
            .map(|row| row.get(column).cloned().unwrap_or(Value::Null))
            .collect();
        assert_eq!(&actual, wanted, "{ctx}: expect_column_values[{column}]");
    }
}

#[cfg(not(feature = "http"))]
fn step_outbox_depth(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let expected = step["expect_depth"]
        .as_u64()
        .unwrap_or_else(|| panic!("{ctx}: expect_depth required"));
    let depth = engine
        .outbox_depth()
        .unwrap_or_else(|e| panic!("{ctx}: outbox_depth failed: {e}"));
    assert_eq!(u64::from(depth), expected, "{ctx}: outbox depth");
}

/// One JSON-RPC call, unwrapped against the step's own expectation.
///
/// A step that declares `expect_error` asserts the refusal and its `expect_code`
/// and answers `None`; anything else that fails is the engine breaking its own
/// contract and panics. Every method reaches the same path, so a refusal is
/// assertable on `apply_where` and `set_bucket` too, not only on the two calls
/// the typed surface exposes.
#[cfg(not(feature = "http"))]
fn invoke(
    engine: &KizunaSyncEngine,
    ctx: &str,
    step: &Value,
    method: &str,
    params: &Value,
) -> Option<Value> {
    let raw = engine
        .call(method.into(), params.to_string())
        .unwrap_or_else(|e| panic!("{ctx}: {method} failed: {e}"));
    let env: Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{ctx}: {method} json: {e}"));
    let ok = env.get("ok").and_then(Value::as_bool) == Some(true);
    if step.get("expect_error").and_then(Value::as_bool) == Some(true) {
        assert!(!ok, "{ctx}: {method} was expected to be refused, got {env}");
        if let Some(expected) = step.get("expect_code").and_then(Value::as_str) {
            assert_eq!(
                env["error"]["code"].as_str(),
                Some(expected),
                "{ctx}: expect_code"
            );
        }
        return None;
    }
    assert!(
        ok,
        "{ctx}: {method} error {}",
        env.get("error").unwrap_or(&Value::Null)
    );
    Some(env.get("value").cloned().unwrap_or(Value::Null))
}

/// A call the runner makes for its own bookkeeping rather than for the step, so
/// no expectation of the step applies to it and a failure is fatal.
#[cfg(not(feature = "http"))]
fn call_ok(engine: &KizunaSyncEngine, ctx: &str, method: &str, params: &Value) -> Value {
    invoke(engine, ctx, &json!({}), method, params)
        .unwrap_or_else(|| panic!("{ctx}: {method} answered nothing"))
}

#[cfg(not(feature = "http"))]
fn cursor_of(value: &Value) -> Option<&str> {
    match value {
        Value::String(cursor) => Some(cursor.as_str()),
        Value::Object(obj) => obj.get("cursor").and_then(Value::as_str),
        _ => None,
    }
}

#[cfg(not(feature = "http"))]
fn step_apply_where(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let mut params = Map::new();
    params.insert("table".into(), step["table"].clone());
    params.insert(
        "op".into(),
        json!(
            step.get("mutation_op")
                .and_then(Value::as_str)
                .unwrap_or("update")
        ),
    );
    if let Some(filters) = step.get("filters") {
        params.insert("filters".into(), filters.clone());
    }
    if let Some(columns) = step.get("columns") {
        params.insert("columns".into(), columns.clone());
    }
    if let Some(transforms) = step.get("transforms") {
        params.insert("transforms".into(), transforms.clone());
    }
    let _ = invoke(engine, ctx, step, "apply_where", &Value::Object(params));
}

#[cfg(not(feature = "http"))]
fn step_rejections(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let include = step
        .get("include_dismissed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(value) = invoke(
        engine,
        ctx,
        step,
        "rejections",
        &json!({ "include_dismissed": include }),
    ) else {
        return;
    };
    if let Some(expected) = step.get("expect_count").and_then(Value::as_u64) {
        let rows = value
            .as_array()
            .unwrap_or_else(|| panic!("{ctx}: rejections expected array, got {value}"));
        assert_eq!(rows.len() as u64, expected, "{ctx}: rejections count");
    }
}

#[cfg(not(feature = "http"))]
fn step_checkpoint(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let Some(value) = invoke(engine, ctx, step, "checkpoint", &json!({})) else {
        return;
    };
    if let Some(expected) = step.get("expect_cursor").and_then(Value::as_str) {
        let actual = cursor_of(&value).unwrap_or_else(|| panic!("{ctx}: checkpoint cursor"));
        assert_eq!(actual, expected, "{ctx}: expect_cursor");
    }
}

#[cfg(not(feature = "http"))]
fn step_seed_checkpoint(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let cursor = step
        .get("cursor")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{ctx}: cursor required"));
    let _ = invoke(
        engine,
        ctx,
        step,
        "seed_checkpoint",
        &json!({ "cursor": cursor }),
    );
}

#[cfg(not(feature = "http"))]
fn step_set_bucket(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let params = step.get("params").cloned().unwrap_or_else(|| json!({}));
    let _ = invoke(
        engine,
        ctx,
        step,
        "set_bucket",
        &json!({ "params": params }),
    );
}

// MARK: - Attachment steps
//
// This harness attaches no transfer port, so a scenario cannot make real bytes
// fail. What it CAN pin is the durable bookkeeping every host queue produces,
// which is exactly what the transfer budget reads: a row, a claim, an attempt,
// and the state each of them leaves behind.

#[cfg(not(feature = "http"))]
fn reference_of<'a>(ctx: &str, step: &'a Value) -> &'a str {
    step.get("reference")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{ctx}: reference required"))
}

/// Compare the answered value against whatever the step named: `expect_value`
/// is the whole value, `expect_status` a subset of its keys (the rest of a
/// status, a progress or an error string, is the engine's to choose), and
/// `expect_null` the absence of a row.
#[cfg(not(feature = "http"))]
fn assert_answer(ctx: &str, step: &Value, value: &Value) {
    if let Some(expected) = step.get("expect_value") {
        assert_eq!(value, expected, "{ctx}: expect_value");
    }
    if step.get("expect_null").and_then(Value::as_bool) == Some(true) {
        assert!(value.is_null(), "{ctx}: expect_null, got {value}");
    }
    if let Some(expected) = step.get("expect_status").and_then(Value::as_object) {
        for (key, wanted) in expected {
            assert_eq!(
                value.get(key),
                Some(wanted),
                "{ctx}: expect_status[{key}] in {value}"
            );
        }
    }
}

/// Enqueue one durable queue row from the step's `attachment` object, which is
/// the `attachment_put` request verbatim.
#[cfg(not(feature = "http"))]
fn step_attachment_put(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let row = step
        .get("attachment")
        .unwrap_or_else(|| panic!("{ctx}: attachment required"));
    let _ = invoke(engine, ctx, step, "attachment_put", row);
}

/// Write the mutable columns of one queue row, which is how a host queue
/// records what its own transfer did.
#[cfg(not(feature = "http"))]
fn step_attachment_patch(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let params = json!({
        "reference": reference_of(ctx, step),
        "patch": step.get("patch").cloned().unwrap_or_else(|| json!({})),
    });
    let _ = invoke(engine, ctx, step, "attachment_patch", &params);
}

/// Every method that takes one reference and answers one value.
#[cfg(not(feature = "http"))]
fn step_attachment_reference(engine: &KizunaSyncEngine, ctx: &str, step: &Value, method: &str) {
    let params = json!({ "reference": reference_of(ctx, step) });
    let Some(value) = invoke(engine, ctx, step, method, &params) else {
        return;
    };
    assert_answer(ctx, step, &value);
}

/// The candidates one direction would drive next.
#[cfg(not(feature = "http"))]
fn step_attachment_pending(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let direction = step
        .get("direction")
        .and_then(Value::as_str)
        .unwrap_or("upload");
    let params = json!({ "direction": direction });
    let Some(value) = invoke(engine, ctx, step, "attachment_pending", &params) else {
        return;
    };
    if let Some(expected) = step.get("expect_count").and_then(Value::as_u64) {
        let rows = rows_of(ctx, &value);
        assert_eq!(rows.len() as u64, expected, "{ctx}: expect_count");
    }
}

/// One failed transfer attempt, recorded the way a host queue records one: claim
/// the row, then write the attempt and the failure back. The step's
/// `expect_value` is the claim's own answer, so a scenario pins the attempt at
/// which the transfer budget stops claiming.
#[cfg(not(feature = "http"))]
fn step_attachment_fail_next(engine: &KizunaSyncEngine, ctx: &str, step: &Value) {
    let reference = reference_of(ctx, step);
    let params = json!({ "reference": reference });
    let entry = call_ok(engine, ctx, "attachment_get", &params);
    assert!(
        !entry.is_null(),
        "{ctx}: no attachment row carries {reference}"
    );
    let running = if entry["direction"].as_str() == Some("download") {
        "downloading"
    } else {
        "uploading"
    };
    let claimed = call_ok(
        engine,
        ctx,
        "attachment_claim",
        &json!({ "reference": reference, "state": running }),
    );
    if claimed.as_bool() == Some(true) {
        let attempts = entry["attempts"].as_i64().unwrap_or_default() + 1;
        let patch = json!({
            "state": "failed",
            "in_flight": false,
            "attempts": attempts,
            "error": "the scenario's transfer failed",
        });
        let _ = call_ok(
            engine,
            ctx,
            "attachment_patch",
            &json!({ "reference": reference, "patch": patch }),
        );
    }
    assert_answer(ctx, step, &claimed);
}

#[cfg(not(feature = "http"))]
fn run_scenario(scenario: &Value) {
    let id = scenario["id"].as_str().unwrap_or("<unnamed>");
    let steps = scenario["steps"]
        .as_array()
        .unwrap_or_else(|| panic!("{id}: steps must be an array"));
    let engine = KizunaSyncEngine::new();

    for (index, step) in steps.iter().enumerate() {
        let ctx = format!("{id}#{index}");
        match step["op"].as_str().unwrap_or_default() {
            "create" => step_create(&engine, &ctx, step),
            "apply" => step_apply(&engine, &ctx, step),
            "apply_where" => step_apply_where(&engine, &ctx, step),
            "query" => step_query(&engine, &ctx, step),
            "outbox_depth" => step_outbox_depth(&engine, &ctx, step),
            "rejections" => step_rejections(&engine, &ctx, step),
            "checkpoint" => step_checkpoint(&engine, &ctx, step),
            "seed_checkpoint" => step_seed_checkpoint(&engine, &ctx, step),
            "set_bucket" => step_set_bucket(&engine, &ctx, step),
            "attachment_put" => step_attachment_put(&engine, &ctx, step),
            "attachment_patch" => step_attachment_patch(&engine, &ctx, step),
            "attachment_pending" => step_attachment_pending(&engine, &ctx, step),
            "attachment_fail_next" => step_attachment_fail_next(&engine, &ctx, step),
            method @ ("attachment_status" | "attachment_retry" | "attachment_cancel"
            | "attachment_remove") => step_attachment_reference(&engine, &ctx, step, method),
            "sync" => engine
                .sync()
                .unwrap_or_else(|e| panic!("{ctx}: sync failed: {e}")),
            other => panic!("{ctx}: unknown scenario op {other:?}"),
        }
    }
}

#[test]
fn scenario_file_is_structurally_valid() {
    let file = load_scenarios();
    assert_eq!(file["version"].as_u64(), Some(1));
    let scenarios = file["scenarios"].as_array().expect("scenarios array");
    assert!(
        scenarios.len() >= MIN_SCENARIOS,
        "shared oracle shrank to {} scenarios (minimum {MIN_SCENARIOS})",
        scenarios.len()
    );

    let mut seen: Vec<&str> = Vec::new();
    for scenario in scenarios {
        let id = scenario["id"].as_str().expect("scenario id");
        assert!(!id.is_empty(), "empty scenario id");
        assert!(!seen.contains(&id), "duplicate scenario id {id}");
        seen.push(id);
        assert!(
            scenario["description"]
                .as_str()
                .is_some_and(|d| !d.is_empty()),
            "{id}: description required"
        );
        assert!(
            !scenario["steps"].as_array().expect("steps").is_empty(),
            "{id}: at least one step required"
        );
    }
}

// Needs the scripted remote: one scenario in the shared oracle carries a
// `sync` step, and the HTTP remote cannot sync offline.
#[test]
#[cfg(not(feature = "http"))]
fn every_shared_scenario_replays_on_the_uniffi_engine() {
    let file = load_scenarios();
    let scenarios = file["scenarios"].as_array().expect("scenarios array");
    for scenario in scenarios {
        run_scenario(scenario);
    }
    assert!(
        scenarios.len() >= MIN_SCENARIOS,
        "replayed {} scenarios, fewer than the {MIN_SCENARIOS} the oracle carries",
        scenarios.len()
    );
}

#[test]
fn create_with_invalid_json_returns_typed_error() {
    let engine = KizunaSyncEngine::new();
    let err = engine
        .create("{not json".into())
        .expect_err("invalid config JSON must fail");
    assert!(matches!(err, KizunaSyncFfiError::Engine { .. }));
}

#[test]
fn apply_before_create_returns_typed_error() {
    let engine = KizunaSyncEngine::new();
    let err = engine
        .apply(r#"{"table":"items","pk":"p1","op":"insert"}"#.into())
        .expect_err("apply without create must fail");
    assert!(matches!(err, KizunaSyncFfiError::Engine { .. }));
}
