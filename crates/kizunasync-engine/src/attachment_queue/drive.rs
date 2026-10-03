use super::{AttachmentBytes, failure_code};
use crate::{EngineError, SyncEngine};
use kizunasync_store::{AttachmentEntry, AttachmentFailure, AttachmentState};
use kizunasync_transfer::{
    ConfirmMeta, ObjectTarget, Transfer, UploadTarget, sha256_hex, upload_with_policy,
};
use std::sync::Arc;

impl SyncEngine {
    /// Drive pending uploads through the transfer port with durable resume state.
    ///
    /// A transfer that fails settles into the row (`failed`, with the error text)
    /// rather than out of this call, so one bad job never halts the queue. A
    /// transfer Storage refuses for its session releases the claim without
    /// charging the attempt. Without a token that names a user, or on a
    /// soft-blocked store, nothing is claimed and the call answers 0.
    ///
    /// # Errors
    /// `ATTACHMENT_PORTS_MISSING` when no transfer port is attached, and
    /// [`EngineError::Store`] when the queue cannot be claimed or updated.
    pub async fn drive_attachment_queue(
        &self,
        bytes: Arc<dyn AttachmentBytes>,
        limit: usize,
    ) -> Result<usize, EngineError> {
        let transfer = self
            .transfer
            .as_ref()
            .ok_or(EngineError::AttachmentPortsMissing)?;
        if !self.attachments_reach_storage()? {
            return Ok(0);
        }

        let pending = self.store.list_pending_attachments("upload", limit)?;
        let mut completed = 0usize;
        for entry in pending {
            let now = (self.deps.now)();
            if !self.claim_for_drive(&entry.reference, AttachmentState::Uploading, &now)? {
                continue;
            }

            if !self.claimed_upload_still_live(&entry, &now)? {
                continue;
            }
            if self
                .drive_claimed_upload(transfer.as_ref(), bytes.as_ref(), &entry)
                .await?
            {
                completed += 1;
            }
        }
        Ok(completed)
    }

    // One claimed upload is one linear transaction: read the bytes, send them,
    // confirm them, and record what each step left durable. Splitting it would
    // hand the pieces the same locals back as arguments.
    #[expect(clippy::too_many_lines)]
    async fn drive_claimed_upload(
        &self,
        transfer: &dyn Transfer,
        bytes: &dyn AttachmentBytes,
        entry: &AttachmentEntry,
    ) -> Result<bool, EngineError> {
        let now = (self.deps.now)();
        let Some(local_path) = entry.local_path.clone() else {
            self.record_local_failure(&entry.reference, "missing sandbox bytes", &now)?;
            return Ok(false);
        };

        let payload = match bytes.read_local(&local_path) {
            Ok(b) => b,
            Err(e) => {
                let code = match &e {
                    EngineError::Transfer(error) => failure_code(error).to_string(),
                    other => other.code(),
                };
                self.store.update_attachment_state(
                    &entry.reference,
                    AttachmentState::Failed,
                    false,
                    Some(AttachmentFailure {
                        message: &e.to_string(),
                        code: &code,
                    }),
                    &now,
                )?;
                return Ok(false);
            }
        };

        let target = UploadTarget {
            bucket: entry.bucket.clone(),
            path: entry.reference.clone(),
            content_type: entry
                .content_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".into()),
        };
        let start = u64::try_from(entry.chunk_offset).unwrap_or(0);
        let tus = entry.tus_url.clone();

        match upload_with_policy(transfer, &target, &payload, start, tus).await {
            Ok(progress) => {
                let done_now = (self.deps.now)();
                let uploaded = i64::try_from(progress.bytes_uploaded).unwrap_or(i64::MAX);
                // The claim survives this write: the bytes are up but nothing is
                // durable until `confirm` settles, so a kill in that window must
                // still be a row crash recovery can see.
                self.store.upsert_attachment_progress(
                    &entry.reference,
                    uploaded,
                    uploaded,
                    progress.tus_url.as_deref(),
                    AttachmentState::Uploading,
                    true,
                    &done_now,
                )?;

                let sha256 = entry.sha256.clone().unwrap_or_else(|| sha256_hex(&payload));
                let content_type = entry
                    .content_type
                    .clone()
                    .unwrap_or_else(|| "application/octet-stream".into());
                // A row that never recorded a positive size confirms the length
                // of the bytes actually sent, never 0.
                let size = entry
                    .size
                    .filter(|declared| *declared > 0)
                    .and_then(|declared| u64::try_from(declared).ok())
                    .unwrap_or(payload.len() as u64);
                let object = ObjectTarget {
                    bucket: entry.bucket.clone(),
                    path: entry.reference.clone(),
                };
                let meta = ConfirmMeta {
                    sha256,
                    size,
                    content_type,
                };

                match transfer.confirm(&object, &meta, &entry.table).await {
                    Ok(()) => {
                        self.store.upsert_attachment_progress(
                            &entry.reference,
                            uploaded,
                            uploaded,
                            progress.tus_url.as_deref(),
                            AttachmentState::Synced,
                            false,
                            &done_now,
                        )?;
                        Ok(true)
                    }
                    Err(e) => {
                        self.record_transfer_failure(entry, &e, &done_now)?;
                        Ok(false)
                    }
                }
            }
            Err(e) => {
                let fail_now = (self.deps.now)();
                // Persist the interrupted transfer's own resume state: the offset
                // the server confirmed and its live session URL. A `None` URL
                // leaves the stored one in place (the SQL COALESCE), so a fresh
                // session is never invented for a row that already has one.
                if let kizunasync_transfer::TransferError::Interrupted { offset, tus_url } = &e {
                    let at = i64::try_from(*offset).unwrap_or(i64::MAX);
                    self.store.upsert_attachment_progress(
                        &entry.reference,
                        at,
                        at,
                        tus_url.as_deref(),
                        AttachmentState::Failed,
                        false,
                        &fail_now,
                    )?;
                } else {
                    self.record_transfer_failure(entry, &e, &fail_now)?;
                }
                Ok(false)
            }
        }
    }
}
