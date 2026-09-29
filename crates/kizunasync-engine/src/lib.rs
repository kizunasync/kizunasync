//! Kizuna sync engine: local apply, query-in-Rust, pull/push over `ProtocolRemote`.
//!
//! [`SyncEngine`] is `Send` and not `Sync` on a native target, so a handle moves
//! between threads and a host that shares one guards it with its own mutex; the
//! wasm32 build carries neither auto trait, because the browser engine never
//! leaves its thread.
//!
//! # Allocation
//!
//! Allocation-conscious. The engine is not heapless: `SQLite`, Tokio, and JSON
//! all allocate. Tokio is a runtime dependency with the workspace feature set
//! (`sync`, `macros`, `io-util`, `rt`, `time`). `rt-multi-thread` is a
//! dev-dependency only, for tests that need a multi-thread executor. wasm32 uses
//! the same crate with that slim feature set.

#![forbid(unsafe_code)]

mod attachment_queue;
mod attachment_watchers;
pub mod bridge;
pub mod clock;
mod config;
mod engine;
mod error;
pub mod error_catalog;
#[cfg(not(target_arch = "wasm32"))]
mod host_runtime;
pub mod platform;
pub mod remote_envelope;
pub mod rpc;
pub mod rpc_methods;
mod scripted_remote;
mod time;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

pub use attachment_queue::{
    AttachmentBytes, AttachmentStatus, EnqueueUpload, FromFileResult, FsAttachmentBytes,
    MapAttachmentBytes,
};
pub use attachment_watchers::{AttachmentDelivery, AttachmentWatchers};
pub use config::{
    AttachmentSpec, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineEvent,
    EventHandler, NowFn, NowMillisFn, ProtocolRemote, SoftBlockReason, SyncMode, TableConfig,
    UuidFn, arrival_mode,
};
pub use engine::{ApplyWhere, SyncEngine};
pub use error::EngineError;
pub use error_catalog::{CATALOG, CatalogEntry};
#[cfg(not(target_arch = "wasm32"))]
pub use host_runtime::current_thread_runtime;
/// The closed conflict-resolution vocabulary a [`TableConfig`] declares, owned
/// by the protocol crate so the engine and the wire spell it one way.
pub use kizunasync_protocol::ConflictMode;
pub use scripted_remote::ScriptedRemote;
