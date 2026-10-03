//! Transfer port: single-shot under threshold, TUS resumable above (Supabase Storage default).
//!
//! [`TransferError`] and `FakeTransfer` (test-only) are `Send + Sync`, so an
//! embedder can carry a transfer result across an await point and share a
//! fake adapter behind an `Arc` across concurrent tasks.
//!
//! # Allocation
//!
//! Allocation-conscious: hashes, paths, and HTTP buffers allocate. Not heapless.
//! An attachment is held in memory whole: an upload hands the adapter the
//! entire object as one byte slice, and a download buffers the entire object
//! before it verifies the hash and writes the file. The Storage bucket's
//! `file_size_limit` and `allowed_mime_types` settings are the controls that
//! bound the size and the type of an object.

#![forbid(unsafe_code)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(not(target_arch = "wasm32"))]
use std::fs;
#[cfg(not(target_arch = "wasm32"))]
use std::io::Write;
use std::path::Path;
#[cfg(any(test, feature = "test-support"))]
use std::sync::Mutex;
use thiserror::Error;

/// An object at or below this size uploads in one request; Supabase Storage
/// recommends the resumable path above it.
pub const DEFAULT_SINGLE_SHOT_MAX_BYTES: u64 = 6 * 1024 * 1024;

/// The chunk size a resumable upload sends. Supabase Storage accepts this one
/// value, so a TUS request built around another size is refused.
pub const TUS_CHUNK_SIZE: u64 = 6 * 1024 * 1024;

/// Everything a [`Transfer`] call can fail with.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TransferError {
    /// The adapter refused the transfer and reported why.
    #[error("transfer failed: {0}")]
    Failed(String),
    /// A local file-store operation failed: creating the destination
    /// directory, writing the temporary file, fsyncing it, or renaming it
    /// over the destination.
    #[error("local filesystem operation failed: {detail}")]
    LocalIo {
        /// What the failing operation reported.
        detail: String,
    },
    /// The transfer lost the network mid-flight. `offset` is the last progress
    /// the server confirmed and `tus_url` the live session, so a caller can
    /// persist both and resume instead of re-sending the whole object. `None`
    /// means the adapter has no session to report, never that one was lost.
    #[error("interrupted at offset {offset}")]
    Interrupted {
        /// The last progress the server confirmed.
        offset: u64,
        /// The live session a resume continues, when the adapter has one.
        tus_url: Option<String>,
    },
    /// A peer's download 404'd because the bytes are not on Storage yet.
    #[error("attachment not yet available")]
    NotYetAvailable,
    /// No local filesystem port on this target; bytes are host-side on wasm.
    #[error("filesystem unavailable on this target")]
    FilesystemUnavailable,
    /// The local bytes an upload was queued for are not at `path`. Re-reading the
    /// same path cannot produce them, so the queue must not treat it as transient.
    #[error("local attachment bytes missing at {path}")]
    LocalBytesMissing {
        /// The sandbox path the bytes were expected at.
        path: String,
    },
    /// The call carried no authenticated session, so it never reached the host.
    #[error("no authenticated session for this transfer")]
    Unauthorized,
    /// The resumable session the upload was continuing is gone from the host; a
    /// resume has nothing to continue and the object must be sent from zero.
    #[error("the resumable upload session expired")]
    SessionExpired,
    /// The host refused the offset probe of a persisted resumable session with
    /// a client error. The session URL is unusable, so the caller drops it and
    /// the next attempt opens a new session; `status` classifies the refusal
    /// like any other HTTP answer.
    #[error("the resumable upload session was refused with HTTP {status}: {detail}")]
    SessionRefused {
        /// The status the offset probe answered with.
        status: u16,
        /// The host's own description of the refusal.
        detail: String,
    },
    /// A request ran past its deadline. A resumable session survives it, so a
    /// later attempt resumes instead of starting over.
    #[error("transfer timed out: {detail}")]
    TimedOut {
        /// Which request ran out of time.
        detail: String,
    },
    /// A URL the host handed back (a session URL or a signed download URL)
    /// that does not share the origin the adapter was configured with. The
    /// next request would go to a host the caller never configured, so the
    /// transfer is refused instead.
    #[error("the URL does not belong to the configured origin")]
    OriginMismatch,
    /// The downloaded bytes do not match the SHA-256 the caller expected, so
    /// they are refused before anything is written.
    #[error("attachment sha256 mismatch for {path}")]
    HashMismatch {
        /// The object path the refused bytes were fetched from.
        path: String,
    },
    /// The payload is larger than the adapter agreed to hold in memory.
    #[error("payload exceeds the {limit} byte limit")]
    TooLarge {
        /// The ceiling the payload would have crossed, in bytes.
        limit: u64,
    },
    /// A response that violates the transfer protocol: a header the contract
    /// requires is absent or unparsable, an offset the object cannot hold, or a
    /// status the protocol does not allow at that point in the exchange.
    #[error("transfer protocol violation: {detail}")]
    Protocol {
        /// What the response got wrong.
        detail: String,
    },
    /// A non-success HTTP status, carrying whatever the host said about it.
    #[error("transfer failed with HTTP {status}: {detail}")]
    Http {
        /// The status the host answered with.
        status: u16,
        /// The host's own description of the refusal.
        detail: String,
    },
}

impl TransferError {
    /// The HTTP status the host answered the failed request with, `None` for
    /// a failure no answer carried a status for. An adapter reports the
    /// status the host means, which Supabase Storage can carry in the body
    /// of an HTTP 400.
    #[must_use]
    pub const fn status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. } | Self::SessionRefused { status, .. } => Some(*status),
            Self::Failed(_)
            | Self::LocalIo { .. }
            | Self::Interrupted { .. }
            | Self::NotYetAvailable
            | Self::FilesystemUnavailable
            | Self::LocalBytesMissing { .. }
            | Self::Unauthorized
            | Self::SessionExpired
            | Self::TimedOut { .. }
            | Self::OriginMismatch
            | Self::HashMismatch { .. }
            | Self::TooLarge { .. }
            | Self::Protocol { .. } => None,
        }
    }
}

/// Write `bytes` to `dest` atomically: a fully fsynced temporary file is renamed
/// over the destination, so no reader ever observes a half-written object.
///
/// The fsync happens BEFORE the rename because the rename can reach the disk
/// first: a power loss in that window would otherwise surface an empty file
/// under a name that promises complete bytes. The temporary name APPENDS `.tmp`
/// to the whole file name instead of replacing the extension, so `x.png` and
/// `x.pdf` in one directory cannot race each other through a shared `x.tmp`.
///
/// # Errors
/// [`TransferError::LocalIo`], carrying the offending path, when the parent
/// directory, the temporary file, the fsync, or the rename fails, including a
/// `dest` that has no file name at all.
#[cfg(not(target_arch = "wasm32"))]
pub fn atomic_write(dest: &Path, bytes: &[u8]) -> Result<(), TransferError> {
    let Some(name) = dest.file_name() else {
        return Err(TransferError::LocalIo {
            detail: format!("atomic write target has no file name: {}", dest.display()),
        });
    };

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| TransferError::LocalIo {
            detail: format!("create dir {}: {e}", parent.display()),
        })?;
    }

    let mut tmp_name = name.to_os_string();
    tmp_name.push(".tmp");
    let tmp = dest.with_file_name(tmp_name);
    {
        let mut file = fs::File::create(&tmp).map_err(|e| TransferError::LocalIo {
            detail: format!("write {}: {e}", tmp.display()),
        })?;
        file.write_all(bytes).map_err(|e| TransferError::LocalIo {
            detail: format!("write {}: {e}", tmp.display()),
        })?;
        file.sync_all().map_err(|e| TransferError::LocalIo {
            detail: format!("sync {}: {e}", tmp.display()),
        })?;
    }

    fs::rename(&tmp, dest).map_err(|e| TransferError::LocalIo {
        detail: format!("rename {} → {}: {e}", tmp.display(), dest.display()),
    })?;
    Ok(())
}

/// Bytes are host-side on wasm; there is no local filesystem to write through.
///
/// # Errors
/// Always [`TransferError::FilesystemUnavailable`] on this target.
#[cfg(target_arch = "wasm32")]
pub fn atomic_write(_dest: &Path, _bytes: &[u8]) -> Result<(), TransferError> {
    Err(TransferError::FilesystemUnavailable)
}

/// Where an upload is going and what it declares itself to be.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadTarget {
    /// The Storage bucket.
    pub bucket: String,
    /// The object key inside the bucket.
    pub path: String,
    /// The media type recorded with the object.
    pub content_type: String,
}

/// Storage object identity shared by confirm/download/metadata/remove.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectTarget {
    /// The Storage bucket.
    pub bucket: String,
    /// The object key inside the bucket.
    pub path: String,
}

/// Integrity metadata recorded by `kizunasync.attachment_confirm`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfirmMeta {
    /// The content hash a peer verifies its download against.
    pub sha256: String,
    /// The object's byte length.
    pub size: u64,
    /// The media type recorded with the object.
    pub content_type: String,
}

/// How far an upload got, and the session a resume would continue.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UploadProgress {
    /// Bytes the server has confirmed.
    pub bytes_uploaded: u64,
    /// Bytes the object holds in total.
    pub bytes_total: u64,
    /// The live TUS session, when the adapter opened one.
    pub tus_url: Option<String>,
}

/// The bytes port: one adapter moves objects between the local sandbox and the
/// host's Storage.
#[async_trait]
pub trait Transfer: Send + Sync {
    /// Whether this adapter can resume an interrupted upload.
    fn supports_resumable(&self) -> bool;

    /// The largest object this adapter sends in one request.
    fn single_shot_max_bytes(&self) -> u64 {
        DEFAULT_SINGLE_SHOT_MAX_BYTES
    }

    /// Send the whole object in one request.
    ///
    /// # Errors
    /// Whatever the adapter's transport reports.
    async fn upload_single_shot(
        &self,
        target: &UploadTarget,
        bytes: &[u8],
    ) -> Result<(), TransferError>;

    /// Resume-aware upload. `start_offset` is durable progress from the store.
    ///
    /// # Errors
    /// [`TransferError::Interrupted`] carrying the offset and session a resume
    /// continues from, or whatever else the transport reports.
    async fn upload_resumable(
        &self,
        target: &UploadTarget,
        bytes: &[u8],
        start_offset: u64,
        existing_tus_url: Option<&str>,
    ) -> Result<UploadProgress, TransferError>;

    /// Record the object so peers can verify downloads (`sha256`, size, content
    /// type). `table` is the synced table whose row carries the reference.
    ///
    /// # Errors
    /// Whatever the adapter's transport reports.
    async fn confirm(
        &self,
        target: &ObjectTarget,
        meta: &ConfirmMeta,
        table: &str,
    ) -> Result<(), TransferError>;

    /// Download to a local path. When `sha256` is given the adapter verifies
    /// the bytes before the atomic rename.
    ///
    /// # Errors
    /// [`TransferError::NotYetAvailable`] when the object is not on Storage yet,
    /// [`TransferError::HashMismatch`] when the bytes miss `sha256`,
    /// [`TransferError::FilesystemUnavailable`] where there is no local
    /// filesystem, or whatever the transport reports.
    async fn download(
        &self,
        target: &ObjectTarget,
        to_local_path: &str,
        sha256: Option<&str>,
    ) -> Result<(), TransferError>;

    /// Expected sha256 for an object, or `None` if the server has no record yet.
    ///
    /// # Errors
    /// Whatever the adapter's transport reports.
    async fn metadata(&self, _target: &ObjectTarget) -> Result<Option<String>, TransferError> {
        Ok(None)
    }

    /// Best-effort delete of a Storage object plus the confirm-row vacuum.
    ///
    /// # Errors
    /// Whatever the adapter's transport reports.
    async fn remove(&self, target: &ObjectTarget) -> Result<(), TransferError>;

    /// Replace the user JWT used on the next Storage/RPC call. Default no-op.
    fn set_access_token(&self, _token: Option<String>) {}
}

/// Whether an object of `size` takes the resumable path: only when the adapter
/// supports it and the object is larger than one request carries.
#[must_use]
pub const fn should_use_resumable(size: u64, max_single: u64, supports: bool) -> bool {
    supports && size > max_single
}

/// The lowercase hex sha256 of `bytes`, the form the confirm row records.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// In-memory fake for tests: can interrupt once at a configured offset.
#[cfg(any(test, feature = "test-support"))]
pub struct FakeTransfer {
    /// Whether [`Transfer::supports_resumable`] answers `true`.
    pub support_resumable: bool,
    /// The single-shot threshold this fake reports.
    pub max_single: u64,
    /// The offset the next resumable upload interrupts at, consumed once.
    pub interrupt_at: Mutex<Option<u64>>,
    /// The bytes the last upload delivered.
    pub uploaded: Mutex<Vec<u8>>,
    /// The offset each TUS session has reached.
    pub tus_sessions: Mutex<std::collections::HashMap<String, u64>>,
    /// Every confirm this fake recorded, with the table it named.
    pub confirmed: Mutex<Vec<(ObjectTarget, ConfirmMeta, String)>>,
    /// Every download this fake recorded, as target and destination path.
    pub downloaded: Mutex<Vec<(ObjectTarget, String)>>,
    /// Every object this fake was asked to delete.
    pub removed: Mutex<Vec<ObjectTarget>>,
    /// The last token [`Transfer::set_access_token`] was given.
    pub access_token: Mutex<Option<String>>,
    fail_confirm: Mutex<bool>,
}

#[cfg(any(test, feature = "test-support"))]
impl FakeTransfer {
    /// A fake that supports resumable uploads and never interrupts.
    #[must_use]
    pub fn new() -> Self {
        Self {
            support_resumable: true,
            max_single: DEFAULT_SINGLE_SHOT_MAX_BYTES,
            interrupt_at: Mutex::new(None),
            uploaded: Mutex::new(Vec::new()),
            tus_sessions: Mutex::new(std::collections::HashMap::new()),
            confirmed: Mutex::new(Vec::new()),
            downloaded: Mutex::new(Vec::new()),
            removed: Mutex::new(Vec::new()),
            access_token: Mutex::new(None),
            fail_confirm: Mutex::new(false),
        }
    }

    /// Interrupt the next resumable upload once it reaches `offset`.
    pub fn interrupt_once_at(&self, offset: u64) {
        *self
            .interrupt_at
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(offset);
    }

    /// Refuse the next confirm exactly once.
    pub fn fail_next_confirm(&self) {
        *self
            .fail_confirm
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    }

    /// Record `bytes` as fully delivered and mark `key`'s session complete.
    fn record_complete_upload(&self, key: &str, bytes: &[u8]) {
        self.tus_sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.to_string(), bytes.len() as u64);
        let mut uploaded = self
            .uploaded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        uploaded.clear();
        uploaded.extend_from_slice(bytes);
    }
}

#[cfg(any(test, feature = "test-support"))]
impl Default for FakeTransfer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(any(test, feature = "test-support"))]
#[async_trait]
impl Transfer for FakeTransfer {
    fn supports_resumable(&self) -> bool {
        self.support_resumable
    }

    fn single_shot_max_bytes(&self) -> u64 {
        self.max_single
    }

    async fn upload_single_shot(
        &self,
        _target: &UploadTarget,
        bytes: &[u8],
    ) -> Result<(), TransferError> {
        let mut u = self
            .uploaded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        u.clear();
        u.extend_from_slice(bytes);
        Ok(())
    }

    async fn upload_resumable(
        &self,
        target: &UploadTarget,
        bytes: &[u8],
        start_offset: u64,
        existing_tus_url: Option<&str>,
    ) -> Result<UploadProgress, TransferError> {
        let key = existing_tus_url.map_or_else(
            || format!("tus://{}/{}", target.bucket, target.path),
            str::to_string,
        );

        let mut offset = start_offset.min(bytes.len() as u64);
        {
            let mut sessions = self
                .tus_sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let stored = sessions.entry(key.clone()).or_insert(0);
            if *stored > offset {
                offset = *stored;
            }
        }

        let mut interrupt = self
            .interrupt_at
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(at) = interrupt.filter(|&at| offset < at && at < bytes.len() as u64) else {
            self.record_complete_upload(&key, bytes);
            return Ok(UploadProgress {
                bytes_uploaded: bytes.len() as u64,
                bytes_total: bytes.len() as u64,
                tus_url: Some(key),
            });
        };

        self.tus_sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone(), at);
        let mut uploaded = self
            .uploaded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        uploaded.clear();
        uploaded.extend_from_slice(&bytes[..usize::try_from(at).unwrap_or(bytes.len())]);
        drop(uploaded);
        *interrupt = None;
        Err(TransferError::Interrupted {
            offset: at,
            tus_url: Some(key),
        })
    }

    async fn confirm(
        &self,
        target: &ObjectTarget,
        meta: &ConfirmMeta,
        table: &str,
    ) -> Result<(), TransferError> {
        let mut fail = self
            .fail_confirm
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *fail {
            *fail = false;
            return Err(TransferError::Failed("confirm refused".into()));
        }
        drop(fail);
        self.confirmed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((target.clone(), meta.clone(), table.to_string()));
        Ok(())
    }

    async fn download(
        &self,
        target: &ObjectTarget,
        to_local_path: &str,
        _sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        self.downloaded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((target.clone(), to_local_path.to_string()));
        Ok(())
    }

    async fn remove(&self, target: &ObjectTarget) -> Result<(), TransferError> {
        self.removed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(target.clone());
        Ok(())
    }

    fn set_access_token(&self, token: Option<String>) {
        *self
            .access_token
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            token.filter(|value| !value.is_empty());
    }
}

/// One resumed attempt per interruption that made progress; beyond this the
/// caller decides.
const MAX_RESUME_INTERRUPTS: u32 = 64;

/// Drive an upload to completion, resuming after every interrupt that made
/// progress.
///
/// # Errors
/// Whatever the adapter reports. An interrupt whose offset did not advance past
/// the previous attempt is handed back to the caller instead of retried: a
/// session stuck at one offset would otherwise spin here forever, and the
/// durable resume state (offset plus session URL) belongs in the caller's store.
/// Past a fixed budget of progressing interrupts the last one reaches the
/// caller instead, so a session that keeps losing the connection cannot hold
/// this call open indefinitely.
pub async fn upload_with_policy<T: Transfer + ?Sized>(
    transfer: &T,
    target: &UploadTarget,
    bytes: &[u8],
    mut start_offset: u64,
    mut tus_url: Option<String>,
) -> Result<UploadProgress, TransferError> {
    let use_resumable = should_use_resumable(
        bytes.len() as u64,
        transfer.single_shot_max_bytes(),
        transfer.supports_resumable(),
    );
    if !use_resumable {
        transfer.upload_single_shot(target, bytes).await?;
        return Ok(UploadProgress {
            bytes_uploaded: bytes.len() as u64,
            bytes_total: bytes.len() as u64,
            tus_url: None,
        });
    }

    let mut last_offset = start_offset;
    let mut resumes: u32 = 0;
    loop {
        match transfer
            .upload_resumable(target, bytes, start_offset, tus_url.as_deref())
            .await
        {
            Ok(done) => return Ok(done),
            Err(TransferError::Interrupted {
                offset,
                tus_url: url,
            }) => {
                if offset <= last_offset {
                    return Err(TransferError::Interrupted {
                        offset,
                        tus_url: url,
                    });
                }

                last_offset = offset;
                start_offset = offset;
                tus_url = url.or(tus_url);
                resumes += 1;
                if resumes > MAX_RESUME_INTERRUPTS {
                    return Err(TransferError::Interrupted { offset, tus_url });
                }
            }
            Err(e) => return Err(e),
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_interrupted_upload_resumes_and_completes() {
        let mut fake = FakeTransfer::new();
        fake.max_single = 10;
        let bytes = vec![7u8; 100];
        fake.interrupt_once_at(40);
        let target = UploadTarget {
            bucket: "b".into(),
            path: "p".into(),
            content_type: "application/octet-stream".into(),
        };
        // first attempt surfaces interrupt through low-level API
        let err = fake
            .upload_resumable(&target, &bytes, 0, None)
            .await
            .unwrap_err();
        assert_eq!(
            err,
            TransferError::Interrupted {
                offset: 40,
                tus_url: Some("tus://b/p".into())
            }
        );

        let done = upload_with_policy(&fake, &target, &bytes, 40, Some("tus://b/p".into()))
            .await
            .expect("resume");
        assert_eq!(done.bytes_uploaded, 100);
        assert_eq!(fake.uploaded.lock().unwrap().len(), 100);
    }

    #[tokio::test]
    async fn small_files_use_single_shot() {
        let fake = FakeTransfer::new();
        let bytes = b"hi";
        let target = UploadTarget {
            bucket: "b".into(),
            path: "p".into(),
            content_type: "text/plain".into(),
        };
        let done = upload_with_policy(&fake, &target, bytes, 0, None)
            .await
            .unwrap();
        assert!(done.tus_url.is_none());
        assert_eq!(fake.uploaded.lock().unwrap().as_slice(), b"hi");
    }

    #[tokio::test]
    async fn confirm_and_download_are_recorded() {
        let fake = FakeTransfer::new();
        let target = ObjectTarget {
            bucket: "media".into(),
            path: "u1/p1.png".into(),
        };
        let meta = ConfirmMeta {
            sha256: "abc".into(),
            size: 3,
            content_type: "image/png".into(),
        };
        fake.confirm(&target, &meta, "items").await.unwrap();
        fake.download(&target, "/tmp/p1.png", Some("abc"))
            .await
            .unwrap();
        fake.set_access_token(Some("jwt-1".into()));
        assert_eq!(
            fake.confirmed.lock().unwrap().as_slice(),
            &[(target.clone(), meta, "items".to_string())]
        );
        assert_eq!(
            fake.downloaded.lock().unwrap().as_slice(),
            &[(target, "/tmp/p1.png".into())]
        );
        assert_eq!(fake.access_token.lock().unwrap().as_deref(), Some("jwt-1"));
    }

    /// Two objects sharing a stem in one directory must not share a temporary
    /// file: `with_extension` gave both `x.tmp`, so one rename could carry the
    /// other's bytes.
    #[test]
    fn atomic_write_never_shares_a_temp_file_across_extensions() {
        let dir = tempfile::tempdir().expect("temp dir");
        let png = dir.path().join("x.png");
        let pdf = dir.path().join("x.pdf");

        atomic_write(&png, b"png-bytes").expect("png");
        atomic_write(&pdf, b"pdf-bytes").expect("pdf");

        assert_eq!(std::fs::read(&png).expect("read png"), b"png-bytes");
        assert_eq!(std::fs::read(&pdf).expect("read pdf"), b"pdf-bytes");
        assert!(!dir.path().join("x.tmp").exists());
        assert!(!dir.path().join("x.png.tmp").exists());
        assert!(!dir.path().join("x.pdf.tmp").exists());
    }

    #[tokio::test]
    async fn confirm_can_fail_once() {
        let fake = FakeTransfer::new();
        fake.fail_next_confirm();
        let target = ObjectTarget {
            bucket: "media".into(),
            path: "u1/p1.png".into(),
        };
        let meta = ConfirmMeta {
            sha256: "abc".into(),
            size: 3,
            content_type: "image/png".into(),
        };
        assert!(fake.confirm(&target, &meta, "items").await.is_err());
        fake.confirm(&target, &meta, "items").await.unwrap();
        assert_eq!(fake.confirmed.lock().unwrap().len(), 1);
    }

    /// An adapter that never lands a chunk, advancing the offset by one byte
    /// on every attempt: `upload_with_policy` must stop retrying instead of
    /// looping until the object completes one byte at a time.
    struct AlwaysInterruptsByOne;

    #[async_trait]
    impl Transfer for AlwaysInterruptsByOne {
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
            Err(TransferError::Failed("single shot is not scripted".into()))
        }

        async fn upload_resumable(
            &self,
            _target: &UploadTarget,
            _bytes: &[u8],
            start_offset: u64,
            _existing_tus_url: Option<&str>,
        ) -> Result<UploadProgress, TransferError> {
            Err(TransferError::Interrupted {
                offset: start_offset + 1,
                tus_url: Some("tus://always".into()),
            })
        }

        async fn confirm(
            &self,
            _target: &ObjectTarget,
            _meta: &ConfirmMeta,
            _table: &str,
        ) -> Result<(), TransferError> {
            Err(TransferError::Failed("confirm is not scripted".into()))
        }

        async fn download(
            &self,
            _target: &ObjectTarget,
            _to_local_path: &str,
            _sha256: Option<&str>,
        ) -> Result<(), TransferError> {
            Err(TransferError::Failed("download is not scripted".into()))
        }

        async fn remove(&self, _target: &ObjectTarget) -> Result<(), TransferError> {
            Err(TransferError::Failed("remove is not scripted".into()))
        }
    }

    #[tokio::test]
    async fn upload_with_policy_stops_after_the_resume_budget() {
        let bytes = vec![0_u8; 1000];
        let target = UploadTarget {
            bucket: "b".into(),
            path: "p".into(),
            content_type: "application/octet-stream".into(),
        };

        let error = upload_with_policy(&AlwaysInterruptsByOne, &target, &bytes, 0, None)
            .await
            .expect_err("a session that never lands a chunk must not loop forever");

        assert_eq!(
            error,
            TransferError::Interrupted {
                offset: u64::from(MAX_RESUME_INTERRUPTS) + 1,
                tus_url: Some("tus://always".into())
            }
        );
    }

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn transfer_error_is_send_and_sync() {
        assert_send_sync::<TransferError>();
    }

    #[test]
    fn fake_transfer_is_send_and_sync() {
        assert_send_sync::<FakeTransfer>();
    }

    /// Only a failure the host answered names a status: the queue keys the
    /// session refusal and the permanent client errors on it.
    #[test]
    fn a_failure_the_host_answered_carries_its_status() {
        let answered = [
            TransferError::Http {
                status: 403,
                detail: "refused".into(),
            },
            TransferError::SessionRefused {
                status: 400,
                detail: "tus HEAD refused".into(),
            },
        ];
        let unanswered = [
            TransferError::NotYetAvailable,
            TransferError::Unauthorized,
            TransferError::SessionExpired,
            TransferError::Failed("network down".into()),
            TransferError::HashMismatch {
                path: "u1/p1.bin".into(),
            },
        ];

        assert_eq!(answered.map(|error| error.status()), [Some(403), Some(400)]);
        for error in unanswered {
            assert_eq!(error.status(), None, "{error}");
        }
    }
}
