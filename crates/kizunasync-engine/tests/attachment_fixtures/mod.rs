//! Shared fixtures for the attachment integration tests: a `todos` table whose
//! `photo` column is an attachment owned by `owner_id`, the session a host
//! hands the engine, and the pages a scripted server answers.

// Each test crate that includes this module uses a different subset of it.
#![allow(dead_code)]

use kizunasync_engine::{
    AttachmentSpec, ConflictMode, EngineConfig, EngineDeps, ScriptedRemote, SyncEngine, SyncMode,
    TableConfig,
};
use kizunasync_protocol::{PullResponse, RowChange, Signal, Tombstone};
use kizunasync_store::AttachmentState;
use kizunasync_transfer::Transfer;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

pub const NOW: &str = "2024-01-01T00:00:00.000Z";

/// What one engine under test is built from.
pub struct Setup {
    pub remote: Arc<ScriptedRemote>,
    pub transfer: Arc<dyn Transfer>,
    pub root: Option<PathBuf>,
    pub attachment_attempts: i64,
}

/// An engine over an in-memory store that pulls `todos` for owner `u1`.
pub fn engine(setup: Setup) -> SyncEngine {
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
        },
    );
    let engine = SyncEngine::new(
        kizunasync_store::LocalStore::open_in_memory().expect("store"),
        EngineConfig {
            tables,
            schema_version: 1,
            default_limit: None,
            attachment_attempts: setup.attachment_attempts,
            client_id: "c1".into(),
        },
        setup.remote,
        EngineDeps {
            now: Box::new(|| NOW.into()),
            uuid: Box::new(|| "9b2c8f1e-3d4a-4c5b-8e6f-7a8b9c0d1e2f".into()),
            ..EngineDeps::default()
        },
    )
    .with_transfer(setup.transfer);
    match setup.root {
        Some(root) => engine.with_attachment_root(root),
        None => engine,
    }
}

/// Unpadded base64url (RFC 4648 section 5).
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let group = chunk.iter().enumerate().fold(0u32, |group, (index, byte)| {
            group | (u32::from(*byte) << (16 - 8 * index))
        });
        for index in 0..=chunk.len() {
            let sextet = (group >> (18 - 6 * index)) & 63;
            out.push(char::from(
                ALPHABET[usize::try_from(sextet).expect("a sextet is below 64")],
            ));
        }
    }
    out
}

/// The access token Supabase Auth issues to `sub`. The signature is never
/// checked.
pub fn token_of(sub: &str) -> String {
    let header = base64url(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = json!({ "sub": sub, "role": "authenticated" });
    let payload = base64url(&serde_json::to_vec(&claims).expect("claims"));
    format!("{header}.{payload}.c2lnbmF0dXJl")
}

/// Hand the engine the session of `sub`, as the host does on sign-in.
pub fn sign_in(engine: &SyncEngine, sub: &str) {
    engine.set_remote_access_token(Some(token_of(sub)));
}

/// A server row of `todos` owned by `owner`, its `photo` holding `photo`.
pub fn server_row(pk: &str, owner: &str, photo: &str, seq: &str) -> RowChange {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("works on a plane"));
    columns.insert("owner_id".into(), json!(owner));
    columns.insert("photo".into(), Value::String(photo.into()));
    RowChange {
        table: "todos".into(),
        pk: pk.into(),
        seq: seq.into(),
        columns,
        deleted: false,
    }
}

/// A server tombstone for `todos`/`pk`.
pub fn tombstone(pk: &str, seq: &str) -> Tombstone {
    Tombstone {
        table: "todos".into(),
        pk: pk.into(),
        seq: seq.into(),
    }
}

/// One complete pull page ending at `cursor`.
pub fn page(cursor: &str, rows: Vec<RowChange>, tombstones: Vec<Tombstone>) -> PullResponse {
    PullResponse {
        cursor: cursor.into(),
        has_more: false,
        rows,
        tombstones,
        signal: None,
        conflicts: None,
    }
}

/// A pull answered with `signal` alone.
pub fn signal(signal_type: &str) -> PullResponse {
    PullResponse {
        cursor: "0".into(),
        has_more: false,
        rows: vec![],
        tombstones: vec![],
        signal: Some(Signal {
            signal_type: signal_type.into(),
        }),
        conflicts: None,
    }
}

/// Pull `response` through the engine.
pub async fn pull(engine: &SyncEngine, remote: &ScriptedRemote, response: PullResponse) {
    remote.enqueue_pull(response);
    engine.pull_once().await.expect("pull");
}

/// The queue state of `reference`, `None` when no row carries it.
pub fn state_of(engine: &SyncEngine, reference: &str) -> Option<AttachmentState> {
    engine
        .get_attachment(reference)
        .expect("read the queue row")
        .map(|entry| entry.state)
}
