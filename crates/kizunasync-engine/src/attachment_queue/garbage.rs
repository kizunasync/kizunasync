//! Which objects this device hands to the vacuum for removal from Storage, and
//! which copies it only evicts.
//!
//! Server evidence makes a reference remote garbage: a pulled tombstone for the
//! row that carried it, a pulled server row that carries another one, an
//! applied push verdict for this device's write that removed or replaced it,
//! or a rejected verdict for the write that introduced it. The reference must
//! also be named by no local row and no queued write, since a queued write
//! reaches the server later and a second row may share the object, and its
//! owner segment must be the user the store belongs to: another user's object
//! is theirs to remove. Any other reference this device drops is evicted: the
//! vacuum deletes its cached bytes and never asks Storage. The host's orphan
//! call ([`SyncEngine::orphan_attachment`]) follows the same owner rule.

use crate::config::AttachmentSpec;
use crate::{EngineError, SyncEngine};
use kizunasync_protocol::{ColumnValues, Op};
use kizunasync_store::OutboxEntry;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

impl SyncEngine {
    /// Settle the references this device dropped. Each one in `evidence`
    /// that is this user's is orphaned for the vacuum and any other is
    /// evicted; each one in `left`, which only left this device, is evicted.
    /// A reference a local row or a queued write still names is kept.
    ///
    /// Runs inside the transaction that dropped them, after the queued writes
    /// were replayed over the rows it replaced, so a reference a queued write
    /// carries still counts as named.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the rows, the queued writes, or the owner
    /// cannot be read, or a queue row cannot be written.
    pub(crate) fn settle_dropped_refs(
        &self,
        evidence: &BTreeSet<String>,
        left: &BTreeSet<String>,
        now: &str,
    ) -> Result<(), EngineError> {
        if evidence.is_empty() && left.is_empty() {
            return Ok(());
        }
        let subject = self.owner_subject()?;
        let named = self.named_attachments()?;

        for reference in evidence.difference(&named) {
            self.orphan_or_evict(subject.as_deref(), reference, now)?;
        }
        for reference in left.difference(&named) {
            self.store.mark_attachment_evicted(reference, now)?;
        }
        Ok(())
    }

    /// Orphan `reference` for the vacuum when its owner segment is `subject`,
    /// the user the store belongs to, and evict it otherwise: another user's
    /// object is theirs to remove, and a store that records no user owns none.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the queue row cannot be written.
    pub(super) fn orphan_or_evict(
        &self,
        subject: Option<&str>,
        reference: &str,
        now: &str,
    ) -> Result<(), EngineError> {
        if subject == Some(owner_segment(reference)) {
            self.store.mark_attachment_orphaned(reference, now)?;
        } else {
            self.store.mark_attachment_evicted(reference, now)?;
        }
        Ok(())
    }

    /// Add to `dropped` every reference the pre-image of an applied write
    /// held that the write took off its row: all of them for a delete, and
    /// each one a written column replaced for an insert or an update.
    pub(crate) fn refs_an_applied_write_dropped(
        &self,
        entry: &OutboxEntry,
        dropped: &mut BTreeSet<String>,
    ) {
        let (Some(specs), Some(pre_image)) =
            (self.attachment_specs(&entry.table), &entry.pre_image)
        else {
            return;
        };
        for column in specs.keys() {
            let Some(previous) = pre_image.get(column).and_then(Value::as_str) else {
                continue;
            };
            let replaced = match entry.op {
                Op::Delete => true,
                Op::Insert | Op::Update => entry
                    .columns
                    .get(column)
                    .is_some_and(|written| written.as_str() != Some(previous)),
            };
            if replaced {
                dropped.insert(previous.to_owned());
            }
        }
    }

    /// Add to `dropped` every reference a rejected write carried that the
    /// server row it was answered with does not.
    pub(crate) fn refs_a_rejected_write_introduced(
        &self,
        entry: &OutboxEntry,
        server_row: Option<&ColumnValues>,
        dropped: &mut BTreeSet<String>,
    ) {
        let Some(specs) = self.attachment_specs(&entry.table) else {
            return;
        };
        if entry.op == Op::Delete {
            return;
        }

        let mut kept = BTreeSet::new();
        if let Some(server_row) = server_row {
            name_refs(server_row, specs, &mut kept);
        }
        let mut carried = BTreeSet::new();
        name_refs(&entry.columns, specs, &mut carried);
        dropped.extend(carried.difference(&kept).cloned());
    }

    /// Every reference a live local row or a queued write names in an
    /// attachment column. A queued write names the references of its columns
    /// and of its pre-image, the row it replaces until the server answers.
    fn named_attachments(&self) -> Result<BTreeSet<String>, EngineError> {
        let mut named = BTreeSet::new();
        for (table, config) in &self.config.tables {
            if config.attachments.is_empty() {
                continue;
            }
            for row in self.store.read_all(table)? {
                name_refs(&row.columns, &config.attachments, &mut named);
            }
        }

        for entry in self.store.list_outbox(usize::MAX)? {
            let Some(specs) = self.attachment_specs(&entry.table) else {
                continue;
            };
            name_refs(&entry.columns, specs, &mut named);
            if let Some(pre_image) = &entry.pre_image {
                name_refs(pre_image, specs, &mut named);
            }
        }
        Ok(named)
    }
}

/// Add the reference each attachment column of `columns` holds to `named`.
pub(crate) fn name_refs(
    columns: &ColumnValues,
    specs: &BTreeMap<String, AttachmentSpec>,
    named: &mut BTreeSet<String>,
) {
    named.extend(
        specs
            .keys()
            .filter_map(|column| columns.get(column).and_then(Value::as_str))
            .map(str::to_owned),
    );
}

/// The first path segment of a reference: the owner an import names its
/// object after (`owner/pk/upload.ext`).
fn owner_segment(reference: &str) -> &str {
    reference.split('/').next().unwrap_or_default()
}
