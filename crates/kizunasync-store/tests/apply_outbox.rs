//! Integration cover for the apply → outbox → clear path through the public API.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_protocol::Op;
use kizunasync_store::{
    CLIENT_ID_KEY, LocalMutation, LocalStore, ORIGIN_HLC_KEY, StoreError, op_as_str,
};
use serde_json::{Map, json};

const NOW: &str = "2020-01-01T00:00:00.000Z";

fn mutation(pk: &str, op: Op, columns: Map<String, serde_json::Value>) -> LocalMutation {
    LocalMutation {
        table: "todos".into(),
        pk: pk.into(),
        op,
        columns,
        transforms: None,
        precondition: None,
        batch_id: None,
        hlc: None,
        mutation_id: None,
    }
}

fn columns(title: &str) -> Map<String, serde_json::Value> {
    let mut c = Map::new();
    c.insert("title".into(), json!(title));
    c.insert("owner_id".into(), json!("u1"));
    c
}

#[test]
fn insert_update_delete_accumulate_outbox_depth() {
    let store = LocalStore::open_in_memory().expect("open");
    assert_eq!(store.outbox_depth().expect("depth"), 0);

    store
        .apply(
            &mutation("p1", Op::Insert, columns("first")),
            "m1",
            NOW,
            None,
        )
        .expect("insert");
    store
        .apply(
            &mutation("p2", Op::Insert, columns("second")),
            "m2",
            NOW,
            None,
        )
        .expect("insert 2");
    store
        .apply(
            &mutation("p1", Op::Update, columns("renamed")),
            "m3",
            NOW,
            None,
        )
        .expect("update");
    store
        .apply(&mutation("p2", Op::Delete, Map::new()), "m4", NOW, None)
        .expect("delete");

    assert_eq!(store.outbox_depth().expect("depth"), 4);

    // Ordered by insertion sequence, carrying op and pre-image for revert.
    let entries = store.list_outbox(10).expect("list");
    assert_eq!(
        entries.iter().map(|e| op_as_str(e.op)).collect::<Vec<_>>(),
        vec!["insert", "insert", "update", "delete"]
    );
    assert!(
        entries[0].pre_image.is_none(),
        "fresh insert has no pre-image"
    );
    assert_eq!(
        entries[2].pre_image.as_ref().and_then(|p| p.get("title")),
        Some(&json!("first")),
        "update carries the row it replaced"
    );

    // Local state reflects the last write per row.
    assert_eq!(
        store
            .read("todos", "p1")
            .expect("read")
            .expect("present")
            .columns
            .get("title"),
        Some(&json!("renamed"))
    );
    assert!(store.read("todos", "p2").expect("read").is_none());
    assert!(store.has_tombstone("todos", "p2").expect("tombstone"));

    // The limit is honoured and clearing drains only the named mutations.
    assert_eq!(store.list_outbox(2).expect("limited").len(), 2);
    store
        .clear_outbox_ids(&["m1".into(), "m2".into()])
        .expect("clear");
    assert_eq!(store.outbox_depth().expect("depth"), 2);
    store
        .clear_outbox_ids(&["m3".into(), "m4".into()])
        .expect("clear rest");
    assert_eq!(store.outbox_depth().expect("depth"), 0);
}

#[test]
fn duplicate_insert_is_rejected_without_queueing() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .apply(
            &mutation("p1", Op::Insert, columns("first")),
            "m1",
            NOW,
            None,
        )
        .expect("insert");

    let err = store
        .apply(
            &mutation("p1", Op::Insert, columns("again")),
            "m2",
            NOW,
            None,
        )
        .expect_err("duplicate insert must fail");
    assert!(matches!(err, StoreError::Constraint(_)), "{err}");

    // The failed apply rolled back: no phantom outbox entry, row unchanged.
    assert_eq!(store.outbox_depth().expect("depth"), 1);
    assert_eq!(
        store
            .read("todos", "p1")
            .expect("read")
            .expect("present")
            .columns
            .get("title"),
        Some(&json!("first"))
    );
}

/// A mutation id names one queued write: the server records one verdict per id
/// and a push clears the outbox by id, so a second write under a queued id
/// would be answered and cleared as if it were the first.
#[test]
fn a_queued_mutation_id_is_refused_without_touching_the_row() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .apply(
            &mutation("p1", Op::Insert, columns("first")),
            "m1",
            NOW,
            None,
        )
        .expect("insert");

    let err = store
        .apply(
            &mutation("p1", Op::Update, columns("renamed")),
            "m1",
            NOW,
            Some((ORIGIN_HLC_KEY, "1577836800000|0|node")),
        )
        .expect_err("a queued mutation id must not be queued twice");
    assert!(matches!(err, StoreError::Constraint(_)), "{err}");

    assert_eq!(store.outbox_depth().expect("depth"), 1);
    assert_eq!(
        store
            .read("todos", "p1")
            .expect("read")
            .expect("present")
            .columns
            .get("title"),
        Some(&json!("first"))
    );
    assert_eq!(store.meta_get(ORIGIN_HLC_KEY).expect("meta"), "");
}

/// The meta write rides the apply's transaction: it lands with the outbox
/// entry, and a refused write takes it back out with everything else.
#[test]
fn a_meta_write_commits_and_rolls_back_with_the_apply() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .apply(
            &mutation("p1", Op::Insert, columns("first")),
            "m1",
            NOW,
            Some((ORIGIN_HLC_KEY, "1577836800000|0|node")),
        )
        .expect("insert");
    assert_eq!(
        store.meta_get(ORIGIN_HLC_KEY).expect("meta"),
        "1577836800000|0|node"
    );

    store
        .apply(
            &mutation("p1", Op::Insert, columns("again")),
            "m2",
            NOW,
            Some((ORIGIN_HLC_KEY, "1577836800000|1|node")),
        )
        .expect_err("duplicate insert must fail");
    assert_eq!(
        store.meta_get(ORIGIN_HLC_KEY).expect("meta"),
        "1577836800000|0|node",
        "the refused write rolled its meta write back"
    );
    assert_eq!(store.outbox_depth().expect("depth"), 1);
}

/// A reset wipes the device's rows and bookkeeping but keeps its origin clock,
/// so a stamp minted after it still sorts after every stamp minted before it.
#[test]
fn reset_keeps_the_origin_hlc() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .apply(
            &mutation("p1", Op::Insert, columns("first")),
            "m1",
            NOW,
            Some((ORIGIN_HLC_KEY, "1577836800000|2|node")),
        )
        .expect("insert");
    store.set_cursor("42").expect("cursor");
    store.set_last_mutation_id("m1").expect("watermark");

    store.reset(1, "c2").expect("reset");

    assert_eq!(
        store.meta_get(ORIGIN_HLC_KEY).expect("meta"),
        "1577836800000|2|node"
    );
    assert_eq!(store.get_cursor().expect("cursor"), "0");
    assert_eq!(store.last_mutation_id().expect("watermark"), None);
    assert_eq!(store.outbox_depth().expect("depth"), 0);
    assert!(store.read("todos", "p1").expect("read").is_none());
}

/// A reset starts the device over as a new client: the identity its caller
/// minted replaces the kept one.
#[test]
fn reset_keeps_the_identity_its_caller_minted() {
    let store = LocalStore::open_in_memory().expect("open");
    store.meta_set(CLIENT_ID_KEY, "c1").expect("identity");

    store.reset(1, "c2").expect("reset");

    assert_eq!(store.meta_get(CLIENT_ID_KEY).expect("meta"), "c2");
}

/// A device that never minted a stamp resets without one: the kept key is
/// written back only when there was something to keep.
#[test]
fn reset_of_a_store_without_an_origin_hlc_writes_none() {
    let store = LocalStore::open_in_memory().expect("open");
    store.reset(1, "c2").expect("reset");
    assert_eq!(store.meta_get(ORIGIN_HLC_KEY).expect("meta"), "");
}
