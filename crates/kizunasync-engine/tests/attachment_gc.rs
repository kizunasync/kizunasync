//! A Storage object is removed only on server evidence: a pulled tombstone for
//! its row, a pulled server row that carries another reference, or a push
//! verdict for this device's own write. Even then it stays while a local row
//! or a queued write still names it. Everything else this device drops is a
//! local eviction: another user's object, a store that records no user, and a
//! row that only leaves this device (a rehydration drop). An evicted row keeps
//! the object's hash, the vacuum deletes its cached bytes, and Storage is never
//! called for it.
//!
//! The vacuum ends a removal Storage keeps refusing on this device: a 401 or
//! 403 after that one attempt, any other failure once the attachment budget
//! is spent. The object stays where it is and the row ends evicted, its
//! sandbox bytes gone.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod attachment_fixtures;

use async_trait::async_trait;
use attachment_fixtures::{
    Setup, engine, page, pull, server_row, sign_in, signal, state_of, tombstone,
};
use kizunasync_engine::{DEFAULT_ATTACHMENT_ATTEMPTS, EnqueueUpload, ScriptedRemote, SyncEngine};
use kizunasync_protocol::{Op, PushResponse, Verdict};
use kizunasync_store::{AttachmentEntry, AttachmentState, LocalMutation};
use kizunasync_transfer::{
    ConfirmMeta, FakeTransfer, ObjectTarget, Transfer, TransferError, UploadProgress, UploadTarget,
};
use serde_json::{Map, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const OWN: &str = "u1/p1/own.png";
const OWN_NEXT: &str = "u1/p1/own-next.png";
const PEER: &str = "u2/p9/peer.png";
const OWN_SHA256: &str = "5e0e13ff1ba8a8b1ad5d4ed3d9f4bc3a60b6a1ee2a4e3a1e3d8ab4d5d1d1c2b3";

/// An engine signed in as `u1` over a recording transfer.
fn signed_in() -> (SyncEngine, Arc<ScriptedRemote>, Arc<FakeTransfer>) {
    let remote = Arc::new(ScriptedRemote::new());
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine(Setup {
        remote: remote.clone(),
        transfer: transfer.clone(),
        root: None,
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
    });
    sign_in(&engine, "u1");
    (engine, remote, transfer)
}

/// The Storage keys the vacuum removed.
async fn vacuumed(engine: &SyncEngine, transfer: &FakeTransfer) -> Vec<String> {
    engine.vacuum_attachments().await.expect("vacuum");
    transfer
        .removed
        .lock()
        .expect("lock")
        .iter()
        .map(|target| target.path.clone())
        .collect()
}

// MARK: - Server evidence

#[tokio::test]
async fn a_pulled_tombstone_hands_the_owners_unreferenced_object_to_the_vacuum() {
    let (engine, remote, transfer) = signed_in();
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
    assert_eq!(vacuumed(&engine, &transfer).await, vec![OWN.to_string()]);
    assert_eq!(state_of(&engine, OWN), None);
}

#[tokio::test]
async fn a_pulled_replacement_hands_the_owners_old_object_to_the_vacuum() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p1", "u1", OWN, "1")], vec![]),
    )
    .await;

    pull(
        &engine,
        &remote,
        page("2", vec![server_row("p1", "u1", OWN_NEXT, "2")], vec![]),
    )
    .await;

    assert_eq!(state_of(&engine, OWN), Some(AttachmentState::Orphaned));
    assert_eq!(state_of(&engine, OWN_NEXT), Some(AttachmentState::Queued));
    assert_eq!(vacuumed(&engine, &transfer).await, vec![OWN.to_string()]);
}

// MARK: - What keeps an object

/// A pull that carries the server's older reference must not orphan the one a
/// queued local write set: the write has not reached the server yet.
#[tokio::test]
async fn a_pending_ref_survives_a_pull_that_carries_another() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p1", "u1", OWN, "1")], vec![]),
    )
    .await;
    let mut columns = Map::new();
    columns.insert("photo".into(), json!(OWN_NEXT));
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
            mutation_id: Some("m1".into()),
        })
        .expect("replace the photo locally");
    engine
        .enqueue_upload(EnqueueUpload {
            reference: OWN_NEXT.into(),
            upload_id: "own-next".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            local_path: "/sandbox/own-next.png".into(),
            size: 9,
            sha256: None,
            content_type: None,
        })
        .expect("enqueue the new photo");

    // A peer edits the title: the server row still carries the old photo.
    pull(
        &engine,
        &remote,
        page("2", vec![server_row("p1", "u1", OWN, "2")], vec![]),
    )
    .await;

    assert_eq!(state_of(&engine, OWN_NEXT), Some(AttachmentState::Queued));
    let row = engine.read_row("todos", "p1").expect("read").expect("row");
    assert_eq!(row.columns.get("photo"), Some(&json!(OWN_NEXT)));
    assert!(vacuumed(&engine, &transfer).await.is_empty());
}

/// A rehydration drops the rows the fresh snapshot omits, which says nothing
/// about the server: the row may only have left this device's scope.
#[tokio::test]
async fn a_rehydration_drop_is_a_local_eviction() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p1", "u1", OWN, "1")], vec![]),
    )
    .await;

    pull(&engine, &remote, signal("CHECKPOINT_EXPIRED")).await;
    pull(&engine, &remote, page("5", vec![], vec![])).await;

    assert!(engine.read_row("todos", "p1").expect("read").is_none());
    assert_eq!(state_of(&engine, OWN), Some(AttachmentState::Evicted));
    assert!(vacuumed(&engine, &transfer).await.is_empty());
}

/// Another user's object is theirs to remove, even after its row is gone:
/// this device only evicts its copy.
#[tokio::test]
async fn a_peer_object_is_evicted_and_never_removed_from_storage() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p9", "u2", PEER, "1")], vec![]),
    )
    .await;

    pull(
        &engine,
        &remote,
        page("2", vec![], vec![tombstone("p9", "2")]),
    )
    .await;

    assert_eq!(state_of(&engine, PEER), Some(AttachmentState::Evicted));
    assert!(vacuumed(&engine, &transfer).await.is_empty());
}

/// Two rows can carry one reference: the object stays while either does.
#[tokio::test]
async fn a_ref_shared_with_a_second_row_survives_the_first_rows_tombstone() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page(
            "1",
            vec![
                server_row("p1", "u1", OWN, "1"),
                server_row("p2", "u1", OWN, "1"),
            ],
            vec![],
        ),
    )
    .await;

    pull(
        &engine,
        &remote,
        page("2", vec![], vec![tombstone("p1", "2")]),
    )
    .await;

    assert_eq!(state_of(&engine, OWN), Some(AttachmentState::Queued));
    assert!(vacuumed(&engine, &transfer).await.is_empty());
}

/// The store records no user before a token names one, so nothing it holds is
/// that user's to remove.
#[tokio::test]
async fn a_store_without_a_recorded_user_only_evicts() {
    let remote = Arc::new(ScriptedRemote::new());
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine(Setup {
        remote: remote.clone(),
        transfer: transfer.clone(),
        root: None,
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
    });
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

    assert_eq!(state_of(&engine, OWN), Some(AttachmentState::Evicted));
}

// MARK: - A removal Storage refuses

/// Delegates everything to a recording fake except `remove`, which fails with
/// the error `refusal` builds and counts every attempt.
struct RefusingRemoval {
    inner: FakeTransfer,
    refusal: fn() -> TransferError,
    removals: AtomicUsize,
    last_path: Mutex<Option<String>>,
}

impl RefusingRemoval {
    fn new(refusal: fn() -> TransferError) -> Self {
        Self {
            inner: FakeTransfer::new(),
            refusal,
            removals: AtomicUsize::new(0),
            last_path: Mutex::new(None),
        }
    }
}

#[async_trait]
impl Transfer for RefusingRemoval {
    fn supports_resumable(&self) -> bool {
        false
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
        self.removals.fetch_add(1, Ordering::SeqCst);
        *self.last_path.lock().expect("lock") = Some(target.path.clone());
        Err((self.refusal)())
    }
}

/// The row a removal Storage refused ends in: evicted, its cached bytes
/// deleted, its hash kept.
fn assert_evicted_without_bytes(engine: &SyncEngine, cached: &Path) {
    let evicted = engine
        .get_attachment(OWN)
        .expect("read")
        .expect("the evicted row stays");
    assert_eq!(evicted.state, AttachmentState::Evicted);
    assert_eq!(evicted.local_path, None);
    assert_eq!(evicted.sha256.as_deref(), Some(OWN_SHA256));
    assert!(!cached.exists(), "the sandbox bytes are deleted");
}

/// An orphaned own object whose bytes this device caches under `root`.
fn orphaned_with_bytes(
    refusal: fn() -> TransferError,
    attempts: i64,
    root: &Path,
) -> (SyncEngine, Arc<RefusingRemoval>, PathBuf) {
    let transfer = Arc::new(RefusingRemoval::new(refusal));
    let engine = engine(Setup {
        remote: Arc::new(ScriptedRemote::new()),
        transfer: transfer.clone(),
        root: Some(root.to_path_buf()),
        attachment_attempts: attempts,
    });
    sign_in(&engine, "u1");
    let cached = root.join("content").join("own-bytes");
    std::fs::create_dir_all(cached.parent().expect("parent")).expect("content dir");
    std::fs::write(&cached, b"png-bytes").expect("cache the bytes");
    engine
        .put_attachment(&AttachmentEntry {
            reference: OWN.into(),
            upload_id: "own".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            sha256: Some(OWN_SHA256.into()),
            content_type: None,
            size: Some(9),
            local_path: Some(cached.to_string_lossy().into_owned()),
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
    engine.orphan_attachment(OWN).expect("orphan");
    (engine, transfer, cached)
}

#[tokio::test]
async fn a_removal_refused_with_401_ends_as_a_local_eviction_after_one_attempt() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, transfer, cached) = orphaned_with_bytes(
        || TransferError::Http {
            status: 401,
            detail: "jwt expired".into(),
        },
        DEFAULT_ATTACHMENT_ATTEMPTS,
        dir.path(),
    );

    engine.vacuum_attachments().await.expect("vacuum");

    assert_eq!(transfer.removals.load(Ordering::SeqCst), 1);
    assert_evicted_without_bytes(&engine, &cached);

    engine.vacuum_attachments().await.expect("second vacuum");
    assert_eq!(transfer.removals.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_removal_refused_with_403_ends_as_a_local_eviction_after_one_attempt() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, transfer, cached) = orphaned_with_bytes(
        || TransferError::Http {
            status: 403,
            detail: "new row violates row-level security policy".into(),
        },
        DEFAULT_ATTACHMENT_ATTEMPTS,
        dir.path(),
    );

    engine.vacuum_attachments().await.expect("vacuum");

    assert_eq!(transfer.removals.load(Ordering::SeqCst), 1);
    assert_evicted_without_bytes(&engine, &cached);
}

#[tokio::test]
async fn a_failing_removal_is_retried_within_the_budget_then_evicted() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, transfer, cached) = orphaned_with_bytes(
        || TransferError::Http {
            status: 503,
            detail: "unavailable".into(),
        },
        2,
        dir.path(),
    );

    engine.vacuum_attachments().await.expect("first vacuum");

    let kept = engine
        .get_attachment(OWN)
        .expect("read")
        .expect("the row waits for the next vacuum");
    assert_eq!(kept.state, AttachmentState::Orphaned);
    assert_eq!(kept.attempts, 1);
    assert_eq!(
        kept.error.as_deref(),
        Some("transfer failed with HTTP 503: unavailable")
    );
    assert!(cached.exists());

    engine.vacuum_attachments().await.expect("second vacuum");

    assert_eq!(transfer.removals.load(Ordering::SeqCst), 2);
    assert_evicted_without_bytes(&engine, &cached);
    assert_eq!(
        transfer.last_path.lock().expect("lock").as_deref(),
        Some(OWN)
    );
}

// MARK: - Evicted rows

/// A peer's object this device downloaded, then dropped by a pulled delete:
/// evicted, with its cached bytes under `root`.
async fn evicted_peer_download(
    root: &Path,
) -> (SyncEngine, Arc<ScriptedRemote>, Arc<FakeTransfer>, PathBuf) {
    let remote = Arc::new(ScriptedRemote::new());
    let transfer = Arc::new(FakeTransfer::new());
    let engine = engine(Setup {
        remote: remote.clone(),
        transfer: transfer.clone(),
        root: Some(root.to_path_buf()),
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
    });
    sign_in(&engine, "u1");
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p9", "u2", PEER, "1")], vec![]),
    )
    .await;
    let cached = root.join("downloads").join(OWN_SHA256);
    std::fs::create_dir_all(cached.parent().expect("parent")).expect("downloads dir");
    std::fs::write(&cached, b"peer-bytes").expect("cache the bytes");
    let mut downloaded = Map::new();
    downloaded.insert("state".into(), json!("synced"));
    downloaded.insert("sha256".into(), json!(OWN_SHA256));
    downloaded.insert("size".into(), json!(10));
    downloaded.insert("local_path".into(), json!(cached.to_string_lossy()));
    engine
        .patch_attachment(PEER, &downloaded)
        .expect("record the download");
    pull(
        &engine,
        &remote,
        page("2", vec![], vec![tombstone("p9", "2")]),
    )
    .await;
    assert_eq!(state_of(&engine, PEER), Some(AttachmentState::Evicted));
    (engine, remote, transfer, cached)
}

/// The vacuum deletes an evicted row's cached bytes and forgets their path,
/// keeps the row and its hash, and never asks Storage for anything.
#[tokio::test]
async fn the_vacuum_deletes_an_evicted_rows_bytes_and_never_calls_storage() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, _remote, transfer, cached) = evicted_peer_download(dir.path()).await;

    assert!(vacuumed(&engine, &transfer).await.is_empty());

    assert!(!cached.exists(), "the cached bytes are deleted");
    let evicted = engine
        .get_attachment(PEER)
        .expect("read")
        .expect("the row stays");
    assert_eq!(evicted.state, AttachmentState::Evicted);
    assert_eq!(evicted.local_path, None);
    assert_eq!(evicted.sha256.as_deref(), Some(OWN_SHA256));
    assert!(engine.orphaned_attachments().expect("listed").is_empty());
}

/// A pull that carries an evicted reference again queues its download, and
/// the hash the row kept verifies it.
#[tokio::test]
async fn a_pull_that_carries_an_evicted_ref_again_queues_it_under_the_kept_hash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, remote, transfer, _cached) = evicted_peer_download(dir.path()).await;
    assert!(vacuumed(&engine, &transfer).await.is_empty());

    pull(
        &engine,
        &remote,
        page("3", vec![server_row("p9", "u2", PEER, "3")], vec![]),
    )
    .await;

    let queued = engine
        .get_attachment(PEER)
        .expect("read")
        .expect("the row is back");
    assert_eq!(queued.state, AttachmentState::Queued);
    assert_eq!(queued.direction, "download");
    assert_eq!(queued.sha256.as_deref(), Some(OWN_SHA256));
    assert_eq!(queued.size, Some(10));
    assert_eq!(queued.local_path, None);
}

// MARK: - Push verdicts

/// Write `photo` onto `todos`/`pk` locally.
fn replace_photo(engine: &SyncEngine, pk: &str, photo: &str, mutation_id: &str) {
    let mut columns = Map::new();
    columns.insert("photo".into(), json!(photo));
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: pk.into(),
            op: Op::Update,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some(mutation_id.into()),
        })
        .expect("replace the photo locally");
}

/// The server applied this device's replacement, so the reference it
/// replaced is garbage the moment the verdict lands.
#[tokio::test]
async fn an_applied_replacement_hands_the_owners_old_object_to_the_vacuum() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p1", "u1", OWN, "1")], vec![]),
    )
    .await;
    replace_photo(&engine, "p1", OWN_NEXT, "m1");

    engine.push_once().await.expect("push");

    assert_eq!(state_of(&engine, OWN), Some(AttachmentState::Orphaned));
    assert_eq!(vacuumed(&engine, &transfer).await, vec![OWN.to_string()]);
}

/// The server applied this device's delete of the row.
#[tokio::test]
async fn an_applied_delete_hands_the_owners_object_to_the_vacuum() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p1", "u1", OWN, "1")], vec![]),
    )
    .await;
    engine
        .apply(LocalMutation {
            table: "todos".into(),
            pk: "p1".into(),
            op: Op::Delete,
            columns: Map::new(),
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: Some("m1".into()),
        })
        .expect("delete the row locally");

    engine.push_once().await.expect("push");

    assert_eq!(state_of(&engine, OWN), Some(AttachmentState::Orphaned));
    assert_eq!(vacuumed(&engine, &transfer).await, vec![OWN.to_string()]);
}

/// A write the server refused never carried its new reference anywhere: the
/// object it introduced is garbage, and the one the server row keeps stays.
#[tokio::test]
async fn a_rejected_write_hands_the_object_it_introduced_to_the_vacuum() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p1", "u1", OWN, "1")], vec![]),
    )
    .await;
    replace_photo(&engine, "p1", OWN_NEXT, "m1");
    engine
        .enqueue_upload(EnqueueUpload {
            reference: OWN_NEXT.into(),
            upload_id: "own-next".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            local_path: "/sandbox/own-next.png".into(),
            size: 9,
            sha256: None,
            content_type: None,
        })
        .expect("enqueue the new photo");
    remote.enqueue_push(PushResponse {
        verdicts: Some(vec![Verdict {
            mutation_id: "m1".into(),
            verdict: "rejected".into(),
            reason: Some("CONSTRAINT".into()),
            server_row: Some(server_row("p1", "u1", OWN, "1").columns),
        }]),
        signal: None,
        batch: None,
    });

    engine.push_once().await.expect("push");

    assert_eq!(state_of(&engine, OWN_NEXT), Some(AttachmentState::Orphaned));
    assert_eq!(state_of(&engine, OWN), Some(AttachmentState::Queued));
    assert_eq!(
        vacuumed(&engine, &transfer).await,
        vec![OWN_NEXT.to_string()]
    );
}

/// A replacement of another user's object hands nothing to Storage: this
/// device only evicts its copy.
#[tokio::test]
async fn an_applied_replacement_of_a_peer_object_evicts_it() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p9", "u2", PEER, "1")], vec![]),
    )
    .await;
    replace_photo(&engine, "p9", OWN_NEXT, "m1");

    engine.push_once().await.expect("push");

    assert_eq!(state_of(&engine, PEER), Some(AttachmentState::Evicted));
    assert!(vacuumed(&engine, &transfer).await.is_empty());
}

/// A later write of the same push that puts the reference back keeps it: the
/// row still carries it once every verdict landed.
#[tokio::test]
async fn a_ref_the_row_carries_again_survives_the_verdict_that_replaced_it() {
    let (engine, remote, transfer) = signed_in();
    pull(
        &engine,
        &remote,
        page("1", vec![server_row("p1", "u1", OWN, "1")], vec![]),
    )
    .await;
    replace_photo(&engine, "p1", OWN_NEXT, "m1");
    replace_photo(&engine, "p1", OWN, "m2");

    engine.push_once().await.expect("push");

    assert_eq!(state_of(&engine, OWN), Some(AttachmentState::Queued));
    assert_eq!(vacuumed(&engine, &transfer).await, Vec::<String>::new());
}
