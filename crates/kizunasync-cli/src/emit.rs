//! Naming and planning what `init` writes into `supabase/migrations/`.
//!
//! Supabase names migrations `<YYYYMMDDHHMMSS>_<label>.sql`, so each pack file is
//! emitted under a fresh UTC timestamp: they sort after the app's own migrations
//! and apply in pack order. One base instant plus an incrementing offset per file
//! keeps the emitted names strictly increasing and stable within a run: the
//! trailing config migration therefore always sorts last.
//!
//! Idempotency here is the OFFLINE stand-in only. The authoritative signal is the
//! content-hashed `kizunasync._provisions` ledger ([`crate::provision`]); a
//! `--dry-run` or `--local-only` run cannot read it, so the emitted filename's
//! `_kizunasync_<label>.sql` suffix answers "did a previous run already write this?"
//! instead. A re-apply the wizard confirmed is the exception: it writes every
//! pack file again under a fresh timestamp ([`plan_reapply`]).

use std::path::Path;

use crate::clock::{migration_second, migration_version};
use crate::pack::PackFile;

/// The label the trailing config-bridge migration carries.
pub const CONFIG_MIGRATION_LABEL: &str = "config";

/// The prefix every emitted migration carries under its timestamp.
const EMIT_PREFIX: &str = "kizunasync";

/// One pack file's place in the emission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    /// The pack file to copy.
    pub source: PackFile,
    /// The timestamped name it is written under.
    pub target_name: String,
}

/// What a run will and will not emit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EmitPlan {
    /// Files to write, in pack order.
    pub to_emit: Vec<PlannedFile>,
    /// Pack files a previous run already emitted, by original name.
    pub skipped: Vec<String>,
    /// Every file re-applies a pack the ledger records under another hash, so
    /// its ledger row replaces the recorded one instead of keeping it.
    pub reapply: bool,
}

/// The descriptive label emitted under the `_kizunasync_` prefix: Supabase's `NNNN_`
/// numeric prefix and a redundant leading product token are stripped, so
/// `0001_kizuna_init.sql` reads `init`.
#[must_use]
pub fn pack_label(pack_file_name: &str) -> String {
    let digits = pack_file_name
        .chars()
        .take_while(char::is_ascii_digit)
        .count();
    let after_digits = pack_file_name
        .get(digits..)
        .and_then(|rest| rest.strip_prefix('_'))
        .filter(|_| digits > 0)
        .unwrap_or(pack_file_name);
    let stem = after_digits.strip_suffix(".sql").unwrap_or(after_digits);

    stem.strip_prefix("kizuna_").unwrap_or(stem).to_owned()
}

/// One pack file's emitted name: the base instant plus `offset_seconds`, then the
/// pack label.
#[must_use]
pub fn timestamped_name(pack_file_name: &str, base_secs: i64, offset_seconds: i64) -> String {
    emitted_name(&pack_label(pack_file_name), base_secs, offset_seconds)
}

/// The trailing config-bridge migration's name, offset past every pack file so it
/// applies last.
#[must_use]
pub fn config_migration_name(base_secs: i64, offset_seconds: i64) -> String {
    emitted_name(CONFIG_MIGRATION_LABEL, base_secs, offset_seconds)
}

fn emitted_name(label: &str, base_secs: i64, offset_seconds: i64) -> String {
    format!(
        "{}_{EMIT_PREFIX}_{label}.sql",
        utc_stamp(base_secs.saturating_add(offset_seconds))
    )
}

/// Whether `name`, the name a migration history records for a migration
/// (its file name between the version and `.sql`), is one this CLI writes:
/// the `kizunasync_` prefix and a lowercase label.
#[must_use]
pub fn is_emitted_name(name: &str) -> bool {
    name.strip_prefix(EMIT_PREFIX)
        .and_then(|rest| rest.strip_prefix('_'))
        .is_some_and(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
}

/// `.sql` names already in the app's migrations directory, sorted. An absent
/// directory is an empty list: a project that has never run `supabase init` has
/// emitted nothing.
#[must_use]
pub fn app_migration_names(migrations_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(migrations_dir) else {
        return Vec::new();
    };

    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.file_name()))
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| {
            std::path::Path::new(name)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("sql"))
        })
        .collect();
    names.sort();

    names
}

/// Has this pack file already been emitted, judged by its `_kizunasync_<label>.sql`
/// suffix?
#[must_use]
pub fn already_emitted(pack_file_name: &str, existing: &[String]) -> bool {
    let suffix = format!("_{EMIT_PREFIX}_{}.sql", pack_label(pack_file_name));

    existing.iter().any(|name| name.ends_with(&suffix))
}

/// Has a previous run already emitted the config-bridge migration? Re-emitting
/// would stack duplicates of an idempotent migration for no gain.
#[must_use]
pub fn config_already_emitted(existing: &[String]) -> bool {
    already_emitted(&format!("{CONFIG_MIGRATION_LABEL}.sql"), existing)
}

/// Plan the emission: every pack file not already emitted, each under its own
/// strictly-increasing timestamp.
#[must_use]
pub fn plan_emit(pack_files: &[PackFile], existing: &[String], base_secs: i64) -> EmitPlan {
    let mut plan = EmitPlan::default();
    let mut offset = 0_i64;
    for file in pack_files {
        if already_emitted(&file.name, existing) {
            plan.skipped.push(file.name.clone());
            continue;
        }
        plan.to_emit.push(PlannedFile {
            source: file.clone(),
            target_name: timestamped_name(&file.name, base_secs, offset),
        });
        offset += 1;
    }

    plan
}

/// Plan a re-apply: every pack file under its own fresh timestamp, including
/// the ones whose label a previous run already emitted. The older migration
/// stays where it is, and the new one sorts after it, so the directory
/// rebuilds to this pack.
#[must_use]
pub fn plan_reapply(pack_files: &[PackFile], base_secs: i64) -> EmitPlan {
    let to_emit = pack_files
        .iter()
        .zip(0_i64..)
        .map(|(file, offset)| PlannedFile {
            source: file.clone(),
            target_name: timestamped_name(&file.name, base_secs, offset),
        })
        .collect();

    EmitPlan {
        to_emit,
        skipped: Vec::new(),
        reapply: true,
    }
}

/// The second the next migration this CLI writes is named after: `now_unix`,
/// or one second past the latest version in `taken` when that is later.
#[must_use]
pub fn next_migration_second(now_unix: i64, taken: &[String]) -> i64 {
    taken
        .iter()
        .filter_map(|version| migration_second(version))
        .map(|second| second.saturating_add(1))
        .fold(now_unix, i64::max)
}

/// `YYYYMMDDHHMMSS` in UTC: the filename convention the Supabase CLI orders
/// migrations by.
fn utc_stamp(secs: i64) -> String {
    migration_version(secs)
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// 2023-11-14T22:13:20Z: a fixed instant, so every name below is exact.
    const FIXED: i64 = 1_700_000_000;

    fn pack(names: &[&str]) -> Vec<PackFile> {
        names
            .iter()
            .map(|name| PackFile {
                name: (*name).to_owned(),
                sql: format!("-- {name}\n"),
            })
            .collect()
    }

    fn owned(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn the_epoch_and_a_known_instant_both_convert_exactly() {
        assert_eq!(utc_stamp(0), "19700101000000");
        assert_eq!(utc_stamp(FIXED), "20231114221320");
    }

    #[test]
    fn a_leap_day_is_not_off_by_one() {
        // 2024-02-29T00:00:00Z
        assert_eq!(utc_stamp(1_709_164_800), "20240229000000");
        // 2000-02-29T12:34:56Z: the century leap year.
        assert_eq!(utc_stamp(951_827_696), "20000229123456");
    }

    /// Two migrations written in the same second never share a version: the
    /// second one takes the second after the first.
    #[test]
    fn the_next_migration_takes_the_second_after_the_latest_taken_version() {
        let taken = |seconds: &[i64]| -> Vec<String> {
            seconds.iter().map(|second| utc_stamp(*second)).collect()
        };

        assert_eq!(next_migration_second(FIXED, &[]), FIXED);
        assert_eq!(next_migration_second(FIXED, &taken(&[FIXED - 60])), FIXED);
        assert_eq!(next_migration_second(FIXED, &taken(&[FIXED])), FIXED + 1);
        assert_eq!(
            next_migration_second(FIXED, &taken(&[FIXED - 1, FIXED + 5, FIXED])),
            FIXED + 6
        );
    }

    /// Only a version shaped like the ones this CLI writes can collide with
    /// one; any other shape leaves the clock's second as it is.
    #[test]
    fn a_version_of_another_shape_leaves_the_second_as_it_is() {
        assert_eq!(
            next_migration_second(FIXED, &owned(&["0001", "99999999999999999"])),
            FIXED
        );
    }

    #[test]
    fn the_pack_label_strips_the_numeric_prefix_and_the_product_token() {
        assert_eq!(pack_label("0001_kizuna_init.sql"), "init");
        assert_eq!(pack_label("0006_push_policy.sql"), "push_policy");
        assert_eq!(pack_label("init.sql"), "init");
        assert_eq!(pack_label("kizuna_init.sql"), "init");
    }

    #[test]
    fn an_emitted_name_carries_the_stamp_the_prefix_and_the_label() {
        assert_eq!(
            timestamped_name("0001_kizuna_init.sql", FIXED, 0),
            "20231114221320_kizunasync_init.sql"
        );
        assert_eq!(
            config_migration_name(FIXED, 2),
            "20231114221322_kizunasync_config.sql"
        );
    }

    #[test]
    fn every_file_in_a_plan_gets_a_strictly_increasing_stamp() {
        let plan = plan_emit(
            &pack(&["0001_kizuna_init.sql", "0002_rpcs.sql"]),
            &[],
            FIXED,
        );
        let names: Vec<&str> = plan
            .to_emit
            .iter()
            .map(|file| file.target_name.as_str())
            .collect();

        assert_eq!(
            names,
            [
                "20231114221320_kizunasync_init.sql",
                "20231114221321_kizunasync_rpcs.sql"
            ]
        );
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn a_file_whose_label_is_already_on_disk_is_skipped_not_re_emitted() {
        let existing = owned(&[
            "20200101000000_kizunasync_init.sql",
            "20200101000001_app.sql",
        ]);
        let plan = plan_emit(
            &pack(&["0001_kizuna_init.sql", "0002_rpcs.sql"]),
            &existing,
            FIXED,
        );

        assert_eq!(plan.skipped, ["0001_kizuna_init.sql"]);
        assert_eq!(plan.to_emit.len(), 1);
        // The surviving file takes the first offset: skipping never leaves a gap.
        assert_eq!(
            plan.to_emit[0].target_name,
            "20231114221320_kizunasync_rpcs.sql"
        );
    }

    /// A re-apply never skips: the label an earlier run emitted is exactly the
    /// file that has to be written again.
    #[test]
    fn a_reapply_plans_every_pack_file_even_when_its_label_is_on_disk() {
        let pack_files = pack(&["0001_kizuna_init.sql", "0002_rpcs.sql"]);
        let plan = plan_reapply(&pack_files, FIXED);

        assert_eq!(
            plan,
            EmitPlan {
                to_emit: vec![
                    PlannedFile {
                        source: pack_files[0].clone(),
                        target_name: "20231114221320_kizunasync_init.sql".to_owned(),
                    },
                    PlannedFile {
                        source: pack_files[1].clone(),
                        target_name: "20231114221321_kizunasync_rpcs.sql".to_owned(),
                    },
                ],
                skipped: Vec::new(),
                reapply: true,
            }
        );
        assert!(already_emitted(
            "0001_kizuna_init.sql",
            &owned(&["20200101000000_kizunasync_init.sql"])
        ));
        assert!(!plan_emit(&pack_files, &[], FIXED).reapply);
    }

    #[test]
    fn the_config_migration_is_detected_by_the_same_suffix_rule() {
        assert!(config_already_emitted(&owned(&[
            "20200101000000_kizunasync_config.sql"
        ])));
        assert!(!config_already_emitted(&owned(&[
            "20200101000000_kizunasync_init.sql"
        ])));
        assert!(!config_already_emitted(&[]));
    }

    #[test]
    fn an_app_migration_that_merely_contains_the_label_is_not_a_match() {
        assert!(!already_emitted(
            "0001_kizuna_init.sql",
            &owned(&["20200101000000_kizunasync_init_extras.sql"])
        ));
    }

    /// The name the Supabase CLI records for a migration file: what sits
    /// between the version and `.sql`.
    fn recorded_name(file_name: &str) -> &str {
        let stem = file_name.strip_suffix(".sql").unwrap();

        stem.split_once('_').unwrap().1
    }

    #[test]
    fn every_migration_this_cli_writes_is_recorded_under_a_name_it_owns() {
        let pack_files = pack(&["0001_kizuna_init.sql", "0002_rpcs.sql"]);
        let mut written: Vec<String> = plan_emit(&pack_files, &[], FIXED)
            .to_emit
            .into_iter()
            .map(|file| file.target_name)
            .collect();
        written.push(config_migration_name(FIXED, 2));
        written.push(crate::commands::sync::migration_name(FIXED));

        for file_name in &written {
            assert!(is_emitted_name(recorded_name(file_name)), "{file_name}");
        }
    }

    #[test]
    fn a_name_this_cli_never_writes_is_not_its_own() {
        for name in [
            "create_todos",
            "kizunasync",
            "kizunasync_",
            "kizunasync_Init",
            "kizunasync_init.sql",
            "kizunasync_init\u{1b}[2J",
            "my_kizunasync_init",
            "",
        ] {
            assert!(!is_emitted_name(name), "{name:?}");
        }
    }

    #[test]
    fn an_absent_migrations_directory_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();

        assert!(app_migration_names(&dir.path().join("supabase")).is_empty());
    }

    #[test]
    fn only_sql_files_are_listed_and_they_come_back_sorted() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["0002_b.sql", "0001_a.sql", "README.md"] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }

        assert_eq!(
            app_migration_names(dir.path()),
            ["0001_a.sql", "0002_b.sql"]
        );
    }
}
