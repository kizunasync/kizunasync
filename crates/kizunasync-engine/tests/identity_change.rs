//! The store belongs to the user whose token first reached it.
//!
//! The engine reads the `sub` claim of every token the host sets, records the
//! first one as the store's owner, and soft-blocks the store with the reason
//! `identity_changed` when a token names another user: queued writes of one
//! user must never be pushed under another user's session. The block holds
//! until `reset()`, and it is never a rejection or a dead letter.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::{
    AttachmentSpec, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps,
    EngineEvent, EnqueueUpload, MapAttachmentBytes, ScriptedRemote, SyncEngine, SyncMode,
    TableConfig, rpc,
};
use kizunasync_protocol::{Op, PullResponse, PushResponse, Signal};
use kizunasync_store::{AttachmentState, LocalMutation, LocalStore};
use kizunasync_transfer::FakeTransfer;
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

const USER_A: &str = "00000000-0000-4000-8000-0000000000a1";
const USER_B: &str = "00000000-0000-4000-8000-0000000000b2";
const USER_C: &str = "00000000-0000-4000-8000-0000000000c3";

// MARK: - Tokens

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let padded = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let group =
            (u32::from(padded[0]) << 16) | (u32::from(padded[1]) << 8) | u32::from(padded[2]);
        for index in 0..=chunk.len() {
            let sextet = (group >> (18 - 6 * index)) & 63;
            out.push(char::from(ALPHABET[usize::try_from(sextet).unwrap()]));
        }
    }
    out
}

/// A compact JWS whose payload is `claims`. The signature is never checked.
fn token_with(claims: &Value) -> String {
    let header = base64url(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = base64url(&serde_json::to_vec(claims).unwrap());
    format!("{header}.{payload}.c2lnbmF0dXJl")
}

/// The access token Supabase Auth issues to `sub`.
fn token_of(sub: &str) -> String {
    token_with(&json!({
        "sub": sub,
        "role": "authenticated",
        "aud": "authenticated",
    }))
}

/// Hand the engine the session of `sub`, as the host does on sign-in and on
/// every token refresh.
fn sign_in(engine: &SyncEngine, sub: &str) {
    engine.set_remote_access_token(Some(token_of(sub)));
}

// MARK: - Engines

fn config() -> EngineConfig {
    let mut params = Map::new();
    params.insert("owner_id".into(), json!(USER_A));
    let mut tables = BTreeMap::new();
    tables.insert(
        "todos".into(),
        TableConfig {
            bucket_column: "owner_id".into(),
            bucket_params: params,
            bucket_owner: false,
            attachments: BTreeMap::new(),
            soft_delete_column: None,
            sync_mode: SyncMode::ReadWrite,
            conflict_mode: ConflictMode::Arrival,
            key: vec!["id".into()],
        },
    );
    EngineConfig {
        tables,
        schema_version: 1,
        default_limit: None,
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
        client_id: "c1".into(),
    }
}

fn engine_over(store: LocalStore, remote: &Arc<ScriptedRemote>) -> SyncEngine {
    engine_with(store, config(), remote)
}

fn engine_with(
    store: LocalStore,
    config: EngineConfig,
    remote: &Arc<ScriptedRemote>,
) -> SyncEngine {
    SyncEngine::new(
        store,
        config,
        Arc::clone(remote) as Arc<dyn kizunasync_engine::ProtocolRemote>,
        EngineDeps {
            now: Box::new(|| "2024-01-01T00:00:00.000Z".into()),
            now_millis: Box::new(|| 1_704_067_200_000),
            ..EngineDeps::default()
        },
    )
}

fn memory_engine(remote: &Arc<ScriptedRemote>) -> SyncEngine {
    engine_over(LocalStore::open_in_memory().unwrap(), remote)
}

fn file_engine(path: &Path, remote: &Arc<ScriptedRemote>) -> SyncEngine {
    engine_over(LocalStore::open_path(path).unwrap(), remote)
}

/// An engine whose `todos.photo` column carries attachments that `transfer`
/// moves, with the bytes of `photos` in its sandbox.
fn attachment_engine(
    remote: &Arc<ScriptedRemote>,
    transfer: &Arc<FakeTransfer>,
    photos: &[&str],
) -> SyncEngine {
    let mut config = config();
    config.tables.get_mut("todos").unwrap().attachments.insert(
        "photo".into(),
        AttachmentSpec {
            storage_bucket: "media".into(),
            owner_column: "owner_id".into(),
        },
    );
    let bytes = Arc::new(MapAttachmentBytes::new());
    for photo in photos {
        bytes.insert(sandbox_path(photo), b"png-bytes".to_vec());
    }
    engine_with(LocalStore::open_in_memory().unwrap(), config, remote)
        .with_transfer(transfer.clone())
        .with_attachment_bytes(bytes)
}

fn sandbox_path(photo: &str) -> String {
    format!("/sandbox/{photo}.png")
}

fn photo_reference(photo: &str) -> String {
    format!("{USER_A}/row-{photo}/{photo}.png")
}

/// Queue a row of user a whose photo is the upload `photo`.
fn queue_photo(engine: &SyncEngine, photo: &str) {
    let mut columns = Map::new();
    columns.insert("owner_id".into(), json!(USER_A));
    columns.insert("photo".into(), json!(photo_reference(photo)));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: format!("row-{photo}"),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some(format!("m-{photo}")),
        })
        .unwrap();
    engine
        .enqueue_upload(EnqueueUpload {
            reference: photo_reference(photo),
            upload_id: photo.into(),
            table: "todos".into(),
            pk: format!("row-{photo}"),
            column: "photo".into(),
            bucket: "media".into(),
            owner: USER_A.into(),
            local_path: sandbox_path(photo),
            size: 9,
            sha256: Some("deadbeef".into()),
            content_type: Some("image/png".into()),
        })
        .unwrap();
}

fn queue_write(engine: &SyncEngine, mutation_id: &str) {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("written by user a"));
    columns.insert("owner_id".into(), json!(USER_A));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: format!("row-{mutation_id}"),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some(mutation_id.into()),
        })
        .unwrap();
}

// MARK: - Observations

async fn checkpoint(engine: &SyncEngine) -> Value {
    let envelope: Value =
        serde_json::from_str(&rpc::dispatch(engine, "checkpoint", "{}").await).unwrap();
    assert_eq!(envelope["ok"], json!(true), "{envelope}");
    envelope["value"].clone()
}

/// Every `RESET_REQUIRED` the engine emits from now on, as the JSON the N-API
/// and wasm bridges hand the host.
fn record_reset_required(engine: &SyncEngine) -> Arc<Mutex<Vec<Value>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let _keep_subscribed = engine.subscribe(Arc::new(move |event: EngineEvent| {
        if event.name() == "RESET_REQUIRED" {
            sink.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(serde_json::to_value(event).unwrap());
        }
    }));
    seen
}

fn recorded(events: &Mutex<Vec<Value>>) -> Vec<Value> {
    events
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

fn transfer_was_called(transfer: &FakeTransfer) -> bool {
    !transfer.uploaded.lock().unwrap().is_empty()
        || !transfer.confirmed.lock().unwrap().is_empty()
        || !transfer.downloaded.lock().unwrap().is_empty()
        || !transfer.removed.lock().unwrap().is_empty()
}

fn attachment_state(engine: &SyncEngine, photo: &str) -> AttachmentState {
    engine
        .attachment_status(&photo_reference(photo))
        .unwrap()
        .expect("the upload is queued")
        .state
}

fn reset_required_count(engine: &SyncEngine) -> usize {
    engine
        .recent_event_names()
        .iter()
        .filter(|name| *name == "RESET_REQUIRED")
        .count()
}

fn remote_was_called(remote: &ScriptedRemote) -> bool {
    remote
        .last_pull
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .is_some()
        || remote
            .last_push
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
}

fn forget_calls(remote: &ScriptedRemote) {
    *remote
        .last_pull
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = None;
    *remote
        .last_push
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = None;
}

fn fail_meta_writes(path: &Path, key: &str) {
    Connection::open(path)
        .unwrap()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_meta_insert BEFORE INSERT ON _kizunasync_meta
             WHEN NEW.key = '{key}'
             BEGIN SELECT RAISE(ABORT, 'injected store fault'); END;
             CREATE TRIGGER fail_meta_update BEFORE UPDATE ON _kizunasync_meta
             WHEN NEW.key = '{key}'
             BEGIN SELECT RAISE(ABORT, 'injected store fault'); END;"
        ))
        .unwrap();
}

fn heal_meta_writes(path: &Path) {
    Connection::open(path)
        .unwrap()
        .execute_batch(
            "DROP TRIGGER fail_meta_insert;
             DROP TRIGGER fail_meta_update;",
        )
        .unwrap();
}

// MARK: - Identity change

#[tokio::test]
async fn a_token_of_another_user_soft_blocks_the_store_with_identity_changed() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    queue_write(&engine, "m1");

    sign_in(&engine, USER_A);
    sign_in(&engine, USER_B);

    assert!(engine.is_soft_blocked().unwrap());
    let state = checkpoint(&engine).await;
    assert_eq!(state["soft_blocked"], json!(true));
    assert_eq!(state["soft_block_reason"], json!("identity_changed"));
    assert_eq!(reset_required_count(&engine), 1);
}

#[tokio::test]
async fn a_blocked_store_sends_nothing_and_keeps_the_writes_of_the_previous_user() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    queue_write(&engine, "m1");
    sign_in(&engine, USER_A);
    sign_in(&engine, USER_B);

    engine.sync().await.unwrap();
    engine.push_once().await.unwrap();
    engine.pull_once().await.unwrap();

    assert!(!remote_was_called(&remote), "no RPC under the new session");
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
    assert!(engine.list_dead_letters().unwrap().is_empty());
    assert!(engine.list_rejections(true).unwrap().is_empty());
}

#[tokio::test]
async fn a_refreshed_token_of_the_same_user_changes_nothing() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    queue_write(&engine, "m1");

    sign_in(&engine, USER_A);
    sign_in(&engine, USER_A);
    engine.sync().await.unwrap();

    assert!(!engine.is_soft_blocked().unwrap());
    assert_eq!(checkpoint(&engine).await["soft_block_reason"], Value::Null);
    assert_eq!(engine.get_outbox_depth().unwrap(), 0);
    assert_eq!(reset_required_count(&engine), 0);
}

#[tokio::test]
async fn repeated_tokens_of_the_new_user_announce_the_change_once() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);

    sign_in(&engine, USER_A);
    sign_in(&engine, USER_B);
    sign_in(&engine, USER_B);
    engine.sync().await.unwrap();

    assert_eq!(reset_required_count(&engine), 1);
}

#[tokio::test]
async fn an_unreadable_token_records_nothing() {
    let unreadable = [
        "opaque-session-token".to_string(),
        "only.two".to_string(),
        "four.dot.separated.segments".to_string(),
        "header.not*base64url.signature".to_string(),
        token_with(&json!(["sub", USER_B])),
        token_with(&json!({ "sub": 7 })),
        token_with(&json!({ "sub": "" })),
        token_with(&json!({ "role": "anon" })),
        format!("header.{}.signature", base64url(b"not json")),
    ];
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);

    for token in &unreadable {
        engine.set_remote_access_token(Some(token.clone()));
    }
    sign_in(&engine, USER_A);

    assert!(
        !engine.is_soft_blocked().unwrap(),
        "the first readable subject is the owner"
    );
    sign_in(&engine, USER_B);
    assert!(engine.is_soft_blocked().unwrap());
}

#[tokio::test]
async fn an_unreadable_token_changes_nothing() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);

    engine.set_remote_access_token(Some("opaque-session-token".into()));
    engine.sync().await.unwrap();

    assert!(!engine.is_soft_blocked().unwrap());
    assert_eq!(reset_required_count(&engine), 0);
    sign_in(&engine, USER_B);
    assert!(
        engine.is_soft_blocked().unwrap(),
        "the owner is still user a"
    );
}

#[tokio::test]
async fn a_padded_payload_reads_like_an_unpadded_one() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    let unpadded = token_of(USER_A);
    let mut segments: Vec<String> = unpadded.split('.').map(str::to_string).collect();
    while !segments[1].len().is_multiple_of(4) {
        segments[1].push('=');
    }

    engine.set_remote_access_token(Some(segments.join(".")));
    sign_in(&engine, USER_A);

    assert!(!engine.is_soft_blocked().unwrap());
}

#[tokio::test]
async fn a_cleared_token_changes_nothing() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);

    engine.set_remote_access_token(None);

    assert!(!engine.is_soft_blocked().unwrap());
    assert_eq!(reset_required_count(&engine), 0);
    sign_in(&engine, USER_B);
    assert!(
        engine.is_soft_blocked().unwrap(),
        "signing out does not release the store to the next user"
    );
}

#[tokio::test]
async fn a_schema_block_names_reset_required_and_a_later_identity_change_names_itself() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);
    remote.enqueue_pull(PullResponse {
        cursor: "0".into(),
        has_more: false,
        rows: vec![],
        tombstones: vec![],
        signal: Some(Signal {
            signal_type: "RESET_REQUIRED".into(),
        }),
        conflicts: None,
    });
    engine.pull_once().await.unwrap();

    assert_eq!(
        checkpoint(&engine).await["soft_block_reason"],
        json!("reset_required")
    );

    sign_in(&engine, USER_B);

    assert_eq!(
        checkpoint(&engine).await["soft_block_reason"],
        json!("identity_changed")
    );
    assert_eq!(reset_required_count(&engine), 2);
}

#[tokio::test]
async fn a_push_refused_by_the_schema_gate_names_reset_required() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    queue_write(&engine, "m1");
    remote.enqueue_push(PushResponse {
        verdicts: None,
        signal: Some(Signal {
            signal_type: "RESET_REQUIRED".into(),
        }),
        batch: None,
    });

    engine.push_once().await.unwrap();

    let state = checkpoint(&engine).await;
    assert_eq!(state["soft_blocked"], json!(true));
    assert_eq!(state["soft_block_reason"], json!("reset_required"));
}

#[tokio::test]
async fn the_event_of_an_identity_change_names_identity_changed() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    let events = record_reset_required(&engine);

    sign_in(&engine, USER_A);
    sign_in(&engine, USER_B);

    assert_eq!(
        recorded(&events),
        vec![json!({ "type": "RESET_REQUIRED", "reason": "identity_changed" })]
    );
}

#[tokio::test]
async fn the_event_of_a_pull_refused_by_the_schema_gate_names_reset_required() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    let events = record_reset_required(&engine);
    remote.enqueue_pull(PullResponse {
        cursor: "0".into(),
        has_more: false,
        rows: vec![],
        tombstones: vec![],
        signal: Some(Signal {
            signal_type: "RESET_REQUIRED".into(),
        }),
        conflicts: None,
    });

    engine.pull_once().await.unwrap();

    assert_eq!(
        recorded(&events),
        vec![json!({ "type": "RESET_REQUIRED", "reason": "reset_required" })]
    );
}

#[tokio::test]
async fn the_event_of_a_push_refused_by_the_schema_gate_names_reset_required() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    let events = record_reset_required(&engine);
    queue_write(&engine, "m1");
    remote.enqueue_push(PushResponse {
        verdicts: None,
        signal: Some(Signal {
            signal_type: "RESET_REQUIRED".into(),
        }),
        batch: None,
    });

    engine.push_once().await.unwrap();

    assert_eq!(
        recorded(&events),
        vec![json!({ "type": "RESET_REQUIRED", "reason": "reset_required" })]
    );
}

// MARK: - Attachments

/// The queue of the previous user stays where it is: no upload, download or
/// removal runs under the new user's session, and a claim left in flight is
/// not handed back to the queue either.
#[tokio::test]
async fn a_sync_after_an_identity_change_makes_no_transfer_call() {
    let remote = Arc::new(ScriptedRemote::new());
    let transfer = Arc::new(FakeTransfer::new());
    let engine = attachment_engine(&remote, &transfer, &["queued", "claimed"]);
    queue_photo(&engine, "queued");
    queue_photo(&engine, "claimed");
    assert!(
        engine
            .claim_attachment(&photo_reference("claimed"), AttachmentState::Uploading)
            .unwrap()
    );
    sign_in(&engine, USER_A);
    sign_in(&engine, USER_B);

    engine.sync().await.unwrap();

    assert!(!transfer_was_called(&transfer));
    assert!(!remote_was_called(&remote));
    assert_eq!(attachment_state(&engine, "queued"), AttachmentState::Queued);
    assert_eq!(
        attachment_state(&engine, "claimed"),
        AttachmentState::Uploading
    );
}

#[tokio::test]
async fn a_sync_the_schema_gate_blocks_makes_no_transfer_call() {
    let remote = Arc::new(ScriptedRemote::new());
    let transfer = Arc::new(FakeTransfer::new());
    let engine = attachment_engine(&remote, &transfer, &["queued"]);
    queue_photo(&engine, "queued");
    remote.enqueue_push(PushResponse {
        verdicts: None,
        signal: Some(Signal {
            signal_type: "RESET_REQUIRED".into(),
        }),
        batch: None,
    });

    engine.sync().await.unwrap();

    assert!(engine.is_soft_blocked().unwrap());
    assert!(!transfer_was_called(&transfer));
    assert_eq!(attachment_state(&engine, "queued"), AttachmentState::Queued);
}

// MARK: - Reset

#[tokio::test]
async fn a_reset_clears_the_owner_and_the_reason() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);
    sign_in(&engine, USER_B);

    engine.reset().await.unwrap();

    let state = checkpoint(&engine).await;
    assert_eq!(state["soft_blocked"], json!(false));
    assert_eq!(state["soft_block_reason"], Value::Null);
    sign_in(&engine, USER_B);
    assert!(
        !engine.is_soft_blocked().unwrap(),
        "the reset store belongs to the next user it sees"
    );
}

#[tokio::test]
async fn after_a_reset_the_next_sync_records_the_session_it_runs_under() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);
    sign_in(&engine, USER_B);
    engine.reset().await.unwrap();

    engine.sync().await.unwrap();

    assert!(remote_was_called(&remote));
    sign_in(&engine, USER_C);
    assert!(
        engine.is_soft_blocked().unwrap(),
        "the sync after the reset recorded user b"
    );
}

#[tokio::test]
async fn signing_out_then_resetting_hands_the_store_to_the_next_user() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = memory_engine(&remote);
    sign_in(&engine, USER_A);
    engine.set_remote_access_token(None);
    engine.reset().await.unwrap();
    engine.sync().await.unwrap();

    sign_in(&engine, USER_B);

    assert!(!engine.is_soft_blocked().unwrap());
}

// MARK: - Durability

#[tokio::test]
async fn the_owner_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("identity.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = file_engine(&path, &remote);
        sign_in(&engine, USER_A);
    }

    let engine = file_engine(&path, &remote);
    sign_in(&engine, USER_B);

    let state = checkpoint(&engine).await;
    assert_eq!(state["soft_blocked"], json!(true));
    assert_eq!(state["soft_block_reason"], json!("identity_changed"));
}

#[tokio::test]
async fn the_same_user_after_a_restart_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("identity.db");
    let remote = Arc::new(ScriptedRemote::new());
    {
        let engine = file_engine(&path, &remote);
        sign_in(&engine, USER_A);
    }

    let engine = file_engine(&path, &remote);
    sign_in(&engine, USER_A);

    assert!(!engine.is_soft_blocked().unwrap());
}

#[tokio::test]
async fn a_subject_the_store_could_not_record_is_recorded_before_the_next_sync() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("identity.db");
    let remote = Arc::new(ScriptedRemote::new());
    let engine = file_engine(&path, &remote);
    fail_meta_writes(&path, "owner_subject");

    sign_in(&engine, USER_A);
    let refused = engine.sync().await;

    assert!(
        refused.is_err(),
        "a sync that cannot record its owner fails"
    );
    assert!(!remote_was_called(&remote));

    heal_meta_writes(&path);
    engine.sync().await.unwrap();
    forget_calls(&remote);
    sign_in(&engine, USER_B);

    assert!(engine.is_soft_blocked().unwrap());
    engine.sync().await.unwrap();
    assert!(!remote_was_called(&remote));
}

#[tokio::test]
async fn a_latch_the_store_could_not_write_is_written_before_the_next_sync() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("identity.db");
    let remote = Arc::new(ScriptedRemote::new());
    let engine = file_engine(&path, &remote);
    queue_write(&engine, "m1");
    sign_in(&engine, USER_A);
    fail_meta_writes(&path, "soft_blocked");

    sign_in(&engine, USER_B);

    assert!(!engine.is_soft_blocked().unwrap());
    assert!(engine.sync().await.is_err());
    assert!(!remote_was_called(&remote), "no RPC under the new session");

    heal_meta_writes(&path);
    engine.sync().await.unwrap();

    assert!(engine.is_soft_blocked().unwrap());
    assert!(!remote_was_called(&remote));
    assert_eq!(engine.get_outbox_depth().unwrap(), 1);
}
