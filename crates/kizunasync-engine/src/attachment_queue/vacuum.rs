use super::failure_code;
use crate::{EngineError, SyncEngine};
use kizunasync_store::{AttachmentEntry, AttachmentState};
use kizunasync_transfer::{ObjectTarget, TransferError};
use serde_json::Value;
#[cfg(not(target_arch = "wasm32"))]
use std::fs;
#[cfg(not(target_arch = "wasm32"))]
use std::path::{Component, Path};

impl SyncEngine {
    /// GC orphaned attachment objects and the sandbox files this device
    /// evicted.
    ///
    /// Each orphaned row's Storage object is removed, then its sandbox bytes
    /// and the row itself. A removal Storage refuses with 401 or 403 is not
    /// this session's to make, and one that keeps failing is retried until the
    /// attachment budget is spent: either way the row ends evicted, its bytes
    /// gone and the object left in Storage. An evicted row's cached bytes are
    /// deleted and the row kept, with no Storage call. Local files are deleted
    /// only under the attachment root. Without a token that names a user, or
    /// on a soft-blocked store, the call does nothing. It waits for the
    /// network call in flight, like every call that reaches Storage.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the orphan list, the store's owner, its
    /// soft block, or a row cannot be read or written.
    pub async fn vacuum_attachments(&self) -> Result<(), EngineError> {
        let _turn = self.network_gate().lock().await;
        if !self.attachments_reach_storage()? {
            return Ok(());
        }

        let now = (self.deps.now)();
        for entry in self.store.list_orphaned_attachments()? {
            if entry.state == AttachmentState::Evicted {
                self.evict_locally(&entry, &now)?;
                continue;
            }
            if let Some(transfer) = &self.transfer {
                let object = ObjectTarget {
                    bucket: entry.bucket.clone(),
                    path: entry.reference.clone(),
                };
                if let Err(error) = transfer.remove(&object).await {
                    if self.gives_up_on_removal(&entry, &error, &now)? {
                        self.evict_locally(&entry, &now)?;
                    }
                    continue;
                }
            }
            // Bytes are host-side on wasm: no local sandbox file to remove.
            #[cfg(not(target_arch = "wasm32"))]
            self.release_sandbox_bytes(&entry)?;
            self.store.purge_attachment(&entry.reference)?;
        }
        Ok(())
    }

    /// Whether a failed removal ends here as a local eviction: Storage refused
    /// this session, or the attempt just made spent the attachment budget.
    /// Otherwise the attempt and its failure are recorded on the row, which
    /// waits for the next vacuum.
    fn gives_up_on_removal(
        &self,
        entry: &AttachmentEntry,
        error: &TransferError,
        now: &str,
    ) -> Result<bool, EngineError> {
        let attempts = entry.attempts + 1;
        if removal_refused(error) || attempts >= self.config.attachment_attempts {
            return Ok(true);
        }

        let mut patch = kizunasync_protocol::ColumnValues::new();
        patch.insert("attempts".into(), Value::Number(attempts.into()));
        patch.insert("error".into(), Value::String(error.to_string()));
        patch.insert(
            "error_code".into(),
            Value::String(failure_code(error).into()),
        );
        self.store
            .update_attachment(&entry.reference, &patch, now)?;
        Ok(false)
    }

    /// Leave `entry` evicted with no local bytes: its cached file is deleted
    /// and its path forgotten, while the row and the hash that verifies the
    /// object again stay. Storage is not asked.
    fn evict_locally(&self, entry: &AttachmentEntry, now: &str) -> Result<(), EngineError> {
        #[cfg(not(target_arch = "wasm32"))]
        self.release_sandbox_bytes(entry)?;
        let mut evicted = kizunasync_protocol::ColumnValues::new();
        evicted.insert(
            "state".into(),
            Value::String(AttachmentState::Evicted.as_str().into()),
        );
        evicted.insert("in_flight".into(), Value::Bool(false));
        evicted.insert("local_path".into(), Value::Null);
        evicted.insert("error".into(), Value::Null);
        evicted.insert("error_code".into(), Value::Null);
        Ok(self
            .store
            .update_attachment(&entry.reference, &evicted, now)?)
    }

    /// Delete the sandbox file a row the vacuum owns cached, when it lies
    /// under the attachment root and no live row shares it. Best-effort: the
    /// row is the durable record, and a file the OS already reclaimed must not
    /// stop the row being settled.
    #[cfg(not(target_arch = "wasm32"))]
    fn release_sandbox_bytes(&self, entry: &AttachmentEntry) -> Result<(), EngineError> {
        let (Some(root), Some(local_path)) = (&self.attachment_root, &entry.local_path) else {
            return Ok(());
        };
        if !lies_under(root, Path::new(local_path)) {
            return Ok(());
        }

        let shared = self
            .store
            .count_live_attachments_at_local_path(local_path, Some(&entry.reference))?;
        if shared == 0 {
            let _ = fs::remove_file(local_path);
        }
        Ok(())
    }

    /// Whether a claimed upload's row still carries its reference. When it
    /// does not, the claim is released and the object is left alone.
    ///
    /// A row that is gone, tombstoned, or carries another reference is no
    /// evidence that the server dropped the object: the delete or the replace
    /// may still be this device's queued write, and `from_file`'s caller may
    /// not have applied the reference yet. Only server evidence, a pull or a
    /// push verdict, hands an object to the vacuum
    /// ([`SyncEngine::settle_dropped_refs`]).
    pub(super) fn claimed_upload_still_live(
        &self,
        entry: &AttachmentEntry,
        now: &str,
    ) -> Result<bool, EngineError> {
        let tombstoned = self.store.has_tombstone(&entry.table, &entry.pk)?;
        let carried = self
            .store
            .read(&entry.table, &entry.pk)?
            .filter(|_| !tombstoned)
            .is_some_and(|row| {
                row.columns.get(&entry.column).and_then(Value::as_str)
                    == Some(entry.reference.as_str())
            });
        if carried {
            return Ok(true);
        }

        let mut release = kizunasync_protocol::ColumnValues::new();
        release.insert(
            "state".into(),
            Value::String(AttachmentState::Queued.as_str().into()),
        );
        release.insert("in_flight".into(), Value::Bool(false));
        self.store
            .update_attachment(&entry.reference, &release, now)?;
        Ok(false)
    }
}

/// Whether Storage refused the removal for this session or its permissions:
/// no token, a 401, or a 403.
const fn removal_refused(error: &TransferError) -> bool {
    matches!(error, TransferError::Unauthorized) || matches!(error.status(), Some(401 | 403))
}

/// Whether `path` names an entry strictly inside `root`, judged on the path's
/// own components: a `..` anywhere below the root leaves it.
#[cfg(not(target_arch = "wasm32"))]
fn lies_under(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|inside| {
        inside.components().next().is_some()
            && inside
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
    })
}
