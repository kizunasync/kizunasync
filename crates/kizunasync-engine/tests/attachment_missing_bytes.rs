//! A claimed upload whose local bytes are absent is a permanent fault, and the
//! queue says so in the row rather than in a sentence a host has to read.
//!
//! Re-reading the same sandbox path cannot produce bytes that are not there, so
//! the failure must not look like the transport losses the queue retries. The
//! row lands `failed` with the typed message, the attempt is counted, and every
//! later pass repeats the same verdict: the Alpha policy is that the drive keeps
//! re-deriving it, because neither host has a terminal state for a permanent
//! upload fault.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::{
    AttachmentSpec, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps,
    EngineError, EnqueueUpload, MapAttachmentBytes, ScriptedRemote, SyncEngine, SyncMode,
    TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_store::{AttachmentState, LocalMutation, LocalStore};
use kizunasync_transfer::{FakeTransfer, TransferError};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::sync::Arc;

const REFERENCE: &str = "u1/p1/gone.png";
const LOCAL_PATH: &str = "/sandbox/gone.png";

/// The exact text the row carries: `EngineError`'s transfer prefix over the
/// transfer's own missing-bytes message, naming the path that has no bytes.
const EXPECTED_ERROR: &str = "transfer: local attachment bytes missing at /sandbox/gone.png";

/// The session of user `u1` (`{"sub":"u1"}`), which the drive needs before it
/// claims anything. The signature is never checked.
const SESSION: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln";

fn engine(transfer: Arc<FakeTransfer>) -> SyncEngine {
    let mut attachments = BTreeMap::new();
    attachments.insert(
        "photo".to_string(),
        AttachmentSpec {
            storage_bucket: "media".into(),
            owner_column: "owner_id".into(),
        },
    );
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("u1"));
    let mut tables = BTreeMap::new();
    tables.insert(
        "todos".into(),
        TableConfig {
            bucket_column: "owner_id".into(),
            bucket_params: params,
            bucket_owner: false,
            attachments,
            soft_delete_column: None,
            sync_mode: SyncMode::ReadWrite,
            conflict_mode: ConflictMode::Arrival,
            key: vec!["id".into()],
        },
    );
    let engine = SyncEngine::new(
        LocalStore::open_in_memory().expect("store"),
        EngineConfig {
            tables,
            schema_version: 1,
            default_limit: None,
            attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
            client_id: "c1".into(),
        },
        Arc::new(ScriptedRemote::new()),
        EngineDeps {
            now: Box::new(|| "2020-01-01T00:00:00.000Z".into()),
            ..EngineDeps::default()
        },
    )
    .with_transfer(transfer);
    engine.set_remote_access_token(Some(SESSION.into()));
    engine
}

/// The row the upload belongs to, with the column already holding the reference
/// so the drive reaches the byte read instead of releasing the claim.
fn insert_photo_row(engine: &SyncEngine) {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    columns.insert("photo".into(), json!(REFERENCE));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m1".into()),
        })
        .expect("apply photo row");
}

fn queued_upload() -> EnqueueUpload {
    EnqueueUpload {
        reference: REFERENCE.into(),
        upload_id: "gone".into(),
        table: "todos".into(),
        pk: "p1".into(),
        column: "photo".into(),
        bucket: "media".into(),
        owner: "u1".into(),
        local_path: LOCAL_PATH.into(),
        size: 9,
        sha256: None,
        content_type: None,
    }
}

#[tokio::test]
async fn a_claimed_upload_without_local_bytes_fails_with_the_typed_error() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine(transfer.clone());
    insert_photo_row(&engine);
    engine.enqueue_upload(queued_upload()).expect("enqueue");
    // An empty byte source is the evicted sandbox file: the path is recorded,
    // nothing answers for it.
    let bytes = Arc::new(MapAttachmentBytes::new());

    let completed = engine
        .drive_attachment_queue(bytes.clone(), 10)
        .await
        .expect("the drive itself reports the row, never an error");

    assert_eq!(completed, 0);
    let row = engine
        .get_attachment(REFERENCE)
        .expect("read row")
        .expect("row present");
    assert_eq!(row.state, AttachmentState::Failed);
    assert!(!row.in_flight, "a settled failure holds no claim");
    assert_eq!(row.error.as_deref(), Some(EXPECTED_ERROR));
    assert_eq!(row.error_code.as_deref(), Some("STORE"));
    assert_eq!(row.attempts, 1, "the attempt is counted");

    // Nothing left for Storage to hold: the bytes never existed to send.
    assert!(transfer.uploaded.lock().expect("lock").is_empty());
    assert!(transfer.confirmed.lock().expect("lock").is_empty());

    let again = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("second pass");

    assert_eq!(again, 0);
    let second = engine
        .get_attachment(REFERENCE)
        .expect("read row")
        .expect("row present");
    assert_eq!(second.state, AttachmentState::Failed);
    assert_eq!(second.error.as_deref(), Some(EXPECTED_ERROR));
    assert_eq!(second.attempts, 2, "each pass counts its own attempt");
}

/// The classification behind the text: a push loop that keeps queued only what
/// [`EngineError::is_budget_exempt`] allows must not resend this one forever.
#[test]
fn missing_local_bytes_counts_against_the_dead_letter_budget() {
    let error = EngineError::Transfer(TransferError::LocalBytesMissing {
        path: LOCAL_PATH.into(),
    });
    assert!(!error.is_budget_exempt());
    assert_eq!(error.to_string(), EXPECTED_ERROR);
}
