use std::cell::RefCell;
use std::path::{Path, PathBuf};

use crate::applier::fake::{FakeApplier, text_row};
use crate::catalog::SchemaSource;
use crate::commands::FAILURE;
use crate::commands::history_gate::fake::KIZUNASYNC_WROTE;
use crate::commands::init::{DirectConnection, STEP_BACK};
use crate::config::{KizunaSyncConfig, ProjectSettings};
use crate::constants::{INTERNAL_CONFIG, INTERNAL_SETTINGS};
use crate::discovery::ConnectionCandidate;
use crate::env::Env;
use crate::migration_history::AppliedMigration;
use crate::migration_history::fake::recorded;
use crate::project_ref::ProjectRef;
use crate::prompts::{
    Answer, Ask, Entry, Prompter, ScriptedPrompter, SectionChoice, ServerSection, WizardMode,
};
use crate::proposals::{
    Bucket, BucketAnswer, ConflictMode, PolicyRow, PrimaryKey, SchemaCatalog, SyncMode,
    TableProposal,
};
use crate::server_facts::ServerFacts;
use crate::supabase_cli::fake::{NoopCli, RecordingCli, UnreachableCli};
use crate::supabase_cli::{PushTarget, SupabaseCli};
use crate::ui::Capture;

use super::*;

const FIXED_NOW: i64 = 1_700_000_000;
const FAKE_DB_URL: &str = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// MARK: - fakes

/// The probe [`crate::provision::read_ledger_rows`] opens with.
const LEDGER_PRESENT: &str = "to_regclass('kizunasync._provisions')";

/// The synced set every fixture starts from, over a database whose ledger
/// table does not exist yet.
fn config_rows() -> FakeApplier {
    synced_set(FakeApplier::new().answer(LEDGER_PRESENT, vec![text_row(&[("present", "f")])]))
}

/// `applier`, also answering `kizunasync._config` with `todos` (read-write,
/// bucketed on `user_id`) and `notes` (pull-only).
fn synced_set(applier: FakeApplier) -> FakeApplier {
    applier.answer(
        INTERNAL_CONFIG,
        vec![
            text_row(&[
                ("table_name", "todos"),
                ("sync_mode", "read-write"),
                ("bucket_column", "user_id"),
                ("tombstone_ttl_days", "30"),
            ]),
            text_row(&[
                ("table_name", "notes"),
                ("sync_mode", "pull-only"),
                ("tombstone_ttl_days", "30"),
            ]),
        ],
    )
}

/// The DB surface this command needs: the synced set it already carries, plus
/// the catalog the checkbox proposes from. `todos` carries an owner-keyed RLS
/// policy, `notes` and `widgets` do not. `history` is what each read of the
/// migration history answers, in order, the last answer repeating.
struct FakeSchemas {
    probe_err: Option<String>,
    config: FakeApplier,
    history: RefCell<Vec<std::result::Result<Vec<AppliedMigration>, String>>>,
    ledger: Vec<crate::provision::LedgerRow>,
    rls_disabled: std::collections::BTreeSet<String>,
    /// Tables whose key is not the uuid `id` every other table carries, each
    /// with the key it has instead, if any.
    unkeyed: Vec<(String, Option<PrimaryKey>)>,
    /// What the database lacks once the delta applied: nothing, unless a
    /// test says so.
    gaps: Vec<String>,
}

impl FakeSchemas {
    fn ok() -> Self {
        Self {
            probe_err: None,
            config: config_rows(),
            history: RefCell::new(vec![Ok(Vec::new())]),
            ledger: Vec::new(),
            rls_disabled: std::collections::BTreeSet::new(),
            unkeyed: Vec::new(),
            gaps: Vec::new(),
        }
    }

    /// The same project, whose catalog keys `table` by `key` instead.
    fn with_key(mut self, table: &str, key: Option<PrimaryKey>) -> Self {
        self.unkeyed.push((table.to_owned(), key));

        self
    }

    /// The same project, whose catalog reports `tables` with row level
    /// security disabled.
    fn with_rls_disabled(self, tables: &[&str]) -> Self {
        Self {
            rls_disabled: tables.iter().map(|table| (*table).to_owned()).collect(),
            ..self
        }
    }

    /// The same project, whose provision ledger holds `ledger`.
    fn with_ledger(self, ledger: Vec<crate::provision::LedgerRow>) -> Self {
        Self { ledger, ..self }
    }

    fn probe_failing(reason: &str) -> Self {
        Self {
            probe_err: Some(reason.to_owned()),
            ..Self::ok()
        }
    }

    /// A project whose `kizunasync._config` cannot be read at all.
    fn config_failing(reason: &str) -> Self {
        Self {
            config: FakeApplier::new().fail(INTERNAL_CONFIG, reason),
            ..Self::ok()
        }
    }

    /// A project with the pack installed and nothing synced yet.
    fn nothing_synced() -> Self {
        Self {
            config: FakeApplier::new(),
            ..Self::ok()
        }
    }

    /// The same project, its migration history recording `entries`, each
    /// written as [`recorded`] reads it.
    fn with_history(self, entries: &[&str]) -> Self {
        self.with_history_reads(&[Ok(entries)])
    }

    /// The same project, whose migration history answers `reads` in order,
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

/// What every fake connection test answers.
fn test_facts() -> ServerFacts {
    ServerFacts {
        version: "17.4".to_owned(),
        database: "postgres".to_owned(),
        user: "postgres".to_owned(),
    }
}

impl SchemaSource for FakeSchemas {
    fn probe(&self, _url: &str) -> crate::error::Result<ServerFacts> {
        self.probe_err.as_ref().map_or_else(
            || Ok(test_facts()),
            |reason| Err(crate::error::Error::Db(reason.clone())),
        )
    }

    fn introspect(&self, _url: &str, _schema: &str) -> crate::error::Result<SchemaCatalog> {
        let mut catalog = SchemaCatalog {
            tables: vec!["todos".to_owned(), "notes".to_owned(), "widgets".to_owned()],
            policies: vec![PolicyRow {
                table: "todos".to_owned(),
                qual: "(auth.uid() = user_id)".to_owned(),
            }],
            rls_disabled: self.rls_disabled.clone(),
            ..Default::default()
        }
        .keyed_by_uuid_id();
        for (table, key) in &self.unkeyed {
            catalog.primary_keys.remove(table);
            if let Some(key) = key {
                catalog.primary_keys.insert(table.clone(), key.clone());
            }
        }

        Ok(catalog)
    }

    fn read_config(&self, _url: &str) -> crate::error::Result<KizunaSyncConfig> {
        crate::config::load_config_from_db(&self.config)
    }

    fn pg_cron_present(&self, _url: &str) -> crate::error::Result<bool> {
        Ok(true)
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
        Box::new(Lent(&self.config))
    }

    fn provisioning_gaps(
        &self,
        _url: &str,
        _expected: &crate::verify::Expectation,
    ) -> crate::error::Result<Vec<String>> {
        Ok(self.gaps.clone())
    }
}

/// The fake's own applier, lent to the pack gate so a test reads back what it
/// was sent.
struct Lent<'a>(&'a FakeApplier);

impl crate::applier::Applier for Lent<'_> {
    fn run_query(&self, sql: &str) -> crate::error::Result<Vec<crate::row::Row>> {
        self.0.run_query(sql)
    }
}

/// A `SchemaSource` that answers the connection test, the synced set, an
/// empty migration history, and a catalog that holds no table: a flag-driven
/// add reads the catalog only to check the keys of the tables it names, and
/// leaves one the catalog does not hold to the push.
struct EmptyCatalog {
    config: FakeApplier,
}

impl EmptyCatalog {
    fn new() -> Self {
        Self {
            config: config_rows(),
        }
    }
}

impl SchemaSource for EmptyCatalog {
    fn probe(&self, _url: &str) -> crate::error::Result<ServerFacts> {
        Ok(test_facts())
    }

    fn introspect(&self, _url: &str, _schema: &str) -> crate::error::Result<SchemaCatalog> {
        Ok(SchemaCatalog::default())
    }

    fn read_config(&self, _url: &str) -> crate::error::Result<KizunaSyncConfig> {
        crate::config::load_config_from_db(&self.config)
    }

    fn pg_cron_present(&self, _url: &str) -> crate::error::Result<bool> {
        Ok(true)
    }

    fn applied_migrations(&self, _url: &str) -> crate::error::Result<Vec<AppliedMigration>> {
        Ok(Vec::new())
    }

    fn ledger_rows(&self, _url: &str) -> crate::error::Result<Vec<crate::provision::LedgerRow>> {
        Ok(Vec::new())
    }

    fn pack_applier(&self, _url: &str) -> Box<dyn crate::applier::Applier + '_> {
        panic!("sync never re-applies the pack")
    }

    fn provisioning_gaps(
        &self,
        _url: &str,
        _expected: &crate::verify::Expectation,
    ) -> crate::error::Result<Vec<String>> {
        Ok(Vec::new())
    }
}

/// A linked connector no test here expects to reach: it answers with the
/// failure a missing token would produce.
fn no_linked(
    _project_ref: &ProjectRef,
    _token: Option<&str>,
) -> crate::error::Result<crate::login_role::LinkedConnection> {
    Err(crate::error::Error::Transport(
        "no Supabase access token".to_owned(),
    ))
}

// MARK: - fixtures

fn flags() -> SyncFlags {
    SyncFlags {
        schema: "public".to_owned(),
        ..SyncFlags::default()
    }
}

/// A scripted run's connection comes from the same ladder every other DB-backed
/// command uses, so a flag-driven test hands it over the process environment.
fn scripted_env() -> Env {
    Env::from_pairs(&[("KSYNC_DB_URL", FAKE_DB_URL)])
}

fn project() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn migrations_dir(dir: &Path) -> PathBuf {
    dir.join("supabase").join("migrations")
}

fn migrations(dir: &Path) -> Vec<String> {
    let path = migrations_dir(dir);
    if !path.exists() {
        return Vec::new();
    }

    let mut names: Vec<String> = std::fs::read_dir(path)
        .unwrap()
        .filter_map(|entry| {
            entry
                .ok()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
        })
        .collect();
    names.sort();

    names
}

fn migration_sql(dir: &Path) -> String {
    let names = migrations(dir);
    assert_eq!(
        names.len(),
        1,
        "expected exactly one migration, got {names:?}"
    );

    std::fs::read_to_string(migrations_dir(dir).join(&names[0])).unwrap()
}

fn is_sync_migration_name(name: &str) -> bool {
    let Some(prefix) = name.strip_suffix("_kizunasync_sync.sql") else {
        return false;
    };

    prefix.len() == 14 && prefix.bytes().all(|byte| byte.is_ascii_digit())
}

/// `STEP_BACK` rewinds a wizard step inside the process and must never become
/// the exit code: every `sync::run` in this file passes through here.
fn assert_no_step_back(code: i32) {
    assert_ne!(code, STEP_BACK, "sync::run leaked the step-back code");
}

fn run_in<'a>(
    dir: &Path,
    flags: &SyncFlags,
    schemas: &'a dyn SchemaSource,
    supabase: &'a dyn SupabaseCli,
    prompter: Option<&'a mut dyn Prompter>,
) -> (i32, Capture) {
    run_in_env(dir, flags, &scripted_env(), schemas, supabase, prompter)
}

fn run_in_env<'a>(
    dir: &Path,
    flags: &SyncFlags,
    env: &Env,
    schemas: &'a dyn SchemaSource,
    supabase: &'a dyn SupabaseCli,
    prompter: Option<&'a mut dyn Prompter>,
) -> (i32, Capture) {
    run_in_env_at(dir, flags, env, schemas, supabase, prompter, FIXED_NOW)
}

/// Like [`run_in_env`], with the migration named after `now_unix`.
fn run_in_env_at<'a>(
    dir: &Path,
    flags: &SyncFlags,
    env: &Env,
    schemas: &'a dyn SchemaSource,
    supabase: &'a dyn SupabaseCli,
    prompter: Option<&'a mut dyn Prompter>,
    now_unix: i64,
) -> (i32, Capture) {
    let (mut ui, capture) = Ui::capture();
    let mut ports = SyncPorts {
        prompter,
        schemas,
        supabase,
        now_unix,
        tokens: &crate::token::NoTokenStore,
        linked: &no_linked,
    };
    let code = run(
        flags,
        &ProjectPaths::rooted_at(dir.to_path_buf()),
        env,
        &EnvFileValues::default(),
        None,
        &mut ports,
        &mut ui,
    );
    assert_no_step_back(code);

    (code, capture)
}

// MARK: - the synced set comes from the database

#[test]
fn the_synced_set_is_read_from_the_config_table_and_reported() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            yes: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(capture.stderr().contains("2 in kizunasync._config"));
    assert!(capture.stderr().contains("todos is already synced"));
}

#[test]
fn an_unreadable_config_table_is_exit_two_and_names_the_local_stack() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            ..flags()
        },
        &FakeSchemas::config_failing("connection refused"),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("could not read kizunasync._config")
    );
    assert!(capture.stderr().contains("supabase start"));
    assert!(migrations(dir.path()).is_empty());
}

#[test]
fn a_database_that_cannot_be_resolved_at_all_is_exit_two() {
    let dir = project();
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            ..flags()
        },
        &Env::default(),
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("could not resolve a database connection")
    );
}

#[test]
fn a_project_with_nothing_synced_can_still_add_its_first_table() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &FakeSchemas::nothing_synced(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(capture.stderr().contains("0 in kizunasync._config"));
    assert!(migration_sql(dir.path()).contains("'todos', 'pull-only'"));
}

// MARK: - flag-driven adds and removes

#[test]
fn add_emits_the_delta_that_provisions_the_table() {
    let dir = project();
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    let names = migrations(dir.path());
    assert_eq!(names.len(), 1);
    assert!(is_sync_migration_name(&names[0]), "{names:?}");
    let sql = migration_sql(dir.path());
    assert!(sql.contains("'widgets', 'pull-only', null, null, 'arrival', false, false, null, 1"));
    assert!(sql.contains("create trigger kizunasync_track_change"));
    assert!(sql.contains("('config',  'public.widgets',"));
    assert!(sql.contains("begin;"));
    assert!(sql.contains("commit;"));
}

/// A delta written in the same second as a migration already on disk takes
/// the second after it, so `supabase db push` never meets two files with one
/// version.
#[test]
fn a_delta_written_in_the_same_second_as_another_migration_takes_the_next_one() {
    let dir = project();
    std::fs::create_dir_all(migrations_dir(dir.path())).unwrap();
    let taken = format!(
        "{}_kizunasync_config.sql",
        crate::clock::migration_version(FIXED_NOW)
    );
    std::fs::write(migrations_dir(dir.path()).join(&taken), "").unwrap();
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert_eq!(
        migrations(dir.path()),
        [taken, crate::commands::sync::migration_name(FIXED_NOW + 1)]
    );
}

/// The per-table flags are the wizard's questions, answered on the command
/// line: everything they set reaches the `kizunasync._config` upsert.
#[test]
fn the_per_table_flags_decide_the_contract_an_added_table_is_provisioned_with() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            options: TableOptions {
                sync: Some(SyncMode::ReadWrite),
                bucket_column: Some("workspace_id".to_owned()),
                soft_delete: Some("deleted_at".to_owned()),
                conflict: Some(ConflictMode::Hlc),
                conflict_journal: true,
                register_clients: Some(true),
                min_schema_version: Some(2),
                tombstone_ttl_days: Some(14),
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(migration_sql(dir.path()).contains(
        "'widgets', 'read-write', 'workspace_id', 'deleted_at', 'hlc', true, true, 14, 2"
    ));
    assert!(capture.stderr().contains("with per-table options"));
}

/// The retention an added table inherits is the project's own, not the
/// documented default, because a new table must match the ones beside it.
#[test]
fn an_added_table_with_no_retention_of_its_own_inherits_the_projects() {
    let dir = project();
    let schemas = FakeSchemas {
        config: FakeApplier::new().answer(
            INTERNAL_CONFIG,
            vec![text_row(&[
                ("table_name", "todos"),
                ("sync_mode", "read-write"),
                ("tombstone_ttl_days", "7"),
            ])],
        ),
        ..FakeSchemas::ok()
    };
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    // The server inherits: a null retention is what makes the project default
    // apply, rather than a copy of whatever the first table happened to carry.
    assert!(migration_sql(dir.path()).contains("'arrival', false, false, null, 1"));
}

#[test]
fn remove_emits_the_ledger_exact_unwind() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            remove: vec!["notes".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    let sql = migration_sql(dir.path());
    assert!(sql.contains("drop trigger if exists kizunasync_track_change on public.\"notes\";"));
    assert!(sql.contains("drop trigger if exists kizunasync_track_delete on public.\"notes\";"));
    assert!(sql.contains("delete from kizunasync._config where table_name = 'notes';"));
    assert!(sql.contains("('trigger', 'public.notes.kizunasync_track_delete')"));
    assert!(capture.stderr().contains("changelog and tombstone rows"));
}

#[test]
fn one_run_can_add_and_remove_at_once() {
    let dir = project();
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            remove: vec!["notes".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    let sql = migration_sql(dir.path());
    assert!(sql.contains("'widgets', 'pull-only'"));
    assert!(sql.contains("delete from kizunasync._config where table_name = 'notes';"));
}

#[test]
fn adding_an_already_synced_table_or_removing_a_non_synced_one_is_a_stated_no_op() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            remove: vec!["widgets".to_owned()],
            yes: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(
        capture
            .stderr()
            .contains("todos is already synced, nothing to add.")
    );
    assert!(capture.stderr().contains("widgets is not synced"));
    assert!(capture.stderr().contains("nothing to change."));
    assert!(!migrations_dir(dir.path()).exists());
}

/// `--add` on a table the project already syncs, with an option flag, is how a
/// scripted run changes a contract after the install: the `_config` row moves
/// and the triggers it already carries are left alone.
#[test]
fn adding_an_already_synced_table_with_an_option_flag_updates_its_config_row() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            options: TableOptions {
                sync: Some(SyncMode::PullOnly),
                register_clients: Some(true),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(
        capture
            .stderr()
            .contains("todos is already synced: updating the options this run named.")
    );
    assert!(
        capture
            .stderr()
            .contains("~ todos   updated: sync_mode = 'pull-only', register_clients = true")
    );
    let sql = migration_sql(dir.path());
    assert!(sql.contains("update kizunasync._config set"));
    assert!(sql.contains("  sync_mode = 'pull-only',"));
    assert!(sql.contains("  register_clients = true"));
    assert!(sql.contains("where table_name = 'todos';"));
    // Only the options: the row, both triggers and the ledger rows are already
    // provisioned.
    assert!(!sql.contains("insert into kizunasync._config"));
    assert!(!sql.contains("create trigger"));
    assert!(!sql.contains("drop trigger"));
    assert!(!sql.contains("kizunasync._provisions"));
    assert!(!sql.contains("bucket_column"));
}

/// The flags decide which half of `--add` a synced table takes, so a run that
/// names none of them stays a no-op and writes nothing.
#[test]
fn adding_an_already_synced_table_with_no_option_flag_stays_a_no_op() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(
        capture
            .stderr()
            .contains("todos is already synced, nothing to add.")
    );
    assert!(capture.stderr().contains("nothing to change."));
    assert!(!migrations_dir(dir.path()).exists());
}

#[test]
fn the_same_table_on_both_sides_is_a_contradiction() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            remove: vec!["todos".to_owned()],
            yes: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("both --add and --remove"));
}

/// A contradiction is refused before a database is even resolved: nothing
/// about the connection can make the request coherent.
#[test]
fn an_invalid_table_name_refuses_before_the_database_is_touched() {
    let dir = project();
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            add: vec!["drop table;".to_owned()],
            yes: true,
            ..flags()
        },
        &Env::default(),
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("invalid table name(s)"));
    assert!(!migrations_dir(dir.path()).exists());
}

/// `--bucket-column`/`--soft-delete` reach a generated SQL string literal and
/// (on the pack's own runtime side) a dynamic column lookup, so each must be
/// a valid identifier before a flag-driven add, which never introspects the
/// table to catch a bad one some other way, writes anything.
#[test]
fn an_invalid_bucket_column_refuses_before_the_database_is_touched() {
    let dir = project();
    let options = TableOptions {
        bucket_column: Some("user id; drop table todos;".to_owned()),
        ..TableOptions::default()
    };
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            yes: true,
            options,
            ..flags()
        },
        &Env::default(),
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("--bucket-column"));
    assert!(capture.stderr().contains("not a valid Postgres identifier"));
    assert!(!migrations_dir(dir.path()).exists());
}

/// The same gate covers `--soft-delete`.
#[test]
fn an_invalid_soft_delete_column_refuses_before_the_database_is_touched() {
    let dir = project();
    let options = TableOptions {
        soft_delete: Some("deleted at".to_owned()),
        ..TableOptions::default()
    };
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            yes: true,
            options,
            ..flags()
        },
        &Env::default(),
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("--soft-delete"));
    assert!(!migrations_dir(dir.path()).exists());
}

// MARK: - the global push policy

/// A run that names no settings flag leaves `kizunasync._settings` alone.
#[test]
fn a_run_that_names_no_settings_flag_does_not_touch_the_policy() {
    let dir = project();
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(!migration_sql(dir.path()).contains("kizunasync._settings"));
}

#[test]
fn a_changed_push_policy_is_emitted_in_the_delta_and_reported() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            settings: SettingsOptions {
                max_batch_size: Some(50),
                ..SettingsOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    let sql = migration_sql(dir.path());
    assert!(sql.contains("update kizunasync._settings set"));
    assert!(sql.contains("  max_batch_size = 50"));
    assert!(!sql.contains("require_atomic"));
    assert!(capture.stderr().contains("max 50 per push"));
}

/// A run that names a settings flag has work to do whatever the table set is,
/// so it does not need `--add` or a terminal to reach it. What it declares is
/// what it writes, even when the project already carries that value: the
/// migration is the declaration, not a diff.
#[test]
fn a_settings_only_run_writes_what_it_declared_without_a_table_flag() {
    let dir = project();
    let schemas = FakeSchemas {
        config: config_rows().answer(
            INTERNAL_SETTINGS,
            vec![text_row(&[
                ("max_batch_size", "50"),
                ("require_atomic", "t"),
            ])],
        ),
        ..FakeSchemas::ok()
    };
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            settings: SettingsOptions {
                max_batch_size: Some(50),
                ..SettingsOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    let sql = migration_sql(dir.path());
    assert!(sql.contains("  max_batch_size = 50"), "{sql}");
    assert!(!sql.contains("require_atomic"), "{sql}");
    assert!(!sql.contains("insert into kizunasync._config"));
    assert!(capture.stderr().contains("max 50 per push"));
}

/// One committed delta surface, byte for byte. A deliberate change is a
/// one-word fix: rerun with `KSYNC_BLESS_GOLDEN=1`.
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

/// The whole flag path in one delta: a table added with every per-table flag
/// answered, a table removed, and every project knob declared.
#[test]
fn the_flag_path_emits_the_committed_delta() {
    let dir = project();
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            remove: vec!["notes".to_owned()],
            options: TableOptions {
                sync: Some(SyncMode::ReadWrite),
                bucket_column: Some("workspace_id".to_owned()),
                soft_delete: Some("deleted_at".to_owned()),
                conflict: Some(ConflictMode::Hlc),
                conflict_journal: true,
                register_clients: Some(true),
                min_schema_version: Some(2),
                tombstone_ttl_days: Some(14),
            },
            settings: SettingsOptions {
                max_batch_size: Some(100),
                reap_schedule: Some("0 4 * * *".to_owned()),
                compact_schedule: Some("30 4 * * *".to_owned()),
                client_prune_schedule: Some("45 4 * * *".to_owned()),
                client_ttl_days: Some(30),
                hlc_max_skew_ms: Some(2000),
                max_pull_scan: Some(2500),
                ..SettingsOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert_golden_sql(&migration_sql(dir.path()), "sync-delta.sql");
}

/// The Management API path: the same delta, applied through the endpoint, with
/// no migration file and no connection-string ladder anywhere near it.
#[test]
fn a_project_ref_run_applies_the_delta_through_the_api_and_writes_no_migration() {
    let dir = project();
    let applied = FakeApplier::new()
        .answer(LEDGER_PRESENT, vec![text_row(&[("present", "t")])])
        .answer(
            "from kizunasync._provisions",
            vec![text_row(&[
                ("object_kind", "pack-file"),
                ("object_name", "0001_kizuna_init.sql"),
                ("content_hash", "recorded"),
                ("pack_version", crate::VERSION),
            ])],
        )
        .answer(
            INTERNAL_CONFIG,
            vec![
                text_row(&[("table_name", "todos"), ("sync_mode", "read-write")]),
                text_row(&[("table_name", "widgets"), ("sync_mode", "pull-only")]),
            ],
        );
    let api = config_rows().then("insert into kizunasync._config", applied);
    let (mut ui, capture) = Ui::capture();
    let mut ports = SyncPorts {
        prompter: None,
        schemas: &EmptyCatalog::new(),
        supabase: &UnreachableCli,
        now_unix: FIXED_NOW,
        tokens: &crate::token::NoTokenStore,
        linked: &no_linked,
    };
    let code = run(
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            project_ref: Some(ProjectRef::parse("abcdefghijklmnopqrst").unwrap()),
            yes: true,
            ..flags()
        },
        &ProjectPaths::rooted_at(dir.path().to_path_buf()),
        &Env::default(),
        &EnvFileValues::default(),
        Some(&api),
        &mut ports,
        &mut ui,
    );
    assert_no_step_back(code);
    let applied = api.executed.borrow().clone();

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(migrations(dir.path()).is_empty());
    assert!(
        applied
            .iter()
            .any(|sql| sql.contains("insert into kizunasync._config") && sql.contains("'widgets'")),
        "{applied:?}"
    );
    assert!(
        capture.stderr().contains("applied over the Management API"),
        "{}",
        capture.stderr()
    );
}

/// A push that applies nothing (a migration the history already recorded)
/// passes `supabase db push`; the run reads the database afterwards and
/// fails, naming what it does not hold, rather than reporting success.
#[test]
fn a_push_that_left_the_database_without_the_delta_fails_naming_what_is_missing() {
    let dir = project();
    let schemas = FakeSchemas {
        gaps: vec!["kizunasync._config has no row for widgets".to_owned()],
        ..FakeSchemas::ok()
    };
    let cli = RecordingCli::new();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            ..flags()
        },
        &schemas,
        &cli,
        None,
    );
    let stderr = capture.stderr();

    assert_eq!(code, FAILURE, "{stderr}");
    assert!(
        stderr.contains(
            "the migrations applied, but the database does not hold what they provision:\n    - kizunasync._config has no row for widgets"
        ),
        "{stderr}"
    );
    assert!(!stderr.contains("applied via supabase db push"), "{stderr}");
    assert_eq!(cli.pushes.borrow().len(), 1);
}

/// The pack addresses `public.<table>` everywhere, so a run naming another
/// schema is refused rather than provisioning the table somewhere the triggers
/// will never fire. There is no picker to offer an alternative.
#[test]
fn a_run_naming_a_schema_the_pack_does_not_support_is_refused() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            schema: "billing".to_owned(),
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
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
    assert!(migrations(dir.path()).is_empty());
}

/// A declared schedule brings the scheduler call with it, and nothing else in
/// `_settings` is named.
#[test]
fn a_declared_schedule_writes_only_that_column_and_reschedules_the_jobs() {
    let dir = project();
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            settings: SettingsOptions {
                reap_schedule: Some("0 4 * * *".to_owned()),
                client_ttl_days: Some(30),
                ..SettingsOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    let sql = migration_sql(dir.path());
    assert!(sql.contains("  reap_schedule = '0 4 * * *',"));
    assert!(sql.contains("  client_ttl_days = 30"));
    assert!(!sql.contains("max_batch_size"));
    assert!(!sql.contains("require_atomic"));
    assert!(sql.contains("select kizunasync._schedule_jobs();"));
}

#[test]
fn a_schedule_the_pack_would_refuse_is_refused_before_anything_is_written() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            settings: SettingsOptions {
                reap_schedule: Some("0 0 * * MON".to_owned()),
                ..SettingsOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("--reap-schedule \"0 0 * * MON\" is not a five-field UTC crontab"),
        "{}",
        capture.stderr()
    );
    assert!(migrations(dir.path()).is_empty());
}

/// The policy can be the whole change: no table added or removed, but the
/// migration still carries the upsert.
#[test]
fn a_policy_change_alone_is_enough_to_emit_a_migration() {
    let dir = project();
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            remove: vec!["nothing_synced_here".to_owned()],
            settings: SettingsOptions {
                max_batch_size: Some(10),
                require_atomic: false,
                ..SettingsOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    let sql = migration_sql(dir.path());
    assert!(sql.contains("  max_batch_size = 10"), "{sql}");
    assert!(!sql.contains("insert into kizunasync._config"));
}

/// A `_settings` row carrying `policy`, so a test can name what the project
/// already has.
fn live_policy(max_batch_size: Option<&str>, require_atomic: &str) -> FakeSchemas {
    let mut row = vec![("require_atomic", require_atomic)];
    if let Some(size) = max_batch_size {
        row.push(("max_batch_size", size));
    }

    FakeSchemas {
        config: config_rows().answer(INTERNAL_SETTINGS, vec![text_row(&row)]),
        ..FakeSchemas::ok()
    }
}

/// A project whose `kizunasync._settings` carries exactly the values the pack
/// seeds, which is what the wizard's steps open on.
fn live_pack_defaults() -> FakeSchemas {
    FakeSchemas {
        config: config_rows().answer(
            INTERNAL_SETTINGS,
            vec![text_row(&[
                ("max_batch_size", "500"),
                ("require_atomic", "f"),
                ("reap_schedule", "16 3 * * *"),
                ("compact_schedule", "47 3 * * *"),
                ("client_prune_schedule", "31 3 * * *"),
                ("client_ttl_days", "90"),
                ("hlc_max_skew_ms", "5000"),
                ("tombstone_ttl_days", "30"),
                ("max_pull_scan", "5000"),
            ])],
        ),
        ..FakeSchemas::ok()
    }
}

/// Customize walks the two server sections here too, and every step opens on
/// what the project already carries, so accepting them all writes nothing.
#[test]
fn the_wizard_writes_only_the_settings_the_user_changed() {
    let dir = project();
    let schemas = live_pack_defaults();
    let answered = TableProposal::derived("widgets", None, "[auto] no RLS policies found");
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec![
            "todos".to_owned(),
            "notes".to_owned(),
            "widgets".to_owned(),
        ]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(answered),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(ProjectSettings {
            reap_schedule: Some("0 5 * * *".to_owned()),
            ..ProjectSettings::pack_defaults()
        }),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(ProjectSettings::pack_defaults()),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    let sql = migration_sql(dir.path());
    assert!(sql.contains("  reap_schedule = '0 5 * * *'"), "{sql}");
    assert!(!sql.contains("compact_schedule"), "{sql}");
    assert!(!sql.contains("client_ttl_days"), "{sql}");
    assert!(!sql.contains("max_batch_size"), "{sql}");
    assert!(!sql.contains("require_atomic"), "{sql}");
    assert!(sql.contains("select kizunasync._schedule_jobs();"), "{sql}");
    assert!(
        !prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::CronPolicy { .. })),
        "the pg_cron policy is an install's question, not this one's"
    );
}

/// The same walk with nothing changed anywhere: no migration, and the run says
/// so rather than emitting an empty transaction.
#[test]
fn accepting_every_recommended_value_changes_nothing_at_all() {
    let dir = project();
    let schemas = live_pack_defaults();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert!(capture.stderr().contains("nothing to change"));
    assert!(migrations(dir.path()).is_empty());
}

/// The migration a settings-only run emits.
fn policy_sql(dir: &Path, flags: &SyncFlags, schemas: &FakeSchemas) -> (i32, String) {
    let (code, _) = run_in(dir, flags, schemas, &UnreachableCli, None);
    let sql = if migrations(dir).is_empty() {
        String::new()
    } else {
        migration_sql(dir)
    };

    (code, sql)
}

fn policy_flags(settings: SettingsOptions) -> SyncFlags {
    SyncFlags {
        add: vec!["widgets".to_owned()],
        settings,
        yes: true,
        local_only: true,
        ..flags()
    }
}

/// Naming the cap must not relax an atomic guard the project already has on.
#[test]
fn naming_the_cap_alone_keeps_the_live_atomic_guard() {
    let dir = project();
    let (code, sql) = policy_sql(
        dir.path(),
        &policy_flags(SettingsOptions {
            max_batch_size: Some(100),
            ..SettingsOptions::default()
        }),
        &live_policy(None, "t"),
    );

    assert_eq!(code, OK);
    assert!(sql.contains("  max_batch_size = 100"), "{sql}");
    // The column nobody named is not in the statement at all, which is what
    // keeps the guard where the project put it.
    assert!(!sql.contains("require_atomic"), "{sql}");
}

/// `--require-atomic` is refused: ordinary writes would dead-letter.
#[test]
fn require_atomic_is_refused() {
    let dir = project();
    let (code, sql) = policy_sql(
        dir.path(),
        &policy_flags(SettingsOptions {
            require_atomic: true,
            ..SettingsOptions::default()
        }),
        &live_policy(Some("50"), "f"),
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        sql.is_empty() || !sql.contains("require_atomic = true"),
        "{sql}"
    );
}

#[test]
fn no_require_atomic_is_how_a_run_says_permissive_on_purpose() {
    let dir = project();
    let (code, sql) = policy_sql(
        dir.path(),
        &policy_flags(SettingsOptions {
            no_require_atomic: true,
            ..SettingsOptions::default()
        }),
        &live_policy(Some("50"), "t"),
    );

    assert_eq!(code, OK);
    assert!(sql.contains("  require_atomic = false"), "{sql}");
    assert!(!sql.contains("max_batch_size"), "{sql}");
}

#[test]
fn no_max_batch_size_clears_the_cap_and_leaves_the_guard() {
    let dir = project();
    let (code, sql) = policy_sql(
        dir.path(),
        &policy_flags(SettingsOptions {
            no_max_batch_size: true,
            ..SettingsOptions::default()
        }),
        &live_policy(Some("50"), "t"),
    );

    assert_eq!(code, OK);
    assert!(sql.contains("  max_batch_size = null"), "{sql}");
    assert!(!sql.contains("require_atomic"), "{sql}");
}

/// A declaration is not a diff: a negative that names what the project already
/// has still writes that column, which is what makes the migration a record of
/// what the run asked for.
#[test]
fn a_negative_flag_declares_the_column_even_when_it_already_matches() {
    let dir = project();
    let (code, sql) = policy_sql(
        dir.path(),
        &policy_flags(SettingsOptions {
            no_require_atomic: true,
            ..SettingsOptions::default()
        }),
        &live_policy(Some("50"), "f"),
    );

    assert_eq!(code, OK);
    assert!(sql.contains("  require_atomic = false"), "{sql}");
}

// MARK: - numbers the server would refuse

#[test]
fn a_batch_size_below_one_is_refused_before_anything_is_written() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &policy_flags(SettingsOptions {
            max_batch_size: Some(0),
            ..SettingsOptions::default()
        }),
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    // The bound, plus this command's own way to ask for unlimited.
    assert!(
        capture.stderr().contains(
            "--max-batch-size 0 is out of range: at least 1 mutation per push. Use --no-max-batch-size for unlimited."
        ),
        "{}",
        capture.stderr()
    );
    assert!(migrations(dir.path()).is_empty());
}

#[test]
fn a_retention_below_a_day_is_refused_before_anything_is_written() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            options: TableOptions {
                tombstone_ttl_days: Some(0),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("--tombstone-ttl-days 0 is out of range: at least 1 day")
    );
    assert!(migrations(dir.path()).is_empty());
}

// MARK: - the gates

#[test]
fn dry_run_prints_the_plan_and_the_sql_but_writes_nothing() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            dry_run: true,
            yes: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(capture.stdout().contains("'widgets', 'pull-only'"));
    assert!(capture.stderr().contains("nothing was written"));
    assert!(!migrations_dir(dir.path()).exists());
}

/// A dry run makes the history comparison the real run makes before it
/// writes, with nobody to ask: drift is reported with the commands that settle
/// it and the real run's exit, and nothing is repaired or written.
#[test]
fn a_dry_run_compares_the_migration_history_and_reports_drift_with_the_real_runs_exit() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            dry_run: true,
            yes: true,
            ..flags()
        },
        &FakeSchemas::ok().with_history(&[REMOTE_ONLY]),
        &UnreachableCli,
        None,
    );
    let stderr = capture.stderr();

    assert_no_step_back(code);
    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(capture.stdout().contains("'widgets', 'pull-only'"));
    assert!(
        stderr.contains(&format!(
            "records 1 version(s) with no file in supabase/migrations:\n    - {REMOTE_ONLY}"
        )),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "supabase migration repair --status reverted {REMOTE_ONLY}"
        )),
        "{stderr}"
    );
    assert!(
        stderr.contains("--dry-run: nothing was written."),
        "{stderr}"
    );
    assert!(!migrations_dir(dir.path()).exists());
}

#[test]
fn a_dry_run_over_a_matching_history_says_so_and_exits_zero() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            dry_run: true,
            yes: true,
            ..flags()
        },
        &FakeSchemas::ok(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("migration history: matches (0 applied)"),
        "{}",
        capture.stderr()
    );
    assert!(!migrations_dir(dir.path()).exists());
}

/// `--local-only` never pushes, so its dry run has no history to compare.
#[test]
fn a_local_only_dry_run_reads_no_migration_history() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            dry_run: true,
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok().with_history_reads(&[Err(HISTORY_UNREAD)]),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(!capture.stderr().contains("migration history"));
}

#[test]
fn no_yes_and_no_tty_refuses_to_write() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("refusing to write without confirmation")
    );
    assert!(!migrations_dir(dir.path()).exists());
}

#[test]
fn declining_the_interactive_confirm_writes_nothing() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert!(capture.stderr().contains(CANCELLED));
    assert!(migrations(dir.path()).is_empty());
}

#[test]
fn neither_flag_nor_a_tty_prints_the_usage_and_exits() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &flags(),
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("--add <table>"));
}

#[test]
fn local_only_writes_the_migration_and_never_pushes() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(capture.stderr().contains("NOT applied"));
    assert_eq!(migrations(dir.path()).len(), 1);
}

#[test]
fn without_local_only_it_applies_through_the_injected_push_port() {
    let dir = project();
    let cli = RecordingCli::new();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &cli,
        None,
    );

    assert_eq!(code, OK);
    assert_eq!(
        cli.pushes.borrow().as_slice(),
        [PushTarget::DbUrl(FAKE_DB_URL.to_owned())]
    );
    assert!(
        capture
            .stderr()
            .contains("applied via supabase db push --db-url")
    );
    assert!(capture.stderr().contains("kizunasync status"));
}

// MARK: - the connection picker
//
// The interactive session offers what this machine has, direct candidates
// only, since this command introspects a live schema and emits a migration.

/// The answers the wizard needs after the connection is settled.
fn wizard_tail() -> Vec<Answer> {
    vec![
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Confirm(true),
    ]
}

#[test]
fn an_empty_ladder_offers_the_picker_instead_of_a_bare_prompt() {
    let dir = project();
    let schemas = FakeSchemas::ok();
    let mut answers = vec![Answer::DbUrl(FAKE_DB_URL.to_owned())];
    answers.extend(wizard_tail());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &Env::default(),
        &schemas,
        &NoopCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    // Nothing is discoverable here: an `.env` URL or a local config.toml
    // would have satisfied the ladder above and never reached the picker,
    // so the list is manual entry alone, which resolves without a question.
    assert_eq!(
        prompter.asked().first(),
        Some(&Ask::Phase {
            title: crate::discovery::CONNECTION_PHASE.title.to_owned(),
            docs: crate::discovery::CONNECTION_PHASE.url.to_owned(),
        })
    );
    assert_eq!(
        prompter.asked().get(1),
        Some(&Ask::Candidate {
            candidates: vec![ConnectionCandidate::Manual],
            current: None,
        })
    );
    assert_eq!(prompter.asked().get(2), Some(&Ask::DbUrl { current: None }));
    assert!(capture.stderr().contains("(entered)"));
}

/// Like [`run_in`], but with the project's own `.env` files loaded. An empty
/// [`EnvFileValues`] declares nothing, so this is the only way to reach the
/// picker's `.env` candidate.
fn run_with_env_files<'a>(
    dir: &Path,
    flags: &SyncFlags,
    schemas: &'a dyn SchemaSource,
    prompter: Option<&'a mut dyn Prompter>,
) -> (i32, Capture) {
    run_with_linked(
        dir,
        flags,
        schemas,
        prompter,
        &crate::token::NoTokenStore,
        &no_linked,
    )
}

/// Like [`run_with_env_files`], with the credential store and the linked
/// connector the linked-project candidate reaches.
fn run_with_linked<'a>(
    dir: &Path,
    flags: &SyncFlags,
    schemas: &'a dyn SchemaSource,
    prompter: Option<&'a mut dyn Prompter>,
    tokens: &'a dyn crate::token::TokenStore,
    linked: &'a LinkedConnector<'a>,
) -> (i32, Capture) {
    let (mut ui, capture) = Ui::capture();
    let mut ports = SyncPorts {
        prompter,
        schemas,
        supabase: &NoopCli,
        now_unix: FIXED_NOW,
        tokens,
        linked,
    };
    let code = run(
        flags,
        &ProjectPaths::rooted_at(dir.to_path_buf()),
        &Env::default(),
        &crate::env_file::load(dir),
        None,
        &mut ports,
        &mut ui,
    );
    assert_no_step_back(code);

    (code, capture)
}

/// A `.env` URL and the password that must never reach any output.
const ENV_FILE_PASSWORD: &str = "s3cr3t";

fn write_env_file(dir: &Path) -> ConnectionCandidate {
    std::fs::write(
        dir.join(".env"),
        format!(
            "DATABASE_URL=postgresql://postgres:{ENV_FILE_PASSWORD}@db.example:5432/postgres\n"
        ),
    )
    .unwrap();

    ConnectionCandidate::EnvUrl {
        key: "DATABASE_URL",
        file: ".env",
        redacted_url: "postgresql://postgres:***@db.example:5432/postgres".to_owned(),
    }
}

/// The flag and the process environment are the user telling us where to
/// go, so they still decide without a question, the same line `init` draws.
#[test]
fn the_process_environment_still_decides_without_a_picker() {
    let dir = project();
    let schemas = FakeSchemas::ok();
    let mut prompter = ScriptedPrompter::new(wizard_tail());
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &scripted_env(),
        &schemas,
        &NoopCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert!(
        !prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::Candidate { .. })),
        "an explicit connection must not be put to a vote: {:?}",
        prompter.asked()
    );
    assert!(capture.stderr().contains("env:KSYNC_DB_URL"));
}

fn candidate_lists(prompter: &ScriptedPrompter) -> usize {
    prompter
        .asked()
        .iter()
        .filter(|ask| matches!(ask, Ask::Candidate { .. }))
        .count()
}

/// Backspace at the masked entry erases it and offers the list again; the
/// second pick resolves and the run carries on.
#[test]
fn backspace_at_the_masked_entry_offers_the_list_again() {
    let dir = project();
    let schemas = FakeSchemas::ok();
    let mut answers = vec![Answer::Back, Answer::DbUrl(FAKE_DB_URL.to_owned())];
    answers.extend(wizard_tail());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &Env::default(),
        &schemas,
        &NoopCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(candidate_lists(&prompter), 2, "{:?}", prompter.asked());
    assert!(
        prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::Tables { .. })),
        "the run carries on to the tables: {:?}",
        prompter.asked()
    );
    assert!(capture.stderr().contains("(entered)"));
}

/// Backspace at the `.env` confirm does the same: the list comes back and
/// the candidate picked the second time is confirmed and used.
#[test]
fn backspace_at_the_env_file_confirm_offers_the_list_again() {
    let dir = project();
    let candidate = write_env_file(dir.path());
    let schemas = FakeSchemas::ok();
    let mut answers = vec![
        Answer::Candidate(candidate.clone()),
        Answer::Back,
        Answer::Candidate(candidate),
        Answer::Confirm(true),
    ];
    answers.extend(wizard_tail());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_with_env_files(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &schemas,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(candidate_lists(&prompter), 2, "{:?}", prompter.asked());
    assert!(
        prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::Tables { .. })),
        "the run carries on to the tables: {:?}",
        prompter.asked()
    );
    assert!(capture.stderr().contains("DATABASE_URL from .env"));
}

/// A checkbox answer that unchecks `notes`, then the write confirmation, so
/// the run writes a delta and every answer is used.
fn removing_notes() -> Vec<Answer> {
    vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Confirm(true),
    ]
}

/// The connection-step questions a run asked, in order, named by kind.
fn connection_steps(prompter: &ScriptedPrompter) -> Vec<&'static str> {
    prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Phase { title, .. } if title == crate::discovery::CONNECTION_PHASE.title => {
                Some("connection phase")
            }
            Ask::Candidate { .. } => Some("picker"),
            Ask::Confirm { message, .. } if message.starts_with("Use DATABASE_URL") => {
                Some("env confirm")
            }
            Ask::DbUrl { .. } => Some("connection string"),
            Ask::Tables { .. } => Some("tables"),
            _ => None,
        })
        .collect()
}

/// Backspace on the picker returns to the solution question before it, whose
/// connection phase then opens the picker again.
#[test]
fn backspace_on_the_picker_returns_to_the_solution_question() {
    let dir = project();
    let candidate = write_env_file(dir.path());
    let mut answers = vec![
        Answer::Back,
        Answer::Candidate(candidate),
        Answer::Confirm(true),
    ];
    answers.extend(removing_notes());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_with_env_files(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok(),
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        connection_steps(&prompter),
        [
            "connection phase",
            "picker",
            "connection phase",
            "picker",
            "env confirm",
            "tables"
        ]
    );
}

/// Backspace on the checkbox reopens the connection question right before
/// it, the `.env` confirm, and the run carries on from the same database.
#[test]
fn backspace_on_the_checkbox_reopens_the_env_file_confirm() {
    let dir = project();
    let candidate = write_env_file(dir.path());
    let mut answers = vec![
        Answer::Candidate(candidate),
        Answer::Confirm(true),
        Answer::Back,
        Answer::Confirm(true),
    ];
    answers.extend(removing_notes());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_with_env_files(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok(),
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        connection_steps(&prompter),
        [
            "connection phase",
            "picker",
            "env confirm",
            "tables",
            "env confirm",
            "tables"
        ]
    );
    assert!(capture.stderr().contains("DATABASE_URL from .env"));
}

/// A typed connection string comes back on the one entered: an empty answer
/// keeps it, and the run carries on.
#[test]
fn backspace_on_the_checkbox_reopens_the_connection_string_on_the_one_entered() {
    let dir = project();
    let mut answers = vec![
        Answer::DbUrl(FAKE_DB_URL.to_owned()),
        Answer::Back,
        Answer::DbUrl(String::new()),
    ];
    answers.extend(removing_notes());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &Env::default(),
        &FakeSchemas::ok(),
        &NoopCli,
        Some(&mut prompter),
    );
    let openings: Vec<Option<String>> = prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::DbUrl { current } => Some(current.clone()),
            _ => None,
        })
        .collect();

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(openings, [None, Some(FAKE_DB_URL.to_owned())]);
    assert!(
        migrations(dir.path())
            .iter()
            .any(|name| is_sync_migration_name(name))
    );
}

/// With nothing discovered the list is manual entry alone and draws no
/// picker, so the question before the connection string is the solution
/// question: Backspace on the empty field reopens it, and its connection
/// phase asks for the string again.
#[test]
fn backspace_on_the_connection_string_with_no_picker_reopens_the_solution_question() {
    let dir = project();
    let mut answers = vec![Answer::Back, Answer::DbUrl(FAKE_DB_URL.to_owned())];
    answers.extend(removing_notes());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &Env::default(),
        &FakeSchemas::ok(),
        &NoopCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        connection_steps(&prompter),
        [
            "connection phase",
            "picker",
            "connection string",
            "connection phase",
            "picker",
            "connection string",
            "tables"
        ]
    );
}

/// The connection string the checkbox reopens has the same question before
/// it: Backspace on its empty field reopens the solution question, and the
/// string typed first is still the one an empty answer keeps.
#[test]
fn backspace_on_the_reopened_connection_string_with_no_picker_reopens_the_solution_question() {
    let dir = project();
    let mut answers = vec![
        Answer::DbUrl(FAKE_DB_URL.to_owned()),
        Answer::Back,
        Answer::Back,
        Answer::DbUrl(String::new()),
    ];
    answers.extend(removing_notes());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &Env::default(),
        &FakeSchemas::ok(),
        &NoopCli,
        Some(&mut prompter),
    );
    let openings: Vec<Option<String>> = prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::DbUrl { current } => Some(current.clone()),
            _ => None,
        })
        .collect();

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        connection_steps(&prompter),
        [
            "connection phase",
            "picker",
            "connection string",
            "tables",
            "connection string",
            "connection phase",
            "picker",
            "connection string",
            "tables"
        ]
    );
    assert_eq!(
        openings,
        [
            None,
            Some(FAKE_DB_URL.to_owned()),
            Some(FAKE_DB_URL.to_owned())
        ]
    );
}

/// A URL this command FOUND is confirmed, never taken silently: the
/// originating request, and what `init` already does.
#[test]
fn an_env_file_url_is_offered_as_a_candidate_and_confirmed() {
    let dir = project();
    let candidate = write_env_file(dir.path());
    let schemas = FakeSchemas::ok();
    let mut answers = vec![Answer::Candidate(candidate.clone()), Answer::Confirm(true)];
    answers.extend(wizard_tail());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_with_env_files(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &schemas,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert_eq!(
        prompter.asked().first(),
        Some(&Ask::Phase {
            title: crate::discovery::CONNECTION_PHASE.title.to_owned(),
            docs: crate::discovery::CONNECTION_PHASE.url.to_owned(),
        })
    );
    assert_eq!(
        prompter.asked().get(1),
        Some(&Ask::Candidate {
            candidates: vec![candidate, ConnectionCandidate::Manual],
            current: None,
        }),
        "the account and the linked project are never offered here"
    );
    assert!(matches!(
        prompter.asked().get(2),
        Some(Ask::Confirm { message, default: true }) if message.contains("Use DATABASE_URL from .env?")
    ));
    assert!(!capture.stdout().contains(ENV_FILE_PASSWORD));
    assert!(!capture.stderr().contains(ENV_FILE_PASSWORD));
    assert!(capture.stderr().contains("postgres:***@db.example"));
}

const LINKED_REF: &str = "abcdefghijklmnopqrst";
const LINKED_PAT: &str = "sbp_0123456789abcdef0123456789abcdef01234567";
const MINTED_PASSWORD: &str = "m1nt3d";

/// A credential store holding [`LINKED_PAT`] under every account.
struct HoldingStore;

impl crate::token::TokenStore for HoldingStore {
    fn read(&self, _account: &str) -> Option<String> {
        Some(LINKED_PAT.to_owned())
    }
}

fn write_linked_ref(dir: &Path) -> ConnectionCandidate {
    let temp = dir.join("supabase").join(".temp");
    std::fs::create_dir_all(&temp).unwrap();
    std::fs::write(temp.join("project-ref"), LINKED_REF).unwrap();

    ConnectionCandidate::LinkedProject {
        project_ref: ProjectRef::parse(LINKED_REF).unwrap(),
        origin: crate::discovery::ProjectRefOrigin::LinkFile,
    }
}

/// The linked project is a direct candidate: picking it opens the temporary
/// login with the token the ladder found, and the run introspects over it.
#[test]
fn the_linked_project_is_offered_and_reached_over_a_temporary_login() {
    let dir = project();
    let linked_candidate = write_linked_ref(dir.path());
    let env_candidate = write_env_file(dir.path());
    let schemas = FakeSchemas::ok();
    let asked = std::cell::RefCell::new(Vec::new());
    let linked = |project_ref: &ProjectRef, token: Option<&str>| {
        asked
            .borrow_mut()
            .push((project_ref.to_string(), token.map(ToOwned::to_owned)));

        Ok(crate::login_role::LinkedConnection {
            url: format!(
                "postgresql://cli_login_postgres:{MINTED_PASSWORD}@db.{project_ref}.supabase.co:5432/postgres?sslmode=require"
            ),
            route: crate::login_role::LinkedRoute::Direct,
            minted: true,
        })
    };
    let mut answers = vec![Answer::Candidate(linked_candidate.clone())];
    answers.extend(wizard_tail());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_with_linked(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &schemas,
        Some(&mut prompter),
        &HoldingStore,
        &linked,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(
        prompter.asked().get(1),
        Some(&Ask::Candidate {
            candidates: vec![linked_candidate, env_candidate, ConnectionCandidate::Manual],
            current: None,
        })
    );
    assert_eq!(
        asked.borrow().as_slice(),
        [(LINKED_REF.to_owned(), Some(LINKED_PAT.to_owned()))]
    );
    assert!(capture.stderr().contains(&format!(
        "postgresql://cli_login_postgres:***@db.{LINKED_REF}.supabase.co:5432/postgres?sslmode=require (linked project {LINKED_REF}, direct host)"
    )));
    assert!(!capture.stderr().contains(MINTED_PASSWORD));
    assert!(!capture.stderr().contains(LINKED_PAT));
}

/// A login that cannot be opened says why in one line, then the picker comes
/// back without the linked project.
#[test]
fn a_failed_linked_login_names_the_reason_and_reopens_the_picker_without_it() {
    let dir = project();
    let linked_candidate = write_linked_ref(dir.path());
    let env_candidate = write_env_file(dir.path());
    let schemas = FakeSchemas::ok();
    let linked = |_: &ProjectRef, _: Option<&str>| {
        Err(crate::error::Error::Transport(
            "could not open a temporary database login (HTTP 403)".to_owned(),
        ))
    };
    let mut answers = vec![
        Answer::Candidate(linked_candidate.clone()),
        Answer::Candidate(env_candidate.clone()),
        Answer::Confirm(true),
    ];
    answers.extend(wizard_tail());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_with_linked(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &schemas,
        Some(&mut prompter),
        &HoldingStore,
        &linked,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(capture.stderr().contains(&format!(
        "linked project {LINKED_REF}: could not open a temporary database login (HTTP 403); choose another connection"
    )));
    let lists: Vec<&Vec<ConnectionCandidate>> = prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Candidate { candidates, .. } => Some(candidates),
            _ => None,
        })
        .collect();
    assert_eq!(lists.len(), 2);
    assert!(lists[0].contains(&linked_candidate));
    assert_eq!(*lists[1], vec![env_candidate, ConnectionCandidate::Manual]);
}

/// Every run reads `kizunasync._config`, so an empty entry ends the run: this
/// command has no path that skips the database.
#[test]
fn an_empty_entry_keeps_this_commands_own_abort_message() {
    let dir = project();
    let schemas = FakeSchemas::ok();
    let mut prompter = ScriptedPrompter::new(vec![Answer::DbUrl(String::new())]);
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &Env::default(),
        &schemas,
        &NoopCli,
        Some(&mut prompter),
    );

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("cannot read the synced tables"));
}

/// The other half of the ruling: a local stack is something this command
/// FOUND, so it is offered rather than taken. The listener makes the stack
/// genuinely reachable, an unreachable one is filtered out as a connection
/// already known to fail.
#[test]
fn a_local_stack_is_offered_instead_of_resolved_silently() {
    let dir = project();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::fs::create_dir_all(dir.path().join("supabase")).unwrap();
    std::fs::write(
        dir.path().join("supabase").join("config.toml"),
        format!("[db]\nport = {port}\n"),
    )
    .unwrap();
    let candidate = ConnectionCandidate::Local {
        port,
        reachable: true,
    };
    let schemas = FakeSchemas::ok();
    let mut answers = vec![Answer::Candidate(candidate.clone())];
    answers.extend(wizard_tail());
    let mut prompter = ScriptedPrompter::new(answers);
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &Env::default(),
        &schemas,
        &NoopCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert_eq!(
        prompter.asked().get(1),
        Some(&Ask::Candidate {
            candidates: vec![candidate, ConnectionCandidate::Manual],
            current: None,
        })
    );
    assert!(capture.stderr().contains("local-config"));
}

#[test]
fn declining_the_offered_connection_cancels_cleanly_and_writes_nothing() {
    let dir = project();
    let candidate = write_env_file(dir.path());
    let schemas = FakeSchemas::ok();
    let mut prompter =
        ScriptedPrompter::new(vec![Answer::Candidate(candidate), Answer::Confirm(false)]);
    let (code, capture) = run_with_env_files(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &schemas,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert!(capture.stderr().contains("cancelled"));
    assert!(migrations(dir.path()).is_empty());
}

// MARK: - the interactive checkbox surface

#[test]
fn the_checkbox_pre_checks_the_synced_set_and_its_result_drives_one_add_and_one_remove() {
    let dir = project();
    let schemas = FakeSchemas::ok();
    let mut prompter = ScriptedPrompter::new(vec![
        // keep todos, drop notes, add widgets.
        Answer::Tables(vec!["todos".to_owned(), "widgets".to_owned()]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert!(prompter.asked().iter().any(|ask| matches!(
        ask,
        Ask::Phase { title, docs }
            if title == crate::docs::TABLES_PHASE.title && docs == crate::docs::TABLES_PHASE.url
    )));

    let Some(Ask::Tables { choices }) = prompter
        .asked()
        .iter()
        .find(|ask| matches!(ask, Ask::Tables { .. }))
    else {
        panic!(
            "expected the tables question in the wizard: {:?}",
            prompter.asked()
        );
    };
    assert_eq!(
        choices
            .iter()
            .map(|choice| (choice.table.as_str(), choice.checked))
            .collect::<Vec<_>>(),
        [("notes", true), ("todos", true), ("widgets", false)]
    );

    let sql = migration_sql(dir.path());
    assert!(sql.contains("'widgets', 'pull-only'"));
    assert!(sql.contains("delete from kizunasync._config where table_name = 'notes';"));
}

/// A flag the user typed decides the same field the wizard asks about, so an
/// interactive run must honour it rather than drop it. Here four of the five
/// are given, so the ladder still runs and the answer it returns wins.
#[test]
fn the_per_table_flags_reach_the_interactive_adds() {
    let dir = project();
    let schemas = FakeSchemas::ok();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec![
            "todos".to_owned(),
            "notes".to_owned(),
            "widgets".to_owned(),
        ]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            options: TableOptions {
                sync: Some(SyncMode::ReadWrite),
                conflict: Some(ConflictMode::Hlc),
                soft_delete: Some("deleted_at".to_owned()),
                conflict_journal: true,
                tombstone_ttl_days: Some(14),
                bucket_column: None,
                register_clients: None,
                min_schema_version: None,
            },
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert!(
        migration_sql(dir.path())
            .contains("'widgets', 'read-write', null, 'deleted_at', 'hlc', true, false, 14, 1")
    );
    assert!(
        capture
            .stderr()
            .contains("per-table flags applied to 1 added table")
    );
    // Every flag the run named is accounted for on that line, none silently dropped.
    assert!(capture.stderr().contains("--sync read-write"));
    assert!(capture.stderr().contains("--soft-delete deleted_at"));
    assert!(capture.stderr().contains("--conflict hlc"));
    assert!(capture.stderr().contains("--conflict-journal"));
    assert!(capture.stderr().contains("--tombstone-ttl-days 14"));
    // Five of six leaves something to ask, so the ladder still ran.
    assert!(
        prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::Mode { .. }))
    );
}

/// The precedence, both halves in one run: the flag pre-fills the question, and
/// the answer the wizard comes back with is what gets provisioned. Moving
/// `options.apply` after the ladder would overwrite the answer with the flag
/// and fail this test.
#[test]
fn an_interactive_answer_wins_over_the_flag_that_pre_filled_it() {
    let dir = project();
    let schemas = FakeSchemas::ok();
    let answered = TableProposal {
        bucket: BucketAnswer::Answered(Bucket::ByColumn("workspace_id".to_owned())),
        ..TableProposal::derived("widgets", None, "[auto] no RLS policies found")
    };
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec![
            "todos".to_owned(),
            "notes".to_owned(),
            "widgets".to_owned(),
        ]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(answered),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(ProjectSettings::pack_defaults()),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(ProjectSettings::pack_defaults()),
        Answer::Confirm(true),
    ]);
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            options: TableOptions {
                bucket_column: Some("owner_id".to_owned()),
                ..TableOptions::default()
            },
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    let sql = migration_sql(dir.path());
    assert!(
        sql.contains(
            "'widgets', 'pull-only', 'workspace_id', null, 'arrival', false, false, null, 1"
        ),
        "the wizard's column must be the provisioned one: {sql}"
    );
    assert!(
        !sql.contains("owner_id"),
        "the flag only pre-fills the question, it does not survive the answer: {sql}"
    );
}

/// All five answered leaves the wizard nothing to ask about an added table, so
/// the ladder is skipped and the run says which flags decided it.
#[test]
fn five_flags_skip_the_per_table_ladder_entirely() {
    let dir = project();
    let schemas = FakeSchemas::ok();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec![
            "todos".to_owned(),
            "notes".to_owned(),
            "widgets".to_owned(),
        ]),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            options: TableOptions {
                sync: Some(SyncMode::ReadWrite),
                bucket_column: Some("workspace_id".to_owned()),
                soft_delete: Some("deleted_at".to_owned()),
                conflict: Some(ConflictMode::Hlc),
                conflict_journal: true,
                register_clients: Some(true),
                min_schema_version: Some(2),
                tombstone_ttl_days: Some(14),
            },
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert!(migration_sql(dir.path()).contains(
        "'widgets', 'read-write', 'workspace_id', 'deleted_at', 'hlc', true, true, 14, 2"
    ));
    assert!(
        !prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::Mode { .. } | Ask::Customize { .. })),
        "nothing is left to ask: {:?}",
        prompter.asked()
    );
    assert!(capture.stderr().contains("--bucket-column workspace_id"));
}

#[test]
fn an_unchecked_nothing_interactive_run_changes_nothing() {
    let dir = project();
    let schemas = FakeSchemas::ok();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Tables(vec![
        "todos".to_owned(),
        "notes".to_owned(),
    ])]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK);
    assert!(capture.stderr().contains("nothing to change."));
    assert!(!migrations_dir(dir.path()).exists());
}

#[test]
fn a_failed_probe_stops_before_any_write() {
    let dir = project();
    let schemas = FakeSchemas::probe_failing("connection refused");
    let mut prompter = ScriptedPrompter::new(Vec::new());
    let (code, _) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, UNUSABLE);
    assert!(!migrations_dir(dir.path()).exists());
}

// MARK: - push target, migration history, connection test

const REMOTE_ONLY: &str = "20260925201900";

/// [`REMOTE_ONLY`] as the history records it after another tool wrote it.
const USER_WROTE: &str = "20260925201900_create_widgets";

/// [`FAKE_DB_URL`] as a printed command names it: its password travels
/// through `PGPASSWORD`.
const PRINTED_DB_URL: &str = "postgresql://postgres@127.0.0.1:54322/postgres";

#[test]
fn a_settled_linked_connection_pushes_with_linked() {
    let dir = project();
    let cli = RecordingCli::new();
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            connection: Some(DirectConnection {
                url: FAKE_DB_URL.to_owned(),
                push: PushTarget::Linked,
            }),
            ..flags()
        },
        &Env::default(),
        &EmptyCatalog::new(),
        &cli,
        None,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(cli.pushes.borrow().as_slice(), [PushTarget::Linked]);
    assert!(
        capture
            .stderr()
            .contains("applied via supabase db push --linked. Run `kizunasync status` to verify.")
    );
}

#[test]
fn the_history_gate_runs_before_the_write_confirm() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            ..flags()
        },
        &FakeSchemas::ok().with_history(&[KIZUNASYNC_WROTE]),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    let confirms: Vec<&str> = prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Confirm { message, .. } => Some(message.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        confirms,
        ["Mark them reverted in the history now (supabase migration repair --status reverted …)?"],
        "the write confirm is never reached"
    );
    assert!(migrations(dir.path()).is_empty());
}

#[test]
fn a_failed_connection_test_on_the_scripted_path_exits_two() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            ..flags()
        },
        &FakeSchemas::probe_failing("connection refused"),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE);
    assert!(
        capture
            .stderr()
            .contains("could not connect to the database:\n    connection refused")
    );
    assert!(migrations(dir.path()).is_empty());
}

#[test]
fn the_scripted_path_reports_the_connection_test() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &NoopCli,
        None,
    );

    assert_eq!(code, OK);
    assert!(
        capture
            .stderr()
            .contains("  connected:        PostgreSQL 17.4, database postgres as postgres")
    );
    assert!(
        capture
            .stderr()
            .contains("migration history: matches (0 applied)")
    );
}

// MARK: - an unreadable history and a refused push

const PUSH_REFUSED: &str = "Remote migration versions not found in local migrations directory.";
const HISTORY_UNREAD: &str = "permission denied for schema supabase_migrations";
const CONTINUE_UNREAD: &str = "Continue without checking the migration history?";
const REPAIR_QUESTION: &str =
    "Mark them reverted in the history now (supabase migration repair --status reverted …)?";

/// A fixed clock that sits after [`REMOTE_ONLY`], so the migration the drift
/// scenario writes is newer than the remote-only version it records.
const REPORTED_NOW: i64 = 1_790_424_000;

fn push_failing(stderr: &str) -> crate::supabase_cli::CliResult {
    crate::supabase_cli::CliResult {
        ok: false,
        stderr: stderr.to_owned(),
    }
}

fn push_ok() -> crate::supabase_cli::CliResult {
    crate::supabase_cli::CliResult {
        ok: true,
        stderr: String::new(),
    }
}

fn confirm_messages(prompter: &ScriptedPrompter) -> Vec<String> {
    prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Confirm { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// `--add widgets` with the write asked in the terminal.
fn interactive_add() -> SyncFlags {
    SyncFlags {
        add: vec!["widgets".to_owned()],
        ..flags()
    }
}

/// [`run_in`] on the reported run's clock.
fn run_reported<'a>(
    dir: &Path,
    flags: &SyncFlags,
    schemas: &'a dyn SchemaSource,
    supabase: &'a dyn SupabaseCli,
    prompter: Option<&'a mut dyn Prompter>,
) -> (i32, Capture) {
    run_in_env_at(
        dir,
        flags,
        &scripted_env(),
        schemas,
        supabase,
        prompter,
        REPORTED_NOW,
    )
}

#[test]
fn an_unreadable_history_stops_a_scripted_sync_before_anything_is_written() {
    let dir = project();
    let (code, capture) = run_reported(
        dir.path(),
        &SyncFlags {
            yes: true,
            ..interactive_add()
        },
        &FakeSchemas::ok().with_history_reads(&[Err(HISTORY_UNREAD)]),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(capture.stderr().contains(HISTORY_UNREAD));
    assert!(migrations(dir.path()).is_empty());
}

#[test]
fn an_unreadable_history_in_a_terminal_continues_only_on_an_explicit_yes() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
    let (code, capture) = run_reported(
        dir.path(),
        &interactive_add(),
        &FakeSchemas::ok().with_history_reads(&[Err(HISTORY_UNREAD)]),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(confirm_messages(&prompter), [CONTINUE_UNREAD]);
    assert!(matches!(
        prompter.asked().last(),
        Some(Ask::Confirm { default: false, .. })
    ));
    assert!(migrations(dir.path()).is_empty());
}

#[test]
fn a_refused_sync_push_offers_the_repair_then_pushes_again() {
    let dir = project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED), push_ok()]);
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true), Answer::Confirm(true)]);
    let (code, capture) = run_reported(
        dir.path(),
        &interactive_add(),
        &FakeSchemas::ok().with_history_reads(&[Ok(&[]), Ok(&[KIZUNASYNC_WROTE])]),
        &cli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(
        cli.repairs.borrow().as_slice(),
        [(
            PushTarget::DbUrl(FAKE_DB_URL.to_owned()),
            vec![REMOTE_ONLY.to_owned()]
        )]
    );
    assert_eq!(cli.pushes.borrow().len(), 2);
    let confirms = confirm_messages(&prompter);
    assert_eq!(confirms.len(), 2, "{confirms:?}");
    assert_eq!(
        confirms[1], REPAIR_QUESTION,
        "the repair replaces the Retry"
    );
}

#[test]
fn a_refused_sync_push_over_an_unreadable_history_stops_without_a_retry() {
    let dir = project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED)]);
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
    let (code, capture) = run_reported(
        dir.path(),
        &interactive_add(),
        &FakeSchemas::ok().with_history_reads(&[Ok(&[]), Err(HISTORY_UNREAD)]),
        &cli,
        Some(&mut prompter),
    );

    assert_eq!(code, FAILURE, "{}", capture.stderr());
    assert_eq!(cli.pushes.borrow().len(), 1);
    assert_eq!(prompter.unused(), 0);
    assert!(!confirm_messages(&prompter).contains(&"Retry?".to_owned()));
    let written = migrations(dir.path());
    assert_eq!(written.len(), 1);
    let stderr = capture.stderr();
    assert!(
        stderr.contains(&format!(
            "supabase db push failed, and some of the files this run wrote may have been applied: {}. Check with `supabase migration list --db-url {PRINTED_DB_URL}`",
            written[0]
        )),
        "{stderr}"
    );
    assert!(stderr.contains(HISTORY_UNREAD), "{stderr}");
    assert!(!stderr.contains("IS written"), "{stderr}");
    assert!(!stderr.contains("nothing was applied"), "{stderr}");
}

#[test]
fn a_refused_sync_push_over_a_version_another_tool_wrote_stops_without_asking() {
    let dir = project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED)]);
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
    let (code, capture) = run_reported(
        dir.path(),
        &interactive_add(),
        &FakeSchemas::ok().with_history_reads(&[Ok(&[]), Ok(&[USER_WROTE])]),
        &cli,
        Some(&mut prompter),
    );
    let stderr = capture.stderr();

    assert_eq!(code, FAILURE, "{stderr}");
    assert!(cli.repairs.borrow().is_empty());
    assert_eq!(cli.pushes.borrow().len(), 1);
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        confirm_messages(&prompter).len(),
        1,
        "only the write is asked"
    );
    let written = migrations(dir.path());
    assert!(
        stderr.contains(&format!("    not applied: {}", written[0])),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "    supabase migration repair --status reverted {REMOTE_ONLY} --db-url {PRINTED_DB_URL}\n"
        )),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "`supabase migration list --db-url {PRINTED_DB_URL}`"
        )),
        "{stderr}"
    );
}

/// `--yes` never prompts, even on a terminal: an unreadable history stops the
/// run with nothing written.
#[test]
fn sync_yes_on_a_terminal_never_asks_past_an_unreadable_history() {
    let dir = project();
    let mut prompter = ScriptedPrompter::default();
    let (code, capture) = run_reported(
        dir.path(),
        &SyncFlags {
            yes: true,
            ..interactive_add()
        },
        &FakeSchemas::ok().with_history_reads(&[Err(HISTORY_UNREAD)]),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    assert!(capture.stderr().contains(HISTORY_UNREAD));
    assert!(migrations(dir.path()).is_empty());
}

/// The same after a refused push: the history read again and the commands
/// that settle it, no repair question, no Retry, and a failing exit.
#[test]
fn sync_yes_on_a_terminal_never_asks_after_a_refused_push() {
    let dir = project();
    let cli = RecordingCli::pushing(vec![push_failing(PUSH_REFUSED)]);
    let mut prompter = ScriptedPrompter::default();
    let (code, capture) = run_reported(
        dir.path(),
        &SyncFlags {
            yes: true,
            ..interactive_add()
        },
        &FakeSchemas::ok().with_history_reads(&[Ok(&[]), Ok(&[KIZUNASYNC_WROTE])]),
        &cli,
        Some(&mut prompter),
    );
    let stderr = capture.stderr();

    assert_eq!(code, FAILURE, "{stderr}");
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    assert!(cli.repairs.borrow().is_empty());
    assert_eq!(cli.pushes.borrow().len(), 1);
    let written = migrations(dir.path());
    assert!(
        stderr.contains(&format!("    not applied: {}", written[0])),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "run `supabase migration repair --status reverted {REMOTE_ONLY} --db-url {PRINTED_DB_URL}` or `supabase db pull`, then run `supabase db push --db-url {PRINTED_DB_URL}`."
        )),
        "{stderr}"
    );
}

#[test]
fn a_failed_sync_push_over_a_clean_history_offers_a_retry() {
    let dir = project();
    let cli = RecordingCli::pushing(vec![push_failing("connection reset by peer"), push_ok()]);
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true), Answer::Confirm(true)]);
    let (code, capture) = run_reported(
        dir.path(),
        &interactive_add(),
        &FakeSchemas::ok(),
        &cli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(cli.pushes.borrow().len(), 2);
    assert_eq!(
        confirm_messages(&prompter).last().map(String::as_str),
        Some("Retry?")
    );
}

// MARK: - back navigation through the wizard

/// The checkbox as the scripted prompter was shown it: each table with its
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

/// The customized `widgets`, carrying the key the fake catalog reads for it:
/// the walk keeps the catalog's key on every answer it stores.
fn widgets_by_workspace() -> TableProposal {
    TableProposal {
        bucket: BucketAnswer::Answered(Bucket::ByColumn("workspace_id".to_owned())),
        key: Some(PrimaryKey::of("widgets_pkey", &[("id", "uuid")])),
        ..TableProposal::derived("widgets", None, "[auto] no RLS policies found")
    }
}

fn reaping_at(schedule: &str) -> ProjectSettings {
    ProjectSettings {
        reap_schedule: Some(schedule.to_owned()),
        ..ProjectSettings::pack_defaults()
    }
}

/// A sync wizard that adds `widgets` on customize, backs out of every step
/// from the push policy down to the checkbox (the custom maintenance values,
/// then their select, then the table), then answers again with `notes`
/// unchecked and every step given a new answer.
fn run_backed_out_sync(dir: &Path) -> (i32, Capture, ScriptedPrompter) {
    let schemas = live_pack_defaults();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec![
            "todos".to_owned(),
            "notes".to_owned(),
            "widgets".to_owned(),
        ]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(widgets_by_workspace()),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(reaping_at("0 4 * * *")),
        // The push policy, then every step before it, back to the checkbox.
        Answer::Back,
        Answer::Back,
        Answer::Back,
        Answer::Back,
        Answer::Back,
        Answer::Tables(vec!["todos".to_owned(), "widgets".to_owned()]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(TableProposal {
            min_schema_version: Some(4),
            ..widgets_by_workspace()
        }),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(reaping_at("0 6 * * *")),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(ProjectSettings {
            max_batch_size: Some(crate::config::MaxBatchSize::Mutations(60)),
            ..ProjectSettings::default()
        }),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir,
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    (code, capture, prompter)
}

#[test]
fn a_back_at_every_sync_step_reopens_the_one_before_on_its_last_answer() {
    let dir = project();
    let (code, capture, prompter) = run_backed_out_sync(dir.path());

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        table_lists(&prompter),
        [
            vec![
                ("notes".to_owned(), true),
                ("todos".to_owned(), true),
                ("widgets".to_owned(), false),
            ],
            vec![
                ("notes".to_owned(), true),
                ("todos".to_owned(), true),
                ("widgets".to_owned(), true),
            ],
        ],
        "the checkbox reopens as it was answered, not as the project is synced"
    );
    let steps: Vec<&Ask> = prompter
        .asked()
        .iter()
        .filter(|ask| {
            matches!(
                ask,
                Ask::Mode { .. }
                    | Ask::Customize { .. }
                    | Ask::Section { .. }
                    | Ask::Maintenance { .. }
                    | Ask::PushPolicy { .. }
            )
        })
        .collect();
    let reaping_at_4 =
        |current: &ProjectSettings| current.reap_schedule.as_deref() == Some("0 4 * * *");
    let widgets = Ask::Customize {
        current: widgets_by_workspace(),
        entry: Entry::First,
    };
    let customize = Ask::Mode {
        current: WizardMode::Customize,
    };

    assert!(matches!(
        steps[4],
        Ask::Section {
            section: ServerSection::PushPolicy,
            ..
        }
    ));
    assert!(
        matches!(steps[5], Ask::Maintenance { current, entry: Entry::Last } if reaping_at_4(current))
    );
    assert!(
        matches!(steps[6], Ask::Section { section: ServerSection::Maintenance, current, choice: SectionChoice::Custom } if reaping_at_4(current))
    );
    assert_eq!(
        steps[7],
        &Ask::Customize {
            current: widgets_by_workspace(),
            entry: Entry::Last,
        }
    );
    assert_eq!(steps[8], &customize);
    assert_eq!(steps[9], &customize);
    assert_eq!(steps[10], &widgets);
    assert!(
        matches!(steps[11], Ask::Section { section: ServerSection::Maintenance, current, .. } if reaping_at_4(current))
    );
    assert!(
        matches!(steps[12], Ask::Maintenance { current, entry: Entry::First } if reaping_at_4(current))
    );
    assert!(
        !prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::CronPolicy { .. })),
        "the pg_cron policy is an install's question, not this one's"
    );
}

#[test]
fn the_sync_plan_after_backing_out_carries_the_answers_given_last() {
    let dir = project();
    let (code, capture, _) = run_backed_out_sync(dir.path());

    assert_eq!(code, OK, "{}", capture.stderr());
    let sql = migration_sql(dir.path());
    assert!(
        sql.contains(
            "'widgets', 'pull-only', 'workspace_id', null, 'arrival', false, false, null, 4"
        ),
        "{sql}"
    );
    assert!(
        sql.contains("delete from kizunasync._config where table_name = 'notes';"),
        "{sql}"
    );
    assert!(sql.contains("  reap_schedule = '0 6 * * *'"), "{sql}");
    assert!(sql.contains("  max_batch_size = 60"), "{sql}");
    assert!(!sql.contains("0 4 * * *"), "{sql}");
}

fn push_capped_at(size: i64) -> ProjectSettings {
    ProjectSettings {
        max_batch_size: Some(crate::config::MaxBatchSize::Mutations(size)),
        ..ProjectSettings::default()
    }
}

/// The confirms a run asked, by message.
fn write_confirms(prompter: &ScriptedPrompter) -> usize {
    confirm_messages(prompter)
        .iter()
        .filter(|message| message.starts_with("Write "))
        .count()
}

/// The write confirmation is a step of the wizard: Backspace on it reopens
/// the custom push value on its answer, every earlier answer kept, and the
/// written migration carries the answers given last.
#[test]
fn a_back_on_the_sync_write_confirm_reopens_the_push_policy_on_its_answer() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec![
            "todos".to_owned(),
            "notes".to_owned(),
            "widgets".to_owned(),
        ]),
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(widgets_by_workspace()),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(reaping_at("0 4 * * *")),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(push_capped_at(30)),
        Answer::Back,
        Answer::PushPolicy(push_capped_at(60)),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &live_pack_defaults(),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(write_confirms(&prompter), 2);
    let push_values: Vec<&ProjectSettings> = prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::PushPolicy { current } => Some(current),
            _ => None,
        })
        .collect();
    assert_eq!(push_values.len(), 2, "{:?}", prompter.asked());
    assert_eq!(
        push_values[1].max_batch_size,
        Some(crate::config::MaxBatchSize::Mutations(30)),
        "the push value reopens on the answer it gave"
    );
    assert_eq!(table_lists(&prompter).len(), 1);
    let sql = migration_sql(dir.path());
    assert!(sql.contains("  max_batch_size = 60"), "{sql}");
    assert!(sql.contains("  reap_schedule = '0 4 * * *'"), "{sql}");
    assert!(
        sql.contains("'widgets', 'pull-only', 'workspace_id'"),
        "{sql}"
    );
}

#[test]
fn a_back_on_the_recommended_sync_write_confirm_reopens_the_mode_on_its_answer() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec![
            "todos".to_owned(),
            "notes".to_owned(),
            "widgets".to_owned(),
        ]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Back,
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok(),
        &UnreachableCli,
        Some(&mut prompter),
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
    assert_eq!(table_lists(&prompter).len(), 1);
    assert!(migration_sql(dir.path()).contains("'widgets', 'pull-only'"));
}

/// A run that only removes a table asks nothing between the checkbox and the
/// write, so Backspace on the write reopens the checkbox as it was answered.
#[test]
fn a_back_on_the_write_confirm_after_the_checkbox_alone_reopens_the_checkbox() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Back,
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok(),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        table_lists(&prompter),
        [
            vec![
                ("notes".to_owned(), true),
                ("todos".to_owned(), true),
                ("widgets".to_owned(), false),
            ],
            vec![
                ("notes".to_owned(), false),
                ("todos".to_owned(), true),
                ("widgets".to_owned(), false),
            ],
        ],
        "the checkbox reopens as it was answered"
    );
    assert!(
        migration_sql(dir.path())
            .contains("delete from kizunasync._config where table_name = 'notes';")
    );
}

/// A flag-driven run has no step before its write confirmation, so
/// Backspace there declines: nothing written, a clean exit.
#[test]
fn a_back_on_a_flag_driven_sync_write_confirm_declines() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Back]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(capture.stderr().contains(CANCELLED));
    assert!(migrations(dir.path()).is_empty());
}

/// A connection the flag decided asks no question before the checkbox, so
/// Backspace there reopens the checkbox and the run goes on.
#[test]
fn a_back_on_the_sync_checkbox_with_no_connection_question_reopens_it() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Back,
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok(),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        prompter
            .asked()
            .iter()
            .filter(|ask| matches!(ask, Ask::Tables { .. }))
            .count(),
        2
    );
    assert!(!capture.stderr().contains(CANCELLED));
    assert!(capture.stderr().contains("nothing to change."));
    assert!(!migrations_dir(dir.path()).exists());
}

// MARK: - Ctrl+C

/// A cancelled `sync` run: exit `0`, nothing written, and one cancel outro.
fn assert_cancelled(code: i32, prompter: &ScriptedPrompter, capture: &Capture, dir: &Path) {
    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(prompter.cancel_outros(), ["Nothing written."]);
    assert!(migrations(dir).is_empty());
}

#[test]
fn ctrl_c_on_the_sync_picker_closes_the_wizard_with_its_cancel_outro() {
    let dir = project();
    write_env_file(dir.path());
    let mut prompter = ScriptedPrompter::new(vec![Answer::Cancel]);
    let (code, capture) = run_with_env_files(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok(),
        Some(&mut prompter),
    );

    assert_cancelled(code, &prompter, &capture, dir.path());
}

#[test]
fn ctrl_c_on_the_sync_checkbox_closes_the_wizard_with_its_cancel_outro() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Cancel]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok(),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_cancelled(code, &prompter, &capture, dir.path());
}

#[test]
fn ctrl_c_on_the_sync_write_confirm_closes_the_wizard_with_its_cancel_outro() {
    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Cancel,
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok(),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_cancelled(code, &prompter, &capture, dir.path());
}

// MARK: - a ledger a newer kizunasync wrote

/// The version a newer build writes into its `pack-file` rows.
const NEWER_PACK: &str = "99.0.0";

fn newer_ledger() -> Vec<crate::provision::LedgerRow> {
    vec![crate::provision::LedgerRow {
        object_kind: "pack-file".to_owned(),
        object_name: "0001_kizuna_init.sql".to_owned(),
        content_hash: "recorded".to_owned(),
        pack_version: NEWER_PACK.to_owned(),
    }]
}

fn assert_refused_as_newer(code: i32, capture: &Capture) {
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains(&format!(
            "recorded by kizunasync {NEWER_PACK}, newer than this build"
        )),
        "{stderr}"
    );
    assert!(stderr.contains("update kizunasync"), "{stderr}");
    assert!(capture.stdout().is_empty(), "{}", capture.stdout());
}

/// The ledger is read once the database is resolved: a row a newer build
/// wrote stops every run before a delta is rendered, a dry run included.
#[test]
fn a_ledger_a_newer_build_wrote_refuses_the_sync_before_anything_is_written() {
    for flags in [
        SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            ..flags()
        },
        SyncFlags {
            add: vec!["widgets".to_owned()],
            dry_run: true,
            ..flags()
        },
        SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
    ] {
        let dir = project();
        let cli = RecordingCli::new();
        let (code, capture) = run_in(
            dir.path(),
            &flags,
            &FakeSchemas::ok().with_ledger(newer_ledger()),
            &cli,
            None,
        );

        assert_refused_as_newer(code, &capture);
        assert!(migrations(dir.path()).is_empty());
        assert!(cli.pushes.borrow().is_empty());
    }
}

// MARK: - a differing pack

/// The pack this checkout ships.
fn pack_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/supabase-pack")
}

/// [`scripted_env`] with the pack named.
fn pack_env() -> Env {
    Env::from_pairs(&[
        ("KSYNC_DB_URL", FAKE_DB_URL),
        ("KSYNC_PACK_DIR", pack_dir().to_string_lossy().as_ref()),
    ])
}

/// A ledger this build wrote that records a stale md5 of the shipped pack.
fn changed_ledger() -> Vec<crate::provision::LedgerRow> {
    vec![crate::provision::LedgerRow {
        object_kind: "pack-file".to_owned(),
        object_name: "0001_kizuna_init.sql".to_owned(),
        content_hash: "a-stale-hash".to_owned(),
        pack_version: crate::VERSION.to_owned(),
    }]
}

fn add_widgets() -> SyncFlags {
    SyncFlags {
        add: vec!["widgets".to_owned()],
        ..flags()
    }
}

/// `--yes` never asks, so a ledger that records another hash of the pack
/// stops the run before `_config` is read or anything is written, naming the
/// file and the re-apply over the same connection, its password left to
/// `PGPASSWORD`.
#[test]
fn a_differing_pack_stops_a_yes_run_naming_the_reapply_over_its_connection() {
    let dir = project();
    let cli = RecordingCli::new();
    let schemas = FakeSchemas::ok().with_ledger(changed_ledger());
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            yes: true,
            ..add_widgets()
        },
        &pack_env(),
        &schemas,
        &cli,
        None,
    );
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains("! 0001_kizuna_init.sql: ledger md5 a-stale-hash, pack md5 "),
        "{stderr}"
    );
    assert!(
        stderr.contains(
            "`PGPASSWORD=… kizunasync upgrade --reapply --yes --db-url postgresql://postgres@127.0.0.1:54322/postgres`"
        ),
        "{stderr}"
    );
    assert!(schemas.config.executed.borrow().is_empty());
    assert!(migrations(dir.path()).is_empty());
    assert!(cli.pushes.borrow().is_empty());
}

/// On a terminal the gate asks first, and No ends a run that has no
/// connection question behind it with nothing written.
#[test]
fn a_declined_reapply_writes_nothing() {
    let dir = project();
    let cli = RecordingCli::new();
    let schemas = FakeSchemas::ok().with_ledger(changed_ledger());
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
    let (code, capture) = run_in_env(
        dir.path(),
        &add_widgets(),
        &pack_env(),
        &schemas,
        &cli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert_eq!(
        prompter.asked(),
        [Ask::Confirm {
            message: "Re-apply the pack now?".to_owned(),
            default: false,
        }]
    );
    assert!(capture.stderr().contains("nothing applied."));
    assert!(
        !schemas
            .config
            .executed
            .borrow()
            .iter()
            .any(|sql| sql.contains("begin;"))
    );
    assert!(migrations(dir.path()).is_empty());
    assert!(cli.pushes.borrow().is_empty());
}

/// Yes re-applies the pack over the connection, the way `upgrade --reapply`
/// does, and the sync carries on to its own write confirmation.
#[test]
fn a_confirmed_reapply_runs_then_the_sync_carries_on() {
    let dir = project();
    let cli = RecordingCli::new();
    let schemas = FakeSchemas {
        config: config_rows().answer(
            "_schedule_jobs()::text",
            vec![text_row(&[(
                "schedules",
                r#"{"jobs": {"kizunasync-reap-tombstones": "16 3 * * *"}, "pg_cron": true}"#,
            )])],
        ),
        ..FakeSchemas::ok()
    }
    .with_ledger(changed_ledger());
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true), Answer::Confirm(false)]);
    let (code, capture) = run_in_env(
        dir.path(),
        &add_widgets(),
        &pack_env(),
        &schemas,
        &cli,
        Some(&mut prompter),
    );
    let stderr = capture.stderr();
    let confirms: Vec<String> = prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Confirm { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect();

    assert_eq!(code, OK, "{stderr}");
    assert_eq!(confirms.len(), 2, "{confirms:?}");
    assert_eq!(confirms[0], "Re-apply the pack now?");
    assert!(confirms[1].starts_with("Write "), "{confirms:?}");
    assert!(
        schemas
            .config
            .executed
            .borrow()
            .iter()
            .any(|sql| sql.contains("do update set content_hash")),
        "{:?}",
        schemas.config.executed.borrow()
    );
    assert!(
        stderr.contains("re-applied 1 pack file(s) and recorded their hashes."),
        "{stderr}"
    );
    assert!(migrations(dir.path()).is_empty());
}

/// A dry run and a `--local-only` run write nothing to the database, so they
/// are not gated.
#[test]
fn a_dry_run_or_a_local_only_run_over_a_differing_pack_is_not_gated() {
    for flags in [
        SyncFlags {
            dry_run: true,
            ..add_widgets()
        },
        SyncFlags {
            yes: true,
            local_only: true,
            ..add_widgets()
        },
    ] {
        let dir = project();
        let (code, capture) = run_in_env(
            dir.path(),
            &flags,
            &pack_env(),
            &FakeSchemas::ok().with_ledger(changed_ledger()),
            &UnreachableCli,
            None,
        );

        assert_eq!(code, OK, "{}", capture.stderr());
        assert!(!capture.stderr().contains("upgrade --reapply"));
    }
}

/// Over the Management API the refusal names the project instead, its token
/// left to `SUPABASE_ACCESS_TOKEN`.
#[test]
fn a_project_ref_yes_run_over_a_differing_pack_names_the_reapply_over_the_project() {
    let dir = project();
    let api = synced_set(
        FakeApplier::new()
            .answer(LEDGER_PRESENT, vec![text_row(&[("present", "t")])])
            .answer(
                "content_hash, pack_version",
                vec![text_row(&[
                    ("object_kind", "pack-file"),
                    ("object_name", "0001_kizuna_init.sql"),
                    ("content_hash", "a-stale-hash"),
                    ("pack_version", crate::VERSION),
                ])],
            ),
    );
    let (mut ui, capture) = Ui::capture();
    let mut ports = SyncPorts {
        prompter: None,
        schemas: &EmptyCatalog::new(),
        supabase: &UnreachableCli,
        now_unix: FIXED_NOW,
        tokens: &crate::token::NoTokenStore,
        linked: &no_linked,
    };
    let code = run(
        &SyncFlags {
            project_ref: Some(ProjectRef::parse("abcdefghijklmnopqrst").unwrap()),
            yes: true,
            ..add_widgets()
        },
        &ProjectPaths::rooted_at(dir.path().to_path_buf()),
        &Env::from_pairs(&[("KSYNC_PACK_DIR", pack_dir().to_string_lossy().as_ref())]),
        &EnvFileValues::default(),
        Some(&api),
        &mut ports,
        &mut ui,
    );
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains(
            "`SUPABASE_ACCESS_TOKEN=… kizunasync upgrade --reapply --yes --project-ref abcdefghijklmnopqrst`"
        ),
        "{stderr}"
    );
    assert!(
        !api.executed
            .borrow()
            .iter()
            .any(|sql| sql.contains("kizunasync._config")),
        "{:?}",
        api.executed.borrow()
    );
}

/// The Management API path reads the same ledger through the endpoint.
#[test]
fn a_project_ref_sync_over_a_ledger_a_newer_build_wrote_refuses_before_anything_is_applied() {
    let dir = project();
    let api = synced_set(
        FakeApplier::new()
            .answer(LEDGER_PRESENT, vec![text_row(&[("present", "t")])])
            .answer(
                "content_hash, pack_version",
                vec![text_row(&[
                    ("object_kind", "pack-file"),
                    ("object_name", "0001_kizuna_init.sql"),
                    ("content_hash", "recorded"),
                    ("pack_version", NEWER_PACK),
                ])],
            ),
    );
    let (mut ui, capture) = Ui::capture();
    let mut ports = SyncPorts {
        prompter: None,
        schemas: &EmptyCatalog::new(),
        supabase: &UnreachableCli,
        now_unix: FIXED_NOW,
        tokens: &crate::token::NoTokenStore,
        linked: &no_linked,
    };
    let code = run(
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            project_ref: Some(ProjectRef::parse("abcdefghijklmnopqrst").unwrap()),
            yes: true,
            ..flags()
        },
        &ProjectPaths::rooted_at(dir.path().to_path_buf()),
        &Env::default(),
        &EnvFileValues::default(),
        Some(&api),
        &mut ports,
        &mut ui,
    );

    assert_refused_as_newer(code, &capture);
    assert!(
        !api.executed
            .borrow()
            .iter()
            .any(|sql| sql.contains("insert into kizunasync._config")),
        "{:?}",
        api.executed.borrow()
    );
}

// MARK: - the linked project's ref

/// The picker reads `supabase/.temp/project-ref` before it opens: a value that
/// is not a ref is refused there, naming the file, and nothing is asked.
#[test]
fn a_link_file_that_holds_no_valid_ref_is_refused_before_the_sync_picker_opens() {
    let dir = project();
    let temp = dir.path().join("supabase").join(".temp");
    std::fs::create_dir_all(&temp).unwrap();
    std::fs::write(temp.join("project-ref"), "evil.example/x#\n").unwrap();
    let mut prompter = ScriptedPrompter::new(vec![Answer::Candidate(ConnectionCandidate::Manual)]);
    let (code, capture) = run_in_env(
        dir.path(),
        &SyncFlags {
            local_only: true,
            ..flags()
        },
        &Env::default(),
        &FakeSchemas::ok(),
        &UnreachableCli,
        Some(&mut prompter),
    );
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains(
            "supabase/.temp/project-ref holds \"evil.example/x#\", which is not a Supabase project ref"
        ),
        "{stderr}"
    );
    assert!(
        !prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::Candidate { .. }))
    );
    assert!(migrations(dir.path()).is_empty());
}

// MARK: - row level security, bucket moves, and the scan cap

/// A flag-driven add never reads the catalog, so the run names the check it
/// did not make.
#[test]
fn a_flag_driven_add_says_it_does_not_check_row_level_security() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("--add does not check row level security on widgets."),
        "{}",
        capture.stderr()
    );
}

/// The checkbox read the catalog, so a table it adds with row level security
/// disabled is refused before anything is asked or written.
#[test]
fn the_checkbox_refuses_to_add_a_table_whose_row_level_security_is_disabled() {
    let dir = project();
    let schemas = FakeSchemas::ok().with_rls_disabled(&["widgets"]);
    let mut prompter = ScriptedPrompter::new(vec![Answer::Tables(vec![
        "todos".to_owned(),
        "notes".to_owned(),
        "widgets".to_owned(),
    ])]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains("refusing to sync widgets: row level security is disabled on it"),
        "{stderr}"
    );
    assert!(stderr.contains("--allow-no-rls"), "{stderr}");
    assert!(
        !prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::Mode { .. })),
        "nothing is asked after the refusal"
    );
    assert!(migrations(dir.path()).is_empty());
}

/// The key `widgets` carries in the tests where the pack cannot sync by it:
/// a `numeric` column's text form is not the same on the device.
fn composite_key() -> PrimaryKey {
    PrimaryKey::of(
        "widgets_pkey",
        &[("owner_id", "uuid"), ("price", "numeric")],
    )
}

/// `sync --add` reads the catalog for the keys of the tables it names and
/// refuses one the pack cannot sync by before anything is written.
#[test]
fn add_refuses_a_table_the_pack_cannot_key_and_writes_nothing() {
    let dir = project();
    for (key, named) in [
        (
            Some(composite_key()),
            "refusing to sync widgets: its key column price is numeric, and its text form is not identical on the device and on the server.",
        ),
        (
            Some(PrimaryKey::of(
                "widgets_pkey",
                &[("id", "date"), ("seq", "real")],
            )),
            "refusing to sync widgets: its key columns id (date) and seq (real) have types whose text form is not identical on the device and on the server.",
        ),
        (
            None,
            "refusing to sync widgets: it has no primary key, and the pack keys every change by the table's primary key.",
        ),
    ] {
        let (code, capture) = run_in(
            dir.path(),
            &SyncFlags {
                add: vec!["widgets".to_owned()],
                yes: true,
                ..flags()
            },
            &FakeSchemas::ok().with_key("widgets", key.clone()),
            &UnreachableCli,
            None,
        );
        let stderr = capture.stderr();

        assert_eq!(code, UNUSABLE, "{key:?}: {stderr}");
        assert!(stderr.contains(named), "{stderr}");
        assert!(!stderr.contains("alter table"), "{stderr}");
        assert!(migrations(dir.path()).is_empty(), "{key:?}");
    }
}

/// Any key over the six key types provisions, single or composite, and the
/// delta records it in key order; the plan names it.
#[test]
fn add_records_a_composite_or_integer_key_in_the_delta() {
    for (key, recorded, planned) in [
        (
            PrimaryKey::of("widgets_pkey", &[("owner_id", "uuid"), ("slug", "text")]),
            "'{owner_id,slug}'",
            "    + widgets   key (owner_id, slug)   [flag]",
        ),
        (
            PrimaryKey::of("widgets_pkey", &[("id", "bigint")]),
            "'{id}'",
            "    + widgets   key id   [flag]",
        ),
        (
            PrimaryKey::over(
                "widgets_pkey",
                vec![
                    crate::proposals::KeyColumn::plain("code", "character varying(32)")
                        .over_base("character varying"),
                    crate::proposals::KeyColumn::plain("rank", "smallint"),
                ],
            ),
            "'{code,rank}'",
            "    + widgets   key (code, rank)   [flag]",
        ),
    ] {
        let dir = project();
        let (code, capture) = run_in(
            dir.path(),
            &SyncFlags {
                add: vec!["widgets".to_owned()],
                yes: true,
                local_only: true,
                ..flags()
            },
            &FakeSchemas::ok().with_key("widgets", Some(key)),
            &UnreachableCli,
            None,
        );
        let stderr = capture.stderr();

        assert_eq!(code, OK, "{stderr}");
        assert!(stderr.contains(planned), "{stderr}");
        assert!(
            migration_sql(dir.path()).contains(&format!(
                "'widgets', 'pull-only', null, null, 'arrival', false, false, null, 1, {recorded}"
            )),
            "{}",
            migration_sql(dir.path())
        );
    }
}

/// A device mints the key of every row it inserts, which a column generated
/// always refuses: an add that makes the table read-write is refused, and
/// the pull-only default is not.
#[test]
fn add_refuses_a_read_write_table_keyed_by_a_generated_always_identity() {
    use crate::proposals::{Identity, KeyColumn};

    let schemas = || {
        FakeSchemas::ok().with_key(
            "widgets",
            Some(PrimaryKey::over(
                "widgets_pkey",
                vec![KeyColumn::plain("id", "bigint").generated(Identity::Always)],
            )),
        )
    };
    let refused_dir = project();
    let (refused, refused_capture) = run_in(
        refused_dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            options: TableOptions {
                sync: Some(SyncMode::ReadWrite),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &schemas(),
        &UnreachableCli,
        None,
    );
    let pull_only_dir = project();
    let (pull_only, pull_only_capture) = run_in(
        pull_only_dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &schemas(),
        &UnreachableCli,
        None,
    );

    assert_eq!(refused, UNUSABLE, "{}", refused_capture.stderr());
    assert!(
        refused_capture
            .stderr()
            .contains("refusing to sync widgets read-write: its key column id is generated always as identity, so devices cannot supply its value."),
        "{}",
        refused_capture.stderr()
    );
    assert!(migrations(refused_dir.path()).is_empty());
    assert_eq!(pull_only, OK, "{}", pull_only_capture.stderr());
}

/// A read-write add whose key the database fills in provisions, with a note
/// naming what an offline insert must provide.
#[test]
fn add_notes_what_offline_inserts_provide_when_the_key_has_a_database_default() {
    use crate::proposals::KeyColumn;

    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            options: TableOptions {
                sync: Some(SyncMode::ReadWrite),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok().with_key(
            "widgets",
            Some(PrimaryKey::over(
                "widgets_pkey",
                vec![
                    KeyColumn::plain("hall", "bigint"),
                    KeyColumn::plain("seat", "integer")
                        .defaulting("nextval('widgets_seat_seq'::regclass)"),
                ],
            )),
        ),
        &UnreachableCli,
        None,
    );
    let stderr = capture.stderr();

    assert_eq!(code, OK, "{stderr}");
    assert!(
        stderr.contains(
            "  note: widgets is read-write and its key has a database default: offline inserts must provide seat.\n"
        ),
        "{stderr}"
    );
}

// MARK: - a synced table whose key moved

/// Devices hold a pull-only table's rows under the recorded key too, so its
/// moved key is recorded only with a schema bump, and the delta re-keys the
/// changelog after the update.
#[test]
fn a_pull_only_tables_moved_key_is_recorded_only_with_a_schema_bump() {
    let schemas = || {
        FakeSchemas::ok().with_key(
            "notes",
            Some(PrimaryKey::of("notes_pkey", &[("slug", "text")])),
        )
    };
    let refused_dir = project();
    let (refused, refused_capture) = run_in(
        refused_dir.path(),
        &SyncFlags {
            add: vec!["notes".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &schemas(),
        &UnreachableCli,
        None,
    );
    let bumped_dir = project();
    let (bumped, bumped_capture) = run_in(
        bumped_dir.path(),
        &SyncFlags {
            add: vec!["notes".to_owned()],
            options: TableOptions {
                min_schema_version: Some(2),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &schemas(),
        &UnreachableCli,
        None,
    );
    let stderr = bumped_capture.stderr();

    assert_eq!(refused, UNUSABLE, "{}", refused_capture.stderr());
    assert!(
        refused_capture.stderr().contains(
            "refusing to record the key slug of notes without raising --min-schema-version above 1: devices hold its rows under id, the key kizunasync._config records, so every device has to bootstrap notes again. Run `kizunasync sync --add notes --min-schema-version 2`."
        ),
        "{}",
        refused_capture.stderr()
    );
    assert!(migrations(refused_dir.path()).is_empty());
    assert_eq!(bumped, OK, "{stderr}");
    assert!(
        stderr.contains(
            "  notes: its primary key is slug, and kizunasync._config records id: recording the current key."
        ),
        "{stderr}"
    );
    assert!(!stderr.contains("nothing to add"), "{stderr}");
    let sql = migration_sql(bumped_dir.path());
    let update = sql
        .find("update kizunasync._config set\n  min_schema_version = 2,\n  key_columns = '{slug}'\nwhere table_name = 'notes';")
        .unwrap_or_else(|| panic!("{sql}"));
    let rekey = sql
        .find("select kizunasync._rekey_changelog('notes');")
        .unwrap_or_else(|| panic!("{sql}"));
    assert!(update < rekey, "{sql}");
}

/// A read-write table's moved key follows the same rule.
#[test]
fn a_read_write_tables_moved_key_is_recorded_only_with_a_schema_bump() {
    let schemas = || {
        FakeSchemas::ok().with_key(
            "todos",
            Some(PrimaryKey::of(
                "todos_pkey",
                &[("user_id", "uuid"), ("slug", "text")],
            )),
        )
    };
    let refused_dir = project();
    let (refused, refused_capture) = run_in(
        refused_dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &schemas(),
        &UnreachableCli,
        None,
    );
    let bumped_dir = project();
    let (bumped, bumped_capture) = run_in(
        bumped_dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            options: TableOptions {
                min_schema_version: Some(2),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &schemas(),
        &UnreachableCli,
        None,
    );

    assert_eq!(refused, UNUSABLE, "{}", refused_capture.stderr());
    assert!(
        refused_capture.stderr().contains(
            "refusing to record the key (user_id, slug) of todos without raising --min-schema-version above 1: devices hold its rows under id, the key kizunasync._config records, so every device has to bootstrap todos again. Run `kizunasync sync --add todos --min-schema-version 2`."
        ),
        "{}",
        refused_capture.stderr()
    );
    assert!(migrations(refused_dir.path()).is_empty());
    assert_eq!(bumped, OK, "{}", bumped_capture.stderr());
    let sql = migration_sql(bumped_dir.path());
    assert!(
        sql.contains(
            "update kizunasync._config set\n  min_schema_version = 2,\n  key_columns = '{user_id,slug}'\nwhere table_name = 'todos';\n\n-- re-key the changelog by the new key"
        ),
        "{sql}"
    );
    assert!(
        sql.contains("select kizunasync._rekey_changelog('todos');"),
        "{sql}"
    );
}

/// A synced table whose key moved to one the pack cannot key by is refused
/// rather than recorded.
#[test]
fn a_synced_tables_key_that_moved_to_an_unkeyable_one_is_refused() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["notes".to_owned()],
            yes: true,
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok().with_key(
            "notes",
            Some(PrimaryKey::of(
                "notes_pkey",
                &[("at", "timestamp with time zone")],
            )),
        ),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("refusing to sync notes: its key column at is timestamp with time zone"),
        "{}",
        capture.stderr()
    );
    assert!(migrations(dir.path()).is_empty());
}

/// The checkbox raises no schema version, so a synced table it keeps whose
/// key moved is refused, pull-only or read-write, with the command that
/// records the key; unchecking the table still removes it.
#[test]
fn the_checkbox_refuses_a_kept_table_whose_key_moved_and_names_the_command() {
    let answers = || {
        vec![
            Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
            Answer::Confirm(true),
        ]
    };
    for (table, key, command) in [
        (
            "notes",
            PrimaryKey::of("notes_pkey", &[("slug", "text")]),
            "Run `kizunasync sync --add notes --min-schema-version 2`.",
        ),
        (
            "todos",
            PrimaryKey::of("todos_pkey", &[("slug", "text")]),
            "Run `kizunasync sync --add todos --min-schema-version 2`.",
        ),
    ] {
        let dir = project();
        let mut prompter = ScriptedPrompter::new(answers());
        let (code, capture) = run_in(
            dir.path(),
            &SyncFlags {
                db_url: Some(FAKE_DB_URL.to_owned()),
                local_only: true,
                ..flags()
            },
            &FakeSchemas::ok().with_key(table, Some(key)),
            &UnreachableCli,
            Some(&mut prompter),
        );

        assert_eq!(code, UNUSABLE, "{table}: {}", capture.stderr());
        assert!(capture.stderr().contains(command), "{}", capture.stderr());
        assert!(migrations(dir.path()).is_empty(), "{table}");
    }

    let dir = project();
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &FakeSchemas::ok().with_key(
            "notes",
            Some(PrimaryKey::of("notes_pkey", &[("slug", "text")])),
        ),
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(
        migration_sql(dir.path())
            .contains("delete from kizunasync._config where table_name = 'notes';")
    );
}

/// The checkbox lists a table the pack cannot key as unavailable, unchecked,
/// with the reason in a note above it, and the other tables go on.
#[test]
fn the_checkbox_lists_an_unkeyed_table_as_unavailable_with_its_reason() {
    let dir = project();
    let schemas = FakeSchemas::ok().with_key("widgets", Some(composite_key()));
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
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
    let widgets = offered
        .iter()
        .find(|choice| choice.table == "widgets")
        .unwrap();
    assert!(widgets.unavailable);
    assert!(!widgets.checked);
    assert_eq!(widgets.hint, "key column price is numeric");
    let (_, note) = prompter
        .notes()
        .iter()
        .find(|(title, _)| title == "Unavailable tables")
        .unwrap();
    assert!(
        note.starts_with("refusing to sync widgets: its key column price is numeric"),
        "{note}"
    );
}

/// A synced table stays on offer whatever its key, so unchecking it still
/// stops syncing it.
#[test]
fn the_checkbox_keeps_an_unkeyed_synced_table_on_offer() {
    let dir = project();
    let schemas = FakeSchemas::ok().with_key("todos", Some(composite_key()));
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["notes".to_owned()]),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
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
    assert!(!todos.unavailable);
    assert!(todos.checked);
    assert!(migration_sql(dir.path()).contains("'todos'"));
}

/// A table the checkbox could not have offered is refused all the same.
#[test]
fn the_checkbox_refuses_an_unkeyed_table_it_was_answered_with() {
    let dir = project();
    let schemas = FakeSchemas::ok().with_key("widgets", Some(composite_key()));
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec![
            "todos".to_owned(),
            "notes".to_owned(),
            "widgets".to_owned(),
        ]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(capture.stderr().contains("refusing to sync widgets"));
    assert!(migrations(dir.path()).is_empty());
}

/// A synced table keeps syncing whatever its row level security: the check
/// is about what a run adds.
#[test]
fn the_checkbox_does_not_refuse_a_table_that_is_already_synced() {
    let dir = project();
    let schemas = FakeSchemas::ok().with_rls_disabled(&["todos"]);
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(!capture.stderr().contains("row level security"));
}

#[test]
fn allow_no_rls_adds_the_table_and_names_it_in_a_warning() {
    let dir = project();
    let schemas = FakeSchemas::ok().with_rls_disabled(&["widgets"]);
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec![
            "todos".to_owned(),
            "notes".to_owned(),
            "widgets".to_owned(),
        ]),
        Answer::Mode(WizardMode::Recommended),
        Answer::Confirm(true),
    ]);
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            db_url: Some(FAKE_DB_URL.to_owned()),
            local_only: true,
            allow_no_rls: true,
            ..flags()
        },
        &schemas,
        &UnreachableCli,
        Some(&mut prompter),
    );
    let stderr = capture.stderr();

    assert_eq!(code, OK, "{stderr}");
    assert!(
        stderr.contains("--allow-no-rls: syncing widgets with row level security disabled"),
        "{stderr}"
    );
    assert!(migration_sql(dir.path()).contains("'widgets', 'pull-only'"));
}

/// Moving a synced table to another bucket column relabels its changelog and
/// drops the tombstones the new column cannot scope, so the run has to raise
/// the table's schema version for every device to bootstrap it again.
#[test]
fn a_bucket_column_change_without_a_schema_bump_is_refused_with_the_reason() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            options: TableOptions {
                bucket_column: Some("team_id".to_owned()),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );
    let stderr = capture.stderr();

    assert_eq!(code, UNUSABLE, "{stderr}");
    assert!(
        stderr.contains(
            "refusing to change the bucket column of todos to team_id without raising --min-schema-version above 1"
        ),
        "{stderr}"
    );
    assert!(
        stderr.contains("every device has to bootstrap todos again"),
        "{stderr}"
    );
    assert!(migrations(dir.path()).is_empty());
}

#[test]
fn a_schema_bump_to_the_current_version_is_not_a_bump() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            options: TableOptions {
                bucket_column: Some("team_id".to_owned()),
                min_schema_version: Some(1),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(migrations(dir.path()).is_empty());
}

/// A table with no bucket column gains one: every label it carries is null,
/// so that is a change of bucket column too.
#[test]
fn giving_an_unbucketed_table_a_bucket_column_needs_the_bump_too() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["notes".to_owned()],
            options: TableOptions {
                bucket_column: Some("team_id".to_owned()),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, UNUSABLE, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("refusing to change the bucket column of notes to team_id"),
        "{}",
        capture.stderr()
    );
}

#[test]
fn a_bucket_column_change_with_a_schema_bump_relabels_after_the_update() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            options: TableOptions {
                bucket_column: Some("team_id".to_owned()),
                min_schema_version: Some(2),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    let sql = migration_sql(dir.path());
    let update = sql
        .find("  bucket_column = 'team_id',\n  min_schema_version = 2\nwhere table_name = 'todos';")
        .unwrap_or_else(|| panic!("{sql}"));
    let relabel = sql
        .find("select kizunasync._relabel_changelog('todos');")
        .unwrap_or_else(|| panic!("{sql}"));

    assert!(update < relabel, "{sql}");
}

/// Restating the bucket column a table already has moves nothing, so it
/// needs no bump and relabels nothing.
#[test]
fn restating_the_current_bucket_column_relabels_nothing() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["todos".to_owned()],
            options: TableOptions {
                bucket_column: Some("user_id".to_owned()),
                register_clients: Some(true),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(!migration_sql(dir.path()).contains("_relabel_changelog"));
}

#[test]
fn a_pull_scan_cap_below_one_is_refused_before_anything_is_read() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            settings: SettingsOptions {
                max_pull_scan: Some(0),
                ..SettingsOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &FakeSchemas::config_failing("unreachable in this test"),
        &UnreachableCli,
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
    assert!(migrations(dir.path()).is_empty());
}

#[test]
fn a_declared_pull_scan_cap_reaches_the_settings_update() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            settings: SettingsOptions {
                max_pull_scan: Some(2000),
                ..SettingsOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &live_pack_defaults(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    let sql = migration_sql(dir.path());
    assert!(sql.contains("  max_pull_scan = 2000\nwhere id;"), "{sql}");
    assert!(!sql.contains("max_batch_size"), "{sql}");
}

/// An unbucketed read-write table's tombstones reach every user who pulled
/// any of its rows, so the run points at the column that avoids them.
#[test]
fn a_read_write_table_without_a_bucket_or_a_soft_delete_column_is_warned_about() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["widgets".to_owned()],
            options: TableOptions {
                sync: Some(SyncMode::ReadWrite),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );
    let stderr = capture.stderr();

    assert_eq!(code, OK, "{stderr}");
    assert!(
        stderr.contains(
            "widgets is read-write with no bucket column and no soft-delete column: every user who pulls a row of it also receives the id of every row deleted from it"
        ),
        "{stderr}"
    );
    assert!(stderr.contains("--soft-delete <column>"), "{stderr}");
}

#[test]
fn a_bucket_or_a_soft_delete_column_leaves_no_warning() {
    for options in [
        TableOptions {
            sync: Some(SyncMode::ReadWrite),
            bucket_column: Some("team_id".to_owned()),
            ..TableOptions::default()
        },
        TableOptions {
            sync: Some(SyncMode::ReadWrite),
            soft_delete: Some("deleted_at".to_owned()),
            ..TableOptions::default()
        },
        TableOptions::default(),
    ] {
        let dir = project();
        let (code, capture) = run_in(
            dir.path(),
            &SyncFlags {
                add: vec!["widgets".to_owned()],
                options: options.clone(),
                yes: true,
                local_only: true,
                ..flags()
            },
            &EmptyCatalog::new(),
            &UnreachableCli,
            None,
        );

        assert_eq!(code, OK, "{}", capture.stderr());
        assert!(
            !capture.stderr().contains("no soft-delete column"),
            "{options:?}: {}",
            capture.stderr()
        );
    }
}

/// An update that leaves a table read-write, unbucketed and without a
/// soft-delete column gets the same warning as an add.
#[test]
fn an_update_that_makes_an_unbucketed_table_read_write_is_warned_about() {
    let dir = project();
    let (code, capture) = run_in(
        dir.path(),
        &SyncFlags {
            add: vec!["notes".to_owned()],
            options: TableOptions {
                sync: Some(SyncMode::ReadWrite),
                ..TableOptions::default()
            },
            yes: true,
            local_only: true,
            ..flags()
        },
        &EmptyCatalog::new(),
        &UnreachableCli,
        None,
    );

    assert_eq!(code, OK, "{}", capture.stderr());
    assert!(
        capture
            .stderr()
            .contains("notes is read-write with no bucket column and no soft-delete column"),
        "{}",
        capture.stderr()
    );
}
