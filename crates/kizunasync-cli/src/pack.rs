//! Locating and reading the installable Kizuna SQL pack.
//!
//! `pack.manifest.json` lists which migration files are the pack (vs
//! local-dev/demo fixtures) and the `.sql` lives under `supabase/migrations/`
//! beside it (monorepo layout) or flat alongside it (bundled layout).
//!
//! A Rust binary is not installed next to its sources, so the pack is
//! searched for: the ladder is `KSYNC_PACK_DIR`, then a `pack/` directory
//! beside the running executable (the bundled layout a packaged install
//! ships), then `packages/supabase-pack` beside the nearest `target/`
//! directory above the executable, which is where a cargo dev build of this
//! checkout lives. Each rung is documented in the crate README. Nothing here
//! walks up from the working directory: an app project the CLI was installed
//! into must never be searched for a pack that happens to live somewhere
//! above it.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::env::Env;
use crate::error::{Error, Result};

/// The manifest's `pack` array: the installable files, in order.
#[derive(Debug, Deserialize)]
pub struct PackManifest {
    /// Migration filenames that make up the installable pack.
    pub pack: Vec<String>,
    /// Demo-only SQL filenames, never applied by `kizunasync init`.
    #[serde(default)]
    pub demo: Vec<String>,
}

/// One pack file: its original name and its SQL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackFile {
    /// Original pack filename, e.g. `0001_kizuna_init.sql`.
    pub name: String,
    /// The file's full SQL.
    pub sql: String,
}

const MANIFEST: &str = "pack.manifest.json";

/// Find the directory holding `pack.manifest.json` plus the pack `.sql` files,
/// or `None` so callers fail loudly rather than plan an empty pack. The order
/// is `KSYNC_PACK_DIR`, then `beside_executable`, then `checkout_pack`;
/// none of them walks up from the working directory.
#[must_use]
pub fn resolve_pack_dir(env: &Env) -> Option<PathBuf> {
    if let Some(dir) = env.get("KSYNC_PACK_DIR") {
        let candidate = PathBuf::from(dir);
        if candidate.join(MANIFEST).is_file() {
            return Some(candidate);
        }
    }

    let exe = std::env::current_exe().ok()?;
    if let Some(dir) = exe.parent().and_then(beside_executable) {
        return Some(dir);
    }

    checkout_pack(&exe)
}

/// The bundled layout: a `pack/` directory right beside the executable,
/// carrying its own manifest.
fn beside_executable(exe_dir: &Path) -> Option<PathBuf> {
    let candidate = exe_dir.join("pack");

    candidate.join(MANIFEST).is_file().then_some(candidate)
}

/// `packages/supabase-pack` under the checkout `exe` was built from (a
/// `cargo build`/`cargo run` dev binary): the nearest ancestor of `exe` named
/// `target` marks the checkout, and its parent is the checkout root. Only that
/// directory is weighed: when its parent holds no pack manifest, `exe` is not
/// a dev build of this checkout, and an outer `target/` belongs to something
/// else, so the answer is `None` rather than a guess.
fn checkout_pack(exe: &Path) -> Option<PathBuf> {
    let target = exe
        .ancestors()
        .skip(1)
        .find(|dir| dir.file_name().is_some_and(|name| name == "target"))?;
    let candidate = target.parent()?.join("packages").join("supabase-pack");

    candidate.join(MANIFEST).is_file().then_some(candidate)
}

/// Parse `pack.manifest.json`.
///
/// # Errors
/// Returns [`Error::Pack`] when the manifest is unreadable or malformed.
pub fn read_pack_manifest(pack_dir: &Path) -> Result<PackManifest> {
    let path = pack_dir.join(MANIFEST);
    let raw = std::fs::read_to_string(&path)
        .map_err(|cause| Error::Pack(format!("could not read {}: {cause}", path.display())))?;

    serde_json::from_str(&raw).map_err(|_| {
        Error::Pack(format!(
            "pack.manifest.json in {} is malformed: expected {{ pack: string[] }}",
            pack_dir.display()
        ))
    })
}

/// The pack's `.sql` files, in manifest order.
///
/// # Errors
/// Returns [`Error::Pack`] when the manifest cannot be read, or when a listed
/// file is missing.
pub fn read_pack_files(pack_dir: &Path) -> Result<Vec<PackFile>> {
    let manifest = read_pack_manifest(pack_dir)?;
    let migrations_dir = pack_migrations_dir(pack_dir);
    let mut files = Vec::new();
    for name in manifest.pack {
        let path = migrations_dir.join(&name);
        let sql = std::fs::read_to_string(&path).map_err(|error| {
            Error::Pack(format!(
                "pack file {} is listed in the manifest but missing at {}: {error}",
                name,
                path.display()
            ))
        })?;
        files.push(PackFile { name, sql });
    }

    Ok(files)
}

/// Where the pack `.sql` lives relative to the manifest: `supabase/migrations/`
/// in the monorepo (the layout the Supabase CLI requires), flat in a bundle.
fn pack_migrations_dir(pack_dir: &Path) -> PathBuf {
    let with_migrations = pack_dir.join("supabase").join("migrations");

    if with_migrations.is_dir() {
        with_migrations
    } else {
        pack_dir.to_path_buf()
    }
}

/// The message every command prints when the pack cannot be found.
#[must_use]
pub fn not_found_message() -> String {
    "could not locate the Kizuna SQL pack (pack.manifest.json). Tried, in order:\n\
     \x20   1. KSYNC_PACK_DIR: not set, or set to a directory with no pack.manifest.json\n\
     \x20   2. a pack/ directory beside this executable: not found\n\
     \x20   3. packages/supabase-pack beside the nearest target/ above this binary: not found,\n\
     \x20      or this binary is not a cargo dev build of this checkout\n\
     \x20 Set KSYNC_PACK_DIR to the directory carrying pack.manifest.json."
        .to_owned()
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn write_pack(root: &Path, layout_with_migrations: bool) -> PathBuf {
        let pack_dir = root.join("packages").join("supabase-pack");
        let sql_dir = if layout_with_migrations {
            pack_dir.join("supabase").join("migrations")
        } else {
            pack_dir.clone()
        };
        std::fs::create_dir_all(&sql_dir).unwrap();
        std::fs::write(
            pack_dir.join(MANIFEST),
            r#"{"pack":["0001_kizuna_init.sql"],"demo":["0002_example.sql"]}"#,
        )
        .unwrap();
        std::fs::write(sql_dir.join("0001_kizuna_init.sql"), "select 1;\n").unwrap();
        std::fs::write(sql_dir.join("0002_example.sql"), "select 2;\n").unwrap();

        pack_dir
    }

    #[test]
    fn the_env_override_wins() {
        let dir = tempfile::tempdir().unwrap();
        let pack_dir = write_pack(dir.path(), true);
        let env = Env::from_pairs(&[("KSYNC_PACK_DIR", pack_dir.to_str().unwrap())]);

        assert_eq!(resolve_pack_dir(&env), Some(pack_dir));
    }

    #[test]
    fn an_env_override_with_no_manifest_falls_through_instead_of_answering_it() {
        let dir = tempfile::tempdir().unwrap();
        let env = Env::from_pairs(&[("KSYNC_PACK_DIR", dir.path().to_str().unwrap())]);

        // `dir` carries no manifest, so the env rung must not be the answer:
        // the ladder falls through to the executable rungs (whatever those
        // find in this process, real or none, is never this empty directory).
        assert_ne!(resolve_pack_dir(&env), Some(dir.path().to_path_buf()));
    }

    #[test]
    fn beside_the_executable_finds_a_bundled_pack() {
        let dir = tempfile::tempdir().unwrap();
        let pack_dir = dir.path().join("pack");
        std::fs::create_dir_all(&pack_dir).unwrap();
        std::fs::write(pack_dir.join(MANIFEST), r#"{"pack":[]}"#).unwrap();

        assert_eq!(beside_executable(dir.path()), Some(pack_dir));
    }

    #[test]
    fn beside_the_executable_is_none_without_a_manifest_there() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(beside_executable(dir.path()), None);
    }

    #[test]
    fn checkout_pack_finds_the_repo_root_above_the_executables_own_target_dir() {
        let dir = tempfile::tempdir().unwrap();
        let pack_dir = write_pack(dir.path(), true);
        let exe = dir.path().join("target").join("debug").join("kizunasync");

        assert_eq!(checkout_pack(&exe), Some(pack_dir));
    }

    /// A checkout cloned under an outer directory named `target` is still
    /// found: the walk stops at the `target/` nearest the executable.
    #[test]
    fn checkout_pack_takes_the_target_directory_nearest_the_executable() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = dir.path().join("target").join("kizunasync");
        let pack_dir = write_pack(&checkout, true);
        let exe = checkout.join("target").join("debug").join("kizunasync");

        assert_eq!(checkout_pack(&exe), Some(pack_dir));
    }

    /// The nearest `target/` is the only one weighed: a pack beside an outer
    /// `target/` is another checkout, so nothing matches.
    #[test]
    fn a_nearest_target_directory_without_the_pack_beside_it_matches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        write_pack(dir.path(), true);
        let exe = dir
            .path()
            .join("target")
            .join("elsewhere")
            .join("target")
            .join("debug")
            .join("kizunasync");

        assert_eq!(checkout_pack(&exe), None);
    }

    #[test]
    fn an_executable_outside_any_target_directory_names_no_checkout_pack() {
        // The pack sits right there under `dir`, but the executable is not
        // under `dir/target/`, so this must not walk up and find it anyway.
        let dir = tempfile::tempdir().unwrap();
        write_pack(dir.path(), true);
        let exe = dir.path().join("bin").join("kizunasync");

        assert_eq!(checkout_pack(&exe), None);
    }

    #[test]
    fn only_the_manifests_pack_array_is_read_not_the_demo_files() {
        let dir = tempfile::tempdir().unwrap();
        let pack_dir = write_pack(dir.path(), true);
        let files = read_pack_files(&pack_dir).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "0001_kizuna_init.sql");
        assert_eq!(files[0].sql, "select 1;\n");
    }

    #[test]
    fn a_flat_bundled_layout_reads_the_same_files() {
        let dir = tempfile::tempdir().unwrap();
        let pack_dir = write_pack(dir.path(), false);
        let files = read_pack_files(&pack_dir).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].sql, "select 1;\n");
    }

    #[test]
    fn a_malformed_manifest_fails_loudly() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(MANIFEST), "{\"pack\": 3}").unwrap();

        assert!(read_pack_manifest(dir.path()).is_err());
    }

    #[test]
    fn read_pack_files_fails_when_a_manifest_entry_is_missing_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let pack_dir = dir.path().join("packages").join("supabase-pack");
        std::fs::create_dir_all(&pack_dir).unwrap();
        std::fs::write(
            pack_dir.join(MANIFEST),
            r#"{"pack":["0001_kizuna_init.sql"]}"#,
        )
        .unwrap();

        let Error::Pack(message) = read_pack_files(&pack_dir).unwrap_err() else {
            panic!("a manifest entry with no file is a pack failure");
        };

        assert!(message.contains("0001_kizuna_init.sql"), "{message}");
    }
}
