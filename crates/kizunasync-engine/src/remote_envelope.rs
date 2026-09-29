//! The envelope a host-side remote resolves with, and its mapping back to an
//! [`EngineError`].
//!
//! Shared by every bridge whose transport lives outside Rust (`kizunasync-napi`,
//! `kizunasync-wasm`): the host adapter owns the transport, its auth and its retry
//! classification, and encodes the outcome here. One parser, so the two hosts
//! cannot classify the same reply differently.

use crate::error::EngineError;
use serde::Deserialize;
use serde::de::DeserializeOwned;

/// What the host bridge resolves with. It NEVER rejects: an adapter that threw
/// would lose the `retryable` classification the dead-letter budget depends on,
/// so the bridge catches and encodes it here instead.
#[derive(Deserialize)]
struct RemoteEnvelope<T> {
    ok: bool,
    #[serde(default = "Option::default")]
    data: Option<T>,
    #[serde(default)]
    message: Option<String>,
    /// Absent ⇒ transient. Only an adapter that explicitly marked a fault
    /// PERMANENT may feed the budget that drops a queued write.
    #[serde(default)]
    retryable: Option<bool>,
    /// The adapter's transport code (`AUTH_SESSION_MISSING`, a PostgREST/SQLSTATE
    /// code, …), carried through to the bridge error envelope as-is.
    #[serde(default)]
    code: Option<String>,
}

/// Decode one envelope into the response the engine asked for.
///
/// # Errors
///
/// Returns [`EngineError::Json`] for an unparseable envelope, the envelope's own
/// fault (retryable unless the adapter marked it permanent) for `ok: false`, and
/// a retryable remote error for an `ok: true` envelope that carries no data.
pub fn parse<T: DeserializeOwned>(raw: &str, operation: &str) -> Result<T, EngineError> {
    let envelope: RemoteEnvelope<T> = serde_json::from_str(raw)?;
    if !envelope.ok {
        return Err(into_remote_error(envelope, operation));
    }

    envelope
        .data
        .ok_or_else(|| EngineError::remote(format!("{operation}: bridge resolved ok with no data")))
}

/// Rebuild the typed engine error from a failed envelope.
fn into_remote_error<T>(envelope: RemoteEnvelope<T>, operation: &str) -> EngineError {
    let message = envelope
        .message
        .unwrap_or_else(|| format!("{operation} failed"));
    match envelope.retryable {
        Some(false) => EngineError::permanent_remote(message),
        None | Some(true) => EngineError::remote(message),
    }
    .with_code(envelope.code)
}
