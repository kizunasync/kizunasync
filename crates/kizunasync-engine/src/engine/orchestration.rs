//! Orchestration: `sync` and its push/pull halves, the dead-letter budget, and
//! dead-lettering the slice that owns a permanent failure.

use super::push::select_push_entries;
use super::{DeadLetterBudget, SyncEngine};
use crate::config::EngineEvent;
use crate::error::EngineError;
// The reason stamped on both the dead-letter row and the rejection journal when
// the budget drops a write (parity with `sync-engine.ts`); the catalog owns it.
use crate::error_catalog::PERMANENT_TRANSPORT;
use crate::{AttachmentBytes, FsAttachmentBytes};
use kizunasync_store::{DeadLetterRecord, OutboxEntry};
use std::sync::{Arc, PoisonError};

/// Consecutive PERMANENT push failures charged to the same head (a lone
/// unbatched write, or the atomic batch at the head) before it is
/// dead-lettered. Only ever consumed in [`SyncEngine::sync`], never in raw
/// [`SyncEngine::push_once`]: the conformance corpus drives `push_once`
/// directly, so neither the budget nor its narrowing of a slice reaches it.
const DEAD_LETTER_BUDGET: u32 = 5;

/// The pack's SQLSTATE for a push batch over `_settings.max_batch_size`
/// (`0001_kizuna_init.sql`). It refuses the size of the request, never one of
/// its writes.
const BATCH_TOO_LARGE: &str = "KZP02";

/// Safety bound on how many keyset pages one `sync()` drains: a misbehaving
/// server that always answers `has_more` cannot spin the loop forever, and
/// reaching the bound fails the call rather than report a pull that committed
/// nothing as a success.
const MAX_PULL_PAGES: u32 = 100_000;

/// Safety bound on how many push slices one `sync()` drains. Each slice is at
/// most 500 unbatched rows; a stuck remote that applies nothing is stopped by
/// the depth check, not this cap.
const MAX_PUSH_ROUNDS: u32 = MAX_PULL_PAGES;

/// How many pending attachment rows one `sync()` drives. Matches a small
/// in-process batch, not the whole table: a later tick continues.
const ATTACHMENT_DRIVE_LIMIT: usize = 32;

/// Whether a permanent failure of the slice that was SENT names its write. A
/// lone unbatched write does, and an atomic batch is one request, so the whole
/// run owns the rejection. An unbatched run of several does not say which of
/// them the server refused (a later constraint, or `KZP02`, which names only
/// the size): charging its head would dead-letter an innocent write.
const fn slice_owns_the_rejection(sent: &[OutboxEntry], atomic: bool) -> bool {
    atomic || sent.len() == 1
}

/// The server's own words when `error` is its `KZP02` refusal of the batch size.
fn batch_too_large_message(error: &EngineError) -> Option<&str> {
    let EngineError::Remote {
        code: Some(code),
        message,
        ..
    } = error
    else {
        return None;
    };
    (code == BATCH_TOO_LARGE).then_some(message.as_str())
}

impl DeadLetterBudget {
    /// Start counting for `head_seq` when it is not the head this budget follows.
    fn follow(&mut self, head_seq: i64) {
        if self.head_seq != Some(head_seq) {
            self.forget_head();
            self.head_seq = Some(head_seq);
        }
    }

    /// End the head's failure streak and its isolation; the slice cap stays.
    const fn forget_head(&mut self) {
        self.consecutive_failures = 0;
        self.head_seq = None;
        self.isolate_head = false;
    }

    /// The part of `run` the next budgeted push sends: an atomic batch whole
    /// (it cannot be split), an unbatched run cut to the head alone or to the
    /// slice cap.
    fn limit<'run>(&self, run: &'run [OutboxEntry], atomic: bool) -> &'run [OutboxEntry] {
        if atomic {
            return run;
        }

        let cap = if self.isolate_head {
            1
        } else {
            self.slice_cap.unwrap_or(run.len())
        };
        &run[..run.len().min(cap)]
    }

    /// Narrow the next unbatched slice after `sent` entries failed together:
    /// `KZP02` refuses the size, so the cap halves; any other fault may belong
    /// to any of them, so the head goes alone. Either way the next slice is
    /// strictly shorter than `sent`.
    fn narrow(&mut self, sent: usize, error: &EngineError) {
        if batch_too_large_message(error).is_some() {
            self.slice_cap = Some((sent / 2).max(1));
        } else {
            self.isolate_head = true;
        }
    }
}

impl SyncEngine {
    /// Push (under the dead-letter budget) then drain the whole pull sequence.
    ///
    /// The conformance harness drives `push_once` / `pull_once` DIRECTLY and never
    /// `sync()`, so the corpus path never consumes the budget, and never sees the
    /// drain loop: a bootstrap bigger than one page only STAGES until the
    /// `has_more:false` boundary, so one page per `sync()` would leave a large
    /// pull invisible for pages × poll interval.
    ///
    /// A failed push still pulls, so a write the server refuses never holds
    /// remote rows back, and the push failure is what the call returns. The one
    /// exception is a retryable remote fault: the network or the session, which
    /// the pull would hit the same way, so the call returns at once.
    ///
    /// When a `Transfer` is attached (thin native client), the attachment queue
    /// runs BETWEEN the two halves, and only after a push that succeeded, so the
    /// ref column reaches the server before its object. A soft-blocked store
    /// skips it, crash recovery included: the queue may belong to another user
    /// than the session the transfer would run under. JavaScript/NAPI keep
    /// `transfer` unset and insert `attachments.drive()` themselves
    /// (`rust-engine.ts`).
    ///
    /// Local calls proceed while a network call awaits: a read, a write, a
    /// bucket or token change, and a journal read answer between the awaits of
    /// a `sync()` in flight. The calls that pull or push (`sync`,
    /// [`Self::sync_push`], [`Self::sync_pull`], [`Self::push_once`],
    /// [`Self::pull_once`]), [`Self::resolve_download`],
    /// [`Self::vacuum_attachments`], [`Self::reset`] and
    /// [`Self::seed_checkpoint`] run one at a time: each waits, in arrival
    /// order, until the one before it returned. So two `sync()` calls never
    /// overlap, and the attachment branch's
    /// [`SyncEngine::recover_in_flight_attachments`] never reclaims a claim
    /// another call of this engine is holding. A write that lands while
    /// a push awaits stays queued and is replayed over the rows the push
    /// reconciles.
    ///
    /// # Errors
    ///
    /// Returns the push half's error when it fails (after the pull half ran,
    /// unless it is a retryable remote fault), otherwise the attachment drive's
    /// or the pull half's.
    pub async fn sync(&self) -> Result<(), EngineError> {
        let _turn = self.network.lock().await;
        let pushed = self.push_outbox().await;
        if matches!(
            pushed,
            Err(EngineError::Remote {
                retryable: true,
                ..
            })
        ) {
            return pushed;
        }

        if pushed.is_ok() && self.transfer.is_some() && !self.blocks_network()? {
            self.recover_in_flight_attachments()?;
            let bytes: Arc<dyn AttachmentBytes> = self
                .attachment_bytes
                .clone()
                .unwrap_or_else(|| Arc::new(FsAttachmentBytes));
            self.drive_attachment_queue(bytes, ATTACHMENT_DRIVE_LIMIT)
                .await?;
        }

        let pulled = self.pull_sequence().await;
        pushed.and(pulled)
    }

    /// The push half of [`Self::sync`], callable on its own so an embedder that
    /// owns the attachment queue can move the bytes BETWEEN the two halves: the
    /// ref column has to reach the server before its object does. Splitting it
    /// here rather than
    /// driving the queue from inside `sync()` keeps the byte transfer where the
    /// `fileStore` / `transfer` ports were injected.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when a push round fails outside the
    /// dead-letter budget.
    pub async fn sync_push(&self) -> Result<(), EngineError> {
        let _turn = self.network.lock().await;
        self.push_outbox().await
    }

    /// [`Self::sync_push`] for a caller that already holds the network gate.
    async fn push_outbox(&self) -> Result<(), EngineError> {
        let mut rounds = 0;
        loop {
            if self.blocks_network()? {
                return Ok(());
            }
            let before = self.get_outbox_depth()?;
            if before == 0 {
                self.with_budget(|budget| *budget = DeadLetterBudget::default());
                return Ok(());
            }
            self.push_with_budget().await?;
            let after = self.get_outbox_depth()?;
            if after >= before {
                return Ok(());
            }
            rounds += 1;
            if rounds >= MAX_PUSH_ROUNDS {
                return Ok(());
            }
        }
    }

    /// The pull half of [`Self::sync`]: drain the whole keyset sequence, not one
    /// page.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when a page of the sequence fails, and a
    /// retryable [`EngineError::Remote`] when the server still answers
    /// `has_more` after `MAX_PULL_PAGES` pages: nothing is committed, the
    /// staged pages and the keyset position stay, and the next pull continues
    /// the sequence.
    pub async fn sync_pull(&self) -> Result<(), EngineError> {
        let _turn = self.network.lock().await;
        self.pull_sequence().await
    }

    /// [`Self::sync_pull`] for a caller that already holds the network gate.
    async fn pull_sequence(&self) -> Result<(), EngineError> {
        let mut pages = 0;
        loop {
            self.pull_page().await?;
            if self.page_cursor()?.is_none() {
                return Ok(());
            }
            pages += 1;
            if pages >= MAX_PULL_PAGES {
                return Err(EngineError::remote(format!(
                    "pull: no checkpoint boundary after {MAX_PULL_PAGES} pages; the next pull continues the sequence"
                )));
            }
        }
    }

    /// One push under the budget, the only accounting allowed to DROP a
    /// queued write.
    ///
    /// Only a remote fault the wire adapter classified as PERMANENT counts toward
    /// the budget; a protocol/local fault and every transient/untagged failure are
    /// re-raised so the write stays queued and is retried indefinitely.
    ///
    /// A permanent failure belongs to the slice that was sent, never to the
    /// candidate list it was cut from. A slice that does not own it is
    /// narrowed ([`DeadLetterBudget::narrow`]) and sent again at once; each
    /// retry sends a strictly shorter unbatched slice, so the loop ends by the
    /// time the slice is one write, which owns its failure.
    async fn push_with_budget(&self) -> Result<(), EngineError> {
        loop {
            let outbox = self.push_candidates()?;
            let Some(head) = outbox.first() else {
                self.with_budget(|budget| *budget = DeadLetterBudget::default());
                return Ok(());
            };
            let head_seq = head.seq;
            let (run, atomic) = select_push_entries(&outbox);
            let sent = self.with_budget(|budget| {
                budget.follow(head_seq);
                budget.limit(run, atomic)
            });

            let error = match self.push_entries(sent, atomic).await {
                Ok(()) => {
                    // The slice was cleared or reconciled: the streak is broken.
                    self.with_budget(|budget| budget.consecutive_failures = 0);
                    return Ok(());
                }
                Err(error) if error.is_budget_exempt() => return Err(error),
                Err(error) => error,
            };
            if slice_owns_the_rejection(sent, atomic) {
                return self.charge(sent, atomic, error);
            }
            self.with_budget(|budget| budget.narrow(sent.len(), &error));
        }
    }

    /// Charge a permanent failure to `sent`, the slice that owns it, and drop
    /// the slice once the budget runs out. A `KZP02` on an atomic batch drops it
    /// at once: the batch cannot be split, so it can never fit the server's cap.
    fn charge(
        &self,
        sent: &[OutboxEntry],
        atomic: bool,
        error: EngineError,
    ) -> Result<(), EngineError> {
        if atomic && let Some(message) = batch_too_large_message(&error) {
            return self.dead_letter_slice(sent, message);
        }

        let failures = self.with_budget(|budget| {
            budget.consecutive_failures += 1;
            budget.consecutive_failures
        });
        if failures < DEAD_LETTER_BUDGET {
            return Err(error);
        }
        self.dead_letter_slice(sent, PERMANENT_TRANSPORT)
    }

    /// Runs `f` against the dead-letter budget under its lock and answers what
    /// `f` returned.
    ///
    /// The budget is a few counters and flags, not a torn invariant, so a
    /// poisoned lock is recovered rather than skipped: skipping would freeze the
    /// failure streak and either strand a doomed write forever or drop one early.
    pub(crate) fn with_budget<R>(&self, f: impl FnOnce(&mut DeadLetterBudget) -> R) -> R {
        f(&mut self
            .dead_letter
            .lock()
            .unwrap_or_else(PoisonError::into_inner))
    }

    /// Drop `doomed`, the slice that owns a permanent failure, with `reason` on
    /// its dead-letter rows, its journal rows and its events.
    ///
    /// `doomed` is the slice that was sent: the head alone, or the whole
    /// consecutive atomic batch at the head, which the budget never cuts and
    /// [`Self::push_candidates`] reads whole (an all-or-nothing group must die
    /// whole, else surviving members apply later).
    fn dead_letter_slice(&self, doomed: &[OutboxEntry], reason: &str) -> Result<(), EngineError> {
        let now = (self.deps.now)();
        let at = (self.deps.now_millis)();
        let records: Vec<DeadLetterRecord> = doomed
            .iter()
            .map(|entry| DeadLetterRecord {
                entry: entry.clone(),
                reason: reason.to_string(),
                created_at: now.clone(),
                at,
            })
            .collect();
        self.store.dead_letter(&records, &now)?;

        self.with_budget(DeadLetterBudget::forget_head);
        for entry in doomed {
            self.emit(&EngineEvent::DeadLetter {
                mutation_id: entry.mutation_id.clone(),
                reason: reason.to_string(),
            });
        }
        self.emit(&EngineEvent::LocalChanged);
        Ok(())
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::MAX_PULL_PAGES;
    use crate::config::{EngineConfig, EngineDeps, ProtocolRemote};
    use crate::error::EngineError;
    use crate::error_catalog::{self, REMOTE};
    use crate::{DEFAULT_ATTACHMENT_ATTEMPTS, SyncEngine};
    use async_trait::async_trait;
    use kizunasync_protocol::{PullRequest, PullResponse, PushRequest, PushResponse};
    use kizunasync_store::LocalStore;
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A server that never reaches a checkpoint boundary: every page answers
    /// `has_more` with the next keyset position.
    struct EndlessRemote {
        pulls: AtomicU32,
    }

    #[async_trait]
    impl ProtocolRemote for EndlessRemote {
        async fn pull(&self, _req: PullRequest) -> Result<PullResponse, EngineError> {
            let page = self.pulls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(PullResponse {
                cursor: page.to_string(),
                has_more: true,
                rows: vec![],
                tombstones: vec![],
                signal: None,
                conflicts: None,
            })
        }

        async fn push(&self, _req: PushRequest) -> Result<PushResponse, EngineError> {
            panic!("the pull bound test never pushes");
        }
    }

    /// Reaching the page bound is a failed pull, not a quiet success: the call
    /// answers a retryable remote fault, nothing is committed, and the keyset
    /// position stays so the next pull continues the sequence.
    #[tokio::test]
    async fn reaching_the_page_bound_fails_the_pull_and_keeps_the_sequence() {
        let remote = Arc::new(EndlessRemote {
            pulls: AtomicU32::new(0),
        });
        let engine = SyncEngine::new(
            LocalStore::open_in_memory().unwrap(),
            EngineConfig {
                tables: BTreeMap::new(),
                schema_version: 1,
                default_limit: None,
                attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
                client_id: "c1".into(),
            },
            Arc::clone(&remote) as Arc<dyn ProtocolRemote>,
            EngineDeps::default(),
        );

        let error = engine
            .sync_pull()
            .await
            .expect_err("an endless sequence must fail the pull");

        assert!(
            matches!(
                error,
                EngineError::Remote {
                    retryable: true,
                    ..
                }
            ),
            "{error:?}"
        );
        assert_eq!(error.code(), REMOTE);
        assert!(error_catalog::catalog_retryable(&error.code()));
        assert_eq!(remote.pulls.load(Ordering::SeqCst), MAX_PULL_PAGES);
        assert_eq!(engine.get_checkpoint().unwrap(), "0");
        assert_eq!(
            engine.page_cursor().unwrap().as_deref(),
            Some(MAX_PULL_PAGES.to_string().as_str())
        );
    }
}
