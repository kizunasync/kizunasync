use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicI64, Ordering};

use crate::applier::fake::{FakeApplier, text_row};
use crate::catalog::{PgSchemaSource, SchemaSource};
use crate::commands::history_gate::fake::KIZUNASYNC_WROTE;
use crate::commands::{FAILURE, OK, UNUSABLE};
use crate::config::ProjectSettings;
use crate::constants::SCHEMA;
use crate::discovery::ConnectionCandidate;
use crate::env::Env;
use crate::management::{HttpResponse, HttpTransport, ManagementApi, ProjectSummary};
use crate::migration_history::AppliedMigration;
use crate::migration_history::fake::recorded;
use crate::pack::{self, PackFile};
use crate::project_ref::ProjectRef;
use crate::prompts::{
    Answer, Ask, Entry, Prompter, ScriptedPrompter, SectionChoice, ServerSection, WizardMode,
};
use crate::proposals::TableProposal;
use crate::proposals::{ConflictMode, PolicyRow, SchemaCatalog, SyncMode};
use crate::provision::hash_pack_file;
use crate::server_facts::ServerFacts;
use crate::supabase_cli::fake::{NoopCli, RecordingCli, UnreachableCli};
use crate::supabase_cli::{CliResult, PushTarget, SupabaseCli};
use crate::token::TokenStore;
use crate::ui::Ui;

use super::*;

static TEST_NOW: AtomicI64 = AtomicI64::new(1_700_000_000);

fn fixed_now() -> i64 {
    TEST_NOW.load(Ordering::Relaxed)
}

/// What every fake connection test answers.
fn test_facts() -> ServerFacts {
    ServerFacts {
        version: "17.4".to_owned(),
        database: "postgres".to_owned(),
        user: "postgres".to_owned(),
    }
}

/// The Management API connection test, answered without a socket.
#[expect(clippy::unnecessary_wraps)] // Matches the fallible port signature.
fn remote_facts_ok(_project_ref: &ProjectRef, _token: &str) -> crate::error::Result<ServerFacts> {
    Ok(test_facts())
}

/// A ref the tests know to be valid, checked the way the CLI checks one.
fn valid_ref(value: &str) -> ProjectRef {
    ProjectRef::parse(value).unwrap()
}

fn no_browser() -> crate::error::Result<()> {
    Err(crate::error::Error::Cli("no browser in tests".to_owned()))
}

/// The account rung, for every test that must never reach it. Failing loudly
/// beats an empty list: a test that lists projects has to say so.
fn unreachable_projects(_token: &str) -> crate::error::Result<Vec<ProjectSummary>> {
    Err(crate::error::Error::Transport(
        "unreachable, no test lists projects over the network".to_owned(),
    ))
}

/// The pack this checkout ships, addressed from the crate's own manifest.
///
/// Production resolution (KSYNC_PACK_DIR, then a walk up from the working
/// directory, then one from the executable) is unchanged and untested here
/// on purpose: `pack.rs` owns it. What a test must not do is depend on it,
/// because a `build-dir` outside the repository moves the executable out of
/// reach and every guarded test would then skip itself into a pass.
fn test_pack_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/supabase-pack")
}

/// The environment a test run carries: the pack override and nothing else,
/// so every other rung stays as empty as [`Env::default`].
fn test_env() -> Env {
    Env::from_pairs(&[("KSYNC_PACK_DIR", test_pack_dir().to_string_lossy().as_ref())])
}

fn run_in(
    dir: &Path,
    argv: &InitFlags,
    prompter: Option<ScriptedPrompter>,
) -> (i32, crate::ui::Capture) {
    run_with_schemas(dir, argv, prompter, &PgSchemaSource)
}

/// Like [`run_in`], but with an injectable [`SchemaSource`]: the wizard
/// path reads through it, so a test that drives the wizard needs a fake
/// rather than the real `PgSchemaSource` the plain helper hardcodes.
fn run_with_schemas(
    dir: &Path,
    argv: &InitFlags,
    prompter: Option<ScriptedPrompter>,
    schemas: &dyn SchemaSource,
) -> (i32, crate::ui::Capture) {
    let mut boxed = prompter;

    run_with_cli(dir, argv, boxed.as_mut(), schemas, &NoopCli)
}

/// Like [`run_with_schemas`], with the Supabase CLI injected too, and the
/// prompter lent so the test can read back what it was asked.
fn run_with_cli(
    dir: &Path,
    argv: &InitFlags,
    prompter: Option<&mut ScriptedPrompter>,
    schemas: &dyn SchemaSource,
    supabase: &dyn SupabaseCli,
) -> (i32, crate::ui::Capture) {
    run_with_cli_at(dir, argv, prompter, schemas, supabase, fixed_now())
}

/// Like [`run_with_cli`], with the migrations named after `now_unix`.
fn run_with_cli_at(
    dir: &Path,
    argv: &InitFlags,
    prompter: Option<&mut ScriptedPrompter>,
    schemas: &dyn SchemaSource,
    supabase: &dyn SupabaseCli,
    now_unix: i64,
) -> (i32, crate::ui::Capture) {
    let (mut ui, capture) = Ui::capture();
    let prompter_ref: Option<&mut dyn Prompter> =
        prompter.map(|prompter| prompter as &mut dyn Prompter);
    let mut ports = InitPorts {
        prompter: prompter_ref,
        schemas,
        supabase,
        now_unix,
        tokens: &crate::token::NoTokenStore,
        list_projects: &unreachable_projects,
        browser_login: &no_browser,
        probe_remote: &remote_facts_ok,
    };
    let code = run(
        argv,
        &RunContext {
            cwd: dir,
            paths: &ProjectPaths::rooted_at(dir.to_path_buf()),
            env: &test_env(),
            env_files: &crate::env_file::load(dir),
        },
        &mut ports,
        &mut ui,
    );

    (code, capture)
}

/// The flags every test starts from and overrides with struct-update syntax.
fn base_flags() -> InitFlags {
    InitFlags {
        dry_run: false,
        yes: false,
        local_only: false,
        schema: "public".to_owned(),
        project_ref: None,
        db_url: None,
        access_token: None,
        options: crate::commands::sync::TableOptions::default(),
        settings: crate::commands::sync::SettingsOptions::default(),
        allow_no_cron: false,
        allow_no_rls: false,
    }
}

#[test]
fn dry_run_local_only_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, _) = run_in(
        dir.path(),
        &InitFlags {
            dry_run: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn local_only_without_yes_refuses() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("refusing to write without confirmation")
    );
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn yes_local_only_emits_the_pack_and_the_config_migration() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, _) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    let migrations = std::fs::read_dir(dir.path().join("supabase/migrations"))
        .unwrap()
        .filter_map(|entry| {
            entry
                .ok()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
        })
        .collect::<Vec<_>>();
    assert!(!migrations.is_empty());
    assert!(migrations.iter().all(|name| name.contains("_kizunasync_")));
}

/// The default: a non-interactive run that never named `--allow-no-cron`
/// gates the config migration it emits on `pg_cron`.
#[test]
fn a_non_interactive_run_gates_the_config_migration_on_pg_cron_by_default() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, _) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert!(config_migration_sql(dir.path()).contains("pg_cron is not enabled"));
}

/// `--allow-no-cron` emits the config migration without the gate: the run
/// asked to install without scheduled retention.
#[test]
fn allow_no_cron_emits_the_config_migration_without_the_gate() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, _) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            allow_no_cron: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert!(!config_migration_sql(dir.path()).contains("pg_cron is not enabled"));
}

#[test]
fn project_ref_and_local_only_are_mutually_exclusive() {
    let dir = tempfile::tempdir().unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            local_only: true,
            project_ref: Some(valid_ref("abcd")),
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("mutually exclusive"));
}

/// One committed config-migration surface, byte for byte. A deliberate change
/// to the emitted SQL is a one-word fix: rerun with `KSYNC_BLESS_GOLDEN=1`.
fn assert_golden_sql(actual: &str, golden_name: &str) {
    let golden = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(golden_name);
    if std::env::var("KSYNC_BLESS_GOLDEN").is_ok_and(|value| value == "1") {
        std::fs::write(&golden, actual).unwrap();

        return;
    }
    let expected = std::fs::read_to_string(&golden).unwrap();

    assert_eq!(
        actual, expected,
        "the emitted SQL drifted from tests/golden/{golden_name}: rerun with KSYNC_BLESS_GOLDEN=1 if that was intended"
    );
}

// MARK: - the pg_cron gate

fn pg_cron(present: bool) -> FakeApplier {
    FakeApplier::new().answer(
        "pg_extension",
        vec![text_row(&[("present", if present { "t" } else { "f" })])],
    )
}

#[test]
fn pg_cron_present_is_reported_and_the_run_continues() {
    let (mut ui, capture) = Ui::capture();

    assert_eq!(verify_pg_cron(&pg_cron(true), false, &mut ui), OK);
    assert!(capture.stderr().contains("pg_cron:          enabled"));
}

/// The exact sentence, because it is what tells a user where the switch is.
#[test]
fn pg_cron_absent_fails_the_install_and_names_the_dashboard_page() {
    let (mut ui, capture) = Ui::capture();

    assert_eq!(verify_pg_cron(&pg_cron(false), false, &mut ui), FAILURE);
    assert!(
        capture.stderr().contains(
            "pg_cron is not enabled: enable it under Integrations > Cron in the Supabase dashboard, then rerun; pass --allow-no-cron to install without scheduled retention"
        ),
        "{}",
        capture.stderr()
    );
}

#[test]
fn allow_no_cron_installs_and_names_the_three_functions_to_run_by_hand() {
    let (mut ui, capture) = Ui::capture();

    assert_eq!(verify_pg_cron(&pg_cron(false), true, &mut ui), OK);
    let printed = capture.stderr();
    assert!(printed.contains("select kizunasync.reap_tombstones();"));
    assert!(printed.contains("select kizunasync.compact_changelog();"));
    assert!(printed.contains("select kizunasync.prune_clients();"));
    assert!(printed.contains("kizunasync jobs run all"));
}

/// A check that cannot run is a failure, not a silent pass: "no pg_cron" and
/// "we could not ask" must not look alike.
#[test]
fn a_pg_cron_check_that_cannot_run_stops_the_install_unless_it_was_waived() {
    let unreadable = || FakeApplier::new().fail("pg_extension", "permission denied");
    let (mut strict, strict_capture) = Ui::capture();
    let (mut waived, _) = Ui::capture();

    assert_eq!(verify_pg_cron(&unreadable(), false, &mut strict), FAILURE);
    assert!(
        strict_capture
            .stderr()
            .contains("could not check whether pg_cron is enabled")
    );
    assert_eq!(verify_pg_cron(&unreadable(), true, &mut waived), OK);
}

// MARK: - wizard fakes

/// A [`SchemaSource`] fake for wizard tests: scripted answers, no network.
/// `probe_errors` makes [`SchemaSource::probe`] fail instead of the catalog
/// read, since a failed probe must abort before that is ever called: one
/// entry per probe, in order, and every probe after the last one answers.
/// `history` is what each read of the migration history answers, in order,
/// the last answer repeating; `ledger` is what the provision ledger holds,
/// `pg_cron` is what the presence probe answers, and `applier` records what
/// the run sends over the connection itself.
struct FakeSchemaSource {
    probe_errors: RefCell<Vec<String>>,
    catalog: SchemaCatalog,
    history: RefCell<Vec<std::result::Result<Vec<AppliedMigration>, String>>>,
    ledger: Vec<crate::provision::LedgerRow>,
    pg_cron: bool,
    applier: FakeApplier,
}

impl FakeSchemaSource {
    fn ok(catalog: SchemaCatalog) -> Self {
        Self {
            probe_errors: RefCell::new(Vec::new()),
            catalog,
            history: RefCell::new(vec![Ok(Vec::new())]),
            ledger: Vec::new(),
            pg_cron: true,
            applier: FakeApplier::new(),
        }
    }

    fn failing_probe(message: &str) -> Self {
        Self::failing_probes(&[message], SchemaCatalog::default())
    }

    /// The first probes fail with `messages`, in order; every later one
    /// answers.
    fn failing_probes(messages: &[&str], catalog: SchemaCatalog) -> Self {
        Self {
            probe_errors: RefCell::new(
                messages
                    .iter()
                    .rev()
                    .map(|message| (*message).to_owned())
                    .collect(),
            ),
            catalog,
            history: RefCell::new(vec![Ok(Vec::new())]),
            ledger: Vec::new(),
            pg_cron: true,
            applier: FakeApplier::new(),
        }
    }

    /// The same database, without `pg_cron`.
    fn without_pg_cron(self) -> Self {
        Self {
            pg_cron: false,
            ..self
        }
    }

    /// The same database, whose provision ledger holds `ledger`.
    fn with_ledger(self, ledger: Vec<crate::provision::LedgerRow>) -> Self {
        Self { ledger, ..self }
    }

    /// The same database, its migration history recording `entries`, each
    /// written as [`recorded`] reads it.
    fn with_history(self, entries: &[&str]) -> Self {
        self.with_history_reads(&[Ok(entries)])
    }

    /// The same database, whose migration history answers `reads` in order,
    /// the last one repeating. An `Err` is a read that fails with that cause.
    fn with_history_reads(self, reads: &[std::result::Result<&[&str], &str>]) -> Self {
        let reads = reads
            .iter()
            .map(|read| match read {
                Ok(entries) => Ok(recorded(entries)),
                Err(cause) => Err((*cause).to_owned()),
            })
            .collect();

        Self {
            history: RefCell::new(reads),
            ..self
        }
    }
}

impl SchemaSource for FakeSchemaSource {
    fn probe(&self, _url: &str) -> crate::error::Result<ServerFacts> {
        self.probe_errors.borrow_mut().pop().map_or_else(
            || Ok(test_facts()),
            |message| Err(crate::error::Error::Db(message)),
        )
    }

    fn introspect(&self, _url: &str, _schema: &str) -> crate::error::Result<SchemaCatalog> {
        Ok(self.catalog.clone())
    }

    /// `init` provisions the synced set rather than reading it, so nothing on
    /// its path may ask for one.
    fn read_config(&self, _url: &str) -> crate::error::Result<crate::config::KizunaSyncConfig> {
        panic!("init tests: SchemaSource::read_config must not be reached on this path")
    }

    /// The gate a provisioned project passes, unless the fixture removed
    /// the extension: the absent message has its own tests against the
    /// applier.
    fn pg_cron_present(&self, _url: &str) -> crate::error::Result<bool> {
        Ok(self.pg_cron)
    }

    fn applied_migrations(&self, _url: &str) -> crate::error::Result<Vec<AppliedMigration>> {
        let mut history = self.history.borrow_mut();
        let read = if history.len() > 1 {
            history.remove(0)
        } else {
            history[0].clone()
        };

        read.map_err(crate::error::Error::Db)
    }

    fn ledger_rows(&self, _url: &str) -> crate::error::Result<Vec<crate::provision::LedgerRow>> {
        Ok(self.ledger.clone())
    }

    fn pack_applier(&self, _url: &str) -> Box<dyn crate::applier::Applier + '_> {
        Box::new(Lent(&self.applier))
    }
}

/// The fake's own applier, lent to the run so the test reads back what it
/// was sent.
struct Lent<'a>(&'a FakeApplier);

impl crate::applier::Applier for Lent<'_> {
    fn run_query(&self, sql: &str) -> crate::error::Result<Vec<crate::row::Row>> {
        self.0.run_query(sql)
    }
}

/// A ledger that records a stale md5 of the shipped pack's first file, written
/// by this build.
fn changed_pack_ledger() -> Vec<crate::provision::LedgerRow> {
    vec![crate::provision::LedgerRow {
        object_kind: "pack-file".to_owned(),
        object_name: init_pack_files()[0].name.clone(),
        content_hash: "a-stale-hash".to_owned(),
        pack_version: crate::VERSION.to_owned(),
    }]
}

/// The project-config migration this run emitted, the one that provisions
/// `kizunasync._config`, and the only record of what `init` decided.
fn config_migration_sql(root: &Path) -> String {
    let dir = root.join("supabase").join("migrations");
    let name = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| {
            entry
                .ok()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
        })
        .find(|name| name.ends_with("_kizunasync_config.sql"))
        .expect("the project-config migration");

    std::fs::read_to_string(dir.join(name)).unwrap()
}

/// `todos` carries an owner-inferring RLS policy, `notes` has none: the same
/// shape the wizard fixture uses.
fn wizard_catalog() -> SchemaCatalog {
    SchemaCatalog {
        tables: vec!["todos".to_owned(), "notes".to_owned()],
        policies: vec![PolicyRow {
            table: "todos".to_owned(),
            qual: "(auth.uid() = user_id)".to_owned(),
        }],
        ..Default::default()
    }
    .keyed_by_uuid_id()
}

// MARK: - wizard
//
// The wizard asks: connection string when unresolved, schema, tables,
// recommended vs customize, optional per-table settings, then one confirm.

#[test]
fn wizard_writes_the_derived_config_and_pack_then_applies_via_push() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_with_schemas(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );

    assert_eq!(code, OK);
    let config_sql = config_migration_sql(dir.path());
    assert!(
        config_sql
            .contains("  'todos', 'read-write', 'user_id', null, 'arrival', false, false, null, 1")
    );
    assert!(
        config_sql.contains("  'notes', 'pull-only', null, null, 'arrival', false, false, null, 1")
    );
    let migrations = std::fs::read_dir(dir.path().join("supabase/migrations"))
        .unwrap()
        .filter_map(|entry| {
            entry
                .ok()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
        })
        .collect::<Vec<_>>();
    assert!(
        migrations
            .iter()
            .any(|name| name.ends_with("_kizunasync_init.sql"))
    );
    assert!(capture.stderr().contains("applied via supabase db push"));
}

#[test]
fn wizard_customize_provisions_the_answered_hlc_conflict_mode() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let mut custom = TableProposal::derived("todos", Some("user_id"), "[auto]");
    custom.conflict = Some(crate::proposals::ConflictMode::Hlc);
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(custom),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(ProjectSettings::pack_defaults()),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(ProjectSettings::pack_defaults()),
        Answer::CronPolicy(false),
        Answer::Confirm(true),
    ]);
    let (code, _) = run_with_schemas(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );

    assert_eq!(code, OK);
    let config_sql = config_migration_sql(dir.path());
    assert!(
        config_sql
            .contains("  'todos', 'read-write', 'user_id', null, 'hlc', false, false, null, 1")
    );
}

/// The Recommended path, whole: two tables as the inference proposes them, and
/// no `_settings` statement at all, because nothing declared one.
#[test]
fn the_recommended_wizard_emits_the_committed_config_migration() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, _) = run_with_schemas(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );

    assert_eq!(code, OK);
    assert_golden_sql(&config_migration_sql(dir.path()), "config-recommended.sql");
}

/// The Customize path, whole: every per-table column answered, and every
/// project knob declared, which is what brings the scheduler call with it.
#[test]
fn the_customize_wizard_emits_the_committed_config_migration() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let todos = TableProposal {
        conflict: Some(crate::proposals::ConflictMode::Hlc),
        conflict_journal: true,
        register_clients: true,
        min_schema_version: Some(2),
        tombstone_ttl_days: Some(7),
        soft_delete: Some("deleted_at".to_owned()),
        ..TableProposal::derived("todos", Some("user_id"), "[auto]")
    };
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Mode(WizardMode::Customize),
        // The ladder walks the proposals in name order: notes, then todos.
        Answer::Customize(TableProposal::derived("notes", None, "[auto] no owner")),
        Answer::Customize(todos),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(ProjectSettings {
            reap_schedule: Some("0 4 * * *".to_owned()),
            ..ProjectSettings::pack_defaults()
        }),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(ProjectSettings {
            max_batch_size: Some(crate::config::MaxBatchSize::Mutations(100)),
            require_atomic: None,
            reap_schedule: Some("0 4 * * *".to_owned()),
            ..ProjectSettings::pack_defaults()
        }),
        Answer::CronPolicy(true),
        Answer::Confirm(true),
    ]);
    let (code, _) = run_with_schemas(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );

    assert_eq!(code, OK);
    assert_golden_sql(&config_migration_sql(dir.path()), "config-customize.sql");
}

/// The flag path's `--dry-run` payload: stdout carries the same SQL the
/// migration would have held, and every settings flag reaches it.
#[test]
fn a_dry_run_on_the_flag_path_prints_the_committed_config_sql() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            dry_run: true,
            local_only: true,
            settings: crate::commands::sync::SettingsOptions {
                max_batch_size: Some(100),
                reap_schedule: Some("0 4 * * *".to_owned()),
                compact_schedule: Some("30 4 * * *".to_owned()),
                client_prune_schedule: Some("45 4 * * *".to_owned()),
                client_ttl_days: Some(30),
                hlc_max_skew_ms: Some(2000),
                tombstone_ttl_days: Some(14),
                max_pull_scan: Some(2500),
                ..crate::commands::sync::SettingsOptions::default()
            },
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert_golden_sql(&capture.stdout(), "config-flags.sql");
}

#[test]
fn require_atomic_is_refused_on_init() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            dry_run: true,
            local_only: true,
            settings: crate::commands::sync::SettingsOptions {
                require_atomic: true,
                ..crate::commands::sync::SettingsOptions::default()
            },
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("Not supported in this release"));
}

#[test]
fn wizard_cancel_at_the_final_confirm_writes_nothing_and_exits_ok() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(false),
    ]);
    let (code, capture) = run_with_schemas(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );

    assert_eq!(code, OK);
    assert!(capture.stderr().contains("cancelled"));
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// a connection string entered at the wizard's prompt is masked in
/// every human-readable output and never lands in the written config.
#[test]
fn wizard_masks_an_entered_connection_string_and_never_writes_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let secret_url = "postgresql://postgres:s3cr3t@127.0.0.1:54322/postgres";
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let prompter = ScriptedPrompter::new(vec![
        // Nothing is discoverable here, so the picker offers the account and manual entry.
        Answer::Candidate(ConnectionCandidate::Manual),
        Answer::DbUrl(secret_url.to_owned()),
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_with_schemas(dir.path(), &base_flags(), Some(prompter), &schemas);

    assert_eq!(code, OK);
    assert!(!capture.stdout().contains("s3cr3t"));
    assert!(!capture.stderr().contains("s3cr3t"));
    assert!(capture.stderr().contains("postgres:***@127.0.0.1"));
    assert!(!config_migration_sql(dir.path()).contains("s3cr3t"));
}

#[test]
fn wizard_failed_probe_aborts_before_any_write() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let schemas = FakeSchemaSource::failing_probe("connection refused");
    let prompter = ScriptedPrompter::new(Vec::new());
    let (code, _) = run_with_schemas(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );

    assert_eq!(code, UNUSABLE);
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// Gate: `use_wizard` requires a prompter, so a run with none never enters it
/// and falls straight to the non-interactive path, which (in an empty
/// temp dir, with no `--db-url` / env / local config) refuses at connection
/// resolution before ever reaching the `--yes` check. `local_only_without_yes_refuses`
/// above already pins the "refuses without --yes" half of this gate on the
/// `--local-only` path; this test pins "no prompter means no wizard".
#[test]
fn a_non_interactive_run_never_enters_the_wizard_and_refuses_to_write() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, _) = run_in(dir.path(), &base_flags(), None);

    assert_eq!(code, UNUSABLE);
    assert!(!dir.path().join("supabase/migrations").exists());
}

// MARK: - the connection picker
//
// The wizard's first question is "which of the connections you already
// have", so these drive `choose_connection` directly: it is the seam where
// every branch is decided, and the two remote branches continue into a
// Management API call that a unit test must not make.

/// Structurally valid, and nothing like a real token.
const WIZARD_PAT: &str = "sbp_0123456789abcdef0123456789abcdef01234567";
const LINKED_REF: &str = "abcdefghijklmnopqrst";

struct FixedStore(Option<&'static str>);

impl FixedStore {
    fn holding(token: &'static str) -> Self {
        Self(Some(token))
    }

    fn empty() -> Self {
        Self(None)
    }
}

impl TokenStore for FixedStore {
    fn read(&self, _account: &str) -> Option<String> {
        self.0.map(ToOwned::to_owned)
    }
}

/// A store the fake `supabase login` can fill after the first empty read.
struct SharedStore(RefCell<Option<String>>);

impl TokenStore for SharedStore {
    fn read(&self, _account: &str) -> Option<String> {
        self.0.borrow().clone()
    }
}

/// Counts reads, so "the keychain was never touched" is an assertion rather
/// than a claim.
#[derive(Default)]
struct CountingStore(std::cell::Cell<usize>);

impl CountingStore {
    fn reads(&self) -> usize {
        self.0.get()
    }
}

impl TokenStore for CountingStore {
    fn read(&self, _account: &str) -> Option<String> {
        self.0.set(self.0.get() + 1);

        None
    }
}

struct ConnectionRun {
    outcome: Result<WizardConnection, i32>,
    capture: crate::ui::Capture,
    prompter: ScriptedPrompter,
}

fn write_linked_ref(dir: &Path, body: &str) {
    let temp = dir.join("supabase").join(".temp");
    std::fs::create_dir_all(&temp).unwrap();
    std::fs::write(temp.join("project-ref"), body).unwrap();
}

fn write_config_toml(dir: &Path, port: u16) {
    std::fs::create_dir_all(dir.join("supabase")).unwrap();
    std::fs::write(
        dir.join("supabase").join("config.toml"),
        format!("[db]\nport = {port}\n"),
    )
    .unwrap();
}

/// A port nothing listens on, so the local candidate is deterministically
/// unreachable instead of colliding with a developer's running stack.
fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    port
}

fn choose_connection_in(
    dir: &Path,
    flags: &InitFlags,
    env: &Env,
    prompter: ScriptedPrompter,
    tokens: &dyn TokenStore,
    list_projects: &dyn Fn(&str) -> crate::error::Result<Vec<ProjectSummary>>,
) -> ConnectionRun {
    choose_connection_with_login(
        dir,
        flags,
        env,
        prompter,
        tokens,
        list_projects,
        &no_browser,
    )
}

fn choose_connection_with_login(
    dir: &Path,
    flags: &InitFlags,
    env: &Env,
    prompter: ScriptedPrompter,
    tokens: &dyn TokenStore,
    list_projects: &dyn Fn(&str) -> crate::error::Result<Vec<ProjectSummary>>,
    browser_login: &dyn Fn() -> crate::error::Result<()>,
) -> ConnectionRun {
    let (mut ui, capture) = Ui::capture();
    let mut scripted = prompter;
    let outcome = {
        let prompter_ref: Option<&mut dyn Prompter> = Some(&mut scripted);
        let mut ports = InitPorts {
            prompter: prompter_ref,
            schemas: &FakeSchemaSource::ok(wizard_catalog()),
            supabase: &NoopCli,
            now_unix: fixed_now(),
            tokens,
            list_projects,
            browser_login,
            probe_remote: &remote_facts_ok,
        };

        choose_connection(
            flags,
            &ProjectPaths::rooted_at(dir.to_path_buf()),
            env,
            &crate::env_file::load(dir),
            &mut ports,
            &mut ui,
            &mut crate::commands::init::ConnectionAnswers::default(),
        )
    };

    ConnectionRun {
        outcome,
        capture,
        prompter: scripted,
    }
}

fn env_url(key: &'static str, file: &'static str, redacted: &str) -> ConnectionCandidate {
    ConnectionCandidate::EnvUrl {
        key,
        file,
        redacted_url: redacted.to_owned(),
    }
}

fn linked_candidate() -> ConnectionCandidate {
    ConnectionCandidate::LinkedProject {
        project_ref: valid_ref(LINKED_REF),
        origin: crate::discovery::ProjectRefOrigin::LinkFile,
    }
}

fn account_candidate() -> ConnectionCandidate {
    ConnectionCandidate::Account
}

/// A project carrying every discoverable connection at once.
fn everything_discoverable(dir: &Path) -> u16 {
    let port = closed_port();
    write_linked_ref(dir, LINKED_REF);
    write_config_toml(dir, port);
    std::fs::write(
        dir.join(".env"),
        "DATABASE_URL=postgresql://postgres:s3cr3t@db.example:5432/postgres\n",
    )
    .unwrap();

    port
}

#[test]
fn the_picker_offers_every_discovered_connection_in_priority_order_with_manual_last() {
    let dir = tempfile::tempdir().unwrap();
    let port = everything_discoverable(dir.path());
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![Answer::Candidate(ConnectionCandidate::Local {
            port,
            reachable: false,
        })]),
        &FixedStore::holding(WIZARD_PAT),
        &unreachable_projects,
    );
    assert_eq!(
        run.prompter.asked().first(),
        Some(&crate::prompts::Ask::Phase {
            title: crate::discovery::CONNECTION_PHASE.title.to_owned(),
            docs: crate::discovery::CONNECTION_PHASE.url.to_owned(),
        })
    );
    let Some(crate::prompts::Ask::Candidate { candidates, .. }) = run.prompter.asked().get(1)
    else {
        panic!("the connection picker was not asked");
    };

    assert_eq!(
        candidates
            .iter()
            .map(ConnectionCandidate::label)
            .collect::<Vec<_>>(),
        [
            format!("Linked project {LINKED_REF}"),
            "DATABASE_URL from .env".to_owned(),
            format!("Local Supabase stack (127.0.0.1:{port})"),
            "Choose a project from your Supabase account".to_owned(),
            "Enter a connection string".to_owned(),
        ]
    );
    assert!(!format!("{candidates:?}").contains("s3cr3t"));
}

#[test]
fn the_flag_still_decides_without_a_question() {
    let dir = tempfile::tempdir().unwrap();
    everything_discoverable(dir.path());
    let run = choose_connection_in(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://flag/db".to_owned()),
            ..base_flags()
        },
        &Env::default(),
        ScriptedPrompter::default(),
        &FixedStore::holding(WIZARD_PAT),
        &unreachable_projects,
    );

    assert!(matches!(
        run.outcome,
        Ok(WizardConnection::Direct(ref direct))
            if direct.url == "postgresql://flag/db"
                && direct.push == PushTarget::DbUrl("postgresql://flag/db".to_owned())
    ));
    assert!(run.prompter.asked().is_empty());
}

#[test]
fn the_process_environment_still_decides_without_a_question() {
    let dir = tempfile::tempdir().unwrap();
    everything_discoverable(dir.path());
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::from_pairs(&[("KSYNC_DB_URL", "postgresql://env/db")]),
        ScriptedPrompter::default(),
        &FixedStore::empty(),
        &unreachable_projects,
    );

    assert!(matches!(
        run.outcome,
        Ok(WizardConnection::Direct(ref direct))
            if direct.url == "postgresql://env/db"
                && direct.push == PushTarget::DbUrl("postgresql://env/db".to_owned())
    ));
    assert!(run.prompter.asked().is_empty());
}

#[test]
fn an_env_file_url_is_confirmed_then_used_unredacted_but_never_printed() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".env.local"),
        "KSYNC_DB_URL=postgresql://postgres:s3cr3t@db.example:5432/postgres\n",
    )
    .unwrap();
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(env_url(
                "KSYNC_DB_URL",
                ".env.local",
                "postgresql://postgres:***@db.example:5432/postgres",
            )),
            Answer::Confirm(true),
        ]),
        &FixedStore::empty(),
        &unreachable_projects,
    );

    assert!(matches!(
        run.outcome,
        Ok(WizardConnection::Direct(ref direct))
            if direct.url == "postgresql://postgres:s3cr3t@db.example:5432/postgres"
    ));
    assert!(!run.capture.stderr().contains("s3cr3t"));
    assert!(run.capture.stderr().contains("postgres:***@db.example"));
    assert!(matches!(
        run.prompter.asked().last(),
        Some(crate::prompts::Ask::Confirm { message, default: true })
            if message.contains("Use KSYNC_DB_URL from .env.local?")
    ));
}

#[test]
fn declining_the_env_file_url_writes_nothing_and_exits_clean() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".env"), "DATABASE_URL=postgres://x\n").unwrap();
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(env_url("DATABASE_URL", ".env", "postgres://x")),
            Answer::Confirm(false),
        ]),
        &FixedStore::empty(),
        &unreachable_projects,
    );

    assert!(matches!(run.outcome, Err(OK)));
    assert!(run.capture.stderr().contains("cancelled"));
}

#[test]
fn the_local_stack_resolves_to_the_same_url_the_ladder_would_have_built() {
    let dir = tempfile::tempdir().unwrap();
    let port = closed_port();
    write_config_toml(dir.path(), port);
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::default(),
        &FixedStore::empty(),
        &unreachable_projects,
    );

    // Local plus Manual is a real choice, but the script answers neither: the
    // single-candidate shortcut does not apply, so this asserts the picker
    // fails loudly rather than hanging.
    assert!(matches!(run.outcome, Err(UNUSABLE)));
    assert!(run.capture.stderr().contains("the wizard could not ask"));

    let chosen = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![Answer::Candidate(ConnectionCandidate::Local {
            port,
            reachable: false,
        })]),
        &FixedStore::empty(),
        &unreachable_projects,
    );

    assert!(matches!(
        chosen.outcome,
        Ok(WizardConnection::Direct(ref direct))
            if direct.url == crate::discovery::local_url(port) && direct.push == PushTarget::Local
    ));
}

#[test]
fn a_linked_project_is_confirmed_and_carries_the_discovered_token() {
    let dir = tempfile::tempdir().unwrap();
    write_linked_ref(dir.path(), LINKED_REF);
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(linked_candidate()),
            Answer::Confirm(true),
        ]),
        &FixedStore::holding(WIZARD_PAT),
        &unreachable_projects,
    );
    let Ok(WizardConnection::Remote {
        project_ref,
        credential,
    }) = run.outcome
    else {
        panic!("the linked project did not take the Management API path");
    };

    assert_eq!(project_ref.as_str(), LINKED_REF);
    assert_eq!(credential.token, WIZARD_PAT);
    assert_eq!(credential.origin, "OS credential store (profile supabase)");
    assert!(!run.capture.stderr().contains(WIZARD_PAT));
}

#[test]
fn declining_the_linked_project_writes_nothing_and_exits_clean() {
    let dir = tempfile::tempdir().unwrap();
    write_linked_ref(dir.path(), LINKED_REF);
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(linked_candidate()),
            Answer::Confirm(false),
        ]),
        &FixedStore::holding(WIZARD_PAT),
        &unreachable_projects,
    );

    assert!(matches!(run.outcome, Err(OK)));
    assert!(run.capture.stderr().contains("cancelled"));
}

#[test]
fn a_linked_project_without_a_stored_token_falls_through_to_a_masked_paste() {
    let dir = tempfile::tempdir().unwrap();
    write_linked_ref(dir.path(), LINKED_REF);
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(linked_candidate()),
            Answer::Confirm(true),
            Answer::AccessToken(format!("  {WIZARD_PAT}  ")),
        ]),
        &FixedStore::empty(),
        &unreachable_projects,
    );
    let Ok(WizardConnection::Remote { credential, .. }) = run.outcome else {
        panic!("the pasted token did not take the Management API path");
    };

    assert_eq!(credential.token, WIZARD_PAT);
    assert_eq!(credential.origin, "entered");
    assert!(
        run.prompter
            .asked()
            .contains(&crate::prompts::Ask::AccessToken)
    );
    assert!(!run.capture.stderr().contains(WIZARD_PAT));
    assert!(
        run.capture
            .stderr()
            .contains("Create a token on supabase.com")
    );
    assert!(run.capture.stderr().contains(crate::token::TOKENS_PAGE));
}

#[test]
fn a_missing_token_uses_what_supabase_login_stored_and_never_asks_to_paste() {
    let dir = tempfile::tempdir().unwrap();
    write_linked_ref(dir.path(), LINKED_REF);
    let store = SharedStore(RefCell::new(None));
    let login = || {
        store.0.replace(Some(WIZARD_PAT.to_owned()));
        Ok(())
    };
    let run = choose_connection_with_login(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(linked_candidate()),
            Answer::Confirm(true),
        ]),
        &store,
        &unreachable_projects,
        &login,
    );
    let Ok(WizardConnection::Remote { credential, .. }) = run.outcome else {
        panic!("the browser login did not take the Management API path");
    };

    assert_eq!(credential.token, WIZARD_PAT);
    assert_eq!(credential.origin, "OS credential store (profile supabase)");
    assert!(
        !run.prompter
            .asked()
            .contains(&crate::prompts::Ask::AccessToken)
    );
    assert!(!run.capture.stderr().contains(WIZARD_PAT));
}

#[test]
fn an_empty_pasted_token_aborts_instead_of_calling_the_api_with_nothing() {
    let dir = tempfile::tempdir().unwrap();
    write_linked_ref(dir.path(), LINKED_REF);
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(linked_candidate()),
            Answer::Confirm(true),
            Answer::AccessToken(String::new()),
        ]),
        &FixedStore::empty(),
        &unreachable_projects,
    );

    assert!(matches!(run.outcome, Err(UNUSABLE)));
    assert!(run.capture.stderr().contains("no access token provided"));
}

#[test]
fn a_service_role_shaped_paste_is_rejected_instead_of_sent_to_management() {
    let dir = tempfile::tempdir().unwrap();
    write_linked_ref(dir.path(), LINKED_REF);
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(linked_candidate()),
            Answer::Confirm(true),
            Answer::AccessToken(
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig"
                    .to_owned(),
            ),
        ]),
        &FixedStore::empty(),
        &unreachable_projects,
    );

    assert!(matches!(run.outcome, Err(UNUSABLE)));
    assert!(run.capture.stderr().contains("not a Personal Access Token"));
}

#[test]
fn the_account_candidate_lists_projects_with_the_discovered_token_and_binds_the_chosen_ref() {
    let dir = tempfile::tempdir().unwrap();
    let seen = RefCell::new(Vec::new());
    let list = |token: &str| {
        seen.borrow_mut().push(token.to_owned());

        Ok(vec![
            ProjectSummary {
                project_ref: "aaaaaaaaaaaaaaaaaaaa".to_owned(),
                name: "prod".to_owned(),
                region: "eu-central-1".to_owned(),
            },
            ProjectSummary {
                project_ref: LINKED_REF.to_owned(),
                name: "staging".to_owned(),
                region: "us-east-1".to_owned(),
            },
        ])
    };
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(account_candidate()),
            Answer::Project(LINKED_REF.to_owned()),
        ]),
        &FixedStore::holding(WIZARD_PAT),
        &list,
    );
    let Ok(WizardConnection::Remote {
        project_ref,
        credential,
    }) = run.outcome
    else {
        panic!("the account candidate did not take the Management API path");
    };

    assert_eq!(project_ref.as_str(), LINKED_REF);
    assert_eq!(credential.token, WIZARD_PAT);
    assert_eq!(seen.into_inner(), [WIZARD_PAT]);
}

/// The account picker is where a listed ref enters the CLI, so one that is
/// not a valid ref is refused there and no project is bound.
#[test]
fn a_listed_project_whose_ref_is_not_valid_is_refused_at_the_picker() {
    let dir = tempfile::tempdir().unwrap();
    let list = |_: &str| {
        Ok(vec![ProjectSummary {
            project_ref: "Evil.example".to_owned(),
            name: "prod".to_owned(),
            region: "eu-central-1".to_owned(),
        }])
    };
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(account_candidate()),
            Answer::Project("Evil.example".to_owned()),
        ]),
        &FixedStore::holding(WIZARD_PAT),
        &list,
    );

    assert!(matches!(run.outcome, Err(UNUSABLE)));
    assert!(
        run.capture
            .stderr()
            .contains("the account listed \"Evil.example\", which is not a Supabase project ref"),
        "{}",
        run.capture.stderr()
    );
}

/// `supabase/.temp/project-ref` is read before the picker opens: a value that
/// is not a ref is refused there, naming the file, and nothing is asked.
#[test]
fn a_link_file_that_holds_no_valid_ref_is_refused_before_the_picker_opens() {
    let dir = tempfile::tempdir().unwrap();
    write_linked_ref(dir.path(), "evil.example/x#\n");
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![Answer::Candidate(ConnectionCandidate::Manual)]),
        &FixedStore::holding(WIZARD_PAT),
        &unreachable_projects,
    );

    assert!(matches!(run.outcome, Err(UNUSABLE)));
    assert!(
        run.capture
            .stderr()
            .contains("supabase/.temp/project-ref holds \"evil.example/x#\", which is not a Supabase project ref"),
        "{}",
        run.capture.stderr()
    );
    assert_eq!(candidate_lists(&run.prompter), 0);
}

#[test]
fn a_failed_project_list_names_the_token_source_and_never_the_token() {
    let dir = tempfile::tempdir().unwrap();
    let list = |token: &str| {
        Err(crate::error::Error::Transport(format!(
            "the API rejected {token}"
        )))
    };
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![Answer::Candidate(account_candidate())]),
        &FixedStore::holding(WIZARD_PAT),
        &list,
    );

    assert!(matches!(run.outcome, Err(UNUSABLE)));
    assert!(!run.capture.stderr().contains(WIZARD_PAT));
    assert!(run.capture.stderr().contains("***"));
    assert!(
        run.capture
            .stderr()
            .contains("token from OS credential store (profile supabase)")
    );
}

#[test]
fn an_account_with_no_projects_says_so_instead_of_binding_an_empty_ref() {
    let dir = tempfile::tempdir().unwrap();
    let list = |_token: &str| Ok(Vec::new());
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![Answer::Candidate(account_candidate())]),
        &FixedStore::holding(WIZARD_PAT),
        &list,
    );

    assert!(matches!(run.outcome, Err(UNUSABLE)));
    assert!(run.capture.stderr().contains("reaches no projects"));
}

/// Nothing discoverable still offers the account, so the manual prompt is a
/// choice the user makes rather than the only thing left.
#[test]
fn a_project_with_nothing_discoverable_offers_the_account_and_manual_entry() {
    let dir = tempfile::tempdir().unwrap();
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(ConnectionCandidate::Manual),
            Answer::DbUrl("postgresql://typed/db".to_owned()),
        ]),
        &FixedStore::empty(),
        &unreachable_projects,
    );

    assert!(matches!(
        run.outcome,
        Ok(WizardConnection::Direct(ref direct))
            if direct.url == "postgresql://typed/db"
                && direct.push == PushTarget::DbUrl("postgresql://typed/db".to_owned())
    ));
    assert_eq!(
        run.prompter.asked(),
        [
            crate::prompts::Ask::Phase {
                title: crate::discovery::CONNECTION_PHASE.title.to_owned(),
                docs: crate::discovery::CONNECTION_PHASE.url.to_owned(),
            },
            crate::prompts::Ask::Candidate {
                candidates: vec![ConnectionCandidate::Account, ConnectionCandidate::Manual],
                current: None,
            },
            crate::prompts::Ask::DbUrl { current: None },
        ]
    );
    assert!(run.capture.stderr().contains("no --db-url"));
    assert!(
        run.capture
            .stderr()
            .contains("no --db-url / KSYNC_DB_URL / DIRECT_URL / POSTGRES_URL_NON_POOLING / DATABASE_URL / POSTGRES_URL / local config found.\n\n")
    );
}

/// The masked entry is shared with `sync`, the copy is not: this command
/// has no flag path that skips the database, so it must not offer one.
#[test]
fn an_empty_entry_aborts_with_this_commands_own_message() {
    let dir = tempfile::tempdir().unwrap();
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(ConnectionCandidate::Manual),
            Answer::DbUrl("   ".to_owned()),
        ]),
        &FixedStore::empty(),
        &unreachable_projects,
    );

    assert!(matches!(run.outcome, Err(UNUSABLE)));
    assert!(run.capture.stderr().contains(NO_CONNECTION_ENTERED.trim()));
    assert!(
        !run.capture.stderr().contains("--add/--remove"),
        "that hint belongs to kizunasync sync, which has a flag path this command does not"
    );
}

/// The credential store is not read while the picker is built: only inside
/// the branches that need a token.
#[test]
fn building_the_picker_never_reads_the_credential_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = CountingStore::default();
    let run = choose_connection_in(
        dir.path(),
        &base_flags(),
        &Env::default(),
        ScriptedPrompter::new(vec![
            Answer::Candidate(ConnectionCandidate::Manual),
            Answer::DbUrl("postgresql://typed/db".to_owned()),
        ]),
        &store,
        &unreachable_projects,
    );

    assert!(matches!(run.outcome, Ok(WizardConnection::Direct(_))));
    assert_eq!(store.reads(), 0);
}

/// The picker is not a private seam: this drives the whole wizard through
/// `run`, picking the `.env` candidate, and asserts the run it produced.
#[test]
fn the_wizard_end_to_end_takes_the_env_file_candidate_the_user_picked() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    std::fs::write(
        dir.path().join(".env"),
        "DATABASE_URL=postgresql://postgres:s3cr3t@db.example:5432/postgres\n",
    )
    .unwrap();
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let prompter = ScriptedPrompter::new(vec![
        Answer::Candidate(env_url(
            "DATABASE_URL",
            ".env",
            "postgresql://postgres:***@db.example:5432/postgres",
        )),
        Answer::Confirm(true),
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_with_schemas(dir.path(), &base_flags(), Some(prompter), &schemas);

    assert_eq!(code, OK);
    assert!(!config_migration_sql(dir.path()).is_empty());
    assert!(!capture.stdout().contains("s3cr3t"));
    assert!(!capture.stderr().contains("s3cr3t"));
    assert!(
        capture
            .stderr()
            .contains("postgres:***@db.example:5432/postgres (DATABASE_URL from .env)")
    );
}

// MARK: - supabase/config.toml [api].schemas: command-level gaps
//
// `api_schemas.rs` proves the patch primitive; these pin how `init` wires it
// in: dry-run vs `--yes`, the patch outcomes, and the absent-file case.

const CONFIG_TOML_NOT_EXPOSED: &str = "project_id = \"demo\"\n\n[api]\nenabled = true\nport = 54321\nschemas = [\"public\", \"graphql_public\"]\nmax_rows = 1000\n\n[db]\nport = 54322\n";

const CONFIG_TOML_MULTILINE: &str =
    "project_id = \"demo\"\n\n[api]\nschemas = [\n  \"public\",\n]\n";

const CONFIG_TOML_UNPARSEABLE: &str =
    "project_id = \"demo\"\n\n[api]\nschemas = [\n  \"public\",\n";

fn api_schemas_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    std::fs::create_dir_all(dir.path().join("supabase")).unwrap();

    dir
}

fn config_toml_path(dir: &Path) -> PathBuf {
    dir.join("supabase").join("config.toml")
}

#[test]
fn api_schemas_dry_run_plans_the_patch_and_writes_nothing() {
    let dir = api_schemas_dir();
    std::fs::write(config_toml_path(dir.path()), CONFIG_TOML_NOT_EXPOSED).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            dry_run: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert!(capture.stderr().contains("supabase/config.toml"));
    assert!(capture.stderr().contains("[api].schemas"));
    assert_eq!(
        std::fs::read_to_string(config_toml_path(dir.path())).unwrap(),
        CONFIG_TOML_NOT_EXPOSED
    );
}

#[test]
fn api_schemas_yes_patches_the_array_leaving_every_other_line_byte_identical() {
    let dir = api_schemas_dir();
    std::fs::write(config_toml_path(dir.path()), CONFIG_TOML_NOT_EXPOSED).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    let patched = std::fs::read_to_string(config_toml_path(dir.path())).unwrap();
    assert!(patched.contains(r#"schemas = ["public", "graphql_public", "kizunasync"]"#));
    assert!(capture.stderr().contains("patched supabase/config.toml"));
    let before: Vec<&str> = CONFIG_TOML_NOT_EXPOSED.split('\n').collect();
    let changed: Vec<&str> = patched
        .split('\n')
        .enumerate()
        .filter(|(index, line)| before.get(*index) != Some(line))
        .map(|(_, line)| line)
        .collect();
    assert_eq!(
        changed,
        [r#"schemas = ["public", "graphql_public", "kizunasync"]"#]
    );
}

#[test]
fn api_schemas_yes_adds_the_key_when_api_has_no_schemas() {
    let dir = api_schemas_dir();
    std::fs::write(config_toml_path(dir.path()), "[api]\nport = 54321\n").unwrap();
    let (code, _) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert_eq!(
        std::fs::read_to_string(config_toml_path(dir.path())).unwrap(),
        "[api]\nschemas = [\"public\", \"graphql_public\", \"kizunasync\"]\nport = 54321\n"
    );
}

#[test]
fn api_schemas_yes_appends_an_api_section_when_the_file_has_none() {
    let dir = api_schemas_dir();
    std::fs::write(config_toml_path(dir.path()), "project_id = \"demo\"\n").unwrap();
    let (code, _) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert!(
        std::fs::read_to_string(config_toml_path(dir.path()))
            .unwrap()
            .contains("[api]\nschemas = [\"public\", \"graphql_public\", \"kizunasync\"]")
    );
}

#[test]
fn api_schemas_yes_is_a_no_op_when_kizunasync_is_already_exposed() {
    let dir = api_schemas_dir();
    let exposed = CONFIG_TOML_NOT_EXPOSED.replace(
        r#"schemas = ["public", "graphql_public"]"#,
        r#"schemas = ["public", "graphql_public", "kizunasync"]"#,
    );
    std::fs::write(config_toml_path(dir.path()), &exposed).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert_eq!(
        std::fs::read_to_string(config_toml_path(dir.path())).unwrap(),
        exposed
    );
    assert!(capture.stderr().contains("already exposes kizunasync"));
}

#[test]
fn api_schemas_yes_patches_a_multiline_array_in_place() {
    let dir = api_schemas_dir();
    std::fs::write(config_toml_path(dir.path()), CONFIG_TOML_MULTILINE).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert_eq!(
        std::fs::read_to_string(config_toml_path(dir.path())).unwrap(),
        "project_id = \"demo\"\n\n[api]\nschemas = [\n  \"public\",\n  \"kizunasync\",\n]\n"
    );
    assert!(capture.stderr().contains("patched supabase/config.toml"));
}

#[test]
fn api_schemas_an_unparseable_config_toml_is_left_alone_naming_the_parse_error() {
    let dir = api_schemas_dir();
    std::fs::write(config_toml_path(dir.path()), CONFIG_TOML_UNPARSEABLE).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert_eq!(
        std::fs::read_to_string(config_toml_path(dir.path())).unwrap(),
        CONFIG_TOML_UNPARSEABLE
    );
    assert!(capture.stderr().contains("does not parse (line "));
    assert!(capture.stderr().contains("supabase config push"));
}

#[test]
fn api_schemas_an_absent_config_toml_is_not_created_and_prints_the_exact_line() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert!(!config_toml_path(dir.path()).exists());
    assert!(capture.stderr().contains("supabase init"));
    assert!(
        capture
            .stderr()
            .contains(r#"schemas = ["public", "graphql_public", "kizunasync"]"#)
    );
    assert!(capture.stderr().contains("supabase config push"));
}

// MARK: - the project-config migration
//
// What `init` decided is recorded in exactly one place: the migration that
// upserts `kizunasync._config` and `kizunasync._settings`. These pin what it
// carries, and that a re-run does not stack a second copy of it.

fn config_migration_names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir.join("supabase/migrations"))
        .unwrap()
        .filter_map(|entry| {
            entry
                .ok()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
        })
        .filter(|name| name.ends_with("_kizunasync_config.sql"))
        .collect()
}

/// A wizard run that accepts both proposed tables, with `notes` answered a
/// soft-delete column so the migration carries more than the inference.
fn provision_two_tables(dir: &Path) -> i32 {
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let notes = TableProposal {
        soft_delete: Some("deleted_at".to_owned()),
        ..TableProposal::derived("notes", None, "[auto] no RLS policies found")
    };
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Mode(WizardMode::Customize),
        // The ladder walks the proposals in name order: notes, then todos.
        Answer::Customize(notes),
        Answer::Customize(TableProposal::derived(
            "todos",
            Some("user_id"),
            "[auto] RLS policy keys on user_id",
        )),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(ProjectSettings::pack_defaults()),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(ProjectSettings::pack_defaults()),
        Answer::CronPolicy(false),
        Answer::Confirm(true),
    ]);
    let (code, _) = run_with_schemas(
        dir,
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );

    code
}

#[test]
fn the_config_migration_provisions_every_table_the_run_decided() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();

    assert_eq!(provision_two_tables(dir.path()), OK);
    let names = config_migration_names(dir.path());
    assert_eq!(names.len(), 1);
    let sql = config_migration_sql(dir.path());
    assert!(
        sql.contains("'todos', 'read-write', 'user_id', null, 'arrival', false, false, null, 1")
    );
    assert!(
        sql.contains("'notes', 'pull-only', null, 'deleted_at', 'arrival', false, false, null, 1")
    );
    assert!(sql.contains("create trigger kizunasync_track_change"));
    assert!(sql.contains("on public.\"todos\""));
    assert!(sql.contains("on public.\"notes\""));
    // Customize answered every server knob, so every one of them is written.
    assert!(sql.contains("  max_batch_size = 500,"));
    assert!(sql.contains("  tombstone_ttl_days = 30,"));
    assert!(sql.contains("  max_pull_scan = 5000"));
}

/// `init` provisions the policy the flags named; the wizard's own answer wins
/// over the flags that pre-filled it, the same precedence the table flags keep.
#[test]
fn the_push_policy_flags_reach_the_settings_update() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, _) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            settings: crate::commands::sync::SettingsOptions {
                max_batch_size: Some(25),
                ..crate::commands::sync::SettingsOptions::default()
            },
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    let sql = config_migration_sql(dir.path());
    assert!(sql.contains("update kizunasync._settings set"));
    assert!(sql.contains("  max_batch_size = 25"));
    assert!(!sql.contains("require_atomic"));
    // Nothing else was named, so nothing else is written.
    assert!(!sql.contains("reap_schedule"));
    assert!(!sql.contains("_schedule_jobs"));
}

/// Every schedule flag is judged by the pack's own grammar before a file is
/// written, and the refusal carries the field and the link that reads it back.
#[test]
fn a_schedule_flag_the_pack_would_refuse_is_refused_here_first() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            settings: crate::commands::sync::SettingsOptions {
                compact_schedule: Some("@daily".to_owned()),
                ..crate::commands::sync::SettingsOptions::default()
            },
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("--compact-schedule \"@daily\" is not a five-field UTC crontab"),
        "{}",
        capture.stderr()
    );
    assert!(
        capture.stderr().contains("https://crontab.guru/#@daily"),
        "{}",
        capture.stderr()
    );
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// The per-table flags `init` carries reach every table it provisions.
#[test]
fn the_client_registry_and_schema_version_flags_reach_every_provisioned_table() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, _) = run_with_schemas(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            options: crate::commands::sync::TableOptions {
                register_clients: Some(true),
                min_schema_version: Some(4),
                ..crate::commands::sync::TableOptions::default()
            },
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );

    assert_eq!(code, OK);
    assert!(
        config_migration_sql(dir.path())
            .contains("  'todos', 'read-write', 'user_id', null, 'arrival', false, true, null, 4")
    );
}

/// The five flags `sync` already had reach `init` too, so the per-table
/// columns a scripted install declares are the ones Customize walks.
#[test]
fn every_per_table_flag_reaches_every_provisioned_table() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, _) = run_with_schemas(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            options: crate::commands::sync::TableOptions {
                sync: Some(SyncMode::PullOnly),
                bucket_column: Some("workspace_id".to_owned()),
                soft_delete: Some("deleted_at".to_owned()),
                conflict: Some(ConflictMode::Hlc),
                conflict_journal: true,
                ..crate::commands::sync::TableOptions::default()
            },
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );
    let sql = config_migration_sql(dir.path());

    assert_eq!(code, OK);
    assert!(
        sql.contains(
            "  'todos', 'pull-only', 'workspace_id', 'deleted_at', 'hlc', true, false, null, 1"
        ),
        "{sql}"
    );
}

#[test]
fn an_init_batch_size_below_one_is_refused_before_anything_is_written() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            settings: crate::commands::sync::SettingsOptions {
                max_batch_size: Some(0),
                ..crate::commands::sync::SettingsOptions::default()
            },
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture.stderr().contains(
            "--max-batch-size 0 is out of range: at least 1 mutation per push. Use --no-max-batch-size for unlimited."
        ),
        "{}",
        capture.stderr()
    );
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// The pack addresses `public.<table>` everywhere, so no other schema can be
/// provisioned and the flag says so before anything is read or written.
#[test]
fn a_schema_the_pack_does_not_support_is_refused_before_any_read() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            schema: "billing".to_owned(),
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("--schema billing is not supported"),
        "{}",
        capture.stderr()
    );
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// Unlimited is a value, so an install can declare it. Omitting both halves
/// declares nothing at all.
#[test]
fn no_max_batch_size_declares_unlimited_and_omitting_both_declares_nothing() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, _) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            settings: crate::commands::sync::SettingsOptions {
                no_max_batch_size: true,
                ..crate::commands::sync::SettingsOptions::default()
            },
            ..base_flags()
        },
        None,
    );
    let sql = config_migration_sql(dir.path());

    assert_eq!(code, OK);
    assert!(sql.contains("  max_batch_size = null"), "{sql}");
    assert!(!sql.contains("require_atomic"), "{sql}");
}

/// A run that declares nothing emits no `_settings` statement at all, so the
/// row keeps whatever the project carries.
#[test]
fn an_init_that_names_no_settings_flag_writes_no_settings_statement() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let (code, _) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK);
    assert!(
        !config_migration_sql(dir.path()).contains("update kizunasync._settings"),
        "a run that declared nothing must leave the row alone"
    );
}

#[test]
fn the_wizards_push_policy_answer_is_what_gets_provisioned() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let schemas = FakeSchemaSource::ok(wizard_catalog());
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(TableProposal::derived("todos", Some("user_id"), "[auto]")),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(ProjectSettings::pack_defaults()),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(ProjectSettings {
            max_batch_size: Some(crate::config::MaxBatchSize::Mutations(5)),
            require_atomic: Some(false),
            ..ProjectSettings::pack_defaults()
        }),
        Answer::CronPolicy(false),
        Answer::Confirm(true),
    ]);
    let (code, _) = run_with_schemas(
        dir.path(),
        &InitFlags {
            db_url: Some("postgresql://wizard/db".to_owned()),
            settings: crate::commands::sync::SettingsOptions {
                max_batch_size: Some(99),
                ..crate::commands::sync::SettingsOptions::default()
            },
            ..base_flags()
        },
        Some(prompter),
        &schemas,
    );

    assert_eq!(code, OK);
    let sql = config_migration_sql(dir.path());
    assert!(sql.contains("  max_batch_size = 5,"));
    assert!(sql.contains("  require_atomic = false,"));
    // Customize answered every schedule, so the scheduler is called too.
    assert!(sql.contains("  reap_schedule = '16 3 * * *',"));
    assert!(
        sql.trim_end()
            .ends_with("select kizunasync._schedule_jobs();")
    );
}

#[test]
fn re_running_does_not_stack_a_second_config_migration() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();

    assert_eq!(provision_two_tables(dir.path()), OK);
    assert_eq!(config_migration_names(dir.path()).len(), 1);
    assert_eq!(provision_two_tables(dir.path()), OK);
    assert_eq!(config_migration_names(dir.path()).len(), 1);
}

// MARK: - --project-ref ledger matrix
//
// `run_remote` always builds the real `ReqwestTransport`, so it is not
// reachable with a fake here. These drive the private `provision_remotely`
// directly with `ManagementApi<FakeManagementTransport>`: everything past
// token resolution and pack loading, which `run_remote` does before ever
// building a transport (and which the mutual-exclusion and missing-token
// cases below exercise through the real `run()`).

const PROJECT_REF: &str = "abcdefghijklmnopqrst";
const PAT: &str = "sbp_test_never_print_me";

/// A [`HttpTransport`] fake answering the Management API's two endpoints
/// from scripted state. `Rc<RefCell<_>>`-backed so a clone taken before the
/// transport is moved into `ManagementApi::new` still reads its call log.
/// `pg_cron` is what the presence probe answers, and `applied` keeps the SQL
/// of every script that installs the pack. `pack_version` is the build every
/// ledger row names; `schedules_fail` and `install_fails` answer those calls
/// with a server error, and `reapply` is what a re-apply script meets.
#[derive(Clone)]
struct FakeManagementTransport {
    exposed: Rc<RefCell<Vec<String>>>,
    ledger_rows: Rc<RefCell<Vec<(String, String, String)>>>,
    core_rpcs: Rc<Vec<&'static str>>,
    calls: Rc<RefCell<Vec<String>>>,
    pg_cron: bool,
    applied: Rc<RefCell<Vec<String>>>,
    pack_version: &'static str,
    schedules_fail: bool,
    install_fails: bool,
    policies: &'static str,
    rls_disabled: &'static str,
    primary_keys: &'static str,
    reapply: ReapplyAnswer,
}

/// What the fake Management API does with a re-apply script.
#[derive(Clone, Copy)]
enum ReapplyAnswer {
    /// It runs and records every file's hash.
    Records,
    /// It runs and leaves the ledger as it was.
    LeavesTheLedger,
    /// The database refuses it over a column the installed `_settings` lacks,
    /// answering HTTP 400 with the body the query endpoint sends.
    RefusedOverAMissingColumn,
}

/// What the query endpoint answered, with HTTP 400, when the database refused
/// a statement over `_settings.max_pull_scan`.
const MISSING_COLUMN_BODY: &str = r#"{"message":"Failed to run sql query: ERROR:  42703: column \"max_pull_scan\" does not exist\nLINE 1: select max_batch_size, require_atomic, reap_schedule, compact_schedule, client_prune_schedule, client_ttl_days, hlc_max_skew_ms, tombstone_ttl_days, max_pull_scan from kizunasync._settings;\n"}"#;

impl FakeManagementTransport {
    fn new() -> Self {
        Self {
            exposed: Rc::new(RefCell::new(vec![
                "public".to_owned(),
                "graphql_public".to_owned(),
            ])),
            ledger_rows: Rc::new(RefCell::new(Vec::new())),
            core_rpcs: Rc::new(vec!["pull", "push"]),
            calls: Rc::new(RefCell::new(Vec::new())),
            pg_cron: true,
            applied: Rc::new(RefCell::new(Vec::new())),
            pack_version: crate::VERSION,
            schedules_fail: false,
            install_fails: false,
            policies: "[]",
            rls_disabled: "[]",
            primary_keys: r#"[{"table_name":"todos","constraint_name":"todos_pkey","column_name":"id","data_type":"uuid"}]"#,
            reapply: ReapplyAnswer::Records,
        }
    }

    fn answering_a_reapply(self, reapply: ReapplyAnswer) -> Self {
        Self { reapply, ..self }
    }

    /// The same project, where `todos` carries an owner-keyed policy and its
    /// row level security is disabled.
    fn with_todos_rls_disabled(self) -> Self {
        Self {
            policies: r#"[{"tablename":"todos","qual":"(auth.uid() = user_id)"}]"#,
            rls_disabled: r#"[{"table_name":"todos"}]"#,
            ..self
        }
    }

    /// The same project, where `todos` carries an owner-keyed policy and the
    /// primary key `primary_keys` reads.
    fn with_todos_keyed_by(self, primary_keys: &'static str) -> Self {
        Self {
            policies: r#"[{"tablename":"todos","qual":"(auth.uid() = user_id)"}]"#,
            primary_keys,
            ..self
        }
    }

    fn with_pack_version(self, pack_version: &'static str) -> Self {
        Self {
            pack_version,
            ..self
        }
    }

    fn with_failing_schedules(self) -> Self {
        Self {
            schedules_fail: true,
            ..self
        }
    }

    fn with_failing_install(self) -> Self {
        Self {
            install_fails: true,
            ..self
        }
    }

    fn without_pg_cron(self) -> Self {
        Self {
            pg_cron: false,
            ..self
        }
    }

    fn applied(&self) -> Vec<String> {
        self.applied.borrow().clone()
    }

    fn with_exposed(mut self, schemas: &[&str]) -> Self {
        self.exposed = Rc::new(RefCell::new(
            schemas.iter().map(|schema| (*schema).to_owned()).collect(),
        ));
        self
    }

    fn with_ledger_rows(mut self, rows: &[(&str, &str, &str)]) -> Self {
        self.ledger_rows = Rc::new(RefCell::new(
            rows.iter()
                .map(|(kind, name, hash)| {
                    ((*kind).to_owned(), (*name).to_owned(), (*hash).to_owned())
                })
                .collect(),
        ));
        self
    }

    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }

    fn exposed_schemas(&self) -> Vec<String> {
        self.exposed.borrow().clone()
    }

    fn handle_postgrest(&self, method: &str, body: Option<&str>) -> HttpResponse {
        if method == "GET" {
            self.calls
                .borrow_mut()
                .push("get-exposed-schemas".to_owned());
            let joined = self.exposed.borrow().join(",");

            return HttpResponse {
                status: 200,
                body: format!(r#"{{"db_schema":"{joined}"}}"#),
            };
        }
        let payload: serde_json::Value = serde_json::from_str(body.unwrap_or("{}")).unwrap();
        let schemas: Vec<String> = payload["db_schema"]
            .as_str()
            .unwrap_or_default()
            .split(',')
            .map(str::to_owned)
            .collect();
        if let Some(added) = schemas.last() {
            self.calls
                .borrow_mut()
                .push(format!("expose-schema {added}"));
        }
        *self.exposed.borrow_mut() = schemas;

        HttpResponse {
            status: 200,
            body: String::new(),
        }
    }

    /// What a re-apply leaves in the ledger: each upsert's hash replaces the
    /// row it names.
    fn record_upserts(&self, sql: &str) {
        let marker = "values ('pack-file', '";
        for line in sql
            .lines()
            .filter(|line| line.contains(marker) && line.contains("do update set"))
        {
            let values = &line[line.find(marker).unwrap() + marker.len()..];
            let mut fields = values.split("', '");
            let name = fields.next().unwrap().to_owned();
            let hash = fields.next().unwrap().to_owned();
            let mut rows = self.ledger_rows.borrow_mut();
            rows.retain(|(kind, recorded, _)| !(kind == "pack-file" && *recorded == name));
            rows.push(("pack-file".to_owned(), name, hash));
        }
    }

    fn handle_query(&self, body: Option<&str>) -> HttpResponse {
        let payload: serde_json::Value = serde_json::from_str(body.unwrap_or("{}")).unwrap();
        let sql = payload["query"].as_str().unwrap_or_default();
        if sql == crate::provision::ledger_present_query() {
            self.calls.borrow_mut().push("ledger-present".to_owned());
            let present = !self.ledger_rows.borrow().is_empty();

            return HttpResponse {
                status: 200,
                body: format!(r#"[{{"present":{present}}}]"#),
            };
        }
        if sql == crate::provision::ledger_rows_query() {
            self.calls.borrow_mut().push("ledger-rows".to_owned());
            let rows = self.ledger_rows.borrow();
            let body = serde_json::to_string(
                    &rows
                        .iter()
                        .map(|(kind, name, hash)| {
                            serde_json::json!({ "object_kind": kind, "object_name": name, "content_hash": hash, "pack_version": self.pack_version })
                        })
                        .collect::<Vec<_>>(),
                )
                .unwrap();

            return HttpResponse { status: 200, body };
        }
        if sql == crate::provision::ledger_state_query() {
            self.calls.borrow_mut().push("ledger-state".to_owned());

            return HttpResponse {
                status: 200,
                body: r#"[{"object_kind":"function","count":29}]"#.to_owned(),
            };
        }
        if sql == crate::provision::core_rpcs_query() {
            self.calls.borrow_mut().push("core-rpcs".to_owned());
            let body = serde_json::to_string(
                &self
                    .core_rpcs
                    .iter()
                    .map(|name| serde_json::json!({ "proname": name }))
                    .collect::<Vec<_>>(),
            )
            .unwrap();

            return HttpResponse { status: 200, body };
        }
        if sql == crate::provision::PG_CRON_QUERY {
            self.calls.borrow_mut().push("pg-cron".to_owned());

            return HttpResponse {
                status: 200,
                body: format!(r#"[{{"present":{}}}]"#, self.pg_cron),
            };
        }
        if let Some(body) = self.introspection_answer(sql) {
            self.calls.borrow_mut().push("introspect".to_owned());

            return HttpResponse { status: 200, body };
        }
        if sql == crate::config::config_query() {
            self.calls.borrow_mut().push("synced-tables".to_owned());

            return HttpResponse {
                status: 200,
                body: "[]".to_owned(),
            };
        }

        self.handle_script(sql)
    }

    /// The statements that write: a re-apply, the schedules, the project
    /// config, and anything else, which is the install.
    fn handle_script(&self, sql: &str) -> HttpResponse {
        if sql.starts_with("-- Generated by kizunasync: every pack file re-applied") {
            self.calls.borrow_mut().push("reconcile-pack".to_owned());
            match self.reapply {
                ReapplyAnswer::Records => self.record_upserts(sql),
                ReapplyAnswer::LeavesTheLedger => {}
                ReapplyAnswer::RefusedOverAMissingColumn => {
                    return HttpResponse {
                        status: 400,
                        body: MISSING_COLUMN_BODY.to_owned(),
                    };
                }
            }

            return HttpResponse {
                status: 200,
                body: String::new(),
            };
        }
        if sql.contains("kizunasync._schedule_jobs()::text") {
            self.calls.borrow_mut().push("schedule-jobs".to_owned());
            if self.schedules_fail {
                return HttpResponse {
                    status: 500,
                    body: r#"{"message":"permission denied for schema cron"}"#.to_owned(),
                };
            }

            return HttpResponse {
                status: 200,
                body: r#"[{"schedules":"{\"jobs\":{\"kizunasync-reap-tombstones\":\"16 3 * * *\"},\"pg_cron\":true}"}]"#
                    .to_owned(),
            };
        }
        if sql.starts_with("-- Generated by `kizunasync init`") {
            self.calls.borrow_mut().push("apply-config-sql".to_owned());

            return HttpResponse {
                status: 200,
                body: String::new(),
            };
        }
        self.calls.borrow_mut().push("apply-pack-sql".to_owned());
        if self.install_fails {
            return HttpResponse {
                status: 500,
                body: r#"{"message":"division by zero"}"#.to_owned(),
            };
        }
        self.applied.borrow_mut().push(sql.to_owned());
        // Simulate the seed the applied SQL leaves behind, so the post-apply
        // ledger report reads a ledger the run itself just created.
        self.ledger_rows.borrow_mut().push((
            "function".to_owned(),
            "kizunasync.pull".to_owned(),
            "seeded".to_owned(),
        ));

        HttpResponse {
            status: 200,
            body: String::new(),
        }
    }
}

impl FakeManagementTransport {
    /// The reads the remote wizard makes before it can propose anything: one
    /// table, no columns, no foreign key to `auth.users`, and the policies and
    /// row level security state the fixture holds.
    fn introspection_answer(&self, sql: &str) -> Option<String> {
        if crate::db::tables_query("public").is_ok_and(|query| query == sql) {
            return Some(r#"[{"table_name":"todos"}]"#.to_owned());
        }
        if crate::db::policies_query("public").is_ok_and(|query| query == sql) {
            return Some(self.policies.to_owned());
        }
        if crate::db::rls_disabled_query("public").is_ok_and(|query| query == sql) {
            return Some(self.rls_disabled.to_owned());
        }
        if crate::db::primary_keys_query("public").is_ok_and(|query| query == sql) {
            return Some(self.primary_keys.to_owned());
        }

        if crate::db::columns_query("public").is_ok_and(|query| query == sql)
            || crate::db::auth_user_fk_query("public").is_ok_and(|query| query == sql)
        {
            return Some("[]".to_owned());
        }

        None
    }
}

impl HttpTransport for FakeManagementTransport {
    fn send(
        &self,
        method: &str,
        url: &str,
        _token: &str,
        body: Option<&str>,
    ) -> crate::error::Result<HttpResponse> {
        if url.ends_with("/postgrest") {
            return Ok(self.handle_postgrest(method, body));
        }
        if url.ends_with("/database/query") {
            return Ok(self.handle_query(body));
        }

        Ok(HttpResponse {
            status: 404,
            body: String::new(),
        })
    }
}

/// The real shipped pack's files, read from the checkout rather than from
/// wherever the test binary happens to live (see [`test_pack_dir`]).
fn init_pack_files() -> Vec<PackFile> {
    pack::read_pack_files(&test_pack_dir()).unwrap()
}

fn remote_flags(yes: bool) -> InitFlags {
    InitFlags {
        yes,
        project_ref: Some(valid_ref(PROJECT_REF)),
        access_token: Some(PAT.to_owned()),
        ..base_flags()
    }
}

/// Drive `provision_remotely` directly against a fake transport, returning
/// its result, the captured output, and a handle onto the transport's call
/// log and mutated state.
fn provision_remotely_with(
    flags: &InitFlags,
    transport: FakeManagementTransport,
    prompter: Option<ScriptedPrompter>,
    pack_files: &[PackFile],
) -> (
    crate::error::Result<i32>,
    crate::ui::Capture,
    FakeManagementTransport,
) {
    let mut boxed = prompter;

    provision_remotely_lent(flags, transport, boxed.as_mut(), pack_files)
}

/// Like [`provision_remotely_with`], with the prompter lent so the test can
/// read back what it was shown.
fn provision_remotely_lent(
    flags: &InitFlags,
    transport: FakeManagementTransport,
    prompter: Option<&mut ScriptedPrompter>,
    pack_files: &[PackFile],
) -> (
    crate::error::Result<i32>,
    crate::ui::Capture,
    FakeManagementTransport,
) {
    let handle = transport.clone();
    let api = ManagementApi::new(
        transport,
        PAT,
        &valid_ref(PROJECT_REF),
        Some("https://api.test/"),
    );
    let (mut ui, capture) = Ui::capture();
    let prompter_ref: Option<&mut dyn Prompter> =
        prompter.map(|prompter| prompter as &mut dyn Prompter);
    let mut ports = InitPorts {
        prompter: prompter_ref,
        schemas: &PgSchemaSource,
        supabase: &NoopCli,
        now_unix: fixed_now(),
        tokens: &crate::token::NoTokenStore,
        list_projects: &unreachable_projects,
        browser_login: &no_browser,
        probe_remote: &remote_facts_ok,
    };
    let result = provision_remotely(flags, &api, pack_files, &mut ports, &mut ui);

    (result, capture, handle)
}

#[test]
fn project_ref_exits_naming_both_pat_sources_when_no_token_is_available() {
    let dir = tempfile::tempdir().unwrap();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            project_ref: Some(valid_ref(PROJECT_REF)),
            access_token: None,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("--access-token"));
    assert!(capture.stderr().contains("SUPABASE_ACCESS_TOKEN"));
}

#[test]
fn project_ref_dry_run_exposes_nothing_applies_nothing_writes_nothing() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &InitFlags {
            dry_run: true,
            ..remote_flags(true)
        },
        FakeManagementTransport::new(),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    assert!(
        !transport
            .calls()
            .iter()
            .any(|call| call.starts_with("expose-schema"))
    );
    assert!(!transport.calls().contains(&"apply-pack-sql".to_owned()));
    assert!(capture.stderr().contains(&pack_files[0].name));
    assert!(
        capture
            .stderr()
            .contains(&hash_pack_file(&pack_files[0].sql))
    );
}

#[test]
fn project_ref_non_interactive_without_yes_refuses_to_apply() {
    let pack_files = init_pack_files();
    let (result, _, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new(),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE);
    assert!(!transport.calls().contains(&"apply-pack-sql".to_owned()));
}

#[test]
fn project_ref_a_declined_confirm_applies_nothing_and_leaves_schemas_untouched() {
    let pack_files = init_pack_files();
    let prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(false),
    ]);
    let (result, _, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new(),
        Some(prompter),
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    assert!(!transport.calls().contains(&"apply-pack-sql".to_owned()));
    assert!(
        !transport
            .calls()
            .iter()
            .any(|call| call.starts_with("expose-schema"))
    );
}

/// The questions the remote wizard asks before its confirmation, for the one
/// table the fake catalog holds.
fn remote_wizard_answers() -> Vec<Answer> {
    vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
    ]
}

fn nothing_applied(transport: &FakeManagementTransport) {
    let calls = transport.calls();

    assert!(!calls.contains(&"apply-pack-sql".to_owned()), "{calls:?}");
    assert!(!calls.contains(&"reconcile-pack".to_owned()), "{calls:?}");
    assert!(
        !calls.iter().any(|call| call.starts_with("expose-schema")),
        "{calls:?}"
    );
}

/// Ctrl+C at the confirmation cancels the run: nothing applied, exit 0, as
/// `cli.md` documents for every prompt.
#[test]
fn project_ref_ctrl_c_at_the_confirm_exits_zero_and_applies_nothing() {
    let pack_files = init_pack_files();
    let mut answers = remote_wizard_answers();
    answers.push(Answer::Cancel);
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new(),
        Some(ScriptedPrompter::new(answers)),
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    assert!(capture.stderr().contains(CANCELLED), "{}", capture.stderr());
    nothing_applied(&transport);
}

/// A confirmation the session turns out unable to ask is a usage error.
#[test]
fn project_ref_a_confirm_that_cannot_be_asked_exits_two_and_applies_nothing() {
    let pack_files = init_pack_files();
    let mut answers = remote_wizard_answers();
    answers.push(Answer::NotInteractive);
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new(),
        Some(ScriptedPrompter::new(answers)),
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("refusing to apply without confirmation"),
        "{}",
        capture.stderr()
    );
    nothing_applied(&transport);
}

/// A prompter that fails outright at the confirmation is the same usage
/// error the local wizard reports, never a transport failure.
#[test]
fn project_ref_a_confirm_the_prompter_fails_on_exits_two_and_applies_nothing() {
    let pack_files = init_pack_files();
    // No answer left for `confirm`: `ScriptedPrompter` answers with
    // `PromptError::Script` exactly there.
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new(),
        Some(ScriptedPrompter::new(remote_wizard_answers())),
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE);
    assert!(
        capture.stderr().contains("the wizard could not ask"),
        "{}",
        capture.stderr()
    );
    nothing_applied(&transport);
}

/// The wizard's own exits reach the command: Ctrl+C on the table list is `0`,
/// a vanished terminal is `2`, and neither applies anything.
#[test]
fn project_ref_the_wizards_own_exits_reach_the_command() {
    for (answer, expected) in [(Answer::Cancel, OK), (Answer::NotInteractive, UNUSABLE)] {
        let pack_files = init_pack_files();
        let (result, capture, transport) = provision_remotely_with(
            &remote_flags(false),
            FakeManagementTransport::new(),
            Some(ScriptedPrompter::new(vec![answer])),
            &pack_files,
        );

        assert_eq!(result.unwrap(), expected, "{}", capture.stderr());
        nothing_applied(&transport);
    }
}

fn asked_modes(prompter: &ScriptedPrompter) -> Vec<&Ask> {
    prompter
        .asked()
        .iter()
        .filter(|ask| matches!(ask, Ask::Mode { .. }))
        .collect()
}

/// The remote confirmation is a step of the wizard: Backspace on it reopens
/// the step before, the mode on recommended, on the answer it gave, and a
/// yes after that applies.
#[test]
fn project_ref_a_back_on_the_recommended_confirm_reopens_the_mode_on_its_answer() {
    let pack_files = init_pack_files();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Back,
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (result, capture, transport) = provision_remotely_lent(
        &remote_flags(false),
        FakeManagementTransport::new(),
        Some(&mut prompter),
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        asked_modes(&prompter),
        [
            &Ask::Mode {
                current: WizardMode::Recommended
            },
            &Ask::Mode {
                current: WizardMode::Recommended
            },
        ]
    );
    assert_eq!(
        table_lists(&prompter).len(),
        1,
        "the list is not asked again"
    );
    assert_eq!(transport.applied().len(), 1, "{:?}", transport.calls());
}

/// On customize the step before the remote confirmation is the pg_cron
/// policy: it reopens on its last answer, every earlier answer is kept, and
/// the install carries the answers given last.
#[test]
fn project_ref_a_back_on_the_customize_confirm_reopens_the_cron_policy_and_keeps_every_answer() {
    let pack_files = init_pack_files();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(TableProposal {
            tombstone_ttl_days: Some(9),
            ..TableProposal::derived("todos", None, "[auto] no RLS policies found")
        }),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(reaping_at("0 4 * * *")),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(push_cap(20)),
        Answer::CronPolicy(true),
        Answer::Back,
        Answer::CronPolicy(false),
        Answer::Confirm(true),
    ]);
    let (result, capture, transport) = provision_remotely_lent(
        &remote_flags(false),
        FakeManagementTransport::new(),
        Some(&mut prompter),
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    let cron_policies: Vec<&Ask> = prompter
        .asked()
        .iter()
        .filter(|ask| matches!(ask, Ask::CronPolicy { .. }))
        .collect();
    assert_eq!(
        cron_policies,
        [
            &Ask::CronPolicy {
                allow_no_cron: false
            },
            &Ask::CronPolicy {
                allow_no_cron: true
            },
        ],
        "the policy reopens on the answer it gave"
    );
    assert_eq!(asked_modes(&prompter).len(), 1, "nothing before it reopens");
    let applied = transport.applied();
    assert_eq!(applied.len(), 1, "{:?}", transport.calls());
    let script = &applied[0];
    assert!(script.contains("  max_batch_size = 20"), "{script}");
    assert!(script.contains("reap_schedule = '0 4 * * *'"), "{script}");
    assert!(
        script.contains("pg_cron is not enabled"),
        "the second answer stops the install without pg_cron: {script}"
    );
}

/// `--yes` never prompts, terminal or not: a changed pack is refused with the
/// command that reconciles it, and nothing is asked.
#[test]
fn project_ref_yes_refuses_a_changed_pack_without_asking_even_on_a_terminal() {
    let pack_files = init_pack_files();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
    let (result, capture, transport) = provision_remotely_lent(
        &remote_flags(true),
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            pack_files[0].name.as_str(),
            "a-stale-hash",
        )]),
        Some(&mut prompter),
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE);
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    assert!(
        capture.stderr().contains(&format!(
            "`SUPABASE_ACCESS_TOKEN=… kizunasync upgrade --reapply --yes --project-ref {PROJECT_REF}`"
        )),
        "{}",
        capture.stderr()
    );
    nothing_applied(&transport);
}

/// `--yes` never offers a retry either: a failed pg_cron check ends the run.
#[test]
fn project_ref_yes_never_offers_a_retry_after_a_failed_pg_cron_check() {
    let pack_files = init_pack_files();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
    let (result, capture, transport) = provision_remotely_lent(
        &remote_flags(true),
        FakeManagementTransport::new().without_pg_cron(),
        Some(&mut prompter),
        &pack_files,
    );

    assert_eq!(result.unwrap(), FAILURE);
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    assert!(capture.stderr().contains("pg_cron is not enabled"));
    assert_eq!(
        transport
            .calls()
            .iter()
            .filter(|call| *call == "pg-cron")
            .count(),
        1
    );
}

/// Without `--yes` the terminal still gets its Retry.
#[test]
fn project_ref_a_terminal_without_yes_is_offered_a_retry() {
    let pack_files = init_pack_files();
    let mut answers = remote_wizard_answers();
    answers.extend([Answer::Confirm(true), Answer::Confirm(false)]);
    let mut prompter = ScriptedPrompter::new(answers);
    let (result, _, _) = provision_remotely_lent(
        &remote_flags(false),
        FakeManagementTransport::new().without_pg_cron(),
        Some(&mut prompter),
        &pack_files,
    );

    assert_eq!(result.unwrap(), FAILURE);
    assert!(prompter.asked().contains(&Ask::Confirm {
        message: "Retry?".to_owned(),
        default: true,
    }));
}

/// A dry run over a ledger that records only part of the pack reports the
/// refusal the real run makes, with its exit code, and prints no config SQL.
#[test]
fn project_ref_dry_run_reports_the_pack_gate_refusal_with_the_real_runs_code() {
    let pack_files = vec![
        PackFile {
            name: "0001_a.sql".to_owned(),
            sql: "select 1;".to_owned(),
        },
        PackFile {
            name: "0002_b.sql".to_owned(),
            sql: "select 2;".to_owned(),
        },
    ];
    let recorded = hash_pack_file("select 1;");
    let (result, capture, transport) = provision_remotely_with(
        &InitFlags {
            dry_run: true,
            ..remote_flags(true)
        },
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            "0001_a.sql",
            recorded.as_str(),
        )]),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE);
    let stderr = capture.stderr();
    assert!(
        stderr.contains("! 0002_b.sql: not recorded in the ledger"),
        "{stderr}"
    );
    assert!(
        stderr.contains("kizunasync upgrade --reapply --yes --project-ref"),
        "{stderr}"
    );
    assert_eq!(capture.stdout(), "", "no config SQL for a refused plan");
    nothing_applied(&transport);
}

/// A dry run asks nothing, so a changed pack meets the refusal a session
/// without a terminal gets, with its exit code, and nothing runs.
#[test]
fn project_ref_dry_run_over_a_changed_pack_refuses_without_asking() {
    let pack_files = init_pack_files();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
    let (result, capture, transport) = provision_remotely_lent(
        &InitFlags {
            dry_run: true,
            ..remote_flags(false)
        },
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            pack_files[0].name.as_str(),
            "a-stale-hash",
        )]),
        Some(&mut prompter),
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE);
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    assert!(
        capture.stderr().contains(&format!(
            "`SUPABASE_ACCESS_TOKEN=… kizunasync upgrade --reapply --yes --project-ref {PROJECT_REF}`"
        )),
        "{}",
        capture.stderr()
    );
    assert!(!transport.calls().contains(&"synced-tables".to_owned()));
    nothing_applied(&transport);
}

/// A fresh install is one script: every pack file with its ledger row, then
/// the project config, between one `begin` and one `commit`.
#[test]
fn project_ref_a_fresh_install_sends_the_pack_and_the_config_as_one_transaction() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new(),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK, "{}", capture.stderr());
    let applied = transport.applied();
    assert_eq!(applied.len(), 1, "one script, not one call per file");
    let script = &applied[0];
    assert!(
        script.starts_with("-- Generated by kizunasync: a fresh install"),
        "{script}"
    );
    assert_eq!(script.matches("\nbegin;\n").count(), 1);
    assert!(script.trim_end().ends_with("commit;"), "{script}");
    let config = script
        .find("-- Generated by `kizunasync init`. Provisions YOUR synced tables")
        .unwrap();
    for file in &pack_files {
        let ledgered = script
            .find(&crate::provision::render_pack_file_ledger_sql(
                &file.name,
                &hash_pack_file(&file.sql),
            ))
            .unwrap();
        assert!(ledgered < config, "the config comes last");
    }
    assert!(
        !transport.calls().contains(&"apply-config-sql".to_owned()),
        "the config rides in the same transaction"
    );
}

#[test]
fn project_ref_the_exposed_schema_patch_runs_only_after_the_ledger_has_been_read() {
    let pack_files = init_pack_files();
    let (result, _, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new(),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    let calls = transport.calls();
    let ledger_read_at = calls
        .iter()
        .position(|call| call == "ledger-present")
        .unwrap();
    let patch_at = calls
        .iter()
        .position(|call| call == "expose-schema kizunasync")
        .unwrap();
    assert!(patch_at > ledger_read_at);
}

#[test]
fn project_ref_a_fresh_project_exposes_the_schema_applies_the_pack_reports_the_ledger() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new(),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    assert!(transport.exposed_schemas().contains(&SCHEMA.to_owned()));
    assert!(transport.calls().contains(&"apply-pack-sql".to_owned()));
    assert!(capture.stderr().contains("added"));
    assert!(capture.stderr().contains(&pack_files[0].name));
    assert!(capture.stderr().contains("function"));
    assert!(capture.stderr().contains("29"));
}

#[test]
fn project_ref_an_already_exposed_schema_is_reported_not_re_patched() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new().with_exposed(&["public", "kizunasync"]),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    assert!(
        !transport
            .calls()
            .iter()
            .any(|call| call.starts_with("expose-schema"))
    );
    assert!(capture.stderr().contains("already exposed"));
}

#[test]
fn project_ref_an_up_to_date_ledger_applies_nothing() {
    let pack_files = init_pack_files();
    let hash = hash_pack_file(&pack_files[0].sql);
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            pack_files[0].name.as_str(),
            hash.as_str(),
        )]),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    assert!(!transport.calls().contains(&"apply-pack-sql".to_owned()));
    assert!(capture.stderr().contains("up to date"));
}

#[test]
fn project_ref_an_object_only_ledger_reports_already_provisioned_and_never_says_drift() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new().with_ledger_rows(&[
            ("function", "kizunasync.pull", "md5-of-pull"),
            ("function", "kizunasync.push", "md5-of-push"),
            ("cron", "kizunasync-reap-tombstones", "md5-of-reap"),
        ]),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    assert!(!transport.calls().contains(&"apply-pack-sql".to_owned()));
    assert!(capture.stderr().contains("already provisioned"));
    assert!(capture.stderr().contains("3 objects"));
    assert!(capture.stderr().contains("kizunasync init"));
    assert!(!capture.stderr().contains("drift"));
}

/// A ledger that records only part of the pack meets the pack gate: with
/// nobody to ask it is refused, naming the file and the command that applies
/// it, and the exposed schemas stay as they are.
#[test]
fn project_ref_a_refused_drift_plan_leaves_the_exposed_schemas_untouched() {
    let pack_files = vec![
        PackFile {
            name: "0001_a.sql".to_owned(),
            sql: "select 1;".to_owned(),
        },
        PackFile {
            name: "0002_b.sql".to_owned(),
            sql: "select 2;".to_owned(),
        },
    ];
    let recorded = hash_pack_file("select 1;");
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            "0001_a.sql",
            recorded.as_str(),
        )]),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE);
    assert!(
        !transport
            .calls()
            .iter()
            .any(|call| call.starts_with("expose-schema"))
    );
    let stderr = capture.stderr();
    assert!(
        stderr.contains("! 0002_b.sql: not recorded in the ledger"),
        "{stderr}"
    );
    assert!(
        stderr.contains("kizunasync upgrade --reapply --yes --project-ref"),
        "{stderr}"
    );
}

/// A stale ledger hash with no terminal stops before anything is exposed,
/// naming the command that reconciles it.
#[test]
fn project_ref_a_changed_pack_without_a_prompter_names_the_reapply_command() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            pack_files[0].name.as_str(),
            "a-stale-hash",
        )]),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE);
    let stderr = capture.stderr();
    assert!(
        stderr.contains(&format!(
            "! {}: ledger md5 a-stale-hash, pack md5 {}",
            pack_files[0].name,
            hash_pack_file(&pack_files[0].sql)
        )),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "`SUPABASE_ACCESS_TOKEN=… kizunasync upgrade --reapply --yes --project-ref {PROJECT_REF}`"
        )),
        "{stderr}"
    );
    assert!(!stderr.contains(PAT), "{stderr}");
    assert!(!transport.calls().contains(&"reconcile-pack".to_owned()));
    assert!(
        !transport
            .calls()
            .iter()
            .any(|call| call.starts_with("expose-schema"))
    );
}

/// A yes whose re-apply leaves the ledger still drifting meets the gate's
/// own refusal, and nothing past the gate runs.
#[test]
fn project_ref_a_re_apply_that_leaves_the_ledger_drifting_meets_the_gates_refusal() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new()
            .with_ledger_rows(&[("pack-file", pack_files[0].name.as_str(), "a-stale-hash")])
            .answering_a_reapply(ReapplyAnswer::LeavesTheLedger),
        Some(ScriptedPrompter::new(vec![Answer::Confirm(true)])),
        &pack_files,
    );
    let stderr = capture.stderr();

    assert_eq!(result.unwrap(), UNUSABLE, "{stderr}");
    assert!(
        stderr.contains(&format!(
            "this build's pack differs from the one the ledger records, so nothing was written. Re-apply it first with `SUPABASE_ACCESS_TOKEN=… kizunasync upgrade --reapply --yes --project-ref {PROJECT_REF}`."
        )),
        "{stderr}"
    );
    assert!(
        !stderr.contains("records only part of this pack"),
        "{stderr}"
    );
    let calls = transport.calls();
    assert!(!calls.contains(&"introspect".to_owned()), "{calls:?}");
    assert!(!calls.contains(&"apply-config-sql".to_owned()), "{calls:?}");
}

/// Over the Management API a re-apply the database refuses with 42703 reads
/// its SQLSTATE from the answer's body, rolls back, and names the fresh
/// install over the same project.
#[test]
fn project_ref_a_re_apply_refused_over_a_missing_column_names_a_fresh_install() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new()
            .with_ledger_rows(&[("pack-file", pack_files[0].name.as_str(), "a-stale-hash")])
            .answering_a_reapply(ReapplyAnswer::RefusedOverAMissingColumn),
        Some(ScriptedPrompter::new(vec![Answer::Confirm(true)])),
        &pack_files,
    );
    let stderr = capture.stderr();

    assert_eq!(result.unwrap(), FAILURE, "{stderr}");
    assert!(
        stderr.contains("so nothing was applied and the ledger is unchanged"),
        "{stderr}"
    );
    assert!(
        stderr.contains(
            "the database holds kizunasync tables from an earlier build of the pack, which a re-apply does not reshape. The Management API path cannot run `kizunasync deprovision`, so remove Kizuna over the project's direct connection with `PGPASSWORD=… kizunasync deprovision --purge --db-url <the project's connection string>`"
        ),
        "{stderr}"
    );
    assert!(
        stderr.contains(
            "then install it again with `PGPASSWORD=… kizunasync init --db-url <the project's connection string>`."
        ),
        "{stderr}"
    );
    assert!(
        !stderr.contains("deprovision --purge --project-ref"),
        "{stderr}"
    );
    assert!(!stderr.contains(PAT), "{stderr}");
    let calls = transport.calls();
    assert!(!calls.contains(&"schedule-jobs".to_owned()), "{calls:?}");
    assert!(!calls.contains(&"introspect".to_owned()), "{calls:?}");
}

/// Yes to the re-apply sends the one-transaction script, the ledger then
/// reads up to date, and the wizard carries on to the tables question.
#[test]
fn project_ref_a_confirmed_reapply_records_the_hash_and_continues_to_the_tables() {
    let pack_files = init_pack_files();
    let prompter = ScriptedPrompter::new(vec![
        Answer::Confirm(true),
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(false),
    ]);
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            pack_files[0].name.as_str(),
            "a-stale-hash",
        )]),
        Some(prompter),
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    let calls = transport.calls();
    let reconciled_at = calls
        .iter()
        .position(|call| call == "reconcile-pack")
        .unwrap();
    let introspected_at = calls.iter().position(|call| call == "introspect").unwrap();
    assert!(reconciled_at < introspected_at, "{calls:?}");
    assert!(calls.contains(&"schedule-jobs".to_owned()), "{calls:?}");
    assert!(!calls.contains(&"apply-pack-sql".to_owned()), "{calls:?}");
    let stderr = capture.stderr();
    assert!(
        stderr.contains("the ledger already records this pack: up to date"),
        "{stderr}"
    );
    assert!(!stderr.contains("refusing to apply"), "{stderr}");
}

/// `run_remote` builds the real HTTP transport, so this drives the fake
/// transport through `provision_remotely` and then the one mapping
/// `run_remote` applies to its result: Backspace on the flag-driven path is a
/// decline, never exit 3.
#[test]
fn project_ref_backspace_on_the_reapply_question_exits_zero_and_applies_nothing() {
    let pack_files = init_pack_files();
    let prompter = ScriptedPrompter::new(vec![Answer::Back]);
    let (result, _, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            pack_files[0].name.as_str(),
            "a-stale-hash",
        )]),
        Some(prompter),
        &pack_files,
    );
    let code = result.unwrap();
    let (mut ui, capture) = Ui::capture();

    assert_eq!(code, STEP_BACK);
    assert_eq!(settle_step_back(code, &mut ui), OK);
    assert!(capture.stderr().contains(CANCELLED), "{}", capture.stderr());
    let calls = transport.calls();
    assert!(!calls.contains(&"reconcile-pack".to_owned()), "{calls:?}");
    assert!(!calls.contains(&"apply-pack-sql".to_owned()), "{calls:?}");
    assert!(
        !calls.iter().any(|call| call.starts_with("expose-schema")),
        "{calls:?}"
    );
}

#[test]
fn a_code_other_than_step_back_passes_through_run_remote_untouched() {
    let (mut ui, capture) = Ui::capture();

    for code in [OK, FAILURE, UNUSABLE] {
        assert_eq!(settle_step_back(code, &mut ui), code);
    }
    assert_eq!(capture.stderr(), "");
}

/// The Management API path has no local tree to write a migration into, and
/// the offer says so before it asks.
#[test]
fn project_ref_the_reapply_note_says_no_local_migration_file_records_it() {
    let pack_files = init_pack_files();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
    let (result, _, _) = provision_remotely_lent(
        &remote_flags(false),
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            pack_files[0].name.as_str(),
            "a-stale-hash",
        )]),
        Some(&mut prompter),
        &pack_files,
    );

    assert_eq!(result.unwrap(), STEP_BACK);
    let (title, body) = &prompter.notes()[0];
    assert_eq!(title, "Pack changed");
    assert!(
        body.contains("this run writes no local migration file for it"),
        "{body}"
    );
    assert!(!body.contains("supabase db push"), "{body}");
}

/// No at the pack gate steps back: from `--project-ref` there is no step
/// before it, so the run ends on `0` with nothing applied.
#[test]
fn project_ref_a_declined_reapply_steps_back_and_applies_nothing() {
    let pack_files = init_pack_files();
    let prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new().with_ledger_rows(&[(
            "pack-file",
            pack_files[0].name.as_str(),
            "a-stale-hash",
        )]),
        Some(prompter),
        &pack_files,
    );

    let code = result.unwrap();
    let (mut ui, _) = Ui::capture();

    assert_eq!(code, STEP_BACK);
    assert_eq!(settle_step_back(code, &mut ui), OK);
    let calls = transport.calls();
    assert!(!calls.contains(&"reconcile-pack".to_owned()), "{calls:?}");
    assert!(!calls.contains(&"apply-pack-sql".to_owned()), "{calls:?}");
    assert!(!calls.contains(&"introspect".to_owned()), "{calls:?}");
    assert!(capture.stderr().contains("nothing applied."));
}

#[test]
fn project_ref_the_access_token_never_reaches_any_output() {
    let pack_files = init_pack_files();
    let (result, capture, _) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new(),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK);
    assert!(!capture.stdout().contains(PAT));
    assert!(!capture.stderr().contains(PAT));
}

// MARK: - push target, migration history, connection test

const WIZARD_URL: &str = "postgresql://wizard/db";
const REMOTE_ONLY: &str = "20260925201900";

/// [`REMOTE_ONLY`] as the history records it after another tool wrote it.
const USER_WROTE: &str = "20260925201900_create_todos";

/// The wizard's own questions once the connection is settled: tables,
/// recommended, and the write confirm.
fn wizard_plan_answers() -> Vec<Answer> {
    vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]
}

fn wizard_project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();

    dir
}

fn flag_url() -> InitFlags {
    InitFlags {
        db_url: Some(WIZARD_URL.to_owned()),
        ..base_flags()
    }
}

fn confirms(prompter: &ScriptedPrompter) -> Vec<String> {
    prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Confirm { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

fn candidate_lists(prompter: &ScriptedPrompter) -> usize {
    prompter
        .asked()
        .iter()
        .filter(|ask| matches!(ask, Ask::Candidate { .. }))
        .count()
}

#[test]
fn picking_the_local_stack_pushes_with_local() {
    let dir = wizard_project();
    let port = closed_port();
    write_config_toml(dir.path(), port);
    let cli = RecordingCli::new();
    let mut prompter = ScriptedPrompter::new(
        std::iter::once(Answer::Candidate(ConnectionCandidate::Local {
            port,
            reachable: false,
        }))
        .chain(wizard_plan_answers())
        .collect(),
    );
    let (code, capture) = run_with_cli(
        dir.path(),
        &base_flags(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()),
        &cli,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(cli.pushes.borrow().as_slice(), [PushTarget::Local]);
    assert!(
        confirms(&prompter)
            .contains(&"Write the migrations and run supabase db push --local now?".to_owned())
    );
    assert!(
        capture
            .stderr()
            .contains("applied via supabase db push --local. Run `kizunasync doctor` to verify.")
    );
}

#[test]
fn the_db_url_flag_pushes_to_that_url() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let mut prompter = ScriptedPrompter::new(wizard_plan_answers());
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()),
        &cli,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(
        cli.pushes.borrow().as_slice(),
        [PushTarget::DbUrl(WIZARD_URL.to_owned())]
    );
    assert!(
        capture
            .stderr()
            .contains("applied via supabase db push --db-url.")
    );
}

/// The pack migration an earlier `init` wrote, still on disk.
const EARLIER_INIT: &str = "20200101000000_kizunasync_init.sql";

const EARLIER_INIT_SQL: &str = "-- the pack as it was installed\n";

/// The read a re-apply makes before it asks: the synced tables its files are
/// classified against. It is the only statement the offer sends itself.
const SYNCED_TABLES_READ: &str = "select * from kizunasync._config order by table_name;";

/// A project whose migrations directory holds the pack migration an earlier
/// `init` wrote, which the database's history records.
fn provisioned_project() -> tempfile::TempDir {
    let dir = wizard_project();
    let migrations = dir.path().join("supabase/migrations");
    std::fs::create_dir_all(&migrations).unwrap();
    std::fs::write(migrations.join(EARLIER_INIT), EARLIER_INIT_SQL).unwrap();

    dir
}

/// The pack migrations on disk, in the order Supabase applies them.
fn init_migrations(root: &Path) -> Vec<String> {
    crate::emit::app_migration_names(&root.join("supabase/migrations"))
        .into_iter()
        .filter(|name| name.ends_with("_kizunasync_init.sql"))
        .collect()
}

/// A changed pack is offered a re-apply before anything else is asked. Yes
/// writes the pack again as a new migration beside the one an earlier run
/// left, which the plan lists and `supabase db push` applies with the rest of
/// the run, so the repository rebuilds to this pack. Nothing reaches the
/// database over the connection itself.
#[test]
fn a_changed_pack_is_written_as_a_new_migration_and_pushed_with_the_run() {
    let dir = provisioned_project();
    let cli = RecordingCli::new();
    let schemas = FakeSchemaSource::ok(wizard_catalog())
        .with_ledger(changed_pack_ledger())
        .with_history(&["20200101000000"]);
    let mut prompter = ScriptedPrompter::new(
        std::iter::once(Answer::Confirm(true))
            .chain(wizard_plan_answers())
            .collect(),
    );
    let (code, capture) =
        run_with_cli(dir.path(), &flag_url(), Some(&mut prompter), &schemas, &cli);
    let stderr = capture.stderr();

    assert_eq!(code, OK, "{stderr}");
    assert_eq!(confirms(&prompter)[0], "Re-apply the pack now?");
    let written = init_migrations(dir.path());
    assert_eq!(written.len(), 2, "{written:?}");
    assert_eq!(written[0], EARLIER_INIT);
    let reapplied = &written[1];
    let migrations = dir.path().join("supabase/migrations");
    let pack = &init_pack_files()[0];
    let body = std::fs::read_to_string(migrations.join(reapplied)).unwrap();
    assert_eq!(
        body,
        format!(
            "{}\n{}\n",
            pack.sql,
            crate::provision::render_pack_file_ledger_upsert_sql(
                &pack.name,
                &hash_pack_file(&pack.sql)
            )
        )
    );
    assert!(
        !body
            .lines()
            .any(|line| matches!(line.trim(), "begin;" | "commit;")),
        "supabase db push wraps the file in its own transaction"
    );
    assert_eq!(
        std::fs::read_to_string(migrations.join(EARLIER_INIT)).unwrap(),
        EARLIER_INIT_SQL
    );
    assert!(
        stderr.contains(&format!("  emitted {reapplied} (re-applies {})", pack.name)),
        "{stderr}"
    );
    assert_eq!(
        cli.pushes.borrow().as_slice(),
        [PushTarget::DbUrl(WIZARD_URL.to_owned())]
    );
    assert_eq!(*schemas.applier.executed.borrow(), [SYNCED_TABLES_READ]);
    let note = |title: &str| {
        prompter
            .notes()
            .iter()
            .find(|(shown, _)| shown == title)
            .map_or_else(|| panic!("no {title} note"), |(_, body)| body.clone())
    };
    assert!(
        note("Plan").contains(&format!("+ {reapplied}   (re-applies {})", pack.name)),
        "{}",
        note("Plan")
    );
    assert!(
        note("Pack changed").contains("written as a new migration in supabase/migrations"),
        "{}",
        note("Pack changed")
    );
}

/// Yes to the re-apply only puts its migration in the plan: declining the plan
/// writes nothing, so the run can still say it wrote nothing.
#[test]
fn declining_the_plan_after_a_yes_to_the_re_apply_writes_nothing() {
    let dir = provisioned_project();
    let cli = RecordingCli::new();
    let schemas = FakeSchemaSource::ok(wizard_catalog())
        .with_ledger(changed_pack_ledger())
        .with_history(&["20200101000000"]);
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Confirm(true),
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(false),
    ]);
    let (code, capture) =
        run_with_cli(dir.path(), &flag_url(), Some(&mut prompter), &schemas, &cli);

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(capture.stderr().contains(CANCELLED), "{}", capture.stderr());
    assert_eq!(init_migrations(dir.path()), [EARLIER_INIT]);
    assert!(cli.pushes.borrow().is_empty());
    assert_eq!(*schemas.applier.executed.borrow(), [SYNCED_TABLES_READ]);
}

#[test]
fn a_declined_re_apply_of_a_changed_pack_writes_nothing() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let schemas = FakeSchemaSource::ok(wizard_catalog()).with_ledger(changed_pack_ledger());
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
    let (code, capture) =
        run_with_cli(dir.path(), &flag_url(), Some(&mut prompter), &schemas, &cli);

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(*schemas.applier.executed.borrow(), [SYNCED_TABLES_READ]);
    assert!(cli.pushes.borrow().is_empty());
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// No at the pack gate returns to the connection question that settled the
/// connection, with nothing written.
#[test]
fn a_declined_re_apply_returns_to_the_connection_picker() {
    let dir = wizard_project();
    let port = closed_port();
    write_config_toml(dir.path(), port);
    let cli = RecordingCli::new();
    let schemas = FakeSchemaSource::ok(wizard_catalog()).with_ledger(changed_pack_ledger());
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Candidate(ConnectionCandidate::Local {
            port,
            reachable: false,
        }),
        Answer::Confirm(false),
        Answer::Cancel,
    ]);
    let (code, capture) = run_with_cli(
        dir.path(),
        &base_flags(),
        Some(&mut prompter),
        &schemas,
        &cli,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(candidate_lists(&prompter), 2);
    assert_eq!(confirms(&prompter), ["Re-apply the pack now?"]);
    assert_eq!(*schemas.applier.executed.borrow(), [SYNCED_TABLES_READ]);
    assert!(cli.pushes.borrow().is_empty());
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// `init --yes` cannot ask, so a changed pack stops the run naming the
/// command that re-applies it.
#[test]
fn a_non_interactive_run_over_a_changed_pack_names_the_reapply_command() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let schemas = FakeSchemaSource::ok(wizard_catalog()).with_ledger(changed_pack_ledger());
    let (code, capture) = run_with_cli(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        None,
        &schemas,
        &cli,
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(
        capture.stderr().contains(&format!(
            "`kizunasync upgrade --reapply --yes --db-url {WIZARD_URL}`"
        )),
        "{}",
        capture.stderr()
    );
    assert!(schemas.applier.executed.borrow().is_empty());
    assert!(cli.pushes.borrow().is_empty());
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn a_recorded_version_without_a_file_is_repaired_on_yes_then_pushed() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let mut prompter = ScriptedPrompter::new(
        std::iter::once(Answer::Confirm(true))
            .chain(wizard_plan_answers())
            .collect(),
    );
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).with_history(&[KIZUNASYNC_WROTE]),
        &cli,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(
        cli.repairs.borrow().as_slice(),
        [(
            PushTarget::DbUrl(WIZARD_URL.to_owned()),
            vec![REMOTE_ONLY.to_owned()]
        )]
    );
    assert_eq!(
        cli.pushes.borrow().as_slice(),
        [PushTarget::DbUrl(WIZARD_URL.to_owned())]
    );
    assert_eq!(
        confirms(&prompter).first().map(String::as_str),
        Some(
            "Mark them reverted in the history now (supabase migration repair --status reverted …)?"
        ),
        "the repair is asked before anything else"
    );
    assert_eq!(prompter.notes()[0].0, "Migration history");
}

/// Every migration an install writes takes a second after the versions
/// already on disk, so a file an earlier run wrote in the same second never
/// shares its version.
#[test]
fn an_install_names_its_migrations_after_every_version_on_disk() {
    let dir = wizard_project();
    let migrations = dir.path().join("supabase/migrations");
    std::fs::create_dir_all(&migrations).unwrap();
    let taken = format!(
        "{}_create_todos.sql",
        crate::clock::migration_version(fixed_now())
    );
    std::fs::write(migrations.join(&taken), "").unwrap();
    let mut prompter = ScriptedPrompter::new(wizard_plan_answers());
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()),
        &RecordingCli::new(),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    let written: Vec<String> = crate::emit::app_migration_names(&migrations)
        .into_iter()
        .filter(|name| name != &taken)
        .collect();
    assert_eq!(
        written,
        [
            crate::emit::timestamped_name("0001_kizuna_init.sql", fixed_now(), 1),
            crate::emit::config_migration_name(fixed_now(), 2),
        ]
    );
}

/// The versions the migration history recorded when the run read it are
/// taken too, the ones a repair marked reverted included.
#[test]
fn an_install_names_its_migrations_after_the_versions_the_history_recorded() {
    let dir = wizard_project();
    let mut prompter = ScriptedPrompter::new(
        std::iter::once(Answer::Confirm(true))
            .chain(wizard_plan_answers())
            .collect(),
    );
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).with_history(&[KIZUNASYNC_WROTE]),
        &RecordingCli::new(),
    );
    let after = crate::clock::migration_second(REMOTE_ONLY).unwrap() + 1;

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(after > fixed_now());
    assert_eq!(
        crate::emit::app_migration_names(&dir.path().join("supabase/migrations")),
        [
            crate::emit::timestamped_name("0001_kizuna_init.sql", after, 0),
            crate::emit::config_migration_name(after, 1),
        ]
    );
}

#[test]
fn declining_the_repair_exits_clean_with_nothing_written_or_pushed() {
    let dir = wizard_project();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).with_history(&[KIZUNASYNC_WROTE]),
        &UnreachableCli,
    );

    assert_eq!(code, OK);
    assert!(!dir.path().join("supabase/migrations").exists());
    assert_eq!(confirms(&prompter).len(), 1, "the write is never asked");
    assert!(capture.stderr().contains(&format!(
        "nothing written. Run `supabase migration repair --status reverted {REMOTE_ONLY} --db-url {WIZARD_URL}`"
    )));
}

#[test]
fn a_local_migration_behind_the_history_stops_naming_include_all() {
    let dir = wizard_project();
    let migrations = dir.path().join("supabase").join("migrations");
    std::fs::create_dir_all(&migrations).unwrap();
    std::fs::write(migrations.join("0001_old.sql"), "").unwrap();
    std::fs::write(migrations.join("20260101000000_app.sql"), "").unwrap();
    let mut prompter = ScriptedPrompter::default();
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).with_history(&["20260101000000", REMOTE_ONLY]),
        &UnreachableCli,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains(&format!(
        "supabase db push --include-all --db-url {WIZARD_URL}"
    )));
    assert!(confirms(&prompter).is_empty());
    assert_eq!(
        std::fs::read_dir(&migrations).unwrap().count(),
        2,
        "nothing new is written"
    );
}

#[test]
fn a_failed_connection_test_offers_the_candidates_again() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let second = "postgresql://second/db";
    let mut prompter = ScriptedPrompter::new(
        vec![
            Answer::Candidate(ConnectionCandidate::Manual),
            Answer::DbUrl("postgresql://first/db".to_owned()),
            Answer::Confirm(true),
            Answer::Candidate(ConnectionCandidate::Manual),
            Answer::DbUrl(second.to_owned()),
        ]
        .into_iter()
        .chain(wizard_plan_answers())
        .collect(),
    );
    let (code, capture) = run_with_cli(
        dir.path(),
        &base_flags(),
        Some(&mut prompter),
        &FakeSchemaSource::failing_probes(&["connection refused"], wizard_catalog()),
        &cli,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(candidate_lists(&prompter), 2);
    assert_eq!(
        confirms(&prompter).first().map(String::as_str),
        Some("Pick another connection?")
    );
    assert!(
        capture
            .stderr()
            .contains("could not connect to the database:\n    connection refused")
    );
    assert_eq!(
        cli.pushes.borrow().as_slice(),
        [PushTarget::DbUrl(second.to_owned())]
    );
}

#[test]
fn a_failed_connection_test_without_another_pick_exits_two() {
    let dir = wizard_project();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Candidate(ConnectionCandidate::Manual),
        Answer::DbUrl(WIZARD_URL.to_owned()),
        Answer::Confirm(false),
    ]);
    let (code, _) = run_with_cli(
        dir.path(),
        &base_flags(),
        Some(&mut prompter),
        &FakeSchemaSource::failing_probe("connection refused"),
        &UnreachableCli,
    );

    assert_eq!(code, UNUSABLE);
    assert_eq!(candidate_lists(&prompter), 1);
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn the_non_interactive_path_tests_the_connection_and_pushes_to_the_db_url() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let (code, capture) = run_with_cli(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(wizard_catalog()),
        &cli,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    let stderr = capture.stderr();
    assert!(
        stderr.contains("  connected:        PostgreSQL 17.4, database postgres as postgres"),
        "{stderr}"
    );
    assert!(
        stderr.contains("migration history: matches (0 applied)"),
        "{stderr}"
    );
    assert!(
        stderr.contains("proposed 1 synced table(s) from RLS policies"),
        "{stderr}"
    );
    assert_eq!(
        cli.pushes.borrow().as_slice(),
        [PushTarget::DbUrl(WIZARD_URL.to_owned())]
    );
    assert!(stderr.contains("applied via supabase db push --db-url."));
}

#[test]
fn a_recorded_version_without_a_file_stops_the_non_interactive_path() {
    let dir = wizard_project();
    let (code, capture) = run_with_cli(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(wizard_catalog()).with_history(&[REMOTE_ONLY]),
        &UnreachableCli,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains(&format!(
        "supabase migration repair --status reverted {REMOTE_ONLY} --db-url {WIZARD_URL}"
    )));
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn a_failed_connection_test_on_the_non_interactive_path_exits_two() {
    let dir = wizard_project();
    let (code, capture) = run_with_cli(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::failing_probe("connection refused"),
        &UnreachableCli,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("could not connect to the database:\n    connection refused")
    );
    assert!(capture.stderr().contains("re-run with --local-only"));
}

#[test]
fn describe_connection_mode_names_the_direct_push_target() {
    let connection = WizardConnection::Direct(DirectConnection {
        url: "postgres://localhost:54322/postgres".to_owned(),
        push: PushTarget::Local,
    });

    let mode = describe_connection_mode(&connection, false);

    assert!(mode.contains("supabase db push --local"), "{mode}");
}

#[test]
fn describe_connection_mode_names_the_management_api_and_the_project() {
    let connection = WizardConnection::Remote {
        project_ref: valid_ref("abcdefghijklmno"),
        credential: RemoteCredential {
            token: "sbp_test".to_owned(),
            origin: "entered".to_owned(),
        },
    };

    let mode = describe_connection_mode(&connection, false);

    assert!(mode.contains("Management API"), "{mode}");
    assert!(mode.contains("abcdefghijklmno"), "{mode}");
}

// MARK: - an unreadable history and a refused push

/// What the Supabase CLI answers when the history records a version that
/// `supabase/migrations/` does not hold.
const PUSH_REFUSED: &str = "Remote migration versions not found in local migrations directory.";
const HISTORY_UNREAD: &str = "permission denied for schema supabase_migrations";
const CONTINUE_UNREAD: &str = "Continue without checking the migration history?";
const REPAIR_QUESTION: &str =
    "Mark them reverted in the history now (supabase migration repair --status reverted …)?";
const WRITE_QUESTION: &str = "Write the migrations and run supabase db push --db-url now?";

/// A fixed clock that sits after [`REMOTE_ONLY`], so the migrations the drift
/// scenario writes are newer than the remote-only version it records.
const REPORTED_NOW: i64 = 1_790_424_000;

fn push_failing(stderr: &str) -> CliResult {
    CliResult {
        ok: false,
        stderr: stderr.to_owned(),
    }
}

fn push_ok() -> CliResult {
    CliResult {
        ok: true,
        stderr: String::new(),
    }
}

/// The confirms asked, each with the default Enter alone would have meant.
fn confirms_with_defaults(prompter: &ScriptedPrompter) -> Vec<(String, bool)> {
    prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Confirm { message, default } => Some((message.clone(), *default)),
            _ => None,
        })
        .collect()
}

/// The migrations this run left in the project, sorted.
fn written_migrations(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir.join("supabase/migrations"))
        .map(|entries| {
            entries
                .filter_map(|entry| {
                    entry
                        .ok()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();

    names
}

#[test]
fn an_unreadable_history_stops_the_wizard_before_anything_is_written() {
    let dir = wizard_project();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).with_history_reads(&[Err(HISTORY_UNREAD)]),
        &UnreachableCli,
        REPORTED_NOW,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(
        confirms_with_defaults(&prompter),
        [(CONTINUE_UNREAD.to_owned(), false)],
        "the only question is whether to continue, and Enter alone says no"
    );
    let stderr = capture.stderr();
    assert!(
        stderr.contains(HISTORY_UNREAD),
        "the cause is named: {stderr}"
    );
    assert!(stderr.contains("nothing written"), "{stderr}");
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn an_unreadable_history_continues_only_on_an_explicit_yes() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let mut prompter = ScriptedPrompter::new(
        std::iter::once(Answer::Confirm(true))
            .chain(wizard_plan_answers())
            .collect(),
    );
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).with_history_reads(&[Err(HISTORY_UNREAD)]),
        &cli,
        REPORTED_NOW,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(
        confirms_with_defaults(&prompter),
        [
            (CONTINUE_UNREAD.to_owned(), false),
            (WRITE_QUESTION.to_owned(), false)
        ]
    );
    assert_eq!(
        cli.pushes.borrow().as_slice(),
        [PushTarget::DbUrl(WIZARD_URL.to_owned())]
    );
}

/// The reported run: the history read fails, the push is refused for a
/// recorded version with no local file, and the read still fails afterwards.
/// There is nothing a retry could change, so none is offered.
#[test]
fn the_reported_run_stops_after_the_refused_push_without_a_retry_loop() {
    let dir = wizard_project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED)]);
    let mut prompter = ScriptedPrompter::new(
        std::iter::once(Answer::Confirm(true))
            .chain(wizard_plan_answers())
            .collect(),
    );
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).with_history_reads(&[Err(HISTORY_UNREAD)]),
        &cli,
        REPORTED_NOW,
    );

    assert_eq!(code, FAILURE, "{}", capture.stderr());
    assert_eq!(cli.pushes.borrow().len(), 1, "pushed once, never again");
    assert_eq!(
        confirms_with_defaults(&prompter),
        [
            (CONTINUE_UNREAD.to_owned(), false),
            (WRITE_QUESTION.to_owned(), false)
        ],
        "no Retry is offered"
    );
    assert_eq!(prompter.unused(), 0);
    let written = written_migrations(dir.path());
    assert!(!written.is_empty());
    let stderr = capture.stderr();
    assert!(
        stderr.contains(&format!("supabase db push failed:\n    {PUSH_REFUSED}")),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "supabase db push failed, and some of the files this run wrote may have been applied: {}. Check with `supabase migration list --db-url {WIZARD_URL}`, then run `supabase db push --db-url {WIZARD_URL}`.",
            written.join(", ")
        )),
        "{stderr}"
    );
    assert!(!stderr.contains("ARE written"), "{stderr}");
    assert!(!stderr.contains("nothing was applied"), "{stderr}");
}

/// The history re-read after a failed push, as it reports each file this run
/// wrote: none of them is recorded as applied.
fn assert_none_recorded_as_applied(stderr: &str, written: &[String]) {
    assert!(
        stderr.contains(
            "the migration history records, of the files this run wrote to supabase/migrations:"
        ),
        "{stderr}"
    );
    for name in written {
        assert!(
            stderr.contains(&format!("    not applied: {name}")),
            "{stderr}"
        );
    }
}

/// The reported run, end to end, over a version `kizunasync` wrote: the
/// history read fails, the push is refused, and the history read again
/// records `20260925201900` under a name this CLI writes. The repair is
/// offered on its own question, and a yes pushes again.
#[test]
fn the_reported_run_over_a_version_kizunasync_wrote_offers_the_repair_then_pushes_again() {
    let dir = wizard_project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED), push_ok()]);
    let mut prompter = ScriptedPrompter::new(
        std::iter::once(Answer::Confirm(true))
            .chain(wizard_plan_answers())
            .chain(std::iter::once(Answer::Confirm(true)))
            .collect(),
    );
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog())
            .with_history_reads(&[Err(HISTORY_UNREAD), Ok(&[KIZUNASYNC_WROTE])]),
        &cli,
        REPORTED_NOW,
    );
    let stderr = capture.stderr();

    assert_eq!(code, OK, "{stderr}");
    assert_eq!(
        cli.repairs.borrow().as_slice(),
        [(
            PushTarget::DbUrl(WIZARD_URL.to_owned()),
            vec![REMOTE_ONLY.to_owned()]
        )]
    );
    assert_eq!(cli.pushes.borrow().len(), 2);
    assert_eq!(
        confirms_with_defaults(&prompter),
        [
            (CONTINUE_UNREAD.to_owned(), false),
            (WRITE_QUESTION.to_owned(), false),
            (REPAIR_QUESTION.to_owned(), false)
        ],
        "the repair replaces the Retry"
    );
    assert!(
        stderr.contains(&format!("    - {REMOTE_ONLY} kizunasync_config")),
        "{stderr}"
    );
    assert_none_recorded_as_applied(&stderr, &written_migrations(dir.path()));
    assert!(
        stderr.contains("applied via supabase db push --db-url."),
        "{stderr}"
    );
}

/// The reported run, end to end, over a version another tool wrote: the
/// history read again records `20260925201900` under an app migration's
/// name, so nothing is offered or retried. The run names the commands that
/// settle it, marks none of them as `kizunasync`'s, and fails.
#[test]
fn the_reported_run_over_a_version_another_tool_wrote_stops_with_the_commands() {
    let dir = wizard_project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED)]);
    let mut prompter = ScriptedPrompter::new(
        std::iter::once(Answer::Confirm(true))
            .chain(wizard_plan_answers())
            .collect(),
    );
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog())
            .with_history_reads(&[Err(HISTORY_UNREAD), Ok(&[USER_WROTE])]),
        &cli,
        REPORTED_NOW,
    );
    let stderr = capture.stderr();

    assert_eq!(code, FAILURE, "{stderr}");
    assert_eq!(cli.pushes.borrow().len(), 1, "pushed once, never again");
    assert!(cli.repairs.borrow().is_empty());
    assert_eq!(
        confirms_with_defaults(&prompter),
        [
            (CONTINUE_UNREAD.to_owned(), false),
            (WRITE_QUESTION.to_owned(), false)
        ],
        "neither the repair nor a Retry is asked"
    );
    assert_eq!(prompter.unused(), 0);
    assert_none_recorded_as_applied(&stderr, &written_migrations(dir.path()));
    assert!(
        stderr.contains(&format!("    - {REMOTE_ONLY} create_todos")),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!("`supabase migration list --db-url {WIZARD_URL}`")),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "    supabase migration repair --status reverted {REMOTE_ONLY} --db-url {WIZARD_URL}\n"
        )),
        "{stderr}"
    );
    assert!(!stderr.contains("written by kizunasync"), "{stderr}");
    assert!(
        stderr.contains(&format!(
            "Settle each one, then run `supabase db push --db-url {WIZARD_URL}`."
        )),
        "{stderr}"
    );
}

/// `--yes` never prompts, even on a terminal: a refused push prints what the
/// history read again records and the commands that settle it, then fails.
#[test]
fn init_yes_on_a_terminal_never_asks_after_a_refused_push() {
    let dir = wizard_project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED)]);
    let mut prompter = ScriptedPrompter::default();
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog())
            .with_history_reads(&[Ok(&[]), Ok(&[KIZUNASYNC_WROTE])]),
        &cli,
        REPORTED_NOW,
    );
    let stderr = capture.stderr();

    assert_eq!(code, FAILURE, "{stderr}");
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    assert_eq!(cli.pushes.borrow().len(), 1);
    assert!(cli.repairs.borrow().is_empty());
    assert_none_recorded_as_applied(&stderr, &written_migrations(dir.path()));
    assert!(
        stderr.contains(&format!(
            "run `supabase migration repair --status reverted {REMOTE_ONLY} --db-url {WIZARD_URL}` or `supabase db pull`, then run `supabase db push --db-url {WIZARD_URL}`."
        )),
        "{stderr}"
    );
}

#[test]
fn init_yes_on_a_terminal_never_asks_past_an_unreadable_history() {
    let dir = wizard_project();
    let mut prompter = ScriptedPrompter::default();
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).with_history_reads(&[Err(HISTORY_UNREAD)]),
        &UnreachableCli,
        REPORTED_NOW,
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    assert!(capture.stderr().contains(HISTORY_UNREAD));
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn init_yes_on_a_terminal_never_offers_a_retry() {
    let dir = wizard_project();
    let cli = RecordingCli::pushing(vec![push_failing("connection reset by peer")]);
    let mut prompter = ScriptedPrompter::default();
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()),
        &cli,
        REPORTED_NOW,
    );

    assert_eq!(code, FAILURE, "{}", capture.stderr());
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    assert_eq!(cli.pushes.borrow().len(), 1);
    assert!(
        capture
            .stderr()
            .contains("Fix the problem and run `supabase db push --db-url`.")
    );
}

#[test]
fn declining_the_repair_after_a_refused_push_names_the_commands_and_fails() {
    let dir = wizard_project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED)]);
    let mut prompter = ScriptedPrompter::new(
        wizard_plan_answers()
            .into_iter()
            .chain(std::iter::once(Answer::Confirm(false)))
            .collect(),
    );
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog())
            .with_history_reads(&[Ok(&[]), Ok(&[KIZUNASYNC_WROTE])]),
        &cli,
        REPORTED_NOW,
    );

    assert_eq!(code, FAILURE, "{}", capture.stderr());
    assert!(cli.repairs.borrow().is_empty());
    assert_eq!(cli.pushes.borrow().len(), 1);
    assert_eq!(
        confirms_with_defaults(&prompter),
        [
            (WRITE_QUESTION.to_owned(), false),
            (REPAIR_QUESTION.to_owned(), false)
        ]
    );
    let stderr = capture.stderr();
    assert!(
        stderr.contains(&format!(
            "nothing applied. Run `supabase migration repair --status reverted {REMOTE_ONLY} --db-url {WIZARD_URL}` or `supabase db pull`, then run `supabase db push --db-url {WIZARD_URL}`."
        )),
        "{stderr}"
    );
}

#[test]
fn a_local_file_behind_after_a_refused_push_stops_naming_include_all() {
    let dir = wizard_project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED)]);
    let mut prompter = ScriptedPrompter::new(wizard_plan_answers());
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog())
            .with_history_reads(&[Ok(&[]), Ok(&["20991231000000"])]),
        &cli,
        REPORTED_NOW,
    );

    assert_eq!(code, FAILURE, "{}", capture.stderr());
    assert_eq!(cli.pushes.borrow().len(), 1);
    assert_eq!(
        confirms_with_defaults(&prompter),
        [(WRITE_QUESTION.to_owned(), false)]
    );
    let stderr = capture.stderr();
    assert!(
        stderr.contains(&format!(
            "supabase db push --include-all --db-url {WIZARD_URL}"
        )),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "then run `supabase db push --db-url {WIZARD_URL}`."
        )),
        "{stderr}"
    );
}

#[test]
fn a_push_that_fails_over_a_clean_history_offers_a_retry() {
    let dir = wizard_project();
    let cli = RecordingCli::pushing(vec![push_failing("connection reset by peer"), push_ok()]);
    let mut prompter = ScriptedPrompter::new(
        wizard_plan_answers()
            .into_iter()
            .chain(std::iter::once(Answer::Confirm(true)))
            .collect(),
    );
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()),
        &cli,
        REPORTED_NOW,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(cli.pushes.borrow().len(), 2);
    assert_eq!(
        confirms_with_defaults(&prompter),
        [
            (WRITE_QUESTION.to_owned(), false),
            ("Retry?".to_owned(), true)
        ]
    );
}

#[test]
fn an_unreadable_history_stops_init_yes_before_anything_is_written() {
    let dir = wizard_project();
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(wizard_catalog()).with_history_reads(&[Err(HISTORY_UNREAD)]),
        &UnreachableCli,
        REPORTED_NOW,
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(capture.stderr().contains(HISTORY_UNREAD));
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// A dry run makes the comparison the real run makes before it writes: drift
/// is reported with the commands that settle it and the real run's exit, and
/// nothing is repaired or written.
#[test]
fn a_dry_run_compares_the_migration_history_and_reports_drift_with_the_real_runs_exit() {
    let dir = wizard_project();
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &InitFlags {
            dry_run: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(wizard_catalog()).with_history(&[KIZUNASYNC_WROTE]),
        &UnreachableCli,
        REPORTED_NOW,
    );
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains("--dry-run: nothing will be written."),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "records 1 version(s) with no file in supabase/migrations:\n    - {REMOTE_ONLY}"
        )),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "run `supabase migration repair --status reverted {REMOTE_ONLY} --db-url {WIZARD_URL}`"
        )),
        "{stderr}"
    );
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn a_dry_run_over_a_matching_history_says_so_and_exits_zero() {
    let dir = wizard_project();
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &InitFlags {
            dry_run: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(wizard_catalog()).with_history(&[]),
        &UnreachableCli,
        REPORTED_NOW,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("migration history: matches (0 applied)"),
        "{}",
        capture.stderr()
    );
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn a_dry_run_over_an_unreadable_history_stops_on_the_real_runs_exit() {
    let dir = wizard_project();
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &InitFlags {
            dry_run: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(wizard_catalog()).with_history_reads(&[Err(HISTORY_UNREAD)]),
        &UnreachableCli,
        REPORTED_NOW,
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(capture.stderr().contains(HISTORY_UNREAD));
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn a_refused_push_on_init_yes_names_the_repair_and_never_retries() {
    let dir = wizard_project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED)]);
    let (code, capture) = run_with_cli_at(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(wizard_catalog())
            .with_history_reads(&[Ok(&[]), Ok(&[KIZUNASYNC_WROTE])]),
        &cli,
        REPORTED_NOW,
    );

    assert_eq!(code, FAILURE, "{}", capture.stderr());
    assert_eq!(cli.pushes.borrow().len(), 1);
    assert!(cli.repairs.borrow().is_empty());
    let stderr = capture.stderr();
    assert!(
        stderr.contains(&format!(
            "run `supabase migration repair --status reverted {REMOTE_ONLY} --db-url {WIZARD_URL}` or `supabase db pull`, then run `supabase db push --db-url {WIZARD_URL}`."
        )),
        "{stderr}"
    );
}

// MARK: - back navigation through the wizard

fn todos_answer() -> TableProposal {
    TableProposal {
        conflict: Some(ConflictMode::Hlc),
        ..TableProposal::derived("todos", Some("user_id"), "[auto]")
    }
}

/// The table list as the scripted prompter was shown it: each table with its
/// pre-check state.
fn table_lists(prompter: &ScriptedPrompter) -> Vec<Vec<(String, bool)>> {
    prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Tables { choices } => Some(
                choices
                    .iter()
                    .map(|choice| (choice.table.clone(), choice.checked))
                    .collect(),
            ),
            _ => None,
        })
        .collect()
}

/// A run of the wizard, kept for its assertions.
struct WizardRun {
    dir: tempfile::TempDir,
    code: i32,
    capture: crate::ui::Capture,
    prompter: ScriptedPrompter,
    cli: RecordingCli,
}

fn push_cap(size: i64) -> ProjectSettings {
    ProjectSettings {
        max_batch_size: Some(crate::config::MaxBatchSize::Mutations(size)),
        ..ProjectSettings::default()
    }
}

fn reaping_at(schedule: &str) -> ProjectSettings {
    ProjectSettings {
        reap_schedule: Some(schedule.to_owned()),
        ..ProjectSettings::pack_defaults()
    }
}

/// A customize walk over `todos` answered to the plan confirmation, backed
/// out of one step at a time down to the table list, then answered again with
/// `notes` added and every step given a new answer.
fn run_backed_out_wizard() -> WizardRun {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(todos_answer()),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(reaping_at("0 4 * * *")),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(push_cap(20)),
        Answer::CronPolicy(true),
        // The plan confirmation, then every step before it, back to the list:
        // each custom section on its value, then its select, then the table.
        Answer::Back,
        Answer::Back,
        Answer::Back,
        Answer::Back,
        Answer::Back,
        Answer::Back,
        Answer::Back,
        Answer::Back,
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(TableProposal {
            register_clients: true,
            ..TableProposal::derived("notes", None, "[auto] no owner")
        }),
        Answer::Customize(TableProposal {
            min_schema_version: Some(3),
            ..todos_answer()
        }),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(reaping_at("0 5 * * *")),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(push_cap(40)),
        Answer::CronPolicy(false),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()),
        &cli,
    );

    WizardRun {
        dir,
        code,
        capture,
        prompter,
        cli,
    }
}

/// The only question after the install applied its writes is the pg_cron
/// retry, and Backspace there ends the run: no step before the writes reopens.
#[test]
fn backspace_after_the_applied_install_ends_the_run() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
        Answer::Back,
    ]);
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).without_pg_cron(),
        &cli,
    );

    assert_eq!(code, FAILURE, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(cli.pushes.borrow().len(), 1);
    assert_eq!(table_lists(&prompter).len(), 1);
    assert!(matches!(
        prompter.asked().last(),
        Some(Ask::Confirm { message, .. }) if message == "Retry?"
    ));
}

#[test]
fn a_back_at_every_wizard_step_reopens_the_one_before_on_its_last_answer() {
    let run = run_backed_out_wizard();

    assert_eq!(run.code, OK, "{}", run.capture.stderr());
    assert_eq!(run.prompter.unused(), 0);
    assert_eq!(
        table_lists(&run.prompter),
        [
            vec![("notes".to_owned(), true), ("todos".to_owned(), true)],
            vec![("notes".to_owned(), false), ("todos".to_owned(), true)],
        ],
        "the list reopens as it was answered"
    );
    let asked: Vec<&Ask> = run
        .prompter
        .asked()
        .iter()
        .filter(|ask| !matches!(ask, Ask::Phase { .. } | Ask::Tables { .. }))
        .collect();
    let capped_at_20 = |current: &ProjectSettings| {
        current.max_batch_size == Some(crate::config::MaxBatchSize::Mutations(20))
    };
    let reaping_at_4 =
        |current: &ProjectSettings| current.reap_schedule.as_deref() == Some("0 4 * * *");
    let push_select_at_20 = |ask: &Ask| matches!(ask, Ask::Section { section: ServerSection::PushPolicy, current, .. } if capped_at_20(current));
    let maintenance_select_at_4 = |ask: &Ask| matches!(ask, Ask::Section { section: ServerSection::Maintenance, current, .. } if reaping_at_4(current));
    let allowing = Ask::CronPolicy {
        allow_no_cron: true,
    };
    let customize = Ask::Mode {
        current: WizardMode::Customize,
    };
    let todos = Ask::Customize {
        current: todos_answer(),
        entry: Entry::First,
    };
    let custom = |ask: &Ask| {
        matches!(
            ask,
            Ask::Section {
                choice: SectionChoice::Custom,
                ..
            }
        )
    };

    assert!(matches!(asked[7], Ask::Confirm { message, .. } if message == WRITE_QUESTION));
    // Backing out: each step reopens on the answer it gave, a customized
    // section on its last value, then on its select.
    assert_eq!(asked[8], &allowing);
    assert!(matches!(asked[9], Ask::PushPolicy { current } if capped_at_20(current)));
    assert!(push_select_at_20(asked[10]) && custom(asked[10]));
    assert!(
        matches!(asked[11], Ask::Maintenance { current, entry: Entry::Last } if reaping_at_4(current))
    );
    assert!(maintenance_select_at_4(asked[12]) && custom(asked[12]));
    assert_eq!(
        asked[13],
        &Ask::Customize {
            current: todos_answer(),
            entry: Entry::Last,
        }
    );
    assert_eq!(asked[14], &customize);
    // Answering again: the same, and a table new to the list opens inferred.
    assert_eq!(asked[15], &customize);
    assert!(
        matches!(asked[16], Ask::Customize { current, .. } if current.table == "notes" && !current.register_clients)
    );
    assert_eq!(asked[17], &todos);
    assert!(maintenance_select_at_4(asked[18]));
    assert!(
        matches!(asked[19], Ask::Maintenance { current, entry: Entry::First } if reaping_at_4(current))
    );
    assert!(push_select_at_20(asked[20]));
    assert!(matches!(asked[21], Ask::PushPolicy { current } if capped_at_20(current)));
    assert_eq!(asked[22], &allowing);
}

#[test]
fn the_plan_after_backing_out_carries_the_answers_given_last() {
    let run = run_backed_out_wizard();

    assert_eq!(run.code, OK, "{}", run.capture.stderr());
    let config_sql = config_migration_sql(run.dir.path());
    assert!(
        config_sql.contains("  'notes', 'pull-only', null, null, 'arrival', false, true, null, 1"),
        "{config_sql}"
    );
    assert!(
        config_sql
            .contains("  'todos', 'read-write', 'user_id', null, 'hlc', false, false, null, 3"),
        "{config_sql}"
    );
    assert!(config_sql.contains("  max_batch_size = 40"), "{config_sql}");
    assert!(
        config_sql.contains("reap_schedule = '0 5 * * *'"),
        "{config_sql}"
    );
    assert!(!config_sql.contains("0 4 * * *"), "{config_sql}");
    assert!(
        config_sql.contains("pg_cron is not enabled"),
        "the second pg_cron answer stops the install without it: {config_sql}"
    );
    assert_eq!(run.cli.pushes.borrow().len(), 1);
}

/// On recommended the confirmation's step before is the mode question, which
/// reopens on recommended; answering customize there walks the ladder that
/// recommended skipped.
#[test]
fn a_back_on_the_recommended_confirmation_reopens_the_mode_on_its_answer() {
    let dir = wizard_project();
    let todos_customized = TableProposal {
        tombstone_ttl_days: Some(9),
        ..todos_answer()
    };
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Back,
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(todos_customized),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(ProjectSettings::pack_defaults()),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(ProjectSettings::pack_defaults()),
        Answer::CronPolicy(true),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()),
        &RecordingCli::new(),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    let modes: Vec<&Ask> = prompter
        .asked()
        .iter()
        .filter(|ask| matches!(ask, Ask::Mode { .. }))
        .collect();
    assert_eq!(
        modes,
        [
            &Ask::Mode {
                current: WizardMode::Recommended
            },
            &Ask::Mode {
                current: WizardMode::Recommended
            },
        ]
    );
    assert_eq!(
        table_lists(&prompter).len(),
        1,
        "the table list is not asked again"
    );
    assert!(
        config_migration_sql(dir.path())
            .contains("  'todos', 'read-write', 'user_id', null, 'hlc', false, false, 9, 1")
    );
}

/// Backspace on the first table list reopens the connection question right
/// before it, the masked prompt, on the string entered there.
#[test]
fn a_back_on_the_table_list_reopens_the_connection_string_on_the_one_entered() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let second = "postgresql://second/db";
    let mut prompter = ScriptedPrompter::new(
        vec![
            Answer::Candidate(ConnectionCandidate::Manual),
            Answer::DbUrl(WIZARD_URL.to_owned()),
            Answer::Back,
            Answer::DbUrl(second.to_owned()),
        ]
        .into_iter()
        .chain(wizard_plan_answers())
        .collect(),
    );
    let (code, capture) = run_with_cli(
        dir.path(),
        &base_flags(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()),
        &cli,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(candidate_lists(&prompter), 1);
    assert_eq!(table_lists(&prompter).len(), 2);
    assert_eq!(
        prompter
            .asked()
            .iter()
            .filter_map(|ask| match ask {
                Ask::DbUrl { current } => Some(current.clone()),
                _ => None,
            })
            .collect::<Vec<_>>(),
        [None, Some(WIZARD_URL.to_owned())]
    );
    assert_eq!(
        cli.pushes.borrow().as_slice(),
        [PushTarget::DbUrl(second.to_owned())]
    );
}

// MARK: - identifiers the per-table flags name

/// The same gate `sync --add` passes: a bucket or soft-delete column that is
/// not a Postgres identifier is refused before anything is written.
#[test]
fn an_invalid_bucket_or_soft_delete_column_is_refused_before_anything_is_written() {
    for (flag, options) in [
        (
            "--bucket-column",
            crate::commands::sync::TableOptions {
                bucket_column: Some("user id; drop table todos;".to_owned()),
                ..Default::default()
            },
        ),
        (
            "--soft-delete",
            crate::commands::sync::TableOptions {
                soft_delete: Some("deleted at".to_owned()),
                ..Default::default()
            },
        ),
    ] {
        let dir = wizard_project();
        let (code, capture) = run_with_cli_at(
            dir.path(),
            &InitFlags {
                yes: true,
                local_only: true,
                options,
                ..base_flags()
            },
            None,
            &FakeSchemaSource::ok(wizard_catalog()),
            &UnreachableCli,
            REPORTED_NOW,
        );
        let stderr = capture.stderr();

        assert_eq!(code, UNUSABLE, "{flag}: {stderr}");
        assert!(stderr.contains(flag), "{stderr}");
        assert!(
            stderr.contains("is not a valid Postgres identifier."),
            "{stderr}"
        );
        assert!(!dir.path().join("supabase/migrations").exists(), "{flag}");
    }
}

// MARK: - a ledger a newer kizunasync wrote

/// The version a newer build writes into its `pack-file` rows.
const NEWER_PACK: &str = "99.0.0";

/// A ledger that records the shipped pack's own hash, written by a newer
/// build: only the version tells it apart from an up-to-date one.
fn newer_ledger() -> Vec<crate::provision::LedgerRow> {
    let pack = &init_pack_files()[0];

    vec![crate::provision::LedgerRow {
        object_kind: "pack-file".to_owned(),
        object_name: pack.name.clone(),
        content_hash: hash_pack_file(&pack.sql),
        pack_version: NEWER_PACK.to_owned(),
    }]
}

fn assert_refused_as_newer(code: i32, stderr: &str) {
    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains(&format!(
            "recorded by kizunasync {NEWER_PACK}, newer than this build"
        )),
        "{stderr}"
    );
    assert!(stderr.contains("update kizunasync"), "{stderr}");
}

/// A flag run reads the ledger before it writes or previews anything, and a
/// row a newer build wrote stops it with the refusal `upgrade` makes.
#[test]
fn a_flag_run_over_a_ledger_a_newer_build_wrote_refuses_before_writing() {
    for flags in [
        InitFlags {
            yes: true,
            ..flag_url()
        },
        InitFlags {
            dry_run: true,
            ..flag_url()
        },
    ] {
        let dir = wizard_project();
        let cli = RecordingCli::new();
        let (code, capture) = run_with_cli_at(
            dir.path(),
            &flags,
            None,
            &FakeSchemaSource::ok(wizard_catalog()).with_ledger(newer_ledger()),
            &cli,
            REPORTED_NOW,
        );

        assert_refused_as_newer(code, &capture.stderr());
        assert!(capture.stdout().is_empty(), "{}", capture.stdout());
        assert!(cli.pushes.borrow().is_empty());
        assert!(!dir.path().join("supabase/migrations").exists());
    }
}

/// The wizard stops once its connection is settled, before a table is offered.
#[test]
fn the_wizard_over_a_ledger_a_newer_build_wrote_refuses_before_any_table_is_offered() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let mut prompter = ScriptedPrompter::new(wizard_plan_answers());
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(wizard_catalog()).with_ledger(newer_ledger()),
        &cli,
    );

    assert_refused_as_newer(code, &capture.stderr());
    assert!(table_lists(&prompter).is_empty());
    assert!(cli.pushes.borrow().is_empty());
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// Over the Management API the ledger is read before anything is exposed or
/// applied, with or without a terminal.
#[test]
fn project_ref_a_ledger_a_newer_build_wrote_refuses_before_anything_is_applied() {
    let pack_files = init_pack_files();
    let hash = hash_pack_file(&pack_files[0].sql);
    for (flags, prompter) in [
        (remote_flags(true), None),
        (
            remote_flags(false),
            Some(ScriptedPrompter::new(wizard_plan_answers())),
        ),
    ] {
        let (result, capture, transport) = provision_remotely_with(
            &flags,
            FakeManagementTransport::new()
                .with_ledger_rows(&[("pack-file", pack_files[0].name.as_str(), hash.as_str())])
                .with_pack_version(NEWER_PACK),
            prompter,
            &pack_files,
        );

        assert_refused_as_newer(result.unwrap(), &capture.stderr());
        assert!(!transport.calls().contains(&"introspect".to_owned()));
        assert!(!transport.calls().contains(&"apply-config-sql".to_owned()));
        nothing_applied(&transport);
    }
}

// MARK: - after a remote re-apply

/// What every later stop says once the Management API re-apply ran.
const REAPPLIED_THEN_CANCELLED: &str =
    "  cancelled: the pack re-apply was applied, nothing else was written.";

/// A project whose ledger records a stale hash of the shipped pack, so the
/// remote run offers the re-apply first.
fn stale_remote() -> FakeManagementTransport {
    FakeManagementTransport::new().with_ledger_rows(&[(
        "pack-file",
        init_pack_files()[0].name.as_str(),
        "a-stale-hash",
    )])
}

/// A yes to the re-apply, then `answers` for the wizard that follows.
fn reapplied_then(answers: Vec<Answer>) -> ScriptedPrompter {
    ScriptedPrompter::new(
        std::iter::once(Answer::Confirm(true))
            .chain(answers)
            .collect(),
    )
}

#[test]
fn project_ref_a_stop_after_the_reapply_says_the_reapply_was_applied() {
    for (stop, answers, line) in [
        (
            "declined confirm",
            vec![
                Answer::Tables(vec!["todos".to_owned()]),
                Answer::Mode(WizardMode::Recommended),
                Answer::Confirm(false),
            ],
            REAPPLIED_THEN_CANCELLED,
        ),
        (
            "ctrl+c at the table list",
            vec![Answer::Cancel],
            REAPPLIED_THEN_CANCELLED,
        ),
        (
            "backspace on the table list",
            vec![Answer::Back],
            REAPPLIED_THEN_CANCELLED,
        ),
        (
            "no table selected",
            vec![Answer::Tables(Vec::new())],
            "  no tables selected: the pack re-apply was applied, nothing else was written.",
        ),
    ] {
        let (result, capture, transport) = provision_remotely_with(
            &remote_flags(false),
            stale_remote(),
            Some(reapplied_then(answers)),
            &init_pack_files(),
        );
        let stderr = capture.stderr();

        assert_eq!(result.unwrap(), OK, "{stop}: {stderr}");
        assert!(stderr.contains(line), "{stop}: {stderr}");
        assert!(!stderr.contains("nothing written"), "{stop}: {stderr}");
        assert!(
            transport.calls().contains(&"reconcile-pack".to_owned()),
            "{stop}"
        );
        assert!(
            !transport.calls().contains(&"apply-config-sql".to_owned()),
            "{stop}"
        );
    }
}

/// The re-apply is applied at once, so a schedule that does not land leaves
/// retention unscheduled: the run ends there on exit 1, as `upgrade` does.
#[test]
fn project_ref_a_schedule_that_fails_after_the_reapply_ends_the_run_on_exit_one() {
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(false),
        stale_remote().with_failing_schedules(),
        Some(reapplied_then(wizard_plan_answers())),
        &init_pack_files(),
    );
    let stderr = capture.stderr();

    assert_eq!(result.unwrap(), FAILURE, "{stderr}");
    assert!(
        stderr.contains("the upgrade is applied, but retention is not scheduled"),
        "{stderr}"
    );
    assert!(stderr.contains("--allow-no-cron"), "{stderr}");
    assert!(!transport.calls().contains(&"introspect".to_owned()));
}

/// `--allow-no-cron` accepts the unscheduled retention and the wizard goes on.
#[test]
fn project_ref_allow_no_cron_carries_a_failed_schedule_after_the_reapply_on_to_the_tables() {
    let (result, capture, transport) = provision_remotely_with(
        &InitFlags {
            allow_no_cron: true,
            ..remote_flags(false)
        },
        stale_remote().with_failing_schedules(),
        Some(reapplied_then(vec![
            Answer::Tables(vec!["todos".to_owned()]),
            Answer::Mode(WizardMode::Recommended),
            Answer::Confirm(false),
        ])),
        &init_pack_files(),
    );
    let stderr = capture.stderr();

    assert_eq!(result.unwrap(), OK, "{stderr}");
    assert!(
        stderr.contains("--allow-no-cron: retention is not scheduled"),
        "{stderr}"
    );
    assert!(transport.calls().contains(&"introspect".to_owned()));
}

// MARK: - the exposed-schema patch

/// The install is one transaction: a failure rolls it back, and the schema is
/// never exposed for a pack that is not there.
#[test]
fn project_ref_a_failed_install_sends_no_schema_exposure_patch() {
    let (result, _, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new().with_failing_install(),
        None,
        &init_pack_files(),
    );
    let Err(crate::error::Error::Provision(message)) = result else {
        panic!("a failed install is a provisioning failure");
    };

    assert!(message.contains("installing the pack failed"), "{message}");
    assert!(
        !transport
            .calls()
            .iter()
            .any(|call| call.starts_with("expose-schema")),
        "{:?}",
        transport.calls()
    );
    assert!(!transport.exposed_schemas().contains(&SCHEMA.to_owned()));
}

#[test]
fn project_ref_the_exposed_schema_patch_follows_the_committed_install() {
    let (result, _, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new(),
        None,
        &init_pack_files(),
    );

    assert_eq!(result.unwrap(), OK);
    let calls = transport.calls();
    let installed_at = calls
        .iter()
        .position(|call| call == "apply-pack-sql")
        .unwrap();
    let patch_at = calls
        .iter()
        .position(|call| call == "expose-schema kizunasync")
        .unwrap();
    assert!(patch_at > installed_at, "{calls:?}");
}

// MARK: - row level security, unscoped deletes, and the scan cap

/// [`wizard_catalog`], with `disabled` reported as tables whose row level
/// security is off.
fn catalog_with_rls_disabled(disabled: &[&str]) -> SchemaCatalog {
    SchemaCatalog {
        rls_disabled: disabled.iter().map(|table| (*table).to_owned()).collect(),
        ..wizard_catalog()
    }
}

#[test]
fn a_scripted_run_refuses_a_proposed_table_whose_row_level_security_is_disabled() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let (code, capture) = run_with_cli(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(catalog_with_rls_disabled(&["todos"])),
        &cli,
    );
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains("refusing to sync todos: row level security is disabled on it"),
        "{stderr}"
    );
    assert!(
        stderr.contains("alter table public.<table> enable row level security;"),
        "{stderr}"
    );
    assert!(stderr.contains("--allow-no-rls"), "{stderr}");
    assert!(cli.pushes.borrow().is_empty());
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// [`wizard_catalog`], with `todos` keyed the way the report the rule came
/// from was: a composite natural key, which the pack cannot sync by.
fn catalog_with_a_composite_todos_key() -> SchemaCatalog {
    let mut catalog = wizard_catalog();
    catalog.primary_keys.insert(
        "todos".to_owned(),
        crate::proposals::PrimaryKey::of("todos_pkey", &[("user_id", "uuid"), ("slug", "text")]),
    );

    catalog
}

#[test]
fn a_scripted_run_refuses_a_proposed_table_the_pack_cannot_key() {
    let dir = wizard_project();
    let cli = RecordingCli::new();
    let (code, capture) = run_with_cli(
        dir.path(),
        &InitFlags {
            yes: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(catalog_with_a_composite_todos_key()),
        &cli,
    );
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains("refusing to sync todos: the pack keys every change by a uuid primary key named id, and its primary key is (user_id uuid, slug text)."),
        "{stderr}"
    );
    assert!(
        stderr.contains("alter table public.\"todos\" add unique (\"user_id\", \"slug\");"),
        "{stderr}"
    );
    assert!(cli.pushes.borrow().is_empty());
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// The table list offers the table as unavailable and unchecked, with the
/// migration in a note above it, and the other tables still provision.
#[test]
fn the_wizard_lists_a_table_the_pack_cannot_key_as_unavailable() {
    let dir = wizard_project();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["notes".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(catalog_with_a_composite_todos_key()),
        &NoopCli,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    let offered = prompter
        .asked()
        .iter()
        .find_map(|ask| match ask {
            Ask::Tables { choices } => Some(choices.clone()),
            _ => None,
        })
        .unwrap();
    let todos = offered
        .iter()
        .find(|choice| choice.table == "todos")
        .unwrap();
    let notes = offered
        .iter()
        .find(|choice| choice.table == "notes")
        .unwrap();
    assert!(todos.unavailable && !todos.checked, "{todos:?}");
    assert!(!notes.unavailable && notes.checked, "{notes:?}");
    let (_, note) = prompter
        .notes()
        .iter()
        .find(|(title, _)| title == "Unavailable tables")
        .unwrap();
    assert!(note.starts_with("refusing to sync todos: "), "{note}");
    assert!(config_migration_sql(dir.path()).contains("'notes', 'pull-only'"));
}

#[test]
fn project_ref_refuses_a_proposed_table_the_pack_cannot_key() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new().with_todos_keyed_by(
            r#"[{"table_name":"todos","constraint_name":"todos_pkey","column_name":"id","data_type":"bigint"}]"#,
        ),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("refusing to sync todos: the pack keys every change by a uuid primary key named id, and its primary key is (id bigint)."),
        "{}",
        capture.stderr()
    );
    nothing_applied(&transport);
}

/// A dry run ends on the exit the real run would, before it prints the SQL.
#[test]
fn a_scripted_dry_run_ends_on_the_same_refusal() {
    let dir = wizard_project();
    let (code, capture) = run_with_schemas(
        dir.path(),
        &InitFlags {
            dry_run: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(catalog_with_rls_disabled(&["todos"])),
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(capture.stdout().is_empty(), "{}", capture.stdout());
}

#[test]
fn allow_no_rls_provisions_the_table_and_names_it_in_a_warning() {
    let dir = wizard_project();
    let (code, capture) = run_with_schemas(
        dir.path(),
        &InitFlags {
            yes: true,
            allow_no_rls: true,
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(catalog_with_rls_disabled(&["todos"])),
    );
    let stderr = capture.stderr();

    assert_eq!(code, OK, "{stderr}");
    assert!(
        stderr.contains("--allow-no-rls: syncing todos with row level security disabled"),
        "{stderr}"
    );
    assert!(config_migration_sql(dir.path()).contains("'todos', 'read-write', 'user_id'"));
}

#[test]
fn local_only_says_it_checks_no_row_level_security() {
    let dir = wizard_project();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("--local-only: skipping DB checks (no pg_policies read, no RLS check)."),
        "{}",
        capture.stderr()
    );
}

#[test]
fn the_wizard_refuses_a_chosen_table_whose_row_level_security_is_disabled() {
    let dir = wizard_project();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(catalog_with_rls_disabled(&["notes"])),
        &NoopCli,
    );
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains("refusing to sync notes: row level security is disabled on it"),
        "{stderr}"
    );
    assert!(
        !prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::Mode { .. })),
        "nothing is asked after the refusal"
    );
    assert!(!dir.path().join("supabase/migrations").exists());
}

/// A table the list leaves unchecked is not the run's business.
#[test]
fn the_wizard_provisions_the_other_tables_without_refusing() {
    let dir = wizard_project();
    let mut prompter = ScriptedPrompter::new(wizard_plan_answers());
    let (code, capture) = run_with_cli(
        dir.path(),
        &flag_url(),
        Some(&mut prompter),
        &FakeSchemaSource::ok(catalog_with_rls_disabled(&["notes"])),
        &NoopCli,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(!capture.stderr().contains("row level security"));
}

/// An unbucketed read-write table's tombstones reach every user who pulled
/// any of its rows, so the run points at the soft-delete column.
#[test]
fn a_read_write_table_without_a_bucket_or_a_soft_delete_column_is_warned_about() {
    let dir = wizard_project();
    let catalog = SchemaCatalog {
        tables: vec!["audit".to_owned()],
        policies: vec![PolicyRow {
            table: "audit".to_owned(),
            qual: "(true)".to_owned(),
        }],
        ..Default::default()
    }
    .keyed_by_uuid_id();
    let (code, capture) = run_with_schemas(
        dir.path(),
        &InitFlags {
            yes: true,
            options: crate::commands::sync::TableOptions {
                sync: Some(SyncMode::ReadWrite),
                ..crate::commands::sync::TableOptions::default()
            },
            ..flag_url()
        },
        None,
        &FakeSchemaSource::ok(catalog),
    );
    let stderr = capture.stderr();

    assert_eq!(code, OK, "{stderr}");
    assert!(
        stderr.contains(
            "audit is read-write with no bucket column and no soft-delete column: every user who pulls a row of it also receives the id of every row deleted from it"
        ),
        "{stderr}"
    );
}

#[test]
fn a_pull_scan_cap_below_one_is_refused_on_init() {
    let dir = wizard_project();
    let (code, capture) = run_in(
        dir.path(),
        &InitFlags {
            yes: true,
            local_only: true,
            settings: crate::commands::sync::SettingsOptions {
                max_pull_scan: Some(0),
                ..crate::commands::sync::SettingsOptions::default()
            },
            ..base_flags()
        },
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("--max-pull-scan 0 is out of range: at least 1 candidate."),
        "{}",
        capture.stderr()
    );
    assert!(!dir.path().join("supabase/migrations").exists());
}

#[test]
fn project_ref_refuses_a_proposed_table_whose_row_level_security_is_disabled() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(true),
        FakeManagementTransport::new().with_todos_rls_disabled(),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("refusing to sync todos: row level security is disabled on it"),
        "{}",
        capture.stderr()
    );
    nothing_applied(&transport);
}

#[test]
fn project_ref_with_allow_no_rls_applies_the_config() {
    let pack_files = init_pack_files();
    let (result, capture, transport) = provision_remotely_with(
        &InitFlags {
            allow_no_rls: true,
            ..remote_flags(true)
        },
        FakeManagementTransport::new().with_todos_rls_disabled(),
        None,
        &pack_files,
    );

    assert_eq!(result.unwrap(), OK, "{}", capture.stderr());
    let applied = transport.applied();
    assert_eq!(applied.len(), 1, "{:?}", transport.calls());
    assert!(applied[0].contains("  'todos', 'read-write', 'user_id'"));
    assert!(
        capture
            .stderr()
            .contains("--allow-no-rls: syncing todos with row level security disabled"),
        "{}",
        capture.stderr()
    );
}

#[test]
fn the_remote_wizard_refuses_a_chosen_table_whose_row_level_security_is_disabled() {
    let pack_files = init_pack_files();
    let mut answers = remote_wizard_answers();
    answers.push(Answer::Confirm(true));
    let (result, capture, transport) = provision_remotely_with(
        &remote_flags(false),
        FakeManagementTransport::new().with_todos_rls_disabled(),
        Some(ScriptedPrompter::new(answers)),
        &pack_files,
    );

    assert_eq!(result.unwrap(), UNUSABLE, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("refusing to sync todos: row level security is disabled on it"),
        "{}",
        capture.stderr()
    );
    nothing_applied(&transport);
}
