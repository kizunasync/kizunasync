//! Where attachment bytes may live on this device. An import names its object
//! `owner/pk/upload.ext` from uuid segments only; a peer's reference registers
//! for download whatever its shape, and its bytes land under the attachment
//! root named by their SHA-256 and nothing else; the vacuum deletes local files
//! only under that root.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod attachment_fixtures;

use async_trait::async_trait;
use attachment_fixtures::{Setup, engine, page, pull, server_row, sign_in, state_of, tombstone};
use kizunasync_engine::{DEFAULT_ATTACHMENT_ATTEMPTS, EngineError, ScriptedRemote, SyncEngine};
use kizunasync_protocol::Op;
use kizunasync_store::{AttachmentEntry, AttachmentState, LocalMutation};
use kizunasync_transfer::{
    ConfirmMeta, FakeTransfer, ObjectTarget, Transfer, TransferError, UploadProgress, UploadTarget,
    sha256_hex,
};
use serde_json::{Map, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const OWNER: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const PK: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PAYLOAD: &[u8] = b"peer-bytes";

// MARK: - Imports

/// A `todos` row owned by `owner` under primary key `pk`, with no photo yet.
fn insert_row(engine: &SyncEngine, pk: &str, owner: &str) {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("works on a plane"));
    columns.insert("owner_id".into(), json!(owner));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: pk.into(),
            op: Op::Insert,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m-insert".into()),
        })
        .expect("insert the row");
}

/// An importing engine over `root`, with one picked file beside it.
fn importer(root: &Path) -> (SyncEngine, PathBuf) {
    let engine = engine(Setup {
        remote: Arc::new(ScriptedRemote::new()),
        transfer: Arc::new(FakeTransfer::new()),
        root: Some(root.join("sandbox")),
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
    });
    let picked = root.join("picked.png");
    std::fs::write(&picked, b"png-bytes").expect("write the picked file");
    (engine, picked)
}

fn import(engine: &SyncEngine, pk: &str, picked: &Path) -> Result<String, EngineError> {
    engine
        .from_file(
            "todos",
            "photo",
            pk,
            picked.to_str().expect("utf-8 path"),
            Some("image/png"),
        )
        .map(|imported| imported.reference)
}

/// Nothing of a refused import is left: no queue row, no sandbox copy, and
/// the row's column untouched.
fn assert_nothing_imported(engine: &SyncEngine, pk: &str, root: &Path) {
    assert_eq!(
        engine.pending_attachments("upload").expect("pending"),
        Vec::<kizunasync_store::AttachmentEntry>::new()
    );
    assert!(!root.join("sandbox").join("content").exists());
    let row = engine.read_row("todos", pk).expect("read").expect("row");
    assert!(row.columns.get("photo").is_none());
}

#[test]
fn an_import_refuses_an_owner_that_is_not_a_uuid() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, picked) = importer(dir.path());
    insert_row(&engine, PK, "../u1");

    let error = import(&engine, PK, &picked).expect_err("the owner is no uuid");

    assert!(matches!(error, EngineError::LocalConstraint(_)), "{error}");
    assert_nothing_imported(&engine, PK, dir.path());
}

#[test]
fn an_import_refuses_a_primary_key_that_is_not_a_uuid() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, picked) = importer(dir.path());
    insert_row(&engine, "p1/../p2", OWNER);

    let error = import(&engine, "p1/../p2", &picked).expect_err("the pk is no uuid");

    assert!(matches!(error, EngineError::LocalConstraint(_)), "{error}");
    assert_nothing_imported(&engine, "p1/../p2", dir.path());
}

#[test]
fn an_import_names_its_object_from_uuid_segments() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, picked) = importer(dir.path());
    insert_row(&engine, PK, OWNER);

    let reference = import(&engine, PK, &picked).expect("import");

    assert_eq!(
        reference,
        format!("{OWNER}/{PK}/9b2c8f1e-3d4a-4c5b-8e6f-7a8b9c0d1e2f.png")
    );
    assert_eq!(state_of(&engine, &reference), Some(AttachmentState::Queued));
}

// MARK: - Downloads

/// Writes `PAYLOAD` to the destination it is handed and reports `server_sha`
/// as the object's metadata.
struct PeerStorage {
    server_sha: Option<String>,
    downloads: Mutex<Vec<String>>,
}

impl PeerStorage {
    fn new(server_sha: Option<String>) -> Self {
        Self {
            server_sha,
            downloads: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl Transfer for PeerStorage {
    fn supports_resumable(&self) -> bool {
        false
    }

    async fn upload_single_shot(
        &self,
        _target: &UploadTarget,
        _bytes: &[u8],
    ) -> Result<(), TransferError> {
        Ok(())
    }

    async fn upload_resumable(
        &self,
        _target: &UploadTarget,
        bytes: &[u8],
        _start_offset: u64,
        _existing_tus_url: Option<&str>,
    ) -> Result<UploadProgress, TransferError> {
        Ok(UploadProgress {
            bytes_uploaded: bytes.len() as u64,
            bytes_total: bytes.len() as u64,
            tus_url: None,
        })
    }

    async fn confirm(
        &self,
        _target: &ObjectTarget,
        _meta: &ConfirmMeta,
        _table: &str,
    ) -> Result<(), TransferError> {
        Ok(())
    }

    async fn metadata(&self, _target: &ObjectTarget) -> Result<Option<String>, TransferError> {
        Ok(self.server_sha.clone())
    }

    async fn download(
        &self,
        _target: &ObjectTarget,
        to_local_path: &str,
        _sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        std::fs::write(to_local_path, PAYLOAD)
            .map_err(|error| TransferError::Failed(error.to_string()))?;
        self.downloads
            .lock()
            .expect("lock")
            .push(to_local_path.to_string());
        Ok(())
    }

    async fn remove(&self, _target: &ObjectTarget) -> Result<(), TransferError> {
        Ok(())
    }
}

/// A signed-in engine over `root` that has pulled a peer row carrying `reference`.
async fn with_peer_ref(root: &Path, storage: Arc<PeerStorage>, reference: &str) -> SyncEngine {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine(Setup {
        remote: remote.clone(),
        transfer: storage,
        root: Some(root.to_path_buf()),
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
    });
    sign_in(&engine, "u1");
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p9", "u2", reference, "1")], vec![]),
    )
    .await;
    engine
}

#[tokio::test]
async fn an_off_shape_peer_ref_registers_and_downloads_under_the_root_by_its_hash() {
    const OFF_SHAPE: &str = "../../outside/evil.png";
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("sandbox");
    let storage = Arc::new(PeerStorage::new(Some(sha256_hex(PAYLOAD))));
    let engine = with_peer_ref(&root, storage.clone(), OFF_SHAPE).await;

    assert_eq!(state_of(&engine, OFF_SHAPE), Some(AttachmentState::Queued));
    let resolved = engine
        .resolve_download(OFF_SHAPE)
        .await
        .expect("resolve")
        .expect("the bytes are local");

    let expected = root.join("downloads").join(sha256_hex(PAYLOAD));
    assert_eq!(PathBuf::from(&resolved), expected);
    assert_eq!(std::fs::read(&expected).expect("read"), PAYLOAD);
    assert!(!dir.path().join("outside").exists());
}

#[tokio::test]
async fn a_download_without_a_known_hash_fails_closed() {
    const REFERENCE: &str = "u2/p9/peer.png";
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("sandbox");
    let storage = Arc::new(PeerStorage::new(None));
    let engine = with_peer_ref(&root, storage.clone(), REFERENCE).await;

    let resolved = engine.resolve_download(REFERENCE).await.expect("resolve");

    assert!(resolved.is_none());
    assert!(storage.downloads.lock().expect("lock").is_empty());
    assert!(!root.join("downloads").exists());
    let failed = engine
        .get_attachment(REFERENCE)
        .expect("read")
        .expect("row");
    assert_eq!(failed.state, AttachmentState::Failed);
    assert!(!failed.in_flight);
    assert_eq!(
        failed.error.as_deref(),
        Some("ATTACHMENT_UNVERIFIED: u2/p9/peer.png has no known SHA-256")
    );
    assert_eq!(failed.error_code.as_deref(), Some("ATTACHMENT_UNVERIFIED"));
}

/// A hash the server reports is a file name only when it is one: anything else
/// counts as no hash at all.
#[tokio::test]
async fn a_server_hash_that_is_not_a_sha256_is_never_a_file_name() {
    const REFERENCE: &str = "u2/p9/peer.png";
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("sandbox");
    let storage = Arc::new(PeerStorage::new(Some("../../escape".into())));
    let engine = with_peer_ref(&root, storage.clone(), REFERENCE).await;

    let resolved = engine.resolve_download(REFERENCE).await.expect("resolve");

    assert!(resolved.is_none());
    assert!(storage.downloads.lock().expect("lock").is_empty());
    assert_eq!(
        engine
            .get_attachment(REFERENCE)
            .expect("read")
            .expect("row")
            .state,
        AttachmentState::Failed
    );
}

/// This device's own object keeps the hash it was uploaded with when a pull
/// brings its reference back after handing it to the vacuum, so its download
/// verifies against that hash where the server reports none.
#[tokio::test]
async fn an_own_object_a_pull_brings_back_keeps_its_upload_hash() {
    const OWN: &str = "u1/p1/own.png";
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("sandbox");
    let storage = Arc::new(PeerStorage::new(None));
    let remote = Arc::new(ScriptedRemote::new());
    let engine = engine(Setup {
        remote: remote.clone(),
        transfer: storage.clone(),
        root: Some(root.clone()),
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
    });
    sign_in(&engine, "u1");
    engine
        .put_attachment(&AttachmentEntry {
            reference: OWN.into(),
            upload_id: "own".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            sha256: Some(sha256_hex(PAYLOAD)),
            content_type: Some("image/png".into()),
            size: Some(10),
            local_path: None,
            direction: "upload".into(),
            state: AttachmentState::Synced,
            in_flight: false,
            fingerprint: None,
            progress: 10,
            attempts: 1,
            permanent: false,
            chunk_offset: 0,
            tus_url: None,
            error: None,
            created_at: attachment_fixtures::NOW.into(),
            updated_at: attachment_fixtures::NOW.into(),
            error_code: None,
        })
        .expect("the uploaded object");
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p1", "u1", OWN, "1")], vec![]),
    )
    .await;
    pull(
        &engine,
        &remote,
        page("2", vec![], vec![tombstone("p1", "2")]),
    )
    .await;
    assert_eq!(state_of(&engine, OWN), Some(AttachmentState::Orphaned));

    pull(
        &engine,
        &remote,
        page("3", vec![server_row("p2", "u1", OWN, "3")], vec![]),
    )
    .await;

    let registered = engine.get_attachment(OWN).expect("read").expect("row");
    assert_eq!(registered.state, AttachmentState::Queued);
    assert_eq!(registered.sha256, Some(sha256_hex(PAYLOAD)));
    let resolved = engine
        .resolve_download(OWN)
        .await
        .expect("resolve")
        .expect("the bytes are local");
    assert_eq!(
        PathBuf::from(&resolved),
        root.join("downloads").join(sha256_hex(PAYLOAD))
    );
}

// MARK: - Vacuum

/// An orphaned object whose row names `local_path` as its cached bytes.
fn orphan_at(engine: &SyncEngine, local_path: &Path) {
    engine
        .put_attachment(&AttachmentEntry {
            reference: "u1/p1/own.png".into(),
            upload_id: "own".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            sha256: None,
            content_type: None,
            size: Some(9),
            local_path: Some(local_path.to_string_lossy().into_owned()),
            direction: "upload".into(),
            state: AttachmentState::Synced,
            in_flight: false,
            fingerprint: None,
            progress: 0,
            attempts: 0,
            permanent: false,
            chunk_offset: 0,
            tus_url: None,
            error: None,
            created_at: attachment_fixtures::NOW.into(),
            updated_at: attachment_fixtures::NOW.into(),
            error_code: None,
        })
        .expect("put");
    engine.orphan_attachment("u1/p1/own.png").expect("orphan");
}

fn vacuuming(root: Option<PathBuf>) -> (SyncEngine, Arc<FakeTransfer>) {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine(Setup {
        remote: Arc::new(ScriptedRemote::new()),
        transfer: transfer.clone(),
        root,
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
    });
    sign_in(&engine, "u1");
    (engine, transfer)
}

#[tokio::test]
async fn the_vacuum_deletes_no_file_outside_the_attachment_root() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("sandbox");
    std::fs::create_dir_all(&root).expect("root");
    let outside = dir.path().join("outside.bin");
    std::fs::write(&outside, b"not ours").expect("write");

    for recorded in [outside.clone(), root.join("..").join("outside.bin")] {
        let (engine, transfer) = vacuuming(Some(root.clone()));
        orphan_at(&engine, &recorded);

        engine.vacuum_attachments().await.expect("vacuum");

        assert_eq!(transfer.removed.lock().expect("lock").len(), 1);
        assert_eq!(state_of(&engine, "u1/p1/own.png"), None);
        assert!(outside.exists(), "{} must survive", recorded.display());
    }
}

#[tokio::test]
async fn the_vacuum_deletes_the_cached_bytes_under_the_root() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("sandbox");
    let cached = root.join("content").join("own-bytes");
    std::fs::create_dir_all(cached.parent().expect("parent")).expect("content dir");
    std::fs::write(&cached, b"png-bytes").expect("write");
    let (engine, _) = vacuuming(Some(root));
    orphan_at(&engine, &cached);

    engine.vacuum_attachments().await.expect("vacuum");

    assert!(!cached.exists());
}

#[tokio::test]
async fn a_client_without_an_attachment_root_deletes_no_local_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cached = dir.path().join("own-bytes");
    std::fs::write(&cached, b"png-bytes").expect("write");
    let (engine, _) = vacuuming(None);
    orphan_at(&engine, &cached);

    engine.vacuum_attachments().await.expect("vacuum");

    assert_eq!(state_of(&engine, "u1/p1/own.png"), None);
    assert!(cached.exists());
}
