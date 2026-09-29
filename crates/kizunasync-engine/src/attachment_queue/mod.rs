//! Durable attachment upload queue: enqueue → claim → transfer →
//! progress/synced|failed|orphaned|evicted.
//!
//! Bytes travel through the injected [`Transfer`] port; durable state lives in
//! `_kizunasync_attachments` via [`LocalStore`]. Kill/resume uses `chunk_offset` + `tus_url`.

use crate::error_catalog::{
    ATTACHMENT_HASH_MISMATCH, ATTACHMENT_NOT_YET_AVAILABLE, ATTACHMENT_TRANSFER_TIMEOUT,
    ATTACHMENT_UPLOAD_EXPIRED, STORE, TRANSFER,
};
use crate::{EngineError, SyncEngine};
#[cfg(not(target_arch = "wasm32"))]
use kizunasync_protocol::Op;
#[cfg(not(target_arch = "wasm32"))]
use kizunasync_store::LocalMutation;
use kizunasync_store::{AttachmentEntry, AttachmentFailure, AttachmentState};
use kizunasync_transfer::TransferError;
#[cfg(not(target_arch = "wasm32"))]
use kizunasync_transfer::{atomic_write, sha256_hex};
use serde::{Deserialize, Serialize};
#[cfg(not(target_arch = "wasm32"))]
use serde_json::{Map, Value};
use std::collections::HashMap;
#[cfg(not(target_arch = "wasm32"))]
use std::fs;
#[cfg(not(target_arch = "wasm32"))]
use std::path::{Path, PathBuf};

/// In-process file bytes provider for tests and host adapters (maps `local_path` → bytes).
pub trait AttachmentBytes: Send + Sync {
    /// The bytes cached at `local_path`.
    ///
    /// # Errors
    /// [`kizunasync_transfer::TransferError::LocalBytesMissing`] when nothing is at
    /// that path, which the queue must never retry.
    fn read_local(&self, local_path: &str) -> Result<Vec<u8>, EngineError>;
}

/// Simple path→bytes map for unit tests.
#[derive(Default)]
#[non_exhaustive]
pub struct MapAttachmentBytes {
    /// The path-to-bytes map this provider reads.
    pub files: std::sync::Mutex<HashMap<String, Vec<u8>>>,
}

impl MapAttachmentBytes {
    /// An empty provider.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `bytes` at `path`, replacing whatever was there.
    pub fn insert(&self, path: impl Into<String>, bytes: Vec<u8>) {
        self.files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(path.into(), bytes);
    }
}

impl AttachmentBytes for MapAttachmentBytes {
    fn read_local(&self, local_path: &str) -> Result<Vec<u8>, EngineError> {
        let g = self
            .files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        g.get(local_path).cloned().ok_or_else(|| {
            EngineError::Transfer(TransferError::LocalBytesMissing {
                path: local_path.to_string(),
            })
        })
    }
}

/// Filesystem reader for real host paths.
pub struct FsAttachmentBytes;

impl AttachmentBytes for FsAttachmentBytes {
    #[cfg(not(target_arch = "wasm32"))]
    fn read_local(&self, local_path: &str) -> Result<Vec<u8>, EngineError> {
        std::fs::read(Path::new(local_path)).map_err(|_| {
            EngineError::Transfer(TransferError::LocalBytesMissing {
                path: local_path.to_string(),
            })
        })
    }

    /// Bytes are host-side on wasm; there is no local filesystem to read from.
    #[cfg(target_arch = "wasm32")]
    fn read_local(&self, _local_path: &str) -> Result<Vec<u8>, EngineError> {
        Err(EngineError::AttachmentPortsMissing)
    }
}

/// Where one attachment reference stands right now.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[non_exhaustive]
pub struct AttachmentStatus {
    /// The queue row's lifecycle state, or [`AttachmentState::Missing`] when no
    /// row carries the reference.
    pub state: AttachmentState,
    /// Bytes transferred so far.
    pub progress: i64,
    /// The last failure's message, when there was one.
    pub error: Option<String>,
    /// The sandbox path holding the bytes, when they are local.
    pub local_path: Option<String>,
    /// Whether the transfer budget stopped this reference for good. A `failed`
    /// row is retried by the next drive; a permanent one waits for the app.
    pub permanent: bool,
    /// The engine catalog code of the last recorded failure, `None` while the
    /// row records none.
    pub error_code: Option<String>,
}

/// Thin-client `from_file` result: the Storage object key plus sandbox metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[non_exhaustive]
pub struct FromFileResult {
    /// The Storage object key the row's column carries.
    pub reference: String,
    /// The imported file's content hash.
    pub sha256: String,
    /// The imported file's byte length.
    pub size: i64,
    /// The media type the upload declares.
    pub media_type: String,
    /// The sandbox path holding the bytes.
    pub local_path: String,
}

#[cfg(not(target_arch = "wasm32"))]
fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/heic" => "heic",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn sandbox_content_path(root: &Path, sha256: &str) -> PathBuf {
    root.join("content").join(sha256)
}

/// Where a download of the object whose content hash is `sha256` lands: the
/// hash alone names the file, never the reference a peer chose.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn sandbox_download_path(root: &Path, sha256: &str) -> PathBuf {
    root.join("downloads").join(sha256)
}

/// Whether `text` is a uuid in its hyphenated form (8-4-4-4-12 hex digits):
/// the only shape an import accepts for the owner and primary key its
/// reference is built from.
#[cfg(not(target_arch = "wasm32"))]
fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// Whether `text` is a SHA-256 digest in the lowercase hex every host
/// records, and so safe to name a file after.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether Storage refused the transfer for its session: no token to send,
/// or a 401. The claim is released uncharged, because the next session can
/// succeed where this one could not.
pub(super) const fn refused_the_session(error: &TransferError) -> bool {
    matches!(error, TransferError::Unauthorized) || matches!(error.status(), Some(401))
}

/// Whether the host refused the transfer with a client error no retry can
/// change, the way tus-js-client classifies one: every 4xx except 401 (the
/// session), 403 (a policy that can clear once the row is pushed), 409 and
/// 423. The row stops for good.
fn ends_for_good(error: &TransferError) -> bool {
    match error.status() {
        Some(401 | 403 | 409 | 423) | None => false,
        Some(status) => (400..500).contains(&status),
    }
}

/// The engine catalog code a failed transfer records beside its message.
pub(super) const fn failure_code(error: &TransferError) -> &'static str {
    match error {
        TransferError::SessionExpired | TransferError::SessionRefused { .. } => {
            ATTACHMENT_UPLOAD_EXPIRED
        }
        TransferError::TimedOut { .. } => ATTACHMENT_TRANSFER_TIMEOUT,
        TransferError::NotYetAvailable => ATTACHMENT_NOT_YET_AVAILABLE,
        TransferError::HashMismatch { .. } => ATTACHMENT_HASH_MISMATCH,
        TransferError::LocalIo { .. }
        | TransferError::LocalBytesMissing { .. }
        | TransferError::FilesystemUnavailable => STORE,
        _ => TRANSFER,
    }
}

/// Whether `error` ends the resumable session the row persisted: the host
/// lost it or refused it, so resuming it again can only fail the same way.
const fn ends_the_session(error: &TransferError) -> bool {
    matches!(
        error,
        TransferError::SessionExpired | TransferError::SessionRefused { .. }
    )
}

/// The text a failed transfer leaves on its row. A condition the engine
/// catalog names starts with its code, the one the `TypeScript` adapters set
/// on the same condition, so an app reads one vocabulary on every host.
fn failure_text(reference: &str, error: &TransferError) -> String {
    let detail = format!("{reference}: {error}");
    match error {
        TransferError::SessionExpired | TransferError::SessionRefused { .. } => {
            EngineError::AttachmentUploadExpired(detail).to_string()
        }
        TransferError::TimedOut { .. } => {
            EngineError::AttachmentTransferTimeout(detail).to_string()
        }
        TransferError::NotYetAvailable => {
            EngineError::AttachmentNotYetAvailable(detail).to_string()
        }
        TransferError::HashMismatch { .. } => {
            EngineError::AttachmentHashMismatch(detail).to_string()
        }
        _ => error.to_string(),
    }
}

/// One durable upload job. Deserializable so the host / NAPI edges stay pure type mapping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnqueueUpload {
    /// The Storage object key this job uploads to.
    pub reference: String,
    /// The transfer session identifier a resume continues.
    pub upload_id: String,
    /// The owning row's table.
    pub table: String,
    /// The owning row's primary key.
    pub pk: String,
    /// The owning row's column that carries the reference.
    pub column: String,
    /// The Storage bucket.
    pub bucket: String,
    /// The owner column's value, which scopes the object key.
    pub owner: String,
    /// The sandbox path holding the bytes to send.
    pub local_path: String,
    /// The object's byte length.
    pub size: i64,
    /// The content hash, when the caller already computed it.
    #[serde(default)]
    pub sha256: Option<String>,
    /// The media type, when the caller knows it.
    #[serde(default)]
    pub content_type: Option<String>,
}

impl SyncEngine {
    /// Enqueue a durable upload job (does not start transfer until [`Self::drive_attachment_queue`]).
    ///
    /// # Errors
    /// [`EngineError::Store`] when the job cannot be written.
    pub fn enqueue_upload(&self, job: EnqueueUpload) -> Result<(), EngineError> {
        let now = (self.deps.now)();
        self.store.enqueue_attachment(&AttachmentEntry {
            reference: job.reference,
            upload_id: job.upload_id,
            table: job.table,
            pk: job.pk,
            column: job.column,
            bucket: job.bucket,
            owner: job.owner,
            sha256: job.sha256,
            content_type: job.content_type,
            size: Some(job.size),
            local_path: Some(job.local_path),
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
            created_at: now.clone(),
            updated_at: now,
            error_code: None,
        })?;
        Ok(())
    }

    // MARK: - The embedder-driven queue
    //
    // An embedder that owns the byte ports, the `TypeScript` attachment queue
    // behind `IFileStore` / `ITransfer`, drives the transfer itself and needs
    // only the durable rows. These are deliberately thin: the store stays the
    // single writer of `_kizunasync_attachments` on every bridge, so a client cannot
    // end up with two queues disagreeing about what is in flight.

    /// Insert or re-enqueue one job. A re-enqueue of a known ref is a FRESH job
    /// (see [`kizunasync_store::LocalStore::put_attachment`]).
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be written.
    pub fn put_attachment(&self, entry: &AttachmentEntry) -> Result<(), EngineError> {
        Ok(self.store.put_attachment(entry)?)
    }

    /// One queue row, or `None` when no row carries `reference`.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be read.
    pub fn get_attachment(&self, reference: &str) -> Result<Option<AttachmentEntry>, EngineError> {
        Ok(self.store.get_attachment(reference)?)
    }

    /// Every drainable job for one direction. Unbounded on purpose: the caller
    /// walks the whole queue per drive, and a cap here would silently strand the
    /// tail of a large backlog.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the rows cannot be read.
    pub fn pending_attachments(
        &self,
        direction: &str,
    ) -> Result<Vec<AttachmentEntry>, EngineError> {
        Ok(self.store.list_pending_attachments(direction, usize::MAX)?)
    }

    /// Claim a job for the embedder's transfer; `false` when another driver holds
    /// it, the row is gone, or the transfer budget just stopped it.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the claim cannot be written.
    pub fn claim_attachment(
        &self,
        reference: &str,
        state: AttachmentState,
    ) -> Result<bool, EngineError> {
        let now = (self.deps.now)();
        let claimed = self
            .store
            .claim_attachment_without_attempt(reference, state, &now)?;
        self.keep_claim_within_budget(reference, claimed, &now)
    }

    /// Whether a landed claim survives the transfer budget. A row that has
    /// already consumed the configured attempts is stopped here instead of
    /// driven: the object no attempt will move otherwise keeps every later drive
    /// busy re-sending it, and the app has no way to see that it never will.
    ///
    /// Takes the claim's own answer so the budget is charged once, at the one
    /// moment a transfer is about to start.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the permanent failure cannot be written.
    pub(super) fn keep_claim_within_budget(
        &self,
        reference: &str,
        claimed: Option<i64>,
        now: &str,
    ) -> Result<bool, EngineError> {
        let Some(consumed) = claimed else {
            return Ok(false);
        };
        if consumed < self.config.attachment_attempts {
            return Ok(true);
        }
        self.store
            .fail_attachment_permanently(reference, consumed, now)?;
        Ok(false)
    }

    /// Whether this engine's own queue may reach Storage now: the host set a
    /// token that names a user, and the store is not soft-blocked. A blocked
    /// store's queue may belong to another user than the session.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the owner or the block cannot be read or
    /// written.
    pub(super) fn attachments_reach_storage(&self) -> Result<bool, EngineError> {
        Ok(self.has_session() && !self.blocks_network()?)
    }

    /// Settle a claimed transfer that `error` ended: a refused session
    /// releases the claim and refunds the attempt it charged, a client error
    /// no retry can change stops the row for good, and anything else fails
    /// it for the next drive. A failure records its message and its catalog
    /// code. A resumable session the host lost or refused is dropped first,
    /// so the next attempt opens a new one.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be written.
    pub(super) fn record_transfer_failure(
        &self,
        entry: &AttachmentEntry,
        error: &TransferError,
        now: &str,
    ) -> Result<(), EngineError> {
        if ends_the_session(error) {
            self.store.drop_attachment_session(&entry.reference, now)?;
        }
        if refused_the_session(error) {
            let mut release = kizunasync_protocol::ColumnValues::new();
            release.insert(
                "state".into(),
                serde_json::Value::String(AttachmentState::Queued.as_str().into()),
            );
            release.insert("in_flight".into(), serde_json::Value::Bool(false));
            release.insert("attempts".into(), entry.attempts.into());
            release.insert("error".into(), serde_json::Value::Null);
            release.insert("error_code".into(), serde_json::Value::Null);
            return Ok(self
                .store
                .update_attachment(&entry.reference, &release, now)?);
        }

        let message = failure_text(&entry.reference, error);
        if !ends_for_good(error) {
            let failure = AttachmentFailure {
                message: &message,
                code: failure_code(error),
            };
            return Ok(self.store.update_attachment_state(
                &entry.reference,
                AttachmentState::Failed,
                false,
                Some(failure),
                now,
            )?);
        }

        let mut stop = kizunasync_protocol::ColumnValues::new();
        stop.insert(
            "state".into(),
            serde_json::Value::String(AttachmentState::Failed.as_str().into()),
        );
        stop.insert("in_flight".into(), serde_json::Value::Bool(false));
        stop.insert("permanent".into(), serde_json::Value::Bool(true));
        stop.insert("error".into(), serde_json::Value::String(message));
        stop.insert(
            "error_code".into(),
            serde_json::Value::String(failure_code(error).into()),
        );
        Ok(self.store.update_attachment(&entry.reference, &stop, now)?)
    }

    /// Fail a claimed row on a local file-system fault: `STORE`, retried by
    /// the next drive.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be written.
    pub(super) fn record_local_failure(
        &self,
        reference: &str,
        message: &str,
        now: &str,
    ) -> Result<(), EngineError> {
        let failure = AttachmentFailure {
            message,
            code: STORE,
        };
        Ok(self.store.update_attachment_state(
            reference,
            AttachmentState::Failed,
            false,
            Some(failure),
            now,
        )?)
    }

    /// Claim one job for THIS engine's own drive loop, charging it an attempt,
    /// under the same budget the embedder-driven claim answers to.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the claim cannot be written.
    pub(super) fn claim_for_drive(
        &self,
        reference: &str,
        next_state: AttachmentState,
        now: &str,
    ) -> Result<bool, EngineError> {
        let claimed = self.store.claim_attachment(reference, next_state, now)?;
        self.keep_claim_within_budget(reference, claimed, now)
    }

    /// Hand one stopped reference back to the queue: the budget is forgiven and
    /// the next drive picks the row up again. `false` when no row carries it.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be written.
    pub fn retry_attachment(&self, reference: &str) -> Result<bool, EngineError> {
        let now = (self.deps.now)();
        Ok(self.store.retry_attachment(reference, &now)?)
    }

    /// Stop one transfer at the app's request. The row stays retryable, so a
    /// later drive or an explicit retry can take it again. `false` when no row
    /// carries the reference.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be written.
    pub fn cancel_attachment(&self, reference: &str) -> Result<bool, EngineError> {
        let now = (self.deps.now)();
        Ok(self.store.cancel_attachment(reference, &now)?)
    }

    /// Forget one reference entirely and answer the sandbox path whose bytes the
    /// host still has to delete (this engine owns no file port on every target).
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be read or deleted.
    pub fn remove_attachment(&self, reference: &str) -> Result<Option<String>, EngineError> {
        Ok(self.store.remove_attachment(reference)?)
    }

    /// Apply `patch` to one queue row and stamp it now.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be written.
    pub fn patch_attachment(
        &self,
        reference: &str,
        patch: &kizunasync_protocol::ColumnValues,
    ) -> Result<(), EngineError> {
        let now = (self.deps.now)();
        Ok(self.store.update_attachment(reference, patch, &now)?)
    }

    /// Hand one queue row to the vacuum under the same owner rule as server
    /// evidence: a reference whose owner segment is the user the store
    /// belongs to is orphaned, so the vacuum removes its Storage object. Any
    /// other reference, and every reference of a store that records no user,
    /// is evicted: the vacuum deletes its cached bytes and never asks Storage.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the owner cannot be read or the row cannot
    /// be written.
    pub fn orphan_attachment(&self, reference: &str) -> Result<(), EngineError> {
        let now = (self.deps.now)();
        let subject = self.owner_subject()?;
        self.orphan_or_evict(subject.as_deref(), reference, &now)
    }

    /// Delete one queue row outright.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be deleted.
    pub fn purge_attachment(&self, reference: &str) -> Result<(), EngineError> {
        Ok(self.store.purge_attachment(reference)?)
    }

    /// The rows the vacuum works on, oldest first: every orphaned row, and
    /// every evicted row that still caches its bytes, each with its state.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the rows cannot be read.
    pub fn orphaned_attachments(&self) -> Result<Vec<AttachmentEntry>, EngineError> {
        Ok(self.store.list_orphaned_attachments()?)
    }

    /// Crash recovery, run once by an embedder's queue opening an existing
    /// database: rows a dead process left claimed become drainable again. The
    /// engine's own clock stamps them, exactly as every sibling method does.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the rows cannot be written.
    pub fn recover_in_flight_attachments(&self) -> Result<(), EngineError> {
        let now = (self.deps.now)();
        Ok(self.store.recover_in_flight_attachments(&now)?)
    }

    /// Live rows sharing one sandbox path: the shared-bytes guard the embedder's
    /// vacuum consults before deleting a content-addressed file.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the rows cannot be read.
    pub fn count_live_attachments_at_local_path(
        &self,
        local_path: &str,
        excluding_reference: Option<&str>,
    ) -> Result<u64, EngineError> {
        Ok(self
            .store
            .count_live_attachments_at_local_path(local_path, excluding_reference)?)
    }

    /// Every sandbox path a live row still references, which is the file set a
    /// reset has to delete.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the rows cannot be read.
    pub fn attachment_local_paths(&self) -> Result<Vec<String>, EngineError> {
        Ok(self.store.attachment_local_paths()?)
    }

    /// The current status of `reference`, or `None` when no row carries it.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be read.
    pub fn attachment_status(
        &self,
        reference: &str,
    ) -> Result<Option<AttachmentStatus>, EngineError> {
        Ok(self
            .store
            .get_attachment(reference)?
            .map(|e| AttachmentStatus {
                state: e.state,
                progress: e.progress,
                error: e.error,
                local_path: e.local_path,
                permanent: e.permanent,
                error_code: e.error_code,
            }))
    }

    /// Import a host-picked filesystem path into the content-addressed sandbox,
    /// enqueue the upload, then apply the ref onto the row column.
    ///
    /// The target row must already exist (the JS `ATTACHMENT_ROW_GONE` rule).
    /// The reference is `owner/pk/upload.ext`, so the row's owner and primary
    /// key must be uuids: any other text could add path segments to the
    /// Storage key. Bytes never cross `UniFFI`: the picker stays on the host.
    ///
    /// # Errors
    /// [`EngineError::Transfer`] when the source file cannot be read or the
    /// sandbox copy cannot be written, `ATTACHMENT_PORTS_MISSING` when no
    /// sandbox root is configured, [`EngineError::UnknownTable`] for a table or
    /// column the config does not declare, [`EngineError::LocalConstraint`] for
    /// an owner or primary key that is not a uuid, and [`EngineError::Store`]
    /// for the enqueue and the apply.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn from_file(
        &self,
        table: &str,
        column: &str,
        pk: &str,
        source_path: &str,
        media_type: Option<&str>,
    ) -> Result<FromFileResult, EngineError> {
        let root = self
            .attachment_root
            .as_ref()
            .ok_or(EngineError::AttachmentPortsMissing)?;
        let spec = self
            .table_config(table)?
            .attachments
            .get(column)
            .cloned()
            .ok_or_else(|| {
                EngineError::LocalConstraint(format!(
                    "column \"{column}\" is not an attachment on \"{table}\""
                ))
            })?;

        let row = self
            .store
            .read(table, pk)?
            .ok_or_else(|| EngineError::AttachmentRowGone(format!("{table}/{pk}")))?;
        let owner = row
            .columns
            .get(&spec.owner_column)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                EngineError::AttachmentOwnerMissing(format!("{table}.{0}", spec.owner_column))
            })?;

        let bytes = fs::read(source_path).map_err(|_| {
            EngineError::Transfer(TransferError::LocalBytesMissing {
                path: source_path.to_string(),
            })
        })?;
        if !is_uuid(owner) || !is_uuid(pk) {
            return Err(EngineError::LocalConstraint(format!(
                "an attachment reference needs a uuid owner and primary key, not \"{owner}\" and \"{pk}\""
            )));
        }
        let sha256 = sha256_hex(&bytes);
        let size = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
        let media_type = media_type
            .filter(|s| !s.is_empty())
            .unwrap_or("application/octet-stream")
            .to_string();
        let sandbox = sandbox_content_path(root, &sha256);
        if !sandbox.exists() {
            atomic_write(&sandbox, &bytes)?;
        }

        let local_path = sandbox.to_string_lossy().into_owned();
        let upload_id = (self.deps.uuid)();
        let reference = format!("{owner}/{pk}/{upload_id}.{}", ext_for_mime(&media_type));
        self.enqueue_upload(EnqueueUpload {
            reference: reference.clone(),
            upload_id,
            table: table.to_string(),
            pk: pk.to_string(),
            column: column.to_string(),
            bucket: spec.storage_bucket,
            owner: owner.to_string(),
            local_path: local_path.clone(),
            size,
            sha256: Some(sha256.clone()),
            content_type: Some(media_type.clone()),
        })?;

        let mut columns = Map::new();
        columns.insert(column.to_string(), Value::String(reference.clone()));
        if let Err(err) = self.apply(LocalMutation {
            table: table.to_string(),
            pk: pk.to_string(),
            op: Op::Update,
            columns,
            transforms: None,
            precondition: None,
            batch_id: None,
            hlc: None,
            mutation_id: None,
        }) {
            // The enqueue comes first by contract (the third arm of
            // `claimed_upload_still_live`), so a failed apply leaves a job whose
            // ref no row will ever carry, which would claim and release forever.
            // No server ever saw the ref, so the job is evicted: the vacuum
            // deletes its bytes and Storage is never asked. A failure to evict
            // must not mask the apply error the caller has to see.
            let failed_at = (self.deps.now)();
            let _ = self.store.mark_attachment_evicted(&reference, &failed_at);
            return Err(err);
        }
        Ok(FromFileResult {
            reference,
            sha256,
            size,
            media_type,
            local_path,
        })
    }

    /// Bytes are host-side on wasm; there is no local filesystem to import from.
    ///
    /// # Errors
    /// Always `ATTACHMENT_PORTS_MISSING`.
    #[cfg(target_arch = "wasm32")]
    pub fn from_file(
        &self,
        _table: &str,
        _column: &str,
        _pk: &str,
        _source_path: &str,
        _media_type: Option<&str>,
    ) -> Result<FromFileResult, EngineError> {
        Err(EngineError::AttachmentPortsMissing)
    }
}

mod download;
mod drive;
mod garbage;
mod vacuum;

pub(crate) use garbage::name_refs;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
