//! `mock seed` and `mock churn`: test tooling.
//!
//! * **seed**: a deterministic, reproducible dataset from a fixed seed. The
//!   SQL comes from [`crate::mock_seed`] and is applied over a direct Postgres
//!   connection, never a service-role key.
//! * **churn**: deterministic, marker-scoped write churn for fencing and load
//!   testing. Statements come from [`crate::mock_churn`] and are applied one at
//!   a time, paced by `--interval-ms`.
//!
//! Target resolution is shared: `--table <name>` wins when given (validated as
//! a Postgres identifier); otherwise `kizunasync._config` decides: exactly one
//! synced table is used automatically, more than one asks for `--table`, none is
//! exit 2. Only the second branch needs a database, so `--table` keeps a dry run
//! offline.
//!
//! Seed safety: every seeded title carries [`MOCK_MARKER`], so a seed touches
//! only rows it created and `--clean` removes exactly that set with a single
//! predicate. Applying needs `--yes` (or `KSYNC_ALLOW_MOCK_SEED=1`);
//! `--dry-run` prints the SQL and changes nothing, and needs no database when
//! `--table` is given.

use std::time::Duration;

use crate::applier::Applier;
use crate::commands::{FAILURE, OK, UNUSABLE};
use crate::config::load_config_from_db;
use crate::db::is_valid_schema_name;
use crate::env::Env;
use crate::error::Result;
use crate::mock_churn::{ChurnSpec, build_churn_plan};
use crate::mock_seed::{MOCK_MARKER, SeedSpec, build_cleanup_sql, build_dataset, build_seed_sql};
use crate::ui::Ui;

/// Validate an explicit `--table`. `None` means the caller must resolve one
/// from the database instead.
///
/// # Errors
/// Returns [`Error::Config`](crate::error::Error::Config) when the flag is not
/// a Postgres identifier.
pub fn validate_target_flag(flag: Option<&str>) -> Result<Option<String>> {
    let Some(table) = flag.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if !is_valid_schema_name(table) {
        return Err(crate::error::Error::Config(format!(
            "--table \"{table}\" is not a valid Postgres identifier (letters, digits, underscores; must start with a letter or underscore)."
        )));
    }

    Ok(Some(table.to_owned()))
}

/// Resolve which table the run targets from `kizunasync._config`.
///
/// # Errors
/// Returns [`Error::Config`](crate::error::Error::Config) when `_config` cannot
/// be read, when it declares no synced table, or when it declares more than one
/// and no `--table` picks between them.
pub fn resolve_target_table(applier: &dyn Applier, ui: &mut Ui) -> Result<String> {
    let tables = load_config_from_db(applier)?.synced_tables();
    match tables.as_slice() {
        [] => Err(crate::error::Error::Config(
            "no synced tables found: pass --table <name> or run kizunasync init first.".to_owned(),
        )),
        [table] => {
            ui.log(&format!(
                "  using the only table in kizunasync._config: public.{table}"
            ));

            Ok(table.clone())
        }
        many => Err(crate::error::Error::Config(format!(
            "multiple synced tables found ({}): pass --table <name>.",
            many.join(", ")
        ))),
    }
}

/// Whether an apply is confirmed: `--yes`, or the documented escape hatch.
/// Public so a caller can decide not to open a connection it will not use.
#[must_use]
pub fn guard_allows(yes: bool, env: &Env) -> bool {
    yes || env.equals("KSYNC_ALLOW_MOCK_SEED", "1")
}

/// Flags `mock seed` accepts, plus the resolved target.
#[derive(Debug, Clone)]
pub struct SeedFlags {
    /// The dataset shape.
    pub spec: SeedSpec,
    /// The resolved target table.
    pub table: String,
    /// Print the SQL and stop.
    pub dry_run: bool,
    /// Confirm the write.
    pub yes: bool,
    /// Delete the seeded rows instead of writing them.
    pub clean: bool,
}

/// Print the plan, then apply it if the guard allows.
pub fn plan_and_seed(
    flags: &SeedFlags,
    env: &Env,
    execute: &dyn Fn(&str) -> Result<()>,
    ui: &mut Ui,
) -> i32 {
    if flags.clean {
        return plan_and_clean(flags, env, execute, ui);
    }

    let dataset = build_dataset(&flags.spec);
    let sql = build_seed_sql(&dataset, &flags.table);

    ui.log("kizunasync mock seed: plan (deterministic dataset)\n");
    ui.log(&format!(
        "  seed={}  rows={}  users={}  images={}",
        flags.spec.seed,
        dataset.rows.len(),
        dataset.users.len(),
        dataset
            .rows
            .iter()
            .filter(|row| row.image_path.is_some())
            .count()
    ));
    ui.log(&format!(
        "  target: public.{}  marker: cleanup via title LIKE '{MOCK_MARKER}%'\n",
        flags.table
    ));
    ui.write_stdout(&format!("{}\n", sql.trim_end()));

    if dataset.rows.is_empty() {
        ui.log("\n  0 rows requested, nothing to apply.");

        return OK;
    }

    if flags.dry_run {
        ui.log("\n  --dry-run: SQL shown; nothing applied.");

        return OK;
    }

    if !guard_allows(flags.yes, env) {
        ui.log("\n  this writes rows to your DB. Re-run with --yes (or KSYNC_ALLOW_MOCK_SEED=1) to apply.");

        return UNUSABLE;
    }

    if let Err(cause) = execute(&sql) {
        ui.log(&format!(
            "\n  seed apply failed:\n    {cause}\n  mock seed writes the demo column shape (id, user_id, title, done, image_path): the target table must carry it."
        ));

        return FAILURE;
    }

    ui.log(&format!("\n  seeded {} row(s).", dataset.rows.len()));

    OK
}

fn plan_and_clean(
    flags: &SeedFlags,
    env: &Env,
    execute: &dyn Fn(&str) -> Result<()>,
    ui: &mut Ui,
) -> i32 {
    let sql = build_cleanup_sql(&flags.table);
    ui.log("kizunasync mock seed --clean: plan\n");
    ui.write_stdout(&format!("{}\n", sql.trim_end()));

    if flags.dry_run {
        ui.log("\n  --dry-run: nothing applied.");

        return OK;
    }

    if !guard_allows(flags.yes, env) {
        ui.log("\n  this deletes seeded rows. Re-run with --yes (or KSYNC_ALLOW_MOCK_SEED=1) to apply.");

        return UNUSABLE;
    }

    if let Err(cause) = execute(&sql) {
        ui.log(&format!("\n  cleanup failed:\n    {cause}"));

        return FAILURE;
    }

    ui.log("\n  cleaned seeded rows.");

    OK
}

/// Flags `mock churn` accepts, plus the resolved target.
#[derive(Debug, Clone)]
pub struct ChurnFlags {
    /// How many writes.
    pub iterations: u64,
    /// PRNG seed.
    pub seed: u64,
    /// Milliseconds between writes; `0` disables pacing.
    pub interval_ms: u64,
    /// The resolved target table.
    pub table: String,
    /// Print the statements and stop.
    pub dry_run: bool,
    /// Confirm the writes.
    pub yes: bool,
}

/// Print the plan, then run it if the guard allows, pacing between statements.
pub fn plan_and_churn(
    flags: &ChurnFlags,
    env: &Env,
    execute: &dyn Fn(&str) -> Result<()>,
    sleep: &dyn Fn(Duration),
    ui: &mut Ui,
) -> i32 {
    let plan = build_churn_plan(&ChurnSpec {
        iterations: flags.iterations,
        seed: flags.seed,
        table: flags.table.clone(),
    });

    ui.log("kizunasync mock churn: plan (deterministic, marker-scoped writes)\n");
    ui.log(&format!(
        "  seed={}  iterations={}  interval={}ms  target: public.{}",
        flags.seed,
        plan.len(),
        flags.interval_ms,
        flags.table
    ));
    ui.log(&format!(
        "  every write is scoped to a row matching title LIKE '{MOCK_MARKER}%'; cleanup stays `mock seed --clean`.\n"
    ));
    ui.write_stdout(&format!(
        "{}\n",
        plan.iter()
            .map(|step| step.sql.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    ));

    if plan.is_empty() {
        ui.log("\n  0 iterations requested, nothing to apply.");

        return OK;
    }

    if flags.dry_run {
        ui.log("\n  --dry-run: statements shown; nothing applied.");

        return OK;
    }

    if !guard_allows(flags.yes, env) {
        ui.log(
            "\n  this writes to your DB. Re-run with --yes (or KSYNC_ALLOW_MOCK_SEED=1) to apply.",
        );

        return UNUSABLE;
    }

    let total = plan.len();
    for step in &plan {
        if let Err(cause) = execute(&step.sql) {
            ui.log(&format!(
                "\n  churn failed at step {}/{total}:\n    {cause}",
                step.index
            ));

            return FAILURE;
        }
        if flags.interval_ms > 0 && usize::try_from(step.index).unwrap_or(total) < total {
            sleep(Duration::from_millis(flags.interval_ms));
        }
    }
    ui.log(&format!("\n  applied {total} churn write(s)."));

    OK
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::applier::fake::{FakeApplier, text_row};
    use crate::constants::INTERNAL_CONFIG;
    use crate::error::Error;
    use crate::ui::Capture;

    struct Recorder {
        applied: RefCell<Vec<String>>,
        slept: RefCell<Vec<Duration>>,
        fail_at: Option<usize>,
    }

    impl Recorder {
        fn new() -> Self {
            Self {
                applied: RefCell::new(Vec::new()),
                slept: RefCell::new(Vec::new()),
                fail_at: None,
            }
        }

        fn failing_at(step: usize) -> Self {
            Self {
                fail_at: Some(step),
                ..Self::new()
            }
        }

        fn execute(&self) -> impl Fn(&str) -> Result<()> + '_ {
            move |sql: &str| {
                self.applied.borrow_mut().push(sql.to_owned());
                if self.fail_at == Some(self.applied.borrow().len()) {
                    return Err(Error::Db("column \"image_path\" does not exist".to_owned()));
                }

                Ok(())
            }
        }

        fn sleep(&self) -> impl Fn(Duration) + '_ {
            move |duration: Duration| self.slept.borrow_mut().push(duration)
        }
    }

    fn seed_flags(rows: u64) -> SeedFlags {
        SeedFlags {
            spec: SeedSpec {
                rows,
                users: 2,
                images: 0,
                seed: 1,
            },
            table: "todos".to_owned(),
            dry_run: false,
            yes: false,
            clean: false,
        }
    }

    fn churn_flags(iterations: u64) -> ChurnFlags {
        ChurnFlags {
            iterations,
            seed: 1,
            interval_ms: 0,
            table: "todos".to_owned(),
            dry_run: false,
            yes: false,
        }
    }

    fn seed(flags: &SeedFlags, env: &Env, recorder: &Recorder) -> (i32, Capture) {
        let (mut ui, capture) = Ui::capture();
        let code = plan_and_seed(flags, env, &recorder.execute(), &mut ui);

        (code, capture)
    }

    fn churn(flags: &ChurnFlags, env: &Env, recorder: &Recorder) -> (i32, Capture) {
        let (mut ui, capture) = Ui::capture();
        let code = plan_and_churn(flags, env, &recorder.execute(), &recorder.sleep(), &mut ui);

        (code, capture)
    }

    /// A `_config` answering the given synced tables.
    fn config_with(tables: &[&str]) -> FakeApplier {
        FakeApplier::new().answer(
            INTERNAL_CONFIG,
            tables
                .iter()
                .map(|table| text_row(&[("table_name", table), ("sync_mode", "pull-only")]))
                .collect(),
        )
    }

    #[test]
    fn a_table_flag_wins_and_must_be_an_identifier() {
        assert_eq!(
            validate_target_flag(Some("todos")).unwrap(),
            Some("todos".to_owned())
        );
        assert_eq!(validate_target_flag(None).unwrap(), None);
        assert_eq!(validate_target_flag(Some("")).unwrap(), None);
        let Error::Config(message) = validate_target_flag(Some("todos; drop")).unwrap_err() else {
            panic!("a non-identifier --table is a config failure");
        };
        assert!(
            message.contains("is not a valid Postgres identifier"),
            "{message}"
        );
    }

    #[test]
    fn a_lone_synced_table_is_used_automatically_and_announced() {
        let (mut ui, capture) = Ui::capture();
        let table = resolve_target_table(&config_with(&["todos"]), &mut ui).unwrap();

        assert_eq!(table, "todos");
        assert!(
            capture
                .stderr()
                .contains("using the only table in kizunasync._config")
        );
    }

    #[test]
    fn several_synced_tables_ask_for_the_flag_instead_of_guessing() {
        let (mut ui, _) = Ui::capture();
        let Error::Config(message) =
            resolve_target_table(&config_with(&["todos", "notes"]), &mut ui).unwrap_err()
        else {
            panic!("several synced tables is a config failure");
        };

        // The sentence is the contract: it lists the tables and names the flag.
        assert_eq!(
            message,
            "multiple synced tables found (notes, todos): pass --table <name>."
        );
    }

    #[test]
    fn a_project_with_no_synced_tables_asks_for_the_flag_or_init() {
        let (mut ui, _) = Ui::capture();
        let Error::Config(message) =
            resolve_target_table(&FakeApplier::new(), &mut ui).unwrap_err()
        else {
            panic!("a project with nothing synced is a config failure");
        };

        assert!(message.starts_with("no synced tables found"), "{message}");
    }

    #[test]
    fn an_unreadable_config_table_is_reported_rather_than_read_as_empty() {
        let (mut ui, _) = Ui::capture();
        let applier = FakeApplier::new().fail(INTERNAL_CONFIG, "connection refused");
        let Error::Config(message) = resolve_target_table(&applier, &mut ui).unwrap_err() else {
            panic!("an unreadable config table is a config failure");
        };

        assert!(
            message.contains("could not read kizunasync._config"),
            "{message}"
        );
    }

    #[test]
    fn the_seed_sql_is_the_machine_payload_and_the_stats_are_chrome() {
        let recorder = Recorder::new();
        let flags = SeedFlags {
            dry_run: true,
            ..seed_flags(2)
        };
        let (code, capture) = seed(&flags, &Env::default(), &recorder);

        assert_eq!(code, OK);
        assert!(
            capture
                .stdout()
                .starts_with("-- Generated by `kizunasync mock seed`.")
        );
        assert!(capture.stdout().contains("insert into public.\"todos\""));
        assert!(
            capture
                .stderr()
                .contains("seed=1  rows=2  users=2  images=0")
        );
        assert!(
            capture
                .stderr()
                .contains("--dry-run: SQL shown; nothing applied.")
        );
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn zero_rows_prints_the_comment_and_applies_nothing() {
        let recorder = Recorder::new();
        let flags = SeedFlags {
            yes: true,
            ..seed_flags(0)
        };
        let (code, capture) = seed(&flags, &Env::default(), &recorder);

        assert_eq!(code, OK);
        assert!(
            capture
                .stderr()
                .contains("0 rows requested, nothing to apply.")
        );
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn without_a_guard_the_write_is_refused() {
        let recorder = Recorder::new();
        let (code, capture) = seed(&seed_flags(2), &Env::default(), &recorder);

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("Re-run with --yes"));
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn the_environment_escape_hatch_allows_the_write() {
        let recorder = Recorder::new();
        let env = Env::from_pairs(&[("KSYNC_ALLOW_MOCK_SEED", "1")]);
        let (code, capture) = seed(&seed_flags(2), &env, &recorder);

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("seeded 2 row(s)."));
        assert_eq!(recorder.applied.borrow().len(), 1);
    }

    #[test]
    fn a_failed_seed_explains_the_column_shape_it_needs() {
        let recorder = Recorder::failing_at(1);
        let flags = SeedFlags {
            yes: true,
            ..seed_flags(2)
        };
        let (code, capture) = seed(&flags, &Env::default(), &recorder);

        assert_eq!(code, FAILURE);
        assert!(capture.stderr().contains("seed apply failed"));
        assert!(
            capture
                .stderr()
                .contains("id, user_id, title, done, image_path")
        );
    }

    #[test]
    fn clean_is_its_own_single_predicate_path() {
        let recorder = Recorder::new();
        let flags = SeedFlags {
            clean: true,
            yes: true,
            ..seed_flags(20)
        };
        let (code, capture) = seed(&flags, &Env::default(), &recorder);

        assert_eq!(code, OK);
        assert!(
            capture
                .stdout()
                .contains("delete from public.\"todos\" where title like '[kizunasync-mock]%'")
        );
        assert!(!capture.stdout().contains("insert into"));
        assert!(capture.stderr().contains("cleaned seeded rows."));
    }

    #[test]
    fn a_refused_clean_deletes_nothing() {
        let recorder = Recorder::new();
        let flags = SeedFlags {
            clean: true,
            ..seed_flags(20)
        };
        let (code, capture) = seed(&flags, &Env::default(), &recorder);

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("this deletes seeded rows"));
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn a_dry_run_churn_prints_one_statement_per_iteration_and_applies_nothing() {
        let recorder = Recorder::new();
        let flags = ChurnFlags {
            dry_run: true,
            ..churn_flags(3)
        };
        let (code, capture) = churn(&flags, &Env::default(), &recorder);

        assert_eq!(code, OK);
        assert_eq!(capture.stdout().lines().count(), 3);
        assert!(
            capture
                .stderr()
                .contains("seed=1  iterations=3  interval=0ms  target: public.todos")
        );
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn zero_iterations_applies_nothing() {
        let recorder = Recorder::new();
        let flags = ChurnFlags {
            yes: true,
            ..churn_flags(0)
        };
        let (code, capture) = churn(&flags, &Env::default(), &recorder);

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("0 iterations requested"));
    }

    #[test]
    fn every_statement_runs_in_order_and_pacing_skips_the_last_one() {
        let recorder = Recorder::new();
        let flags = ChurnFlags {
            yes: true,
            interval_ms: 5,
            ..churn_flags(3)
        };
        let (code, capture) = churn(&flags, &Env::default(), &recorder);

        assert_eq!(code, OK);
        assert_eq!(recorder.applied.borrow().len(), 3);
        assert_eq!(recorder.slept.borrow().len(), 2);
        assert_eq!(recorder.slept.borrow()[0], Duration::from_millis(5));
        assert!(capture.stderr().contains("applied 3 churn write(s)."));
    }

    #[test]
    fn a_failing_step_stops_the_run_and_names_the_step() {
        let recorder = Recorder::failing_at(2);
        let flags = ChurnFlags {
            yes: true,
            ..churn_flags(4)
        };
        let (code, capture) = churn(&flags, &Env::default(), &recorder);

        assert_eq!(code, FAILURE);
        assert_eq!(recorder.applied.borrow().len(), 2);
        assert!(capture.stderr().contains("churn failed at step 2/4"));
    }

    #[test]
    fn a_refused_churn_writes_nothing() {
        let recorder = Recorder::new();
        let (code, capture) = churn(&churn_flags(3), &Env::default(), &recorder);

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("this writes to your DB"));
        assert!(recorder.applied.borrow().is_empty());
    }
}
