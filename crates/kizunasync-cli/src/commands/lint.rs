//! `lint`: classify pending migrations additive vs breaking.
//!
//! The synced set is `kizunasync._config`, so what is linted is what the server
//! actually syncs rather than a second declaration that could disagree with it.
//!
//! Exit: `0` all additive (or nothing touches a synced table); `1` at least one
//! breaking change; `2` could not run (unreadable `_config`, no migrations
//! directory).

use crate::applier::Applier;
use crate::commands::{FAILURE, OK, UNUSABLE};
use crate::config::load_config_from_db;
use crate::lint::{Severity, scan_migrations};
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

/// The one thing this command can answer without a database. Called before a
/// connection is resolved, so a run from the wrong directory is told that
/// instead of being asked for credentials.
#[must_use]
pub fn refuse_without_migrations(paths: &ProjectPaths, ui: &mut Ui) -> Option<i32> {
    if paths.migrations_dir.is_dir() {
        return None;
    }

    ui.error("kizunasync lint: no supabase/migrations directory: run from your app root");

    Some(UNUSABLE)
}

/// Scan `supabase/migrations` against the project's synced tables.
pub fn run(applier: &dyn Applier, paths: &ProjectPaths, ui: &mut Ui) -> i32 {
    if let Some(code) = refuse_without_migrations(paths, ui) {
        return code;
    }

    let migrations_dir = &paths.migrations_dir;
    let config = match load_config_from_db(applier) {
        Ok(config) => config,
        Err(cause) => {
            ui.error(&format!("kizunasync lint: {cause}"));

            return UNUSABLE;
        }
    };
    let tables = config.synced_tables();
    if tables.is_empty() {
        ui.log("kizunasync lint: kizunasync._config declares no synced tables, nothing to lint");

        return OK;
    }

    let report = match scan_migrations(migrations_dir, &tables) {
        Ok(report) => report,
        Err(cause) => {
            ui.error(&format!("kizunasync lint: {cause}"));

            return UNUSABLE;
        }
    };
    ui.log(&format!(
        "kizunasync lint, {} synced table(s): {}\n(regex scan, biased to flagging; a flagged-but-safe migration is the accepted false positive)\n",
        tables.len(),
        tables.join(", ")
    ));
    if report.findings.is_empty() {
        ui.log("  no schema changes touch a synced table: additive by default");

        return OK;
    }

    for finding in &report.findings {
        let detail = format!(
            "{}  [{}]  {}",
            finding.file, finding.hit.table, finding.hit.detail
        );
        match finding.hit.severity {
            Severity::Breaking => ui.error(&format!("BREAKING  {detail}")),
            Severity::Additive => ui.success(&format!("additive  {detail}")),
        }
    }
    ui.log("");
    if report.breaking > 0 {
        ui.error(&format!(
            "{} breaking change(s): bump the schema version before shipping: `kizunasync sync --min-schema-version N` on the server and `schemaVersion` in `defineConfig` on the clients (stale clients then soft-block).",
            report.breaking
        ));

        return FAILURE;
    }

    ui.success(&format!(
        "{} additive change(s), 0 breaking: safe to ship",
        report.additive
    ));

    OK
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::applier::fake::{FakeApplier, text_row};
    use crate::constants::INTERNAL_CONFIG;
    use crate::ui::Capture;

    fn paths_for(root: &Path) -> ProjectPaths {
        ProjectPaths::rooted_at(root.to_path_buf())
    }

    fn project(migrations: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("supabase").join("migrations")).unwrap();
        for (name, sql) in migrations {
            std::fs::write(root.join("supabase").join("migrations").join(name), sql).unwrap();
        }

        (dir, root)
    }

    /// One synced table, as `kizunasync._config` answers for it.
    fn todos() -> FakeApplier {
        FakeApplier::new().answer(
            INTERNAL_CONFIG,
            vec![text_row(&[
                ("table_name", "todos"),
                ("sync_mode", "read-write"),
            ])],
        )
    }

    fn run_in(applier: &dyn Applier, root: &Path) -> (i32, Capture) {
        let (mut ui, capture) = Ui::capture();
        let code = run(applier, &paths_for(root), &mut ui);

        (code, capture)
    }

    #[test]
    fn no_migrations_directory_is_exit_two() {
        let dir = tempfile::tempdir().unwrap();
        let (code, capture) = run_in(&todos(), dir.path());

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("no supabase/migrations directory")
        );
    }

    #[test]
    fn an_unreadable_config_table_is_exit_two_and_says_so() {
        let (_guard, root) = project(&[]);
        let applier = FakeApplier::new().fail(INTERNAL_CONFIG, "connection refused");
        let (code, capture) = run_in(&applier, &root);

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("could not read kizunasync._config")
        );
        assert!(capture.stderr().contains("supabase start"));
    }

    #[test]
    fn a_project_with_no_synced_tables_is_a_clean_exit_zero() {
        let (_guard, root) = project(&[]);
        let (code, capture) = run_in(&FakeApplier::new(), &root);

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("declares no synced tables"));
    }

    #[test]
    fn migrations_that_touch_nothing_synced_are_additive_by_default() {
        let (_guard, root) = project(&[("0001.sql", "alter table other add column a text;")]);
        let (code, capture) = run_in(&todos(), &root);

        assert_eq!(code, OK);
        assert!(
            capture
                .stderr()
                .contains("no schema changes touch a synced table")
        );
    }

    #[test]
    fn an_additive_migration_passes_and_is_counted() {
        let (_guard, root) = project(&[("0001.sql", "alter table todos add column a text;")]);
        let (code, capture) = run_in(&todos(), &root);

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("additive  0001.sql  [todos]"));
        assert!(
            capture
                .stderr()
                .contains("1 additive change(s), 0 breaking")
        );
    }

    #[test]
    fn a_breaking_migration_is_exit_one_and_asks_for_a_version_bump() {
        let (_guard, root) = project(&[("0001.sql", "alter table todos drop column a;")]);
        let (code, capture) = run_in(&todos(), &root);

        assert_eq!(code, FAILURE);
        assert!(capture.stderr().contains("BREAKING  0001.sql  [todos]"));
        assert!(capture.stderr().contains("1 breaking change(s)"));
        // Both knobs, because bumping one without the other blocks nothing.
        assert!(
            capture
                .stderr()
                .contains("`kizunasync sync --min-schema-version N` on the server")
        );
        assert!(
            capture
                .stderr()
                .contains("`schemaVersion` in `defineConfig` on the clients")
        );
    }

    /// The whole classification, as a growing project tree walks it. The
    /// synced set lives in the database, so this runs against the fake
    /// `Applier` rather than as a process-level test.
    #[test]
    fn a_project_tree_classifies_additive_then_breaking_as_it_grows() {
        let (_guard, root) = project(&[("0001.sql", "alter table todos add column a text;")]);
        let (code, capture) = run_in(&todos(), &root);

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("1 synced table(s): todos"));
        assert!(capture.stderr().contains("additive  0001.sql  [todos]"));
        assert!(capture.stderr().contains("0 breaking"));
        assert_eq!(capture.stdout(), "");

        std::fs::write(
            root.join("supabase").join("migrations").join("0002.sql"),
            "alter table todos drop column a;",
        )
        .unwrap();
        let (code, capture) = run_in(&todos(), &root);

        assert_eq!(code, FAILURE);
        assert!(capture.stderr().contains("BREAKING  0002.sql  [todos]"));
        assert!(capture.stderr().contains("1 breaking change(s)"));
    }

    #[test]
    fn the_report_never_touches_stdout() {
        let (_guard, root) = project(&[("0001.sql", "alter table todos drop column a;")]);
        let (_, capture) = run_in(&todos(), &root);

        assert_eq!(capture.stdout(), "");
    }
}
