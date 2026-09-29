//! Host clock and UUID source, selected per target so the engine itself never calls `SystemTime::now()` or `Uuid::new_v4()` directly.

#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(not(target_arch = "wasm32"))]
pub use native::{now_unix_ms, random_uuid_v4};
#[cfg(target_arch = "wasm32")]
pub use wasm::{now_unix_ms, random_uuid_v4};

/// The auto traits a shared engine value carries on a threaded host.
#[cfg(not(target_arch = "wasm32"))]
pub trait MaybeSendSync: Send + Sync {}

#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync + ?Sized> MaybeSendSync for T {}

/// Empty on wasm32: the browser engine never leaves its own thread.
#[cfg(target_arch = "wasm32")]
pub trait MaybeSendSync {}

#[cfg(target_arch = "wasm32")]
impl<T: ?Sized> MaybeSendSync for T {}
