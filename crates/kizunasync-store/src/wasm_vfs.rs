//! Persistent `SQLite` VFS selection for wasm32.
//!
//! Neither backend is available on the main thread: the OPFS pool needs
//! synchronous access handles, which only a dedicated worker can obtain, and
//! without a worker the relaxed `IndexedDB` VFS is the only option left. The
//! directory-name derivation and browser-error classification below are
//! plain functions over strings so a native unit test can exercise them
//! without a wasm32 target or a browser.

#[cfg(target_arch = "wasm32")]
use crate::VfsKind;
#[cfg(target_arch = "wasm32")]
use crate::error::StoreError;
#[cfg(target_arch = "wasm32")]
use sqlite_wasm_rs::WasmOsCallback;
#[cfg(target_arch = "wasm32")]
use sqlite_wasm_vfs::sahpool::OpfsSAHError;
#[cfg(target_arch = "wasm32")]
use sqlite_wasm_vfs::{relaxed_idb, sahpool};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsCast;

/// The sanitized part of [`sahpool_directory`] is capped at this many
/// characters before the hash suffix, so a very long database name cannot
/// push the OPFS directory component over the filesystem's 255-byte limit
/// (a name near 245 characters otherwise makes `getDirectoryHandle` raise
/// `TypeError`, which this module treats as a failed OPFS and refuses the
/// open). The hash suffix alone already
/// guarantees the directory is unique, so truncating the readable part
/// loses nothing but readability for pathological names.
#[cfg(any(target_arch = "wasm32", test))]
const SAHPOOL_SANITIZED_NAME_LIMIT: usize = 64;
/// Number of sahpool install attempts before giving up on a busy pool: not
/// the number of `createSyncAccessHandle` calls, since one install attempt
/// can issue several of those while acquiring the pool's files. Ten
/// attempts with [`SAHPOOL_BUSY_BACKOFF_MS`] between them, about 1.8 s
/// total, before [`crate::StoreError::VfsBusy`].
#[cfg(target_arch = "wasm32")]
const SAHPOOL_BUSY_RETRIES: u32 = 10;
/// Delay between busy retries: long enough for a reloading tab to release its
/// handles, short enough that the budget does not stall the opener for long.
/// [`SAHPOOL_BUSY_RETRIES`] sahpool install attempts happen in total, with a
/// wait this long between each pair of attempts (none after the last), so
/// ten attempts is nine waits, about 1.8 s, before
/// [`crate::StoreError::VfsBusy`].
#[cfg(target_arch = "wasm32")]
const SAHPOOL_BUSY_BACKOFF_MS: i32 = 200;

/// FNV-1a, 64-bit: the classic offset basis and prime, folded over `bytes`.
/// Inline rather than a crate dependency because eight bytes of arithmetic
/// do not justify one.
#[cfg(any(target_arch = "wasm32", test))]
fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes.iter().fold(OFFSET_BASIS, |hash, &byte| {
        (hash ^ u64::from(byte)).wrapping_mul(PRIME)
    })
}

/// First 8 hex digits of the FNV-1a 64-bit hash of `name`'s raw (unsanitized)
/// UTF-8 bytes. Shared by [`sahpool_directory`], [`sahpool_vfs_name`], and
/// [`relaxed_idb_vfs_name`] so a directory or VFS name derived for `name`
/// always agrees with every other one derived for the same `name`, on either
/// backend.
#[cfg(any(target_arch = "wasm32", test))]
fn hash8(name: &str) -> String {
    format!("{:016x}", fnv1a64(name.as_bytes()))[..8].to_string()
}

/// Derives the OPFS directory the sahpool VFS stores `name`'s files under.
///
/// One pool directory per database name, not one shared `.kizunasync` pool.
/// `sqlite-wasm-vfs` keys a sahpool install by `OpfsSAHPoolCfg.directory`,
/// and two databases sharing a directory fail in two different ways
/// depending on where they are opened: across two wasm instances (two
/// dedicated workers) the second cannot acquire the sync access handles the
/// first already holds, so it fails busy; within one wasm instance,
/// `sahpool::install` short-circuits on an already-registered `vfs_name` and
/// hands back the first pool, silently ignoring the second database's
/// directory. [`sahpool_vfs_name`] closes that second case by deriving its
/// name from the same hash as this directory, so two databases opened by one
/// instance register two distinct pools instead of one silently absorbing
/// the other.
///
/// Lowercased and restricted to `[a-z0-9._-]` because OPFS directory names are
/// otherwise unconstrained but callers of `open_path_async` pass arbitrary
/// database names, then capped at [`SAHPOOL_SANITIZED_NAME_LIMIT`] characters
/// before the hash suffix. Suffixed with the first 8 hex digits of an FNV-1a
/// 64-bit hash of the raw (unsanitized, untruncated) name so two names that
/// sanitize to the same string, for example `"My DB"` and `"My!DB"`, still
/// land in different directories instead of silently sharing one pool; the
/// sanitized text stays first so an OPFS listing is still readable at a
/// glance.
///
/// Gated to wasm32-or-test rather than left universally compiled: nothing on
/// a plain native build calls it, so it would otherwise be dead code there.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn sahpool_directory(name: &str) -> String {
    let mut sanitized: String = name
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Every char mapped above is a single ASCII byte, so byte-length
    // truncation can never land mid-character.
    sanitized.truncate(SAHPOOL_SANITIZED_NAME_LIMIT);
    format!(".kizunasync/{sanitized}-{}", hash8(name))
}

/// Sahpool `vfs_name` for `name`. Derived from the same hash as
/// [`sahpool_directory`] rather than left at `sqlite-wasm-vfs`'s fixed
/// default (`"opfs-sahpool"`) so that opening two databases from one wasm
/// instance registers two distinct sahpool VFS entries: `sahpool::install`
/// short-circuits on an already-registered `vfs_name` and would otherwise
/// hand the second database the first's already-open pool with no error and
/// no signal (see [`sahpool_directory`]).
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn sahpool_vfs_name(name: &str) -> String {
    format!("opfs-sahpool-{}", hash8(name))
}

/// Relaxed-idb `vfs_name` for `name`, mirroring [`sahpool_vfs_name`] for the
/// other backend.
///
/// `sqlite-wasm-vfs`'s relaxed-idb backend keys its `IndexedDB` database
/// directly by `vfs_name` (`Database::open(&options.vfs_name)` in
/// `relaxed_idb.rs`), and `relaxed_idb::install` short-circuits on an
/// already-registered `vfs_name` the same way `sahpool::install` does. A
/// fixed name would put every database that falls back to relaxed-idb from
/// one wasm instance into the same `IndexedDB` database, the identical
/// same-instance collision [`sahpool_vfs_name`] closes for the sahpool
/// backend. Deriving it from the hash keeps one database name mapped to one
/// `IndexedDB` database, which is what an `open_path_async` caller expects.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn relaxed_idb_vfs_name(name: &str) -> String {
    format!("relaxed-idb-{}", hash8(name))
}

/// Whether a sahpool install failure means the browser lacks the feature,
/// that another context currently holds its files exclusively, or that OPFS is
/// there and failed.
#[cfg(any(target_arch = "wasm32", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SahpoolFailure {
    /// No dedicated worker, no OPFS entry point, or storage access refused
    /// (`SecurityError`, as in private browsing): the feature is absent
    /// here, so relaxed-idb is the right fallback.
    Unsupported,
    /// `createSyncAccessHandle` is exclusive; another tab or worker (often a
    /// page mid-reload) still holds it. A short retry often outlasts that
    /// context releasing its handles on unload.
    Busy,
    /// OPFS is there and failed for another reason. The database may already
    /// live in OPFS, and relaxed-idb would open a different, empty store in
    /// its place, so the open fails instead.
    Failed,
    /// The browser refused the OPFS root directory itself (Safari Private
    /// Browsing answers `UnknownError` there), so no OPFS store is reachable
    /// at all. The safe store is a private memory store, never relaxed-idb,
    /// which would create a second persistent store that can diverge from an
    /// OPFS one later.
    Refused,
}

/// Which handle acquisition a wrapped `OpfsSAHError` came from: its
/// `GetDirHandle`, `GetFileHandle`, and `CreateSyncAccessHandle` variants, in
/// that order, so a native test can drive [`classify_step_error`] without a
/// `JsValue`.
#[cfg(any(target_arch = "wasm32", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SahpoolStep {
    Directory,
    File,
    SyncAccessHandle,
}

/// Classifies a `DOMException` name the way `createSyncAccessHandle()` and
/// its supporting calls report a taken lock: `NoModificationAllowedError`,
/// or `InvalidStateError` on engines that use it for the same condition
/// (File System Access spec, `FileSystemSyncAccessHandle` acquisition).
/// `SecurityError` is storage access the browser refuses outright (private
/// browsing), so the feature is absent. Any other name, `NotFoundError`
/// included, or no name at all, is a failure of an OPFS that exists.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn classify_error_name(name: Option<&str>) -> SahpoolFailure {
    match name {
        Some("NoModificationAllowedError" | "InvalidStateError") => SahpoolFailure::Busy,
        Some("SecurityError") => SahpoolFailure::Unsupported,
        _ => SahpoolFailure::Failed,
    }
}

/// Classifies the `DOMException` name a handle acquisition at `step` failed
/// with. Only `UnknownError` on the directory step is
/// [`SahpoolFailure::Refused`], the answer Safari Private Browsing gives for
/// the OPFS root; the same name from a file or sync access handle is a failure
/// of an OPFS that exists, so every other pair keeps
/// [`classify_error_name`]'s answer.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn classify_step_error(step: SahpoolStep, name: Option<&str>) -> SahpoolFailure {
    match (step, name) {
        (SahpoolStep::Directory, Some("UnknownError")) => SahpoolFailure::Refused,
        _ => classify_error_name(name),
    }
}

/// Whether the browser exposes everything the sahpool VFS needs before
/// [`install_sahpool`] ever calls `sahpool::install`, decided from plain
/// booleans so a native test can drive it without a `JsValue`.
///
/// `sqlite-wasm-vfs`'s own `sahpool::install` reaches `navigator.storage`
/// and calls `.getDirectory()` on it through a `web-sys` binding that has no
/// `#[wasm_bindgen(catch)]`. When `navigator.storage` is `undefined` or lacks
/// `getDirectory` (Safari before 17, Firefox before 111, a non-secure
/// context), that call throws synchronously instead of resolving or
/// rejecting a promise, and an uncaught throw crossing back into Rust traps
/// the whole wasm instance rather than producing a classifiable
/// [`OpfsSAHError`], which would also take down the relaxed-idb fallback
/// this module falls back to. `FileSystemFileHandle.prototype.createSyncAccessHandle`
/// is checked for the same reason: without it, acquiring a handle later
/// would fail the same uncaught way. Checking all three first, before ever
/// calling `sahpool::install`, avoids the trap entirely.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn sahpool_environment_supported(
    has_storage: bool,
    has_get_directory: bool,
    has_create_sync_access_handle: bool,
) -> bool {
    has_storage && has_get_directory && has_create_sync_access_handle
}

/// Names whichever of [`sahpool_environment_supported`]'s three checks
/// failed, for the "unsupported" message this module reports the same way
/// it reports an actual [`OpfsSAHError`]. Called only when that predicate
/// returned `false`, so in practice at least one argument here is `false`.
#[cfg(any(target_arch = "wasm32", test))]
fn describe_missing_sahpool_support(
    has_storage: bool,
    has_get_directory: bool,
    has_create_sync_access_handle: bool,
) -> String {
    let mut missing = Vec::new();
    if !has_storage {
        missing.push("navigator.storage");
    }
    if !has_get_directory {
        missing.push("navigator.storage.getDirectory");
    }
    if !has_create_sync_access_handle {
        missing.push("FileSystemFileHandle.prototype.createSyncAccessHandle");
    }
    format!("missing {}", missing.join(", "))
}

/// Reads `target[key]` without ever throwing: `Reflect::get` throws if
/// `target` is not an object or function, which is exactly the "missing
/// piece" case this module needs to detect rather than trap on, so a
/// non-object target answers `undefined` instead of propagating that throw.
#[cfg(target_arch = "wasm32")]
fn get_property(target: &wasm_bindgen::JsValue, key: &str) -> wasm_bindgen::JsValue {
    if !target.is_object() && !target.is_function() {
        return wasm_bindgen::JsValue::UNDEFINED;
    }
    js_sys::Reflect::get(target, &wasm_bindgen::JsValue::from_str(key))
        .unwrap_or(wasm_bindgen::JsValue::UNDEFINED)
}

/// Reads the JS error's `name` property. Works for both `DOMException` and
/// plain `Error` objects: `DOMException` exposes the same property, and per
/// the current Web IDL spec its prototype chain descends from `Error`.
#[cfg(target_arch = "wasm32")]
fn js_error_name(value: &wasm_bindgen::JsValue) -> Option<String> {
    get_property(value, "name").as_string()
}

/// Probes the current global scope for what [`sahpool_environment_supported`]
/// needs, using [`get_property`] throughout so a missing piece answers
/// `undefined` instead of throwing.
#[cfg(target_arch = "wasm32")]
fn missing_sahpool_support() -> Option<String> {
    let global = js_sys::global();
    let navigator = get_property(&global, "navigator");
    let storage = get_property(&navigator, "storage");
    let has_storage = storage.is_object();
    let has_get_directory = get_property(&storage, "getDirectory").is_function();

    let file_handle_ctor = get_property(&global, "FileSystemFileHandle");
    let prototype = get_property(&file_handle_ctor, "prototype");
    let has_create_sync_access_handle =
        get_property(&prototype, "createSyncAccessHandle").is_function();

    if sahpool_environment_supported(
        has_storage,
        has_get_directory,
        has_create_sync_access_handle,
    ) {
        None
    } else {
        Some(describe_missing_sahpool_support(
            has_storage,
            has_get_directory,
            has_create_sync_access_handle,
        ))
    }
}

/// Classifies an [`OpfsSAHError`] via [`classify_step_error`].
///
/// [`OpfsSAHError::NotSupported`] fires when the current thread is not a
/// dedicated worker (no `WorkerGlobalScope`) and is always
/// [`SahpoolFailure::Unsupported`]. [`OpfsSAHError::GetDirHandle`],
/// `GetFileHandle`, and `CreateSyncAccessHandle` each wrap the JS error from
/// acquiring a directory, file, or sync access handle: the points where
/// another context's lock or a refused storage access would surface, so
/// their step and wrapped error's name decide. Every other variant (`Vfs`,
/// `ImportDb`, `IterHandle`, `GetPath`, `RemoveEntity`, `GetSize`, `Read`,
/// `Write`, `Flush`, `Truncate`, `Reflect`, `Generic`) happens during pool
/// bookkeeping or file I/O on a pool the browser does offer, so it is
/// [`SahpoolFailure::Failed`]: neither a retry nor another store fixes it.
#[cfg(target_arch = "wasm32")]
fn classify_sahpool_error(error: &OpfsSAHError) -> SahpoolFailure {
    let (step, value) = match error {
        OpfsSAHError::NotSupported => return SahpoolFailure::Unsupported,
        OpfsSAHError::GetDirHandle(value) => (SahpoolStep::Directory, value),
        OpfsSAHError::GetFileHandle(value) => (SahpoolStep::File, value),
        OpfsSAHError::CreateSyncAccessHandle(value) => (SahpoolStep::SyncAccessHandle, value),
        _ => return SahpoolFailure::Failed,
    };

    classify_step_error(step, js_error_name(value).as_deref())
}

/// Message [`install_sahpool`] reports for an `error` [`classify_sahpool_error`]
/// did not classify [`SahpoolFailure::Busy`].
///
/// `OpfsSAHError`'s `#[error]` strings for the three wrapped variants carry
/// no field (for example `GetDirHandle` is always the bare "An error
/// occurred while getting the directory handle"), so a `SecurityError` and a
/// `NotFoundError` would otherwise reach `StoreError::VfsUnavailable` as the
/// identical, uninformative text. Appending the wrapped `DOMException` name
/// where one exists is the only way an operator learns which failure it was.
#[cfg(target_arch = "wasm32")]
fn describe_sahpool_error(error: &OpfsSAHError) -> String {
    let name = match error {
        OpfsSAHError::GetDirHandle(value)
        | OpfsSAHError::GetFileHandle(value)
        | OpfsSAHError::CreateSyncAccessHandle(value) => js_error_name(value),
        _ => None,
    };
    match name {
        Some(name) => format!("{error} ({name})"),
        None => error.to_string(),
    }
}

/// Waits `ms` milliseconds without blocking the worker's event loop, via the
/// global `setTimeout`. Reads it through `WorkerGlobalScope` rather than
/// `window` because a dedicated worker has no `window`. If that lookup fails
/// for any reason, resolves immediately rather than stalling a retry loop.
#[cfg(target_arch = "wasm32")]
async fn delay(ms: i32) {
    let mut executor = move |resolve: js_sys::Function, _reject: js_sys::Function| {
        // No worker scope, or no timer: resolve now. The caller is a bounded
        // retry loop, so a lost wait costs an early attempt, never a stall.
        let Ok(scope) = js_sys::global().dyn_into::<web_sys::WorkerGlobalScope>() else {
            let _ = resolve.call0(&wasm_bindgen::JsValue::UNDEFINED);
            return;
        };
        let _ = scope.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms);
    };
    let promise = js_sys::Promise::new(&mut executor);
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

/// What `StoreError::VfsUnavailable` reports for the backend a failed OPFS
/// install never let the open reach.
#[cfg(target_arch = "wasm32")]
const RELAXED_IDB_NOT_TRIED: &str =
    "not tried: OPFS is available and failed, and IndexedDB would open a different, empty store";

/// What trying the sahpool VFS produced, beyond plain success.
#[cfg(target_arch = "wasm32")]
enum SahpoolOutcome {
    /// Carries the failed install's `Display` text, used in the combined
    /// failure message if the relaxed-idb fallback also fails.
    Unsupported(String),
    /// Exclusively held by another context for the whole retry budget.
    Busy,
    /// Carries the failed install's `Display` text; see
    /// [`SahpoolFailure::Failed`].
    Failed(String),
    /// See [`SahpoolFailure::Refused`]. No text: the store opens anyway, and
    /// the reported `none` durability is what tells the app.
    Refused,
}

/// Installs the sahpool VFS for `name`, retrying while the pool is busy.
///
/// Checks [`missing_sahpool_support`] before ever calling `sahpool::install`:
/// see [`sahpool_environment_supported`] for why skipping that check can trap
/// the wasm instance instead of returning a classifiable error.
#[cfg(target_arch = "wasm32")]
async fn install_sahpool(name: &str) -> Result<String, SahpoolOutcome> {
    if let Some(reason) = missing_sahpool_support() {
        return Err(SahpoolOutcome::Unsupported(reason));
    }

    let vfs_name = sahpool_vfs_name(name);
    let cfg = sahpool::OpfsSAHPoolCfg {
        directory: sahpool_directory(name),
        vfs_name: vfs_name.clone(),
        ..Default::default()
    };
    let mut attempts_left = SAHPOOL_BUSY_RETRIES;
    loop {
        // default_vfs = false: the opener names the VFS explicitly instead of
        // relying on whichever backend happened to install last.
        let Err(error) = sahpool::install::<WasmOsCallback>(&cfg, false).await else {
            return Ok(vfs_name);
        };
        match classify_sahpool_error(&error) {
            SahpoolFailure::Unsupported => {
                return Err(SahpoolOutcome::Unsupported(describe_sahpool_error(&error)));
            }
            SahpoolFailure::Failed => {
                return Err(SahpoolOutcome::Failed(describe_sahpool_error(&error)));
            }
            SahpoolFailure::Refused => return Err(SahpoolOutcome::Refused),
            SahpoolFailure::Busy => {
                attempts_left -= 1;
                if attempts_left == 0 {
                    return Err(SahpoolOutcome::Busy);
                }
                delay(SAHPOOL_BUSY_BACKOFF_MS).await;
            }
        }
    }
}

/// What [`install_best_vfs`] chose for a database name.
#[cfg(target_arch = "wasm32")]
pub(crate) enum BestVfs {
    /// A persistent VFS, registered with `SQLite` as `vfs_name`.
    Persistent { kind: VfsKind, vfs_name: String },
    /// No OPFS store is reachable (see [`SahpoolFailure::Refused`]), so the
    /// caller opens the private `:memory:` store instead.
    Memory,
}

/// Installs the best persistent VFS the current context offers for `name`
/// and returns which one won along with its registered `SQLite` VFS name.
///
/// Tries the OPFS synchronous-access-handle pool first (full durability, but
/// only available inside a dedicated worker), retrying while it is merely
/// busy (held by another tab or worker, most often one still shutting down
/// on reload), then falls back to the relaxed-durability `IndexedDB` VFS only
/// when the browser lacks the sahpool outright. Never falls back silently on
/// "busy" or on any other OPFS failure: swapping to `IndexedDB` while the
/// OPFS data may still be there would show the caller a different, empty
/// store, so a store that once opened on OPFS never reopens empty.
///
/// Returns [`BestVfs::Memory`] only when the browser refused the OPFS root
/// directory itself (Safari Private Browsing): no OPFS store can exist there
/// to be hidden, and relaxed-idb would create a second persistent store that
/// can diverge from an OPFS one later, so a private memory store reported as
/// `none` durability is the only safe open.
#[cfg(target_arch = "wasm32")]
pub(crate) async fn install_best_vfs(name: &str) -> Result<BestVfs, StoreError> {
    let sah_error = match install_sahpool(name).await {
        Ok(vfs_name) => {
            return Ok(BestVfs::Persistent {
                kind: VfsKind::OpfsSahPool,
                vfs_name,
            });
        }
        Err(SahpoolOutcome::Busy) => {
            return Err(StoreError::VfsBusy {
                name: name.to_string(),
            });
        }
        Err(SahpoolOutcome::Failed(message)) => {
            return Err(StoreError::VfsUnavailable {
                sahpool: message,
                relaxed_idb: RELAXED_IDB_NOT_TRIED.to_string(),
            });
        }
        Err(SahpoolOutcome::Refused) => return Ok(BestVfs::Memory),
        Err(SahpoolOutcome::Unsupported(message)) => message,
    };

    let idb_vfs_name = relaxed_idb_vfs_name(name);
    let idb_cfg = relaxed_idb::RelaxedIdbCfg {
        vfs_name: idb_vfs_name.clone(),
        ..Default::default()
    };
    let Err(idb_error) = relaxed_idb::install::<WasmOsCallback>(&idb_cfg, false).await else {
        return Ok(BestVfs::Persistent {
            kind: VfsKind::RelaxedIdb,
            vfs_name: idb_vfs_name,
        });
    };

    Err(StoreError::VfsUnavailable {
        sahpool: sah_error,
        relaxed_idb: idb_error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        SahpoolFailure, SahpoolStep, classify_error_name, classify_step_error,
        describe_missing_sahpool_support, relaxed_idb_vfs_name, sahpool_directory,
        sahpool_environment_supported, sahpool_vfs_name,
    };

    #[test]
    fn sahpool_directory_sanitizes_and_prefixes() {
        assert_eq!(
            sahpool_directory("todos.db"),
            ".kizunasync/todos.db-3645491e"
        );
        assert_eq!(sahpool_directory("Todos"), ".kizunasync/todos-64004ee3");
        assert_eq!(
            sahpool_directory("My Todos v2!"),
            ".kizunasync/my_todos_v2_-6aaf7b2f"
        );
    }

    #[test]
    fn sahpool_directory_disambiguates_names_that_sanitize_the_same() {
        // "My DB" and "My!DB" both sanitize to "my_db" (space and '!' both
        // become '_'); the hash suffix is exactly what keeps them from
        // sharing one sahpool directory.
        assert_ne!(sahpool_directory("My DB"), sahpool_directory("My!DB"));
        assert_eq!(sahpool_directory("My DB"), ".kizunasync/my_db-c2094642");
        assert_eq!(sahpool_directory("My!DB"), ".kizunasync/my_db-b7921b42");

        // "My-DB" and "my_db" do not actually collide even pre-hash ('-' and
        // '_' are both individually preserved), but they still land in
        // different directories with the suffix in place.
        assert_ne!(sahpool_directory("My-DB"), sahpool_directory("my_db"));
        assert_eq!(sahpool_directory("My-DB"), ".kizunasync/my-db-21520f42");
        assert_eq!(sahpool_directory("my_db"), ".kizunasync/my_db-2fe5d5de");
    }

    #[test]
    fn sahpool_directory_caps_the_sanitized_part_of_a_long_name() {
        let name = "a".repeat(300);
        let directory = sahpool_directory(&name);
        // 64 sanitized "a"s, then the hash of the full, untruncated name.
        let expected_sanitized = "a".repeat(64);
        assert_eq!(
            directory,
            format!(".kizunasync/{expected_sanitized}-ee7717eb")
        );
    }

    #[test]
    fn sahpool_vfs_name_is_derived_from_the_same_hash_as_the_directory() {
        assert_eq!(sahpool_vfs_name("todos.db"), "opfs-sahpool-3645491e");
        // Two different databases in one wasm instance must register two
        // distinct sahpool VFS entries, or `sahpool::install` would hand the
        // second one back the first's already-open pool.
        assert_ne!(sahpool_vfs_name("todos.db"), sahpool_vfs_name("notes.db"));
    }

    #[test]
    fn relaxed_idb_vfs_name_is_derived_from_the_same_hash_as_sahpool() {
        assert_eq!(relaxed_idb_vfs_name("todos.db"), "relaxed-idb-3645491e");
        // Two different databases in one wasm instance must register two
        // distinct `IndexedDB` databases, or `relaxed_idb::install` would
        // hand the second one back the first's already-open database.
        assert_ne!(
            relaxed_idb_vfs_name("todos.db"),
            relaxed_idb_vfs_name("notes.db")
        );
        // Same hash as the sahpool name for the same database, just a
        // different prefix, since both derive from the one `hash8` helper.
        assert_eq!(
            sahpool_vfs_name("todos.db").trim_start_matches("opfs-sahpool-"),
            relaxed_idb_vfs_name("todos.db").trim_start_matches("relaxed-idb-")
        );
    }

    #[test]
    fn classify_error_name_matches_known_busy_names() {
        assert_eq!(
            classify_error_name(Some("NoModificationAllowedError")),
            SahpoolFailure::Busy
        );
        assert_eq!(
            classify_error_name(Some("InvalidStateError")),
            SahpoolFailure::Busy
        );
    }

    #[test]
    fn classify_error_name_falls_back_only_for_refused_storage_access() {
        assert_eq!(
            classify_error_name(Some("SecurityError")),
            SahpoolFailure::Unsupported
        );
    }

    #[test]
    fn classify_error_name_fails_every_other_error_instead_of_falling_back() {
        for name in [
            "NotFoundError",
            "TypeError",
            "QuotaExceededError",
            "UnknownError",
            "Error",
        ] {
            assert_eq!(
                classify_error_name(Some(name)),
                SahpoolFailure::Failed,
                "{name}"
            );
        }
        assert_eq!(classify_error_name(None), SahpoolFailure::Failed);
    }

    #[test]
    fn classify_step_error_refuses_only_an_unknown_error_on_the_directory() {
        assert_eq!(
            classify_step_error(SahpoolStep::Directory, Some("UnknownError")),
            SahpoolFailure::Refused
        );
        assert_eq!(
            classify_step_error(SahpoolStep::Directory, Some("SecurityError")),
            SahpoolFailure::Unsupported
        );
        assert_eq!(
            classify_step_error(SahpoolStep::Directory, None),
            SahpoolFailure::Failed
        );
    }

    #[test]
    fn classify_step_error_fails_an_unknown_error_on_a_file_or_access_handle() {
        for step in [SahpoolStep::File, SahpoolStep::SyncAccessHandle] {
            assert_eq!(
                classify_step_error(step, Some("UnknownError")),
                SahpoolFailure::Failed,
                "{step:?}"
            );
        }
    }

    #[test]
    fn classify_step_error_keeps_busy_names_on_every_step() {
        for step in [
            SahpoolStep::Directory,
            SahpoolStep::File,
            SahpoolStep::SyncAccessHandle,
        ] {
            for name in ["NoModificationAllowedError", "InvalidStateError"] {
                assert_eq!(
                    classify_step_error(step, Some(name)),
                    SahpoolFailure::Busy,
                    "{step:?} {name}"
                );
            }
        }
    }

    #[test]
    fn sahpool_environment_supported_requires_all_three() {
        assert!(sahpool_environment_supported(true, true, true));
        assert!(!sahpool_environment_supported(false, true, true));
        assert!(!sahpool_environment_supported(true, false, true));
        assert!(!sahpool_environment_supported(true, true, false));
        assert!(!sahpool_environment_supported(false, false, false));
    }

    #[test]
    fn describe_missing_sahpool_support_names_every_missing_piece() {
        assert_eq!(
            describe_missing_sahpool_support(false, true, true),
            "missing navigator.storage"
        );
        assert_eq!(
            describe_missing_sahpool_support(true, false, true),
            "missing navigator.storage.getDirectory"
        );
        assert_eq!(
            describe_missing_sahpool_support(true, true, false),
            "missing FileSystemFileHandle.prototype.createSyncAccessHandle"
        );
        assert_eq!(
            describe_missing_sahpool_support(false, false, false),
            "missing navigator.storage, navigator.storage.getDirectory, \
             FileSystemFileHandle.prototype.createSyncAccessHandle"
        );
    }
}
