use super::*;
use crate::{
    AttachmentSpec, ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps,
    EngineError, ScriptedRemote, SyncEngine, SyncMode, TableConfig,
};
use kizunasync_protocol::Op;
use kizunasync_store::{LocalMutation, LocalStore};
use kizunasync_transfer::{
    ConfirmMeta, FakeTransfer, ObjectTarget, Transfer, TransferError, UploadProgress, UploadTarget,
};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

/// The session Supabase Auth hands user `u1`: `{"sub":"u1"}` as its payload.
/// The signature is never checked.
const SESSION_U1: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln";

/// The session of user `u2`, a different identity than the one the fixtures
/// sign in as.
const SESSION_U2: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MiJ9.c2ln";

/// The uuid owner and primary key an import names its object from.
const IMPORT_OWNER: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const IMPORT_PK: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

fn engine_with_transfer(transfer: Arc<FakeTransfer>) -> SyncEngine {
    engine_over(LocalStore::open_in_memory().expect("store"), transfer)
}

fn engine_over(store: LocalStore, transfer: Arc<dyn Transfer>) -> SyncEngine {
    let remote = Arc::new(ScriptedRemote::new());
    let mut tables = BTreeMap::new();
    let mut params = Map::new();
    params.insert("owner_id".into(), json!("u1"));
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
    let deps = EngineDeps {
        now: Box::new(|| "2020-01-01T00:00:00.000Z".into()),
        uuid: Box::new(|| "00000000-0000-4000-8000-000000000001".into()),
        ..EngineDeps::default()
    };
    let engine = SyncEngine::new(
        store,
        EngineConfig {
            tables,
            schema_version: 1,
            default_limit: None,
            attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
            client_id: "c1".into(),
        },
        remote,
        deps,
    )
    .with_transfer(transfer);
    engine.set_remote_access_token(Some(SESSION_U1.into()));
    engine
}

/// A `todos` that DECLARES `photo` as an attachment, over a caller-chosen
/// store and sandbox root: `from_file` and the resurrection guard are both
/// live here, while the default fixture declares none and keeps every other
/// test on the cheaper path.
fn engine_with_attachment_column(
    store: LocalStore,
    transfer: Arc<FakeTransfer>,
    root: PathBuf,
) -> SyncEngine {
    let remote = Arc::new(ScriptedRemote::new());
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
    let deps = EngineDeps {
        now: Box::new(|| "2020-01-01T00:00:00.000Z".into()),
        uuid: Box::new(|| "00000000-0000-4000-8000-000000000001".into()),
        ..EngineDeps::default()
    };
    let engine = SyncEngine::new(
        store,
        EngineConfig {
            tables,
            schema_version: 1,
            default_limit: None,
            attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
            client_id: "c1".into(),
        },
        remote,
        deps,
    )
    .with_transfer(transfer)
    .with_attachment_root(root);
    engine.set_remote_access_token(Some(SESSION_U1.into()));
    engine
}

/// Reads the durable row from a SECOND connection while `confirm` runs, so
/// the crash window between the bytes landing and the confirm settling can be
/// observed without any hook in the engine.
struct ConfirmWatcher {
    db: PathBuf,
    reference: String,
    in_flight_at_confirm: std::sync::Mutex<Option<i64>>,
}

#[async_trait::async_trait]
impl Transfer for ConfirmWatcher {
    fn supports_resumable(&self) -> bool {
        false
    }

    async fn upload_single_shot(
        &self,
        _target: &UploadTarget,
        _bytes: &[u8],
    ) -> Result<(), kizunasync_transfer::TransferError> {
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
        let conn = rusqlite::Connection::open(&self.db).expect("open raw");
        let in_flight: i64 = conn
            .query_row(
                "SELECT in_flight FROM _kizunasync_attachments WHERE ref = ?1",
                [&self.reference],
                |row| row.get(0),
            )
            .expect("attachment row");
        *self.in_flight_at_confirm.lock().expect("lock") = Some(in_flight);
        Ok(())
    }

    async fn download(
        &self,
        _target: &ObjectTarget,
        _to_local_path: &str,
        _sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        Err(TransferError::Failed("the watcher never downloads".into()))
    }

    async fn remove(&self, _target: &ObjectTarget) -> Result<(), TransferError> {
        Err(TransferError::Failed("the watcher never removes".into()))
    }
}

/// Interrupts EVERY attempt at one offset, so `upload_with_policy` sees no
/// progress and hands the engine the interrupt: the mid-flight network loss
/// a real TUS session reports. [`Self::resume`] lets the inner fake finish
/// from the session URL the first drive persisted.
struct StuckAtOffset {
    inner: FakeTransfer,
    offset: u64,
    session_url: String,
    stuck: std::sync::Mutex<bool>,
}

impl StuckAtOffset {
    fn resume(&self) {
        if let Ok(mut stuck) = self.stuck.lock() {
            *stuck = false;
        }
    }
}

#[async_trait::async_trait]
impl Transfer for StuckAtOffset {
    fn supports_resumable(&self) -> bool {
        true
    }

    fn single_shot_max_bytes(&self) -> u64 {
        self.inner.max_single
    }

    async fn upload_single_shot(
        &self,
        target: &UploadTarget,
        bytes: &[u8],
    ) -> Result<(), TransferError> {
        self.inner.upload_single_shot(target, bytes).await
    }

    async fn upload_resumable(
        &self,
        target: &UploadTarget,
        bytes: &[u8],
        start_offset: u64,
        existing_tus_url: Option<&str>,
    ) -> Result<UploadProgress, TransferError> {
        if self.stuck.lock().is_ok_and(|stuck| *stuck) {
            return Err(TransferError::Interrupted {
                offset: self.offset,
                tus_url: Some(self.session_url.clone()),
            });
        }
        self.inner
            .upload_resumable(target, bytes, start_offset, existing_tus_url)
            .await
    }

    async fn confirm(
        &self,
        target: &ObjectTarget,
        meta: &ConfirmMeta,
        table: &str,
    ) -> Result<(), TransferError> {
        self.inner.confirm(target, meta, table).await
    }

    async fn download(
        &self,
        target: &ObjectTarget,
        to_local_path: &str,
        sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        self.inner.download(target, to_local_path, sha256).await
    }

    async fn remove(&self, target: &ObjectTarget) -> Result<(), TransferError> {
        self.inner.remove(target).await
    }
}

/// MATERIALIZES the bytes it is asked to download, so a resolve can observe a
/// real sandbox file ([`FakeTransfer`] only records the call).
struct DownloadingTransfer {
    payload: Vec<u8>,
    offline: bool,
    downloads: std::sync::Mutex<Vec<String>>,
    uploads: std::sync::Mutex<Vec<String>>,
}

impl DownloadingTransfer {
    fn new(payload: &[u8]) -> Self {
        Self {
            payload: payload.to_vec(),
            offline: false,
            downloads: std::sync::Mutex::new(Vec::new()),
            uploads: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Every download fails: the network loss that leaves an evicted row
    /// retryable instead of resolved.
    fn offline() -> Self {
        Self {
            offline: true,
            ..Self::new(b"unreachable")
        }
    }
}

#[async_trait::async_trait]
impl Transfer for DownloadingTransfer {
    fn supports_resumable(&self) -> bool {
        false
    }

    async fn upload_single_shot(
        &self,
        target: &UploadTarget,
        _bytes: &[u8],
    ) -> Result<(), TransferError> {
        self.uploads.lock().expect("lock").push(target.path.clone());
        Ok(())
    }

    async fn upload_resumable(
        &self,
        target: &UploadTarget,
        bytes: &[u8],
        _start_offset: u64,
        _existing_tus_url: Option<&str>,
    ) -> Result<UploadProgress, TransferError> {
        self.uploads.lock().expect("lock").push(target.path.clone());
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

    async fn download(
        &self,
        _target: &ObjectTarget,
        to_local_path: &str,
        _sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        if self.offline {
            return Err(TransferError::Failed("network down".into()));
        }
        std::fs::write(to_local_path, &self.payload)
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

/// One queue row in an arbitrary state: the durable shape a resolve reads
/// back after a restart, without replaying the drive that produced it. The
/// row keeps the SHA-256 of `payload` as this device's hash for the object.
fn attachment_row(
    reference: &str,
    direction: &str,
    state: AttachmentState,
    local_path: Option<&str>,
    payload: &[u8],
) -> AttachmentEntry {
    AttachmentEntry {
        reference: reference.into(),
        upload_id: "up1".into(),
        table: "todos".into(),
        pk: "p1".into(),
        column: "photo".into(),
        bucket: "media".into(),
        owner: "u1".into(),
        sha256: Some(kizunasync_transfer::sha256_hex(payload)),
        content_type: None,
        size: None,
        local_path: local_path.map(str::to_string),
        direction: direction.into(),
        state,
        in_flight: false,
        fingerprint: None,
        progress: 0,
        attempts: 0,
        permanent: false,
        chunk_offset: 0,
        tus_url: None,
        error: None,
        created_at: "2020-01-01T00:00:00.000Z".into(),
        updated_at: "2020-01-01T00:00:00.000Z".into(),
        error_code: None,
    }
}

/// The row `from_file` needs: `owner_id` for the reference, no attachment
/// column yet, so the resurrection guard does not fire on this write.
fn insert_owner_row(engine: &SyncEngine, op: Op, mutation_id: &str) {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some(mutation_id.into()),
        })
        .expect("apply owner row");
}

/// The row an import names its object from: a uuid primary key owned by a
/// uuid, with no attachment column yet.
fn insert_import_row(engine: &SyncEngine, op: Op, mutation_id: &str) {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!(IMPORT_OWNER));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: IMPORT_PK.into(),
            op,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some(mutation_id.into()),
        })
        .expect("apply import row");
}

/// The same row with the attachment column already carrying `reference`,
/// which is the state a drive reads when it decides whether a queued upload
/// still has a claim on the row.
fn insert_photo_row(engine: &SyncEngine, reference: &str) {
    let mut columns = Map::new();
    columns.insert("title".into(), json!("hi"));
    columns.insert("owner_id".into(), json!("u1"));
    columns.insert("photo".into(), json!(reference));
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

/// Write the ref onto the existing row: the apply an upload enqueued by
/// `from_file` was racing.
fn set_photo_ref(engine: &SyncEngine, reference: &str) {
    let mut columns = Map::new();
    columns.insert("photo".into(), json!(reference));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Update,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m2".into()),
        })
        .expect("apply ref");
}

/// One queued upload for the fixtures' single `todos` / `p1` / `photo` row
/// into the `media` bucket owned by `u1`; only the file and its declared size
/// differ between tests. `local_path` mirrors the sandbox layout the drive
/// hands to the byte source.
fn upload_of(upload_id: &str, extension: &str, size: i64) -> EnqueueUpload {
    let file = format!("{upload_id}.{extension}");
    EnqueueUpload {
        reference: format!("u1/p1/{file}"),
        upload_id: upload_id.into(),
        table: "todos".into(),
        pk: "p1".into(),
        column: "photo".into(),
        bucket: "media".into(),
        owner: "u1".into(),
        local_path: format!("/sandbox/{file}"),
        size,
        sha256: None,
        content_type: None,
    }
}

/// The 9-byte png most upload tests drive, carrying the digest and media type
/// `from_file` stamps and `confirm` reads back.
fn png_upload() -> EnqueueUpload {
    EnqueueUpload {
        sha256: Some("deadbeef".into()),
        content_type: Some("image/png".into()),
        ..upload_of("up1", "png", 9)
    }
}

/// A byte source holding the one sandbox file a drive is about to read.
fn bytes_with(local_path: &str, payload: Vec<u8>) -> Arc<MapAttachmentBytes> {
    let bytes = Arc::new(MapAttachmentBytes::new());
    bytes.insert(local_path, payload);
    bytes
}

/// A temporary directory and the sandbox root inside it, returned together so
/// the directory outlives the engine writing into it.
fn sandbox() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("sandbox");
    (dir, root)
}

#[tokio::test]
async fn queue_drive_syncs_upload() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_transfer(transfer.clone());
    insert_photo_row(&engine, "u1/p1/up1.png");

    let bytes = bytes_with("/sandbox/up1.png", b"png-bytes".to_vec());
    engine.enqueue_upload(png_upload()).expect("enqueue");

    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("drive");
    assert_eq!(n, 1);
    let status = engine
        .attachment_status("u1/p1/up1.png")
        .expect("status")
        .expect("present");
    assert_eq!(status.state, AttachmentState::Synced);
    assert_eq!(
        transfer.uploaded.lock().expect("lock").as_slice(),
        b"png-bytes"
    );
    assert_eq!(transfer.confirmed.lock().expect("lock").len(), 1);
}

/// A row that carries another reference is no server evidence: the write that
/// set it may still be queued, or rejected later. The drive releases the claim
/// and neither uploads nor orphans the object.
#[tokio::test]
async fn queue_releases_an_upload_its_row_no_longer_carries() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_transfer(transfer.clone());
    insert_photo_row(&engine, "other-ref");
    engine
        .enqueue_upload(upload_of("old", "png", 1))
        .expect("enqueue");
    let bytes = bytes_with("/sandbox/old.png", b"x".to_vec());
    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("drive");
    assert_eq!(n, 0);
    let released = engine
        .get_attachment("u1/p1/old.png")
        .expect("get")
        .expect("present");
    assert_eq!(released.state, AttachmentState::Queued);
    assert!(!released.in_flight);
    assert!(transfer.uploaded.lock().expect("lock").is_empty());
    assert!(engine.orphaned_attachments().expect("orphaned").is_empty());
}

/// The third arm of the column check: `from_file` enqueues before the
/// caller's apply writes the ref, so an absent column is a live upload the
/// drive must RELEASE, never orphan (orphaning is terminal, because the bytes
/// would never upload and the vacuum would delete them).
#[tokio::test]
async fn queue_releases_claim_when_row_column_absent() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_transfer(transfer.clone());
    insert_owner_row(&engine, Op::Insert, "m1");
    engine
        .enqueue_upload(upload_of("new", "png", 1))
        .expect("enqueue");
    let bytes = bytes_with("/sandbox/new.png", b"x".to_vec());

    let n = engine
        .drive_attachment_queue(bytes.clone(), 10)
        .await
        .expect("drive");
    assert_eq!(n, 0);
    let released = engine
        .get_attachment("u1/p1/new.png")
        .expect("get")
        .expect("present");
    assert_eq!(released.state, AttachmentState::Queued);
    assert!(!released.in_flight);

    // The apply the upload was racing lands, and the next drive uploads it.
    set_photo_ref(&engine, "u1/p1/new.png");
    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("second drive");
    assert_eq!(n, 1);
    let status = engine
        .attachment_status("u1/p1/new.png")
        .expect("status")
        .expect("present");
    assert_eq!(status.state, AttachmentState::Synced);
}

#[tokio::test]
async fn queue_releases_claim_when_row_column_empty() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_transfer(transfer);
    insert_photo_row(&engine, "");
    engine
        .enqueue_upload(upload_of("blank", "png", 1))
        .expect("enqueue");
    let bytes = bytes_with("/sandbox/blank.png", b"x".to_vec());
    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("drive");
    assert_eq!(n, 0);
    let released = engine
        .get_attachment("u1/p1/blank.png")
        .expect("get")
        .expect("present");
    assert_eq!(released.state, AttachmentState::Queued);
    assert!(!released.in_flight);
}

#[tokio::test]
async fn queue_resume_after_interrupt() {
    let mut fake = FakeTransfer::new();
    fake.max_single = 4;
    fake.interrupt_once_at(5);
    let transfer = Arc::new(fake);
    let engine = engine_with_transfer(transfer.clone());
    insert_photo_row(&engine, "u1/p1/big.bin");
    let payload = vec![9u8; 20];
    let bytes = bytes_with("/sandbox/big.bin", payload.clone());
    engine
        .enqueue_upload(EnqueueUpload {
            content_type: Some("application/octet-stream".into()),
            ..upload_of("big", "bin", 20)
        })
        .expect("enqueue");

    // FakeTransfer interrupts once at offset 5 and keeps that session offset,
    // and `upload_with_policy` retries from it, so ONE drive finishes the upload.
    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("drive");
    assert_eq!(n, 1);
    let status = engine
        .attachment_status("u1/p1/big.bin")
        .expect("status")
        .expect("present");
    assert_eq!(status.state, AttachmentState::Synced);
    assert_eq!(transfer.uploaded.lock().expect("lock").len(), 20);
}

/// A mid-flight loss the retry cannot walk past must leave the row failed
/// with the offset AND the transfer's own session URL, and the next drive
/// must resume that session instead of re-uploading the object.
#[tokio::test]
async fn an_interrupt_without_progress_persists_the_real_session_url() {
    const SESSION_URL: &str = "https://abc.storage.supabase.co/upload/resumable/session-1";
    let mut inner = FakeTransfer::new();
    inner.max_single = 4;
    let transfer = Arc::new(StuckAtOffset {
        inner,
        offset: 12,
        session_url: SESSION_URL.into(),
        stuck: std::sync::Mutex::new(true),
    });
    let engine = engine_over(
        LocalStore::open_in_memory().expect("store"),
        transfer.clone(),
    );
    insert_photo_row(&engine, "u1/p1/big.bin");
    let bytes = Arc::new(MapAttachmentBytes::new());
    bytes.insert("/sandbox/big.bin", vec![4u8; 20]);
    engine
        .enqueue_upload(EnqueueUpload {
            content_type: Some("application/octet-stream".into()),
            ..upload_of("big", "bin", 20)
        })
        .expect("enqueue");

    let n = engine
        .drive_attachment_queue(bytes.clone(), 10)
        .await
        .expect("drive");
    assert_eq!(n, 0);
    let interrupted = engine
        .get_attachment("u1/p1/big.bin")
        .expect("get")
        .expect("present");
    assert_eq!(interrupted.state, AttachmentState::Failed);
    assert!(!interrupted.in_flight);
    assert_eq!(interrupted.chunk_offset, 12);
    assert_eq!(interrupted.tus_url.as_deref(), Some(SESSION_URL));

    transfer.resume();
    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("second drive");
    assert_eq!(n, 1);
    let synced = engine
        .get_attachment("u1/p1/big.bin")
        .expect("get")
        .expect("present");
    assert_eq!(synced.state, AttachmentState::Synced);
    assert_eq!(synced.tus_url.as_deref(), Some(SESSION_URL));
    assert_eq!(transfer.inner.uploaded.lock().expect("lock").len(), 20);
}

#[tokio::test]
async fn confirm_failure_does_not_mark_synced() {
    let transfer = Arc::new(FakeTransfer::new());
    transfer.fail_next_confirm();
    let engine = engine_with_transfer(transfer.clone());
    insert_photo_row(&engine, "u1/p1/up1.png");
    let bytes = bytes_with("/sandbox/up1.png", b"png-bytes".to_vec());
    engine.enqueue_upload(png_upload()).expect("enqueue");
    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("drive");
    assert_eq!(n, 0);
    let status = engine
        .attachment_status("u1/p1/up1.png")
        .expect("status")
        .expect("present");
    assert_eq!(status.state, AttachmentState::Failed);
    assert_eq!(status.error_code.as_deref(), Some("TRANSFER"));
    assert!(transfer.confirmed.lock().expect("lock").is_empty());
}

#[tokio::test]
async fn set_remote_access_token_fans_out_to_transfer() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_transfer(transfer.clone());
    engine.set_remote_access_token(Some("jwt-fan".into()));
    assert_eq!(
        transfer.access_token.lock().expect("lock").as_deref(),
        Some("jwt-fan")
    );
    engine.set_remote_access_token(None);
    assert!(transfer.access_token.lock().expect("lock").is_none());
}

#[tokio::test]
async fn sync_drives_the_queue_when_transfer_is_attached() {
    let transfer = Arc::new(FakeTransfer::new());
    let bytes = bytes_with("/sandbox/up1.png", b"png-bytes".to_vec());
    let engine = engine_with_transfer(transfer.clone()).with_attachment_bytes(bytes);
    insert_photo_row(&engine, "u1/p1/up1.png");
    engine.enqueue_upload(png_upload()).expect("enqueue");
    engine.sync().await.expect("sync");
    let status = engine
        .attachment_status("u1/p1/up1.png")
        .expect("status")
        .expect("present");
    assert_eq!(status.state, AttachmentState::Synced);
    assert_eq!(transfer.confirmed.lock().expect("lock").len(), 1);
}

/// The claim must still be held when `confirm` runs: releasing it at the
/// mid-flight progress write would leave a process killed in that window
/// with a row nothing can reach: 'uploading' is not a candidate state.
#[tokio::test]
async fn the_upload_keeps_its_claim_until_confirm_settles() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("kizunasync.db");
    let watcher = Arc::new(ConfirmWatcher {
        db: db.clone(),
        reference: "u1/p1/up1.png".into(),
        in_flight_at_confirm: std::sync::Mutex::new(None),
    });
    let engine = engine_over(LocalStore::open_path(&db).expect("store"), watcher.clone());
    insert_photo_row(&engine, "u1/p1/up1.png");
    let bytes = bytes_with("/sandbox/up1.png", b"png-bytes".to_vec());
    engine.enqueue_upload(png_upload()).expect("enqueue");

    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("drive");
    assert_eq!(n, 1);
    assert_eq!(
        *watcher.in_flight_at_confirm.lock().expect("lock"),
        Some(1),
        "the row must still be claimed while confirm is in flight"
    );
    let settled = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(settled.state, AttachmentState::Synced);
    assert!(!settled.in_flight);
}

/// The crash window between the bytes landing and `confirm` settling. The
/// row stays claimed there, so it is invisible to the queue until recovery
/// hands it back, and a released claim would have made it invisible
/// forever, since the candidate SELECT skips 'uploading'.
#[tokio::test]
async fn queue_recovers_an_upload_killed_before_confirm() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_transfer(transfer.clone());
    insert_photo_row(&engine, "u1/p1/up1.png");
    let bytes = bytes_with("/sandbox/up1.png", b"png-bytes".to_vec());
    engine.enqueue_upload(png_upload()).expect("enqueue");

    // The state a process killed between `upload_with_policy` and `confirm`
    // leaves behind: claimed, uploading, offset persisted.
    let now = "2020-01-01T00:00:00.000Z";
    assert!(
        engine
            .store
            .claim_attachment("u1/p1/up1.png", AttachmentState::Uploading, now)
            .expect("claim")
            .is_some()
    );
    engine
        .store
        .upsert_attachment_progress(
            "u1/p1/up1.png",
            9,
            9,
            Some("tus://media/u1/p1/up1.png"),
            AttachmentState::Uploading,
            true,
            now,
        )
        .expect("mid-flight progress");
    let stranded = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(stranded.state, AttachmentState::Uploading);
    assert!(stranded.in_flight);
    assert!(
        engine
            .pending_attachments("upload")
            .expect("pending")
            .is_empty()
    );

    engine
        .recover_in_flight_attachments()
        .expect("recover in flight");
    let recovered = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(recovered.state, AttachmentState::Queued);
    assert!(!recovered.in_flight);

    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("drive");
    assert_eq!(n, 1);
    let status = engine
        .attachment_status("u1/p1/up1.png")
        .expect("status")
        .expect("present");
    assert_eq!(status.state, AttachmentState::Synced);
    assert_eq!(transfer.confirmed.lock().expect("lock").len(), 1);
}

/// A row that never recorded a positive size must confirm the bytes it
/// actually sent: a 0 would make the server's integrity record a lie.
#[tokio::test]
async fn confirm_records_payload_length_when_the_row_has_no_size() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_transfer(transfer.clone());
    insert_photo_row(&engine, "u1/p1/up1.png");
    let bytes = bytes_with("/sandbox/up1.png", b"png-bytes".to_vec());
    engine
        .enqueue_upload(EnqueueUpload {
            size: 0,
            ..png_upload()
        })
        .expect("enqueue");

    let n = engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("drive");
    assert_eq!(n, 1);
    let confirmed = transfer.confirmed.lock().expect("lock");
    assert_eq!(confirmed.len(), 1);
    assert_eq!(confirmed[0].1.size, 9);
}

/// The pk a host names an import by is lowercased the way a write's is, so
/// an uppercase spelling of a uuid finds the stored row and the reference
/// and queued job carry the lowercase form the server keeps.
#[tokio::test]
async fn from_file_lowercases_an_uppercase_uuid_pk() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("photo.bin");
    std::fs::write(&source, b"png-bytes").expect("write source");
    let engine = engine_with_attachment_column(
        LocalStore::open_in_memory().expect("store"),
        Arc::new(FakeTransfer::new()),
        dir.path().join("sandbox"),
    );
    insert_import_row(&engine, Op::Insert, "m1");

    let imported = engine
        .from_file(
            "todos",
            "photo",
            &IMPORT_PK.to_ascii_uppercase(),
            source.to_str().expect("source path"),
            Some("image/png"),
        )
        .expect("an uppercase pk names the stored row");

    assert!(
        imported.reference.contains(&format!("/{IMPORT_PK}/")),
        "{}",
        imported.reference
    );
    let pending = engine.pending_attachments("upload").expect("pending");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].pk, IMPORT_PK);
    let row = engine
        .read_row("todos", IMPORT_PK)
        .expect("read")
        .expect("row");
    assert_eq!(row.columns["photo"], json!(imported.reference));
}

/// `from_file` enqueues before it applies the ref, so an apply that never
/// lands must not leave the job behind: the ref no row carries would claim
/// and release on every drive forever. Resurrection is a local constraint:
/// `apply` errors after evicting the ref, which no server ever saw.
#[tokio::test]
async fn from_file_evicts_the_job_when_the_row_is_tombstoned() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("photo.bin");
    std::fs::write(&source, b"png-bytes").expect("write source");
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_attachment_column(
        LocalStore::open_in_memory().expect("store"),
        transfer.clone(),
        dir.path().join("sandbox"),
    );

    // A peer's delete leaves the no-resurrection shadow; the local write
    // that follows restores the row WITHOUT clearing it.
    engine
        .seed_tombstone("todos", IMPORT_PK, "7")
        .expect("seed tombstone");
    insert_import_row(&engine, Op::Update, "m1");

    let error = engine
        .from_file(
            "todos",
            "photo",
            IMPORT_PK,
            source.to_str().expect("source path"),
            Some("image/png"),
        )
        .expect_err("resurrection is refused");
    assert!(matches!(error, EngineError::LocalConstraint(_)), "{error}");
    assert!(
        engine
            .pending_attachments("upload")
            .expect("pending")
            .is_empty()
    );
    let evicted = engine.orphaned_attachments().expect("vacuum rows");
    assert_eq!(evicted.len(), 1);
    assert_eq!(evicted[0].state, AttachmentState::Evicted);

    let n = engine
        .drive_attachment_queue(Arc::new(MapAttachmentBytes::new()), 10)
        .await
        .expect("drive");
    assert_eq!(n, 0);
    assert!(transfer.confirmed.lock().expect("lock").is_empty());
}

/// The same contract when `apply` FAILS instead of refusing: a store fault
/// injected into the outbox write (a `SQLite` trigger, the technique
/// `tests/reconcile_atomicity.rs` uses) must leave the job evicted and the
/// original error propagated.
#[tokio::test]
async fn from_file_evicts_the_job_when_apply_fails() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("kizunasync.db");
    let source = dir.path().join("photo.bin");
    std::fs::write(&source, b"png-bytes").expect("write source");
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_attachment_column(
        LocalStore::open_path(&db).expect("store"),
        transfer,
        dir.path().join("sandbox"),
    );
    insert_import_row(&engine, Op::Insert, "m1");

    // Triggers are schema objects, so a second connection can install one
    // that aborts the outbox write `from_file`'s apply performs.
    rusqlite::Connection::open(&db)
        .expect("open raw")
        .execute_batch(
            "CREATE TRIGGER fail_attachment_apply BEFORE INSERT ON _kizunasync_outbox
             WHEN NEW.op = 'update'
             BEGIN SELECT RAISE(ABORT, 'injected store fault'); END;",
        )
        .expect("install trigger");

    engine
        .from_file(
            "todos",
            "photo",
            IMPORT_PK,
            source.to_str().expect("source path"),
            Some("image/png"),
        )
        .expect_err("apply must fail");

    let evicted = engine.orphaned_attachments().expect("vacuum rows");
    assert_eq!(evicted.len(), 1);
    assert_eq!(evicted[0].state, AttachmentState::Evicted);
    assert!(
        engine
            .pending_attachments("upload")
            .expect("pending")
            .is_empty()
    );
    let row = engine
        .read_row("todos", IMPORT_PK)
        .expect("read")
        .expect("row");
    assert!(row.columns.get("photo").is_none());
}

fn resolving_engine(transfer: Arc<DownloadingTransfer>, root: &Path) -> SyncEngine {
    engine_over(LocalStore::open_in_memory().expect("store"), transfer)
        .with_attachment_root(root.to_path_buf())
}

/// The sandbox file was evicted (an OS purge, a wiped cache) but the row
/// still says 'synced'. Without a re-drive the ref answers `None` forever:
/// the claim gate accepts 'queued'/'failed'/'uploading' only.
#[tokio::test]
async fn resolve_download_refetches_a_synced_row_whose_file_was_evicted() {
    let (_dir, root) = sandbox();
    let transfer = Arc::new(DownloadingTransfer::new(b"fresh-bytes"));
    let engine = resolving_engine(transfer.clone(), &root);
    let evicted = root
        .join("downloads")
        .join("evicted.png")
        .to_string_lossy()
        .into_owned();
    engine
        .put_attachment(&attachment_row(
            "u1/p1/up1.png",
            "download",
            AttachmentState::Synced,
            Some(&evicted),
            b"fresh-bytes",
        ))
        .expect("put");

    let resolved = engine
        .resolve_download("u1/p1/up1.png")
        .await
        .expect("resolve")
        .expect("a fresh sandbox path");
    assert_eq!(
        std::fs::read(&resolved).expect("read refetched bytes"),
        b"fresh-bytes"
    );
    assert_eq!(transfer.downloads.lock().expect("lock").len(), 1);
    let row = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(row.state, AttachmentState::Synced);
    assert!(!row.in_flight);
    assert_eq!(row.local_path.as_deref(), Some(resolved.as_str()));
}

/// Direction does not gate the refetch: a synced UPLOAD has its bytes on
/// Storage, so an evicted sandbox file is just as fetchable, and the row
/// BECOMES a download, because the object is confirmed and only the local
/// copy is missing.
#[tokio::test]
async fn resolve_download_refetches_a_synced_upload() {
    let (_dir, root) = sandbox();
    let transfer = Arc::new(DownloadingTransfer::new(b"uploaded-bytes"));
    let engine = resolving_engine(transfer.clone(), &root);
    engine
        .put_attachment(&attachment_row(
            "u1/p1/up1.png",
            "upload",
            AttachmentState::Synced,
            Some("/sandbox/content/gone"),
            b"uploaded-bytes",
        ))
        .expect("put");

    let resolved = engine
        .resolve_download("u1/p1/up1.png")
        .await
        .expect("resolve")
        .expect("a fresh sandbox path");
    assert_eq!(
        std::fs::read(&resolved).expect("read refetched bytes"),
        b"uploaded-bytes"
    );
    let row = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(row.direction, "download");
    assert_eq!(row.state, AttachmentState::Synced);
}

/// A refetch that FAILS must leave a retryable DOWNLOAD, never an upload the
/// drive will keep failing on "missing sandbox bytes": the local copy is
/// exactly what is gone, while the object is already confirmed on Storage.
#[tokio::test]
async fn a_failed_refetch_leaves_an_evicted_upload_as_a_retryable_download() {
    let (_dir, root) = sandbox();
    let transfer = Arc::new(DownloadingTransfer::offline());
    let engine = resolving_engine(transfer.clone(), &root);
    engine
        .put_attachment(&attachment_row(
            "u1/p1/up1.png",
            "upload",
            AttachmentState::Synced,
            Some("/sandbox/content/gone"),
            b"unreachable",
        ))
        .expect("put");

    assert!(
        engine
            .resolve_download("u1/p1/up1.png")
            .await
            .expect("resolve")
            .is_none()
    );
    let row = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(row.direction, "download");
    assert_eq!(row.state, AttachmentState::Failed);
    assert!(!row.in_flight);
    // The recorded text is the row's contract with the app, so it is matched
    // whole: "network down" is this test's own offline transfer.
    assert_eq!(row.error.as_deref(), Some("transfer failed: network down"));
    assert_eq!(row.error_code.as_deref(), Some("TRANSFER"));

    // The upload drive must not see it at all.
    assert!(
        engine
            .pending_attachments("upload")
            .expect("pending uploads")
            .is_empty()
    );
    let uploaded = engine
        .drive_attachment_queue(Arc::new(MapAttachmentBytes::new()), 10)
        .await
        .expect("drive");
    assert_eq!(uploaded, 0);
    assert!(transfer.uploads.lock().expect("lock").is_empty());
    let after_drive = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(
        after_drive.error.as_deref(),
        Some("transfer failed: network down")
    );
    assert_eq!(
        engine
            .pending_attachments("download")
            .expect("pending downloads")
            .len(),
        1
    );
}

/// `create_dir_all` runs AFTER the claim, so its failure must release the row
/// like the metadata arm does: a bare `?` would strand it 'downloading' until
/// the next recovery pass.
#[tokio::test]
async fn a_download_directory_failure_releases_the_claim() {
    let (_dir, root) = sandbox();
    std::fs::create_dir_all(&root).expect("create root");
    // A FILE where the downloads directory belongs: create_dir_all cannot win.
    std::fs::write(root.join("downloads"), b"not a directory").expect("block downloads");
    let transfer = Arc::new(DownloadingTransfer::new(b"fresh-bytes"));
    let engine = resolving_engine(transfer.clone(), &root);
    engine
        .put_attachment(&attachment_row(
            "u1/p1/up1.png",
            "download",
            AttachmentState::Queued,
            None,
            b"fresh-bytes",
        ))
        .expect("put");

    assert!(
        engine
            .resolve_download("u1/p1/up1.png")
            .await
            .expect("resolve")
            .is_none()
    );
    let failed = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(failed.state, AttachmentState::Failed);
    assert!(!failed.in_flight);
    // The recorded text names the step that failed, which is how the app tells
    // this arm from the metadata one; the OS wording after it varies.
    assert!(
        failed
            .error
            .expect("a recorded failure")
            .contains("create download dir")
    );
    assert_eq!(failed.error_code.as_deref(), Some("STORE"));
    assert!(transfer.downloads.lock().expect("lock").is_empty());

    // Released, so the next resolve retries once the path is usable again.
    std::fs::remove_file(root.join("downloads")).expect("unblock downloads");
    let resolved = engine
        .resolve_download("u1/p1/up1.png")
        .await
        .expect("retry")
        .expect("a fresh sandbox path");
    assert_eq!(
        std::fs::read(&resolved).expect("read refetched bytes"),
        b"fresh-bytes"
    );
    let synced = engine
        .attachment_status("u1/p1/up1.png")
        .expect("status")
        .expect("present");
    assert_eq!(synced.error_code, None, "a success clears the failure code");
}

// MARK: - The session the queue runs under

/// The fixture engine with its session cleared again, as after a sign-out.
fn signed_out(engine: SyncEngine) -> SyncEngine {
    engine.set_remote_access_token(None);
    engine
}

#[tokio::test]
async fn a_drive_without_a_session_claims_nothing() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = signed_out(engine_with_transfer(transfer.clone()));
    insert_photo_row(&engine, "u1/p1/up1.png");
    engine.enqueue_upload(png_upload()).expect("enqueue");

    let n = engine
        .drive_attachment_queue(bytes_with("/sandbox/up1.png", b"png-bytes".to_vec()), 10)
        .await
        .expect("drive");

    assert_eq!(n, 0);
    let untouched = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(untouched.state, AttachmentState::Queued);
    assert_eq!(untouched.attempts, 0);
    assert!(!untouched.in_flight);
    assert!(transfer.uploaded.lock().expect("lock").is_empty());
}

#[tokio::test]
async fn a_sync_without_a_session_uploads_nothing() {
    let transfer = Arc::new(FakeTransfer::new());
    let bytes = bytes_with("/sandbox/up1.png", b"png-bytes".to_vec());
    let engine = signed_out(engine_with_transfer(transfer.clone()).with_attachment_bytes(bytes));
    insert_photo_row(&engine, "u1/p1/up1.png");
    engine.enqueue_upload(png_upload()).expect("enqueue");

    engine.sync().await.expect("sync");

    assert!(transfer.uploaded.lock().expect("lock").is_empty());
    assert!(transfer.confirmed.lock().expect("lock").is_empty());
    let status = engine
        .attachment_status("u1/p1/up1.png")
        .expect("status")
        .expect("present");
    assert_eq!(status.state, AttachmentState::Queued);
}

/// An orphaned object whose row this test controls, so the vacuum has one
/// Storage removal to make.
fn orphan(engine: &SyncEngine, reference: &str) {
    engine
        .put_attachment(&attachment_row(
            reference,
            "upload",
            AttachmentState::Synced,
            None,
            b"old-bytes",
        ))
        .expect("put");
    engine.orphan_attachment(reference).expect("orphan");
}

#[tokio::test]
async fn a_vacuum_without_a_session_removes_nothing() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = signed_out(engine_with_transfer(transfer.clone()));
    orphan(&engine, "u1/p1/old.png");

    engine.vacuum_attachments().await.expect("vacuum");

    assert!(transfer.removed.lock().expect("lock").is_empty());
    assert_eq!(
        engine
            .attachment_status("u1/p1/old.png")
            .expect("status")
            .expect("the row waits for a session")
            .state,
        AttachmentState::Orphaned
    );
}

/// A store latched for another user's session moves no bytes at all: the
/// queue may belong to the previous user.
#[tokio::test]
async fn a_soft_blocked_store_drives_downloads_and_vacuums_nothing() {
    let (_dir, root) = sandbox();
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_over(
        LocalStore::open_in_memory().expect("store"),
        transfer.clone(),
    )
    .with_attachment_root(root);
    insert_photo_row(&engine, "u1/p1/up1.png");
    engine.enqueue_upload(png_upload()).expect("enqueue");
    engine
        .put_attachment(&attachment_row(
            "u2/p9/peer.png",
            "download",
            AttachmentState::Queued,
            None,
            b"peer-bytes",
        ))
        .expect("put the download");
    orphan(&engine, "u1/p1/old.png");

    engine.set_remote_access_token(Some(SESSION_U2.into()));
    assert!(engine.is_soft_blocked().expect("block"));

    let driven = engine
        .drive_attachment_queue(bytes_with("/sandbox/up1.png", b"png-bytes".to_vec()), 10)
        .await
        .expect("drive");
    let resolved = engine
        .resolve_download("u2/p9/peer.png")
        .await
        .expect("resolve");
    engine.vacuum_attachments().await.expect("vacuum");

    assert_eq!(driven, 0);
    assert!(resolved.is_none());
    assert!(transfer.uploaded.lock().expect("lock").is_empty());
    assert!(transfer.downloaded.lock().expect("lock").is_empty());
    assert!(transfer.removed.lock().expect("lock").is_empty());
    for (reference, state) in [
        ("u1/p1/up1.png", AttachmentState::Queued),
        ("u2/p9/peer.png", AttachmentState::Queued),
        ("u1/p1/old.png", AttachmentState::Orphaned),
    ] {
        let entry = engine
            .get_attachment(reference)
            .expect("get")
            .expect("present");
        assert_eq!(entry.state, state, "{reference}");
        assert_eq!(entry.attempts, 0, "{reference}");
    }
}

/// Storage refusing the session: uploads answer 401, and a download finds no
/// session to send.
struct SessionRefused;

#[async_trait::async_trait]
impl Transfer for SessionRefused {
    fn supports_resumable(&self) -> bool {
        false
    }

    async fn upload_single_shot(
        &self,
        _target: &UploadTarget,
        _bytes: &[u8],
    ) -> Result<(), TransferError> {
        Err(TransferError::Http {
            status: 401,
            detail: "jwt expired".into(),
        })
    }

    async fn upload_resumable(
        &self,
        _target: &UploadTarget,
        _bytes: &[u8],
        _start_offset: u64,
        _existing_tus_url: Option<&str>,
    ) -> Result<UploadProgress, TransferError> {
        Err(TransferError::Http {
            status: 401,
            detail: "jwt expired".into(),
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
        Ok(Some(kizunasync_transfer::sha256_hex(b"peer-bytes")))
    }

    async fn download(
        &self,
        _target: &ObjectTarget,
        _to_local_path: &str,
        _sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        Err(TransferError::Unauthorized)
    }

    async fn remove(&self, _target: &ObjectTarget) -> Result<(), TransferError> {
        Ok(())
    }
}

#[tokio::test]
async fn an_upload_refused_with_401_releases_its_claim_uncharged() {
    let engine = engine_over(
        LocalStore::open_in_memory().expect("store"),
        Arc::new(SessionRefused),
    );
    insert_photo_row(&engine, "u1/p1/up1.png");
    engine.enqueue_upload(png_upload()).expect("enqueue");

    let n = engine
        .drive_attachment_queue(bytes_with("/sandbox/up1.png", b"png-bytes".to_vec()), 10)
        .await
        .expect("drive");

    assert_eq!(n, 0);
    let released = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(released.state, AttachmentState::Queued);
    assert!(!released.in_flight);
    assert_eq!(released.attempts, 0, "a refused session costs no attempt");
    assert!(released.error.is_none());
}

#[tokio::test]
async fn a_download_without_a_session_releases_its_claim_uncharged() {
    let (_dir, root) = sandbox();
    let engine = engine_over(
        LocalStore::open_in_memory().expect("store"),
        Arc::new(SessionRefused),
    )
    .with_attachment_root(root);
    engine
        .put_attachment(&attachment_row(
            "u2/p9/peer.png",
            "download",
            AttachmentState::Queued,
            None,
            b"peer-bytes",
        ))
        .expect("put");

    let resolved = engine
        .resolve_download("u2/p9/peer.png")
        .await
        .expect("resolve");

    assert!(resolved.is_none());
    let released = engine
        .get_attachment("u2/p9/peer.png")
        .expect("get")
        .expect("present");
    assert_eq!(released.state, AttachmentState::Queued);
    assert!(!released.in_flight);
    assert_eq!(released.attempts, 0, "a missing session costs no attempt");
}

/// The session URL a scripted upload persists, as a real TUS session would.
const SCRIPTED_SESSION: &str = "https://abc.storage.supabase.co/upload/resumable/s1";

/// Answers each resumable upload with the next scripted outcome, and records
/// the session URL each attempt was handed. Two interrupts at one offset make
/// the first drive persist a live session; the failure under test answers
/// the next drive, which resumes it.
struct ScriptedUpload {
    outcomes: std::sync::Mutex<std::collections::VecDeque<TransferError>>,
    sessions_seen: std::sync::Mutex<Vec<Option<String>>>,
}

impl ScriptedUpload {
    fn failing_a_resume_with(failure: TransferError) -> Arc<Self> {
        let interrupted = || TransferError::Interrupted {
            offset: 4,
            tus_url: Some(SCRIPTED_SESSION.into()),
        };
        Arc::new(Self {
            outcomes: std::sync::Mutex::new([interrupted(), interrupted(), failure].into()),
            sessions_seen: std::sync::Mutex::new(Vec::new()),
        })
    }
}

#[async_trait::async_trait]
impl Transfer for ScriptedUpload {
    fn supports_resumable(&self) -> bool {
        true
    }

    fn single_shot_max_bytes(&self) -> u64 {
        0
    }

    async fn upload_single_shot(
        &self,
        _target: &UploadTarget,
        _bytes: &[u8],
    ) -> Result<(), TransferError> {
        Err(TransferError::Failed(
            "the script never uploads in one shot".into(),
        ))
    }

    async fn upload_resumable(
        &self,
        _target: &UploadTarget,
        _bytes: &[u8],
        _start_offset: u64,
        existing_tus_url: Option<&str>,
    ) -> Result<UploadProgress, TransferError> {
        self.sessions_seen
            .lock()
            .expect("lock")
            .push(existing_tus_url.map(str::to_string));
        Err(self
            .outcomes
            .lock()
            .expect("lock")
            .pop_front()
            .unwrap_or_else(|| TransferError::Failed("the script ran out".into())))
    }

    async fn confirm(
        &self,
        _target: &ObjectTarget,
        _meta: &ConfirmMeta,
        _table: &str,
    ) -> Result<(), TransferError> {
        Ok(())
    }

    async fn download(
        &self,
        _target: &ObjectTarget,
        _to_local_path: &str,
        _sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        Err(TransferError::TimedOut {
            detail: "signed download".into(),
        })
    }

    async fn metadata(&self, _target: &ObjectTarget) -> Result<Option<String>, TransferError> {
        Ok(Some(kizunasync_transfer::sha256_hex(b"peer-bytes")))
    }

    async fn remove(&self, _target: &ObjectTarget) -> Result<(), TransferError> {
        Ok(())
    }
}

/// Drives the scripted upload twice: the first drive persists the session,
/// the second resumes it into the failure under test. Answers the row the
/// second drive left.
async fn resume_into(failure: TransferError) -> (AttachmentEntry, Arc<ScriptedUpload>) {
    let transfer = ScriptedUpload::failing_a_resume_with(failure);
    let engine = engine_over(
        LocalStore::open_in_memory().expect("store"),
        transfer.clone(),
    );
    insert_photo_row(&engine, "u1/p1/up1.png");
    engine.enqueue_upload(png_upload()).expect("enqueue");
    let bytes = bytes_with("/sandbox/up1.png", b"png-bytes".to_vec());

    engine
        .drive_attachment_queue(bytes.clone(), 10)
        .await
        .expect("first drive");
    let persisted = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    assert_eq!(persisted.tus_url.as_deref(), Some(SCRIPTED_SESSION));
    assert_eq!(persisted.chunk_offset, 4);

    engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("second drive");
    assert_eq!(
        transfer.sessions_seen.lock().expect("lock").last(),
        Some(&Some(SCRIPTED_SESSION.to_string())),
        "the second drive resumes the persisted session"
    );
    let row = engine
        .get_attachment("u1/p1/up1.png")
        .expect("get")
        .expect("present");
    (row, transfer)
}

#[tokio::test]
async fn a_refused_session_is_dropped_and_the_failure_carries_its_code() {
    let (row, _) = resume_into(TransferError::SessionRefused {
        status: 403,
        detail: "tus HEAD refused".into(),
    })
    .await;

    assert_eq!(row.state, AttachmentState::Failed);
    assert_eq!(
        row.tus_url, None,
        "the refused session is never resumed again"
    );
    assert_eq!(row.chunk_offset, 0);
    assert_eq!(row.attempts, 2);
    assert!(!row.permanent, "a 403 is retried within the budget");
    assert_eq!(row.error_code.as_deref(), Some("ATTACHMENT_UPLOAD_EXPIRED"));
    let error = row.error.expect("the failure is recorded");
    assert!(
        error.starts_with("ATTACHMENT_UPLOAD_EXPIRED: u1/p1/up1.png"),
        "{error}"
    );
}

#[tokio::test]
async fn a_session_refused_with_401_is_dropped_and_releases_the_claim_uncharged() {
    let (row, _) = resume_into(TransferError::SessionRefused {
        status: 401,
        detail: "jwt expired".into(),
    })
    .await;

    assert_eq!(row.state, AttachmentState::Queued);
    assert!(!row.in_flight);
    assert_eq!(row.attempts, 1, "the refused session costs no attempt");
    assert_eq!(row.tus_url, None);
    assert!(row.error.is_none());
    assert!(row.error_code.is_none());
}

#[tokio::test]
async fn an_expired_session_is_dropped_and_the_failure_carries_its_code() {
    let (row, _) = resume_into(TransferError::SessionExpired).await;

    assert_eq!(row.state, AttachmentState::Failed);
    assert_eq!(row.tus_url, None);
    assert_eq!(row.chunk_offset, 0);
    assert_eq!(row.error_code.as_deref(), Some("ATTACHMENT_UPLOAD_EXPIRED"));
    let error = row.error.expect("the failure is recorded");
    assert!(error.starts_with("ATTACHMENT_UPLOAD_EXPIRED: "), "{error}");
}

/// A deadline does not end the session: the next attempt resumes it.
#[tokio::test]
async fn a_timed_out_upload_keeps_its_session_and_carries_the_timeout_code() {
    let (row, _) = resume_into(TransferError::TimedOut {
        detail: "tus HEAD".into(),
    })
    .await;

    assert_eq!(row.state, AttachmentState::Failed);
    assert_eq!(row.tus_url.as_deref(), Some(SCRIPTED_SESSION));
    assert_eq!(
        row.error_code.as_deref(),
        Some("ATTACHMENT_TRANSFER_TIMEOUT")
    );
    let error = row.error.expect("the failure is recorded");
    assert!(
        error.starts_with("ATTACHMENT_TRANSFER_TIMEOUT: "),
        "{error}"
    );
}

#[tokio::test]
async fn a_timed_out_download_carries_the_timeout_code() {
    let (_dir, root) = sandbox();
    let engine = engine_over(
        LocalStore::open_in_memory().expect("store"),
        ScriptedUpload::failing_a_resume_with(TransferError::SessionExpired),
    )
    .with_attachment_root(root);
    engine
        .put_attachment(&attachment_row(
            "u2/p9/peer.png",
            "download",
            AttachmentState::Queued,
            None,
            b"peer-bytes",
        ))
        .expect("put");

    engine
        .resolve_download("u2/p9/peer.png")
        .await
        .expect("resolve");

    let row = engine
        .get_attachment("u2/p9/peer.png")
        .expect("get")
        .expect("present");
    assert_eq!(row.state, AttachmentState::Failed);
    assert_eq!(
        row.error_code.as_deref(),
        Some("ATTACHMENT_TRANSFER_TIMEOUT")
    );
    let error = row.error.expect("the failure is recorded");
    assert!(
        error.starts_with("ATTACHMENT_TRANSFER_TIMEOUT: u2/p9/peer.png"),
        "{error}"
    );
}

#[tokio::test]
async fn confirm_names_the_table_whose_row_carries_the_reference() {
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine_with_transfer(transfer.clone());
    insert_photo_row(&engine, "u1/p1/up1.png");
    engine.enqueue_upload(png_upload()).expect("enqueue");

    engine
        .drive_attachment_queue(bytes_with("/sandbox/up1.png", b"png-bytes".to_vec()), 10)
        .await
        .expect("drive");

    let confirmed = transfer.confirmed.lock().expect("lock");
    assert_eq!(confirmed.len(), 1);
    assert_eq!(confirmed[0].2, "todos");
}
