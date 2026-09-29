//! Local `SQLite` store: rows, outbox, checkpoint, tombstones, attachments, rejections.
//!
//! # Allocation
//!
//! Allocation-conscious: `SQLite` and JSON maps allocate. Not heapless.
//!
//! # Concurrency
//!
//! [`LocalStore`] is `Send` and not `Sync` (it owns a `rusqlite::Connection`),
//! so one store serves one thread at a time.

#![forbid(unsafe_code)]

mod error;
mod mapping;
mod schema;
mod store;
mod transaction;
mod transforms;
mod types;

// Not `#[cfg(target_arch = "wasm32")]`-gated as a whole: the directory-name
// derivation and browser-error classification are plain functions a native
// unit test exercises directly; only the wasm-bindgen-dependent items inside
// are individually gated.
mod wasm_vfs;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

pub use error::StoreError;
pub use schema::{CLIENT_ID_KEY, ORIGIN_HLC_KEY};
pub use store::{LocalStore, PUSHED_IDS_KEPT};
pub use transforms::{TransformError, apply_transforms};
pub use types::{
    AttachmentEntry, AttachmentFailure, AttachmentState, DEAD_LETTER_KIND, DeadLetterEntry,
    DeadLetterRecord, LocalMutation, LocalRow, NewOverwrite, OutboxEntry, OverwriteRecord,
    RejectionKind, RejectionRecord, op_as_str,
};

/// Which `SQLite` VFS backs a [`LocalStore`] connection.
///
/// Native builds only ever produce [`Self::Memory`] or [`Self::File`]; wasm32
/// builds add the two persistent browser-only backends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum VfsKind {
    /// The `:memory:` VFS: nothing survives the process.
    Memory,
    /// The native OS filesystem VFS.
    File,
    /// The OPFS synchronous-access-handle pool VFS (wasm32, dedicated worker only).
    OpfsSahPool,
    /// The relaxed-durability `IndexedDB` VFS (wasm32 fallback).
    RelaxedIdb,
}

impl VfsKind {
    /// Durability a caller can rely on for a write acknowledged on this VFS.
    #[must_use]
    pub const fn durability(self) -> &'static str {
        match self {
            Self::Memory => "none",
            Self::File | Self::OpfsSahPool => "full",
            Self::RelaxedIdb => "relaxed",
        }
    }

    /// Stable machine-readable name, used in wire responses and diagnostics.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::File => "file",
            Self::OpfsSahPool => "opfs-sahpool",
            Self::RelaxedIdb => "relaxed-idb",
        }
    }
}
