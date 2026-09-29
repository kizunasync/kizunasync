//! The migration history a database records, compared with the files in
//! `supabase/migrations/`.
//!
//! The Supabase CLI refuses to push when the history table
//! (`supabase_migrations.schema_migrations`) and the local directory disagree:
//! a recorded version with no local file is always refused, and a local file
//! older than the newest recorded version is skipped unless `--include-all` is
//! passed. The same two lists are compared here before a file is written, so a
//! run stops (or repairs the history) before it leaves migrations on disk that
//! `supabase db push` would then refuse.

use std::cmp::Ordering;
use std::path::Path;

use crate::applier::Applier;
use crate::error::{Error, Result};
use crate::row::{optional_string, require_bool, require_string};

/// Whether the history table exists at all, and whether it has the `name`
/// column the Supabase CLI records each migration's name in: a database the
/// Supabase CLI never pushed to has no table, which is an empty history
/// rather than a failure.
#[must_use]
pub fn history_present_query() -> String {
    "select to_regclass('supabase_migrations.schema_migrations') is not null as present, \
     exists (select 1 from pg_catalog.pg_attribute \
     where attrelid = to_regclass('supabase_migrations.schema_migrations')::oid \
     and attname = 'name' and not attisdropped) as named;"
        .to_owned()
}

/// Every version the history records, oldest first, for a history with no
/// `name` column.
pub const APPLIED_VERSIONS_QUERY: &str =
    "select version from supabase_migrations.schema_migrations order by version;";

/// Every version the history records with its name, oldest first.
pub const APPLIED_MIGRATIONS_QUERY: &str =
    "select version, name from supabase_migrations.schema_migrations order by version;";

/// One migration the history records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedMigration {
    /// The version, all digits.
    pub version: String,
    /// The name the Supabase CLI recorded beside it, `None` when the history
    /// has no `name` column or the row carries none.
    pub name: Option<String>,
}

/// The migrations the database's migration history records, oldest first.
///
/// # Errors
/// Returns the transport's own failure, and [`Error::Boundary`] when the
/// presence probe does not return exactly one row of two booleans, a history
/// row carries no text `version`, or a recorded `version` is not all digits:
/// a version reaches `supabase migration repair`'s argv and every printed
/// hint verbatim, so a stray row must never smuggle a flag or a shell
/// metacharacter into either.
pub fn read_applied_migrations(applier: &dyn Applier) -> Result<Vec<AppliedMigration>> {
    let rows = applier.run_query(&history_present_query())?;
    if rows.len() != 1 {
        return Err(Error::Boundary(format!(
            "the migration-history presence probe returned {} rows, expected exactly 1",
            rows.len()
        )));
    }
    let Some(row) = rows.first() else {
        return Err(Error::Boundary(
            "the migration-history presence probe returned no row, expected exactly 1".to_owned(),
        ));
    };
    if !require_bool(row, "present")? {
        return Ok(Vec::new());
    }

    let named = require_bool(row, "named")?;
    let query = if named {
        APPLIED_MIGRATIONS_QUERY
    } else {
        APPLIED_VERSIONS_QUERY
    };

    applier
        .run_query(query)?
        .iter()
        .map(|row| {
            let version = require_string(row, "version")?;
            if !is_version(&version) {
                return Err(Error::Boundary(format!(
                    "the migration history recorded {version:?}, which is not a plain digit version"
                )));
            }

            // An empty name says no more about who wrote the file than none.
            let name = if named {
                optional_string(row, "name")?.filter(|name| !name.is_empty())
            } else {
                None
            };

            Ok(AppliedMigration { version, name })
        })
        .collect()
}

/// Whether `value` is a migration version as Supabase's own naming and
/// history table use it: one or more ASCII digits, nothing else.
fn is_version(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// The versions of the migrations in `migrations_dir`, sorted: the leading
/// digit run of every `<digits>_<name>.sql` or `<digits>.sql` file, Supabase's
/// naming convention. A missing or unreadable directory holds none.
#[must_use]
pub fn local_versions(migrations_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(migrations_dir) else {
        return Vec::new();
    };
    let mut versions: Vec<String> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            version_of(&entry.file_name().to_string_lossy())
        })
        .collect();
    versions.sort_by(|left, right| compare_versions(left, right));

    versions
}

/// The version of one migration file name, as [`local_versions`] reads it;
/// `None` for a name Supabase's convention does not cover.
#[must_use]
pub fn version_of(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".sql")?;
    let digits = stem.len() - stem.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    let (version, rest) = stem.split_at(digits);
    if !rest.is_empty() && !rest.starts_with('_') {
        return None;
    }

    Some(version.to_owned())
}

/// Numeric order without parsing: a shorter digit run is the smaller number, so
/// `0001` sorts before a 14-digit timestamp.
fn compare_versions(left: &str, right: &str) -> Ordering {
    (left.len(), left).cmp(&(right.len(), right))
}

/// Where the history and the directory disagree in a way `supabase db push`
/// refuses.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HistoryDrift {
    /// Versions the history records with no local file.
    pub remote_only: Vec<String>,
    /// Local versions the history does not record, older than the newest
    /// version it does.
    pub local_behind: Vec<String>,
}

impl HistoryDrift {
    /// Whether `supabase db push` would accept the pair as it is.
    #[must_use]
    pub const fn is_clean(&self) -> bool {
        self.remote_only.is_empty() && self.local_behind.is_empty()
    }
}

/// Compare the local versions with the applied ones.
#[must_use]
pub fn compare(local: &[String], applied: &[String]) -> HistoryDrift {
    let mut remote_only: Vec<String> = applied
        .iter()
        .filter(|version| !local.contains(version))
        .cloned()
        .collect();
    remote_only.sort_by(|left, right| compare_versions(left, right));

    let newest = applied
        .iter()
        .max_by(|left, right| compare_versions(left, right));
    let mut local_behind: Vec<String> = newest.map_or_else(Vec::new, |newest| {
        local
            .iter()
            .filter(|version| {
                !applied.contains(version) && compare_versions(version, newest) == Ordering::Less
            })
            .cloned()
            .collect()
    });
    local_behind.sort_by(|left, right| compare_versions(left, right));

    HistoryDrift {
        remote_only,
        local_behind,
    }
}

/// History rows for the fakes of every command that reads the history.
#[cfg(test)]
pub(crate) mod fake {
    use super::AppliedMigration;

    /// The rows a history holds, each written as the stem of the file the
    /// Supabase CLI recorded it from: `<version>_<name>`, or `<version>` alone
    /// for a row with no recorded name.
    pub(crate) fn recorded(entries: &[&str]) -> Vec<AppliedMigration> {
        entries
            .iter()
            .map(|entry| match entry.split_once('_') {
                Some((version, name)) => AppliedMigration {
                    version: version.to_owned(),
                    name: Some(name.to_owned()),
                },
                None => AppliedMigration {
                    version: (*entry).to_owned(),
                    name: None,
                },
            })
            .collect()
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::applier::fake::{FakeApplier, row, text_row};

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    // MARK: - local versions

    #[test]
    fn local_versions_reads_timestamped_and_numbered_files_and_ignores_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "20260926145315_kizunasync_config.sql",
            "20260926145314_kizunasync_init.sql",
            "0001_kizuna_init.sql",
            "20260101000000.sql",
            "notes.md",
            "README",
            "draft_20260101.sql",
            "20260102x.sql",
        ] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }

        assert_eq!(
            local_versions(dir.path()),
            strings(&["0001", "20260101000000", "20260926145314", "20260926145315"])
        );
    }

    #[test]
    fn a_missing_directory_holds_no_versions() {
        let dir = tempfile::tempdir().unwrap();

        assert!(local_versions(&dir.path().join("missing")).is_empty());
    }

    // MARK: - compare

    #[test]
    fn the_same_versions_on_both_sides_are_clean() {
        let versions = strings(&["20260101000000", "20260102000000"]);
        let drift = compare(&versions, &versions);

        assert!(drift.is_clean(), "{drift:?}");
    }

    #[test]
    fn pending_local_files_newer_than_the_history_are_clean() {
        let drift = compare(
            &strings(&["20260101000000", "20260926145314"]),
            &strings(&["20260101000000"]),
        );

        assert!(drift.is_clean(), "{drift:?}");
    }

    #[test]
    fn a_recorded_version_with_no_file_is_remote_only() {
        let drift = compare(
            &strings(&["20260926145314"]),
            &strings(&["20260925201900", "20260101000000"]),
        );

        assert_eq!(
            drift.remote_only,
            strings(&["20260101000000", "20260925201900"])
        );
        assert!(drift.local_behind.is_empty());
        assert!(!drift.is_clean());
    }

    #[test]
    fn an_unapplied_file_older_than_the_newest_record_is_local_behind() {
        let drift = compare(
            &strings(&["0001", "20260101000000", "20260926145314"]),
            &strings(&["20260101000000", "20260925201900", "20260926145314"]),
        );

        assert_eq!(drift.local_behind, strings(&["0001"]));
        assert_eq!(drift.remote_only, strings(&["20260925201900"]));
    }

    #[test]
    fn a_short_version_sorts_before_a_timestamp() {
        let drift = compare(&strings(&["0002", "0001"]), &strings(&["20260101000000"]));

        assert_eq!(drift.local_behind, strings(&["0001", "0002"]));
    }

    #[test]
    fn an_empty_history_has_nothing_behind_it() {
        let drift = compare(&strings(&["0001", "20260101000000"]), &[]);

        assert!(drift.is_clean(), "{drift:?}");
    }

    // MARK: - the history read

    /// The presence probe's answer: whether the table exists, and whether it
    /// has the `name` column the Supabase CLI records each migration's name in.
    fn probed(present: bool, named: bool) -> Vec<crate::row::Row> {
        vec![row(&[
            ("present", Value::Bool(present)),
            ("named", Value::Bool(named)),
        ])]
    }

    fn migration(version: &str, name: Option<&str>) -> AppliedMigration {
        AppliedMigration {
            version: version.to_owned(),
            name: name.map(str::to_owned),
        }
    }

    #[test]
    fn an_absent_history_table_is_an_empty_history() {
        let applier = FakeApplier::new().answer("as present", probed(false, false));

        assert!(read_applied_migrations(&applier).unwrap().is_empty());
        assert_eq!(applier.executed.borrow().len(), 1);
    }

    #[test]
    fn a_present_history_table_answers_each_version_with_its_recorded_name() {
        let applier = FakeApplier::new()
            .answer("as present", probed(true, true))
            .answer(
                "select version, name from",
                vec![
                    text_row(&[("version", "20260101000000"), ("name", "create_todos")]),
                    text_row(&[("version", "20260925201900"), ("name", "kizunasync_config")]),
                ],
            );

        assert_eq!(
            read_applied_migrations(&applier).unwrap(),
            [
                migration("20260101000000", Some("create_todos")),
                migration("20260925201900", Some("kizunasync_config")),
            ]
        );
    }

    #[test]
    fn a_history_without_a_name_column_answers_every_name_unknown() {
        let applier = FakeApplier::new()
            .answer("as present", probed(true, false))
            .answer(
                "select version from",
                vec![text_row(&[("version", "20260925201900")])],
            );

        assert_eq!(
            read_applied_migrations(&applier).unwrap(),
            [migration("20260925201900", None)]
        );
    }

    #[test]
    fn a_row_with_no_recorded_name_answers_an_unknown_name() {
        let applier = FakeApplier::new()
            .answer("as present", probed(true, true))
            .answer(
                "select version, name from",
                vec![row(&[
                    ("version", Value::String("20260925201900".to_owned())),
                    ("name", Value::Null),
                ])],
            );

        assert_eq!(
            read_applied_migrations(&applier).unwrap(),
            [migration("20260925201900", None)]
        );
    }

    #[test]
    fn a_presence_probe_without_exactly_one_row_is_a_boundary_error() {
        let error = read_applied_migrations(&FakeApplier::new()).unwrap_err();

        assert!(matches!(error, Error::Boundary(_)), "{error:?}");
    }

    #[test]
    fn a_failed_history_read_is_an_error_never_an_empty_history() {
        let applier = FakeApplier::new()
            .answer("as present", probed(true, true))
            .fail("select version, name from", "permission denied");

        assert!(read_applied_migrations(&applier).is_err());
    }

    #[test]
    fn a_non_digit_recorded_version_is_a_boundary_error_not_a_usable_version() {
        for bad in [
            "--project-ref=evil",
            "20260101000000; drop",
            "",
            "20260101000000a",
        ] {
            let applier = FakeApplier::new()
                .answer("as present", probed(true, false))
                .answer("select version from", vec![text_row(&[("version", bad)])]);

            let Error::Boundary(message) = read_applied_migrations(&applier).unwrap_err() else {
                panic!("{bad:?} is not a valid recorded version");
            };
            assert!(message.contains(bad) || bad.is_empty(), "{bad}: {message}");
        }
    }
}
