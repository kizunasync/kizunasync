//! What a failed transfer leaves on its queue row: the engine catalog code of
//! the failure beside its message, and whether the row is retried within the
//! attachment budget or stopped for good.
//!
//! A status the host answered classifies the failure like tus-js-client
//! does: 401 releases the claim without charging it, 403, 409, 423 and every
//! server error are retried within the budget, and any other client error
//! ends the transfer for good.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod attachment_fixtures;

use async_trait::async_trait;
use attachment_fixtures::{NOW, Setup, engine, sign_in};
use kizunasync_engine::{
    DEFAULT_ATTACHMENT_ATTEMPTS, MapAttachmentBytes, ScriptedRemote, SyncEngine,
};
use kizunasync_protocol::Op;
use kizunasync_store::{AttachmentEntry, AttachmentState, LocalMutation};
use kizunasync_transfer::{
    ConfirmMeta, ObjectTarget, Transfer, TransferError, UploadProgress, UploadTarget, sha256_hex,
};
use serde_json::{Map, json};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const UPLOAD: &str = "u1/p1/up.png";
const DOWNLOAD: &str = "u2/p9/peer.png";
const LOCAL_PATH: &str = "/sandbox/up.png";
const PAYLOAD: &[u8] = b"png-bytes";

/// A transfer whose uploads and downloads fail with the errors a test
/// scripts, one per call and in order, and succeed once the script is spent.
#[derive(Default)]
struct ScriptedFailures {
    uploads: Mutex<VecDeque<TransferError>>,
    downloads: Mutex<VecDeque<TransferError>>,
    upload_calls: AtomicUsize,
}

impl ScriptedFailures {
    fn uploads_failing(errors: Vec<TransferError>) -> Arc<Self> {
        Arc::new(Self {
            uploads: Mutex::new(errors.into()),
            ..Self::default()
        })
    }

    fn downloads_failing(errors: Vec<TransferError>) -> Arc<Self> {
        Arc::new(Self {
            downloads: Mutex::new(errors.into()),
            ..Self::default()
        })
    }
}

#[async_trait]
impl Transfer for ScriptedFailures {
    fn supports_resumable(&self) -> bool {
        false
    }

    async fn upload_single_shot(
        &self,
        _target: &UploadTarget,
        _bytes: &[u8],
    ) -> Result<(), TransferError> {
        self.upload_calls.fetch_add(1, Ordering::SeqCst);
        self.uploads.lock().unwrap().pop_front().map_or(Ok(()), Err)
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

    async fn download(
        &self,
        _target: &ObjectTarget,
        to_local_path: &str,
        _sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        if let Some(error) = self.downloads.lock().unwrap().pop_front() {
            return Err(error);
        }
        std::fs::write(to_local_path, PAYLOAD).expect("write the download");
        Ok(())
    }

    async fn metadata(&self, _target: &ObjectTarget) -> Result<Option<String>, TransferError> {
        Ok(Some(sha256_hex(PAYLOAD)))
    }

    async fn remove(&self, _target: &ObjectTarget) -> Result<(), TransferError> {
        Ok(())
    }
}

/// An engine signed in as `u1` over `transfer`, with its sandbox under `root`.
fn signed_in(transfer: Arc<ScriptedFailures>, root: &Path) -> SyncEngine {
    let engine = engine(Setup {
        remote: Arc::new(ScriptedRemote::new()),
        transfer,
        root: Some(root.to_path_buf()),
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
    });
    sign_in(&engine, "u1");
    engine
}

/// A queue row for `reference` in `direction`, queued.
fn queued_row(reference: &str, direction: &str, local_path: Option<&str>) -> AttachmentEntry {
    AttachmentEntry {
        reference: reference.into(),
        upload_id: "up".into(),
        table: "todos".into(),
        pk: "p1".into(),
        column: "photo".into(),
        bucket: "media".into(),
        owner: "u1".into(),
        sha256: Some(sha256_hex(PAYLOAD)),
        content_type: None,
        size: None,
        local_path: local_path.map(str::to_string),
        direction: direction.into(),
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
    }
}

/// A row carrying [`UPLOAD`] and its queued upload.
fn with_queued_upload(engine: &SyncEngine, local_path: Option<&str>) {
    let mut columns = Map::new();
    columns.insert("owner_id".into(), json!("u1"));
    columns.insert("photo".into(), json!(UPLOAD));
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
        .expect("insert the row");
    engine
        .put_attachment(&queued_row(UPLOAD, "upload", local_path))
        .expect("queue the upload");
}

async fn drive(engine: &SyncEngine) {
    let bytes = Arc::new(MapAttachmentBytes::new());
    bytes.insert(LOCAL_PATH, PAYLOAD.to_vec());
    engine
        .drive_attachment_queue(bytes, 10)
        .await
        .expect("drive");
}

fn row(engine: &SyncEngine, reference: &str) -> AttachmentEntry {
    engine
        .get_attachment(reference)
        .expect("read")
        .expect("the row stays")
}

fn http(status: u16) -> TransferError {
    TransferError::Http {
        status,
        detail: "refused".into(),
    }
}

// MARK: - The failure code

#[tokio::test]
async fn an_upload_with_no_sandbox_path_records_a_store_failure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = signed_in(ScriptedFailures::uploads_failing(vec![]), dir.path());
    with_queued_upload(&engine, None);

    drive(&engine).await;

    let failed = row(&engine, UPLOAD);
    assert_eq!(failed.state, AttachmentState::Failed);
    assert_eq!(failed.error.as_deref(), Some("missing sandbox bytes"));
    assert_eq!(failed.error_code.as_deref(), Some("STORE"));
}

#[tokio::test]
async fn a_download_not_on_storage_yet_waits_queued_under_its_code() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = signed_in(
        ScriptedFailures::downloads_failing(vec![TransferError::NotYetAvailable]),
        dir.path(),
    );
    engine
        .put_attachment(&queued_row(DOWNLOAD, "download", None))
        .expect("queue the download");

    assert_eq!(
        engine.resolve_download(DOWNLOAD).await.expect("resolve"),
        None
    );

    let waiting = row(&engine, DOWNLOAD);
    assert_eq!(waiting.state, AttachmentState::Queued);
    assert_eq!(waiting.error, None);
    assert_eq!(
        waiting.error_code.as_deref(),
        Some("ATTACHMENT_NOT_YET_AVAILABLE")
    );
    assert_eq!(waiting.attempts, 1);
    let status = engine
        .attachment_status(DOWNLOAD)
        .expect("status")
        .expect("present");
    assert_eq!(
        status.error_code.as_deref(),
        Some("ATTACHMENT_NOT_YET_AVAILABLE")
    );
}

#[tokio::test]
async fn a_download_the_device_cannot_write_records_a_store_failure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = signed_in(
        ScriptedFailures::downloads_failing(vec![TransferError::LocalIo {
            detail: "disk full".into(),
        }]),
        dir.path(),
    );
    engine
        .put_attachment(&queued_row(DOWNLOAD, "download", None))
        .expect("queue the download");

    engine.resolve_download(DOWNLOAD).await.expect("resolve");

    let failed = row(&engine, DOWNLOAD);
    assert_eq!(failed.state, AttachmentState::Failed);
    assert_eq!(failed.error_code.as_deref(), Some("STORE"));
}

#[tokio::test]
async fn a_download_whose_bytes_miss_the_hash_records_the_mismatch_and_retries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = signed_in(
        ScriptedFailures::downloads_failing(vec![TransferError::HashMismatch {
            path: DOWNLOAD.into(),
        }]),
        dir.path(),
    );
    engine
        .put_attachment(&queued_row(DOWNLOAD, "download", None))
        .expect("queue the download");

    assert_eq!(
        engine.resolve_download(DOWNLOAD).await.expect("resolve"),
        None
    );

    let failed = row(&engine, DOWNLOAD);
    assert_eq!(failed.state, AttachmentState::Failed);
    assert!(!failed.permanent);
    assert_eq!(failed.attempts, 1);
    assert_eq!(
        failed.error_code.as_deref(),
        Some("ATTACHMENT_HASH_MISMATCH")
    );
    assert!(
        failed
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("ATTACHMENT_HASH_MISMATCH: ")),
        "{:?}",
        failed.error
    );
    let status = engine
        .attachment_status(DOWNLOAD)
        .expect("status")
        .expect("present");
    assert_eq!(
        status.error_code.as_deref(),
        Some("ATTACHMENT_HASH_MISMATCH")
    );

    assert!(
        engine
            .resolve_download(DOWNLOAD)
            .await
            .expect("retry")
            .is_some(),
        "a mismatch is retried and the next good download lands"
    );
    assert_eq!(row(&engine, DOWNLOAD).error_code, None);
}

#[tokio::test]
async fn a_success_clears_the_last_failure_code() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = signed_in(
        ScriptedFailures::uploads_failing(vec![http(503)]),
        dir.path(),
    );
    with_queued_upload(&engine, Some(LOCAL_PATH));

    drive(&engine).await;
    assert_eq!(row(&engine, UPLOAD).error_code.as_deref(), Some("TRANSFER"));
    drive(&engine).await;

    let synced = row(&engine, UPLOAD);
    assert_eq!(synced.state, AttachmentState::Synced);
    assert_eq!(synced.error_code, None);
}

// MARK: - Retried or stopped

/// Every status the host can answer an upload with, and whether the row
/// ends for good.
#[tokio::test]
async fn an_upload_refused_with_a_client_error_ends_for_good_and_the_rest_retry() {
    let cases = [
        (http(400), true),
        (http(404), true),
        (http(410), true),
        (http(413), true),
        (http(422), true),
        (
            TransferError::SessionRefused {
                status: 400,
                detail: "tus HEAD refused".into(),
            },
            true,
        ),
        (http(403), false),
        (http(409), false),
        (http(423), false),
        (http(500), false),
        (http(503), false),
        (TransferError::Failed("network down".into()), false),
    ];
    for (error, permanent) in cases {
        let dir = tempfile::tempdir().expect("tempdir");
        let transfer = ScriptedFailures::uploads_failing(vec![error.clone()]);
        let engine = signed_in(transfer.clone(), dir.path());
        with_queued_upload(&engine, Some(LOCAL_PATH));

        drive(&engine).await;
        drive(&engine).await;

        let settled = row(&engine, UPLOAD);
        assert_eq!(settled.permanent, permanent, "{error}");
        if permanent {
            assert_eq!(settled.state, AttachmentState::Failed, "{error}");
            assert_eq!(settled.attempts, 1, "{error}");
            assert!(!settled.in_flight, "{error}");
            assert_eq!(
                transfer.upload_calls.load(Ordering::SeqCst),
                1,
                "a stopped upload is never sent again: {error}"
            );
        } else {
            assert_eq!(settled.state, AttachmentState::Synced, "{error}");
            assert_eq!(transfer.upload_calls.load(Ordering::SeqCst), 2, "{error}");
        }
    }
}

#[tokio::test]
async fn a_download_refused_with_a_client_error_ends_for_good() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = signed_in(
        ScriptedFailures::downloads_failing(vec![http(400)]),
        dir.path(),
    );
    engine
        .put_attachment(&queued_row(DOWNLOAD, "download", None))
        .expect("queue the download");

    engine.resolve_download(DOWNLOAD).await.expect("resolve");
    assert_eq!(
        engine.resolve_download(DOWNLOAD).await.expect("again"),
        None
    );

    let stopped = row(&engine, DOWNLOAD);
    assert_eq!(stopped.state, AttachmentState::Failed);
    assert!(stopped.permanent);
    assert_eq!(stopped.attempts, 1);
    assert_eq!(stopped.error_code.as_deref(), Some("TRANSFER"));
}
