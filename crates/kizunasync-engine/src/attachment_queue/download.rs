#[cfg(not(target_arch = "wasm32"))]
use super::{is_sha256, sandbox_download_path};
#[cfg(not(target_arch = "wasm32"))]
use crate::error_catalog::{ATTACHMENT_NOT_YET_AVAILABLE, ATTACHMENT_UNVERIFIED};
use crate::{EngineError, SyncEngine};
#[cfg(not(target_arch = "wasm32"))]
use kizunasync_store::{AttachmentEntry, AttachmentFailure, AttachmentState};
#[cfg(not(target_arch = "wasm32"))]
use kizunasync_transfer::ObjectTarget;
#[cfg(not(target_arch = "wasm32"))]
use serde_json::Value;
#[cfg(not(target_arch = "wasm32"))]
use std::fs;
use std::path::Path;

impl SyncEngine {
    /// Lazy download: return the sandbox path when bytes are local, otherwise
    /// fetch once if a `Transfer` is attached.
    ///
    /// A row whose sandbox file is gone, after an OS purge or a wiped cache, is
    /// indistinguishable from one never fetched, so 'synced' re-drives like
    /// 'queued'/'failed' instead of answering `None` forever. Direction does not
    /// gate it: a synced UPLOAD has its bytes on Storage and is fetchable too,
    /// and re-queuing turns it INTO a download so the upload drive never sees a
    /// job whose local bytes are gone. On wasm there is no local sandbox to
    /// redrive into, so a still-missing path answers `None` without demoting the
    /// row. A soft-blocked store fetches nothing: its queue may belong to
    /// another user than the session.
    ///
    /// The bytes land under the attachment root, named by the object's SHA-256:
    /// the server's, else the one this device kept. A download with neither
    /// fails the row with `ATTACHMENT_UNVERIFIED` and fetches nothing.
    ///
    /// Waits for the network call in flight, so the attachment branch of a
    /// `sync()` never reclaims the claim this download holds.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the row cannot be read or updated, or
    /// [`EngineError::AttachmentPortsMissing`] when a refetch is attempted
    /// without an attachment root. A transfer that fails is journalled onto the
    /// row instead, so the call still answers `Ok`.
    pub async fn resolve_download(&self, reference: &str) -> Result<Option<String>, EngineError> {
        let _turn = self.network_gate().lock().await;
        let Some(entry) = self.store.get_attachment(reference)? else {
            return Ok(None);
        };
        if let Some(path) = entry.local_path.as_ref()
            && Path::new(path).is_file()
        {
            return Ok(Some(path.clone()));
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            if self.blocks_network()? {
                return Ok(None);
            }
            let redrivable = matches!(
                entry.state,
                AttachmentState::Queued | AttachmentState::Failed | AttachmentState::Synced
            );
            if redrivable && self.transfer.is_some() {
                if entry.state == AttachmentState::Synced {
                    // The claim gate accepts 'queued'/'failed'/'uploading' only, so a
                    // synced row has to be released back to the queue first. It also
                    // becomes a DOWNLOAD job: its object is confirmed on Storage and
                    // its local bytes are the ones that went missing, so leaving an
                    // upload behind would only feed the upload drive a job that can
                    // fail on "missing sandbox bytes" forever.
                    let now = (self.deps.now)();
                    let mut refetch = kizunasync_protocol::ColumnValues::new();
                    refetch.insert(
                        "state".into(),
                        Value::String(AttachmentState::Queued.as_str().into()),
                    );
                    refetch.insert("in_flight".into(), Value::Bool(false));
                    refetch.insert("error".into(), Value::Null);
                    refetch.insert("error_code".into(), Value::Null);
                    refetch.insert("direction".into(), Value::String("download".into()));
                    self.store
                        .update_attachment(&entry.reference, &refetch, &now)?;
                }
                self.drive_one_download(&entry).await?;
                if let Some(refreshed) = self.store.get_attachment(reference)?
                    && let Some(path) = refreshed.local_path
                    && Path::new(&path).is_file()
                {
                    return Ok(Some(path));
                }
            }
        }
        Ok(None)
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn drive_one_download(&self, entry: &AttachmentEntry) -> Result<(), EngineError> {
        let Some(transfer) = &self.transfer else {
            return Ok(());
        };
        let root = self
            .attachment_root
            .as_ref()
            .ok_or(EngineError::AttachmentPortsMissing)?;
        let now = (self.deps.now)();
        if !self.claim_for_drive(&entry.reference, AttachmentState::Downloading, &now)? {
            return Ok(());
        }

        let object = ObjectTarget {
            bucket: entry.bucket.clone(),
            path: entry.reference.clone(),
        };
        let server_sha = match transfer.metadata(&object).await {
            Ok(sha) => sha,
            Err(e) => return self.record_transfer_failure(entry, &e, &now),
        };
        let Some(expected_sha) = server_sha
            .filter(|sha| is_sha256(sha))
            .or_else(|| entry.sha256.clone().filter(|sha| is_sha256(sha)))
        else {
            let unverified = EngineError::AttachmentUnverified(format!(
                "{} has no known SHA-256",
                entry.reference
            ));
            self.store.update_attachment_state(
                &entry.reference,
                AttachmentState::Failed,
                false,
                Some(AttachmentFailure {
                    message: &unverified.to_string(),
                    code: ATTACHMENT_UNVERIFIED,
                }),
                &now,
            )?;
            return Ok(());
        };

        let dest = sandbox_download_path(root, &expected_sha);
        if let Some(parent) = dest.parent() {
            // Past the claim, so a bare `?` here would strand the row in
            // 'downloading' until the next recovery pass: fail it like the
            // metadata arm above and let the next drive retry.
            if let Err(e) = fs::create_dir_all(parent) {
                let failure = format!("create download dir {}: {e}", parent.display());
                self.record_local_failure(&entry.reference, &failure, &now)?;
                return Ok(());
            }
        }
        let dest_str = dest.to_string_lossy().into_owned();
        match transfer
            .download(&object, &dest_str, Some(&expected_sha))
            .await
        {
            Ok(()) => {
                let done = (self.deps.now)();
                let mut patch = kizunasync_protocol::ColumnValues::new();
                patch.insert(
                    "state".into(),
                    Value::String(AttachmentState::Synced.as_str().into()),
                );
                patch.insert("local_path".into(), Value::String(dest_str));
                patch.insert("sha256".into(), Value::String(expected_sha));
                patch.insert("in_flight".into(), Value::Bool(false));
                patch.insert("error".into(), Value::Null);
                patch.insert("error_code".into(), Value::Null);
                self.store
                    .update_attachment(&entry.reference, &patch, &done)?;
            }
            Err(kizunasync_transfer::TransferError::NotYetAvailable) => {
                // Queued again with the attempt charged; the code tells the app
                // the peer's bytes are still on their way.
                let done = (self.deps.now)();
                let mut waiting = kizunasync_protocol::ColumnValues::new();
                waiting.insert(
                    "state".into(),
                    Value::String(AttachmentState::Queued.as_str().into()),
                );
                waiting.insert("in_flight".into(), Value::Bool(false));
                waiting.insert("error".into(), Value::Null);
                waiting.insert(
                    "error_code".into(),
                    Value::String(ATTACHMENT_NOT_YET_AVAILABLE.into()),
                );
                self.store
                    .update_attachment(&entry.reference, &waiting, &done)?;
            }
            Err(e) => {
                let done = (self.deps.now)();
                self.record_transfer_failure(entry, &e, &done)?;
            }
        }
        Ok(())
    }
}
