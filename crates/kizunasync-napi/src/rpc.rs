//! Thin NAPI wrapper around [`kizunasync_engine::rpc`]: forwards
//! `(method, params)` so the TypeScript adapter has one call shape. The
//! engine's dispatch pins the embedder clock the params carry.

use kizunasync_engine::SyncEngine;

/// Forwards one `(method, params)` call to the engine's RPC surface and answers
/// the JSON envelope the engine produced. A refused call travels inside that
/// envelope, never as a Rust error.
pub async fn dispatch(engine: &SyncEngine, method: &str, params: &str) -> String {
    kizunasync_engine::rpc::dispatch(engine, method, params).await
}
