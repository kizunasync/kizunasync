//! The origin HLC a local write leaves with, and the config that decides it.
//!
//! One owner for the rule: every host reaches it through `apply` and
//! `apply_where`, so a Swift, Kotlin or JavaScript app pushes the same bytes for
//! the same table. An `hlc` table stamps every mutation the caller did not stamp
//! itself, an `arrival` table carries no stamp at all, and a spelling outside
//! the two is refused rather than read as `arrival`.
//!
//! A minted stamp is `<rfc3339 ms>|<counter>|<node>` rendered from the last
//! stamp the store kept: the physical part never moves back, the counter orders
//! writes that share it, and the node is the one the device took on its first
//! stamp.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::bridge::parse_config;
use kizunasync_engine::error_catalog::CONFIG_INVALID;
use kizunasync_engine::{
    ApplyWhere, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError,
    ScriptedRemote, SyncEngine, SyncMode, TableConfig, UuidFn,
};
use kizunasync_protocol::Op;
use kizunasync_query::Filter;
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

const NOW: &str = "2024-01-01T00:00:00.000Z";
/// `NOW` in epoch milliseconds: the wall clock every engine below starts at.
const NOW_MS: i64 = 1_704_067_200_000;
const HOUR_MS: i64 = 3_600_000;
const HLC_TABLE: &str = "notes";
const ARRIVAL_TABLE: &str = "items";

/// Every mutation below pins its own id, so the origin node is the only
/// identifier the engine has to mint, and the stamp a test asserts on is spelled
/// out rather than pattern-matched.
const NODE: &str = "id-1";

/// The wall clock a test moves by hand, read through `deps.now_millis`.
#[derive(Clone)]
struct Clock(Arc<AtomicI64>);

impl Clock {
    fn at(millis: i64) -> Self {
        Self(Arc::new(AtomicI64::new(millis)))
    }

    fn set(&self, millis: i64) {
        self.0.store(millis, Ordering::Relaxed);
    }
}

fn table(conflict_mode: ConflictMode) -> TableConfig {
    TableConfig {
        bucket_column: String::new(),
        bucket_params: Map::new(),
        bucket_owner: false,
        attachments: BTreeMap::new(),
        soft_delete_column: None,
        sync_mode: SyncMode::ReadWrite,
        conflict_mode,
    }
}

/// The counting id source `NODE` names: `id-1`, `id-2`, …
fn counting_ids() -> UuidFn {
    let minted = AtomicU64::new(0);
    Box::new(move || format!("id-{}", minted.fetch_add(1, Ordering::Relaxed) + 1))
}

/// An engine over both modes on `store`, reading `clock`. `deps.now` stays at
/// `NOW` whatever the clock reads, so a stamp that follows the clock proves it
/// came from `deps.now_millis`.
fn engine_on(store: LocalStore, clock: &Clock, uuid: UuidFn) -> SyncEngine {
    let mut tables = BTreeMap::new();
    tables.insert(HLC_TABLE.into(), table(ConflictMode::Hlc));
    tables.insert(ARRIVAL_TABLE.into(), table(ConflictMode::Arrival));
    let wall = Arc::clone(&clock.0);

    SyncEngine::new(
        store,
        EngineConfig {
            tables,
            schema_version: 1,
            default_limit: None,
            attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
            client_id: "c1".into(),
        },
        Arc::new(ScriptedRemote::new()),
        EngineDeps {
            now: Box::new(|| NOW.into()),
            now_millis: Box::new(move || wall.load(Ordering::Relaxed)),
            uuid,
        },
    )
}

/// An in-memory engine with the counting id source and the clock it reads.
fn clocked_engine() -> (SyncEngine, Clock) {
    let clock = Clock::at(NOW_MS);
    let engine = engine_on(
        LocalStore::open_in_memory().expect("store"),
        &clock,
        counting_ids(),
    );
    (engine, clock)
}

fn engine() -> SyncEngine {
    clocked_engine().0
}

fn engine_with(uuid: UuidFn) -> SyncEngine {
    engine_on(
        LocalStore::open_in_memory().expect("store"),
        &Clock::at(NOW_MS),
        uuid,
    )
}

fn insert(table: &str, pk: &str, hlc: Option<&str>) -> LocalMutation {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("Alpha"));
    LocalMutation {
        table: table.into(),
        pk: pk.into(),
        op: Op::Insert,
        columns,
        transforms: None,
        precondition: None,
        batch_id: None,
        hlc: hlc.map(str::to_string),
        mutation_id: Some(format!("m-{pk}")),
    }
}

fn apply_all(engine: &SyncEngine, table: &str, pks: &[&str]) {
    for pk in pks {
        engine.apply(insert(table, pk, None)).expect("apply");
    }
}

/// A stamp this device mints: `iso` and `counter` under `NODE`.
#[expect(
    clippy::unnecessary_wraps,
    reason = "compared with the outbox's `Option` stamps, where `None` is an unstamped write"
)]
fn stamp(iso: &str, counter: u64) -> Option<String> {
    Some(format!("{iso}|{counter}|{NODE}"))
}

/// The stamp of every queued entry, oldest first.
fn queued_stamps(engine: &SyncEngine) -> Vec<Option<String>> {
    engine
        .list_outbox(16)
        .expect("outbox")
        .into_iter()
        .map(|entry| entry.hlc)
        .collect()
}

/// Every stamp sorts strictly after the one before it, in the order the server
/// compares them: physical part, then counter (the node is the same for all).
fn assert_strictly_increasing(stamps: &[Option<String>]) {
    let keys: Vec<(String, u64)> = stamps
        .iter()
        .map(|stamp| {
            let mut parts = stamp.as_deref().expect("a stamp").split('|');
            let physical = parts.next().expect("a physical part").to_string();
            let counter = parts.next().expect("a counter").parse().expect("a number");
            (physical, counter)
        })
        .collect();
    for pair in keys.windows(2) {
        assert!(
            pair[0] < pair[1],
            "{:?} does not sort before {:?}",
            pair[0],
            pair[1]
        );
    }
}

#[test]
fn apply_stamps_an_origin_hlc_for_an_hlc_table_when_the_mutation_carries_none() {
    let engine = engine();
    engine.apply(insert(HLC_TABLE, "n1", None)).expect("apply");

    assert_eq!(
        queued_stamps(&engine),
        vec![stamp(NOW, 0)],
        "a device's first stamp starts its counter at zero"
    );
}

/// One engine mints under one node, so the writes of a session are ordered
/// against each other by their stamps instead of by as many identities as there
/// were writes.
#[test]
fn apply_mints_every_stamp_of_one_engine_under_one_node() {
    let engine = engine();
    apply_all(&engine, HLC_TABLE, &["n1", "n2"]);

    let node = |stamp: &Option<String>| {
        stamp
            .as_deref()
            .and_then(|stamp| stamp.split('|').nth(2).map(str::to_string))
            .expect("a node")
    };
    let stamps = queued_stamps(&engine);
    assert_eq!(node(&stamps[0]), NODE);
    assert_eq!(node(&stamps[0]), node(&stamps[1]));
}

/// Two writes in one millisecond would otherwise share a stamp, and the server
/// would answer the later one `SUPERSEDED`: the counter orders them instead.
#[test]
fn the_counter_orders_writes_while_the_clock_stands_still() {
    let engine = engine();
    apply_all(&engine, HLC_TABLE, &["n1", "n2", "n3"]);

    assert_eq!(
        queued_stamps(&engine),
        vec![stamp(NOW, 0), stamp(NOW, 1), stamp(NOW, 2)]
    );
}

/// Once the wall clock passes the last stamp, the physical part carries the
/// order and the counter starts over (the HLC reset rule).
#[test]
fn the_counter_starts_over_when_the_clock_moves_forward() {
    let (engine, clock) = clocked_engine();
    apply_all(&engine, HLC_TABLE, &["n1", "n2"]);
    clock.set(NOW_MS + 5);
    apply_all(&engine, HLC_TABLE, &["n3", "n4"]);

    let later = "2024-01-01T00:00:00.005Z";
    let stamps = queued_stamps(&engine);
    assert_eq!(
        stamps,
        vec![
            stamp(NOW, 0),
            stamp(NOW, 1),
            stamp(later, 0),
            stamp(later, 1)
        ]
    );
    assert_strictly_increasing(&stamps);
}

/// A wall clock stepped back (a time sync, a manual change) must not order a
/// later write before an earlier one: the physical part holds at the last stamp
/// and the counter moves on until the clock catches up.
#[test]
fn a_clock_stepped_back_keeps_the_stamps_increasing() {
    let (engine, clock) = clocked_engine();
    apply_all(&engine, HLC_TABLE, &["n1"]);
    clock.set(NOW_MS - 10_000);
    apply_all(&engine, HLC_TABLE, &["n2", "n3"]);
    clock.set(NOW_MS + 1);
    apply_all(&engine, HLC_TABLE, &["n4"]);

    let stamps = queued_stamps(&engine);
    assert_eq!(
        stamps,
        vec![
            stamp(NOW, 0),
            stamp(NOW, 1),
            stamp(NOW, 2),
            stamp("2024-01-01T00:00:00.001Z", 0),
        ]
    );
    assert_strictly_increasing(&stamps);
}

/// One clock read per write: the outbox entry's `created_at` is the wall clock
/// the stamp was minted at, not the separately injected `deps.now`.
#[test]
fn the_outbox_entry_and_its_stamp_read_one_clock() {
    let (engine, clock) = clocked_engine();
    clock.set(NOW_MS + 5);
    apply_all(&engine, HLC_TABLE, &["n1"]);
    apply_all(&engine, ARRIVAL_TABLE, &["i1"]);

    let entries = engine.list_outbox(16).expect("outbox");
    let later = "2024-01-01T00:00:00.005Z";
    assert_eq!(entries[0].hlc, stamp(later, 0));
    assert_eq!(entries[0].created_at, later);
    assert_eq!(
        entries[1].created_at, later,
        "an arrival write reads the same clock"
    );
}

/// The last stamp lives in the store, so a relaunch on a clock that stepped
/// back still stamps above every write the previous session queued, under the
/// node that session took.
#[test]
fn the_last_stamp_survives_a_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    {
        let first = engine_on(
            LocalStore::open_path(&path).expect("store"),
            &Clock::at(NOW_MS),
            counting_ids(),
        );
        apply_all(&first, HLC_TABLE, &["n1", "n2"]);
    }

    let reopened = engine_on(
        LocalStore::open_path(&path).expect("reopen"),
        &Clock::at(NOW_MS - 10_000),
        Box::new(|| panic!("the reopened engine minted a second node")),
    );
    apply_all(&reopened, HLC_TABLE, &["n3"]);

    assert_eq!(
        queued_stamps(&reopened),
        vec![stamp(NOW, 0), stamp(NOW, 1), stamp(NOW, 2)]
    );
}

/// A reset starts the device over but keeps its clock: a stamp minted after it
/// still sorts after every stamp minted before it, under the same node.
#[tokio::test]
async fn reset_keeps_the_origin_clock() {
    let engine = engine();
    apply_all(&engine, HLC_TABLE, &["n1", "n2"]);
    engine.reset().await.expect("reset");
    apply_all(&engine, HLC_TABLE, &["n3"]);

    assert_eq!(queued_stamps(&engine), vec![stamp(NOW, 2)]);
}

/// A kept physical time more than an hour ahead of the wall clock is a clock
/// fault (a device that once ran in the future), not an order to keep: it is
/// discarded rather than stamping every later write under it, as the HLC paper
/// does when the drift bound is violated. The node is the device's identity and
/// stays.
#[test]
fn a_last_stamp_more_than_an_hour_ahead_is_discarded() {
    let (engine, clock) = clocked_engine();
    clock.set(NOW_MS + HOUR_MS + 1);
    apply_all(&engine, HLC_TABLE, &["n1"]);
    clock.set(NOW_MS);
    apply_all(&engine, HLC_TABLE, &["n2"]);

    assert_eq!(
        queued_stamps(&engine),
        vec![stamp("2024-01-01T01:00:00.001Z", 0), stamp(NOW, 0)]
    );
}

/// Exactly one hour ahead is inside the bound, so the physical part holds there.
#[test]
fn a_last_stamp_one_hour_ahead_is_kept() {
    let (engine, clock) = clocked_engine();
    clock.set(NOW_MS + HOUR_MS);
    apply_all(&engine, HLC_TABLE, &["n1"]);
    clock.set(NOW_MS);
    apply_all(&engine, HLC_TABLE, &["n2"]);

    let ahead = "2024-01-01T01:00:00.000Z";
    assert_eq!(
        queued_stamps(&engine),
        vec![stamp(ahead, 0), stamp(ahead, 1)]
    );
}

/// The stamp commits in the same transaction as the outbox entry, so a write
/// the store refuses takes no counter value with it.
#[test]
fn a_refused_write_leaves_the_clock_where_it_was() {
    let engine = engine();
    apply_all(&engine, HLC_TABLE, &["n1"]);
    engine
        .apply(insert(HLC_TABLE, "n1", None))
        .expect_err("an insert over an existing row is refused");
    apply_all(&engine, HLC_TABLE, &["n2"]);

    assert_eq!(queued_stamps(&engine), vec![stamp(NOW, 0), stamp(NOW, 1)]);
}

/// The harness and the conformance runners stamp their own requests, so a
/// mutation that brought an HLC keeps it exactly.
#[test]
fn apply_keeps_a_supplied_origin_hlc() {
    let supplied = "2020-05-05T05:05:05.000Z|7|fixed-node";
    let engine = engine();
    engine
        .apply(insert(HLC_TABLE, "n1", Some(supplied)))
        .expect("apply");

    assert_eq!(queued_stamps(&engine), vec![Some(supplied.into())]);
}

#[test]
fn apply_leaves_arrival_tables_unstamped() {
    let engine = engine();
    engine
        .apply(insert(ARRIVAL_TABLE, "i1", None))
        .expect("apply");
    engine
        .apply(insert(
            ARRIVAL_TABLE,
            "i2",
            Some("2020-05-05T05:05:05.000Z|7|fixed-node"),
        ))
        .expect("apply");

    assert_eq!(
        queued_stamps(&engine),
        vec![None, None],
        "an arrival table carries no stamp whatever the caller sent"
    );
}

/// The `update()` / `delete()` builder shape on every host.
fn retitle_where_title_is_alpha(table: &str) -> ApplyWhere {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("targeted"));
    ApplyWhere {
        table: table.into(),
        filters: vec![Filter::Eq {
            column: "title".into(),
            value: json!("Alpha"),
        }],
        op: Op::Update,
        columns,
        precondition: None,
        transforms: None,
        include_deleted: false,
    }
}

/// A filter-targeted write stamps every row it targets, exactly as `apply`
/// does, so an `hlc` table's `update().eq()` push carries the origin order the
/// server resolves the column by; an `arrival` table stays bare.
#[test]
fn apply_where_stamps_every_targeted_row() {
    let engine = engine();
    apply_all(&engine, HLC_TABLE, &["n1", "n2"]);
    apply_all(&engine, ARRIVAL_TABLE, &["i1"]);

    let hlc_targets = engine
        .apply_where(retitle_where_title_is_alpha(HLC_TABLE))
        .expect("apply_where on the hlc table");
    let arrival_targets = engine
        .apply_where(retitle_where_title_is_alpha(ARRIVAL_TABLE))
        .expect("apply_where on the arrival table");

    assert_eq!(hlc_targets, vec!["n1".to_string(), "n2".to_string()]);
    assert_eq!(arrival_targets, vec!["i1".to_string()]);
    assert_eq!(
        queued_stamps(&engine),
        vec![
            stamp(NOW, 0),
            stamp(NOW, 1),
            None,
            stamp(NOW, 2),
            stamp(NOW, 3),
            None,
        ]
    );
}

/// An engine whose tables all resolve by arrival never stamps, so it never asks
/// for a node: a harness that scripts every identifier a run consumes stays
/// exact.
#[test]
fn engine_mints_no_origin_node_for_arrival_only_tables() {
    let engine = engine_with(Box::new(|| panic!("the engine minted an unscripted uuid")));
    engine
        .apply(insert(ARRIVAL_TABLE, "i1", None))
        .expect("apply");

    assert_eq!(queued_stamps(&engine), vec![None]);
}

/// Reading a misspelled `hlc` as `arrival` would drop the origin order the
/// server resolves the column by, so the closed set is refused rather than
/// defaulted, and the refusal names the value the caller sent.
#[test]
fn config_rejects_an_unknown_conflict_mode() {
    let refused = parse_config(&json!({
        "client_id": "c1",
        "tables": {HLC_TABLE: {"conflict_mode": "last-write-wins"}},
    }))
    .expect_err("an unknown conflict mode must fail");

    assert!(
        matches!(refused, EngineError::Config(_)),
        "{refused} is not a config fault"
    );
    assert_eq!(refused.code(), CONFIG_INVALID);
    assert!(refused.to_string().contains("last-write-wins"), "{refused}");

    let non_string = parse_config(&json!({
        "client_id": "c1",
        "tables": {HLC_TABLE: {"conflictMode": 1}},
    }))
    .expect_err("a non-string conflict mode must fail");
    assert_eq!(non_string.code(), CONFIG_INVALID);
}

/// Both spellings reach the same rule, because every other key of this config
/// takes the `snake_case` and the `camelCase` form.
#[test]
fn config_reads_the_conflict_mode_in_either_spelling() {
    for spelling in ["conflict_mode", "conflictMode"] {
        let config = parse_config(&json!({
            "client_id": "c1",
            "tables": {HLC_TABLE: {spelling: "hlc"}, ARRIVAL_TABLE: {}},
        }))
        .expect("config");

        assert_eq!(
            config.tables[HLC_TABLE].conflict_mode,
            ConflictMode::Hlc,
            "{spelling}"
        );
        assert_eq!(
            config.tables[ARRIVAL_TABLE].conflict_mode,
            ConflictMode::Arrival,
            "a table that declares no mode resolves by arrival"
        );
    }
}
