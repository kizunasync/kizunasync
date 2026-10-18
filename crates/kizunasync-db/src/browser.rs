//! Worker-local OPFS/IndexedDB I/O for Turso, without shared WASM memory.

use crate::{Error, Result};
use std::sync::Arc;
use turso_core::io::{FileId, FileSyncType};
use turso_core::{
    Buffer, Clock, Completion, File, IO, MonotonicInstant, OpenFlags, WallClockInstant,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/src/browser-storage.js")]
extern "C" {
    #[wasm_bindgen(js_name = openMemoryStorage)]
    fn open_memory_storage() -> u32;
    #[wasm_bindgen(catch, js_name = openStorage)]
    async fn open_storage(
        name: &str,
        directory: &str,
        legacy_idb: &str,
    ) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(js_name = closeStorage)]
    fn close_storage(id: u32);
    #[wasm_bindgen(catch, js_name = markReady)]
    fn mark_ready(id: u32) -> std::result::Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = fileRead)]
    fn file_read(
        id: u32,
        path: &str,
        offset: f64,
        output: &mut [u8],
    ) -> std::result::Result<i32, JsValue>;
    #[wasm_bindgen(catch, js_name = fileWrite)]
    fn file_write(
        id: u32,
        path: &str,
        offset: f64,
        bytes: &[u8],
    ) -> std::result::Result<i32, JsValue>;
    #[wasm_bindgen(catch, js_name = fileSize)]
    fn file_size(id: u32, path: &str) -> std::result::Result<f64, JsValue>;
    #[wasm_bindgen(catch, js_name = fileTruncate)]
    fn file_truncate(id: u32, path: &str, size: f64) -> std::result::Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = fileSync)]
    fn file_sync(id: u32, path: &str) -> std::result::Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = flushStorage)]
    async fn flush_storage() -> std::result::Result<(), JsValue>;
}

fn message(value: &JsValue) -> String {
    value
        .as_string()
        .or_else(|| {
            js_sys::Reflect::get(value, &"message".into())
                .ok()
                .and_then(|value| value.as_string())
        })
        .unwrap_or_else(|| format!("{value:?}"))
}
// map_err consumes the JS exception; keep one conversion function for all calls.
#[allow(clippy::needless_pass_by_value)]
fn io_error(error: JsValue) -> turso_core::LimboError {
    turso_core::LimboError::InternalError(message(&error))
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn handle_number(value: Option<f64>) -> Result<u32> {
    match value {
        Some(value)
            if value.is_finite()
                && value.fract() == 0.0
                && (0.0..=f64::from(u32::MAX)).contains(&value) =>
        {
            Ok(value as u32)
        }
        _ => Err(Error::Browser("invalid storage handle or kind".into())),
    }
}

#[allow(clippy::cast_precision_loss)]
fn js_offset(value: u64) -> turso_core::Result<f64> {
    if value > 9_007_199_254_740_991 {
        return Err(turso_core::LimboError::InternalError(
            "database offset exceeds JavaScript's integer range".into(),
        ));
    }
    Ok(value as f64)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn file_length(value: f64) -> turso_core::Result<u64> {
    if !value.is_finite()
        || value.fract() != 0.0
        || !(0.0..=9_007_199_254_740_991.0).contains(&value)
    {
        return Err(turso_core::LimboError::InternalError(
            "invalid browser file length".into(),
        ));
    }
    Ok(value as u64)
}

pub(crate) struct Lease {
    id: u32,
    ready: bool,
}
impl Lease {
    pub(crate) fn memory() -> Self {
        Self {
            id: open_memory_storage(),
            ready: true,
        }
    }
    pub(crate) fn needs_verification(&self) -> bool {
        !self.ready
    }
    pub(crate) async fn open(name: &str, directory: &str, legacy_idb: &str) -> Result<(Self, u32)> {
        let result = open_storage(name, directory, legacy_idb)
            .await
            .map_err(|error| Error::Browser(message(&error)))?;
        let number = |key: &str| {
            js_sys::Reflect::get(&result, &key.into())
                .ok()
                .and_then(|value| value.as_f64())
        };
        let id = handle_number(number("id"))?;
        let kind = handle_number(number("kind"))?;
        let ready = js_sys::Reflect::get(&result, &"ready".into())
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        Ok((Self { id, ready }, kind))
    }
    pub(crate) fn id(&self) -> u32 {
        self.id
    }
    pub(crate) fn mark_ready(&self) -> Result<()> {
        mark_ready(self.id).map_err(|error| Error::Browser(message(&error)))
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        close_storage(self.id);
    }
}

/// Await persistence of worker-local `IndexedDB` writes before acknowledging a call.
///
/// # Errors
/// Returns a quota, transaction or storage error instead of acknowledging a lost write.
pub async fn flush() -> Result<()> {
    flush_storage()
        .await
        .map_err(|error| Error::Browser(message(&error)))
}

pub(crate) struct BrowserIo {
    id: u32,
}
impl BrowserIo {
    pub(crate) fn new(id: u32) -> Self {
        Self { id }
    }
}
impl Clock for BrowserIo {
    fn current_time_monotonic(&self) -> MonotonicInstant {
        static EPOCH: std::sync::LazyLock<web_time::Instant> =
            std::sync::LazyLock::new(web_time::Instant::now);
        MonotonicInstant::from_nanos(EPOCH.elapsed().as_nanos())
    }
    fn current_time_wall_clock(&self) -> WallClockInstant {
        let duration = web_time::SystemTime::now()
            .duration_since(web_time::UNIX_EPOCH)
            .unwrap_or_default();
        WallClockInstant {
            secs: i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
            micros: duration.subsec_micros(),
        }
    }
}
impl IO for BrowserIo {
    fn open_file(
        &self,
        path: &str,
        _flags: OpenFlags,
        _direct: bool,
    ) -> turso_core::Result<Arc<dyn File>> {
        file_size(self.id, path).map_err(io_error)?;
        Ok(Arc::new(BrowserFile {
            id: self.id,
            path: path.into(),
        }))
    }
    fn remove_file(&self, path: &str) -> turso_core::Result<()> {
        file_truncate(self.id, path, 0.0).map_err(io_error)
    }
    fn file_id(&self, path: &str) -> turso_core::Result<FileId> {
        Ok(FileId::from_path_hash(&format!("{}:{path}", self.id)))
    }
}
struct BrowserFile {
    id: u32,
    path: String,
}
impl File for BrowserFile {
    fn lock_file(&self, _exclusive: bool) -> turso_core::Result<()> {
        Ok(())
    }
    fn unlock_file(&self) -> turso_core::Result<()> {
        Ok(())
    }
    fn pread(&self, offset: u64, completion: Completion) -> turso_core::Result<Completion> {
        let output = completion.as_read().buf();
        let count = file_read(
            self.id,
            &self.path,
            js_offset(offset)?,
            output.as_mut_slice(),
        )
        .map_err(io_error)?;
        completion.complete(count);
        Ok(completion)
    }
    fn pwrite(
        &self,
        offset: u64,
        bytes: Arc<Buffer>,
        completion: Completion,
    ) -> turso_core::Result<Completion> {
        let count = file_write(self.id, &self.path, js_offset(offset)?, bytes.as_slice())
            .map_err(io_error)?;
        completion.complete(count);
        Ok(completion)
    }
    fn sync(
        &self,
        completion: Completion,
        _sync_type: FileSyncType,
    ) -> turso_core::Result<Completion> {
        file_sync(self.id, &self.path).map_err(io_error)?;
        completion.complete(0);
        Ok(completion)
    }
    fn size(&self) -> turso_core::Result<u64> {
        file_length(file_size(self.id, &self.path).map_err(io_error)?)
    }
    fn truncate(&self, size: u64, completion: Completion) -> turso_core::Result<Completion> {
        file_truncate(self.id, &self.path, js_offset(size)?).map_err(io_error)?;
        completion.complete(0);
        Ok(completion)
    }
}
