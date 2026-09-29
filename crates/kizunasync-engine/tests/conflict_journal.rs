//! What a pull page's conflicts leave behind in the local journal.
//!
//! An D-conflict-journal-visibility conflict names the column a peer took, the write that won it, and
//! the sequence that write landed on. The sequence is what lines the overwrite
//! up against the row the same page delivered, so it has to survive the commit
//! rather than being dropped on the way into `_kizunasync_overwrites`.
//!
//! A conflict this device's own pushed write won is not an overwrite by a peer,
//! so it is neither journalled nor announced.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineEvent, EventHandler,
    ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::{Conflict, Op, PullResponse, PushResponse, RowChange, Verdict};
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};

const TABLE: &str = "todos";
const PK: &str = "00000000-0000-4000-8000-000000000001";
const WINNER_SEQ: &str = "7";
const PEER_WINNER: &str = "00000000-0000-4000-8000-00000000000a";
const OWN_WINNER: &str = "00000000-0000-4000-8000-00000000000b";

fn engine(remote: Arc<ScriptedRemote>) -> SyncEngine {
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("user-a"));
    let mut tables = BTreeMap::new();
    tables.insert(
        TABLE.into(),
        TableConfig {
            bucket_column: "owner_id".into(),
            bucket_params: params,
            bucket_owner: false,
            attachments: BTreeMap::new(),
            soft_delete_column: None,
            sync_mode: SyncMode::ReadWrite,
            conflict_mode: ConflictMode::Arrival,
        },
    );
    SyncEngine::new(
        LocalStore::open_in_memory().expect("store"),
        EngineConfig {
            tables,
            schema_version: 1,
            default_limit: None,
            attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
            client_id: "c1".into(),
        },
        remote,
        EngineDeps {
            now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
            now_millis: Box::new(|| 1_700_000_000_000),
            ..EngineDeps::default()
        },
    )
}

/// One page carrying the winning row and the conflict that names it, which is
/// the shape the pack's own join produces: the conflict's sequence is always one
/// of the sequences the same page delivers.
fn page_with_a_conflict() -> PullResponse {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("theirs"));
    columns.insert("owner_id".into(), json!("user-a"));
    PullResponse {
        cursor: WINNER_SEQ.into(),
        has_more: false,
        rows: vec![RowChange {
            table: TABLE.into(),
            pk: PK.into(),
            seq: WINNER_SEQ.into(),
            columns,
            deleted: false,
        }],
        tombstones: vec![],
        signal: None,
        conflicts: Some(vec![Conflict {
            table: TABLE.into(),
            pk: PK.into(),
            column_name: "title".into(),
            loser_value: json!("mine"),
            winner_mutation_id: PEER_WINNER.into(),
            conflict_mode: "arrival".into(),
            winner_seq: WINNER_SEQ.into(),
        }]),
    }
}

#[tokio::test]
async fn a_pull_page_records_the_winning_sequence_with_the_overwrite() {
    let remote = Arc::new(ScriptedRemote::new());
    remote.enqueue_pull(page_with_a_conflict());
    let engine = engine(Arc::clone(&remote));

    engine.pull_once().await.expect("pull");

    let journalled = engine.list_overwrites(false).expect("overwrites");
    assert_eq!(journalled.len(), 1);
    let overwrite = &journalled[0];
    assert_eq!(overwrite.table, TABLE);
    assert_eq!(overwrite.pk, PK);
    assert_eq!(overwrite.column, "title");
    assert_eq!(overwrite.loser_value, json!("mine"));
    assert_eq!(overwrite.conflict_mode, "arrival");
    assert_eq!(
        overwrite.winner_seq.as_deref(),
        Some(WINNER_SEQ),
        "the sequence the page delivered the winner on must survive the commit"
    );
}

/// The sequence is the row's, not a second opinion: an app joins the overwrite
/// to the row the same checkpoint committed, so the two must read the same.
#[tokio::test]
async fn the_recorded_sequence_is_the_one_the_page_delivered_the_row_at() {
    let remote = Arc::new(ScriptedRemote::new());
    let page = page_with_a_conflict();
    let delivered = page.rows[0].seq.clone();
    remote.enqueue_pull(page);
    let engine = engine(Arc::clone(&remote));

    engine.pull_once().await.expect("pull");

    let journalled = engine.list_overwrites(false).expect("overwrites");
    assert_eq!(
        journalled[0].winner_seq.as_deref(),
        Some(delivered.as_str())
    );
}

/// The conflict page, with one conflict on the title per write in `winners`.
fn page_with_conflicts_won_by(winners: &[&str]) -> PullResponse {
    let mut page = page_with_a_conflict();
    let template = page.conflicts.take().expect("conflicts")[0].clone();
    page.conflicts = Some(
        winners
            .iter()
            .map(|winner| Conflict {
                winner_mutation_id: (*winner).into(),
                ..template.clone()
            })
            .collect(),
    );
    page
}

/// Queue a title update under `mutation_id` and push it.
async fn push_title(engine: &SyncEngine, mutation_id: &str) {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("mine"));
    columns.insert("owner_id".into(), json!("user-a"));
    engine
        .apply(LocalMutation {
            table: TABLE.into(),
            pk: PK.into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some(mutation_id.into()),
        })
        .expect("apply");
    engine.push_once().await.expect("push");
}

/// A handler that records every `COLUMN_OVERWRITTEN` winner into `seen`, in
/// emission order.
fn record_winners(seen: &Arc<Mutex<Vec<String>>>) -> EventHandler {
    let seen = Arc::clone(seen);
    Arc::new(move |event: EngineEvent| {
        if let EngineEvent::ColumnOverwritten {
            winner_mutation_id, ..
        } = event
        {
            seen.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(winner_mutation_id);
        }
    })
}

fn journalled_winners(engine: &SyncEngine) -> Vec<String> {
    engine
        .list_overwrites(true)
        .expect("overwrites")
        .into_iter()
        .map(|overwrite| overwrite.winner_mutation_id)
        .collect()
}

#[tokio::test]
async fn a_conflict_this_device_won_is_neither_journalled_nor_announced() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine(Arc::clone(&remote));
    let announced = Arc::new(Mutex::new(Vec::new()));
    let _unsubscribe = engine.subscribe(record_winners(&announced));
    push_title(&engine, OWN_WINNER).await;
    remote.enqueue_pull(page_with_conflicts_won_by(&[OWN_WINNER]));

    engine.pull_once().await.expect("pull");

    assert!(journalled_winners(&engine).is_empty());
    assert!(announced.lock().expect("events").is_empty());
    assert_eq!(
        engine
            .read_row(TABLE, PK)
            .expect("read")
            .expect("row")
            .columns["title"],
        json!("theirs"),
        "the page itself still commits"
    );
}

#[tokio::test]
async fn a_peer_win_on_the_same_page_is_still_journalled_and_announced() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine(Arc::clone(&remote));
    let announced = Arc::new(Mutex::new(Vec::new()));
    let _unsubscribe = engine.subscribe(record_winners(&announced));
    push_title(&engine, OWN_WINNER).await;
    remote.enqueue_pull(page_with_conflicts_won_by(&[OWN_WINNER, PEER_WINNER]));

    engine.pull_once().await.expect("pull");

    assert_eq!(journalled_winners(&engine), vec![PEER_WINNER.to_string()]);
    assert_eq!(
        *announced.lock().expect("events"),
        vec![PEER_WINNER.to_string()]
    );
}

#[tokio::test]
async fn a_write_the_server_rejected_is_not_remembered_as_won() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine(Arc::clone(&remote));
    let announced = Arc::new(Mutex::new(Vec::new()));
    let _unsubscribe = engine.subscribe(record_winners(&announced));
    remote.enqueue_push(PushResponse {
        verdicts: Some(vec![Verdict {
            mutation_id: OWN_WINNER.into(),
            verdict: "rejected".into(),
            reason: Some("CONSTRAINT".into()),
            server_row: None,
        }]),
        signal: None,
        batch: None,
    });
    push_title(&engine, OWN_WINNER).await;
    remote.enqueue_pull(page_with_conflicts_won_by(&[OWN_WINNER]));

    engine.pull_once().await.expect("pull");

    assert_eq!(journalled_winners(&engine), vec![OWN_WINNER.to_string()]);
    assert_eq!(
        *announced.lock().expect("events"),
        vec![OWN_WINNER.to_string()]
    );
}

#[tokio::test]
async fn a_reset_forgets_the_writes_this_device_pushed() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine(Arc::clone(&remote));
    push_title(&engine, OWN_WINNER).await;

    engine.reset().await.expect("reset");
    remote.enqueue_pull(page_with_conflicts_won_by(&[OWN_WINNER]));
    engine.pull_once().await.expect("pull");

    assert_eq!(journalled_winners(&engine), vec![OWN_WINNER.to_string()]);
}
