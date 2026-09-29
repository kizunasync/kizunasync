//! Engine configuration, wire events, the remote port, and injected dependencies.

use crate::error::EngineError;
use crate::platform::{MaybeSendSync, random_uuid_v4};
use crate::time::{epoch_millis, now_rfc3339};
use async_trait::async_trait;
use kizunasync_protocol::{
    ColumnValues, ConflictMode, PullRequest, PullResponse, PushRequest, PushResponse,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

/// One attachment column: which Storage bucket holds the object, and which row
/// column owns it (the object key derives from that owner). Mirrors the
/// `attachments` entry of `TTableConfig` in `packages/core/src/wire/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentSpec {
    /// The Supabase Storage bucket the object lives in.
    pub storage_bucket: String,
    /// The row column that owns the object key.
    pub owner_column: String,
}

/// Which directions a table syncs in. Mirrors `syncMode` in
/// `packages/core/src/wire/types.ts` and `_config.sync_mode` in the pack.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum SyncMode {
    /// The device both pulls and pushes this table.
    #[default]
    ReadWrite,
    /// The server owns this table: the device pulls it and writes nothing back.
    PullOnly,
}

/// How the server resolves two devices writing the same column of one row, for
/// a table that declares no mode: by arrival order, so its local writes carry no
/// origin stamp. Named here because [`ConflictMode`] is the closed wire
/// vocabulary and carries no default of its own.
#[must_use]
pub const fn arrival_mode() -> ConflictMode {
    ConflictMode::Arrival
}

/// Per-table sync configuration: the push bucket-routing column, its declared
/// attachment columns, the optional soft-delete column, the sync direction, and
/// the conflict-resolution mode. Mirrors `TTableConfig` in
/// `packages/core/src/wire/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableConfig {
    /// The row column pull buckets route on; empty for an unbucketed table.
    pub bucket_column: String,
    /// The bucket-routing values the engine opens with, keyed by
    /// `bucket_column`. [`crate::SyncEngine::bucket_params`] reads the ones the
    /// next pull names once `set_bucket_params` changed them.
    #[serde(default)]
    pub bucket_params: ColumnValues,
    /// The bucket belongs to the store's owner. The engine fills the
    /// `bucket_column` value with the owner's `sub` claim, at open and when a
    /// token first records the owner, and writes it into an inserted row that
    /// leaves the column out.
    #[serde(default)]
    pub bucket_owner: bool,
    /// Attachment columns by name, empty for a table that declares none, which
    /// is every table in the conformance corpus, so the whole corpus keeps the
    /// pull-commit path that does no extra reads. Ordered so a fixed-clock run
    /// orphans and schedules in a stable sequence.
    #[serde(default)]
    pub attachments: BTreeMap<String, AttachmentSpec>,
    /// The app-level deletion marker column, mirroring `softDelete` in
    /// `packages/core/src/wire/types.ts`. Set ⇒ a filter-targeted `delete`
    /// becomes an update stamping this column, a low-level `apply` with
    /// `op: delete` is refused with `SOFT_DELETE_VIOLATION`, and a marked row
    /// is excluded from local reads and write targeting unless the caller asks
    /// for `includeDeleted`.
    #[serde(default)]
    pub soft_delete_column: Option<String>,
    /// Which directions this table syncs in. `pull-only` makes every local write
    /// a refusal before the server's own rule sees it.
    #[serde(default)]
    pub sync_mode: SyncMode,
    /// How the server resolves concurrent column writes here, and therefore
    /// whether a local write leaves carrying an origin HLC.
    #[serde(default = "arrival_mode", alias = "conflictMode")]
    pub conflict_mode: ConflictMode,
}

impl TableConfig {
    /// The column the store owner fills, or `None` unless the table is
    /// flagged `bucket_owner`. A flagged table without a bucket column has
    /// nowhere to put the owner, so it gets `None` too.
    pub(crate) fn owner_bucket_column(&self) -> Option<&str> {
        (self.bucket_owner && !self.bucket_column.is_empty()).then_some(self.bucket_column.as_str())
    }
}

/// How many transfer attempts one attachment gets before the queue gives up on
/// it, when the config names none.
pub const DEFAULT_ATTACHMENT_ATTEMPTS: i64 = 5;

/// The synced tables, schema version, default page size, attachment budget, and
/// client identity a [`crate::SyncEngine`] is constructed with.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    /// Ordered by table name so every request the engine builds from the config
    /// (pull buckets first) has a deterministic, reproducible order.
    pub tables: BTreeMap<String, TableConfig>,
    /// The schema version stamped on every reset.
    pub schema_version: i64,
    /// The page size the app asked for, or `None` when it expressed no
    /// preference: the request then omits `limit` and the server's default
    /// applies.
    #[serde(default)]
    pub default_limit: Option<i64>,
    /// How many transfer attempts one attachment gets. The attempt that reaches
    /// it is the one that stops: the row lands in `failed` and is marked
    /// permanent, so the queue stops re-driving an object that will never move.
    #[serde(default = "default_attachment_attempts")]
    pub attachment_attempts: i64,
    /// This client's identifier, which seeds a store that keeps none. From the
    /// first open on, the store's kept identity wins: see [`crate::SyncEngine::new`].
    pub client_id: String,
}

/// The attachment budget an [`EngineConfig`] carries when it names none.
const fn default_attachment_attempts() -> i64 {
    DEFAULT_ATTACHMENT_ATTEMPTS
}

/// The closed union of events an [`EventHandler`] receives. Mirrors the wire
/// event union in `packages/core/src/wire/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EngineEvent {
    /// A local write (apply, revert, or pull commit) changed `_kizunasync_rows`.
    LocalChanged,
    /// A queued write was journalled to `_kizunasync_rejections` (dead-lettered or
    /// otherwise rejected) without being dead-lettered itself.
    MutationRejected {
        /// The rejected mutation's exactly-once identifier.
        mutation_id: String,
        /// Why the mutation was rejected.
        reason: String,
    },
    /// The outbox depth changed; `depth` is the new value.
    QueueDepth {
        /// The new outbox depth.
        depth: usize,
    },
    /// The store is soft-blocked until a reset: the server's schema gate
    /// refused this client, or a token named another user than the store's
    /// owner.
    ResetRequired {
        /// Which of the two latched the block, the value
        /// [`crate::SyncEngine::soft_block_reason`] reports. Optional on the
        /// wire: the field is left out when there is none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<SoftBlockReason>,
    },
    /// The server cannot serve from the client's cursor: the retention window passed.
    CheckpointExpired,
    /// An atomic push batch was rejected as a whole; every member was reverted.
    /// Carries the offender the abort named. The client surface is the same
    /// closed union, declared once as `BATCH_ABORTED` in
    /// `packages/core/src/wire/types.ts`.
    BatchAborted {
        /// The mutation the abort named as the offender.
        offender_mutation_id: String,
        /// Why the batch was aborted.
        reason: String,
    },
    /// `sync()`'s retry budget dropped a queued write the server definitively
    /// rejects; the optimistic local row was reverted to its pre-image.
    DeadLetter {
        /// The dropped mutation's exactly-once identifier.
        mutation_id: String,
        /// Why the write was dropped.
        reason: String,
    },
    /// A pull page carried an D-conflict-journal-visibility journal loser for a column this checkpoint
    /// just committed. Persisted on `_kizunasync_overwrites`; does not address the
    /// losing device. Never raised for a conflict one of the last 1000 writes
    /// this device pushed and saw applied won.
    ColumnOverwritten {
        /// The synced table the overwritten column belongs to.
        table: String,
        /// The row's primary key.
        pk: String,
        /// The overwritten column's name.
        column: String,
        /// The losing device's value for `column`.
        loser_value: serde_json::Value,
        /// The winning mutation's exactly-once identifier.
        winner_mutation_id: String,
        /// The conflict-resolution mode that produced this overwrite.
        conflict_mode: String,
    },
}

impl EngineEvent {
    /// Oracle-facing event name, identical to the serde `type` tag.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::LocalChanged => "LOCAL_CHANGED",
            Self::MutationRejected { .. } => "MUTATION_REJECTED",
            Self::QueueDepth { .. } => "QUEUE_DEPTH",
            Self::ResetRequired { .. } => "RESET_REQUIRED",
            Self::CheckpointExpired => "CHECKPOINT_EXPIRED",
            Self::BatchAborted { .. } => "BATCH_ABORTED",
            Self::DeadLetter { .. } => "DEAD_LETTER",
            Self::ColumnOverwritten { .. } => "COLUMN_OVERWRITTEN",
        }
    }

    /// Every producer name, in the same order as `packages/protocol/spec/engine-events.json`.
    #[must_use]
    pub const fn all_names() -> &'static [&'static str] {
        &[
            "LOCAL_CHANGED",
            "MUTATION_REJECTED",
            "QUEUE_DEPTH",
            "RESET_REQUIRED",
            "CHECKPOINT_EXPIRED",
            "BATCH_ABORTED",
            "DEAD_LETTER",
            "COLUMN_OVERWRITTEN",
        ]
    }
}

/// Why a store is soft-blocked: it makes no pull or push call until
/// [`crate::SyncEngine::reset`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum SoftBlockReason {
    /// The server's schema gate answered `RESET_REQUIRED`.
    ResetRequired,
    /// A token named another user than the one the store belongs to.
    IdentityChanged,
}

impl SoftBlockReason {
    /// The spelling the store keeps and the checkpoint reports, identical to
    /// the serde form.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ResetRequired => "reset_required",
            Self::IdentityChanged => "identity_changed",
        }
    }

    /// The reason `text` spells, or `None` for text outside the closed set.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        [Self::ResetRequired, Self::IdentityChanged]
            .into_iter()
            .find(|reason| reason.as_str() == text)
    }
}

/// Engine event sink. The auto-trait bounds follow the target, like every other
/// shared engine value: see [`MaybeSendSync`].
#[cfg(not(target_arch = "wasm32"))]
pub type EventHandler = Arc<dyn Fn(EngineEvent) + Send + Sync>;

/// Engine event sink. The auto-trait bounds follow the target, like every other
/// shared engine value: see [`MaybeSendSync`].
#[cfg(target_arch = "wasm32")]
pub type EventHandler = Arc<dyn Fn(EngineEvent)>;

/// RFC3339 UTC timestamp source for pull, dead-letter, attachment and
/// soft-delete bookkeeping; a local write's outbox entry reads `now_millis`.
#[cfg(not(target_arch = "wasm32"))]
pub type NowFn = Box<dyn Fn() -> String + Send + Sync>;

/// RFC3339 UTC timestamp source for pull, dead-letter, attachment and
/// soft-delete bookkeeping; a local write's outbox entry reads `now_millis`.
#[cfg(target_arch = "wasm32")]
pub type NowFn = Box<dyn Fn() -> String>;

/// Epoch-millisecond source for the rejection journal's `at` column, and the
/// one clock read a local write stamps its outbox `created_at` and origin HLC
/// from.
#[cfg(not(target_arch = "wasm32"))]
pub type NowMillisFn = Box<dyn Fn() -> i64 + Send + Sync>;

/// Epoch-millisecond source for the rejection journal's `at` column, and the
/// one clock read a local write stamps its outbox `created_at` and origin HLC
/// from.
#[cfg(target_arch = "wasm32")]
pub type NowMillisFn = Box<dyn Fn() -> i64>;

/// Mutation/batch identifier source.
#[cfg(not(target_arch = "wasm32"))]
pub type UuidFn = Box<dyn Fn() -> String + Send + Sync>;

/// Mutation/batch identifier source.
#[cfg(target_arch = "wasm32")]
pub type UuidFn = Box<dyn Fn() -> String>;

/// The wire transport a [`crate::SyncEngine`] pulls and pushes through.
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
pub trait ProtocolRemote: MaybeSendSync {
    /// Issues one pull request.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when the transport fails or the server
    /// rejects the request.
    async fn pull(&self, req: PullRequest) -> Result<PullResponse, EngineError>;
    /// Issues one push request.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when the transport fails or the server
    /// rejects the request.
    async fn push(&self, req: PushRequest) -> Result<PushResponse, EngineError>;
    /// Replace the user JWT used on the next pull/push. Default is a no-op
    /// (scripted remotes have no Authorization header).
    fn set_access_token(&self, _token: Option<String>) {}
}

/// Injected clock and identifier sources, so every stamp a fixed-clock test
/// asserts on comes from one call site instead of `SystemTime::now()` or
/// `Uuid::new_v4()` scattered through the engine.
pub struct EngineDeps {
    /// RFC3339 UTC timestamp source for pull, push reconciliation, dead-letter,
    /// attachment and soft-delete bookkeeping; a local write's outbox entry
    /// reads `now_millis`.
    pub now: NowFn,
    /// Epoch-millisecond source for the rejection journal's `at` column, and the
    /// one clock read a local write stamps its outbox `created_at` and origin
    /// HLC from.
    pub now_millis: NowMillisFn,
    /// Mutation/batch identifier source.
    pub uuid: UuidFn,
}

impl Default for EngineDeps {
    fn default() -> Self {
        Self {
            now: Box::new(now_rfc3339),
            now_millis: Box::new(epoch_millis),
            uuid: Box::new(random_uuid_v4),
        }
    }
}
