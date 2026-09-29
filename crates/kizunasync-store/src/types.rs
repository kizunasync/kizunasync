use crate::error::StoreError;
use kizunasync_protocol::{ColumnValues, Op};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::str::FromStr;

// MARK: - Closed vocabularies

/// The `SQLite` text one [`Op`] is stored as, identical to the wire rename so a
/// queued row and the mutation it becomes spell the operation the same way.
///
/// The store reuses the protocol's [`Op`] rather than declaring a second enum:
/// `_kizunasync_outbox.op` and `_kizunasync_dead_letter.op` hold exactly the wire
/// vocabulary, and a parallel type would only add a conversion free to drift.
/// [`Op`] lives in another crate, so its text form is this function rather than
/// an inherent method.
#[must_use]
pub const fn op_as_str(op: Op) -> &'static str {
    match op {
        Op::Insert => "insert",
        Op::Update => "update",
        Op::Delete => "delete",
    }
}

/// Read one closed-vocabulary `column` back from the text a row stored.
///
/// The row mappers go through here rather than through [`FromStr`] directly so
/// a corrupt column names itself: the engine keys its machine-readable code off
/// `column`, and a caller-supplied bad value stays a plain constraint.
///
/// # Errors
///
/// [`StoreError::UnknownVocabulary`] when `raw` is outside the set.
pub(crate) fn stored<T: FromStr>(column: &'static str, raw: &str) -> Result<T, StoreError> {
    raw.parse().map_err(|_| StoreError::UnknownVocabulary {
        column,
        value: raw.to_owned(),
    })
}

/// How a queued write died, as `_kizunasync_rejections.kind` records it.
///
/// Mirrors `ERejectionKind` in `packages/core/src/wire/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RejectionKind {
    /// A per-mutation verdict refused the write.
    Rejected,
    /// A per-mutation verdict refused the write because a newer one had already
    /// landed on the row.
    Superseded,
    /// An atomic batch aborted, and this write was the offender the abort named.
    BatchAborted,
    /// The `sync()` retry budget dropped the write after its attempts ran out.
    DeadLetter,
}

impl RejectionKind {
    /// The stored text, byte for byte what the column and the wire carry.
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Rejected => "REJECTED",
            Self::Superseded => "SUPERSEDED",
            Self::BatchAborted => "BATCH_ABORTED",
            Self::DeadLetter => "DEAD_LETTER",
        }
    }
}

impl FromStr for RejectionKind {
    type Err = StoreError;

    /// # Errors
    ///
    /// [`StoreError::Constraint`] when `raw` is outside the closed vocabulary.
    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "REJECTED" => Ok(Self::Rejected),
            "SUPERSEDED" => Ok(Self::Superseded),
            "BATCH_ABORTED" => Ok(Self::BatchAborted),
            "DEAD_LETTER" => Ok(Self::DeadLetter),
            other => Err(StoreError::Constraint(format!(
                "unknown rejection kind \"{other}\""
            ))),
        }
    }
}

/// Where one attachment stands, as `_kizunasync_attachments.state` records it.
///
/// Mirrors `EAttachmentState` in `packages/core/src/wire/types.ts`, plus
/// [`Self::Missing`]. That vocabulary has no member for it because it is never
/// a stored row: it is the status a reference with no [`AttachmentEntry`] is
/// reported under, so a watcher is always handed a state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentState {
    /// Waiting for a drive to claim it.
    Queued,
    /// Claimed, with bytes on their way up.
    Uploading,
    /// Claimed, with bytes on their way down.
    Downloading,
    /// The object is confirmed on Storage and the bytes are cached locally.
    Synced,
    /// The last transfer failed. Retryable unless `permanent` is also set.
    Failed,
    /// No row references the object any more: the vacuum deletes it.
    Orphaned,
    /// This device dropped its copy without server evidence that the object
    /// is garbage: the vacuum deletes the cached bytes and never touches the
    /// Storage object. The row keeps the hash, size and media type, so a pull
    /// that carries the reference again downloads and verifies it.
    Evicted,
    /// No queue row carries the reference at all. Never written to `SQLite`.
    Missing,
}

impl AttachmentState {
    /// The stored text, byte for byte what the column and the bridges carry.
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Uploading => "uploading",
            Self::Downloading => "downloading",
            Self::Synced => "synced",
            Self::Failed => "failed",
            Self::Orphaned => "orphaned",
            Self::Evicted => "evicted",
            Self::Missing => "missing",
        }
    }
}

impl FromStr for AttachmentState {
    type Err = StoreError;

    /// # Errors
    ///
    /// [`StoreError::Constraint`] when `raw` is outside the closed vocabulary.
    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "queued" => Ok(Self::Queued),
            "uploading" => Ok(Self::Uploading),
            "downloading" => Ok(Self::Downloading),
            "synced" => Ok(Self::Synced),
            "failed" => Ok(Self::Failed),
            "orphaned" => Ok(Self::Orphaned),
            "evicted" => Ok(Self::Evicted),
            "missing" => Ok(Self::Missing),
            other => Err(StoreError::Constraint(format!(
                "unknown attachment state \"{other}\""
            ))),
        }
    }
}

// MARK: - Rows

/// One row of `_kizunasync_rows`: the local mirror's current value for a table/pk pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct LocalRow {
    /// The synced table this row belongs to.
    pub table: String,
    /// The row's primary key.
    pub pk: String,
    /// The row's current column values.
    pub columns: ColumnValues,
}

/// One row of `_kizunasync_outbox`: a locally-applied write not yet confirmed pushed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct OutboxEntry {
    /// The `_kizunasync_outbox` autoincrement sequence, used for FIFO ordering.
    pub seq: i64,
    /// The mutation's exactly-once identifier.
    pub mutation_id: String,
    /// The synced table this write targets.
    pub table: String,
    /// The row's primary key.
    pub pk: String,
    /// The write kind.
    pub op: Op,
    /// The write's column values (the full row for insert, the patch for update).
    pub columns: ColumnValues,
    /// D-field-transforms field transforms (increment, `arrayUnion`, `arrayRemove`) to apply
    /// on top of `columns`.
    #[serde(default)]
    pub transforms: Option<serde_json::Map<String, serde_json::Value>>,
    /// An optimistic-concurrency precondition the server checks before applying.
    pub precondition: Option<ColumnValues>,
    /// The atomic-batch identifier, shared by every member of one push batch.
    pub batch_id: Option<String>,
    /// The row's committed value immediately before this write, for compensating reverts.
    pub pre_image: Option<ColumnValues>,
    /// The hybrid logical clock stamp D-conflict-journal-visibility conflict resolution reads.
    pub hlc: Option<String>,
    /// When the local write was applied: the devtools inspector shows queue age,
    /// so an entry without it would be a blank column, not a smaller payload.
    pub created_at: String,
}

/// A caller-issued write before it is journalled to the outbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalMutation {
    /// The synced table this write targets.
    pub table: String,
    /// The row's primary key.
    pub pk: String,
    /// The write kind.
    pub op: Op,
    /// The write's column values (the full row for insert, the patch for update).
    pub columns: ColumnValues,
    /// D-field-transforms field transforms to apply on top of `columns`.
    #[serde(default)]
    pub transforms: Option<serde_json::Map<String, serde_json::Value>>,
    /// An optimistic-concurrency precondition the server checks before applying.
    #[serde(default)]
    pub precondition: Option<ColumnValues>,
    /// The atomic-batch identifier, shared by every member of one push batch.
    #[serde(default)]
    pub batch_id: Option<String>,
    /// The hybrid logical clock stamp D-conflict-journal-visibility conflict resolution reads.
    #[serde(default)]
    pub hlc: Option<String>,
    /// The exactly-once identifier, generated by the caller when absent.
    #[serde(default)]
    pub mutation_id: Option<String>,
}

/// The machine-readable [`RejectionRecord::kind`] a dropped outbox entry
/// carries into its rejection journal row.
pub const DEAD_LETTER_KIND: &str = RejectionKind::DeadLetter.as_str();

/// One journalled rejection (a row of `_kizunasync_rejections`).
///
/// Engine events are fire-and-forget, so this record is the durable trace an app
/// reads to explain a lost write. `changed_columns` are the columns the mutation
/// carried, `server_row` is the authoritative row the verdict carried (if any),
/// `at` is epoch milliseconds, and `dismissed` is the user's acknowledgement.
/// Mirrors `TRejectionRecord` in `packages/core/src/wire/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RejectionRecord {
    /// The rejected mutation's exactly-once identifier.
    pub mutation_id: String,
    /// The synced table the rejected write targeted.
    pub table: String,
    /// The row's primary key.
    pub pk: String,
    /// The machine-readable rejection kind.
    pub kind: RejectionKind,
    /// A human-readable explanation of the rejection.
    pub reason: String,
    /// The columns the rejected mutation carried.
    pub changed_columns: Vec<String>,
    /// The authoritative row the verdict carried, if any.
    pub server_row: Option<ColumnValues>,
    /// Epoch milliseconds when the rejection was journalled.
    pub at: i64,
    /// Whether the user acknowledged this rejection.
    pub dismissed: bool,
}

/// One journalled column overwrite (a row of `_kizunasync_overwrites`).
///
/// The loser of an D-conflict-journal-visibility column resolution: a value this device wrote that a
/// peer's push replaced. Not keyed by a `mutation_id` of ours, because the
/// winner is somebody else's write, so the row carries its own autoincrement
/// `id` and that is what `dismiss_overwrite` acknowledges.
/// Mirrors `TOverwriteRecord` in `packages/core/src/wire/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[non_exhaustive]
pub struct OverwriteRecord {
    /// The journal row's own identifier.
    pub id: i64,
    /// The synced table the overwritten row belongs to.
    pub table: String,
    /// The row's primary key.
    pub pk: String,
    /// The column whose value was replaced.
    pub column: String,
    /// The value this device lost.
    pub loser_value: Value,
    /// The winning peer write's exactly-once identifier.
    pub winner_mutation_id: String,
    /// The resolution mode that decided it (`arrival` or `hlc`).
    pub conflict_mode: String,
    /// The changelog sequence the winning value arrived on, when the pull page
    /// carried one.
    pub winner_seq: Option<String>,
    /// Epoch milliseconds when the overwrite was journalled.
    pub at: i64,
    /// Whether the user acknowledged this overwrite.
    pub dismissed: bool,
}

/// One overwrite as a pull journals it: everything an [`OverwriteRecord`] reads
/// back except the journal's own `id` and `dismissed` flag.
#[derive(Debug, Clone)]
pub struct NewOverwrite<'a> {
    /// The synced table the overwritten row belongs to.
    pub table: &'a str,
    /// The row's primary key.
    pub pk: &'a str,
    /// The column whose value was replaced.
    pub column: &'a str,
    /// The value this device lost.
    pub loser_value: &'a Value,
    /// The winning peer write's exactly-once identifier.
    pub winner_mutation_id: &'a str,
    /// The resolution mode that decided it (`arrival` or `hlc`).
    pub conflict_mode: &'a str,
    /// The changelog sequence the winning value arrived on, when the pull page
    /// carried one.
    pub winner_seq: Option<&'a str>,
    /// Epoch milliseconds when the overwrite is journalled.
    pub at: i64,
}

/// One doomed outbox entry plus the stamps its death is recorded with.
///
/// The pair of rows `sync()`'s dead-letter budget writes: a
/// `_kizunasync_dead_letter` row (the forensic copy of the dropped write) and a
/// `_kizunasync_rejections` row (the user-facing "what happened to my write" journal).
#[derive(Debug, Clone)]
pub struct DeadLetterRecord {
    /// The outbox entry that was dropped.
    pub entry: OutboxEntry,
    /// Why the write was dropped.
    pub reason: String,
    /// RFC3339 stamp for the dead-letter row.
    pub created_at: String,
    /// Epoch milliseconds for the rejection journal's `at` column.
    pub at: i64,
}

/// One row of `_kizunasync_dead_letter`, oldest first.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[non_exhaustive]
pub struct DeadLetterEntry {
    /// The dropped mutation's exactly-once identifier.
    pub mutation_id: String,
    /// The synced table the dropped write targeted.
    pub table: String,
    /// The row's primary key.
    pub pk: String,
    /// The write kind the dropped mutation carried.
    pub op: Op,
    /// The write's column values at the time it was dropped.
    pub columns: ColumnValues,
    /// Why the write was dropped.
    pub reason: String,
    /// The authoritative row the verdict carried, if any.
    pub server_row: Option<ColumnValues>,
    /// RFC3339 stamp for when the write was dropped.
    pub created_at: String,
}

/// Durable attachment queue row (upload or download).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentEntry {
    /// The attachment's stable reference (its `_kizunasync_attachments` primary key).
    pub reference: String,
    /// The TUS/Storage upload identifier this reference resumes.
    pub upload_id: String,
    /// The synced table the owning row belongs to.
    pub table: String,
    /// The owning row's primary key.
    pub pk: String,
    /// The owning row's column that references this attachment.
    pub column: String,
    /// The Supabase Storage bucket the object lives in.
    pub bucket: String,
    /// The row column value that owns the object key.
    pub owner: String,
    /// The object's content hash, once known.
    pub sha256: Option<String>,
    /// The object's MIME type, once known.
    pub content_type: Option<String>,
    /// The object's byte size, once known.
    pub size: Option<i64>,
    /// The sandboxed local file path caching the object's bytes.
    pub local_path: Option<String>,
    /// `"upload"` or `"download"`.
    pub direction: String,
    /// The queue row's lifecycle state.
    pub state: AttachmentState,
    /// Whether a drive currently holds this row's claim.
    pub in_flight: bool,
    /// The content-addressing fingerprint that dedupes sandbox files.
    pub fingerprint: Option<String>,
    /// Bytes transferred so far, for a resumable transfer.
    pub progress: i64,
    /// How many claim attempts this row has consumed.
    pub attempts: i64,
    /// Whether the transfer budget stopped this row for good. A permanent row is
    /// skipped by every candidate query, so nothing re-drives it until the app
    /// retries it by hand.
    pub permanent: bool,
    /// The TUS resume offset; 0 until a chunked upload begins.
    pub chunk_offset: i64,
    /// The TUS resume endpoint, once an upload has started.
    pub tus_url: Option<String>,
    /// The last transfer error, if any.
    pub error: Option<String>,
    /// RFC3339 stamp for when the row was enqueued.
    pub created_at: String,
    /// RFC3339 stamp for the row's last update.
    pub updated_at: String,
    /// The engine catalog code of the last recorded failure, `None` while the
    /// row records none.
    #[serde(default)]
    pub error_code: Option<String>,
}

/// One failure a queue row records: the message an app reads and the engine
/// catalog code it can branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentFailure<'a> {
    /// What went wrong, in words.
    pub message: &'a str,
    /// The engine catalog code naming the condition.
    pub code: &'a str,
}
