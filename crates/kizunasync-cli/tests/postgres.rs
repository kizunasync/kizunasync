//! Postgres-gated integration tests.
//!
//! One skip survives in this file: nobody named a database and the local stack
//! is not running, so there is nothing to test against. Every other missing
//! precondition is a panic, because a lane that passes by skipping reports
//! nothing about the database it never reached.
//!
//! The transport tests take no opt-in variable: this is the transport every
//! read goes through, so they run whenever a database is reachable, and every
//! object they create lives in a uniquely-named throwaway schema that they
//! also drop.
//!
//! The end-to-end scenario is the one test that writes where the product
//! lives. It provisions its own `public.cli_scenario_items` and never
//! `public.todos`, it installs the pack only into a database that carries
//! none, and it unwinds the table, its triggers, its `kizunasync._config` row,
//! and its `kizunasync._provisions` rows before it asserts anything. It removes
//! nothing the pack seeded. The operator commands that write run against
//! `kizunasync_cli_scratch`, a database this file creates and stubs itself.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use kizunasync_cli::applier::Applier;
use kizunasync_cli::catalog::PgSchemaSource;
use kizunasync_cli::commands::doctor::LivePorts;
use kizunasync_cli::commands::init::{InitPorts, WizardConnection};
use kizunasync_cli::commands::panel::{PanelAction, PanelPorts};
use kizunasync_cli::commands::smart::{self, SmartPorts};
use kizunasync_cli::commands::upgrade::render_reapply;
use kizunasync_cli::env::Env;
use kizunasync_cli::error::Error;
use kizunasync_cli::login_role::LinkedConnection;
use kizunasync_cli::management::ProjectSummary;
use kizunasync_cli::migration_history::read_applied_migrations;
use kizunasync_cli::pack::read_pack_files;
use kizunasync_cli::pg::{PgApplier, probe_db};
use kizunasync_cli::project_ref::ProjectRef;
use kizunasync_cli::prompts::{Answer, Ask, Prompter, ScriptedPrompter};
use kizunasync_cli::provision::{
    Plan, hash_pack_file, plan_provision, read_ledger_rows, render_install,
};
use kizunasync_cli::row::require_string;
use kizunasync_cli::server_facts::ServerFacts;
use kizunasync_cli::supabase_cli::{CliResult, PushTarget, SupabaseCli};
use kizunasync_cli::sync_delta::{DeltaInput, render_sync_delta_sql};
use kizunasync_cli::token::NoTokenStore;
use kizunasync_cli::workdir::ProjectPaths;
use kizunasync_cli::{Ui, env_file};

/// The database `SUPABASE_DB_URL` names, or the local Supabase stack's own.
fn db_url() -> String {
    std::env::var("SUPABASE_DB_URL")
        .unwrap_or_else(|_| "postgresql://postgres:postgres@127.0.0.1:55322/postgres".to_owned())
}

/// `Some(url)` when a database answers; `None` after printing the one skip
/// this file keeps.
///
/// That skip is for the machine that named no database and runs no stack. A
/// `SUPABASE_DB_URL` someone set and that does not answer is a failure: it
/// names a database a run was meant to cover.
fn reachable() -> Option<String> {
    let named = std::env::var("SUPABASE_DB_URL").ok();
    let url = db_url();
    let Err(cause) = probe_db(&url) else {
        return Some(url);
    };
    let sentence =
        format!("no Postgres at {url}. Run `bun run db:start` or set SUPABASE_DB_URL. ({cause})");
    assert!(named.is_none(), "[pg-it] {sentence}");
    eprintln!("[pg-it] SKIPPED: {sentence}");

    None
}

/// A schema name unique to this process, so concurrent runs cannot collide.
fn throwaway_schema() -> String {
    format!("kizunasync_rs_it_{}", std::process::id())
}

fn kizunasync(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kizunasync"));
    command.current_dir(cwd).args(args).env_clear();
    command.env("PATH", std::env::var("PATH").unwrap_or_default());
    for (key, value) in env {
        command.env(key, value);
    }
    command.stdin(Stdio::null());

    command.output().expect("kizunasync should be spawnable")
}

#[test]
fn a_multi_statement_script_runs_as_one_unit_and_its_rows_read_back() {
    let Some(url) = reachable() else { return };
    let applier = PgApplier::new(&url);
    let schema = throwaway_schema();

    // The point of this test: deprovision's down-migration and mock's seed SQL
    // are both multi-statement scripts, which only work because the transport
    // uses the simple query protocol. Prove it rather than assume it.
    let script = format!(
        "begin;\n\
         drop schema if exists \"{schema}\" cascade;\n\
         create schema \"{schema}\";\n\
         create table \"{schema}\".t (id int primary key, val text);\n\
         insert into \"{schema}\".t (id, val) values (1, 'a'), (2, 'b');\n\
         insert into \"{schema}\".t (id, val) values (3, 'c');\n\
         commit;"
    );
    applier.run_script(&script).unwrap();

    let rows = applier
        .run_query(&format!("select val from \"{schema}\".t order by id;"))
        .unwrap();
    let values: Vec<String> = rows
        .iter()
        .map(|row| require_string(row, "val").unwrap())
        .collect();

    applier
        .run_script(&format!("drop schema if exists \"{schema}\" cascade;"))
        .unwrap();

    assert_eq!(values, ["a", "b", "c"]);
}

#[test]
fn a_syntactically_invalid_query_is_an_error_not_a_panic() {
    let Some(url) = reachable() else { return };
    let applier = PgApplier::new(&url);
    let Error::Sql { sqlstate, text } = applier.run_query("select this is not sql;").unwrap_err()
    else {
        panic!("a statement the server rejected carries its SQLSTATE");
    };

    // 42601 is Postgres's own `syntax_error` SQLSTATE, which `describe` puts first.
    assert_eq!(sqlstate, "42601");
    assert!(text.starts_with("42601: "), "{text}");
}

/// The history read's presence probe and its name read run on the real
/// catalog: the Supabase CLI records a `name` beside every version it pushes.
#[test]
fn the_migration_history_reads_every_version_with_the_name_it_was_pushed_under() {
    let Some(url) = reachable() else { return };
    let applier = PgApplier::new(&url);
    let named = scalar(
        &applier,
        "select exists (select 1 from information_schema.columns where table_schema = 'supabase_migrations' and table_name = 'schema_migrations' and column_name = 'name')::text as named;",
        "named",
    );
    let history = read_applied_migrations(&applier).unwrap();

    assert!(
        history
            .iter()
            .all(|migration| migration.version.bytes().all(|byte| byte.is_ascii_digit())),
        "{history:?}"
    );
    if named == "true" {
        assert!(
            history.iter().all(|migration| migration.name.is_some()),
            "{history:?}"
        );
    } else {
        assert!(
            history.iter().all(|migration| migration.name.is_none()),
            "{history:?}"
        );
    }
}

#[test]
fn an_unreachable_port_is_an_error_not_a_hang() {
    let Error::Db(message) =
        probe_db("postgresql://postgres:postgres@127.0.0.1:1/postgres").unwrap_err()
    else {
        panic!("an unreachable port is a database failure");
    };

    assert!(!message.is_empty(), "the refusal names its cause");
}

#[test]
fn status_json_against_a_live_database_is_exactly_one_object_on_stdout() {
    // This report reads the jobs and the settings, so it takes the guard even
    // though it asserts only the shape.
    let _live = live_stack_guard();
    let Some(url) = reachable() else { return };
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync(dir.path(), &["status", "--json", "--db-url", &url], &[]);

    // Whether the database is provisioned is not this test's business: the
    // contract is that a `--json` run either succeeds with exactly one object on
    // stdout, or fails with an empty stdout and its reason on stderr.
    if output.status.code() == Some(0) {
        let body = String::from_utf8_lossy(&output.stdout);
        let value: serde_json::Value =
            serde_json::from_str(body.trim()).expect("status --json should print one object");

        assert!(value.get("pack").is_some());
    } else {
        assert!(
            output.stdout.is_empty(),
            "a failed --json run must not print a partial object"
        );
        assert!(!output.stderr.is_empty());
    }
}

/// A printed `PGPASSWORD=… kizunasync … --db-url <url without a password>`
/// command connects as printed: the CLI's own connections read the password
/// from `PGPASSWORD` when the URL carries none.
#[test]
fn a_url_without_a_password_connects_with_the_one_pgpassword_carries() {
    let _live = live_stack_guard();
    let Some(url) = provisioned_url() else { return };
    let (bare, password) = kizunasync_cli::db::split_db_url_password(&url);
    let password = password.expect("the lane's URL carries a password");
    let dir = tempfile::tempdir().unwrap();
    let args = ["status", "--json", "--db-url", bare.as_str()];

    let refused = kizunasync(dir.path(), &args, &[]);
    assert_ne!(refused.status.code(), Some(0), "no password reached it");

    let connected = kizunasync(dir.path(), &args, &[("PGPASSWORD", password.as_str())]);
    assert_eq!(
        connected.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&connected.stderr)
    );
}

// MARK: - schedules, end to end

/// Serializes every test that reads or writes `kizunasync._settings` or
/// `cron.job` on the live stack, because they share one database and one set of
/// three jobs: a test that reads a schedule while another is mid-restore sees a
/// drift nobody caused.
static LIVE_STACK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The lock directory the same guard takes across processes. `cargo test` runs
/// these as threads of one process and `cargo nextest` as one process each, so
/// the mutex alone would leave the nextest lane racing. A directory is the
/// atomic primitive every platform agrees on, and this workspace's MSRV
/// predates `File::lock`.
fn live_stack_lock_path() -> std::path::PathBuf {
    std::env::temp_dir().join("kizunasync-cli-live-stack.lock")
}

/// How long a lock may be held before the next run reads it as abandoned. The
/// longest live test is a few seconds, so half a minute is a crash, not a
/// queue.
const LOCK_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

/// How long to wait for the lock before running without it. Under nextest's
/// terminate-after this has to stay well inside the per-test budget.
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Held for the whole body of every live-stack test.
struct LiveStackGuard {
    _process: std::sync::MutexGuard<'static, ()>,
    held: Option<std::path::PathBuf>,
}

impl Drop for LiveStackGuard {
    fn drop(&mut self) {
        if let Some(path) = self.held.take() {
            let _ = std::fs::remove_dir(&path);
        }
    }
}

/// Take the guard. Mutex poisoning is ignored: a panicking test leaves the
/// stack restored by its own cleanup, and refusing the lock afterwards would
/// turn one failure into every failure. A cross-process lock that cannot be
/// taken degrades to the in-process mutex rather than failing the run, and says
/// so.
fn live_stack_guard() -> LiveStackGuard {
    let process = LIVE_STACK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = live_stack_lock_path();
    let deadline = std::time::Instant::now() + LOCK_WAIT;
    loop {
        if std::fs::create_dir(&path).is_ok() {
            return LiveStackGuard {
                _process: process,
                held: Some(path),
            };
        }
        // A lock nobody released is a crashed run, not a queue. A path that is
        // not a directory at all is something older than this guard.
        if !path.is_dir() || held_longer_than(&path, LOCK_STALE_AFTER) {
            let _ = std::fs::remove_dir(&path);
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if std::time::Instant::now() >= deadline {
            eprintln!(
                "[pg-it] {} is still held after {LOCK_WAIT:?}; this process is serialized by its own mutex only.",
                path.display()
            );

            return LiveStackGuard {
                _process: process,
                held: None,
            };
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Whether the lock directory has existed longer than `limit`. A path whose
/// metadata cannot be read is not stolen.
fn held_longer_than(path: &std::path::Path, limit: std::time::Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| std::time::SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > limit)
}

/// The three job names `kizunasync._schedule_jobs()` owns.
const JOB_NAMES: [&str; 3] = [
    "kizunasync-reap-tombstones",
    "kizunasync-compact-changelog",
    "kizunasync-prune-clients",
];

/// `jobname → schedule` for the three jobs, as `cron.job` carries them.
fn scheduled_jobs(applier: &PgApplier) -> Vec<(String, String)> {
    let Ok(rows) = applier.run_query(
        "select jobname, schedule from cron.job where jobname like 'kizunasync-%' order by jobname;",
    ) else {
        return Vec::new();
    };

    rows.iter()
        .filter_map(|row| {
            Some((
                require_string(row, "jobname").ok()?,
                require_string(row, "schedule").ok()?,
            ))
        })
        .filter(|(name, _)| JOB_NAMES.contains(&name.as_str()))
        .collect()
}

/// The three schedule columns as `_settings` carries them, so the test can put
/// back exactly what it found.
fn settings_schedules(applier: &PgApplier) -> Option<(String, String, String)> {
    let rows = applier
        .run_query(
            "select reap_schedule, compact_schedule, client_prune_schedule from kizunasync._settings;",
        )
        .ok()?;
    let row = rows.first()?;

    Some((
        require_string(row, "reap_schedule").ok()?,
        require_string(row, "compact_schedule").ok()?,
        require_string(row, "client_prune_schedule").ok()?,
    ))
}

/// A schedule a `kizunasync sync` run declares reaches `kizunasync._settings`, and
/// the pack's scheduler puts it on the `pg_cron` job the CLI never names
/// directly.
///
/// Every value this test writes is read back and then restored to what it
/// found, so the stack it ran against is left exactly as it was.
#[test]
fn a_declared_schedule_reaches_settings_and_the_cron_job() {
    let _guard = live_stack_guard();
    let Some(url) = scenario_url() else { return };
    let applier = PgApplier::new(&url);
    assert!(
        is_provisioned(&applier),
        "[pg-it] SUPABASE_DB_URL names a database with no Kizuna pack, so there is no kizunasync._settings to declare into."
    );
    let Some(before) = settings_schedules(&applier) else {
        panic!("[pg-it] kizunasync._settings carries no schedule columns yet.");
    };
    assert_eq!(
        scheduled_jobs(&applier).len(),
        JOB_NAMES.len(),
        "[pg-it] this database schedules none of the three kizunasync jobs, so pg_cron is absent and there is nothing to read a schedule back from."
    );

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("supabase/migrations")).unwrap();
    let declared = kizunasync(
        root,
        &[
            "sync",
            "--reap-schedule",
            "5 4 * * *",
            "--compact-schedule",
            "35 4 * * *",
            "--client-prune-schedule",
            "50 4 * * *",
            "--yes",
            "--local-only",
            "--db-url",
            &url,
        ],
        &[],
    );
    let delta = migration_ending_in(root, "_kizunasync_sync.sql");
    let apply_result = delta
        .as_ref()
        .map(|(_, sql)| applier.run_script(sql.as_str()));
    let written = settings_schedules(&applier);
    let jobs = scheduled_jobs(&applier);

    // Whatever happened above, this database goes back to the schedules it
    // carried before the test touched it.
    let restore = format!(
        "update kizunasync._settings set reap_schedule = '{}', compact_schedule = '{}', client_prune_schedule = '{}' where id; select kizunasync._schedule_jobs();",
        before.0, before.1, before.2
    );
    applier.run_script(&restore).unwrap();
    let restored = scheduled_jobs(&applier);

    assert_eq!(
        code(&declared),
        0,
        "kizunasync sync:\n{}",
        stderr(&declared)
    );
    let Some((name, sql)) = delta else {
        panic!("a settings-only run should have written a *_kizunasync_sync.sql migration");
    };
    assert!(
        sql.contains("select kizunasync._schedule_jobs();"),
        "{name} should reschedule the jobs it rewrote"
    );
    match apply_result {
        Some(Ok(())) => {}
        other => panic!("{name} should apply, got {other:?}"),
    }
    assert_eq!(
        written,
        Some((
            "5 4 * * *".to_owned(),
            "35 4 * * *".to_owned(),
            "50 4 * * *".to_owned()
        ))
    );
    assert_eq!(
        jobs,
        [
            (
                "kizunasync-compact-changelog".to_owned(),
                "35 4 * * *".to_owned()
            ),
            (
                "kizunasync-prune-clients".to_owned(),
                "50 4 * * *".to_owned()
            ),
            (
                "kizunasync-reap-tombstones".to_owned(),
                "5 4 * * *".to_owned()
            ),
        ]
    );
    assert_eq!(
        restored,
        [
            ("kizunasync-compact-changelog".to_owned(), before.1),
            ("kizunasync-prune-clients".to_owned(), before.2),
            ("kizunasync-reap-tombstones".to_owned(), before.0),
        ]
    );
}

// MARK: - the live end-to-end scenario

/// The table this scenario provisions. Its own name, never `public.todos`,
/// which a local stack's demo fixtures already own.
const SCENARIO_TABLE: &str = "cli_scenario_items";

fn code(output: &Output) -> i32 {
    output
        .status
        .code()
        .expect("kizunasync should exit, not signal")
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The connection the scenario runs against: the database `SUPABASE_DB_URL`
/// names, or the local stack's own when it names none.
///
/// This scenario provisions a table into `public` and a row into `kizunasync`,
/// and unwinds both, so the database it runs against is the one every other
/// live test in this file reads.
fn scenario_url() -> Option<String> {
    reachable()
}

/// The pack this checkout ships. The spawned binary lives wherever Cargo's
/// build directory is, possibly outside the repository, so the pack is named
/// explicitly rather than left to production's executable-walk rung.
fn pack_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/supabase-pack")
}

/// The base migration the scenario installs when the database carries no
/// Kizuna. Only this one: `0002_example.sql` needs `auth.users` and
/// `storage.buckets`, which a database outside a full stack does not have.
fn pack_migration() -> PathBuf {
    pack_dir().join("supabase/migrations/0001_kizuna_init.sql")
}

/// Whether `kizunasync._config` is there to read. A failed probe reads as
/// absent, so a transport that did not answer cannot look provisioned.
fn is_provisioned(applier: &PgApplier) -> bool {
    let Ok(rows) =
        applier.run_query("select to_regclass('kizunasync._config') is not null as present;")
    else {
        return false;
    };

    rows.first()
        .and_then(|row| require_string(row, "present").ok())
        .is_some_and(|present| present == "t")
}

/// Migration file names in the temp project, sorted.
fn migration_names(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join("supabase/migrations")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();

    names
}

/// The one migration whose name ends in `suffix`, with its SQL.
fn migration_ending_in(root: &Path, suffix: &str) -> Option<(String, String)> {
    let name = migration_names(root)
        .into_iter()
        .find(|name| name.ends_with(suffix))?;
    let sql = std::fs::read_to_string(root.join("supabase/migrations").join(&name)).ok()?;

    Some((name, sql))
}

/// The DB-first commands against a live database, in the order a project runs
/// them: `init` writes the migrations, `sync` provisions a table into
/// `kizunasync._config`, then `status` and `lint` read the result back.
///
/// `kizunasync sync` applies its delta with `supabase db push` addressed to the
/// chosen database (`--local`, `--db-url`, or `--linked` for the linked login
/// route). This test does not spawn the Supabase CLI, so every run here is
/// `--local-only` and the SQL the CLI emits is applied over the connection
/// `--db-url` names, which is what `supabase db push --db-url` would have done.
///
/// Every observation is taken before the cleanup and every assertion runs after
/// it, so a failed assertion cannot leave the table behind. The cleanup unwinds
/// what this run provisioned and nothing the pack seeded.
///
/// It takes the live-stack guard like its siblings: between the delta apply and
/// the undo this database carries a `kizunasync._config` row and three
/// `_provisions` rows that no other test provisioned, and `doctor`'s ledger
/// check reads both sides of that window over separate connections.
#[test]
fn the_db_first_commands_provision_a_table_against_a_live_database() {
    let _guard = live_stack_guard();
    let Some(url) = scenario_url() else { return };
    let applier = PgApplier::new(&url);
    if !is_provisioned(&applier) {
        let sql = std::fs::read_to_string(pack_migration()).unwrap();
        if let Err(cause) = applier.run_script(&sql) {
            panic!(
                "[pg-it] this database carries no Kizuna pack and 0001_kizuna_init.sql does not apply to it. The pack needs a Supabase stack (the realtime schema, pg_cron, the API roles), not a bare Postgres. ({cause})"
            );
        }
    }
    // Both trackers key the changelog by the primary key, so a synced table needs one.
    applier
        .run_script(&format!(
            "create table if not exists public.{SCENARIO_TABLE} (id uuid primary key, user_id uuid, title text not null default '', done boolean not null default false);"
        ))
        .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    std::fs::create_dir_all(root.join("supabase/migrations")).unwrap();
    let pack = pack_dir().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack.as_str())];

    let init = kizunasync(root, &["init", "--local-only", "--yes"], &env);
    let init_files = migration_names(root);
    let sync = kizunasync(
        root,
        &[
            "sync",
            "--add",
            SCENARIO_TABLE,
            "--sync",
            "read-write",
            "--yes",
            "--local-only",
            "--db-url",
            &url,
        ],
        &env,
    );
    let delta = migration_ending_in(root, "_kizunasync_sync.sql");
    let delta_apply = delta
        .as_ref()
        .map(|(_, sql)| applier.run_script(sql.as_str()));
    let config = applier.run_query(&format!(
        "select sync_mode from kizunasync._config where table_name = '{SCENARIO_TABLE}';"
    ));
    let status = kizunasync(root, &["status", "--json", "--db-url", &url], &env);
    let lint = kizunasync(root, &["lint", "--db-url", &url], &env);

    // The inverse of the delta, rendered by the same owner `kizunasync sync --remove`
    // uses: both triggers, the config row, the three ledger rows.
    let undo = render_sync_delta_sql(&DeltaInput {
        removed: vec![SCENARIO_TABLE.to_owned()],
        ..DeltaInput::default()
    });
    applier.run_script(&undo).unwrap();
    applier
        .run_script(&format!("drop table if exists public.{SCENARIO_TABLE};"))
        .unwrap();

    assert_eq!(code(&init), 0, "kizunasync init:\n{}", stderr(&init));
    assert!(
        init_files
            .iter()
            .any(|name| name.ends_with("_kizunasync_init.sql"))
            && init_files
                .iter()
                .any(|name| name.ends_with("_kizunasync_config.sql")),
        "kizunasync init should write the pack and config migrations, wrote {init_files:?}"
    );

    assert_eq!(code(&sync), 0, "kizunasync sync:\n{}", stderr(&sync));
    let Some((delta_name, _)) = delta else {
        panic!("kizunasync sync should have written a *_kizunasync_sync.sql migration");
    };
    match delta_apply {
        Some(Ok(())) => {}
        other => panic!("{delta_name} should apply, got {other:?}"),
    }

    let rows = config.expect("the kizunasync._config read should answer");
    assert_eq!(rows.len(), 1, "one _config row for {SCENARIO_TABLE}");
    assert_eq!(require_string(&rows[0], "sync_mode").unwrap(), "read-write");

    assert_eq!(code(&status), 0, "kizunasync status:\n{}", stderr(&status));
    let report: serde_json::Value =
        serde_json::from_str(String::from_utf8_lossy(&status.stdout).trim())
            .expect("status --json should print one object");
    let listed = report["tables"].as_array().and_then(|tables| {
        tables
            .iter()
            .find(|entry| entry["table"] == SCENARIO_TABLE)
            .cloned()
    });
    let listed = listed.expect("status should list the table this run provisioned");
    assert_eq!(listed["syncMode"], "read-write");

    // No statement in this project's migrations takes anything away from a
    // client, and a pending file is not a finding, so the scan is clean.
    assert_eq!(code(&lint), 0, "kizunasync lint:\n{}", stderr(&lint));
    assert!(
        stderr(&lint).contains("no schema changes touch a synced table"),
        "lint should report a clean scan, said:\n{}",
        stderr(&lint)
    );
}

// MARK: - the operator commands, read-only, against whatever is provisioned

/// `jobs`, `doctor`, and `status` read the pack's own bookkeeping, so they need
/// a provisioned database and write to none. `Some(url)` when one answers.
fn provisioned_url() -> Option<String> {
    let url = reachable()?;
    assert!(
        is_provisioned(&PgApplier::new(&url)),
        "[pg-it] {url} carries no Kizuna pack, so the operator commands have nothing to report. Run `bun run db:reset`."
    );

    Some(url)
}

/// Whether `pg_cron` is installed on the database `url` names. The three jobs
/// exist only where it is, and the commands say so rather than guessing.
fn has_pg_cron(url: &str) -> bool {
    PgApplier::new(url)
        .run_query(
            "select exists (select 1 from pg_extension where extname = 'pg_cron') as present;",
        )
        .ok()
        .and_then(|rows| {
            rows.first()
                .and_then(|row| require_string(row, "present").ok())
        })
        .is_some_and(|present| present == "t")
}

fn json_of(output: &Output) -> serde_json::Value {
    serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim())
        .expect("--json should print exactly one object")
}

/// The three jobs, their schedules, and the drift column, against a database
/// that has them. Without `pg_cron` the same command is exit 2 and says why: both
/// lanes are asserted, because which one runs is a property of the stack.
#[test]
fn jobs_list_reports_the_three_jobs_against_the_settings_schedules() {
    // The schedules these read are the same three another test restores,
    // so the read takes the live-stack guard for its whole body.
    let _live = live_stack_guard();
    let Some(url) = provisioned_url() else { return };
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync(
        dir.path(),
        &["jobs", "list", "--json", "--db-url", &url],
        &[],
    );
    let report = json_of(&output);
    let names: Vec<&str> = report["jobs"]
        .as_array()
        .expect("jobs is an array")
        .iter()
        .map(|job| job["name"].as_str().unwrap_or_default())
        .collect();

    assert_eq!(
        names,
        [
            "kizunasync-reap-tombstones",
            "kizunasync-compact-changelog",
            "kizunasync-prune-clients"
        ]
    );
    for job in report["jobs"].as_array().unwrap() {
        assert!(
            job["settingsSchedule"].is_string(),
            "every job carries the schedule kizunasync._settings declares: {job}"
        );
    }

    if has_pg_cron(&url) {
        eprintln!("[pg-it] pg_cron is installed: asserting the scheduled lane.");
        assert_eq!(
            code(&output),
            0,
            "kizunasync jobs list:\n{}",
            stderr(&output)
        );
        assert_eq!(report["pgCron"], true);
        for job in report["jobs"].as_array().unwrap() {
            assert!(
                job["schedule"].is_string(),
                "pg_cron holds all three jobs: {job}"
            );
            assert_eq!(job["drift"], false, "{job}");
            assert_eq!(job["schedule"], job["settingsSchedule"], "{job}");
        }

        return;
    }
    eprintln!("[pg-it] pg_cron is NOT installed: asserting the extension-absent lane.");
    assert_eq!(
        code(&output),
        2,
        "kizunasync jobs list:\n{}",
        stderr(&output)
    );
    assert_eq!(report["pgCron"], false);
    assert!(stderr(&output).contains("pg_cron is not installed"));
}

/// Every check `doctor` runs against the pack, on a database the pack is
/// installed in. A job that has never run is a warning, not a failure, so a
/// freshly reset stack is still green.
///
/// The `ledger` check reports what the database holds, so it fails while the
/// pack suite is running on the same database: `rpc-authz-rls.test.ts`
/// provisions `public._authz_*` into `kizunasync._config` with both triggers
/// and no `_provisions` row, which is exactly the state that check is for. The
/// report is true when it says that; the two suites are sequential lanes.
#[test]
fn doctor_reports_every_pack_check_on_a_provisioned_database() {
    // The schedules these read are the same three another test restores,
    // so the read takes the live-stack guard for its whole body.
    let _live = live_stack_guard();
    let Some(url) = provisioned_url() else { return };
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync(dir.path(), &["doctor", "--ci", "--db-url", &url], &[]);
    let body = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut levels: Vec<(String, String)> = Vec::new();
    for line in body.lines() {
        let value: serde_json::Value =
            serde_json::from_str(line).expect("each --ci line is one JSON object");
        levels.push((
            value["check"].as_str().unwrap_or_default().to_owned(),
            value["level"].as_str().unwrap_or_default().to_owned(),
        ));
    }
    let level_of = |id: &str| -> String {
        levels.iter().find(|(check, _)| check == id).map_or_else(
            || panic!("no check with id {id} in:\n{body}"),
            |(_, level)| level.clone(),
        )
    };

    // The filesystem checks fail against a temp directory, which is not what
    // this asserts: the pack half is.
    for id in [
        "config-tables",
        "core-rpcs",
        "triggers",
        "table-primary-key",
        "sync-key",
        "change-stamp",
        "realtime-policy",
        "role-and-grants",
        "column-privileges",
        "ledger",
    ] {
        assert_eq!(level_of(id), "ok", "{id} against {url}:\n{body}");
    }
    if has_pg_cron(&url) {
        assert_eq!(level_of("pg-cron"), "ok", "{body}");
        assert_eq!(level_of("jobs"), "ok", "{body}");
        assert!(
            ["ok", "warn"].contains(&level_of("job-runs").as_str()),
            "a job that has never run is a warning, not a failure:\n{body}"
        );

        return;
    }
    assert_eq!(level_of("pg-cron"), "error", "{body}");
    assert_eq!(level_of("jobs"), "warn", "{body}");
    assert_eq!(level_of("job-runs"), "warn", "{body}");
}

/// Every column of `public.todos` `authenticated` reads under the demo
/// migration's blanket `grant select on public.todos to authenticated`, so
/// restoring it (rather than re-granting `select (likes)` alone) is what
/// actually undoes the revoke below: a bare column-level grant would leave
/// `has_column_privilege` answering `false` for `likes` and `true` for
/// everything else regardless, because Postgres only stops folding the
/// table-level grant into a column once that table-level grant is gone.
const TODOS_COLUMNS_WITHOUT_LIKES: &str = "id, user_id, title, done, version, labels, image_path, updated_at, deleted_at, created_at, archived_at";

/// Re-grants table-level `select` on `public.todos` to `authenticated` when
/// dropped, so a panicking assertion still leaves the shared database as this
/// suite found it. The revoke this pairs with has to be committed for
/// `kizunasync doctor`, a separate process on its own connection, to see it, so
/// the two statements run as their own committed steps rather than inside one
/// open transaction; this guard is what makes the pair atomic to the rest of
/// the suite instead.
struct TodosSelectGuard<'a> {
    applier: &'a PgApplier,
}

impl Drop for TodosSelectGuard<'_> {
    fn drop(&mut self) {
        let _ = self.applier.run_script(&format!(
            "revoke select ({TODOS_COLUMNS_WITHOUT_LIKES}) on public.todos from authenticated;\n\
             grant select on public.todos to authenticated;"
        ));
    }
}

/// `kizunasync doctor`'s `column-privileges` check against a real revoke: the fake
/// applier proves the query shape, this proves Postgres actually answers
/// `has_column_privilege` and `has_table_privilege` the way that shape
/// assumes, including the table-level/column-level interaction above.
#[test]
fn doctor_warns_when_authenticated_cannot_read_a_synced_column() {
    let _live = live_stack_guard();
    let Some(url) = provisioned_url() else { return };
    let applier = PgApplier::new(&url);
    applier
        .run_script(&format!(
            "revoke select on public.todos from authenticated;\n\
             grant select ({TODOS_COLUMNS_WITHOUT_LIKES}) on public.todos to authenticated;"
        ))
        .unwrap();
    let _restore = TodosSelectGuard { applier: &applier };

    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync(dir.path(), &["doctor", "--ci", "--db-url", &url], &[]);
    let body = String::from_utf8_lossy(&output.stdout).into_owned();
    let line = body
        .lines()
        .find(|line| line.contains("\"column-privileges\""))
        .unwrap_or_else(|| panic!("no column-privileges check in:\n{body}"));
    let value: serde_json::Value = serde_json::from_str(line).unwrap();

    assert_eq!(value["level"], "warn", "{line}");
    assert!(
        value["message"]
            .as_str()
            .unwrap_or_default()
            .contains("likes is not readable by authenticated"),
        "{line}"
    );
}

/// Every section `status` grew, against the live pack. The numbers are whatever
/// the database holds; what this pins is that each section is populated rather
/// than null on a provisioned project.
#[test]
fn status_reports_every_operational_section_against_a_provisioned_database() {
    // The schedules these read are the same three another test restores,
    // so the read takes the live-stack guard for its whole body.
    let _live = live_stack_guard();
    let Some(url) = provisioned_url() else { return };
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync(dir.path(), &["status", "--json", "--db-url", &url], &[]);
    let report = json_of(&output);

    assert_eq!(code(&output), 0, "kizunasync status:\n{}", stderr(&output));
    assert!(report["clients"]["stale"].is_number(), "{report}");
    assert!(report["clients"]["ttlDays"].is_number(), "{report}");
    assert!(report["jobs"]["jobs"].is_array(), "{report}");
    assert_eq!(report["jobs"]["jobs"].as_array().unwrap().len(), 3);
    assert!(report["retention"]["changelogRows"].is_number(), "{report}");
    assert!(report["retention"]["tombstoneRows"].is_number(), "{report}");
    assert!(report["retention"]["tombstones"].is_array(), "{report}");
    assert!(report["journal"]["rows"].is_number(), "{report}");
    assert!(report["attachments"]["rows"].is_number(), "{report}");
    assert!(report["attachments"]["withSha"].is_number(), "{report}");
    assert!(report["attachments"]["buckets"].is_array(), "{report}");
}

// MARK: - the writing operator commands, on a scratch database only

/// The database name every destructive step in this file is pinned to. This
/// lane owns it, and it is the only part of this file that is isolated: the
/// read-only live tests above read the main database, which the pack suite
/// mutates mid-run, so the CLI live lane and the pack lane run one after the
/// other. The pack suite verifies pack SQL against its own `kizunasync_scratch`,
/// never this one. A purge drops the whole `kizunasync` schema, so the URL is
/// checked against this name before anything runs: a mistyped connection
/// cannot reach the stack's own database.
const SCRATCH_DATABASE: &str = "kizunasync_cli_scratch";

/// The vendor surface a bare `create database` does not carry. Compiled in, so
/// the scenario needs nothing on disk beside the binary it spawns.
const VENDOR_STUB: &str = include_str!("../../../scripts/pg-vendor-stub.sql");

/// A table of the project's own, created by this scenario and asserted to
/// survive the purge: a purge removes the sync bookkeeping, never the data the
/// app owns.
const SCRATCH_KEEP_TABLE: &str = "public.kizunasync_purge_keeps_this";

/// A view of the project's own over a pack table: what `deprovision` must
/// refuse to cascade into.
const SCRATCH_DEPENDENT_VIEW: &str = "public.kizunasync_purge_dependent_probe";

/// `Some(url)` when the scratch database answers, after building it if the
/// cluster does not carry it yet.
///
/// This lane owns `kizunasync_cli_scratch` end to end: it creates the database from
/// the maintenance connection every other test uses, applies the vendor stub
/// a bare `create database` does not carry, and leaves the pack itself to the
/// scenario, which installs it through `kizunasync init`. `None` is the one skip of
/// this file, taken when no database answers at all.
fn scratch_url() -> Option<String> {
    let url = std::env::var("KSYNC_SCRATCH_DB_URL").unwrap_or_else(|_| {
        format!("postgresql://postgres:postgres@127.0.0.1:55322/{SCRATCH_DATABASE}")
    });
    assert!(
        url.ends_with(&format!("/{SCRATCH_DATABASE}")),
        "[pg-it] KSYNC_SCRATCH_DB_URL must name the {SCRATCH_DATABASE} database; these steps drop a schema."
    );
    let maintenance = reachable()?;
    create_scratch_database(&maintenance);
    PgApplier::new(&url)
        .run_script(VENDOR_STUB)
        .unwrap_or_else(|cause| {
            panic!("[pg-it] scripts/pg-vendor-stub.sql does not apply to {url}. ({cause})")
        });
    if let Err(cause) = probe_db(&url) {
        panic!(
            "[pg-it] no {SCRATCH_DATABASE} database at {url}, after creating and stubbing it from {maintenance}. ({cause})"
        );
    }
    // Whatever the schema holds is not this gate's business: the scenario
    // drops it and provisions its own, so a database left behind by a purge or
    // by a half-finished run is all the same starting point.
    Some(url)
}

/// Create `kizunasync_cli_scratch` from the maintenance connection when
/// `pg_database` lacks it. A `create database` runs outside a transaction, so
/// it is the only statement in its script.
fn create_scratch_database(maintenance: &str) {
    let applier = PgApplier::new(maintenance);
    let present = applier
        .run_query(&format!(
            "select 1 as present from pg_database where datname = '{SCRATCH_DATABASE}';"
        ))
        .unwrap_or_else(|cause| {
            panic!("[pg-it] {maintenance} cannot be asked for {SCRATCH_DATABASE}. ({cause})")
        });
    if !present.is_empty() {
        return;
    }
    applier
        .run_script(&format!("create database {SCRATCH_DATABASE};"))
        .unwrap_or_else(|cause| {
            panic!("[pg-it] {maintenance} cannot create {SCRATCH_DATABASE}. ({cause})")
        });
}

/// A pack directory holding this checkout's `0001_kizuna_init.sql` byte for
/// byte, so its hash matches what the ledger records, plus one more file.
fn pack_with_extra(name: &str, sql: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::read_to_string(pack_migration()).unwrap();
    let migrations = dir.path().join("supabase/migrations");
    std::fs::create_dir_all(&migrations).unwrap();
    std::fs::write(migrations.join("0001_kizuna_init.sql"), &base).unwrap();
    std::fs::write(migrations.join(name), sql).unwrap();
    std::fs::write(
        dir.path().join("pack.manifest.json"),
        format!("{{\n  \"pack\": [\"0001_kizuna_init.sql\", \"{name}\"]\n}}\n"),
    )
    .unwrap();

    dir
}

/// The `--purge` warning line `docs/cli/cli.md` shows, which a purge of a
/// freshly installed pack must print word for word.
fn documented_purge_warning() -> String {
    let reference = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/cli/cli.md");
    let text = std::fs::read_to_string(&reference)
        .unwrap_or_else(|cause| panic!("{} should be readable: {cause}", reference.display()));

    text.lines()
        .find(|line| line.starts_with("  --purge also removes the kizunasync schema: "))
        .unwrap_or_else(|| panic!("{} shows no --purge warning", reference.display()))
        .to_owned()
}

/// One value from one row, loudly. A read that does not answer is a broken run,
/// never a default: swallowing a refused connection into an empty string turns
/// "too many clients" into "the schema is still there".
fn scalar(applier: &PgApplier, sql: &str, column: &str) -> String {
    let rows = applier
        .run_query(sql)
        .unwrap_or_else(|cause| panic!("{sql}\nfailed: {cause}"));
    let row = rows
        .first()
        .unwrap_or_else(|| panic!("{sql}\nreturned no row"));

    require_string(row, column).unwrap_or_else(|cause| panic!("{sql}\nread {column}: {cause}"))
}

fn table_exists(applier: &PgApplier, qualified: &str) -> bool {
    scalar(
        applier,
        &format!("select to_regclass('{qualified}') is not null as present;"),
        "present",
    ) == "t"
}

/// The operator arc that writes: an upgrade that rolls back, an upgrade that
/// commits, the three jobs run by hand, and a purge. All of it on the scratch
/// database, in one test so the steps cannot race each other.
// One arc, deliberately: each phase is the next one's fixture, and splitting it
// into four tests would let nextest run them in parallel against one database.
#[expect(clippy::too_many_lines)]
#[test]
fn the_operator_commands_upgrade_run_and_purge_a_scratch_database() {
    // Its own database, but the same `kizunasync._settings` shape and the same
    // guard, so no live test can be running while it upgrades and purges.
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let project = tempfile::tempdir().unwrap();
    std::fs::write(
        project.path().join("package.json"),
        r#"{"dependencies":{}}"#,
    )
    .unwrap();
    std::fs::create_dir_all(project.path().join("supabase/migrations")).unwrap();

    // The scenario owns this database's schema state end to end, so it starts
    // by removing whatever is there: a purge this test made, or a half-finished
    // run. Nothing carries over, and nothing outside this file has to have run
    // first.
    assert!(
        url.ends_with(&format!("/{SCRATCH_DATABASE}")),
        "refusing to drop a schema on {url}: only {SCRATCH_DATABASE} is disposable"
    );
    applier
        .run_script(&format!(
            "drop table if exists public.kizunasync_upgrade_probe;\ncreate table if not exists {SCRATCH_KEEP_TABLE} (id integer primary key);\ndrop schema if exists kizunasync cascade;",
        ))
        .unwrap();

    // `upgrade` reconciles a per-file ledger, and the pack's own seed records
    // objects rather than files, so the starting state has to be an install
    // `kizunasync init` made: its migration is the pack plus the one `pack-file`
    // row, and `--local-only` writes it without applying, which is what lets
    // this apply it over the connection the run already names.
    let installed = kizunasync(
        project.path(),
        &[
            "init",
            "--local-only",
            "--yes",
            "--allow-no-cron",
            "--db-url",
            &url,
        ],
        &[],
    );
    assert_eq!(
        code(&installed),
        0,
        "kizunasync init:\n{}",
        stderr(&installed)
    );
    let (init_name, init_sql) = migration_ending_in(project.path(), "_kizunasync_init.sql")
        .expect("kizunasync init should write a *_kizunasync_init.sql migration");
    applier
        .run_script(&init_sql)
        .unwrap_or_else(|cause| panic!("{init_name} should apply to {SCRATCH_DATABASE}: {cause}"));

    // MARK: - an upgrade whose second statement raises
    let failing = pack_with_extra(
        "0002_kizunasync_upgrade_probe.sql",
        "create table public.kizunasync_upgrade_probe (id integer primary key);\nselect 1 / 0;\n",
    );
    let failing_env = [(
        "KSYNC_PACK_DIR",
        failing.path().to_string_lossy().into_owned(),
    )];
    let failing_env: Vec<(&str, &str)> = failing_env
        .iter()
        .map(|(key, value)| (*key, value.as_str()))
        .collect();

    let dry = kizunasync(
        project.path(),
        &["upgrade", "--dry-run", "--db-url", &url],
        &failing_env,
    );
    let dry_sql = String::from_utf8_lossy(&dry.stdout).into_owned();

    let raised = kizunasync(
        project.path(),
        &["upgrade", "--yes", "--db-url", &url],
        &failing_env,
    );
    let probe_after_failure = table_exists(&applier, "public.kizunasync_upgrade_probe");
    let ledger_after_failure = scalar(
        &applier,
        "select count(*)::text as count from kizunasync._provisions where object_kind = 'pack-file' and object_name = '0002_kizunasync_upgrade_probe.sql';",
        "count",
    );

    assert_eq!(
        code(&dry),
        0,
        "kizunasync upgrade --dry-run:\n{}",
        stderr(&dry)
    );
    assert!(dry_sql.contains("begin;"), "{dry_sql}");
    assert!(
        dry_sql.contains("create table public.kizunasync_upgrade_probe"),
        "{dry_sql}"
    );
    assert!(dry_sql.trim_end().ends_with("commit;"), "{dry_sql}");
    assert!(
        !table_exists(&applier, "public.kizunasync_upgrade_probe") || probe_after_failure,
        "a dry run writes nothing"
    );

    assert_eq!(
        code(&raised),
        1,
        "an upgrade whose SQL raises is a failure:\n{}",
        stderr(&raised)
    );
    assert!(
        stderr(&raised).contains("nothing was applied and no ledger row was written"),
        "{}",
        stderr(&raised)
    );
    assert!(
        !probe_after_failure,
        "the table the first statement created must roll back with the batch"
    );
    assert_eq!(
        ledger_after_failure, "0",
        "a rolled-back file must not be recorded"
    );

    // MARK: - an upgrade that commits, and the schedules it re-applies
    let good = pack_with_extra(
        "0002_kizunasync_upgrade_probe.sql",
        "create table if not exists public.kizunasync_upgrade_probe (id integer primary key);\n",
    );
    let good_env = [("KSYNC_PACK_DIR", good.path().to_string_lossy().into_owned())];
    let good_env: Vec<(&str, &str)> = good_env
        .iter()
        .map(|(key, value)| (*key, value.as_str()))
        .collect();
    let committed = kizunasync(
        project.path(),
        &["upgrade", "--yes", "--db-url", &url],
        &good_env,
    );
    let probe_after_commit = table_exists(&applier, "public.kizunasync_upgrade_probe");
    let ledger_after_commit = scalar(
        &applier,
        "select count(*)::text as count from kizunasync._provisions where object_kind = 'pack-file' and object_name = '0002_kizunasync_upgrade_probe.sql';",
        "count",
    );

    assert_eq!(
        code(&committed),
        0,
        "kizunasync upgrade:\n{}",
        stderr(&committed)
    );
    assert!(probe_after_commit, "the applied file's table is there");
    assert_eq!(ledger_after_commit, "1", "and the ledger records it");
    assert!(
        stderr(&committed).contains("job schedules"),
        "an apply re-applies the kizunasync._settings schedules:\n{}",
        stderr(&committed)
    );

    // MARK: - the three jobs, run by hand
    let ran = kizunasync(
        project.path(),
        &["jobs", "run", "all", "--json", "--db-url", &url],
        &[],
    );
    let runs = json_of(&ran);

    assert_eq!(code(&ran), 0, "kizunasync jobs run all:\n{}", stderr(&ran));
    assert_eq!(
        runs["ran"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| run["function"].as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        [
            "kizunasync.reap_tombstones",
            "kizunasync.compact_changelog",
            "kizunasync.prune_clients"
        ]
    );
    for run in runs["ran"].as_array().unwrap() {
        assert!(run["count"].is_number(), "{run}");
    }

    // MARK: - a purge, which needs the target typed out
    let unconfirmed = kizunasync(
        project.path(),
        &["deprovision", "--purge", "--yes", "--db-url", &url],
        &[],
    );
    let schema_after_refusal = scalar(
        &applier,
        "select count(*)::text as count from pg_namespace where nspname = 'kizunasync';",
        "count",
    );

    assert_eq!(code(&unconfirmed), 2, "{}", stderr(&unconfirmed));
    assert!(
        stderr(&unconfirmed).contains("--yes alone does not apply it"),
        "{}",
        stderr(&unconfirmed)
    );
    assert_eq!(schema_after_refusal, "1", "a refused purge drops nothing");

    // MARK: - a view over a pack table stops the purge that would cascade into it
    applier
        .run_script(&format!(
            "create view {SCRATCH_DEPENDENT_VIEW} as select seq from kizunasync._changelog;"
        ))
        .unwrap();
    let refused = kizunasync(
        project.path(),
        &[
            "deprovision",
            "--purge",
            "--yes",
            "--confirm",
            "local",
            "--db-url",
            &url,
        ],
        &[],
    );
    let view_after_refusal = table_exists(&applier, SCRATCH_DEPENDENT_VIEW);
    let schema_after_dependent = scalar(
        &applier,
        "select count(*)::text as count from pg_namespace where nspname = 'kizunasync';",
        "count",
    );

    assert_eq!(code(&refused), 2, "{}", stderr(&refused));
    assert!(
        stderr(&refused).contains(&format!(
            "! view {SCRATCH_DEPENDENT_VIEW} depends on table kizunasync._changelog"
        )),
        "{}",
        stderr(&refused)
    );
    assert!(
        !stderr(&refused).contains("! trigger"),
        "the pack's own triggers are not dependents:\n{}",
        stderr(&refused)
    );
    assert!(
        view_after_refusal,
        "the dependent view survives the refusal"
    );
    assert_eq!(schema_after_dependent, "1", "and so does the schema");
    applier
        .run_script(&format!("drop view {SCRATCH_DEPENDENT_VIEW};"))
        .unwrap();

    let purged = kizunasync(
        project.path(),
        &[
            "deprovision",
            "--purge",
            "--yes",
            "--confirm",
            "local",
            "--db-url",
            &url,
        ],
        &[],
    );
    let schema_after_purge = scalar(
        &applier,
        "select count(*)::text as count from pg_namespace where nspname = 'kizunasync';",
        "count",
    );
    let own_table = table_exists(&applier, SCRATCH_KEEP_TABLE);

    assert_eq!(
        code(&purged),
        0,
        "kizunasync deprovision --purge:\n{}",
        stderr(&purged)
    );
    assert!(
        String::from_utf8_lossy(&purged.stdout)
            .contains("[purge] drop schema if exists kizunasync cascade;"),
        "the plan names what it drops:\n{}",
        String::from_utf8_lossy(&purged.stdout)
    );
    assert!(
        stderr(&purged).contains("purged the kizunasync schema:"),
        "{}",
        stderr(&purged)
    );
    assert!(
        stderr(&purged)
            .lines()
            .any(|line| line == documented_purge_warning()),
        "docs/cli/cli.md shows the warning this purge printed:\n{}",
        stderr(&purged)
    );
    assert_eq!(schema_after_purge, "0", "the schema is gone");
    assert!(own_table, "the project's own tables are untouched");
}

// MARK: - a role another database of the cluster still uses

/// A second database of the scratch cluster, where the pack's role owns a
/// schema the way a Kizuna install there owns its functions. This lane creates
/// it when it is missing and drops it when the test ends.
const PEER_DATABASE: &str = "kizunasync_cli_scratch_peer";

/// The schema the pack's role owns in [`PEER_DATABASE`].
const PEER_SCHEMA: &str = "kizunasync_cli_peer";

/// Drops [`PEER_DATABASE`] however the test ends, over the maintenance
/// connection, so the cluster keeps nothing this lane made.
struct PeerDatabase(PgApplier);

impl Drop for PeerDatabase {
    fn drop(&mut self) {
        let _ = self.0.run_script(&format!(
            "drop database if exists {PEER_DATABASE} with (force);"
        ));
    }
}

/// [`PEER_DATABASE`] on the cluster `scratch` names, with a schema the pack's
/// role owns.
fn peer_owned_by_the_role(scratch: &str) -> PeerDatabase {
    let maintenance = PgApplier::new(&scratch.replace(SCRATCH_DATABASE, "postgres"));
    let present = maintenance
        .run_query(&format!(
            "select 1 as present from pg_database where datname = '{PEER_DATABASE}';"
        ))
        .unwrap();
    if present.is_empty() {
        maintenance
            .run_script(&format!("create database {PEER_DATABASE};"))
            .unwrap_or_else(|cause| panic!("[pg-it] cannot create {PEER_DATABASE}. ({cause})"));
    }
    let peer = PeerDatabase(maintenance);
    PgApplier::new(&scratch.replace(SCRATCH_DATABASE, PEER_DATABASE))
        .run_script(&format!(
            "drop schema if exists {PEER_SCHEMA};\ncreate schema {PEER_SCHEMA} authorization kizunasync_rls;"
        ))
        .unwrap_or_else(|cause| {
            panic!("[pg-it] {PEER_DATABASE} refused the peer schema. ({cause})")
        });

    peer
}

/// `kizunasync_rls` is a cluster role. A teardown in one database drops what
/// the role owns there, then keeps the role while another database still
/// owns objects through it: the run succeeds and says how to drop it later.
#[test]
fn a_teardown_keeps_the_role_another_database_still_uses() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let project = install_scratch(&applier, &url, &env);
    let peer = peer_owned_by_the_role(&url);

    let removed = kizunasync(
        project.path(),
        &["deprovision", "--yes", "--db-url", &url],
        &env,
    );
    let roles = scalar(
        &applier,
        "select count(*)::text as count from pg_roles where rolname = 'kizunasync_rls';",
        "count",
    );
    let owned_here = scalar(
        &applier,
        "select count(*)::text as count from pg_shdepend d join pg_database db on db.oid = d.dbid join pg_roles r on r.oid = d.refobjid where r.rolname = 'kizunasync_rls' and db.datname = current_database();",
        "count",
    );
    let ledgered = scalar(
        &applier,
        "select count(*)::text as count from kizunasync._provisions where object_kind in ('role', 'function');",
        "count",
    );
    drop(peer);
    let peers_left = scalar(
        &PgApplier::new(&url.replace(SCRATCH_DATABASE, "postgres")),
        &format!(
            "select count(*)::text as count from pg_database where datname = '{PEER_DATABASE}';"
        ),
        "count",
    );

    assert_eq!(code(&removed), 0, "{}", stderr(&removed));
    assert!(
        stderr(&removed)
            .contains("kept the role kizunasync_rls: other databases of this server still use it."),
        "{}",
        stderr(&removed)
    );
    assert!(
        stderr(&removed).contains("then `drop role kizunasync_rls;`"),
        "{}",
        stderr(&removed)
    );
    assert_eq!(roles, "1", "the role another database uses stays");
    assert_eq!(owned_here, "0", "the role owns nothing in this database");
    assert_eq!(
        ledgered, "0",
        "the ledgered functions and role row are gone"
    );
    assert_eq!(peers_left, "0", "the test drops the database it created");
}

/// How many teardown scripts on this database are in `state`, and, when
/// `waiting` is set, waiting on a lock.
fn teardowns(applier: &PgApplier, waiting: bool) -> String {
    let lock = if waiting {
        " and wait_event_type = 'Lock'"
    } else {
        ""
    };
    scalar(
        applier,
        &format!(
            "select count(*)::text as count from pg_stat_activity where datname = current_database() and state = 'active'{lock} and query like '-- Generated by `kizunasync deprovision`%';"
        ),
        "count",
    )
}

/// Polls `done` every 50 ms, failing the test after `limit`.
fn wait_for(limit: std::time::Duration, what: &str, mut done: impl FnMut() -> bool) {
    let started = std::time::Instant::now();
    while !done() {
        assert!(started.elapsed() < limit, "[pg-it] {what}");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Ctrl+C while a teardown waits on a lock another session holds. The run
/// exits `130` and says the transaction was not applied, and that stays true
/// once the lock is released: the pack is still installed, ledger and
/// functions alike, because the statement was cancelled on the server rather
/// than left to commit after the process was gone.
#[cfg(unix)]
#[test]
fn ctrl_c_during_a_teardown_waiting_on_a_lock_leaves_the_pack_installed() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let project = install_scratch(&applier, &url, &[("KSYNC_PACK_DIR", pack_path.as_str())]);
    let count = |sql: &str| scalar(&applier, sql, "count");
    let ledger = "select count(*)::text as count from kizunasync._provisions;";
    let functions = "select count(*)::text as count from pg_proc where pronamespace = 'kizunasync'::regnamespace;";
    let ledger_before = count(ledger);
    let functions_before = count(functions);
    let mut holder = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    holder
        .batch_execute("begin; lock table realtime.messages in access exclusive mode;")
        .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_kizunasync"))
        .current_dir(project.path())
        .args(["deprovision", "--yes", "--db-url", &url])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("KSYNC_PACK_DIR", &pack_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    wait_for(
        std::time::Duration::from_secs(30),
        "the teardown never waited on the held lock",
        || teardowns(&applier, true) == "1",
    );
    let interrupted = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(interrupted.success());
    let mut status = None;
    wait_for(
        std::time::Duration::from_secs(20),
        "kizunasync kept running after Ctrl+C",
        || {
            status = child.try_wait().unwrap();
            status.is_some()
        },
    );
    holder.batch_execute("rollback;").unwrap();
    wait_for(
        std::time::Duration::from_secs(20),
        "the teardown was still running after the lock was released",
        || teardowns(&applier, false) == "0",
    );
    let output = child.wait_with_output().unwrap();
    let said = String::from_utf8_lossy(&output.stderr);

    assert_eq!(status.and_then(|ended| ended.code()), Some(130), "{said}");
    assert!(
        said.contains("interrupted: the transaction in progress was not applied"),
        "{said}"
    );
    assert_eq!(count(ledger), ledger_before, "the ledger keeps every row");
    assert_eq!(
        count(functions),
        functions_before,
        "every pack function is still installed"
    );
}

/// A `supabase` on `PATH` that records the signals it gets and runs until one
/// of them stops it. It writes its process id to the ready file once its
/// traps are in place.
const HANGING_SUPABASE: &str = "#!/bin/sh\n\
trap 'echo INT >> \"$KSYNC_TEST_SIGNALS\"; exit 130' INT\n\
trap 'echo TERM >> \"$KSYNC_TEST_SIGNALS\"; exit 143' TERM\n\
echo $$ > \"$KSYNC_TEST_READY.tmp\" && mv \"$KSYNC_TEST_READY.tmp\" \"$KSYNC_TEST_READY\"\n\
while :; do sleep 0.05; done\n";

/// Kills the stand-in `supabase` however the test ends, so a run that never
/// stopped it leaves no process behind.
struct Stray(std::path::PathBuf);

impl Drop for Stray {
    fn drop(&mut self) {
        if let Ok(pid) = std::fs::read_to_string(&self.0) {
            let _ = Command::new("kill").args(["-KILL", pid.trim()]).status();
        }
    }
}

/// Ctrl+C while `supabase db push` runs. The CLI interrupts the push, waits
/// for it to exit, reads the migration history again, and removes the file
/// it wrote that the history does not record, so a later run never meets it.
/// It exits `130` and names the file it removed; the database and its
/// migration history are as they were.
#[cfg(unix)]
#[test]
fn ctrl_c_during_a_push_removes_the_migration_it_never_applied() {
    use std::os::unix::fs::PermissionsExt;

    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let project = install_scratch(&applier, &url, &[("KSYNC_PACK_DIR", pack_path.as_str())]);
    let batch_size =
        "select coalesce(max_batch_size::text, 'none') as count from kizunasync._settings;";
    let batch_before = scalar(&applier, batch_size, "count");
    let history_before = read_applied_migrations(&applier).unwrap();
    let bin = tempfile::tempdir().unwrap();
    let fake = bin.path().join("supabase");
    std::fs::write(&fake, HANGING_SUPABASE).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let signals = bin.path().join("signals");
    let ready = bin.path().join("ready");
    let _stray = Stray(ready.clone());
    let path = format!(
        "{}:{}",
        bin.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let mut child = Command::new(env!("CARGO_BIN_EXE_kizunasync"))
        .current_dir(project.path())
        .args(["sync", "--max-batch-size", "321", "--yes", "--db-url", &url])
        .env_clear()
        .env("PATH", &path)
        .env("KSYNC_PACK_DIR", &pack_path)
        .env("KSYNC_TEST_SIGNALS", &signals)
        .env("KSYNC_TEST_READY", &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    wait_for(
        std::time::Duration::from_secs(30),
        "supabase db push never started",
        || ready.exists(),
    );
    let written = migration_names(project.path())
        .into_iter()
        .find(|name| name.ends_with("_kizunasync_sync.sql"))
        .expect("the delta is on disk while the push runs");
    let interrupted = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(interrupted.success());
    let mut status = None;
    wait_for(
        std::time::Duration::from_secs(20),
        "kizunasync kept running after Ctrl+C",
        || {
            status = child.try_wait().unwrap();
            status.is_some()
        },
    );
    let output = child.wait_with_output().unwrap();
    let said = String::from_utf8_lossy(&output.stderr);

    assert_eq!(status.and_then(|ended| ended.code()), Some(130), "{said}");
    assert_eq!(
        std::fs::read_to_string(&signals).unwrap_or_default(),
        "INT\n",
        "the push got SIGINT and stopped on it"
    );
    assert!(
        !migration_names(project.path()).contains(&written),
        "{written} was never applied, so it is gone"
    );
    assert!(
        said.contains(&format!(
            "removed: {written} (the migration history does not record it, so it was never applied)"
        )),
        "{said}"
    );
    assert!(!said.contains("was not applied (Postgres"), "{said}");
    assert_eq!(scalar(&applier, batch_size, "count"), batch_before);
    assert_eq!(read_applied_migrations(&applier).unwrap(), history_before);
}

// MARK: - a re-applied pack, on the scratch database only

/// The checks `doctor` runs against the pack, and whether each one needs
/// `pg_cron` to pass. The scratch database cannot carry the extension, since
/// `pg_cron` installs only into the database cron runs in.
const PACK_CHECKS: [(&str, bool); 15] = [
    ("pg-cron", true),
    ("jobs", true),
    ("job-runs", true),
    ("core-rpcs", false),
    ("triggers", false),
    ("table-primary-key", false),
    ("sync-key", false),
    ("rls-enabled", false),
    ("trigger-search-path", false),
    ("change-stamp", false),
    ("realtime-policy", false),
    ("role-and-grants", false),
    ("column-privileges", false),
    ("require-atomic", false),
    ("ledger", false),
];

/// One operator value, then one broken object for each pack check a re-apply
/// has to repair: the wakeup policy, a grant `role-and-grants` reads, the
/// stamp's arm trigger, its marker table with the transaction trigger on it,
/// its sequence's cache, and a leaf helper nothing depends on.
const BREAK_THE_PACK: &str = "update kizunasync._settings set tombstone_ttl_days = 45 where id;\n\
     drop policy \"kizunasync wakeup receive\" on realtime.messages;\n\
     revoke execute on function kizunasync.jobs_status() from service_role;\n\
     drop trigger kizunasync_arm_stamp on kizunasync._change_pending;\n\
     drop table kizunasync._stamp_marker;\n\
     alter sequence kizunasync._change_seq cache 20;\n\
     drop function kizunasync._encode_cursor(bigint, bigint[]);";

/// `check → (level, message)`, one entry per `kizunasync doctor --ci` line.
type DoctorReport = std::collections::BTreeMap<String, (String, String)>;

/// A pack directory holding this checkout's `0001_kizuna_init.sql` as it read
/// when the test started, so `init` and every `upgrade` hash the same bytes.
fn pack_copy() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let migrations = dir.path().join("supabase/migrations");
    std::fs::create_dir_all(&migrations).unwrap();
    std::fs::copy(pack_migration(), migrations.join("0001_kizuna_init.sql")).unwrap();
    std::fs::write(
        dir.path().join("pack.manifest.json"),
        "{ \"pack\": [\"0001_kizuna_init.sql\"] }\n",
    )
    .unwrap();

    dir
}

/// A project the scratch database holds as `kizunasync init` provisions it: the
/// schema dropped, then the migration `init --local-only` writes, applied over
/// the same connection the operator arc uses.
fn install_scratch(applier: &PgApplier, url: &str, env: &[(&str, &str)]) -> tempfile::TempDir {
    assert!(
        url.ends_with(&format!("/{SCRATCH_DATABASE}")),
        "refusing to drop a schema on {url}: only {SCRATCH_DATABASE} is disposable"
    );
    applier
        .run_script("drop schema if exists kizunasync cascade;")
        .unwrap();
    let project = tempfile::tempdir().unwrap();
    std::fs::write(
        project.path().join("package.json"),
        r#"{"dependencies":{}}"#,
    )
    .unwrap();
    std::fs::create_dir_all(project.path().join("supabase/migrations")).unwrap();

    let installed = kizunasync(
        project.path(),
        &[
            "init",
            "--local-only",
            "--yes",
            "--allow-no-cron",
            "--db-url",
            url,
        ],
        env,
    );
    assert_eq!(
        code(&installed),
        0,
        "kizunasync init:\n{}",
        stderr(&installed)
    );
    let (name, sql) = migration_ending_in(project.path(), "_kizunasync_init.sql")
        .expect("kizunasync init should write a *_kizunasync_init.sql migration");
    applier
        .run_script(&sql)
        .unwrap_or_else(|cause| panic!("{name} should apply to {SCRATCH_DATABASE}: {cause}"));

    project
}

fn reapply(project: &Path, url: &str, env: &[(&str, &str)]) -> Output {
    kizunasync(
        project,
        &["upgrade", "--reapply", "--yes", "--db-url", url],
        env,
    )
}

fn doctor_report(project: &Path, url: &str) -> DoctorReport {
    let output = kizunasync(project, &["doctor", "--ci", "--db-url", url], &[]);

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| {
            let value: serde_json::Value =
                serde_json::from_str(line).expect("each --ci line is one JSON object");
            let field = |key: &str| value[key].as_str().unwrap_or_default().to_owned();

            (field("check"), (field("level"), field("message")))
        })
        .collect()
}

/// Every pack check is `ok`, bar the ones only `pg_cron` can pass when this
/// database has none.
fn assert_pack_checks_pass(report: &DoctorReport, pg_cron: bool, when: &str) {
    assert_pack_checks_pass_but(report, pg_cron, when, "");
}

/// [`assert_pack_checks_pass`], leaving `but` to the caller.
fn assert_pack_checks_pass_but(report: &DoctorReport, pg_cron: bool, when: &str, but: &str) {
    for (id, needs_cron) in PACK_CHECKS {
        if id == but || (needs_cron && !pg_cron) {
            continue;
        }
        let Some((level, message)) = report.get(id) else {
            panic!("{when}: no {id} check in {report:?}");
        };

        assert_eq!(level, "ok", "{when}: {id}: {message}");
    }
}

/// `kizunasync upgrade --reapply --yes` over an up-to-date install. It runs twice
/// cleanly, then puts back every object [`BREAK_THE_PACK`] broke, writes no
/// ledger row, and leaves the operator's own setting as it found it.
#[test]
fn a_re_applied_pack_restores_what_was_broken_and_keeps_operator_data() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let project = install_scratch(&applier, &url, &env);
    let pg_cron = has_pg_cron(&url);

    for run in ["the first re-apply", "the second re-apply"] {
        let output = reapply(project.path(), &url, &env);

        assert_eq!(code(&output), 0, "{run}:\n{}", stderr(&output));
        assert!(
            stderr(&output).contains("re-applied 1 pack file(s)."),
            "{run}:\n{}",
            stderr(&output)
        );
        assert_pack_checks_pass(&doctor_report(project.path(), &url), pg_cron, run);
    }

    let ledger_rows = "select count(*)::text as count from kizunasync._provisions;";
    let rows_before = scalar(&applier, ledger_rows, "count");
    applier.run_script(BREAK_THE_PACK).unwrap();
    let broken = doctor_report(project.path(), &url);
    let repair = reapply(project.path(), &url, &env);
    let repaired = doctor_report(project.path(), &url);
    let ttl = scalar(
        &applier,
        "select tombstone_ttl_days::text as ttl from kizunasync._settings where id;",
        "ttl",
    );
    let rows_after = scalar(&applier, ledger_rows, "count");

    for (id, fault) in [
        ("realtime-policy", "kizunasync upgrade --reapply --yes"),
        (
            "role-and-grants",
            "service_role cannot execute: jobs_status",
        ),
        (
            "change-stamp",
            "the stamp trigger kizunasync_arm_stamp is missing on kizunasync._change_pending",
        ),
        (
            "change-stamp",
            "the stamp marker table kizunasync._stamp_marker is missing, and the stamp trigger kizunasync_stamp_transaction with it",
        ),
        ("change-stamp", "kizunasync._change_seq caches 20 values"),
        ("ledger", "[function] kizunasync._encode_cursor"),
        (
            "ledger",
            "[policy] realtime.messages.kizunasync wakeup receive",
        ),
    ] {
        let Some((level, message)) = broken.get(id) else {
            panic!("no {id} check in {broken:?}");
        };

        assert_eq!(level, "error", "{id} after the break: {message}");
        assert!(message.contains(fault), "{id}: {message}");
    }
    assert_eq!(
        code(&repair),
        0,
        "the repairing re-apply:\n{}",
        stderr(&repair)
    );
    assert_pack_checks_pass(&repaired, pg_cron, "after the repair");
    assert_eq!(ttl, "45", "the operator's tombstone_ttl_days survives");
    assert_eq!(rows_after, rows_before, "a re-apply writes no ledger row");
}

/// A re-apply script planned against one ledger and run after another run
/// changed it: the re-check raises inside the script's own transaction, so the
/// pack does not run and the ledger keeps the other run's row.
#[test]
fn a_re_apply_script_rolls_back_when_the_ledger_changed_after_the_plan() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let _project = install_scratch(&applier, &url, &env);
    let files = read_pack_files(pack.path()).unwrap();
    let plan = plan_provision(&files, &read_ledger_rows(&applier).unwrap());
    assert!(matches!(plan, Plan::UpToDate { .. }), "{plan:?}");

    applier
        .run_script(
            "drop policy \"kizunasync wakeup receive\" on realtime.messages;\n\
             update kizunasync._provisions set content_hash = 'another-run' where object_kind = 'pack-file';",
        )
        .unwrap();
    let outcome = applier.run_script(&render_reapply(&plan));
    let policy = scalar(
        &applier,
        "select exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'kizunasync wakeup receive')::text as present;",
        "present",
    );
    let recorded = scalar(
        &applier,
        "select content_hash from kizunasync._provisions where object_kind = 'pack-file';",
        "content_hash",
    );

    let Err(cause) = outcome else {
        panic!("the re-apply ran over a ledger another run changed after the plan");
    };
    assert!(
        cause.to_string().contains("the provision ledger changed"),
        "{cause}"
    );
    assert_eq!(policy, "false", "the pack must not have run");
    assert_eq!(recorded, "another-run", "the other run's row stays");
}

/// A fresh install is one transaction: a pack whose last file fails leaves no
/// schema and no ledger row behind, and the same script over the shipped pack
/// then lands every file, its ledger row, and the project config after it.
#[test]
fn a_fresh_install_script_is_one_transaction() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    assert!(
        url.ends_with(&format!("/{SCRATCH_DATABASE}")),
        "refusing to drop a schema on {url}: only {SCRATCH_DATABASE} is disposable"
    );
    applier
        .run_script("drop schema if exists kizunasync cascade;")
        .unwrap();
    let shipped = read_pack_files(&pack_dir()).unwrap();
    let config = "update kizunasync._settings set tombstone_ttl_days = 45 where id;";

    let mut failing = shipped.clone();
    failing.push(kizunasync_cli::pack::PackFile {
        name: "9999_kizunasync_fails.sql".to_owned(),
        sql: "select 1 / 0;".to_owned(),
    });
    let broken = applier.run_script(&render_install(&plan_provision(&failing, &[]), config));
    let ledger_after_failure = table_exists(&applier, "kizunasync._provisions");

    assert!(broken.is_err(), "a pack whose last file fails must fail");
    assert!(
        !ledger_after_failure,
        "the failed install left the pack behind: it did not run as one transaction"
    );

    applier
        .run_script(&render_install(&plan_provision(&shipped, &[]), config))
        .unwrap_or_else(|cause| panic!("the shipped pack should install: {cause}"));
    let recorded = scalar(
        &applier,
        "select string_agg(object_name, ',' order by object_name) as names from kizunasync._provisions where object_kind = 'pack-file';",
        "names",
    );
    let ttl = scalar(
        &applier,
        "select tombstone_ttl_days::text as ttl from kizunasync._settings;",
        "ttl",
    );
    let mut names: Vec<String> = shipped.iter().map(|file| file.name.clone()).collect();
    names.sort();

    assert_eq!(recorded, names.join(","), "one ledger row per pack file");
    assert_eq!(
        ttl, "45",
        "the project config ran after the pack, inside it"
    );
}

// MARK: - a synced table of the project's own, on the scratch database only

/// The table the scratch scenarios below sync. Created and dropped by each of
/// them, never by anything else.
const SCRATCH_SYNCED_TABLE: &str = "kizunasync_scratch_items";

/// A trigger function of the project's own on that table, created without a
/// `search_path` of its own.
const SCRATCH_TRIGGER_FUNCTION: &str = "public.kizunasync_scratch_touch";

/// A project directory with nothing but a migrations directory, so every
/// `sync --local-only` run writes its one migration into a directory of its
/// own.
fn empty_project() -> tempfile::TempDir {
    let project = tempfile::tempdir().unwrap();
    std::fs::write(
        project.path().join("package.json"),
        r#"{"dependencies":{}}"#,
    )
    .unwrap();
    std::fs::create_dir_all(project.path().join("supabase/migrations")).unwrap();

    project
}

/// `kizunasync sync <args> --yes --local-only --db-url <url>` from a fresh
/// project, then the migration it wrote, applied over the same connection.
/// `None` when the run wrote none.
fn sync_and_apply(
    applier: &PgApplier,
    url: &str,
    env: &[(&str, &str)],
    args: &[&str],
) -> (Output, Option<String>) {
    let project = empty_project();
    let mut command = vec!["sync"];
    command.extend_from_slice(args);
    command.extend_from_slice(&["--yes", "--local-only", "--db-url", url]);
    let output = kizunasync(project.path(), &command, env);
    let written = migration_ending_in(project.path(), "_kizunasync_sync.sql");
    if let Some((name, sql)) = &written {
        applier
            .run_script(sql)
            .unwrap_or_else(|cause| panic!("{name} should apply to {SCRATCH_DATABASE}: {cause}"));
    }

    (output, written.map(|(_, sql)| sql))
}

/// Stop syncing `tables` the way `kizunasync sync --remove` does, then drop
/// them. The scratch tests share one database, and one that left a
/// `_config` row, a trigger, or a ledger row for a table it dropped would
/// fail the pack checks of the next.
fn unsync_and_drop(applier: &PgApplier, tables: &[&str]) {
    let undo = render_sync_delta_sql(&DeltaInput {
        removed: tables.iter().map(|table| (*table).to_owned()).collect(),
        ..DeltaInput::default()
    });
    applier.run_script(&undo).unwrap();
    applier
        .run_script(&format!(
            "drop table if exists public.{};",
            tables.join(", public.")
        ))
        .unwrap();
}

/// A table keyed by a `numeric` column, whose text form is not the same on
/// the device, and one with no primary key, on the scratch database only,
/// each with the reason its refusal gives.
const SCRATCH_UNKEYED: [(&str, &str, &str); 2] = [
    (
        "kizunasync_scratch_priced",
        "(amount numeric primary key, title text)",
        "its key column amount is numeric, and its text form is not identical on the device and on the server",
    ),
    (
        "kizunasync_scratch_keyless",
        "(title text)",
        "it has no primary key, and the pack keys every change by the table's primary key",
    ),
];

/// `sync --add` reads each table's primary key from the real catalog: a
/// numeric key and a missing key are refused on exit 2, writing nothing, and
/// a uuid `id` table still provisions.
#[test]
fn add_refuses_a_table_the_pack_cannot_key_and_writes_nothing() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let _project = install_scratch(&applier, &url, &env);
    let create = SCRATCH_UNKEYED
        .iter()
        .map(|(table, shape, _)| {
            format!("drop table if exists public.{table};\ncreate table public.{table} {shape};")
        })
        .collect::<Vec<_>>()
        .join("\n");
    applier
        .run_script(&format!(
            "{create}\ndrop table if exists public.{SCRATCH_SYNCED_TABLE};\n\
             create table public.{SCRATCH_SYNCED_TABLE} (id uuid primary key default gen_random_uuid(), title text);"
        ))
        .unwrap();
    let before = written_state(&applier);
    let refused: Vec<(Output, Option<String>)> = SCRATCH_UNKEYED
        .iter()
        .map(|(table, _, _)| {
            sync_and_apply(&applier, &url, &env, &["--add", table, "--allow-no-rls"])
        })
        .collect();
    let after_refusals = written_state(&applier);
    let (keyed, keyed_sql) = sync_and_apply(
        &applier,
        &url,
        &env,
        &["--add", SCRATCH_SYNCED_TABLE, "--allow-no-rls"],
    );
    let tables: Vec<&str> = SCRATCH_UNKEYED
        .iter()
        .map(|(table, _, _)| *table)
        .chain([SCRATCH_SYNCED_TABLE])
        .collect();
    unsync_and_drop(&applier, &tables);

    for ((table, _, reason), (output, sql)) in SCRATCH_UNKEYED.iter().zip(&refused) {
        let said = stderr(output);
        assert_eq!(code(output), 2, "{table}:\n{said}");
        assert!(
            said.contains(&format!("refusing to sync {table}: {reason}")),
            "{said}"
        );
        assert!(!said.contains("alter table"), "{said}");
        assert!(sql.is_none(), "{table}: a refused add writes no migration");
    }
    assert_eq!(after_refusals, before, "the refused adds wrote nothing");
    assert_eq!(code(&keyed), 0, "the uuid id add:\n{}", stderr(&keyed));
    assert!(
        keyed_sql
            .as_deref()
            .is_some_and(|sql| sql.contains(", 1, '{id}'\n")),
        "the uuid id add records its key: {keyed_sql:?}"
    );
}

/// One key shape the lane provisions: the table, its columns and key, the
/// RLS policy that proposes it to `init` (none for a table `sync --add`
/// provisions), the row it holds before it is synced, the key `_config`
/// records, and the pk a pull carries for that row.
struct KeyShape {
    table: &'static str,
    shape: &'static str,
    policy: Option<&'static str>,
    row: &'static str,
    key_columns: &'static str,
    pk: &'static str,
}

/// The owner every owner-scoped shape's row belongs to, and the reader the
/// pull runs as.
const KEY_OWNER: &str = "5b0e7c43-6a5d-4f8e-9c1b-2d3e4f5a6b7c";

/// A uuid `id`, a composite (bigint, integer) key, and a bigint identity by
/// default, each read-write and owner-scoped: `init` proposes them from their
/// policies.
const INIT_KEY_SHAPES: [KeyShape; 3] = [
    KeyShape {
        table: "kizunasync_keys_todos",
        shape: "(id uuid primary key default gen_random_uuid(), owner_id uuid not null, title text)",
        policy: Some("(select auth.uid()) = owner_id"),
        row: "(id, owner_id, title) values ('0b9f3a52-1c2d-4e5f-8a9b-0c1d2e3f4a5b', '5b0e7c43-6a5d-4f8e-9c1b-2d3e4f5a6b7c', 'works on a plane')",
        key_columns: "{id}",
        pk: "0b9f3a52-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    },
    KeyShape {
        table: "kizunasync_keys_seats",
        shape: "(hall bigint, seat integer, owner_id uuid not null, holder text, primary key (hall, seat))",
        policy: Some("(select auth.uid()) = owner_id"),
        row: "(hall, seat, owner_id, holder) values (1, 3456, '5b0e7c43-6a5d-4f8e-9c1b-2d3e4f5a6b7c', 'row 1')",
        key_columns: "{hall,seat}",
        pk: "[\"1\", \"3456\"]",
    },
    KeyShape {
        table: "kizunasync_keys_counters",
        shape: "(id bigint generated by default as identity primary key, owner_id uuid not null, title text)",
        policy: Some("(select auth.uid()) = owner_id"),
        row: "(id, owner_id, title) values (42, '5b0e7c43-6a5d-4f8e-9c1b-2d3e4f5a6b7c', 'counted')",
        key_columns: "{id}",
        pk: "42",
    },
];

/// A text key, a composite (character varying, smallint) key whose first
/// component needs escaping, and a bigint identity generated always, each
/// pull-only: `sync --add` provisions them.
const ADDED_KEY_SHAPES: [KeyShape; 3] = [
    KeyShape {
        table: "kizunasync_keys_slugs",
        shape: "(slug text primary key, title text not null default '')",
        policy: None,
        row: "(slug, title) values ('first-slug', 'first')",
        key_columns: "{slug}",
        pk: "first-slug",
    },
    KeyShape {
        table: "kizunasync_keys_labels",
        shape: "(code character varying(64), rank smallint, title text, primary key (code, rank))",
        policy: None,
        row: "(code, rank, title) values ('alpha \"q\"', 3, 'quoted')",
        key_columns: "{code,rank}",
        pk: "[\"alpha \\\"q\\\"\", \"3\"]",
    },
    KeyShape {
        table: "kizunasync_keys_feed",
        shape: "(id bigint generated always as identity primary key, title text)",
        policy: None,
        row: "(title) values ('first post')",
        key_columns: "{id}",
        pk: "1",
    },
];

/// The statements that create `shapes` with their rows, readable by
/// `authenticated`, and the policies of the ones `init` proposes.
fn create_key_shapes(shapes: &[KeyShape]) -> String {
    shapes
        .iter()
        .map(|shape| {
            let table = shape.table;
            let policy = shape.policy.map_or_else(String::new, |using| {
                format!(
                    "alter table public.{table} enable row level security;\n\
                     create policy \"{table} owner\" on public.{table} for all to authenticated using ({using});\n"
                )
            });

            format!(
                "drop table if exists public.{table};\n\
                 create table public.{table} {};\n\
                 insert into public.{table} {};\n\
                 grant select on public.{table} to authenticated;\n\
                 {policy}",
                shape.shape, shape.row
            )
        })
        .collect::<Vec<_>>()
        .concat()
}

/// `kizunasync.pull` from cursor `0` at `schema_version`, as the key owner,
/// over `shapes`, parsed into `(table, pk)` pairs, sorted.
fn pulled_pks(
    applier: &PgApplier,
    shapes: &[&KeyShape],
    schema_version: i64,
) -> Vec<(String, String)> {
    let buckets: Vec<serde_json::Value> = shapes
        .iter()
        .map(|shape| {
            let params = if shape.policy.is_some() {
                serde_json::json!({ "owner_id": KEY_OWNER })
            } else {
                serde_json::json!({})
            };

            serde_json::json!({ "table": shape.table, "params": params })
        })
        .collect();
    let claims = serde_json::json!({ "sub": KEY_OWNER, "role": "authenticated" });
    let rows = applier
        .run_query(&format!(
            "begin;\n\
             select set_config('request.jwt.claims', '{claims}', true);\n\
             set local role authenticated;\n\
             select kizunasync.pull('{}'::jsonb, '0', {schema_version}, 500)::text as resp;\n\
             commit;",
            serde_json::Value::Array(buckets)
        ))
        .unwrap_or_else(|cause| panic!("the pull should answer: {cause}"));
    let resp = rows
        .iter()
        .find_map(|row| require_string(row, "resp").ok())
        .expect("the pull returns one response");
    let page: serde_json::Value = serde_json::from_str(&resp).unwrap();
    let mut pks: Vec<(String, String)> = page["rows"]
        .as_array()
        .unwrap_or_else(|| panic!("a pull page carries rows: {page}"))
        .iter()
        .map(|row| {
            (
                row["table"].as_str().unwrap_or_default().to_owned(),
                row["pk"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    pks.sort();

    pks
}

/// Every key shape reaches `kizunasync._config` through the command that
/// provisions it: `init --yes` for the owner-scoped read-write tables its
/// policies propose, `sync --add` for the pull-only ones. The config records
/// each key in key order, a read-write table whose key has a database
/// default gets its note, a read-write add over a key generated always is
/// refused, and the pack's own `pull` then carries every seeded row under the
/// pk its recorded key computes. A key that moves afterwards fails `doctor`'s
/// `sync-key` check until `sync --add` records it again with a schema bump,
/// and a pull then carries the row under the pk the new key computes.
// One arc, deliberately: each step provisions what the next one reads.
#[expect(clippy::too_many_lines)]
#[test]
fn every_key_shape_is_recorded_and_pulled_by_the_key_it_records() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let project = install_scratch(&applier, &url, &env);
    applier
        .run_script(&format!(
            "insert into auth.users (id, is_anonymous) values ('{KEY_OWNER}', false) on conflict (id) do nothing;\n{}",
            create_key_shapes(&INIT_KEY_SHAPES)
        ))
        .unwrap();

    let init_project = empty_project();
    let init = kizunasync(
        init_project.path(),
        &[
            "init",
            "--yes",
            "--dry-run",
            "--allow-no-cron",
            "--db-url",
            &url,
        ],
        &env,
    );
    let init_sql = String::from_utf8_lossy(&init.stdout).into_owned();
    let init_applied = applier.run_script(&init_sql);
    applier
        .run_script(&create_key_shapes(&ADDED_KEY_SHAPES))
        .unwrap();
    let (feed_read_write, feed_read_write_sql) = sync_and_apply(
        &applier,
        &url,
        &env,
        &["--add", "kizunasync_keys_feed", "--sync", "read-write"],
    );
    let added: Vec<(Output, Option<String>)> = ADDED_KEY_SHAPES
        .iter()
        .map(|shape| sync_and_apply(&applier, &url, &env, &["--add", shape.table]))
        .collect();
    let recorded = scalar(
        &applier,
        "select string_agg(table_name || ' ' || key_columns::text, ', ' order by table_name) as recorded from kizunasync._config where table_name like 'kizunasync_keys_%';",
        "recorded",
    );
    let every_shape: Vec<&KeyShape> = INIT_KEY_SHAPES.iter().chain(&ADDED_KEY_SHAPES).collect();
    let pulled = pulled_pks(&applier, &every_shape, 1);
    let doctor_before = doctor_report(project.path(), &url);

    applier
        .run_script(
            "alter table public.kizunasync_keys_slugs drop constraint kizunasync_keys_slugs_pkey, add primary key (slug, title);",
        )
        .unwrap();
    let doctor_moved = doctor_report(project.path(), &url);
    let (unbumped, unbumped_sql) =
        sync_and_apply(&applier, &url, &env, &["--add", "kizunasync_keys_slugs"]);
    let (rekeyed, rekeyed_sql) = sync_and_apply(
        &applier,
        &url,
        &env,
        &[
            "--add",
            "kizunasync_keys_slugs",
            "--min-schema-version",
            "2",
        ],
    );
    let doctor_rekeyed = doctor_report(project.path(), &url);
    let pulled_rekeyed = pulled_pks(&applier, &every_shape, 2);

    let tables: Vec<&str> = every_shape.iter().map(|shape| shape.table).collect();
    unsync_and_drop(&applier, &tables);
    applier
        .run_script(&format!("delete from auth.users where id = '{KEY_OWNER}';"))
        .unwrap();

    assert_eq!(code(&init), 0, "kizunasync init:\n{}", stderr(&init));
    for shape in &INIT_KEY_SHAPES {
        assert!(
            init_sql.contains(&format!("'{}', 'read-write', 'owner_id'", shape.table)),
            "{}: {init_sql}",
            shape.table
        );
    }
    assert!(
        stderr(&init).contains("  note: kizunasync_keys_counters is read-write and its key has a database default: offline inserts must provide id."),
        "{}",
        stderr(&init)
    );
    if let Err(cause) = init_applied {
        panic!("the config init printed should apply: {cause}\n{init_sql}");
    }
    assert_eq!(code(&feed_read_write), 2, "{}", stderr(&feed_read_write));
    assert!(
        stderr(&feed_read_write).contains("refusing to sync kizunasync_keys_feed read-write: its key column id is generated always as identity"),
        "{}",
        stderr(&feed_read_write)
    );
    assert!(feed_read_write_sql.is_none());
    for (shape, (output, sql)) in ADDED_KEY_SHAPES.iter().zip(&added) {
        assert_eq!(code(output), 0, "{}:\n{}", shape.table, stderr(output));
        assert!(sql.is_some(), "{} writes its migration", shape.table);
    }
    let mut expected: Vec<String> = every_shape
        .iter()
        .map(|shape| format!("{} {}", shape.table, shape.key_columns))
        .collect();
    expected.sort();
    assert_eq!(recorded, expected.join(", "));
    let mut expected_pks: Vec<(String, String)> = every_shape
        .iter()
        .map(|shape| (shape.table.to_owned(), shape.pk.to_owned()))
        .collect();
    expected_pks.sort();
    assert_eq!(pulled, expected_pks);
    for id in ["table-primary-key", "sync-key"] {
        assert_eq!(
            doctor_before.get(id).map(|(level, _)| level.as_str()),
            Some("ok"),
            "{id}: {doctor_before:?}"
        );
    }
    let (moved_level, moved_message) = &doctor_moved["sync-key"];
    assert_eq!(moved_level, "error", "{moved_message}");
    assert!(
        moved_message.contains("kizunasync_keys_slugs: kizunasync._config records slug, and its primary key is (slug, title)"),
        "{moved_message}"
    );
    assert_eq!(code(&unbumped), 2, "{}", stderr(&unbumped));
    assert!(
        stderr(&unbumped)
            .contains("Run `kizunasync sync --add kizunasync_keys_slugs --min-schema-version 2`."),
        "{}",
        stderr(&unbumped)
    );
    assert!(unbumped_sql.is_none(), "a refused re-record writes nothing");
    assert_eq!(code(&rekeyed), 0, "{}", stderr(&rekeyed));
    assert!(
        rekeyed_sql.as_deref().is_some_and(|sql| sql.contains(
            "  min_schema_version = 2,\n  key_columns = '{slug,title}'\nwhere table_name = 'kizunasync_keys_slugs';\n\n-- re-key the changelog by the new key: every entry under the old pk goes, and every row is seeded again\nselect kizunasync._rekey_changelog('kizunasync_keys_slugs');"
        )),
        "{rekeyed_sql:?}"
    );
    assert_eq!(
        doctor_rekeyed
            .get("sync-key")
            .map(|(level, _)| level.as_str()),
        Some("ok"),
        "{doctor_rekeyed:?}"
    );
    let rekeyed_pks: Vec<(String, String)> = expected_pks
        .iter()
        .map(|(table, pk)| {
            if table == "kizunasync_keys_slugs" {
                (table.clone(), "[\"first-slug\", \"first\"]".to_owned())
            } else {
                (table.clone(), pk.clone())
            }
        })
        .collect();
    assert_eq!(pulled_rekeyed, rekeyed_pks);
}

/// `kizunasync init --yes --dry-run` over `url`, with `extra` flags, and the
/// project config it prints, applied over the same connection.
fn init_and_apply(applier: &PgApplier, url: &str, env: &[(&str, &str)], extra: &[&str]) -> Output {
    let project = empty_project();
    let mut args = vec![
        "init",
        "--yes",
        "--dry-run",
        "--allow-no-cron",
        "--db-url",
        url,
    ];
    args.extend_from_slice(extra);
    let output = kizunasync(project.path(), &args, env);
    let sql = String::from_utf8_lossy(&output.stdout).into_owned();
    if code(&output) == 0 {
        applier
            .run_script(&sql)
            .unwrap_or_else(|cause| panic!("the config init printed should apply: {cause}\n{sql}"));
    }

    output
}

/// The schema version `_config` records for `table`.
fn recorded_schema_version(applier: &PgApplier, table: &str) -> String {
    scalar(
        applier,
        &format!(
            "select min_schema_version::text as version from kizunasync._config where table_name = '{table}';"
        ),
        "version",
    )
}

/// An `init` re-run proposes the documented starting version, 1, for a table
/// already synced at 3: the recorded version stays, since devices told to
/// leave version 1 behind must not be let back in. A run that raises it wins.
#[test]
fn an_init_re_run_never_lowers_a_recorded_schema_version() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let _project = install_scratch(&applier, &url, &env);
    let shape = &INIT_KEY_SHAPES[0];
    applier
        .run_script(&format!(
            "insert into auth.users (id, is_anonymous) values ('{KEY_OWNER}', false) on conflict (id) do nothing;\n{}",
            create_key_shapes(std::slice::from_ref(shape))
        ))
        .unwrap();

    let first = init_and_apply(&applier, &url, &env, &[]);
    let (raised, _) = sync_and_apply(
        &applier,
        &url,
        &env,
        &["--add", shape.table, "--min-schema-version", "3"],
    );
    let before_rerun = recorded_schema_version(&applier, shape.table);
    let rerun = init_and_apply(&applier, &url, &env, &[]);
    let after_rerun = recorded_schema_version(&applier, shape.table);
    let bumped = init_and_apply(&applier, &url, &env, &["--min-schema-version", "4"]);
    let after_bump = recorded_schema_version(&applier, shape.table);
    unsync_and_drop(&applier, &[shape.table]);
    applier
        .run_script(&format!("delete from auth.users where id = '{KEY_OWNER}';"))
        .unwrap();

    for (step, output) in [
        ("init", &first),
        ("sync", &raised),
        ("re-run", &rerun),
        ("bump", &bumped),
    ] {
        assert_eq!(code(output), 0, "{step}:\n{}", stderr(output));
    }
    assert_eq!(before_rerun, "3");
    assert_eq!(after_rerun, "3", "an init re-run kept the recorded version");
    assert_eq!(after_bump, "4", "an init run that raises the version wins");
}

/// The bucket labels `_changelog` carries for the scratch table, sorted.
fn changelog_labels(applier: &PgApplier) -> String {
    scalar(
        applier,
        &format!(
            "select coalesce(string_agg(coalesce(bucket_value, 'null'), ',' order by bucket_value), '') as labels from kizunasync._changelog where table_name = '{SCRATCH_SYNCED_TABLE}';"
        ),
        "labels",
    )
}

/// Rows written before the table was synced reach the changelog through the
/// seed the add carries; a move to another bucket column is refused without a
/// schema bump, and with one it relabels every changelog row by the new
/// column.
#[test]
fn a_synced_table_is_seeded_then_relabeled_by_its_new_bucket_column() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let _project = install_scratch(&applier, &url, &env);
    applier
        .run_script(&format!(
            "drop table if exists public.{SCRATCH_SYNCED_TABLE};\n\
             create table public.{SCRATCH_SYNCED_TABLE} (id uuid primary key default gen_random_uuid(), team_id text, owner_id text);\n\
             insert into public.{SCRATCH_SYNCED_TABLE} (team_id, owner_id) values ('team-a', 'owner-1'), ('team-b', 'owner-2');"
        ))
        .unwrap();

    let (added, _) = sync_and_apply(
        &applier,
        &url,
        &env,
        &[
            "--add",
            SCRATCH_SYNCED_TABLE,
            "--sync",
            "read-write",
            "--bucket-column",
            "team_id",
            "--allow-no-rls",
        ],
    );
    let seeded = changelog_labels(&applier);
    let (refused, refused_sql) = sync_and_apply(
        &applier,
        &url,
        &env,
        &["--add", SCRATCH_SYNCED_TABLE, "--bucket-column", "owner_id"],
    );
    let (moved, moved_sql) = sync_and_apply(
        &applier,
        &url,
        &env,
        &[
            "--add",
            SCRATCH_SYNCED_TABLE,
            "--bucket-column",
            "owner_id",
            "--min-schema-version",
            "2",
        ],
    );
    let relabeled = changelog_labels(&applier);
    unsync_and_drop(&applier, &[SCRATCH_SYNCED_TABLE]);

    assert_eq!(code(&added), 0, "the add:\n{}", stderr(&added));
    assert_eq!(seeded, "team-a,team-b", "the seed labels both rows");
    assert_eq!(
        code(&refused),
        2,
        "the move without a bump:\n{}",
        stderr(&refused)
    );
    assert!(
        stderr(&refused).contains("without raising --min-schema-version above 1"),
        "{}",
        stderr(&refused)
    );
    assert!(refused_sql.is_none(), "a refused move writes no migration");
    assert_eq!(code(&moved), 0, "the move with a bump:\n{}", stderr(&moved));
    assert!(
        moved_sql
            .as_deref()
            .is_some_and(|sql| sql.contains("_relabel_changelog")),
        "{moved_sql:?}"
    );
    assert_eq!(
        relabeled, "owner-1,owner-2",
        "the relabel reads the new column"
    );
}

/// `doctor` names a synced table whose row level security is disabled and a
/// trigger function on it that pins no `search_path`, and passes both checks
/// once they are fixed.
#[test]
fn doctor_names_a_synced_table_without_row_level_security_and_an_unpinned_trigger() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let project = install_scratch(&applier, &url, &env);
    applier
        .run_script(&format!(
            "drop table if exists public.{SCRATCH_SYNCED_TABLE};\n\
             create table public.{SCRATCH_SYNCED_TABLE} (id uuid primary key default gen_random_uuid(), title text);\n\
             create or replace function {SCRATCH_TRIGGER_FUNCTION}() returns trigger language plpgsql as $$ begin return new; end $$;\n\
             create trigger scratch_touch_items before update on public.{SCRATCH_SYNCED_TABLE} for each row execute function {SCRATCH_TRIGGER_FUNCTION}();"
        ))
        .unwrap();

    let (added, _) = sync_and_apply(&applier, &url, &env, &["--add", SCRATCH_SYNCED_TABLE]);
    let broken = doctor_report(project.path(), &url);
    applier
        .run_script(&format!(
            "alter table public.{SCRATCH_SYNCED_TABLE} enable row level security;\n\
             alter function {SCRATCH_TRIGGER_FUNCTION}() set search_path = '';"
        ))
        .unwrap();
    let fixed = doctor_report(project.path(), &url);
    unsync_and_drop(&applier, &[SCRATCH_SYNCED_TABLE]);
    applier
        .run_script(&format!(
            "drop function if exists {SCRATCH_TRIGGER_FUNCTION}();"
        ))
        .unwrap();

    assert_eq!(code(&added), 0, "the add:\n{}", stderr(&added));
    for (id, fault) in [
        ("rls-enabled", SCRATCH_SYNCED_TABLE.to_owned()),
        (
            "trigger-search-path",
            format!("public.{SCRATCH_SYNCED_TABLE}.scratch_touch_items runs"),
        ),
    ] {
        let Some((level, message)) = broken.get(id) else {
            panic!("no {id} check in {broken:?}");
        };

        assert_eq!(level, "error", "{id}: {message}");
        assert!(message.contains(&fault), "{id}: {message}");
    }
    for id in ["rls-enabled", "trigger-search-path"] {
        let Some((level, message)) = fixed.get(id) else {
            panic!("no {id} check in {fixed:?}");
        };

        assert_eq!(level, "ok", "{id} once fixed: {message}");
    }
}

// MARK: - the control panel, end to end

/// The panel's scenario never pushes a migration, so the Supabase CLI is a
/// refusal rather than a spawn.
struct NoSupabaseCli;

impl SupabaseCli for NoSupabaseCli {
    fn push(&self, _target: &PushTarget, _workdir: &Path) -> CliResult {
        CliResult {
            ok: false,
            stderr: "the panel scenario pushes nothing".to_owned(),
        }
    }

    fn repair_reverted(
        &self,
        target: &PushTarget,
        workdir: &Path,
        _versions: &[String],
    ) -> CliResult {
        self.push(target, workdir)
    }
}

fn no_projects(_token: &str) -> kizunasync_cli::error::Result<Vec<ProjectSummary>> {
    Err(Error::Transport("the scenario picks no project".to_owned()))
}

fn no_browser() -> kizunasync_cli::error::Result<()> {
    Err(Error::Cli("the scenario opens no browser".to_owned()))
}

fn no_remote(
    _project_ref: &ProjectRef,
    _token: &str,
) -> kizunasync_cli::error::Result<ServerFacts> {
    Err(Error::Transport(
        "the scenario reaches no project".to_owned(),
    ))
}

fn no_linked(
    _project_ref: &ProjectRef,
    _token: Option<&str>,
) -> kizunasync_cli::error::Result<LinkedConnection> {
    Err(Error::Transport("the scenario links no project".to_owned()))
}

/// Bare `kizunasync` in `project` over `url`, answered by `answers`: the
/// connection comes from `KSYNC_DB_URL` and the pack from `pack_path`. Returns
/// the exit code, stderr, and the prompter to read back what it was asked.
fn bare_kizunasync(
    project: &Path,
    url: &str,
    pack_path: &str,
    answers: Vec<Answer>,
) -> (i32, String, ScriptedPrompter) {
    let env = Env::from_pairs(&[("KSYNC_PACK_DIR", pack_path), ("KSYNC_DB_URL", url)]);
    let paths = ProjectPaths::rooted_at(project.to_path_buf());
    let env_files = env_file::load(project);
    let live = LivePorts::new();
    let open = |connection: &WizardConnection| smart::open_applier(connection);
    let clock = kizunasync_cli::clock::now_unix;
    let mut scripted = ScriptedPrompter::new(answers);
    let (mut ui, capture) = Ui::capture();
    let code = smart::run(
        project,
        &paths,
        &env,
        &env_files,
        SmartPorts {
            init: InitPorts {
                prompter: Some(&mut scripted as &mut dyn Prompter),
                schemas: &PgSchemaSource,
                supabase: &NoSupabaseCli,
                now_unix: clock(),
                tokens: &NoTokenStore,
                list_projects: &no_projects,
                browser_login: &no_browser,
                probe_remote: &no_remote,
            },
            ledger: &smart::read_ledger_over,
            config: &smart::read_config_over,
            linked: &no_linked,
            panel: PanelPorts {
                open: &open,
                doctor: live.ports(&env_files),
                clock: &clock,
            },
        },
        &mut ui,
    );

    (code, capture.stderr(), scripted)
}

/// Bare `kizunasync` over the scratch database, answered by a script: the
/// connection comes from `KSYNC_DB_URL`, the installed ledger opens the
/// panel, and the panel runs the health check, then a re-apply of the
/// up-to-date pack. The re-apply writes no ledger row, so the ledger reads
/// back exactly as it was, still recording this pack's hash.
#[test]
fn the_control_panel_runs_the_health_check_and_a_re_apply_over_a_scratch_database() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let project = install_scratch(&applier, &url, &[("KSYNC_PACK_DIR", pack_path.as_str())]);
    let rows_before = read_ledger_rows(&applier).unwrap();
    let (code, stderr, scripted) = bare_kizunasync(
        project.path(),
        &url,
        &pack_path,
        vec![
            Answer::Action(PanelAction::HealthCheck),
            Answer::Action(PanelAction::UpdatePack),
            Answer::Confirm(true),
            Answer::Action(PanelAction::Exit),
        ],
    );
    let rows_after = read_ledger_rows(&applier).unwrap();
    let shipped = read_pack_files(pack.path()).unwrap();

    assert_eq!(code, 0, "bare kizunasync:\n{stderr}");
    assert_eq!(scripted.unused(), 0, "{stderr}");
    assert!(
        stderr.contains("kizunasync doctor: project checks"),
        "{stderr}"
    );
    assert!(stderr.contains("re-applied 1 pack file(s)."), "{stderr}");
    assert!(
        stderr.contains(&format!(
            "Equivalent command:\n    PGPASSWORD=… kizunasync upgrade --reapply --yes --db-url postgresql://postgres@127.0.0.1:55322/{SCRATCH_DATABASE}"
        )),
        "{stderr}"
    );
    assert_eq!(rows_after, rows_before, "a re-apply writes no ledger row");
    for file in &shipped {
        assert!(
            rows_after.iter().any(|row| {
                row.object_kind == "pack-file"
                    && row.object_name == file.name
                    && row.content_hash == hash_pack_file(&file.sql)
            }),
            "the ledger records {} with this pack's hash: {rows_after:?}",
            file.name
        );
    }
    assert_pack_checks_pass(
        &doctor_report(project.path(), &url),
        has_pg_cron(&url),
        "after the panel's re-apply",
    );
}

// MARK: - an earlier install, on the scratch database only

/// The md5 an earlier `0001_kizuna_init.sql` recorded. Its install created no
/// `_settings.max_pull_scan`.
const EARLIER_PACK_HASH: &str = "34129af629c5fb384a568787cd956044";

/// The current pack installed, then turned into what that earlier install
/// left: the column it never created, and the hash it recorded.
fn earlier_install(applier: &PgApplier, url: &str, env: &[(&str, &str)]) -> tempfile::TempDir {
    let project = install_scratch(applier, url, env);
    applier
        .run_script("alter table kizunasync._settings drop column max_pull_scan;")
        .unwrap();
    record_the_earlier_hash(applier);

    project
}

/// Every `pack-file` row records [`EARLIER_PACK_HASH`], the tables left as
/// they are.
fn record_the_earlier_hash(applier: &PgApplier) {
    applier
        .run_script(&format!(
            "update kizunasync._provisions set content_hash = '{EARLIER_PACK_HASH}' where object_kind = 'pack-file';"
        ))
        .unwrap();
}

fn has_max_pull_scan(applier: &PgApplier) -> bool {
    scalar(
        applier,
        "select exists (select 1 from information_schema.columns where table_schema = 'kizunasync' and table_name = '_settings' and column_name = 'max_pull_scan')::text as present;",
        "present",
    ) == "true"
}

/// The hash the ledger's one `pack-file` row records.
fn recorded_pack_hash(applier: &PgApplier) -> String {
    scalar(
        applier,
        "select content_hash from kizunasync._provisions where object_kind = 'pack-file';",
        "content_hash",
    )
}

/// The md5 of this checkout's `0001_kizuna_init.sql`.
fn this_pack_hash() -> String {
    hash_pack_file(&std::fs::read_to_string(pack_migration()).unwrap())
}

/// The ledger, `_config` and `_settings`, as one text to compare before and
/// after a run that must write nothing.
fn written_state(applier: &PgApplier) -> String {
    scalar(
        applier,
        "select concat_ws(' | ', (select string_agg(object_kind || ':' || object_name || ':' || content_hash, ',' order by object_kind, object_name) from kizunasync._provisions), (select coalesce(string_agg(table_name, ',' order by table_name), '') from kizunasync._config), (select to_jsonb(s)::text from kizunasync._settings s)) as state;",
        "state",
    )
}

/// What a re-apply the database refused over [`earlier_install`] prints once
/// the rollback is reported: the fresh install, over the scratch connection
/// with its password left to `PGPASSWORD`.
fn fresh_install_step() -> String {
    format!(
        "the ledger is unchanged\n  the database holds kizunasync tables from an earlier build of the pack, which a re-apply does not reshape. Remove Kizuna with `PGPASSWORD=… kizunasync deprovision --purge --db-url postgresql://postgres@127.0.0.1:55322/{SCRATCH_DATABASE}` (your application tables and their data stay), then install it again with `PGPASSWORD=… kizunasync init --db-url postgresql://postgres@127.0.0.1:55322/{SCRATCH_DATABASE}`."
    )
}

/// The `ledger` check over a ledger that records [`EARLIER_PACK_HASH`] fails
/// naming both hashes and the re-apply, and every other pack check passes,
/// bar the ones only `pg_cron` can.
fn assert_only_the_ledger_names_the_earlier_hash(report: &DoctorReport, pg_cron: bool, when: &str) {
    assert_pack_checks_pass_but(report, pg_cron, when, "ledger");
    let (level, message) = &report["ledger"];

    assert_eq!(level, "error", "{when}: {message}");
    assert!(
        message.contains("this build's pack differs from the one the ledger records"),
        "{when}: {message}"
    );
    assert!(
        message.contains(&format!(
            "! 0001_kizuna_init.sql: ledger md5 {EARLIER_PACK_HASH}, pack md5 {}",
            this_pack_hash()
        )),
        "{when}: {message}"
    );
    assert!(
        message.contains("kizunasync upgrade --reapply --yes"),
        "{when}: {message}"
    );
}

/// What `status --json` and `doctor --ci` report over [`earlier_install`]:
/// `status` names the pack file whose hash differs, and `doctor` reports the
/// same difference in its `ledger` check.
fn assert_the_drift_is_reported(status: &Output, doctor: &DoctorReport, pg_cron: bool) {
    assert_eq!(code(status), 0, "status:\n{}", stderr(status));
    let report = json_of(status);
    assert_eq!(report["pack"]["state"], "drift", "{report}");
    assert!(
        report["pack"]["offenders"]
            .as_array()
            .is_some_and(|offenders| offenders
                .iter()
                .any(|offender| offender == "0001_kizuna_init.sql: hash-mismatch")),
        "{report}"
    );
    assert!(report["settings"]["maxPullScan"].is_null(), "{report}");
    assert_eq!(report["settings"]["clientTtlDays"], 90, "{report}");
    let (level, message) = &doctor["config-tables"];
    assert_eq!(level, "ok", "doctor reads the config: {message}");
    assert_only_the_ledger_names_the_earlier_hash(doctor, pg_cron, "over an earlier install");
}

/// Over an earlier install, `status` and `doctor` read the project, and
/// `sync --add --yes` stops before it writes anything, naming the re-apply
/// over the same connection. `upgrade --reapply --yes` then fails inside its
/// transaction on the column the earlier build never created: nothing is
/// applied, the ledger keeps its hash, and the run names the fresh install.
#[test]
fn an_earlier_install_is_reported_refused_for_writes_and_left_as_it_is_by_a_reapply() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let project = earlier_install(&applier, &url, &env);
    applier
        .run_script(&format!(
            "drop table if exists public.{SCRATCH_SYNCED_TABLE};\n\
             create table public.{SCRATCH_SYNCED_TABLE} (id uuid primary key default gen_random_uuid(), title text);"
        ))
        .unwrap();

    let status = kizunasync(
        project.path(),
        &["status", "--json", "--db-url", &url],
        &env,
    );
    let doctor = doctor_report(project.path(), &url);
    let before = written_state(&applier);
    let sync = kizunasync(
        project.path(),
        &[
            "sync",
            "--add",
            SCRATCH_SYNCED_TABLE,
            "--yes",
            "--db-url",
            &url,
        ],
        &env,
    );
    let after_sync = written_state(&applier);
    let written = migration_names(project.path());
    let reapplied = reapply(project.path(), &url, &env);
    let after_reapply = written_state(&applier);
    unsync_and_drop(&applier, &[SCRATCH_SYNCED_TABLE]);

    assert_the_drift_is_reported(&status, &doctor, has_pg_cron(&url));

    let sync_err = stderr(&sync);
    assert_eq!(code(&sync), 2, "sync --add --yes:\n{sync_err}");
    assert!(
        sync_err.contains(&format!(
            "! 0001_kizuna_init.sql: ledger md5 {EARLIER_PACK_HASH}, pack md5 "
        )),
        "{sync_err}"
    );
    assert!(
        sync_err.contains(&format!(
            "`PGPASSWORD=… kizunasync upgrade --reapply --yes --db-url postgresql://postgres@127.0.0.1:55322/{SCRATCH_DATABASE}`"
        )),
        "{sync_err}"
    );
    assert!(!sync_err.contains("postgres:postgres@"), "{sync_err}");
    assert_eq!(after_sync, before, "the refused sync wrote nothing");
    assert!(
        written
            .iter()
            .all(|name| !name.ends_with("_kizunasync_sync.sql")),
        "{written:?}"
    );

    let reapply_err = stderr(&reapplied);
    assert_eq!(code(&reapplied), 1, "upgrade --reapply:\n{reapply_err}");
    assert!(reapply_err.contains("42703"), "{reapply_err}");
    assert!(reapply_err.contains(&fresh_install_step()), "{reapply_err}");
    assert!(!reapply_err.contains("postgres:postgres@"), "{reapply_err}");
    assert_eq!(after_reapply, before, "the failed re-apply applied nothing");
    assert!(!has_max_pull_scan(&applier));
    assert_eq!(recorded_pack_hash(&applier), EARLIER_PACK_HASH);
}

/// Every menu select bare `kizunasync` asked, by the item it opened on.
fn menus_opened_on(prompter: &ScriptedPrompter) -> Vec<Option<PanelAction>> {
    prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Action { current, .. } => Some(*current),
            _ => None,
        })
        .collect()
}

/// Every yes/no question bare `kizunasync` asked, in order.
fn confirm_questions(prompter: &ScriptedPrompter) -> Vec<String> {
    prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::Confirm { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// Bare `kizunasync` over an earlier install opens the panel on "Update the
/// pack" with the drift in its header. Synced tables offers the re-apply
/// first: No returns to the panel with nothing written. Yes fails inside the
/// transaction, names the fresh install, and the next menu opens on "Remove
/// Kizuna"; the ledger and the table stay as they were.
#[test]
fn the_panel_opens_on_remove_kizuna_once_a_reapply_fails_over_an_earlier_install() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let project = earlier_install(&applier, &url, &[("KSYNC_PACK_DIR", pack_path.as_str())]);
    let before = written_state(&applier);

    let (declined_code, declined_err, declined) = bare_kizunasync(
        project.path(),
        &url,
        &pack_path,
        vec![
            Answer::Action(PanelAction::SyncedTables),
            Answer::Confirm(false),
            Answer::Action(PanelAction::Exit),
        ],
    );
    let after_no = written_state(&applier);
    let (confirmed_code, confirmed_err, confirmed) = bare_kizunasync(
        project.path(),
        &url,
        &pack_path,
        vec![
            Answer::Action(PanelAction::SyncedTables),
            Answer::Confirm(true),
            Answer::Action(PanelAction::Exit),
        ],
    );
    let after_yes = written_state(&applier);

    assert_eq!(declined_code, 0, "{declined_err}");
    assert_eq!(declined.unused(), 0, "{declined_err}");
    assert_eq!(
        menus_opened_on(&declined),
        [Some(PanelAction::UpdatePack), Some(PanelAction::UpdatePack)],
        "every menu opens on Update the pack while the pack differs"
    );
    assert!(
        declined
            .notes()
            .iter()
            .any(|(_, body)| body.contains("· this CLI ships a different pack")),
        "{:?}",
        declined.notes()
    );
    assert!(declined_err.contains("nothing applied."), "{declined_err}");
    assert_eq!(after_no, before, "No writes nothing");

    assert_eq!(confirmed_code, 0, "{confirmed_err}");
    assert_eq!(confirmed.unused(), 0, "{confirmed_err}");
    assert_eq!(confirm_questions(&confirmed), ["Re-apply the pack now?"]);
    assert!(
        confirmed_err.contains(&fresh_install_step()),
        "{confirmed_err}"
    );
    assert_eq!(
        menus_opened_on(&confirmed),
        [
            Some(PanelAction::UpdatePack),
            Some(PanelAction::RemoveKizuna)
        ],
        "a re-apply refused over an earlier build opens the menu on Remove Kizuna"
    );
    assert_eq!(after_yes, before, "the failed re-apply applied nothing");
    assert!(!has_max_pull_scan(&applier));
    assert_eq!(recorded_pack_hash(&applier), EARLIER_PACK_HASH);
}

/// A ledger that records another hash over tables this pack's own install
/// shaped: in the panel, Yes at the gate before Synced tables re-applies the
/// pack, records this pack's hash, and carries on to the item's question.
/// With the other hash recorded again, `upgrade --reapply --yes` re-applies it
/// the same way. `doctor` runs over the differing ledger, and only its
/// `ledger` check fails.
#[test]
fn a_ledger_recording_another_hash_over_current_tables_is_reapplied() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let env = [("KSYNC_PACK_DIR", pack_path.as_str())];
    let project = install_scratch(&applier, &url, &env);
    record_the_earlier_hash(&applier);
    let doctor = doctor_report(project.path(), &url);

    let (code_of_panel, panel_err, panel) = bare_kizunasync(
        project.path(),
        &url,
        &pack_path,
        vec![
            Answer::Action(PanelAction::SyncedTables),
            Answer::Confirm(true),
            Answer::Confirm(false),
            Answer::Action(PanelAction::Exit),
        ],
    );
    let hash_after_panel = recorded_pack_hash(&applier);
    record_the_earlier_hash(&applier);
    let reapplied = reapply(project.path(), &url, &env);

    assert_only_the_ledger_names_the_earlier_hash(
        &doctor,
        has_pg_cron(&url),
        "over another recorded hash",
    );

    assert_eq!(code_of_panel, 0, "{panel_err}");
    assert_eq!(panel.unused(), 0, "{panel_err}");
    assert_eq!(
        confirm_questions(&panel),
        [
            "Re-apply the pack now?",
            "This database has Kizuna installed but syncs no tables yet. Pick them now?"
        ]
    );
    assert!(
        panel_err.contains("re-applied 1 pack file(s) and recorded their hashes."),
        "{panel_err}"
    );
    assert_eq!(hash_after_panel, this_pack_hash());

    assert_eq!(
        code(&reapplied),
        0,
        "upgrade --reapply:\n{}",
        stderr(&reapplied)
    );
    assert!(
        stderr(&reapplied).contains("re-applied 1 pack file(s) and recorded their hashes."),
        "{}",
        stderr(&reapplied)
    );
    assert_eq!(recorded_pack_hash(&applier), this_pack_hash());
    assert!(has_max_pull_scan(&applier));
}

// MARK: - the migrations directory replays to the database

/// The database a replay of the project's migrations is applied to. This lane
/// creates it, and drops it when the test ends.
const REPLAY_DATABASE: &str = "kizunasync_cli_scratch_replay";

/// The project's own table, created by its own migration and synced by `init`.
const REBUILD_TABLE: &str = "kizunasync_rebuild_items";

/// The project's own migration, older than anything `kizunasync` writes.
const REBUILD_TABLE_MIGRATION: &str = "20200101000000_create_rebuild_items.sql";

/// Leaves the cluster as the other scenarios expect it, however the test
/// ends: the replay database dropped, and in the scratch database the pack
/// the last `init` installed kept, with nothing left of the test's table or
/// of the migration history the pushes wrote.
struct RebuildCleanup {
    maintenance: PgApplier,
    scratch: PgApplier,
}

impl Drop for RebuildCleanup {
    fn drop(&mut self) {
        let _ = self.scratch.run_script(&render_sync_delta_sql(&DeltaInput {
            removed: vec![REBUILD_TABLE.to_owned()],
            ..DeltaInput::default()
        }));
        let _ = self.scratch.run_script(&format!(
            "drop table if exists public.{REBUILD_TABLE};\n\
             drop schema if exists supabase_migrations cascade;"
        ));
        let _ = self.maintenance.run_script(&format!(
            "drop database if exists {REPLAY_DATABASE} with (force);"
        ));
    }
}

/// A Supabase CLI project whose only migration is [`REBUILD_TABLE_MIGRATION`]:
/// the table, and the owner policy `init` proposes it from.
fn supabase_project() -> tempfile::TempDir {
    let project = empty_project();
    std::fs::write(
        project.path().join("supabase/config.toml"),
        "project_id = \"kizunasync-cli-rebuild\"\n",
    )
    .unwrap();
    std::fs::write(
        project
            .path()
            .join("supabase/migrations")
            .join(REBUILD_TABLE_MIGRATION),
        format!(
            "create table public.{REBUILD_TABLE} (id uuid primary key default gen_random_uuid(), user_id uuid not null, title text);\n\
             alter table public.{REBUILD_TABLE} enable row level security;\n\
             create policy \"Owners manage their items.\" on public.{REBUILD_TABLE} for all using (user_id = auth.uid());\n"
        ),
    )
    .unwrap();

    project
}

/// `supabase db push` of `project` to `url`, as a user pushes their own
/// migrations before `kizunasync init` reads the schema.
fn supabase_push(project: &Path, url: &str) -> Output {
    let (bare, password) = kizunasync_cli::db::split_db_url_password(url);
    Command::new("supabase")
        .current_dir(project)
        .args(["db", "push", "--workdir"])
        .arg(project)
        .args(["--db-url", bare.as_str()])
        .env("PGPASSWORD", password.unwrap_or_default())
        .stdin(Stdio::null())
        .output()
        .expect("the supabase CLI should be on PATH")
}

/// `kizunasync status --json` over `url`, run from `project`, without the
/// instant each table was recorded at, which no replay reproduces.
fn status_json(project: &Path, url: &str, env: &[(&str, &str)]) -> serde_json::Value {
    let output = kizunasync(project, &["status", "--json", "--db-url", url], env);
    assert_eq!(code(&output), 0, "kizunasync status:\n{}", stderr(&output));
    let mut status: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("status --json should print one object");
    for table in status["tables"].as_array_mut().into_iter().flatten() {
        table.as_object_mut().map(|table| table.remove("createdAt"));
    }

    status
}

/// Every migration in `names`, applied in order onto a fresh
/// [`REPLAY_DATABASE`] on the cluster `scratch` names, and the `status` that
/// database then reports.
fn replay_status(
    project: &Path,
    names: &[String],
    scratch: &str,
    env: &[(&str, &str)],
) -> serde_json::Value {
    let maintenance = PgApplier::new(&scratch.replace(SCRATCH_DATABASE, "postgres"));
    maintenance
        .run_script(&format!(
            "drop database if exists {REPLAY_DATABASE} with (force);"
        ))
        .unwrap();
    maintenance
        .run_script(&format!("create database {REPLAY_DATABASE};"))
        .unwrap();
    let replay_url = scratch.replace(SCRATCH_DATABASE, REPLAY_DATABASE);
    let replay = PgApplier::new(&replay_url);
    replay.run_script(VENDOR_STUB).unwrap();
    for name in names {
        let sql = std::fs::read_to_string(project.join("supabase/migrations").join(name)).unwrap();
        replay
            .run_script(&sql)
            .unwrap_or_else(|cause| panic!("{name} should replay onto {REPLAY_DATABASE}: {cause}"));
    }

    status_json(project, &replay_url, env)
}

/// After `deprovision --purge`, `init` installs again: the ledger, not the
/// files an earlier install left, decides what is written, and every run's
/// migration goes through `supabase db push` like the project's own. The
/// directory is then the record of the database: every file in it, applied
/// in order onto a fresh database, reaches the same `status`.
#[test]
fn init_after_a_purge_installs_again_and_the_directory_replays_to_the_same_status() {
    let _live = live_stack_guard();
    let Some(url) = scratch_url() else { return };
    let applier = PgApplier::new(&url);
    let _cleanup = RebuildCleanup {
        maintenance: PgApplier::new(&url.replace(SCRATCH_DATABASE, "postgres")),
        scratch: PgApplier::new(&url),
    };
    applier
        .run_script(&format!(
            "drop table if exists public.{REBUILD_TABLE};\n\
             drop schema if exists kizunasync cascade;\n\
             drop schema if exists supabase_migrations cascade;"
        ))
        .unwrap();
    let pack = pack_copy();
    let pack_path = pack.path().to_string_lossy().into_owned();
    let home = std::env::var("HOME").unwrap_or_default();
    let env = [
        ("KSYNC_PACK_DIR", pack_path.as_str()),
        ("HOME", home.as_str()),
    ];
    let project = supabase_project();
    let root = project.path();
    let push_url = format!("{url}?sslmode=disable");
    let init_args = ["init", "--yes", "--allow-no-cron", "--db-url", &push_url];

    let own = supabase_push(root, &push_url);
    assert!(
        own.status.success(),
        "supabase db push:\n{}",
        String::from_utf8_lossy(&own.stderr)
    );

    let first = kizunasync(root, &init_args, &env);
    let installed = migration_names(root);
    let purge = kizunasync(
        root,
        &[
            "deprovision",
            "--purge",
            "--yes",
            "--confirm",
            "local",
            "--db-url",
            &push_url,
        ],
        &env,
    );
    let schema_after_purge = scalar(
        &applier,
        "select count(*)::text as count from pg_namespace where nspname = 'kizunasync';",
        "count",
    );
    let second = kizunasync(root, &init_args, &env);
    let names = migration_names(root);
    let live = status_json(root, &url, &env);

    let replayed = replay_status(root, &names, &url, &env);

    assert_eq!(code(&first), 0, "kizunasync init:\n{}", stderr(&first));
    assert_eq!(
        code(&purge),
        0,
        "kizunasync deprovision:\n{}",
        stderr(&purge)
    );
    assert_eq!(schema_after_purge, "0", "the purge applied");
    assert_eq!(code(&second), 0, "kizunasync init:\n{}", stderr(&second));
    assert!(
        !stderr(&second).contains(": skipped"),
        "the second install writes the pack and the config again:\n{}",
        stderr(&second)
    );
    let suffixes: Vec<&str> = names
        .iter()
        .map(|name| name.split_once('_').map_or(name.as_str(), |(_, rest)| rest))
        .collect();
    assert_eq!(
        suffixes,
        [
            "create_rebuild_items.sql",
            "kizunasync_init.sql",
            "kizunasync_config.sql",
            "kizunasync_deprovision.sql",
            "kizunasync_init.sql",
            "kizunasync_config.sql",
        ],
        "{installed:?} then {names:?}"
    );
    assert_eq!(live["pack"]["state"], "up to date", "{live}");
    assert!(
        live["tables"]
            .as_array()
            .unwrap()
            .iter()
            .any(|table| table.to_string().contains(REBUILD_TABLE)),
        "{live}"
    );
    assert_eq!(replayed, live);
}
