//! Push: candidate selection, `push_once`, and verdict/abort reconciliation.

use super::{
    MALFORMED_PUSH_RESPONSE, SyncEngine, UNKNOWN_BATCH_OFFENDER, UNKNOWN_SIGNAL,
    UNKNOWN_VERDICT_REASON, VERDICT_BIJECTION,
};
use crate::config::{EngineEvent, SoftBlockReason};
use crate::error::EngineError;
use kizunasync_protocol::{
    ColumnValues, Mutation, PushBatch, PushRequest, RejectReason, SignalType, Verdict,
    WireBatchOutcome, WireVerdictKind, parse_wire_member,
};
use kizunasync_store::{RejectionKind, RejectionRecord};
use std::collections::BTreeSet;

/// How many queued entries one push scans when the head is un-batched. A
/// batched head is read WHOLE instead (see [`SyncEngine::push_candidates`]), so
/// this bound can never cut an atomic group in half.
const PUSH_SCAN_LIMIT: usize = 500;

impl SyncEngine {
    /// The entries one push may consume: never truncated inside an atomic batch.
    ///
    /// A batched head is re-read as its WHOLE consecutive run
    /// ([`LocalStore::list_outbox_batch_run`]): the bounded scan would split a
    /// group larger than [`PUSH_SCAN_LIMIT`] across two `atomic:true` requests,
    /// which would not be all-or-nothing (P:verdict-completeness-transforms-and-conflict-rejection / D-atomic-batch-abort) and would dead-letter
    /// only part of a doomed batch. An un-batched head keeps the bounded slice:
    /// [`select_push_entries`] stops it at the first batched entry anyway, so a
    /// following batch still rides its own push intact.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::Store`] when the outbox cannot be read.
    pub(crate) fn push_candidates(
        &self,
    ) -> Result<Vec<kizunasync_store::OutboxEntry>, EngineError> {
        let head_slice = self.store.list_outbox(PUSH_SCAN_LIMIT)?;
        let Some(head) = head_slice.first() else {
            return Ok(head_slice);
        };
        let Some(batch_id) = head.batch_id.as_deref() else {
            return Ok(head_slice);
        };
        Ok(self.store.list_outbox_batch_run(head.seq, batch_id)?)
    }

    /// One push request/response cycle: send the current batched head (or
    /// bounded scan) and reconcile the verdict against the store.
    ///
    /// Exactly one round per call, and no loop: draining the queue is
    /// [`Self::sync_push`], which repeats this call under its own
    /// `MAX_PUSH_ROUNDS` bound. A caller driving `push_once` itself owns that
    /// bound.
    ///
    /// Waits for the network call in flight, like every call that reaches the
    /// network.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when the remote call fails or the reply is
    /// malformed.
    pub async fn push_once(&self) -> Result<(), EngineError> {
        let _turn = self.network.lock().await;
        // A soft-blocked client makes no further RPC (lifecycle/002).
        if self.blocks_network()? {
            return Ok(());
        }

        let outbox = self.push_candidates()?;
        let (entries, atomic) = select_push_entries(&outbox);
        self.push_entries(entries, atomic).await
    }

    /// Send exactly `entries` as one push and reconcile the reply. `atomic` is
    /// what [`select_push_entries`] answered for the run `entries` comes from,
    /// so only an atomic batch is ever reconciled as an abort.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when the remote call fails or the reply is
    /// malformed.
    pub(super) async fn push_entries(
        &self,
        entries: &[kizunasync_store::OutboxEntry],
        atomic: bool,
    ) -> Result<(), EngineError> {
        if entries.is_empty() {
            return Ok(());
        }

        let mut mutations: Vec<Mutation> = Vec::with_capacity(entries.len());
        for entry in entries {
            mutations.push(Mutation {
                mutation_id: entry.mutation_id.clone(),
                table: entry.table.clone(),
                pk: entry.pk.clone(),
                op: entry.op,
                columns: entry.columns.clone(),
                precondition: entry.precondition.clone(),
                hlc: entry.hlc.clone(),
                transforms: entry.transforms.clone(),
            });
        }
        let req = PushRequest {
            client_id: Some(self.client_id()?),
            schema_version: self.config.schema_version,
            batch: PushBatch { atomic, mutations },
            // The exactly-once watermark: the last mutation the server told us it
            // applied, so a retried batch is deduplicated server-side instead of
            // applied twice (`request-build.ts` sends the same field).
            last_mutation_id: self.store.last_mutation_id()?,
        };

        let resp = self.remote.push(req).await?;
        if let Some(signal) = &resp.signal {
            match parse_wire_member::<SignalType>(&signal.signal_type) {
                Some(SignalType::ResetRequired) => {
                    // Schema handshake refused the push: soft-block, leave the outbox
                    // and the cursor untouched (the queued write is not at fault).
                    let announcement = self
                        .store
                        .transaction(|| self.latch_soft_block(SoftBlockReason::ResetRequired))?;
                    self.emit(&announcement);
                    return Ok(());
                }
                Some(SignalType::CheckpointExpired) | None => {
                    return Err(EngineError::protocol(
                        UNKNOWN_SIGNAL,
                        format!("unknown push signal \"{}\"", signal.signal_type),
                    ));
                }
            }
        }
        if let Some(batch) = &resp.batch {
            return self.reconcile_abort(entries, batch, atomic);
        }
        let Some(verdicts) = &resp.verdicts else {
            return Err(EngineError::protocol(
                MALFORMED_PUSH_RESPONSE,
                "push response carries neither verdicts nor a batch outcome",
            ));
        };
        self.reconcile_verdicts(verdicts, entries)
    }

    /// Reconcile an atomic-batch abort (P:verdict-completeness-transforms-and-conflict-rejection / D-atomic-batch-abort): the server reverted the whole
    /// batch, so the client mirrors that by reverting every sent member: the
    /// offender to the abort's authoritative `server_row`, every other member to
    /// its own captured pre-image (the abort names only the offender). Reverting
    /// last-applied first makes two members on the SAME pk settle on the pre-batch
    /// state. One journal row and one `BATCH_ABORTED` event: the member reverts are
    /// consequences of the offender's verdict, not verdicts of their own.
    ///
    /// Every guard runs BEFORE the first store write, so a malformed abort never
    /// clears writes the server may still hold. The reverts wipe the effect of
    /// writes queued behind the batch, so the same transaction ends with the
    /// D-outbox-rebase overlay over the reverted rows.
    fn reconcile_abort(
        &self,
        entries: &[kizunasync_store::OutboxEntry],
        abort: &kizunasync_protocol::BatchOutcome,
        request_atomic: bool,
    ) -> Result<(), EngineError> {
        if !request_atomic {
            return Err(EngineError::protocol(
                MALFORMED_PUSH_RESPONSE,
                "push answered a non-atomic request with a batch abort \
                 (P:verdict-completeness-transforms-and-conflict-rejection: only atomic:true batches abort)",
            ));
        }
        if parse_wire_member::<WireBatchOutcome>(&abort.outcome) != Some(WireBatchOutcome::Aborted)
        {
            return Err(EngineError::protocol(
                MALFORMED_PUSH_RESPONSE,
                format!(
                    "push batch abort carries an unknown outcome \"{}\" (P:verdict-completeness-transforms-and-conflict-rejection closed union)",
                    abort.outcome
                ),
            ));
        }
        let reason = abort.reason.as_deref().unwrap_or_default();
        if parse_wire_member::<RejectReason>(reason).is_none() {
            return Err(EngineError::protocol(
                UNKNOWN_VERDICT_REASON,
                format!(
                    "push batch abort carries an unknown reject reason \"{reason}\" \
                     (D-rejection-reasons closed union)"
                ),
            ));
        }
        let offender_id = abort.offender_mutation_id.as_deref().unwrap_or_default();
        let Some(offender) = entries.iter().find(|e| e.mutation_id == offender_id) else {
            return Err(EngineError::protocol(
                UNKNOWN_BATCH_OFFENDER,
                format!(
                    "push batch abort's offender_mutation_id \"{offender_id}\" is not a member \
                     of the sent batch (D-atomic-batch-abort)"
                ),
            ));
        };

        // ONE transaction for the whole batch, for the same reason the verdict path
        // needs one: a member revert that lands while its outbox entry survives
        // would be replayed by the next push.
        let now = (self.deps.now)();
        self.store.transaction(|| {
            let mut reset = BTreeSet::new();
            for entry in entries.iter().rev() {
                let target = if entry.mutation_id == offender_id {
                    abort.server_row.as_ref()
                } else {
                    entry.pre_image.as_ref()
                };
                self.revert_row_to(&entry.table, &entry.pk, target)?;
                reset.insert((entry.table.clone(), entry.pk.clone()));
            }
            self.journal_rejection(
                offender,
                RejectionKind::BatchAborted,
                reason,
                abort.server_row.as_ref(),
            )?;
            let clear: Vec<String> = entries.iter().map(|e| e.mutation_id.clone()).collect();
            self.store.clear_outbox_ids(&clear)?;
            self.store.overlay_pending(&reset, &now)?;
            Ok::<(), EngineError>(())
        })?;
        self.emit(&EngineEvent::BatchAborted {
            offender_mutation_id: offender.mutation_id.clone(),
            reason: reason.to_string(),
        });
        self.emit(&EngineEvent::LocalChanged);
        Ok(())
    }

    /// Reconcile per-mutation verdicts IN REQUEST ORDER.
    ///
    /// I-5 bijection: exactly one verdict per sent mutation, same order AND same
    /// `mutation_id`. Both the bijection and the closed unions are checked over the
    /// WHOLE reply before anything is written, so a malformed reply never even
    /// opens a transaction; the writes that follow are then ONE transaction, so a
    /// store fault halfway leaves nothing half-applied either.
    fn reconcile_verdicts(
        &self,
        verdicts: &[Verdict],
        entries: &[kizunasync_store::OutboxEntry],
    ) -> Result<(), EngineError> {
        check_verdicts(verdicts, entries)?;

        // ONE transaction for the whole batch: a store fault at verdict N must not
        // leave the reverts, the watermark and the journal of verdicts 0..N behind
        // with their outbox entries still queued: the next push would replay
        // writes that were already compensated.
        let rejected = self
            .store
            .transaction(|| self.write_verdicts(verdicts, entries))?;

        // Announced only once the batch is durable: an event for a rolled-back
        // revert would tell the app about a loss that did not happen.
        for (mutation_id, reason) in rejected {
            self.emit(&EngineEvent::MutationRejected {
                mutation_id,
                reason,
            });
        }

        self.emit(&EngineEvent::LocalChanged);
        Ok(())
    }

    /// The verdicts' store writes, in request order, answering the rejected
    /// `(mutation_id, reason)` pairs. Runs inside [`Self::reconcile_verdicts`]'s
    /// transaction: never call it outside one.
    ///
    /// A server row installed by an applied verdict and a compensating revert
    /// both reset their row, wiping any queued write on it, so the batch ends
    /// with the D-outbox-rebase overlay over every reset row. A write the
    /// server applied without returning its row is laid back only when an
    /// EARLIER verdict of this batch reset that row: a server row that resets
    /// it later in the batch was rendered with the write already applied.
    ///
    /// Every applied write is remembered as pushed, so a later pull does not
    /// journal a conflict this device's own write won
    /// (D-conflict-journal-visibility).
    ///
    /// The verdicts are server evidence for the attachment refs they settle:
    /// the refs an applied write removed or replaced, and the refs a rejected
    /// write introduced that its server row does not carry
    /// ([`SyncEngine::settle_dropped_refs`]).
    fn write_verdicts(
        &self,
        verdicts: &[Verdict],
        entries: &[kizunasync_store::OutboxEntry],
    ) -> Result<Vec<(String, String)>, EngineError> {
        let now = (self.deps.now)();
        let mut reset = BTreeSet::new();
        let mut rejected = Vec::new();
        let mut applied = Vec::new();
        let mut dropped = BTreeSet::new();
        for (verdict, entry) in verdicts.iter().zip(entries) {
            let row = (entry.table.clone(), entry.pk.clone());
            if verdict.verdict == "applied" {
                self.refs_an_applied_write_dropped(entry, &mut dropped);
                match &verdict.server_row {
                    Some(server_row) => {
                        self.store
                            .put_server_row(&entry.table, &entry.pk, server_row, "0")?;
                        reset.insert(row);
                    }
                    None if reset.contains(&row) => {
                        self.store.overlay_entry(entry, &reset, &now)?;
                    }
                    None => {}
                }
                self.store.set_last_mutation_id(&entry.mutation_id)?;
                applied.push(entry.mutation_id.as_str());
                continue;
            }
            let reason = verdict.reason.as_deref().unwrap_or_default();
            self.refs_a_rejected_write_introduced(entry, verdict.server_row.as_ref(), &mut dropped);
            // Compensating revert (P:verdict-completeness-transforms-and-conflict-rejection): a server_row map ⇒ set the local row;
            // null ⇒ the row is invoker-invisible or deleted ⇒ delete + shadow.
            self.revert_row_to(&entry.table, &entry.pk, verdict.server_row.as_ref())?;
            reset.insert(row);
            let kind = if reason == "SUPERSEDED" {
                RejectionKind::Superseded
            } else {
                RejectionKind::Rejected
            };
            self.journal_rejection(entry, kind, reason, verdict.server_row.as_ref())?;
            rejected.push((entry.mutation_id.clone(), reason.to_string()));
        }

        self.store.record_pushed(&applied, &now)?;
        let clear: Vec<String> = entries.iter().map(|e| e.mutation_id.clone()).collect();
        self.store.clear_outbox_ids(&clear)?;
        self.store.overlay_pending(&reset, &now)?;
        self.settle_dropped_refs(&dropped, &BTreeSet::new(), &now)?;
        Ok(rejected)
    }

    /// The single compensating-revert primitive (P:verdict-completeness-transforms-and-conflict-rejection): install `target` as the
    /// local row, or delete it + write the no-resurrection shadow when there is no
    /// target.
    fn revert_row_to(
        &self,
        table: &str,
        pk: &str,
        target: Option<&ColumnValues>,
    ) -> Result<(), EngineError> {
        match target {
            None => self.store.revert_row(table, pk, None)?,
            Some(row) => {
                self.store.put_server_row(table, pk, row, "0")?;
            }
        }
        Ok(())
    }

    /// Durable trace of a lost write. `MUTATION_REJECTED` / `BATCH_ABORTED` are
    /// fire-and-forget, so the journal row is what an app reads afterwards to
    /// explain the loss.
    fn journal_rejection(
        &self,
        entry: &kizunasync_store::OutboxEntry,
        kind: RejectionKind,
        reason: &str,
        server_row: Option<&ColumnValues>,
    ) -> Result<(), EngineError> {
        self.store.insert_rejection(&RejectionRecord {
            mutation_id: entry.mutation_id.clone(),
            table: entry.table.clone(),
            pk: entry.pk.clone(),
            kind,
            reason: reason.to_string(),
            changed_columns: entry.columns.keys().cloned().collect(),
            server_row: server_row.cloned(),
            at: (self.deps.now_millis)(),
            dismissed: false,
        })?;
        Ok(())
    }
}

/// The I-5 bijection and the closed unions of a verdict reply, checked over the
/// WHOLE reply before anything is written.
fn check_verdicts(
    verdicts: &[Verdict],
    entries: &[kizunasync_store::OutboxEntry],
) -> Result<(), EngineError> {
    if verdicts.len() != entries.len() {
        return Err(EngineError::protocol(
            VERDICT_BIJECTION,
            format!(
                "push returned {} verdicts for {} mutations (I-5)",
                verdicts.len(),
                entries.len()
            ),
        ));
    }
    for (index, (verdict, entry)) in verdicts.iter().zip(entries).enumerate() {
        if verdict.mutation_id != entry.mutation_id {
            return Err(EngineError::protocol(
                VERDICT_BIJECTION,
                format!(
                    "push verdict {index} mutation_id \"{}\" != outbox \"{}\" \
                     (I-5 bijection broken)",
                    verdict.mutation_id, entry.mutation_id
                ),
            ));
        }
        match parse_wire_member::<WireVerdictKind>(verdict.verdict.as_str()) {
            Some(WireVerdictKind::Applied) => {}
            Some(WireVerdictKind::Rejected) => {
                let reason = verdict.reason.as_deref().unwrap_or_default();
                if parse_wire_member::<RejectReason>(reason).is_none() {
                    return Err(EngineError::protocol(
                        UNKNOWN_VERDICT_REASON,
                        format!(
                            "push verdict carries an unknown reject reason \"{reason}\" \
                             (D-rejection-reasons closed union)"
                        ),
                    ));
                }
            }
            None => {
                return Err(EngineError::protocol(
                    UNKNOWN_VERDICT_REASON,
                    format!(
                        "push verdict carries an unknown verdict kind \"{}\"",
                        verdict.verdict
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// The outbox entries ONE `push_once` sends, plus whether they form an atomic
/// batch.
///
/// When the FIFO head carries a `batch_id`, the push is exactly the maximal
/// CONSECUTIVE run sharing it (one all-or-nothing group, P:verdict-completeness-transforms-and-conflict-rejection / D-atomic-batch-abort). When the
/// head is un-batched, the push is the leading run of un-batched entries and
/// STOPS at the first batched one, so a following atomic batch rides its own push
/// intact. With no batch in the outbox this is the whole outbox, non-atomic.
pub(super) fn select_push_entries(
    entries: &[kizunasync_store::OutboxEntry],
) -> (&[kizunasync_store::OutboxEntry], bool) {
    let Some(head) = entries.first() else {
        return (entries, false);
    };
    let end = entries
        .iter()
        .position(|entry| entry.batch_id != head.batch_id)
        .unwrap_or(entries.len());
    (&entries[..end], head.batch_id.is_some())
}
