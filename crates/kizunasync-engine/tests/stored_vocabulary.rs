//! A stored row outside one of the closed vocabularies is local corruption, and
//! the engine fails loud on it rather than reading a value it cannot represent.
//! Only the outbox `op` carries its own code, because shipping a queued write
//! the row no longer describes would send the server something the app never
//! made; a corrupt rejection kind or attachment state is an ordinary `STORE`
//! fault. Neither counts against the dead-letter budget.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::error_catalog;
use kizunasync_engine::{
    DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, ScriptedRemote, SyncEngine,
};
use kizunasync_store::{AttachmentEntry, AttachmentState, LocalStore};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

const NOW: &str = "2024-01-01T00:00:00.000Z";
const REFERENCE: &str = "u1/p1/photo.png";

/// A file-backed engine: the corruption is written from a second connection to
/// the same database.
fn engine_at(path: &Path) -> SyncEngine {
    let store = LocalStore::open_path(path).expect("store");
    SyncEngine::new(
        store,
        EngineConfig {
            tables: BTreeMap::new(),
            schema_version: 1,
            default_limit: None,
            attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
            client_id: "c1".into(),
        },
        Arc::new(ScriptedRemote::new()),
        EngineDeps::default(),
    )
}

#[test]
fn a_corrupted_rejection_kind_fails_the_journal_read_with_store() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let engine = engine_at(&path);

    let conn = Connection::open(&path).expect("open raw");
    conn.execute(
        "INSERT INTO _kizunasync_rejections(
            mutation_id, table_name, pk, kind, reason, changed_columns, server_row, at, dismissed
         ) VALUES ('m1', 'todos', 'p1', 'PRECONDITION', 'RLS_DENIED', '[]', NULL, 0, 0)",
        [],
    )
    .expect("corrupt kind");

    let err = engine
        .list_rejections(true)
        .expect_err("journal read must fail loud");
    assert_eq!(err.code(), error_catalog::STORE);
    assert!(err.is_budget_exempt());
}

#[test]
fn a_corrupted_attachment_state_fails_the_queue_read_with_store() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kizunasync.db");
    let engine = engine_at(&path);

    engine
        .put_attachment(&AttachmentEntry {
            reference: REFERENCE.into(),
            upload_id: "photo".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            sha256: None,
            content_type: None,
            size: None,
            local_path: None,
            direction: "upload".into(),
            state: AttachmentState::Queued,
            in_flight: false,
            fingerprint: None,
            progress: 0,
            attempts: 0,
            permanent: false,
            chunk_offset: 0,
            tus_url: None,
            error: None,
            created_at: NOW.into(),
            updated_at: NOW.into(),
            error_code: None,
        })
        .expect("put");

    let conn = Connection::open(&path).expect("open raw");
    let corrupted = conn
        .execute("UPDATE _kizunasync_attachments SET state = 'uploaded'", [])
        .expect("corrupt state");
    assert_eq!(corrupted, 1);

    let err = engine
        .get_attachment(REFERENCE)
        .expect_err("queue read must fail loud");
    assert_eq!(err.code(), error_catalog::STORE);
    assert!(err.is_budget_exempt());
}
