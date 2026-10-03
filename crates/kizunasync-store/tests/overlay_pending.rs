//! The one overlay of queued writes onto rows a reconcile or a pull replaced
//! (D-outbox-rebase): FIFO, only onto the rows the caller reset, a queued
//! delete always replayed, and never a queued insert or update over a
//! tombstone.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_protocol::{ColumnValues, Op};
use kizunasync_store::{DeadLetterRecord, LocalMutation, LocalStore, StoreError};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const NOW: &str = "2020-01-01T00:00:00.000Z";

fn columns(value: Value) -> ColumnValues {
    match value {
        Value::Object(map) => map,
        other => panic!("columns must be an object, got {other}"),
    }
}

fn write(store: &LocalStore, mutation_id: &str, pk: &str, op: Op, value: Value) {
    store
        .apply(
            &LocalMutation {
                table: "todos".into(),
                pk: pk.into(),
                op,
                columns: columns(value),
                transforms: None,
                precondition: None,
                batch_id: None,
                hlc: None,
                mutation_id: None,
            },
            mutation_id,
            NOW,
            None,
        )
        .expect("apply");
}

fn reset_of(pks: &[&str]) -> BTreeSet<(String, String)> {
    pks.iter()
        .map(|pk| ("todos".to_string(), (*pk).to_string()))
        .collect()
}

fn overlay(store: &LocalStore, pks: &[&str]) {
    store
        .transaction(|| store.overlay_pending(&reset_of(pks), NOW))
        .expect("overlay");
}

fn row(store: &LocalStore, pk: &str) -> Option<ColumnValues> {
    store
        .read("todos", pk)
        .expect("read")
        .map(|row| row.columns)
}

#[test]
fn queued_writes_replay_in_order_onto_the_reset_rows_only() {
    let store = LocalStore::open_in_memory().expect("open");
    write(&store, "m1", "p1", Op::Insert, json!({ "title": "a" }));
    write(&store, "m2", "p1", Op::Update, json!({ "title": "b" }));
    write(&store, "m3", "p1", Op::Update, json!({ "note": "n" }));
    write(&store, "m4", "p2", Op::Insert, json!({ "title": "x" }));
    store
        .put_server_row("todos", "p1", &columns(json!({ "title": "server" })), "5")
        .expect("server p1");
    store
        .put_server_row("todos", "p2", &columns(json!({ "title": "server" })), "5")
        .expect("server p2");

    overlay(&store, &["p1"]);

    assert_eq!(
        row(&store, "p1"),
        Some(columns(json!({ "title": "b", "note": "n" })))
    );
    assert_eq!(
        row(&store, "p2"),
        Some(columns(json!({ "title": "server" }))),
        "a row the caller did not reset already holds its queued write"
    );
    assert_eq!(
        store.outbox_depth().expect("depth"),
        4,
        "nothing is queued twice"
    );
}

#[test]
fn a_queued_delete_replays_as_a_tombstone() {
    let store = LocalStore::open_in_memory().expect("open");
    write(&store, "m1", "p1", Op::Delete, json!({}));
    store
        .put_server_row("todos", "p1", &columns(json!({ "title": "server" })), "5")
        .expect("server p1");

    overlay(&store, &["p1"]);

    assert_eq!(row(&store, "p1"), None);
    assert!(store.has_tombstone("todos", "p1").expect("tombstone"));
}

#[test]
fn a_queued_write_never_resurrects_a_tombstoned_row() {
    let store = LocalStore::open_in_memory().expect("open");
    write(&store, "m1", "p1", Op::Insert, json!({ "title": "a" }));
    write(&store, "m2", "p1", Op::Update, json!({ "title": "b" }));
    store
        .apply_tombstone("todos", "p1", "7", NOW)
        .expect("pulled tombstone");

    overlay(&store, &["p1"]);

    assert_eq!(row(&store, "p1"), None);
    assert_eq!(
        store.outbox_depth().expect("depth"),
        2,
        "the writes stay queued"
    );
}

#[test]
fn a_failed_overlay_rolls_back_with_the_callers_transaction() {
    let store = LocalStore::open_in_memory().expect("open");
    write(&store, "m1", "p1", Op::Update, json!({ "title": "b" }));
    store
        .put_server_row("todos", "p1", &columns(json!({ "title": "server" })), "5")
        .expect("server p1");

    let outcome: Result<(), StoreError> = store.transaction(|| {
        store.overlay_pending(&reset_of(&["p1"]), NOW)?;
        Err(StoreError::Constraint(
            "the caller's later write failed".into(),
        ))
    });

    assert!(outcome.is_err());
    assert_eq!(
        row(&store, "p1"),
        Some(columns(json!({ "title": "server" })))
    );
}

#[test]
fn a_dead_letter_replays_the_writes_queued_behind_the_dropped_one() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .put_server_row(
            "todos",
            "p1",
            &columns(json!({ "title": "orig", "note": null })),
            "1",
        )
        .expect("server p1");
    write(&store, "m1", "p1", Op::Update, json!({ "title": "one" }));
    write(&store, "m2", "p1", Op::Update, json!({ "note": "two" }));
    let head = store.list_outbox(1).expect("outbox").remove(0);
    assert_eq!(head.mutation_id, "m1");

    store
        .dead_letter(
            &[DeadLetterRecord {
                entry: head,
                reason: "PERMANENT_TRANSPORT".into(),
                created_at: NOW.into(),
                at: 1_577_836_800_000,
            }],
            NOW,
        )
        .expect("dead letter");

    assert_eq!(
        row(&store, "p1"),
        Some(columns(json!({ "title": "orig", "note": "two" })))
    );
    let queued = store.list_outbox(10).expect("outbox");
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].mutation_id, "m2");
    assert_eq!(store.list_dead_letters().expect("dead letters").len(), 1);
}
