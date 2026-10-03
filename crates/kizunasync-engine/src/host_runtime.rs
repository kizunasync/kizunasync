//! Hosts construct a current-thread runtime around the engine. The engine
//! never holds it, never spawns on it, and never `block_on`s inside library
//! code; FFI and N-API own the `Runtime` value.

use crate::EngineError;

/// A single-thread Tokio runtime for one engine handle.
///
/// The time driver is always on. The IO driver is on only when a crate in the
/// build graph enables Tokio's `net` feature: the native HTTP transport
/// (`kizunasync-remote-http`, behind the FFI `http` feature) pulls it in through
/// `reqwest`, and a build without that crate gets a runtime that drives timers
/// but no sockets.
///
/// # Errors
/// [`EngineError::EngineUnavailable`] when the runtime cannot be built.
#[cfg(not(target_arch = "wasm32"))]
pub fn current_thread_runtime() -> Result<tokio::runtime::Runtime, EngineError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| EngineError::EngineUnavailable {
            message: format!("engine runtime: {error}"),
        })
}
