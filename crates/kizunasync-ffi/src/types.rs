//! `UniFFI` records, events, and host-implemented observers.

use kizunasync_engine::{AttachmentStatus, EngineEvent, FromFileResult};
use kizunasync_store::RejectionRecord;

/// The one error every exported method throws. `code` is a
/// [`kizunasync_engine::error_catalog`] member, so a host switches on it and never on
/// `msg`.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum KizunaSyncFfiError {
    /// An engine fault, carrying its catalog code and its message.
    #[error("{code}: {msg}")]
    Engine {
        /// The catalog code, stable across every binding.
        code: String,
        /// The human-readable detail. Never classify on it.
        msg: String,
    },
}

impl KizunaSyncFfiError {
    pub(crate) fn engine(code: impl Into<String>, msg: impl Into<String>) -> Self {
        Self::Engine {
            code: code.into(),
            msg: msg.into(),
        }
    }
}

/// The engine's own classification, unchanged: `code()` is what each binding's
/// Errors table promises, so a refused config arrives as `CONFIG_INVALID` and a
/// store that will not open keeps the store's code.
impl From<kizunasync_engine::EngineError> for KizunaSyncFfiError {
    fn from(error: kizunasync_engine::EngineError) -> Self {
        Self::engine(error.code(), error.to_string())
    }
}

/// The pull cursor and whether the engine is holding writes back.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiCheckpoint {
    /// The opaque cursor token the next pull sends.
    pub cursor: String,
    /// `true` while the engine refuses new writes until the host resolves the
    /// rejection journal.
    pub soft_blocked: bool,
    /// Why the engine is soft-blocked: `reset_required` when the server's schema
    /// gate asked for a reset, `identity_changed` when a token named another
    /// user than the one the store belongs to. `None` while it is not.
    pub soft_block_reason: Option<String>,
}

/// One entry of the rejection journal: a local write the server refused.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiRejection {
    /// The refused mutation.
    pub mutation_id: String,
    /// The table it targeted.
    pub table: String,
    /// The row it targeted.
    pub pk: String,
    /// How the server refused it (a verdict, an abort).
    pub kind: String,
    /// The server's reason code.
    pub reason: String,
    /// The columns the write would have changed.
    pub changed_columns: Vec<String>,
    /// The authoritative row as JSON, or an empty string when the server sent
    /// none.
    pub server_row_json: String,
    /// When the journal recorded it, in epoch milliseconds.
    pub at: i64,
    /// `true` once the host dismissed it.
    pub dismissed: bool,
}

impl From<RejectionRecord> for FfiRejection {
    fn from(record: RejectionRecord) -> Self {
        Self {
            mutation_id: record.mutation_id,
            table: record.table,
            pk: record.pk,
            kind: record.kind.as_str().to_owned(),
            reason: record.reason,
            changed_columns: record.changed_columns,
            server_row_json: record
                .server_row
                .map(|row| serde_json::Value::Object(row).to_string())
                .unwrap_or_default(),
            at: record.at,
            dismissed: record.dismissed,
        }
    }
}

/// Where one attachment reference stands right now.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiAttachmentStatus {
    /// `queued`, `uploading`, `downloading`, `synced`, `failed`, `orphaned`,
    /// `evicted` (this device dropped its copy and keeps the object in
    /// Storage), or `missing` when no row carries the reference.
    pub state: String,
    /// Bytes transferred so far.
    pub progress: i64,
    /// The last failure's message, when there was one.
    pub error: Option<String>,
    /// The sandbox path holding the bytes, when they are local.
    pub local_path: Option<String>,
    /// Whether the transfer budget stopped this reference for good. A `failed`
    /// row is retried by the next drive; a permanent one waits for the app.
    pub permanent: bool,
    /// The engine catalog code of the last recorded failure, `None` while the
    /// row records none.
    pub error_code: Option<String>,
}

impl From<AttachmentStatus> for FfiAttachmentStatus {
    fn from(status: AttachmentStatus) -> Self {
        Self {
            state: status.state.as_str().to_owned(),
            progress: status.progress,
            error: status.error,
            local_path: status.local_path,
            permanent: status.permanent,
            error_code: status.error_code,
        }
    }
}

/// What importing a host file produced: the Storage reference the column now
/// holds, plus the sandbox copy's metadata.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiFromFileResult {
    /// The Storage object key the row's column carries.
    pub reference: String,
    /// The content hash the confirm step records.
    pub sha256: String,
    /// The byte length of the imported file.
    pub size: i64,
    /// The media type the upload declares.
    pub media_type: String,
    /// The sandbox path holding the bytes.
    pub local_path: String,
}

impl From<FromFileResult> for FfiFromFileResult {
    fn from(result: FromFileResult) -> Self {
        Self {
            reference: result.reference,
            sha256: result.sha256,
            size: result.size,
            media_type: result.media_type,
            local_path: result.local_path,
        }
    }
}

/// FFI copy of [`EngineEvent`]. `loser_value` stays JSON because `UniFFI` has no
/// `serde_json::Value`.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum FfiEngineEvent {
    /// The local store changed; re-read what is on screen.
    LocalChanged,
    /// The server refused one mutation, which is now in the journal.
    MutationRejected {
        /// The refused mutation.
        mutation_id: String,
        /// The server's reason code.
        reason: String,
    },
    /// The outbox depth after a push or an apply.
    QueueDepth {
        /// How many mutations are still queued.
        depth: u32,
    },
    /// The engine soft-blocked until the host resets the store.
    ResetRequired {
        /// `reset_required` when the server's schema gate asked for a reset,
        /// `identity_changed` when a token named another user than the one the
        /// store belongs to.
        reason: Option<String>,
    },
    /// The cursor is older than the server's retention window.
    CheckpointExpired,
    /// An atomic batch was refused whole.
    BatchAborted {
        /// The member the server blamed.
        offender_mutation_id: String,
        /// The server's reason code.
        reason: String,
    },
    /// A mutation exhausted the retry budget and was dropped.
    DeadLetter {
        /// The dropped mutation.
        mutation_id: String,
        /// Why it was dropped.
        reason: String,
    },
    /// A concurrent write won one column and the local value was overwritten.
    ColumnOverwritten {
        /// The row's table.
        table: String,
        /// The row's primary key.
        pk: String,
        /// The column that changed owner.
        column: String,
        /// The value that lost, as JSON.
        loser_value_json: String,
        /// The mutation that won.
        winner_mutation_id: String,
        /// The conflict rule that decided it.
        conflict_mode: String,
    },
}

impl From<EngineEvent> for FfiEngineEvent {
    fn from(event: EngineEvent) -> Self {
        match event {
            EngineEvent::LocalChanged => Self::LocalChanged,
            EngineEvent::MutationRejected {
                mutation_id,
                reason,
            } => Self::MutationRejected {
                mutation_id,
                reason,
            },
            // A display counter: a queue past 4 billion entries reports the cap
            // rather than failing an event the host cannot act on anyway.
            EngineEvent::QueueDepth { depth } => Self::QueueDepth {
                depth: u32::try_from(depth).unwrap_or(u32::MAX),
            },
            EngineEvent::ResetRequired { reason } => Self::ResetRequired {
                reason: reason.map(|reason| reason.as_str().to_owned()),
            },
            EngineEvent::CheckpointExpired => Self::CheckpointExpired,
            EngineEvent::BatchAborted {
                offender_mutation_id,
                reason,
            } => Self::BatchAborted {
                offender_mutation_id,
                reason,
            },
            EngineEvent::DeadLetter {
                mutation_id,
                reason,
            } => Self::DeadLetter {
                mutation_id,
                reason,
            },
            EngineEvent::ColumnOverwritten {
                table,
                pk,
                column,
                loser_value,
                winner_mutation_id,
                conflict_mode,
            } => Self::ColumnOverwritten {
                table,
                pk,
                column,
                loser_value_json: loser_value.to_string(),
                winner_mutation_id,
                conflict_mode,
            },
        }
    }
}

/// Synchronous host observer. `UniFFI` 0.31 + Swift 6 cannot export async foreign
/// traits (`#SendingClosureRisksDataRace`).
///
/// `on_event` runs on the handle's delivery thread, one event at a time and in
/// emission order, never on the thread that made the call. It may call back
/// into the handle. A slow observer delays the events and statuses queued
/// after it, so an observer with real work hands the event to its own queue
/// and returns. A failing observer drops its own event, and the events after it
/// still arrive.
#[uniffi::export(with_foreign)]
pub trait EventObserver: Send + Sync {
    /// Receive one engine event.
    fn on_event(&self, event: FfiEngineEvent);
}

/// Per-ref attachment progress. Distinct from [`EventObserver`]: a download's
/// percent is not a global `LOCAL_CHANGED`.
///
/// `on_status` runs on the handle's delivery thread, in emission order with
/// the engine events, so it may call back into the handle. A failing listener
/// drops its own status, and the statuses after it still arrive.
#[uniffi::export(with_foreign)]
pub trait AttachmentListener: Send + Sync {
    /// Receive the reference's current status.
    fn on_status(&self, status: FfiAttachmentStatus);
}
