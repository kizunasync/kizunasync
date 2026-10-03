//! Pull: `pull_once`, page staging, and the atomic checkpoint commit.

use super::{PAGE_CURSOR_KEY, SyncEngine, UNKNOWN_SIGNAL};
use crate::attachment_queue::name_refs;
use crate::config::{EngineEvent, SoftBlockReason};
use crate::error::EngineError;
use kizunasync_protocol::{
    Bucket, Conflict, PullRequest, PullResponse, RowChange, SignalType, parse_wire_member,
};
use kizunasync_store::NewOverwrite;
use std::collections::BTreeSet;

impl SyncEngine {
    /// One pull request/response cycle: single-page apply, or one page of a
    /// multi-page checkpoint staged toward [`Self`]'s atomic commit.
    ///
    /// Exactly one page per call, and no loop: draining a multi-page sequence is
    /// [`Self::sync_pull`], which repeats this call under its own `MAX_PULL_PAGES`
    /// bound. A caller driving `pull_once` itself owns that bound.
    ///
    /// A `bucket_owner` table whose bucket value is unset gets the store owner
    /// before the request is built, when the store has recorded one.
    ///
    /// Waits for the network call in flight, like every call that reaches the
    /// network. When [`Self::set_bucket_params`] replaces the scope while the
    /// request awaits the remote, the answer commits nothing: no page is
    /// staged, the cursor does not move, and the next pull re-bootstraps under
    /// the new scope.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when the remote call fails, the server signal
    /// is unrecognized, or staged pull state is corrupt.
    pub async fn pull_once(&self) -> Result<(), EngineError> {
        let _turn = self.network.lock().await;
        self.pull_page().await
    }

    /// [`Self::pull_once`] for a caller that already holds the network gate.
    pub(super) async fn pull_page(&self) -> Result<(), EngineError> {
        // A soft-blocked client makes no further RPC (lifecycle/002).
        if self.blocks_network()? {
            return Ok(());
        }

        self.fill_unset_owner_buckets()?;
        let (buckets, generation) = self.pull_buckets()?;
        // The in-progress keyset position (mid-pagination or mid-rehydration) wins
        // over the durable checkpoint.
        let cursor = match self.page_cursor()? {
            Some(page) => page,
            None => self.store.get_cursor()?,
        };
        let req = PullRequest {
            client_id: Some(self.client_id()?),
            schema_version: self.config.schema_version,
            cursor,
            limit: self.config.default_limit,
            buckets,
        };

        let answer = self.remote.pull(req).await;
        if self.with_buckets(|routing| routing.generation) != generation {
            // The scope was replaced while the request was out, and its arm
            // already dropped the staged pages and restarted the sequence from
            // "0": the old scope's answer is neither staged nor committed, and
            // a failure must not clear the restart either.
            return answer.map(drop);
        }
        let resp = match answer {
            Ok(resp) => resp,
            Err(err) => {
                // A transport (or any remote) fault mid-sequence must abandon
                // the keyset, same as `pullOnce` in pull-loop.ts: the next poll
                // resumes from the durable checkpoint, not the mid-flight
                // cursor (fencing/001, D-visibility-horizon).
                self.store.transaction(|| {
                    self.store.clear_pull_pages()?;
                    self.clear_pagination_state()
                })?;
                return Err(err);
            }
        };
        // I-8: a non-null signal rides an EMPTY page, so a signalled response never
        // applies rows and never advances the durable cursor. RESET_REQUIRED latches
        // the soft block; CHECKPOINT_EXPIRED restarts the keyset from '0' and marks
        // the sequence a re-hydration; anything else fails loud (no silent
        // fallback).
        if let Some(signal) = &resp.signal {
            match parse_wire_member::<SignalType>(&signal.signal_type) {
                Some(SignalType::ResetRequired) => {
                    // ONE transaction, for the same reason the checkpoint boundary
                    // is one: the staging drop, the end of the pagination sequence
                    // and the latch are a single state change, and a fault between
                    // them would soft-block a client whose keyset position still
                    // says a sequence is running.
                    let announcement = self.store.transaction(|| {
                        self.store.clear_pull_pages()?;
                        self.clear_pagination_state()?;
                        self.latch_soft_block(SoftBlockReason::ResetRequired)
                    })?;
                    self.emit(&announcement);
                }
                Some(SignalType::CheckpointExpired) => {
                    // Token invalidated: drop staged work and re-hydrate from '0' on
                    // the NEXT pull_once, whose boundary REPLACES local state.
                    self.store.transaction(|| self.arm_rehydration())?;
                    self.emit(&EngineEvent::CheckpointExpired);
                }
                None => {
                    return Err(EngineError::protocol(
                        UNKNOWN_SIGNAL,
                        format!("unknown pull signal \"{}\"", signal.signal_type),
                    ));
                }
            }
            return Ok(());
        }

        // Multi-page: stage pages until has_more is false (atomic checkpoint).
        // Staging is one row per page in `_kizunasync_pull_pages`, so each page is a
        // single insert instead of a read-modify-write of a growing blob. A
        // non-empty outbox does not withhold the page (D-outbox-rebase): the boundary
        // commits, then FIFO-replays pending mutations over the snapshot.
        self.stage_pull_page(&resp)?;
        if resp.has_more {
            // Do not apply or advance the cursor yet; only the keyset moves on.
            self.meta_set(PAGE_CURSOR_KEY, &resp.cursor)?;
            return Ok(());
        }
        let rehydrating = self.is_rehydrating()?;
        self.commit_staged_pull(rehydrating)
    }

    /// The buckets the next pull names, one per configured table, and the
    /// generation of the scope they select.
    ///
    /// An EMPTY parameter map is a global/shared table (no `bucket()` in
    /// config): it matches every row RLS permits, and pulling it is legal. Only
    /// an empty VALUE is an unset bucket someone forgot to fill. Bucket order
    /// follows the config key order and is therefore deterministic, but it is
    /// not a wire contract: the server treats the list as a set.
    fn pull_buckets(&self) -> Result<(Vec<Bucket>, u64), EngineError> {
        self.with_buckets(|routing| {
            let mut buckets = Vec::with_capacity(routing.params.len());
            for (table, params) in &routing.params {
                if params.values().any(|value| value.as_str() == Some("")) {
                    return Err(EngineError::BucketUnset);
                }
                buckets.push(Bucket {
                    table: table.clone(),
                    params: params.clone(),
                });
            }
            Ok((buckets, routing.generation))
        })
    }

    /// The pages staged so far, oldest first, or an error when a page's body
    /// is corrupt.
    ///
    /// An absent page set decodes to an empty list: [`LocalStore::list_pull_pages`]
    /// answers with no rows before the first page is staged, which is the
    /// legitimate state at the start of every sequence. A row that fails to
    /// decode is corruption and fails loud: swallowing it would drop the page
    /// it belongs to (and every page ordered after it) and let the sequence
    /// commit a cursor covering rows the mirror never got.
    fn read_staged_pages(&self) -> Result<Vec<PullResponse>, EngineError> {
        self.store
            .list_pull_pages()?
            .iter()
            .map(|body| serde_json::from_str(body).map_err(EngineError::from))
            .collect()
    }

    fn stage_pull_page(&self, resp: &PullResponse) -> Result<(), EngineError> {
        self.store.insert_pull_page(&serde_json::to_string(resp)?)?;
        Ok(())
    }

    /// Commit the staged checkpoint. `rehydrating` makes it a snapshot REPLACE:
    /// locally-retained rows the fresh snapshot omits are dropped, because
    /// their tombstones were reaped along with the expired checkpoint.
    ///
    /// ONE transaction: the rehydration drops, the applied rows, the
    /// tombstones, the durable cursor and the staging clear are one
    /// checkpoint, so a fault halfway can never leave the mirror holding part
    /// of a page under a cursor that claims the whole page (P:session-guarantees-and-exactly-once-effect item 2,
    /// no-intermediate-commit).
    fn commit_staged_pull(&self, rehydrating: bool) -> Result<(), EngineError> {
        let staged: Vec<PullResponse> = self.read_staged_pages()?;
        let conflicts = self
            .store
            .transaction(|| self.commit_staged_rows(&staged, rehydrating))?;
        self.emit(&EngineEvent::LocalChanged);
        for conflict in conflicts {
            self.emit(&EngineEvent::ColumnOverwritten {
                table: conflict.table,
                pk: conflict.pk,
                column: conflict.column_name,
                loser_value: conflict.loser_value,
                winner_mutation_id: conflict.winner_mutation_id,
                conflict_mode: conflict.conflict_mode,
            });
        }
        Ok(())
    }

    /// The staged checkpoint's writes, answering the conflicts it journalled.
    /// Runs inside [`commit_staged_pull`]'s transaction: never call it outside
    /// one.
    fn commit_staged_rows(
        &self,
        staged: &[PullResponse],
        rehydrating: bool,
    ) -> Result<Vec<Conflict>, EngineError> {
        let now = (self.deps.now)();
        let mut final_cursor = self.store.get_cursor()?;

        // Pks whose committed snapshot this page replaced: the D-outbox-rebase
        // overlay replays queued writes onto those rows only.
        let mut reset: BTreeSet<(String, String)> = BTreeSet::new();
        // Attachment refs a pulled tombstone or server row took off a row.
        let mut dropped: BTreeSet<String> = BTreeSet::new();
        // Attachment refs of rows that only left this device.
        let mut left: BTreeSet<String> = BTreeSet::new();

        if rehydrating {
            self.drop_rows_the_snapshot_omits(staged, &mut reset, &mut left)?;
        }

        for resp in staged {
            self.apply_staged_page(resp, &now, &mut reset, &mut dropped)?;
            final_cursor.clone_from(&resp.cursor);
        }

        let conflicts = self.close_checkpoint(&final_cursor, staged)?;
        self.store.overlay_pending(&reset, &now)?;
        self.settle_dropped_refs(&dropped, &left, &now)?;
        Ok(conflicts)
    }

    /// The rehydration drop: every row of a configured table that the fresh
    /// snapshot does not carry leaves the mirror, and its pk joins `reset`.
    /// The row may only have left this device's scope, so the attachment
    /// refs it held join `left`: evicted, never garbage evidence.
    fn drop_rows_the_snapshot_omits(
        &self,
        staged: &[PullResponse],
        reset: &mut BTreeSet<(String, String)>,
        left: &mut BTreeSet<String>,
    ) -> Result<(), EngineError> {
        let survivors = snapshot_survivors(staged);

        // Only the configured (pulled) tables are touched: never wipe an
        // unrelated table.
        for table in self.config.tables.keys() {
            let specs = self.attachment_specs(table);
            for row in self.store.read_all(table)? {
                if survivors.contains(&(table.clone(), row.pk.clone())) {
                    continue;
                }
                if let Some(specs) = specs {
                    name_refs(&row.columns, specs, left);
                }
                self.store.delete_row(table, &row.pk)?;
                reset.insert((table.clone(), row.pk.clone()));
            }
        }
        Ok(())
    }

    /// One staged page in wire order, its changed rows before its tombstones.
    /// Every pk the page writes joins `reset`, and every attachment ref it
    /// takes off a row joins `dropped`.
    fn apply_staged_page(
        &self,
        resp: &PullResponse,
        now: &str,
        reset: &mut BTreeSet<(String, String)>,
        dropped: &mut BTreeSet<String>,
    ) -> Result<(), EngineError> {
        for row in &resp.rows {
            self.apply_pulled_row(row, now, dropped)?;
            reset.insert((row.table.clone(), row.pk.clone()));
        }
        for t in &resp.tombstones {
            if let Some(specs) = self.attachment_specs(&t.table) {
                self.collect_row_refs(&t.table, &t.pk, specs, dropped)?;
            }
            self.store.apply_tombstone(&t.table, &t.pk, &t.seq, now)?;
            reset.insert((t.table.clone(), t.pk.clone()));
        }
        Ok(())
    }

    fn apply_pulled_row(
        &self,
        row: &RowChange,
        now: &str,
        dropped: &mut BTreeSet<String>,
    ) -> Result<(), EngineError> {
        if row.deleted {
            if let Some(specs) = self.attachment_specs(&row.table) {
                self.collect_row_refs(&row.table, &row.pk, specs, dropped)?;
            }
            self.store
                .apply_tombstone(&row.table, &row.pk, &row.seq, now)?;
            return Ok(());
        }

        // A pulled row is authoritative and REPLACES the local column
        // map: merging into the existing row would keep columns the
        // incoming row omits alive forever.
        // Both reads happen BEFORE the blind replace: one needs the
        // ref this row is about to lose, the other must not mistake
        // the incoming ref for one it already knows.
        if let Some(specs) = self.attachment_specs(&row.table) {
            self.collect_replaced_refs(row, specs, dropped)?;
            self.schedule_downloads(row, specs, now)?;
        }
        self.store
            .put_server_row(&row.table, &row.pk, &row.columns, &row.seq)?;
        Ok(())
    }

    /// The checkpoint's watermark and bookkeeping, written after its rows: the
    /// durable cursor, the staging clear, the end of the pagination sequence,
    /// and the conflict journal, whose entries it answers.
    fn close_checkpoint(
        &self,
        cursor: &str,
        staged: &[PullResponse],
    ) -> Result<Vec<Conflict>, EngineError> {
        self.store.set_cursor(cursor)?;
        self.store.clear_pull_pages()?;
        // The keyset position and the rehydration flag end WITH the checkpoint,
        // inside the same transaction: surviving a committed
        // rehydration boundary, they would make the next page a second snapshot
        // replace and drop every row that page does not carry.
        self.clear_pagination_state()?;
        self.persist_conflicts(staged)
    }

    /// Journal the staged conflicts and answer them. A conflict whose winner
    /// this device pushed is its own write taking the column, not an overwrite
    /// by a peer, so it is left out.
    fn persist_conflicts(&self, staged: &[PullResponse]) -> Result<Vec<Conflict>, EngineError> {
        let at = (self.deps.now_millis)();
        let mut journalled = Vec::new();
        for resp in staged {
            let Some(conflicts) = &resp.conflicts else {
                continue;
            };
            for conflict in conflicts {
                if self.store.was_pushed(&conflict.winner_mutation_id)? {
                    continue;
                }
                self.store.record_overwrite(&NewOverwrite {
                    table: &conflict.table,
                    pk: &conflict.pk,
                    column: &conflict.column_name,
                    loser_value: &conflict.loser_value,
                    winner_mutation_id: &conflict.winner_mutation_id,
                    conflict_mode: &conflict.conflict_mode,
                    winner_seq: Some(conflict.winner_seq.as_str()),
                    at,
                })?;
                journalled.push(conflict.clone());
            }
        }
        Ok(journalled)
    }
}

/// The rows a rehydration's fresh snapshot carries: every staged change that
/// is not a deletion, by `(table, pk)`.
fn snapshot_survivors(staged: &[PullResponse]) -> BTreeSet<(String, String)> {
    staged
        .iter()
        .flat_map(|resp| &resp.rows)
        .filter(|row| !row.deleted)
        .map(|row| (row.table.clone(), row.pk.clone()))
        .collect()
}
