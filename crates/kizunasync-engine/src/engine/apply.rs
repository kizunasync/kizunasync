//! Local apply: optimistic writes, the attachment-resurrection guard, the
//! attachment refs a pull drops or schedules, and filtered `apply_where`.

use super::origin_hlc::OriginClock;
use super::{ApplyWhere, PK_COLUMN, SyncEngine};
use crate::config::{AttachmentSpec, EngineEvent, SyncMode, TableConfig};
use crate::error::EngineError;
use crate::time::format_rfc3339_millis;
use kizunasync_protocol::{ColumnValues, ConflictMode, Op, RowChange};
use kizunasync_query::{Filter, Predicate, QueryError, validate_filters};
use kizunasync_store::{AttachmentState, LocalMutation, ORIGIN_HLC_KEY};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

impl SyncEngine {
    /// Apply one local mutation: write the store owner into an insert on a
    /// `bucket_owner` table that leaves the bucket column out, stamp the
    /// origin HLC an `hlc` table resolves by, write it to the mirror, queue it
    /// for push, and emit the local-change and queue-depth events.
    ///
    /// # Errors
    /// [`EngineError::UnknownTable`] for a table absent from the config,
    /// [`EngineError::Query`] for any write to a `pull-only` table,
    /// [`EngineError::SoftDeleteViolation`] for a hard delete on a soft-delete
    /// table, [`EngineError::LocalConstraint`] when the write contradicts the
    /// primary key, and [`EngineError::Store`] when the local store refuses it
    /// (a mutation id that is already queued answers `LOCAL_CONSTRAINT`).
    pub fn apply(&self, mutation: LocalMutation) -> Result<(), EngineError> {
        self.apply_at(mutation, None)
    }

    /// The refusal every local write to a server-owned table carries. Raised
    /// here rather than left to the server's own `KZP01`, so the write never
    /// reaches the outbox and every runtime refuses it the same way.
    fn refuse_pull_only(table: &str) -> EngineError {
        EngineError::Query(QueryError::Unsupported(format!(
            "table \"{table}\" is pull-only"
        )))
    }

    /// [`SyncEngine::apply`] with the caller's timestamp as the outbox entry's
    /// `created_at`. The embedder owns `now`, which is what lets a harness pin
    /// the clock and get a reproducible entry on every mutation. The origin HLC
    /// reads `deps.now_millis`, which the JSON call surface pins from the same
    /// request envelope as `now`, so both name one instant there too.
    ///
    /// Every host reaches the origin-HLC rule through here: `kizunasync-ffi` calls
    /// [`SyncEngine::apply`] and the JSON call surface calls this, so a Swift,
    /// Kotlin, Node, Bun or browser app pushes the same bytes for the same table.
    ///
    /// # Errors
    /// The same faults [`SyncEngine::apply`] reports.
    pub fn apply_at(
        &self,
        mutation: LocalMutation,
        now: Option<String>,
    ) -> Result<(), EngineError> {
        self.write_local(mutation, now)
    }

    /// One local write: refuse it, fill the owner column an owner-bucket
    /// insert leaves out, stamp it when the table resolves by `hlc`, persist
    /// it with the stamp it consumed, and announce it.
    fn write_local(
        &self,
        mut mutation: LocalMutation,
        now: Option<String>,
    ) -> Result<(), EngineError> {
        let Some(table_config) = self.config.tables.get(&mutation.table) else {
            return Err(EngineError::UnknownTable(mutation.table));
        };
        if table_config.sync_mode == SyncMode::PullOnly {
            return Err(Self::refuse_pull_only(&mutation.table));
        }
        if mutation.op == Op::Delete && table_config.soft_delete_column.is_some() {
            return Err(EngineError::SoftDeleteViolation {
                table: mutation.table,
            });
        }
        let conflict_mode = table_config.conflict_mode;
        self.fill_owner_column(&mut mutation, table_config)?;
        Self::refuse_divergent_pk(&mutation)?;

        let mutation_id = mutation
            .mutation_id
            .clone()
            .unwrap_or_else(|| (self.deps.uuid)());
        // One clock read, so the outbox entry's `created_at` and the origin HLC
        // name the same instant.
        let now_ms = (self.deps.now_millis)();
        let now = now.unwrap_or_else(|| format_rfc3339_millis(now_ms));
        if mutation.op == Op::Insert && mutation.pk.is_empty() {
            mutation.pk = (self.deps.uuid)();
        }
        let origin = self.stamp_origin(&mut mutation, conflict_mode, now_ms)?;

        self.refuse_resurrecting_attachment(&mutation, &now)?;

        let kept = origin.as_ref().map(OriginClock::to_meta);
        let meta = kept.as_deref().map(|value| (ORIGIN_HLC_KEY, value));
        self.store.apply(&mutation, &mutation_id, &now, meta)?;
        self.emit(&EngineEvent::LocalChanged);
        let depth = self.store.outbox_depth()?;
        self.emit(&EngineEvent::QueueDepth { depth });
        Ok(())
    }

    /// Write the store owner into an insert on a `bucket_owner` table that
    /// leaves the bucket column out, before anything is stored, so the mirror
    /// row, the outbox entry and every read of them carry it. A column the
    /// row names is the app's value, an explicit null included. With no owner
    /// yet the row stays as written and the server's column default decides.
    fn fill_owner_column(
        &self,
        mutation: &mut LocalMutation,
        table: &TableConfig,
    ) -> Result<(), EngineError> {
        let Some(column) = table.owner_bucket_column() else {
            return Ok(());
        };
        if mutation.op != Op::Insert || mutation.columns.contains_key(column) {
            return Ok(());
        }

        if let Some(owner) = self.owner_subject()? {
            mutation
                .columns
                .insert(column.to_string(), Value::String(owner));
        }
        Ok(())
    }

    /// Set the origin HLC `mutation` leaves with, and return the clock the store
    /// must keep with it. An `arrival` table's push carries no stamp whatever the
    /// caller sent; an `hlc` table keeps a stamp the caller brought and
    /// otherwise gets the one that follows the kept stamp at `now_ms`, which is
    /// returned so it commits in the write's own transaction.
    ///
    /// Only a minted stamp reads the kept clock or mints a node, which is what
    /// lets a fixed-identifier harness over `arrival` tables script every id a
    /// run consumes.
    fn stamp_origin(
        &self,
        mutation: &mut LocalMutation,
        mode: ConflictMode,
        now_ms: i64,
    ) -> Result<Option<OriginClock>, EngineError> {
        match mode {
            ConflictMode::Arrival => {
                mutation.hlc = None;
                Ok(None)
            }
            ConflictMode::Hlc if mutation.hlc.is_some() => Ok(None),
            ConflictMode::Hlc => {
                let last = OriginClock::from_meta(&self.meta_get(ORIGIN_HLC_KEY)?);
                let next = OriginClock::next(last, now_ms, || (self.deps.uuid)());
                mutation.hlc = Some(next.to_wire());
                Ok(Some(next))
            }
        }
    }

    /// The primary key is the row's identity, not a column a write may set to
    /// something else: the query seam derives `id` from the pk, so a stored `id`
    /// that disagrees would make one row answer to two names, and a filter naming
    /// `id` would then target a row a read reports under a different one. An `id`
    /// that repeats the pk names the same identity, so it is written like any
    /// other column.
    fn refuse_divergent_pk(mutation: &LocalMutation) -> Result<(), EngineError> {
        let Some(id) = mutation.columns.get(PK_COLUMN) else {
            return Ok(());
        };
        if id.as_str() == Some(mutation.pk.as_str()) {
            return Ok(());
        }
        match mutation.op {
            Op::Update => Err(EngineError::LocalConstraint(format!(
                "update cannot change \"{PK_COLUMN}\": the primary key is immutable"
            ))),
            Op::Insert => Err(EngineError::LocalConstraint(format!(
                "insert: \"{PK_COLUMN}\" must equal the row's primary key"
            ))),
            Op::Delete => Ok(()),
        }
    }

    /// Resurrection guard (D3): an attachment-column write must not revive a row
    /// a peer already deleted (the no-resurrection tombstone shadow). The drive
    /// loop re-guards before the bytes move, but the optimistic local write and
    /// its outbox entry happen HERE, so the refusal lives here too, and the
    /// would-be Storage object, which no server saw, is evicted on the way
    /// out. Soft-delete
    /// and pull-only refuse with [`EngineError`]; this path matches them instead
    /// of returning success for a mutation that was not applied. Scoped to
    /// tables that declare `attachment()`, so the whole conformance corpus
    /// skips it.
    fn refuse_resurrecting_attachment(
        &self,
        mutation: &LocalMutation,
        now: &str,
    ) -> Result<(), EngineError> {
        if mutation.op == Op::Delete {
            return Ok(());
        }
        let Some(specs) = self.attachment_specs(&mutation.table) else {
            return Ok(());
        };
        if !mutation.columns.keys().any(|c| specs.contains_key(c)) {
            return Ok(());
        }
        if !self.store.has_tombstone(&mutation.table, &mutation.pk)? {
            return Ok(());
        }
        for (column, value) in &mutation.columns {
            if specs.contains_key(column)
                && let Some(reference) = value.as_str()
            {
                self.store.mark_attachment_evicted(reference, now)?;
            }
        }
        Err(EngineError::LocalConstraint(format!(
            "refusing to resurrect \"{}\" / \"{}\" through an attachment write",
            mutation.table, mutation.pk
        )))
    }

    /// The attachment columns of `table`, or `None` when it declares none: the
    /// gate every attachment branch reads so a config without `attachment()`
    /// never pays for one.
    pub(crate) fn attachment_specs(
        &self,
        table: &str,
    ) -> Option<&BTreeMap<String, AttachmentSpec>> {
        self.config
            .tables
            .get(table)
            .map(|config| &config.attachments)
            .filter(|specs| !specs.is_empty())
    }

    /// A pulled delete takes every attachment ref the stored row holds off it:
    /// each joins `dropped`, the pull's garbage candidates.
    pub(crate) fn collect_row_refs(
        &self,
        table: &str,
        pk: &str,
        specs: &BTreeMap<String, AttachmentSpec>,
        dropped: &mut BTreeSet<String>,
    ) -> Result<(), EngineError> {
        self.for_each_stored_ref(table, pk, specs, |_, reference| {
            dropped.insert(reference.to_string());
            Ok(())
        })
    }

    /// When a pulled row supersedes a local ref (an LWW loser, a peer replace, a
    /// clear-to-null), the OLD ref joins `dropped`: `put_server_row` is a blind
    /// full-replace, so the diff has to be read before it.
    pub(crate) fn collect_replaced_refs(
        &self,
        row: &RowChange,
        specs: &BTreeMap<String, AttachmentSpec>,
        dropped: &mut BTreeSet<String>,
    ) -> Result<(), EngineError> {
        self.for_each_stored_ref(&row.table, &row.pk, specs, |column, old| {
            if row.columns.get(column).and_then(Value::as_str) != Some(old) {
                dropped.insert(old.to_string());
            }
            Ok(())
        })
    }

    /// Hand `visit` every attachment ref the stored row of `(table, pk)` holds,
    /// with its column, in `specs` order; nothing when no row is stored.
    fn for_each_stored_ref(
        &self,
        table: &str,
        pk: &str,
        specs: &BTreeMap<String, AttachmentSpec>,
        mut visit: impl FnMut(&str, &str) -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        let Some(prior) = self.store.read(table, pk)? else {
            return Ok(());
        };
        for column in specs.keys() {
            if let Some(reference) = prior.columns.get(column).and_then(Value::as_str) {
                visit(column, reference)?;
            }
        }
        Ok(())
    }

    /// Register a peer's ref so a later `resolveDownload` can fetch it (the ref
    /// itself carries no bucket). Metadata only, no bytes: the entry sits
    /// `queued` until something views it. A LIVE row is skipped; an orphaned
    /// or evicted row is re-registered so a re-lived ref is not vacuumed, and
    /// keeps the SHA-256 this device recorded for the object, which verifies
    /// the download when the server reports none. An evicted row also keeps
    /// its size, media type and the cached bytes the vacuum has not deleted
    /// yet. A ref of any shape registers: its download is named by the
    /// object's SHA-256, never by the ref.
    ///
    /// # Errors
    /// [`EngineError::Store`] when an attachment row cannot be read or written.
    pub(crate) fn schedule_downloads(
        &self,
        row: &RowChange,
        specs: &BTreeMap<String, AttachmentSpec>,
        now: &str,
    ) -> Result<(), EngineError> {
        for (column, spec) in specs {
            let Some(reference) = row.columns.get(column).and_then(Value::as_str) else {
                continue;
            };
            if reference.is_empty() {
                continue;
            }
            let (sha256, size, content_type, local_path) =
                match self.store.get_attachment(reference)? {
                    None => (None, None, None, None),
                    Some(kept) => match kept.state {
                        AttachmentState::Orphaned => (kept.sha256, None, None, None),
                        AttachmentState::Evicted => {
                            (kept.sha256, kept.size, kept.content_type, kept.local_path)
                        }
                        AttachmentState::Queued
                        | AttachmentState::Uploading
                        | AttachmentState::Downloading
                        | AttachmentState::Synced
                        | AttachmentState::Failed
                        | AttachmentState::Missing => continue,
                    },
                };
            // A peer's ref is `owner/pk/upload_id.ext`; an off-shape ref still
            // registers, with empty parts, so a later resolve can fetch it by ref.
            let derived_owner = reference.split('/').next().unwrap_or_default();
            let owner = row
                .columns
                .get(&spec.owner_column)
                .and_then(Value::as_str)
                .unwrap_or(derived_owner);
            let upload_id = reference
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .split('.')
                .next()
                .unwrap_or_default();

            self.store
                .put_attachment(&kizunasync_store::AttachmentEntry {
                    reference: reference.to_string(),
                    upload_id: upload_id.to_string(),
                    table: row.table.clone(),
                    pk: row.pk.clone(),
                    column: column.clone(),
                    bucket: spec.storage_bucket.clone(),
                    owner: owner.to_string(),
                    sha256,
                    content_type,
                    size,
                    local_path,
                    direction: "download".into(),
                    state: AttachmentState::Queued,
                    in_flight: false,
                    fingerprint: None,
                    progress: 0,
                    attempts: 0,
                    permanent: false,
                    chunk_offset: 0,
                    tus_url: None,
                    error: None,
                    created_at: now.to_string(),
                    updated_at: now.to_string(),
                    error_code: None,
                })?;
        }
        Ok(())
    }

    /// Apply one mutation per row matching `request.filters`; returns the targeted pks.
    ///
    /// Each mutation is written like [`SyncEngine::apply`] writes one, so on a
    /// table that resolves by `hlc` every targeted row leaves with its own origin
    /// HLC and the server orders a builder `update()` like any other write.
    ///
    /// Targets are matched over the same `id`-bearing rows a read sees, so every
    /// filter shape naming `id` addresses the row a read reports under that name,
    /// and a row a soft-delete column marks as deleted is no more a write target
    /// than it is a read result. An `eq` or `in` on `id` among the filters, or
    /// inside a root `and`, reads only the rows it names.
    ///
    /// A `delete` on a soft-delete table is the app's delete, not a hard one: it
    /// becomes an update stamping that column with the engine's `now`, so the
    /// outbox carries an ordinary update and the server needs no rule of its own.
    ///
    /// # Errors
    /// [`EngineError::UnknownTable`] for a table absent from the config,
    /// [`EngineError::Query`] for a write to a `pull-only` table, for an empty
    /// filter list or a filter node that names no rows (either would rewrite
    /// the whole table) or for a construct the local subset refuses, and
    /// whatever [`SyncEngine::apply`] reports for each matched row.
    pub fn apply_where(&self, request: ApplyWhere) -> Result<Vec<String>, EngineError> {
        let Some(table_config) = self.config.tables.get(&request.table) else {
            return Err(EngineError::UnknownTable(request.table));
        };
        if table_config.sync_mode == SyncMode::PullOnly {
            return Err(Self::refuse_pull_only(&request.table));
        }
        if request.filters.is_empty() {
            return Err(EngineError::Query(QueryError::Unsupported(format!(
                "{:?} on \"{}\" needs at least one target filter",
                request.op, request.table
            ))));
        }
        validate_filters(&request.filters)?;
        request
            .filters
            .iter()
            .try_for_each(refuse_a_node_that_names_no_rows)?;

        let hidden_by = self.hidden_by(&request.table, request.include_deleted);
        let predicate = Predicate::new(&request.filters);
        let mut targets = Vec::new();
        for (pk, row) in self.read_targets(&request.table, &request.filters)? {
            if hidden_by.is_some_and(|column| Self::is_soft_deleted(&row, column)) {
                continue;
            }
            if predicate.matches(&row)? {
                targets.push(pk);
            }
        }

        let (op, columns) = self.as_soft_delete(&request, table_config.soft_delete_column.as_ref());
        for pk in &targets {
            self.write_local(
                LocalMutation {
                    table: request.table.clone(),
                    pk: pk.clone(),
                    op,
                    columns: columns.clone(),
                    transforms: request.transforms.clone(),
                    precondition: request.precondition.clone(),
                    batch_id: None,
                    hlc: None,
                    mutation_id: None,
                },
                None,
            )?;
        }
        Ok(targets)
    }

    /// The op and columns each target actually receives: the request's own,
    /// unless a `delete` meets a soft-delete column, which turns it into the
    /// update that marks the row. One stamp for the whole request, so every row
    /// a single `delete()` covers carries the same deletion time.
    fn as_soft_delete(
        &self,
        request: &ApplyWhere,
        soft_delete_column: Option<&String>,
    ) -> (Op, ColumnValues) {
        if request.op == Op::Delete
            && let Some(column) = soft_delete_column
        {
            let mut columns = request.columns.clone();
            columns.insert(column.clone(), Value::String((self.deps.now)()));
            return (Op::Update, columns);
        }
        (request.op, request.columns.clone())
    }
}

/// A write target has to name its rows. An empty `and`, an empty `or` under a
/// `not`, and a blank `search` or `textSearch` pattern match every row, so a
/// write carrying one, at any depth, would rewrite the whole table like an
/// unfiltered write. An empty `or` alone matches nothing and is refused the same
/// way, so no negation above it can turn it into every row. Reads keep the
/// evaluator's meaning for these nodes.
fn refuse_a_node_that_names_no_rows(filter: &Filter) -> Result<(), QueryError> {
    match filter {
        Filter::And { filters } | Filter::Or { filters } => {
            if filters.is_empty() {
                return Err(QueryError::Unsupported(
                    "a write target cannot hold an empty and() or or()".to_string(),
                ));
            }
            filters
                .iter()
                .try_for_each(refuse_a_node_that_names_no_rows)
        }
        Filter::Not { filter } => refuse_a_node_that_names_no_rows(filter),
        Filter::Search { query, .. } | Filter::TextSearch { query, .. } => {
            if query.trim().is_empty() {
                return Err(QueryError::Unsupported(
                    "a write target cannot search for a blank pattern".to_string(),
                ));
            }
            Ok(())
        }
        Filter::Eq { .. }
        | Filter::Neq { .. }
        | Filter::Gt { .. }
        | Filter::Gte { .. }
        | Filter::Lt { .. }
        | Filter::Lte { .. }
        | Filter::Like { .. }
        | Filter::Ilike { .. }
        | Filter::Is { .. }
        | Filter::In { .. }
        | Filter::Contains { .. }
        | Filter::ContainedBy { .. } => Ok(()),
    }
}
