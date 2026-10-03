use thiserror::Error;

/// Everything a [`crate::LocalStore`] call can fail with.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum StoreError {
    /// The underlying `SQLite` driver failed (open, prepare, or execute).
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// A stored JSON payload could not be encoded or decoded.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// A caller violated a store-level invariant (for example, an insert onto
    /// an existing row, or an attachment patch naming an unpatchable column).
    #[error("constraint: {0}")]
    Constraint(String),
    /// A stored row carries a value outside one of the closed vocabularies
    /// ([`crate::AttachmentState`], [`crate::RejectionKind`], or the wire
    /// `Op`). The set is closed, so this is local corruption rather than an
    /// unrecognised new member, and it carries the column name because the
    /// engine fails an unknown `op` under its own code: sending a queued write
    /// under an operation its row does not name would ship the server
    /// something the app never made.
    #[error("stored `{column}` carries an unknown value \"{value}\"")]
    UnknownVocabulary {
        /// The `SQLite` column the value was read from.
        column: &'static str,
        /// The text the column held.
        value: String,
    },
    /// A store operation the current build target cannot perform at all, as
    /// opposed to one that failed. The one such operation is the synchronous
    /// [`crate::LocalStore::open_path`] on `wasm32`: installing a persistent
    /// VFS (OPFS or `IndexedDB`) is asynchronous, so a synchronous open cannot
    /// wait for it; use `LocalStore::open_path_async` instead (`wasm32`-only,
    /// so not linkable from a native doc build).
    #[error("unsupported on this target: {0}")]
    Unsupported(&'static str),
    /// Neither persistent VFS could be installed on `wasm32`: the OPFS
    /// sahpool needs synchronous access handles (a dedicated worker with
    /// OPFS), the `IndexedDB` fallback needs `IndexedDB`. Both errors travel
    /// so the host can show why the browser has no durable store.
    #[error(
        "wasm store: no persistent VFS available (opfs-sahpool: {sahpool}; relaxed-idb: {relaxed_idb})"
    )]
    VfsUnavailable {
        /// Why the OPFS synchronous-access-handle pool VFS failed.
        sahpool: String,
        /// Why the relaxed-durability `IndexedDB` VFS failed.
        relaxed_idb: String,
    },
    /// The OPFS sahpool for `name` is exclusively held by another browser
    /// context (often a reloading tab still releasing its sync access
    /// handles) even after ten install attempts, nine 200 ms waits between
    /// them, about 1.8 s total. Falling back to `IndexedDB` here would
    /// silently swap the durable OPFS store for an empty one, so this fails
    /// loud instead and names the database so the host can retry or surface
    /// the conflict.
    #[error("wasm store: OPFS store for {name:?} is held by another browser context")]
    VfsBusy {
        /// The database name the OPFS sahpool is held for.
        name: String,
    },
}
