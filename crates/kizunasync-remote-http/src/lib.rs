//! Live HTTP adapters for the Kizuna engine: the Supabase RPC `ProtocolRemote`
//! and the Storage/TUS `Transfer`.
//!
//! Kept out of `kizunasync-engine` and `kizunasync-transfer` on purpose: a mobile
//! embedder links the engine without ever pulling `reqwest` (this crate is a
//! workspace member but not a default member).
//!
//! Every adapter talks through [`HttpTransport`], so the wire shape and the
//! error classification are unit tested in-process with zero network.
//!
//! [`HttpProtocolRemote`] and [`TusTransfer`] are `Send + Sync`, so an
//! embedder shares one behind an `Arc` across the engine's concurrent tasks.
//!
//! # Transport posture
//!
//! The live constructors accept only `https` project URLs, or plain `http` on
//! a loopback or local-network host for a local stack. [`ReqwestTransport`]
//! follows no redirect, and its failures never repeat the request URL. TLS
//! runs on rustls with the webpki root certificates compiled into the binary
//! (reqwest's `rustls-tls` feature), not the platform trust store. The
//! `Debug` output of [`RemoteConfig`], [`TusConfig`] and [`HttpRequest`]
//! leaves the keys and tokens out.
//!
//! # Allocation
//!
//! Allocation-conscious HTTP adapters (`reqwest`, JSON bodies). Not heapless.

#![forbid(unsafe_code)]

mod auth;
mod base64;
mod rpc;
mod transport;
mod tus;

pub use rpc::{DEFAULT_SCHEMA, HttpProtocolRemote, RemoteConfig};
pub use transport::{
    DEFAULT_BYTES_TIMEOUT, DEFAULT_CONNECT_TIMEOUT, DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_REQUEST_TIMEOUT, FakeTransport, HttpError, HttpMethod, HttpRequest, HttpResponse,
    HttpTransport, ReqwestTransport, json_response,
};
pub use tus::{TusConfig, TusTransfer, tus_endpoint_from_supabase_url};

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{HttpProtocolRemote, TusTransfer};

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn http_protocol_remote_is_send_and_sync() {
        assert_send_sync::<HttpProtocolRemote>();
    }

    #[test]
    fn tus_transfer_is_send_and_sync() {
        assert_send_sync::<TusTransfer>();
    }
}
