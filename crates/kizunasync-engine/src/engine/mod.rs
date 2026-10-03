//! The `SyncEngine`: struct, shared constants, and its construction, event,
//! read/query, journal, and meta accessors. Its apply/push/pull/orchestration/
//! attachment method groups live in the sibling submodules.

use crate::AttachmentBytes;
use crate::config::{
    EngineConfig, EngineDeps, EngineEvent, EventHandler, ProtocolRemote, SoftBlockReason,
};
use crate::error::EngineError;
use crate::row_key::{DEFAULT_KEY_COLUMN, lowercase_uuid_key_operands, operand_pks};
use kizunasync_protocol::{ColumnValues, Op};
use kizunasync_query::{
    Filter, Predicate, QueryPlan, QueryResult, Row, apply_query, conjunct_keys,
};
use kizunasync_store::{CLIENT_ID_KEY, LocalRow, LocalStore, RejectionRecord, StoreError};
use kizunasync_transfer::Transfer;
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

mod apply;
mod attachments;
mod identity;
mod orchestration;
mod origin_hlc;
mod pull;
mod push;

/// How many emitted event names `recent_event_names` keeps (oldest dropped first).
pub(crate) const RECENT_EVENT_CAPACITY: usize = 64;

/// `_kizunasync_meta` key for the soft-block latch. The key and its `'1'`/`'0'`
/// encoding are the on-disk format: every database this engine opens spells them
/// this way.
const SOFT_BLOCKED_KEY: &str = "soft_blocked";

/// `_kizunasync_meta` key for why the soft block is latched, a
/// [`SoftBlockReason`] spelling written with the latch.
const SOFT_BLOCK_REASON_KEY: &str = "soft_block_reason";

/// `_kizunasync_meta` key for the `sub` claim of the user the store belongs to.
/// A reset wipes it with the rest of the meta.
const OWNER_SUBJECT_KEY: &str = "owner_subject";

/// `_kizunasync_meta` keys for the pull sequence spanning several `pull_once` calls:
/// the keyset position of the in-progress sequence, and whether that sequence is
/// a `CHECKPOINT_EXPIRED` re-hydration whose boundary REPLACES local state. These
/// key names are the on-disk format too, like [`SOFT_BLOCKED_KEY`].
const PAGE_CURSOR_KEY: &str = "page_cursor";
const REHYDRATING_KEY: &str = "rehydrating";

/// `_kizunasync_meta` key for the scope the local snapshot belongs to: per
/// table, the last non-empty value `set_bucket` gave each bucket key, as one
/// JSON object. A reset wipes it with the rest of the meta.
const BUCKET_SCOPE_KEY: &str = "bucket_scope";

/// Oracle error codes, owned by [`crate::error_catalog`] so the catalog, `code()`
/// and these call sites cannot drift apart. The frozen conflict vectors assert on
/// them, so the code for a given protocol violation is pinned and cannot be
/// renamed quietly.
pub(crate) use crate::error_catalog::{
    MALFORMED_PUSH_RESPONSE, UNKNOWN_BATCH_OFFENDER, UNKNOWN_SIGNAL, UNKNOWN_VERDICT_REASON,
    VERDICT_BIJECTION,
};

/// A filter-targeted local write (the `update(...)` / `delete()` builder shape).
///
/// Targets are resolved against the local mirror only, never the network, and each
/// match becomes its own mutation carrying the same columns.
#[derive(Debug, Clone)]
pub struct ApplyWhere {
    /// Table the write targets.
    pub table: String,
    /// Predicates the target rows must satisfy, combined with AND. Never empty.
    pub filters: Vec<Filter>,
    /// The operation each matched row receives.
    pub op: Op,
    /// Columns written to every matched row.
    pub columns: ColumnValues,
    /// Optional compare-and-set guard carried by each mutation.
    pub precondition: Option<ColumnValues>,
    /// Optional wire transforms carried by each mutation.
    pub transforms: Option<serde_json::Map<String, serde_json::Value>>,
    /// Whether rows a soft-delete column marks as deleted may be targeted. A
    /// read hides them by default, so a write hides them by default too: the two
    /// surfaces would otherwise disagree about which rows exist.
    pub include_deleted: bool,
    /// The most rows the write may reach, `PostgREST` `max-affected` with strict
    /// handling: when the filters match more, nothing is written. `None` sets
    /// no cap.
    pub max_affected: Option<u32>,
    /// Whether the answer carries the rows the write reached
    /// ([`AppliedWhere::rows`]).
    pub returning: bool,
    /// The one-row shape a returning write ends in, checked before anything is
    /// written: a match count that breaks it refuses the write with the message
    /// the same terminal gives on a read. `None` takes every match.
    pub cardinality: Option<WriteCardinality>,
}

/// The one-row terminal a write's returning `select()` ends in. The wire
/// spells it as a read plan's `cardinality` does: `single` or `maybeSingle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum WriteCardinality {
    /// Exactly one row.
    Single,
    /// At most one row.
    MaybeSingle,
}

/// What a filter-targeted write answers.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct AppliedWhere {
    /// The primary keys the write reached, in pk order.
    pub keys: Vec<String>,
    /// With [`ApplyWhere::returning`], the rows those keys name, shaped as a read
    /// reports them: an update's as they read after the write, a delete's as
    /// they read before it. `None` without it.
    pub rows: Option<Vec<Row>>,
}

/// What `sync()`'s push loop has learned from permanent push failures.
///
/// Engine-instance state (not per-`sync()`-call) so bursts of `sync()` calls
/// accumulate toward the budget. The failure streak and the head isolation
/// belong to one head: they end when the head changes (a successful push, or a
/// different head) or when it is dead-lettered. The slice cap describes the
/// server's batch limit rather than a write, so it outlives a head and ends
/// when the outbox drains.
#[derive(Debug, Default)]
pub(crate) struct DeadLetterBudget {
    /// Consecutive PERMANENT failures charged to the head.
    consecutive_failures: u32,
    /// The outbox `seq` of the head the streak and the isolation belong to.
    head_seq: Option<i64>,
    /// The next unbatched push sends the head alone.
    isolate_head: bool,
    /// The most unbatched entries one push may carry, halved on each `KZP02`.
    slice_cap: Option<usize>,
}

/// The bucket values the next pull names, which `set_bucket_params` changes
/// while a network call may be awaiting, and the generation of the scope
/// they select.
#[derive(Debug)]
pub(crate) struct BucketRouting {
    /// Per configured table, its bucket values by key.
    params: BTreeMap<String, ColumnValues>,
    /// Bumped each time a value replaces the kept scope, so a pull that was
    /// awaiting the remote under the old scope commits nothing.
    generation: u64,
}

/// A stored row as the query layer addresses it: its pk beside the column map.
/// A table keyed by one column gets that column from the pk when the map lacks
/// it, which is the case of a row minted under `id`; a column the row carries
/// is kept as it is, an integer key included.
fn into_target(row: LocalRow, lone_key: Option<&str>) -> (String, Row) {
    let pk = row.pk;
    let mut columns = row.columns;
    if let Some(column) = lone_key
        && !columns.contains_key(column)
    {
        columns.insert(column.to_string(), Value::String(pk.clone()));
    }
    (pk, columns)
}

/// The local sync engine: the single owner of the local mirror, the outbox, the
/// pull/push loop, and the local query and write surface every bridge calls.
pub struct SyncEngine {
    pub(crate) store: LocalStore,
    pub(crate) config: EngineConfig,
    remote: Arc<dyn ProtocolRemote>,
    pub(crate) deps: EngineDeps,
    listeners: Mutex<Vec<EventHandler>>,
    recent_events: Mutex<VecDeque<&'static str>>,
    pub(crate) transfer: Option<Arc<dyn Transfer>>,
    pub(crate) attachment_bytes: Option<Arc<dyn AttachmentBytes>>,
    pub(crate) attachment_root: Option<PathBuf>,
    dead_letter: Mutex<DeadLetterBudget>,
    /// The `sub` claim of the token the remote sends, `None` once the token
    /// is cleared. See the `identity` module.
    token_subject: Mutex<Option<String>>,
    /// Held for the whole of every call that pulls or pushes, by the
    /// attachment download and vacuum, and by `reset` and `seed_checkpoint`,
    /// so those run one at a time in arrival order. Local reads and writes
    /// never take it. See [`SyncEngine::sync`].
    network: tokio::sync::Mutex<()>,
    buckets: Mutex<BucketRouting>,
}

impl SyncEngine {
    /// Build an engine over an open store, a validated config, a remote, and the
    /// injected clock and id sources a harness pins.
    ///
    /// The store keeps the identity this device registers under: the one it
    /// already holds wins, and a store that holds none keeps
    /// [`EngineConfig::client_id`] from this open on.
    ///
    /// A non-empty bucket value a table config names counts like a
    /// [`SyncEngine::set_bucket_params`] call: one that replaces the value the
    /// store kept for that table and key re-bootstraps the next pull.
    ///
    /// A `bucket_owner` table's bucket value is the owner the store keeps,
    /// when it keeps one, so a store that already belongs to a user pulls
    /// before the host hands it a token.
    #[must_use]
    pub fn new(
        store: LocalStore,
        config: EngineConfig,
        remote: Arc<dyn ProtocolRemote>,
        deps: EngineDeps,
    ) -> Self {
        let params = config
            .tables
            .iter()
            .map(|(name, table)| (name.clone(), table.bucket_params.clone()))
            .collect();
        let engine = Self {
            store,
            config,
            remote,
            deps,
            listeners: Mutex::new(Vec::new()),
            recent_events: Mutex::new(VecDeque::with_capacity(RECENT_EVENT_CAPACITY)),
            transfer: None,
            attachment_bytes: None,
            attachment_root: None,
            dead_letter: Mutex::new(DeadLetterBudget::default()),
            token_subject: Mutex::new(None),
            network: tokio::sync::Mutex::new(()),
            buckets: Mutex::new(BucketRouting {
                params,
                generation: 0,
            }),
        };
        // If the store cannot keep the identity right now, it is asked again and fails the call on the first pull or push.
        let _ = engine.client_id();
        engine.keep_configured_scope();
        engine.fill_kept_owner_buckets();
        engine
    }

    /// Attach the attachment transfer port.
    #[must_use]
    pub fn with_transfer(mut self, transfer: Arc<dyn Transfer>) -> Self {
        self.transfer = Some(transfer);
        self
    }

    /// Attach the port that reads and writes local attachment bytes.
    #[must_use]
    pub fn with_attachment_bytes(mut self, bytes: Arc<dyn AttachmentBytes>) -> Self {
        self.attachment_bytes = Some(bytes);
        self
    }

    /// Attach the directory local attachment bytes live under.
    #[must_use]
    pub fn with_attachment_root(mut self, root: PathBuf) -> Self {
        self.attachment_root = Some(root);
        self
    }

    /// Register an event handler and return the closure that drops it again.
    pub fn subscribe(&self, handler: EventHandler) -> impl Fn() + '_ {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(handler.clone());
        let listeners = &self.listeners;
        move || {
            listeners
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|h| !Arc::ptr_eq(h, &handler));
        }
    }

    /// Drop one previously subscribed handler (pointer equality). `UniFFI` stores
    /// the `Arc` by subscription id and cannot keep the lifetime-bound unsub
    /// closure `subscribe` returns.
    pub fn remove_listener(&self, handler: &EventHandler) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|h| !Arc::ptr_eq(h, handler));
    }

    /// Deliver one event to every listener, synchronously and in subscription
    /// order, because that order is part of the conflict-vectors contract, so an event is
    /// never deferred to a queue.
    ///
    /// The listeners are snapshotted and the lock released before any of them
    /// runs: a foreign callback that subscribes or unsubscribes from inside the
    /// handler would otherwise deadlock on `listeners`.
    pub(crate) fn emit(&self, event: &EngineEvent) {
        let mut ring = self
            .recent_events
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if ring.len() == RECENT_EVENT_CAPACITY {
            ring.pop_front();
        }
        ring.push_back(event.name());
        drop(ring);

        let handlers = self
            .listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        for handler in handlers {
            handler(event.clone());
        }
    }

    /// Event names emitted since this engine was created, oldest first. The ring
    /// keeps a bounded tail and drops the oldest name once it is full, so this is
    /// a recent window and never the whole history. Every name comes from the wire
    /// vocabulary [`EngineEvent::all_names`] declares.
    #[must_use]
    pub fn recent_event_names(&self) -> Vec<String> {
        self.recent_events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|name| (*name).to_string())
            .collect()
    }

    /// The key columns of `table`, empty for a table the config does not name.
    pub(crate) fn table_key(&self, table: &str) -> &[String] {
        self.config
            .tables
            .get(table)
            .map_or(&[], |config| config.key.as_slice())
    }

    /// The one column a table's key is made of, or `None` for a composite key.
    /// A table the config does not name reads as keyed by `id`.
    pub(crate) fn lone_key_column(&self, table: &str) -> Option<&str> {
        match self.config.tables.get(table) {
            None => Some(DEFAULT_KEY_COLUMN),
            Some(config) => match config.key.as_slice() {
                [column] => Some(column.as_str()),
                _ => None,
            },
        }
    }

    /// Live rows of one table as `(pk, row)` pairs, where the row is what the
    /// query layer addresses.
    ///
    /// The pk lives in its own store column. A row minted under `id` carries no
    /// `id` in its column map, so this seam derives it from the pk rather than
    /// any layer persisting it. Every read and filter-targeted write shapes its
    /// rows through `into_target`, so a filter naming a key column means the
    /// same row on both.
    fn read_all_targets(&self, table: &str) -> Result<Vec<(String, Row)>, EngineError> {
        let lone_key = self.lone_key_column(table);
        Ok(self
            .store
            .read_all(table)?
            .into_iter()
            .map(|row| into_target(row, lone_key))
            .collect())
    }

    /// The pks an `eq` or `in` on the column of a single-column key names
    /// among `filters`, when one is a conjunct ([`conjunct_keys`]) whose every
    /// operand bounds the rows it can match ([`operand_pks`]). `None` sends the
    /// read to the whole table.
    fn key_lookup(&self, table: &str, filters: &[Filter]) -> Option<Vec<String>> {
        let column = self.lone_key_column(table)?;
        operand_pks(&conjunct_keys(filters, column)?)
    }

    /// The live rows [`Self::key_lookup`] names, or else every live row: in
    /// pk order, shaped as [`Self::read_all_targets`] shapes them. A row this
    /// leaves out is never true on `filters`.
    fn read_targets(
        &self,
        table: &str,
        filters: &[Filter],
    ) -> Result<Vec<(String, Row)>, EngineError> {
        let Some(pks) = self.key_lookup(table, filters) else {
            return self.read_all_targets(table);
        };

        let lone_key = self.lone_key_column(table);
        Ok(self
            .store
            .read_rows(table, pks.iter().map(String::as_str))?
            .into_iter()
            .map(|row| into_target(row, lone_key))
            .collect())
    }

    /// The first `decisive` visible live rows of `table`, in pk order, that
    /// `filters` select. The walk stops there, so no later row is read.
    fn first_matches(
        &self,
        table: &str,
        filters: &[Filter],
        decisive: usize,
        hidden_by: Option<&str>,
    ) -> Result<Vec<Row>, EngineError> {
        let mut matches = Vec::new();
        if decisive == 0 {
            return Ok(matches);
        }

        let predicate = Predicate::new(filters);
        let lone_key = self.lone_key_column(table);
        self.store.for_each_row(table, |stored| {
            let (_, row) = into_target(stored, lone_key);
            if hidden_by.is_some_and(|column| Self::is_soft_deleted(&row, column))
                || !predicate.matches(&row)?
            {
                return Ok(ControlFlow::Continue(()));
            }

            matches.push(row);
            Ok::<_, EngineError>(if matches.len() == decisive {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            })
        })?;
        Ok(matches)
    }

    /// Live rows of one table as the query layer addresses them: the column of
    /// a single-column key is filled from the pk when a row lacks it.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn read_all_rows(&self, table: &str) -> Result<Vec<Row>, EngineError> {
        Ok(self
            .read_all_targets(table)?
            .into_iter()
            .map(|(_, row)| row)
            .collect())
    }

    /// A row the app marked deleted: the table's soft-delete column carries a
    /// value. An absent column and an explicit null are both live, so a table
    /// that gains the column later keeps every row written before it.
    pub(crate) fn is_soft_deleted(row: &Row, column: &str) -> bool {
        row.get(column).is_some_and(|value| !value.is_null())
    }

    /// The soft-delete column to hide rows by, or `None` when the table declares
    /// none or the caller asked for the marked rows. One owner for the read and
    /// the write-targeting side, so `update(...)` and `delete()` address exactly
    /// the rows a `select` reports.
    pub(crate) fn hidden_by(&self, table: &str, include_deleted: bool) -> Option<&str> {
        if include_deleted {
            return None;
        }
        self.config
            .tables
            .get(table)
            .and_then(|config| config.soft_delete_column.as_deref())
    }

    /// Evaluate one local read plan over the live rows of `table`.
    ///
    /// Rows a soft-delete column marks as deleted are not rows here: each is
    /// excluded before the plan is evaluated unless the plan asks for them, so a
    /// `limit` counts the rows the caller can see.
    ///
    /// The store is read no further than the plan needs. An `eq` or `in` on the
    /// column of a single-column key among the root filters, or inside a root
    /// `and`, reads only the rows it names, unless an operand is a number the
    /// evaluator could equal with more than one integer. Otherwise a plan with no `orders` and a `limit` or a one-row
    /// cardinality stops at the matches that decide it, which for `single` and
    /// `maybeSingle` is the second, counted past any `offset`. The answer is the
    /// one the whole table gives, except that a cardinality refusal from a read
    /// that stopped counts two rows.
    ///
    /// A uuid-shaped operand of an `eq`, `neq` or `in` on a key column is
    /// lowercased first, since the engine stores uuid keys in that form.
    ///
    /// # Errors
    /// [`EngineError::UnknownTable`] when `table` is absent from the config,
    /// [`EngineError::Store`] when the local store cannot be read, and
    /// [`EngineError::Query`] for a plan the local subset refuses or a row count
    /// that contradicts the cardinality.
    pub fn query(&self, table: &str, plan: &QueryPlan) -> Result<QueryResult, EngineError> {
        if !self.config.tables.contains_key(table) {
            return Err(EngineError::UnknownTable(table.to_string()));
        }
        // Refused before any row is read, so a plan outside the local subset never half-streams.
        plan.validate()?;
        let plan = &QueryPlan {
            filters: lowercase_uuid_key_operands(self.table_key(table), &plan.filters),
            ..plan.clone()
        };

        let hidden_by = self.hidden_by(table, plan.include_deleted);
        let rows = if let Some(decisive) = plan.decisive_matches()
            && self.key_lookup(table, &plan.filters).is_none()
        {
            self.first_matches(table, &plan.filters, decisive, hidden_by)?
        } else {
            let mut rows: Vec<Row> = self
                .read_targets(table, &plan.filters)?
                .into_iter()
                .map(|(_, row)| row)
                .collect();
            if let Some(column) = hidden_by {
                rows.retain(|row| !Self::is_soft_deleted(row, column));
            }
            rows
        };
        Ok(apply_query(rows, plan)?)
    }

    /// The durable pull cursor this device resumes from.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn get_checkpoint(&self) -> Result<String, EngineError> {
        Ok(self.store.get_cursor()?)
    }

    /// Which VFS backs this engine's local store.
    #[must_use]
    pub fn store_kind(&self) -> kizunasync_store::VfsKind {
        self.store.kind()
    }

    /// `true` once a `RESET_REQUIRED` signal or a token naming another user
    /// latched the soft block: the client makes no further pull/push RPC until
    /// the app resets. Durable in `_kizunasync_meta`.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn is_soft_blocked(&self) -> Result<bool, EngineError> {
        Ok(self.store.meta_get(SOFT_BLOCKED_KEY)? == "1")
    }

    /// Why the soft block is latched, or `None` while the store is not
    /// blocked or its block carries no reason.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read, or when it
    /// keeps a reason outside [`SoftBlockReason`].
    pub fn soft_block_reason(&self) -> Result<Option<SoftBlockReason>, EngineError> {
        if !self.is_soft_blocked()? {
            return Ok(None);
        }

        let stored = self.meta_get(SOFT_BLOCK_REASON_KEY)?;
        if stored.is_empty() {
            return Ok(None);
        }
        SoftBlockReason::parse(&stored).map(Some).ok_or_else(|| {
            EngineError::Store(StoreError::UnknownVocabulary {
                column: SOFT_BLOCK_REASON_KEY,
                value: stored,
            })
        })
    }

    /// Latch the soft block with `reason` and return the `RESET_REQUIRED`
    /// naming it, which the caller emits once its transaction committed. The
    /// flag and its reason are one state change, so this runs inside the
    /// caller's store transaction.
    fn latch_soft_block(&self, reason: SoftBlockReason) -> Result<EngineEvent, EngineError> {
        self.meta_set(SOFT_BLOCK_REASON_KEY, reason.as_str())?;
        self.meta_set(SOFT_BLOCKED_KEY, "1")?;
        Ok(EngineEvent::ResetRequired {
            reason: Some(reason),
        })
    }

    /// The keyset position of the in-progress pull sequence, if one is running.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub(crate) fn page_cursor(&self) -> Result<Option<String>, EngineError> {
        let value = self.meta_get(PAGE_CURSOR_KEY)?;
        Ok(if value.is_empty() { None } else { Some(value) })
    }

    fn is_rehydrating(&self) -> Result<bool, EngineError> {
        Ok(self.meta_get(REHYDRATING_KEY)? == "1")
    }

    /// End the sequence: no keyset position, no rehydration flag. The durable
    /// cursor is untouched, so the next poll resumes from the last checkpoint.
    fn clear_pagination_state(&self) -> Result<(), EngineError> {
        self.meta_set(PAGE_CURSOR_KEY, "")?;
        self.meta_set(REHYDRATING_KEY, "0")
    }

    /// Make the next pull a re-hydration from `"0"` whose boundary REPLACES
    /// local state, dropping the pages staged so far.
    ///
    /// Runs inside the caller's store transaction, because the flag and the
    /// keyset reset arm that replace TOGETHER: a fault after `rehydrating` and
    /// before `page_cursor` would leave the rehydration armed over a
    /// mid-pagination position, so the next boundary would replace the
    /// snapshot from a survivor set missing every row the pages before that
    /// position carry: silently dropping live rows.
    fn arm_rehydration(&self) -> Result<(), EngineError> {
        self.store.clear_pull_pages()?;
        self.meta_set(REHYDRATING_KEY, "1")?;
        self.meta_set(PAGE_CURSOR_KEY, "0")
    }

    /// Live rows of one table WITH their primary keys beside the column map, as
    /// the store keeps them: [`SyncEngine::read_all_rows`] fills a missing
    /// single-column key from the pk.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn read_local_rows(
        &self,
        table: &str,
    ) -> Result<Vec<kizunasync_store::LocalRow>, EngineError> {
        Ok(self.store.read_all(table)?)
    }

    /// One stored row by primary key, or `None` when the table holds no such row.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn read_row(
        &self,
        table: &str,
        pk: &str,
    ) -> Result<Option<kizunasync_store::LocalRow>, EngineError> {
        Ok(self.store.read(table, pk)?)
    }

    /// The configured shape of one table, as the engine opened with it: its
    /// `bucket_params` are the values the config named, and
    /// [`SyncEngine::bucket_params`] reads the ones the next pull names.
    ///
    /// # Errors
    /// [`EngineError::UnknownTable`] when `table` is absent from the config.
    pub fn table_config(&self, table: &str) -> Result<&crate::config::TableConfig, EngineError> {
        self.config
            .tables
            .get(table)
            .ok_or_else(|| EngineError::UnknownTable(table.to_string()))
    }

    /// The bucket values the next pull names for `table`, after every
    /// [`SyncEngine::set_bucket_params`] call so far.
    ///
    /// # Errors
    /// [`EngineError::UnknownTable`] when `table` is absent from the config.
    pub fn bucket_params(&self, table: &str) -> Result<ColumnValues, EngineError> {
        self.with_buckets(|routing| routing.params.get(table).cloned())
            .ok_or_else(|| EngineError::UnknownTable(table.to_string()))
    }

    /// Runs `f` against the bucket routing under its lock and answers what `f`
    /// returned. Never held across an await.
    ///
    /// The routing is a map of values and a counter, so a poisoned lock is
    /// recovered rather than skipped: skipping would drop a `set_bucket` the
    /// caller was told succeeded.
    pub(crate) fn with_buckets<R>(&self, f: impl FnOnce(&mut BucketRouting) -> R) -> R {
        f(&mut self.buckets.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// The gate every call that reaches the network holds for its whole run,
    /// for the attachment download and vacuum. Not reentrant: a caller that
    /// already holds it (`sync()` driving the attachment queue) must not take
    /// it again.
    pub(crate) const fn network_gate(&self) -> &tokio::sync::Mutex<()> {
        &self.network
    }

    /// `true` when a no-resurrection shadow covers this pk.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn has_tombstone(&self, table: &str, pk: &str) -> Result<bool, EngineError> {
        Ok(self.store.has_tombstone(table, pk)?)
    }

    /// How many writes are queued for the next push.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn get_outbox_depth(&self) -> Result<usize, EngineError> {
        Ok(self.store.outbox_depth()?)
    }

    /// Queued outbox entries in FIFO order, the devtools and inspector projection.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn list_outbox(
        &self,
        limit: usize,
    ) -> Result<Vec<kizunasync_store::OutboxEntry>, EngineError> {
        Ok(self.store.list_outbox(limit)?)
    }

    /// The exactly-once push watermark, or `None` before the first applied verdict.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn last_mutation_id(&self) -> Result<Option<String>, EngineError> {
        Ok(self.store.last_mutation_id()?)
    }

    /// The identity the next pull and push register under: the one the store
    /// keeps, which a store that keeps none takes from the config's
    /// `client_id`. A restart therefore registers under the same identity, the
    /// one a [`SyncEngine::reset`] minted included, whatever id the host passes.
    pub(crate) fn client_id(&self) -> Result<String, EngineError> {
        let kept = self.meta_get(CLIENT_ID_KEY)?;
        if !kept.is_empty() {
            return Ok(kept);
        }

        self.meta_set(CLIENT_ID_KEY, &self.config.client_id)?;
        Ok(self.config.client_id.clone())
    }

    /// Wipe every local table and clear the soft block, its reason, the
    /// store's owner, and the kept bucket scope. The `bucket_owner` tables go
    /// back to an unset bucket value until a token records the next owner.
    /// Returns the attachment paths whose bytes the embedder still has to
    /// delete. The origin HLC is kept, so a stamp minted after the reset still
    /// sorts after every stamp minted before it.
    ///
    /// A reset is the point where a device starts over, so it also starts over
    /// as a new registered client: this mints a new `client_id` and the store
    /// keeps it with the wipe, which is what lets an account switch register
    /// under the new user instead of colliding with the previous user's
    /// registration, across restarts too.
    ///
    /// Waits for the network call in flight, so no pull commits over the
    /// wiped store and no push reconciles a write the reset dropped.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be written.
    pub async fn reset(&self) -> Result<Vec<String>, EngineError> {
        let _turn = self.network.lock().await;
        let client_id = (self.deps.uuid)();
        let paths = self.store.reset(self.config.schema_version, &client_id)?;
        self.unset_owner_buckets();

        self.with_budget(|budget| *budget = DeadLetterBudget::default());
        self.emit(&EngineEvent::LocalChanged);
        Ok(paths)
    }

    /// Journalled rejections, newest first. See [`LocalStore::list_rejections`].
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn list_rejections(
        &self,
        include_dismissed: bool,
    ) -> Result<Vec<RejectionRecord>, EngineError> {
        Ok(self.store.list_rejections(include_dismissed)?)
    }

    /// Journalled column overwrites, newest first. See
    /// [`LocalStore::list_overwrites`].
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn list_overwrites(
        &self,
        include_dismissed: bool,
    ) -> Result<Vec<kizunasync_store::OverwriteRecord>, EngineError> {
        Ok(self.store.list_overwrites(include_dismissed)?)
    }

    /// Acknowledge one journalled overwrite; `false` when no entry matched.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be written.
    pub fn dismiss_overwrite(&self, id: i64) -> Result<bool, EngineError> {
        Ok(self.store.dismiss_overwrite(id)?)
    }

    /// Writes `sync()`'s retry budget dropped, oldest first.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub fn list_dead_letters(&self) -> Result<Vec<kizunasync_store::DeadLetterEntry>, EngineError> {
        Ok(self.store.list_dead_letters()?)
    }

    /// Acknowledge one journalled rejection; `false` when no entry matched.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be written.
    pub fn dismiss_rejection(&self, mutation_id: &str) -> Result<bool, EngineError> {
        Ok(self.store.dismiss_rejection(mutation_id)?)
    }

    /// Reads one `_kizunasync_meta` value, empty when `key` was never written.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be read.
    pub(crate) fn meta_get(&self, key: &str) -> Result<String, EngineError> {
        self.store.meta_get(key).map_err(EngineError::from)
    }

    /// Writes one `_kizunasync_meta` value, replacing whatever `key` held.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the local store cannot be written.
    pub(crate) fn meta_set(&self, key: &str, value: &str) -> Result<(), EngineError> {
        self.store.meta_set(key, value).map_err(EngineError::from)
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
pub(crate) mod tests {
    use super::{EngineConfig, EngineEvent, SyncEngine};
    use crate::{DEFAULT_ATTACHMENT_ATTEMPTS, EngineDeps, ScriptedRemote};
    use kizunasync_store::LocalStore;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex, PoisonError};

    /// An engine over an empty in-memory store with no tables, client `c1`, and a
    /// scripted remote, for the tests that need an engine and no synced table.
    pub(crate) fn memory_engine() -> SyncEngine {
        SyncEngine::new(
            LocalStore::open_in_memory().unwrap(),
            EngineConfig {
                tables: BTreeMap::new(),
                schema_version: 1,
                default_limit: None,
                attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
                client_id: "c1".into(),
            },
            Arc::new(ScriptedRemote::new()),
            EngineDeps::default(),
        )
    }

    /// A foreign callback that panics inside a handler poisons the registry for
    /// the life of the engine, and these events are the app's only notice of a
    /// rejected write, a dead letter or an aborted batch.
    #[test]
    fn emit_still_delivers_after_a_listener_lock_was_poisoned() {
        let engine = memory_engine();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        let _unsubscribe = engine.subscribe(Arc::new(move |event: EngineEvent| {
            recorder
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(event.name());
        }));

        let listeners = &engine.listeners;
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let _ = std::panic::catch_unwind(|| {
                    let _guard = listeners.lock().unwrap();
                    panic!("a listener panicked while holding the registry");
                });
            });
        });
        assert!(listeners.is_poisoned());

        engine.emit(&EngineEvent::LocalChanged);

        assert_eq!(*seen.lock().unwrap(), vec!["LOCAL_CHANGED"]);
    }
}
