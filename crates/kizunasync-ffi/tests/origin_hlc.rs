//! The origin HLC the typed `apply` attaches, and the config that decides it.
//!
//! The engine owns the rule and this crate forwards the table's declared
//! `conflict_mode` to it, so these tests drive it the way a Swift or Kotlin app
//! does, through `create`, `apply` and `applyWhere`: an `hlc` table stamps every
//! mutation, an `arrival` table stamps none, a caller's own stamp wins, and a
//! spelling outside the two is refused rather than read as `arrival`.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::error_catalog::CONFIG_INVALID;
use kizunasync_ffi::{KizunaSyncEngine, KizunaSyncFfiError};
use serde_json::{Value, json};

/// The create JSON every test in this file builds from. `build_remote`
/// refuses a config without a `remote` key under the `http` feature, so this
/// carries a placeholder that satisfies the shape check without ever
/// resolving; without the feature the extra key is inert.
fn config_json(tables: &Value) -> String {
    let mut config = json!({"client_id": "ffi-hlc", "schema_version": 1, "tables": tables});
    if cfg!(feature = "http") {
        config["remote"] = json!({"url": "https://127.0.0.1:1", "publishable_key": "pub-xxx"});
    }
    config.to_string()
}

fn engine_with(tables: &Value) -> KizunaSyncEngine {
    let engine = KizunaSyncEngine::new();
    engine.create(config_json(tables)).expect("create");
    engine
}

fn insert(engine: &KizunaSyncEngine, table: &str, pk: &str, extra: &Value) {
    let mut mutation = json!({
        "table": table,
        "pk": pk,
        "op": "insert",
        "mutation_id": format!("m-{pk}"),
        "columns": {"title": "Alpha", "user_id": "u1"},
    });
    for (key, value) in extra.as_object().expect("an object") {
        mutation[key] = value.clone();
    }
    engine.apply(mutation.to_string()).expect("apply");
}

/// The `hlc` of every queued entry, oldest first.
fn queued_hlcs(engine: &KizunaSyncEngine) -> Vec<Option<String>> {
    let raw = engine.inspect().expect("inspect");
    let snapshot: Value = serde_json::from_str(&raw).expect("inspect json");
    snapshot["queued"]
        .as_array()
        .expect("queued array")
        .iter()
        .map(|entry| entry.get("hlc").and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn bucketed(mode: Option<&str>) -> Value {
    let mut table = json!({"bucket_column": "user_id", "bucket_params": {"user_id": "u1"}});
    if let Some(mode) = mode {
        table["conflict_mode"] = json!(mode);
    }
    table
}

#[test]
fn an_hlc_table_stamps_every_mutation_and_an_arrival_table_stamps_none() {
    let engine = engine_with(&json!({
        "notes": bucketed(Some("hlc")),
        "items": bucketed(Some("arrival")),
        "logs": bucketed(None),
    }));

    insert(&engine, "notes", "n1", &json!({}));
    insert(&engine, "items", "i1", &json!({}));
    insert(&engine, "logs", "l1", &json!({}));

    let stamps = queued_hlcs(&engine);
    assert_eq!(stamps.len(), 3);
    let minted = stamps[0].as_deref().expect("the hlc table is stamped");
    assert_eq!(stamps[1], None, "an arrival table carries no stamp");
    assert_eq!(stamps[2], None, "an undeclared table is arrival");

    // "<rfc3339 ms>|<counter>|<node>": a fresh store's first stamp starts the counter at zero.
    let parts: Vec<&str> = minted.split('|').collect();
    assert_eq!(parts.len(), 3, "unexpected stamp shape {minted}");
    assert_eq!(parts[0].len(), "2024-01-01T00:00:00.000Z".len(), "{minted}");
    assert!(parts[0].ends_with('Z'), "{minted}");
    assert_eq!(parts[1], "0");
    assert_ne!(parts[2], "");
}

/// One client mints under one node, so two writes of the same session are
/// ordered against each other by their stamps rather than by two identities.
#[test]
fn two_mutations_of_one_client_share_the_node() {
    let engine = engine_with(&json!({"notes": bucketed(Some("hlc"))}));
    insert(&engine, "notes", "n1", &json!({}));
    insert(&engine, "notes", "n2", &json!({}));

    let stamps = queued_hlcs(&engine);
    let node = |stamp: &Option<String>| {
        stamp
            .as_deref()
            .and_then(|s| s.split('|').nth(2).map(str::to_string))
            .expect("a node")
    };
    assert_eq!(node(&stamps[0]), node(&stamps[1]));
}

/// The harness and the conformance runners stamp their own requests, so a
/// mutation that brought an `hlc` keeps it exactly.
#[test]
fn a_caller_supplied_stamp_wins_on_an_hlc_table() {
    let engine = engine_with(&json!({"notes": bucketed(Some("hlc"))}));
    insert(
        &engine,
        "notes",
        "n1",
        &json!({"hlc": "2024-01-01T00:00:00.000Z|7|fixed-node"}),
    );
    assert_eq!(
        queued_hlcs(&engine)[0].as_deref(),
        Some("2024-01-01T00:00:00.000Z|7|fixed-node")
    );
}

/// An arrival-mode table drops a stamp the caller sent, so its push carries no
/// `hlc` field whatever the caller put in the request.
#[test]
fn a_caller_supplied_stamp_is_dropped_on_an_arrival_table() {
    let engine = engine_with(&json!({"items": bucketed(Some("arrival"))}));
    insert(
        &engine,
        "items",
        "i1",
        &json!({"hlc": "2024-01-01T00:00:00.000Z|7|fixed-node"}),
    );
    assert_eq!(queued_hlcs(&engine)[0], None);
}

#[test]
fn a_conflict_mode_outside_the_closed_set_is_refused() {
    let engine = KizunaSyncEngine::new();
    let error = engine
        .create(config_json(&json!({
            "notes": bucketed(Some("last-write-wins")),
        })))
        .expect_err("an unknown conflict mode must fail");
    // Every refused config carries CONFIG_INVALID, so the message is what echoes
    // the rejected mode back to the caller: it is matched whole.
    let KizunaSyncFfiError::Engine { code, msg } = error;
    assert_eq!(code, CONFIG_INVALID);
    assert_eq!(
        msg,
        "config: tables.notes.conflict_mode must be \"arrival\" or \"hlc\", got \"last-write-wins\""
    );
}

#[test]
fn a_non_string_conflict_mode_is_refused() {
    let engine = KizunaSyncEngine::new();
    let mut table = bucketed(None);
    table["conflictMode"] = json!(1);
    let error = engine
        .create(config_json(&json!({"notes": table})))
        .expect_err("a non-string conflict mode must fail");
    let KizunaSyncFfiError::Engine { code, .. } = error;
    assert_eq!(code, CONFIG_INVALID);
}

/// Both spellings reach the same rule, because every other key of this config
/// takes the `snake_case` and the `camelCase` form.
#[test]
fn a_camel_case_conflict_mode_stamps_an_hlc_like_the_snake_case_one() {
    let mut table = bucketed(None);
    table["conflictMode"] = json!("hlc");
    let engine = engine_with(&json!({"notes": table}));
    insert(&engine, "notes", "n1", &json!({}));
    assert!(queued_hlcs(&engine)[0].is_some());
}

const PINNED_NOW: &str = "2021-05-05T05:05:05.000Z";
const PINNED_NOW_MS: i64 = 1_620_191_105_000;

/// An insert through the JSON call surface with the clock pinned at `now_ms`.
fn insert_at(engine: &KizunaSyncEngine, pk: &str, now: &str, now_ms: i64) {
    let raw = engine
        .call(
            "apply".into(),
            json!({
                "table": "notes",
                "pk": pk,
                "op": "insert",
                "mutation_id": format!("m-{pk}"),
                "columns": {"title": "Alpha", "user_id": "u1"},
                "now": now,
                "now_ms": now_ms,
            })
            .to_string(),
        )
        .expect("apply call");
    let envelope: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(envelope["ok"], json!(true), "{envelope}");
}

/// The node every stamp of `engine` names, read off its first queued stamp.
fn minted_node(engine: &KizunaSyncEngine) -> String {
    queued_hlcs(engine)[0]
        .as_deref()
        .and_then(|stamp| stamp.split('|').nth(2).map(str::to_string))
        .expect("a minted stamp")
}

/// Writes pinned to one instant are ordered by the counter, a clock stepped
/// back keeps the physical part where it was, and a clock that moves past it
/// starts the counter over: the same bytes on every host, because the rule
/// lives in the engine and the call surface only pins the clock it reads.
#[test]
fn stamps_pinned_to_one_instant_are_ordered_by_the_counter() {
    let engine = engine_with(&json!({"notes": bucketed(Some("hlc"))}));
    insert_at(&engine, "n1", PINNED_NOW, PINNED_NOW_MS);
    insert_at(&engine, "n2", PINNED_NOW, PINNED_NOW_MS);
    insert_at(
        &engine,
        "n3",
        "2021-05-05T05:05:04.000Z",
        PINNED_NOW_MS - 1_000,
    );
    insert_at(&engine, "n4", "2021-05-05T05:05:05.001Z", PINNED_NOW_MS + 1);

    let node = minted_node(&engine);
    assert_eq!(
        queued_hlcs(&engine),
        vec![
            Some(format!("{PINNED_NOW}|0|{node}")),
            Some(format!("{PINNED_NOW}|1|{node}")),
            Some(format!("{PINNED_NOW}|2|{node}")),
            Some(format!("2021-05-05T05:05:05.001Z|0|{node}")),
        ]
    );
}

/// The typed `applyWhere` Swift and Kotlin call stamps every row it targets on
/// an `hlc` table, as `apply` does.
#[test]
fn a_filter_targeted_update_is_stamped_on_an_hlc_table() {
    let engine = engine_with(&json!({"notes": bucketed(Some("hlc"))}));
    insert(&engine, "notes", "n1", &json!({}));
    insert(&engine, "notes", "n2", &json!({}));

    let targets = engine
        .apply_where(
            "notes".into(),
            "update".into(),
            json!([{"kind": "eq", "column": "title", "value": "Alpha"}]).to_string(),
            json!({"title": "targeted"}).to_string(),
            String::new(),
            String::new(),
            String::new(),
        )
        .expect("apply_where");

    assert_eq!(targets, vec!["n1".to_string(), "n2".to_string()]);
    let stamps = queued_hlcs(&engine);
    assert_eq!(stamps.len(), 4);
    let node = minted_node(&engine);
    for stamp in &stamps[2..] {
        let stamp = stamp.as_deref().expect("the targeted update is stamped");
        assert!(stamp.ends_with(&format!("|{node}")), "{stamp}");
    }
    assert_ne!(
        stamps[2], stamps[3],
        "two targeted rows never share a stamp"
    );
}
