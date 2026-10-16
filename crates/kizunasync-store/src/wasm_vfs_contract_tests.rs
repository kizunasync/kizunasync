const SAHPOOL_SANITIZED_NAME_LIMIT: usize = 64;
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
