//! Where the project actually lives.
//!
//! `kizunasync` gets run from wherever the developer happens to be: an `apps/web`
//! package, a nested example, a scratch directory two levels down, while the
//! files every command reads (`supabase/config.toml`, `supabase/migrations`)
//! sit at the project root. Supabase's own CLI answers that with two rules,
//! and this module is a port of them: an explicit `--workdir` or
//! `SUPABASE_WORKDIR` is used exactly as given (never walked), and otherwise
//! the root is the first ancestor of the working directory holding
//! `supabase/config.toml`.
//!
//! Resolution happens once per invocation and travels as a [`ProjectPaths`], so
//! this is the only place in the crate that spells the `supabase/` layout.

use std::path::{Path, PathBuf};

use crate::env::Env;

/// Supabase's own override, honoured with the precedence its CLI gives it.
const WORKDIR_ENV: &str = "SUPABASE_WORKDIR";

/// The project layout a command works against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectPaths {
    /// The project root: everything below is derived from it.
    pub root: PathBuf,
    /// `<root>/supabase`.
    pub supabase_dir: PathBuf,
    /// `<root>/supabase/config.toml`.
    pub config_toml: PathBuf,
    /// `<root>/supabase/migrations`.
    pub migrations_dir: PathBuf,
}

impl ProjectPaths {
    /// The layout a root implies. Pure path arithmetic: nothing here asks the
    /// filesystem whether any of it exists.
    #[must_use]
    pub fn rooted_at(root: PathBuf) -> Self {
        let supabase_dir = root.join("supabase");

        Self {
            config_toml: supabase_dir.join("config.toml"),
            migrations_dir: supabase_dir.join("migrations"),
            supabase_dir,
            root,
        }
    }

    /// Whether the root moved off the working directory: the one condition a
    /// command reports, so a walk-up or an override is never silent.
    #[must_use]
    pub fn is_relocated_from(&self, cwd: &Path) -> bool {
        self.root != cwd
    }
}

/// Resolve the project root, then the paths under it.
///
/// In order: the `--workdir` flag, then `SUPABASE_WORKDIR`, both used exactly
/// as given, resolved against `cwd` when relative and never walked up from.
/// Then the first ancestor of `cwd` (starting at `cwd` itself) holding
/// `supabase/config.toml`, then `cwd` unchanged.
#[must_use]
pub fn resolve(cwd: &Path, env: &Env, workdir_flag: Option<&Path>) -> ProjectPaths {
    let explicit = workdir_flag
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| env.get(WORKDIR_ENV).map(Path::new));
    if let Some(path) = explicit {
        return ProjectPaths::rooted_at(absolute(cwd, path));
    }

    let root = cwd
        .ancestors()
        .find(|ancestor| ancestor.join("supabase").join("config.toml").is_file())
        .map_or_else(|| cwd.to_path_buf(), Path::to_path_buf);

    ProjectPaths::rooted_at(root)
}

fn absolute(cwd: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }

    cwd.join(path)
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// A project root: the marker the walk looks for, and nothing else.
    fn mark(root: &Path) {
        std::fs::create_dir_all(root.join("supabase")).unwrap();
        std::fs::write(root.join("supabase").join("config.toml"), "[db]\n").unwrap();
    }

    #[test]
    fn the_flag_wins_over_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let flag = dir.path().join("from-flag");
        let env = Env::from_pairs(&[(WORKDIR_ENV, "/from-env")]);
        let paths = resolve(dir.path(), &env, Some(&flag));

        assert_eq!(paths.root, flag);
    }

    #[test]
    fn an_override_is_used_as_given_and_never_walked() {
        let dir = tempfile::tempdir().unwrap();
        mark(dir.path());
        let nested = dir.path().join("apps").join("web");
        std::fs::create_dir_all(&nested).unwrap();
        let env = Env::from_pairs(&[(WORKDIR_ENV, &nested.display().to_string())]);
        let paths = resolve(dir.path(), &env, None);

        assert_eq!(paths.root, nested);
        assert_eq!(
            paths.config_toml,
            nested.join("supabase").join("config.toml")
        );
    }

    #[test]
    fn a_relative_override_is_resolved_against_the_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        let env = Env::from_pairs(&[(WORKDIR_ENV, "..")]);

        assert_eq!(resolve(dir.path(), &env, None).root, dir.path().join(".."));
        assert_eq!(
            resolve(dir.path(), &Env::default(), Some(Path::new("nested"))).root,
            dir.path().join("nested")
        );
    }

    #[test]
    fn the_walk_stops_at_the_first_ancestor_holding_the_marker() {
        let dir = tempfile::tempdir().unwrap();
        mark(dir.path());
        let nested = dir.path().join("apps").join("web").join("src");
        std::fs::create_dir_all(&nested).unwrap();
        let paths = resolve(&nested, &Env::default(), None);

        assert_eq!(paths.root, dir.path());
        assert_eq!(paths.supabase_dir, dir.path().join("supabase"));
        assert_eq!(
            paths.migrations_dir,
            dir.path().join("supabase").join("migrations")
        );
        assert!(paths.is_relocated_from(&nested));
    }

    #[test]
    fn the_nearest_marker_wins_over_a_higher_one() {
        let dir = tempfile::tempdir().unwrap();
        mark(dir.path());
        let inner = dir.path().join("apps").join("web");
        mark(&inner);

        assert_eq!(resolve(&inner, &Env::default(), None).root, inner);
    }

    #[test]
    fn no_marker_anywhere_leaves_the_root_at_the_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        let paths = resolve(dir.path(), &Env::default(), None);

        assert_eq!(paths.root, dir.path());
        assert!(!paths.is_relocated_from(dir.path()));
    }
}
