//! The checks that read what the pack installed.
//!
//! Everything here is one or more catalog reads against the project's own
//! database: the extension the retention jobs need, the jobs themselves, the
//! RPCs a client calls, the triggers a synced table carries, the primary key
//! they key its changes by and the key `_config` records for it, its row
//! level security and the `search_path` of its own trigger
//! functions, the stamp that numbers every change at commit, the wakeup
//! policy, the role and the grants that lock the surface down, the
//! column-level privileges layered on top of them, and whether the ledger
//! still describes the objects it claims and records this build's pack rather
//! than a different or a newer one.
//!
//! A query that does not answer fails its own check carrying the transport's
//! own message. An unreachable database and a project that was never
//! provisioned both land there, and both are fixed by the same command, which
//! is why every hint closes on it.

use std::collections::{BTreeMap, BTreeSet};

use crate::applier::Applier;
use crate::commands::deprovision::read_ledger;
use crate::commands::jobs::{Job, JobsReport, has_pg_cron, read_jobs};
use crate::commands::reconcile::describe_offenders;
use crate::commands::table_checks::key_reason;
use crate::config::{TableConfig, config_query, load_config_from_db, settings_query};
use crate::config_sql::{SYNCED_TABLE_SCHEMA, change_trigger_name, delete_trigger_name};
use crate::constants::{INTERNAL_CONFIG, SCHEMA};
use crate::error::{Error, Result};
use crate::ledger::{ObjectKind, ProvisionRow};
use crate::pack::PackFile;
use crate::proposals::{PrimaryKey, SyncMode, describe_key_columns, listed, read_primary_keys};
use crate::provision::{ledger_newer, plan_provision, read_ledger_rows};
use crate::row::{optional_bool, optional_string, require_bool, require_number, require_string};

use super::{Check, CheckLevel, under_the_arrow};

/// Every pack check, in report order. The ledger check holds the ledger against
/// `pack_files`, this build's pack.
pub(super) fn run_checks(applier: &dyn Applier, pack_files: Option<&[PackFile]>) -> Vec<Check> {
    let mut checks = job_checks(applier);
    checks.push(check_core_rpcs(applier));
    checks.push(check_triggers(applier));
    checks.push(check_table_primary_key(applier));
    checks.push(check_sync_key(applier));
    checks.push(check_rls_enabled(applier));
    checks.push(check_trigger_search_path(applier));
    checks.push(check_change_stamp(applier));
    checks.push(check_realtime_policy(applier));
    checks.push(check_role_and_grants(applier));
    checks.push(check_column_privileges(applier));
    checks.push(check_require_atomic(applier));
    checks.push(check_ledger(applier, pack_files));

    checks
}

/// The command that installs everything this module looks for.
const PROVISION_HINT: &str = "run `kizunasync init` to provision this project";

/// The command that runs every pack file the ledger records again, which puts
/// back a pack object someone dropped or altered.
const REAPPLY_HINT: &str = "re-apply the pack with `kizunasync upgrade --reapply --yes`";

/// What a ledger a newer kizunasync recorded needs: this build refuses to
/// write to it, the re-apply included.
const UPDATE_HINT: &str = "update kizunasync to the build that recorded it or a newer one: `init`, `sync`, `upgrade`, and `deprovision` refuse to write to this database with this build";

/// A check whose query did not answer, carrying the transport's own message.
fn unreadable(id: &str, label: &str, cause: &Error) -> Check {
    Check::new(
        id,
        label,
        &format!(
            "{}\n      {PROVISION_HINT}",
            under_the_arrow(&cause.to_string())
        ),
        false,
    )
}

// MARK: - pg_cron and the three jobs

const PG_CRON_LABEL: &str = "pg_cron installed (the retention jobs' scheduler)";
const JOBS_LABEL: &str = "the three retention jobs scheduled from kizunasync._settings";
const JOB_RUNS_LABEL: &str = "the latest run of each retention job succeeded";

const PG_CRON_HINT: &str = "enable pg_cron (Dashboard → Database → Extensions, or `create extension pg_cron;` on a superuser connection): nothing schedules the retention jobs without it, and `kizunasync jobs run all` is what runs them by hand meanwhile";
const SCHEDULE_HINT: &str =
    "run `kizunasync jobs schedule` to write the kizunasync._settings schedules into pg_cron";

/// pg_cron, the jobs, and their last run come from one read: the three answers
/// are three facets of the same `cron.job` state.
fn job_checks(applier: &dyn Applier) -> Vec<Check> {
    let report = match read_jobs(applier) {
        Ok(report) => report,
        Err(cause) => {
            return vec![
                unreadable("pg-cron", PG_CRON_LABEL, &cause),
                unreadable("jobs", JOBS_LABEL, &cause),
                unreadable("job-runs", JOB_RUNS_LABEL, &cause),
            ];
        }
    };

    vec![
        Check::new("pg-cron", PG_CRON_LABEL, PG_CRON_HINT, report.pg_cron),
        check_jobs(&report),
        check_job_runs(&report),
    ]
}

/// Without the extension there is no `cron.job` to hold a job, which the
/// `pg-cron` check already reports as the error: repeating it here would say
/// the same thing twice and hide the one cause behind three.
fn check_jobs(report: &JobsReport) -> Check {
    if !report.pg_cron {
        return Check::at(
            "jobs",
            JOBS_LABEL,
            "pg_cron is absent, so no job is scheduled: see the pg-cron check",
            CheckLevel::Warn,
        );
    }

    let missing: Vec<&str> = report
        .jobs
        .iter()
        .filter(|job| job.schedule.is_none())
        .map(|job| job.name.as_str())
        .collect();
    let drifted: Vec<&str> = report
        .jobs
        .iter()
        .filter(|job| job.drift)
        .map(|job| job.name.as_str())
        .collect();
    let inactive: Vec<&str> = report
        .jobs
        .iter()
        .filter(|job| job.active == Some(false))
        .map(|job| job.name.as_str())
        .collect();
    let mut faults = Vec::new();
    if !missing.is_empty() {
        faults.push(format!("not scheduled: {}", missing.join(", ")));
    }
    if !drifted.is_empty() {
        faults.push(format!(
            "running on a schedule kizunasync._settings does not declare: {}",
            drifted.join(", ")
        ));
    }
    if !inactive.is_empty() {
        faults.push(format!("scheduled but inactive: {}", inactive.join(", ")));
    }
    if faults.is_empty() {
        return Check::new("jobs", JOBS_LABEL, SCHEDULE_HINT, true);
    }

    Check::new(
        "jobs",
        JOBS_LABEL,
        &format!("{}\n      {SCHEDULE_HINT}", faults.join("; ")),
        false,
    )
}

/// A job that has never run is the state of every freshly installed pack, so it
/// is a warning. A job whose last run raised is an error carrying pg_cron's own
/// message.
fn check_job_runs(report: &JobsReport) -> Check {
    if !report.pg_cron {
        return Check::at(
            "job-runs",
            JOB_RUNS_LABEL,
            "pg_cron is absent, so nothing has run: see the pg-cron check",
            CheckLevel::Warn,
        );
    }

    let failed: Vec<String> = report
        .jobs
        .iter()
        .filter(|job| job.last_run_succeeded() == Some(false))
        .map(|job| {
            format!(
                "{} {}{}",
                job.name,
                job.last_status.as_deref().unwrap_or_default(),
                job.last_message
                    .as_deref()
                    .filter(|message| !message.is_empty())
                    .map(|message| format!(": {message}"))
                    .unwrap_or_default()
            )
        })
        .collect();
    if !failed.is_empty() {
        return Check::new(
            "job-runs",
            JOB_RUNS_LABEL,
            &format!(
                "{}\n      run it by hand with `kizunasync jobs run all` to see the failure again",
                failed.join("\n      ")
            ),
            false,
        );
    }

    let never: Vec<&str> = report
        .jobs
        .iter()
        .filter(|job| job.last_run_succeeded().is_none())
        .map(|job| job.name.as_str())
        .collect();
    if never.is_empty() {
        return Check::new("job-runs", JOB_RUNS_LABEL, SCHEDULE_HINT, true);
    }

    Check::at(
        "job-runs",
        JOB_RUNS_LABEL,
        &format!(
            "never ran yet: {}. A freshly scheduled job has no run until its first slot, or run it now with `kizunasync jobs run all`",
            never.join(", ")
        ),
        CheckLevel::Warn,
    )
}

// MARK: - the public RPC surface

/// The RPCs a client calls, with the identity arguments the pack creates them
/// with. A signature that moved is a client that cannot resolve the function:
/// PostgREST matches on the named arguments, not on the name alone.
pub const PUBLIC_RPCS: [(&str, &str); 5] = [
    (
        "attachment_confirm",
        "p_bucket text, p_path text, p_sha256 text, p_size bigint, p_media_type text, p_table text",
    ),
    (
        "attachment_metadata",
        "p_bucket_id text, p_object_path text",
    ),
    ("attachment_vacuum", "p_bucket text, p_path text"),
    (
        "pull",
        "buckets jsonb, cursor text, schema_version integer, \"limit\" integer, client_id uuid",
    ),
    (
        "push",
        "batch jsonb, last_mutation_id uuid, schema_version integer, client_id uuid",
    ),
];

fn functions_query() -> String {
    format!(
        "select p.proname as name, pg_get_function_identity_arguments(p.oid) as args\nfrom pg_proc p\njoin pg_namespace n on n.oid = p.pronamespace\nwhere n.nspname = '{SCHEMA}'\norder by 1, 2;"
    )
}

/// Every `kizunasync` function, as name to the identity argument lists it is
/// declared with (a name can carry more than one overload).
fn read_functions(applier: &dyn Applier) -> Result<BTreeMap<String, Vec<String>>> {
    let rows = applier.run_query(&functions_query())?;
    let mut functions: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &rows {
        functions
            .entry(require_string(row, "name")?)
            .or_default()
            .push(optional_string(row, "args")?.unwrap_or_default());
    }

    Ok(functions)
}

fn check_core_rpcs(applier: &dyn Applier) -> Check {
    let id = "core-rpcs";
    let label = format!(
        "the {} public RPCs present with the pack's signatures",
        PUBLIC_RPCS.len()
    );
    let functions = match read_functions(applier) {
        Ok(functions) => functions,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let mut faults = Vec::new();
    for (name, expected) in PUBLIC_RPCS {
        match functions.get(name) {
            None => faults.push(format!("{SCHEMA}.{name} is missing")),
            Some(overloads) if !overloads.iter().any(|args| args == expected) => {
                faults.push(format!(
                    "{SCHEMA}.{name}({}) is declared, the pack creates {SCHEMA}.{name}({expected})",
                    overloads.join(") / (")
                ));
            }
            Some(_) => {}
        }
    }
    if faults.is_empty() {
        return Check::new(id, &label, PROVISION_HINT, true);
    }

    Check::new(
        id,
        &label,
        &format!(
            "{}\n      {PROVISION_HINT}, or {REAPPLY_HINT} if it is already provisioned",
            faults.join("\n      ")
        ),
        false,
    )
}

// MARK: - change-capture triggers

/// Every non-internal trigger the pack's change capture would own, as
/// `schema.table.trigger`: the shape the ledger records them under.
fn triggers_query() -> String {
    format!(
        "select n.nspname || '.' || c.relname || '.' || t.tgname as name\nfrom pg_trigger t\njoin pg_class c on c.oid = t.tgrelid\njoin pg_namespace n on n.oid = c.relnamespace\nwhere not t.tgisinternal\n  and t.tgname like '{SCHEMA}\\_%'\norder by 1;"
    )
}

fn read_names(applier: &dyn Applier, sql: &str, column: &str) -> Result<BTreeSet<String>> {
    let rows = applier.run_query(sql)?;
    let mut names = BTreeSet::new();
    for row in &rows {
        names.insert(require_string(row, column)?);
    }

    Ok(names)
}

fn check_triggers(applier: &dyn Applier) -> Check {
    let id = "triggers";
    let label =
        "every synced table carries the pack's change-capture and tombstone triggers".to_owned();
    let tables = match read_names(applier, &config_query(), "table_name") {
        Ok(tables) => tables,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let live = match read_names(applier, &triggers_query(), "name") {
        Ok(live) => live,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let missing: Vec<String> = tables
        .iter()
        .flat_map(|table| [change_trigger_name(table), delete_trigger_name(table)])
        .filter(|expected| !live.contains(expected))
        .collect();
    if missing.is_empty() {
        return Check::new(
            id,
            &format!("{label} ({} table(s))", tables.len()),
            "run `kizunasync sync` to re-provision a synced table's triggers",
            true,
        );
    }

    Check::new(
        id,
        &label,
        &format!(
            "missing: {}\n      run `kizunasync sync --add <table>` to re-provision them: a synced table without them drifts silently",
            missing.join(", ")
        ),
        false,
    )
}

// MARK: - the key every change carries

/// What the pack keys a row by, and the two ways out for a table keyed
/// otherwise.
const PRIMARY_KEY_HINT: &str = "the pack keys every change by the table's primary key: a key column is uuid, text, character varying, smallint, integer, or bigint, and a read-write table's key is not generated always as identity, since devices supply the key of every row they insert. Change the key in a migration you review first, or stop syncing the table with `kizunasync sync --remove <table> --yes`";

/// How a moved key is recorded again: always with a schema bump, since
/// devices hold the table's rows under the recorded key whatever its mode.
const SYNC_KEY_HINT: &str = "`kizunasync sync --add <table> --min-schema-version <n> --yes` records the current key, with <n> above the table's current schema version: devices hold its rows under the recorded key, pull-only or read-write, so every device has to bootstrap the table again";

/// The synced tables and every primary key in their schema, the two reads
/// both key checks start from.
fn read_synced_keys(
    applier: &dyn Applier,
) -> Result<(BTreeMap<String, TableConfig>, BTreeMap<String, PrimaryKey>)> {
    let config = load_config_from_db(applier)?;
    let keys = read_primary_keys(applier, SYNCED_TABLE_SCHEMA)?;

    Ok((config.tables, keys))
}

/// Every synced table's primary key is one the pack can key its rows by:
/// there is one, each column is of a key type, and on a read-write table no
/// column is generated always as identity.
fn check_table_primary_key(applier: &dyn Applier) -> Check {
    let id = "table-primary-key";
    let label = "every synced table has a primary key the pack can key its rows by".to_owned();
    let (tables, keys) = match read_synced_keys(applier) {
        Ok(read) => read,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let unkeyed: Vec<String> = tables
        .iter()
        .filter_map(|(table, config)| {
            let key = keys.get(table);
            if let Some(reason) = key_reason(key) {
                return Some(format!("{table}: {reason}"));
            }
            let generated: Vec<String> = key
                .filter(|_| config.sync == SyncMode::ReadWrite.as_str())?
                .generated_always_columns()
                .iter()
                .map(|column| column.name.clone())
                .collect();
            match generated.as_slice() {
                [] => None,
                [only] => Some(format!(
                    "{table}: key column {only} is generated always as identity on a read-write table"
                )),
                _ => Some(format!(
                    "{table}: key columns {} are generated always as identity on a read-write table",
                    listed(&generated)
                )),
            }
        })
        .collect();
    if unkeyed.is_empty() {
        return Check::new(
            id,
            &format!("{label} ({} table(s))", tables.len()),
            PRIMARY_KEY_HINT,
            true,
        );
    }

    Check::new(
        id,
        &label,
        &format!("{}\n      {PRIMARY_KEY_HINT}", unkeyed.join("\n      ")),
        false,
    )
}

/// Every synced table's `_config.key_columns` is its current primary key:
/// the key every change is recorded under and every device holds its rows
/// by.
fn check_sync_key(applier: &dyn Applier) -> Check {
    let id = "sync-key";
    let label = "every synced table's recorded key is its primary key".to_owned();
    let (tables, keys) = match read_synced_keys(applier) {
        Ok(read) => read,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let moved: Vec<String> = tables
        .iter()
        .filter_map(|(table, config)| {
            let recorded = describe_key_columns(&config.key_columns);
            match keys.get(table).map(PrimaryKey::column_names) {
                Some(current) if current == config.key_columns => None,
                Some(current) => Some(format!(
                    "{table}: kizunasync._config records {recorded}, and its primary key is {}",
                    describe_key_columns(&current)
                )),
                None => Some(format!(
                    "{table}: kizunasync._config records {recorded}, and it has no primary key"
                )),
            }
        })
        .collect();
    if moved.is_empty() {
        return Check::new(
            id,
            &format!("{label} ({} table(s))", tables.len()),
            SYNC_KEY_HINT,
            true,
        );
    }

    Check::new(
        id,
        &label,
        &format!("{}\n      {SYNC_KEY_HINT}", moved.join("\n      ")),
        false,
    )
}

// MARK: - row level security on synced tables

/// Every synced table whose row level security is disabled.
fn synced_rls_disabled_query() -> String {
    format!(
        "select c.relname as table_name\nfrom {SCHEMA}.{INTERNAL_CONFIG} cfg\njoin pg_namespace n on n.nspname = '{SYNCED_TABLE_SCHEMA}'\njoin pg_class c on c.relnamespace = n.oid and c.relname = cfg.table_name\nwhere c.relkind in ('r', 'p')\n  and not c.relrowsecurity\norder by 1;"
    )
}

/// A pull renders every row under the reader's own policies, so a synced
/// table without row level security hands every row to any signed-in user.
fn check_rls_enabled(applier: &dyn Applier) -> Check {
    let id = "rls-enabled";
    let label = "row level security is enabled on every synced table";
    let disabled = match read_names(applier, &synced_rls_disabled_query(), "table_name") {
        Ok(disabled) => disabled,
        Err(cause) => return unreadable(id, label, &cause),
    };
    if disabled.is_empty() {
        return Check::new(
            id,
            label,
            "keep it enabled: a pull reads every synced table under the caller's policies",
            true,
        );
    }

    Check::new(
        id,
        label,
        &format!(
            "row level security is disabled on: {}\n      enable it with `alter table public.<table> enable row level security;` and add policies: without it a pull hands every row to any signed-in user",
            disabled.into_iter().collect::<Vec<_>>().join(", ")
        ),
        false,
    )
}

// MARK: - trigger functions on synced tables

/// How a trigger function pins its `search_path`.
const TRIGGER_SEARCH_PATH_HINT: &str = "pin it with `alter function <function> set search_path = '';` and schema-qualify what the function reads";

/// Every trigger on a synced table whose function pins no `search_path`,
/// with that function.
fn unpinned_triggers_query() -> String {
    format!(
        "select n.nspname || '.' || c.relname || '.' || t.tgname as trigger_name, t.tgfoid::regprocedure::text as function_name\nfrom {SCHEMA}.{INTERNAL_CONFIG} cfg\njoin pg_namespace n on n.nspname = '{SYNCED_TABLE_SCHEMA}'\njoin pg_class c on c.relnamespace = n.oid and c.relname = cfg.table_name\njoin pg_trigger t on t.tgrelid = c.oid and not t.tgisinternal\njoin pg_proc p on p.oid = t.tgfoid\nwhere not exists (\n  select 1 from unnest(coalesce(p.proconfig, '{{}}'::text[])) as setting\n  where setting like 'search_path=%'\n)\norder by 1;"
    )
}

/// A push applies its writes through the pack's definer helpers, which run
/// with an empty `search_path`, so an unqualified name in a trigger function
/// on a synced table that pins none fails the push that fires it.
fn check_trigger_search_path(applier: &dyn Applier) -> Check {
    let id = "trigger-search-path";
    let label = "every trigger function on a synced table pins its search_path";
    let rows = match applier.run_query(&unpinned_triggers_query()) {
        Ok(rows) => rows,
        Err(cause) => return unreadable(id, label, &cause),
    };
    let mut faults = Vec::with_capacity(rows.len());
    for row in &rows {
        match (
            require_string(row, "trigger_name"),
            require_string(row, "function_name"),
        ) {
            (Ok(trigger), Ok(function)) => faults.push(format!(
                "{trigger} runs {function} without a fixed search_path"
            )),
            (Err(cause), _) | (_, Err(cause)) => return unreadable(id, label, &cause),
        }
    }
    if faults.is_empty() {
        return Check::new(id, label, TRIGGER_SEARCH_PATH_HINT, true);
    }

    Check::new(
        id,
        label,
        &format!(
            "{}\n      {TRIGGER_SEARCH_PATH_HINT}: a push applies its writes through the pack's definer helpers, which run with an empty search_path, so an unqualified name in the function fails the push that fires it",
            faults.join("\n      ")
        ),
        false,
    )
}

// MARK: - the commit-time stamp

/// A trigger the commit-time stamp runs on: its name, the table it fires on,
/// and whether it must be a deferred constraint trigger.
struct StampTrigger {
    name: &'static str,
    table: &'static str,
    deferred: bool,
}

/// The queue every change waits in, and the marker table holding one row per
/// transaction that queued one.
const PENDING_TABLE: &str = "_change_pending";
const MARKER_TABLE: &str = "_stamp_marker";

/// The statement trigger that arms the stamp at a transaction's first queued
/// change, and the deferred constraint trigger on the marker that numbers
/// every queued change as the transaction commits.
const STAMP_TRIGGERS: [StampTrigger; 2] = [
    StampTrigger {
        name: "kizunasync_arm_stamp",
        table: PENDING_TABLE,
        deferred: false,
    },
    StampTrigger {
        name: "kizunasync_stamp_transaction",
        table: MARKER_TABLE,
        deferred: true,
    },
];

/// The sequence the stamp draws from.
const CHANGE_SEQUENCE: &str = "_change_seq";

/// The Troubleshooting section that repairs a missing, disabled, or
/// non-deferred stamp trigger in SQL, the alternative to re-applying the pack.
const TRIGGER_RECOVERY_SECTION: &str = "The stamp trigger is missing, disabled, or not deferred";

/// The Troubleshooting section that numbers changes committed without a
/// number.
const RECOVERY_SECTION: &str = "Changes queued without a sequence number";

/// The line that closes a failing check, after every fault's own repair.
const CHANGE_STAMP_WHY: &str = "a change the stamp never numbers never reaches a pull";

/// One stamp invariant: the fault lines it produces, none when it holds.
type StampProbe = fn(&dyn Applier) -> Result<Vec<String>>;

/// One row per stamp trigger that exists on its own table.
fn stamp_triggers_query() -> String {
    let pairs: Vec<String> = STAMP_TRIGGERS
        .iter()
        .map(|trigger| format!("('{}', '{}')", trigger.table, trigger.name))
        .collect();

    format!(
        "select st.tgname as name, st.tgdeferrable as deferrable, st.tginitdeferred as initially_deferred, st.tgenabled <> 'D' as enabled\nfrom pg_trigger st\njoin pg_class c on c.oid = st.tgrelid\njoin pg_namespace n on n.oid = c.relnamespace\nwhere n.nspname = '{SCHEMA}' and (c.relname, st.tgname::text) in ({});",
        pairs.join(", ")
    )
}

fn marker_table_query() -> String {
    format!("select to_regclass('{SCHEMA}.{MARKER_TABLE}') is not null as present;")
}

fn sequence_cache_query() -> String {
    format!(
        "select cache_size from pg_sequences where schemaname = '{SCHEMA}' and sequencename = '{CHANGE_SEQUENCE}';"
    )
}

fn queued_changes_query() -> String {
    format!("select count(*) as queued from {SCHEMA}.{PENDING_TABLE};")
}

/// The stamp triggers' fault lines, each ending in its own repair: the marker
/// table missing, a trigger missing or disabled, or the transaction trigger
/// firing without the deferred timing the numbering needs. A missing marker
/// table is named once, since the trigger on it goes with it.
fn stamp_trigger_faults(applier: &dyn Applier) -> Result<Vec<String>> {
    let marker_present = read_present(applier, &marker_table_query())?;
    let rows = applier.run_query(&stamp_triggers_query())?;
    let mut faults = Vec::new();
    for trigger in &STAMP_TRIGGERS {
        let name = trigger.name;
        if trigger.table == MARKER_TABLE && !marker_present {
            faults.push(format!(
                "the stamp marker table {SCHEMA}.{MARKER_TABLE} is missing, and the stamp trigger {name} with it: {REAPPLY_HINT}"
            ));
            continue;
        }
        let mut found = None;
        for row in &rows {
            if require_string(row, "name")? == name {
                found = Some(row);
            }
        }
        let Some(row) = found else {
            faults.push(format!(
                "the stamp trigger {name} is missing on {SCHEMA}.{}: {REAPPLY_HINT}, or recreate it as Troubleshooting shows under \"{TRIGGER_RECOVERY_SECTION}\"",
                trigger.table
            ));
            continue;
        };
        if !require_bool(row, "enabled")? {
            faults.push(format!(
                "the stamp trigger {name} is disabled: run `alter table {SCHEMA}.{} enable trigger {name};` or {REAPPLY_HINT}",
                trigger.table
            ));
        }
        if trigger.deferred
            && !(require_bool(row, "deferrable")? && require_bool(row, "initially_deferred")?)
        {
            faults.push(format!(
                "the stamp trigger {name} is not deferrable and initially deferred: {REAPPLY_HINT}, or recreate it as Troubleshooting shows under \"{TRIGGER_RECOVERY_SECTION}\""
            ));
        }
    }

    Ok(faults)
}

/// The sequence the stamp draws from, as a fault line unless it caches one
/// value.
fn sequence_cache_faults(applier: &dyn Applier) -> Result<Vec<String>> {
    let rows = applier.run_query(&sequence_cache_query())?;
    let Some(row) = rows.first() else {
        return Err(Error::Boundary(format!(
            "{SCHEMA}.{CHANGE_SEQUENCE} is not in pg_sequences, expected exactly 1 row"
        )));
    };
    let cache_size = require_number(row, "cache_size")?;
    if cache_size == 1 {
        return Ok(Vec::new());
    }

    Ok(vec![format!(
        "{SCHEMA}.{CHANGE_SEQUENCE} caches {cache_size} values: {REAPPLY_HINT}, or run `alter sequence {SCHEMA}.{CHANGE_SEQUENCE} cache 1;`"
    )])
}

/// The queued changes doctor's own connection can see. The stamp deletes every
/// queued row before its transaction commits, so a visible one committed
/// without a number.
fn queued_changes_faults(applier: &dyn Applier) -> Result<Vec<String>> {
    let rows = applier.run_query(&queued_changes_query())?;
    let Some(row) = rows.first() else {
        return Err(Error::Boundary(
            "the queue count returned no row, expected exactly 1".to_owned(),
        ));
    };
    let queued = require_number(row, "queued")?;
    if queued == 0 {
        return Ok(Vec::new());
    }

    Ok(vec![format!(
        "{queued} queued change(s) committed without a sequence number, so no pull delivers them: restore the stamp trigger, then write to any synced table or commit one transaction that arms the stamp as Troubleshooting shows under \"{RECOVERY_SECTION}\""
    )])
}

/// A pull resumes from the largest sequence number it can see, which is safe
/// only while every number is drawn at commit: by the stamp the arm trigger
/// schedules on the marker table, from a sequence that caches one value, with
/// no queued change left behind a commit.
fn check_change_stamp(applier: &dyn Applier) -> Check {
    let id = "change-stamp";
    let label = "changes are numbered at commit";
    let probes: [StampProbe; 3] = [
        stamp_trigger_faults,
        sequence_cache_faults,
        queued_changes_faults,
    ];
    let mut faults = Vec::new();
    for probe in probes {
        match probe(applier) {
            Ok(lines) => faults.extend(lines),
            Err(cause) => return unreadable(id, label, &cause),
        }
    }
    if faults.is_empty() {
        return Check::new(
            id,
            label,
            &format!("{REAPPLY_HINT} if a stamp trigger is ever dropped or disabled"),
            true,
        );
    }

    Check::new(
        id,
        label,
        &format!("{}\n      {CHANGE_STAMP_WHY}", faults.join("\n      ")),
        false,
    )
}

// MARK: - the realtime wakeup policy

/// The cross-schema policy the pack installs so a client may RECEIVE the
/// contentless wakeup broadcast.
const WAKEUP_POLICY: (&str, &str, &str) = ("realtime", "messages", "kizunasync wakeup receive");

fn realtime_policy_query() -> String {
    let (schema, table, policy) = WAKEUP_POLICY;

    format!(
        "select exists (\n  select 1 from pg_policies\n  where schemaname = '{schema}' and tablename = '{table}' and policyname = '{policy}'\n) as present;"
    )
}

fn read_present(applier: &dyn Applier, sql: &str) -> Result<bool> {
    let rows = applier.run_query(sql)?;
    let Some(row) = rows.first() else {
        return Err(Error::Boundary(
            "an existence probe returned no row, expected exactly 1".to_owned(),
        ));
    };

    require_bool(row, "present")
}

fn check_realtime_policy(applier: &dyn Applier) -> Check {
    let id = "realtime-policy";
    let (schema, table, policy) = WAKEUP_POLICY;
    let label = format!("the wakeup policy \"{policy}\" on {schema}.{table}");
    match read_present(applier, &realtime_policy_query()) {
        Err(cause) => unreadable(id, &label, &cause),
        Ok(present) => Check::new(
            id,
            &label,
            &format!(
                "{REAPPLY_HINT}: without this policy a client never receives the realtime wakeup and falls back to its own schedule"
            ),
            present,
        ),
    }
}

// MARK: - the role and the grants that lock the surface down

/// The role the pack's apply helpers run as, so RLS is enforced against the
/// caller rather than bypassed by the definer.
const PACK_ROLE: &str = "kizunasync_rls";
/// The roles that must hold `usage` on the schema.
const SCHEMA_USERS: [&str; 2] = ["authenticated", "service_role"];
/// The operator functions the pack grants to `service_role`, and to no one
/// else: the three retention jobs, the scheduler that writes them, and the one
/// Data API operator RPC the sync inspector's Jobs panel reads.
const SERVICE_FUNCTIONS: [&str; 5] = [
    "reap_tombstones",
    "compact_changelog",
    "prune_clients",
    "_schedule_jobs",
    "jobs_status",
];

/// The one pack table `service_role` reads directly: the inspector's
/// Attachments panel lists it over a service connection.
const SERVICE_TABLE: &str = "attachments";

fn role_query() -> String {
    let [authenticated, service] = SCHEMA_USERS;

    format!(
        "select\n  coalesce((select true from pg_roles where rolname = '{PACK_ROLE}'), false) as role_present,\n  coalesce((select has_schema_privilege('{authenticated}', '{SCHEMA}', 'usage') from pg_roles where rolname = '{authenticated}'), false) as authenticated_usage,\n  coalesce((select has_schema_privilege('{service}', '{SCHEMA}', 'usage') from pg_roles where rolname = '{service}'), false) as service_usage,\n  coalesce((select has_table_privilege(r.rolname, c.oid, 'select') from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.rolname = '{service}' where n.nspname = '{SCHEMA}' and c.relname = '{SERVICE_TABLE}'), false) as service_table_select;"
    )
}

/// Who may EXECUTE what in the schema. `aclexplode` is what turns the stored
/// ACL array into rows, so an over-grant is as visible as a missing one.
fn grants_query() -> String {
    let [authenticated, service] = SCHEMA_USERS;

    format!(
        "select p.proname as name, r.rolname as grantee\nfrom pg_proc p\njoin pg_namespace n on n.oid = p.pronamespace\njoin lateral aclexplode(p.proacl) a on a.privilege_type = 'EXECUTE'\njoin pg_roles r on r.oid = a.grantee\nwhere n.nspname = '{SCHEMA}'\n  and r.rolname in ('{authenticated}', '{service}')\norder by 1, 2;"
    )
}

fn read_grants(applier: &dyn Applier) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let rows = applier.run_query(&grants_query())?;
    let mut by_grantee: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in &rows {
        by_grantee
            .entry(require_string(row, "grantee")?)
            .or_default()
            .insert(require_string(row, "name")?);
    }

    Ok(by_grantee)
}

fn check_role_and_grants(applier: &dyn Applier) -> Check {
    let id = "role-and-grants";
    let label = format!("the {PACK_ROLE} role and the pack's grants");
    let [authenticated, service] = SCHEMA_USERS;
    let rows = match applier.run_query(&role_query()) {
        Ok(rows) => rows,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let Some(row) = rows.first() else {
        return unreadable(
            id,
            &label,
            &Error::Boundary("the role probe returned no row, expected exactly 1".to_owned()),
        );
    };
    let mut faults = Vec::new();
    for (column, fault) in [
        ("role_present", format!("the role {PACK_ROLE} is missing")),
        (
            "authenticated_usage",
            format!("{authenticated} has no usage on schema {SCHEMA}"),
        ),
        (
            "service_usage",
            format!("{service} has no usage on schema {SCHEMA}"),
        ),
        (
            "service_table_select",
            format!("{service} cannot select {SCHEMA}.{SERVICE_TABLE}"),
        ),
    ] {
        match require_bool(row, column) {
            Ok(true) => {}
            Ok(false) => faults.push(fault),
            Err(cause) => return unreadable(id, &label, &cause),
        }
    }
    let grants = match read_grants(applier) {
        Ok(grants) => grants,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    faults.extend(grant_faults(&grants));
    if faults.is_empty() {
        return Check::new(
            id,
            &label,
            &format!("{REAPPLY_HINT} to restore the grants"),
            true,
        );
    }

    Check::new(
        id,
        &label,
        &format!(
            "{}\n      {REAPPLY_HINT}: the grants are what keep the client surface to the public RPCs",
            faults.join("\n      ")
        ),
        false,
    )
}

/// `authenticated` must execute the public RPCs and nothing else, and
/// `service_role` must execute the operator functions: a retention function it
/// cannot call is a job `kizunasync jobs run` cannot run over a service connection,
/// and `jobs_status` is the RPC the inspector's Jobs panel reads.
fn grant_faults(grants: &BTreeMap<String, BTreeSet<String>>) -> Vec<String> {
    let [authenticated, service] = SCHEMA_USERS;
    let empty = BTreeSet::new();
    let client = grants.get(authenticated).unwrap_or(&empty);
    let operator = grants.get(service).unwrap_or(&empty);
    let expected: BTreeSet<String> = PUBLIC_RPCS
        .iter()
        .map(|(name, _)| (*name).to_owned())
        .collect();
    let mut faults = Vec::new();
    let missing: Vec<&str> = expected
        .iter()
        .filter(|name| !client.contains(*name))
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        faults.push(format!(
            "{authenticated} cannot execute: {}",
            missing.join(", ")
        ));
    }
    let extra: Vec<&str> = client
        .iter()
        .filter(|name| !expected.contains(*name))
        .map(String::as_str)
        .collect();
    if !extra.is_empty() {
        faults.push(format!(
            "{authenticated} can execute more than the public RPCs: {}",
            extra.join(", ")
        ));
    }
    let unreachable: Vec<&str> = SERVICE_FUNCTIONS
        .iter()
        .filter(|name| !operator.contains(**name))
        .copied()
        .collect();
    if !unreachable.is_empty() {
        faults.push(format!(
            "{service} cannot execute: {}",
            unreachable.join(", ")
        ));
    }

    faults
}

// MARK: - column-level privileges on synced tables

/// How to grant or revoke what `has_column_privilege` and `has_table_privilege`
/// already answered: Postgres and Supabase both keep this out of the tooling
/// that manages everything else the pack checks.
const COLUMN_PRIVILEGES_HINT: &str = "grant or revoke column privileges by hand, in SQL or from the dashboard: the Supabase CLI and `supabase db diff` do not manage column-level privileges (https://supabase.com/docs/guides/auth/column-level-security)";

/// One synced column, and what `authenticated` may do with it. `select` is
/// true when a table-level grant covers the column as well as when a
/// column-level one does, because `has_column_privilege` already folds a
/// table-level grant into every column it covers.
struct ColumnGrant {
    column: String,
    select: bool,
    update: bool,
}

fn column_privileges_query() -> String {
    let [authenticated, _] = SCHEMA_USERS;

    format!(
        "select cfg.table_name as table_name, col.column_name as column_name,\n  has_column_privilege('{authenticated}', format('{SYNCED_TABLE_SCHEMA}.%I', cfg.table_name)::regclass, col.column_name, 'SELECT')\n    or has_table_privilege('{authenticated}', format('{SYNCED_TABLE_SCHEMA}.%I', cfg.table_name)::regclass, 'SELECT') as column_select,\n  has_column_privilege('{authenticated}', format('{SYNCED_TABLE_SCHEMA}.%I', cfg.table_name)::regclass, col.column_name, 'UPDATE') as column_update\nfrom {SCHEMA}.{INTERNAL_CONFIG} cfg\njoin information_schema.columns col\n  on col.table_schema = '{SYNCED_TABLE_SCHEMA}' and col.table_name = cfg.table_name\norder by cfg.table_name, col.ordinal_position;"
    )
}

/// `authenticated`'s privileges on every column of every synced table, keyed
/// by table name.
fn read_column_grants(applier: &dyn Applier) -> Result<BTreeMap<String, Vec<ColumnGrant>>> {
    let rows = applier.run_query(&column_privileges_query())?;
    let mut by_table: BTreeMap<String, Vec<ColumnGrant>> = BTreeMap::new();
    for row in &rows {
        by_table
            .entry(require_string(row, "table_name")?)
            .or_default()
            .push(ColumnGrant {
                column: require_string(row, "column_name")?,
                select: require_bool(row, "column_select")?,
                update: require_bool(row, "column_update")?,
            });
    }

    Ok(by_table)
}

/// One grouped fact per table naming the columns `authenticated` cannot read
/// or write, split into what only hides data (`critical: false`) and what
/// also breaks the pull outright (`critical: true`): the table's key columns
/// and its bucket column are what a pull selects to run at all, so losing any
/// one of them fails with `KZL02`. An unwritable column only matters on a `read-write`
/// table, because `push` never targets a `pull-only` one.
fn column_privilege_facts(
    tables: &BTreeMap<String, TableConfig>,
    grants: &BTreeMap<String, Vec<ColumnGrant>>,
) -> (Vec<String>, Vec<String>) {
    let mut critical = Vec::new();
    let mut other = Vec::new();
    for (table, config) in tables {
        let Some(columns) = grants.get(table) else {
            continue;
        };
        let bucket_column = config.bucket_column();
        let mut table_critical = Vec::new();
        let mut table_other = Vec::new();
        for column in columns {
            let is_pull_critical = config.key_columns.contains(&column.column)
                || bucket_column == Some(column.column.as_str());
            if !column.select {
                let fact = format!("{} is not readable by authenticated", column.column);
                if is_pull_critical {
                    table_critical.push(format!("{fact} (the pull fails with KZL02)"));
                } else {
                    table_other.push(fact);
                }
            }
            if config.sync == "read-write" && !column.update {
                table_other.push(format!(
                    "{} is not writable by authenticated",
                    column.column
                ));
            }
        }
        if !table_critical.is_empty() {
            critical.push(format!("{table}: {}", table_critical.join("; ")));
        }
        if !table_other.is_empty() {
            other.push(format!("{table}: {}", table_other.join("; ")));
        }
    }

    (critical, other)
}

/// Column-level privileges are a Postgres feature layered on top of the
/// table-level grants [`check_role_and_grants`] already covers, and Supabase
/// documents them as advanced and unmanaged by its own tooling: a project
/// that restricts one by hand can silently break a pull or a push. An
/// unreadable key or bucket column is an error, because it fails every pull
/// of that table with `KZL02`; every other hidden or unwritable column is a
/// warning, because the restriction is a deliberate, out-of-band choice
/// `kizunasync upgrade` cannot fix, and it only narrows what one column carries.
fn check_column_privileges(applier: &dyn Applier) -> Check {
    let id = "column-privileges";
    let label =
        "authenticated's column-level select and update privileges on synced tables".to_owned();
    let config = match load_config_from_db(applier) {
        Ok(config) => config,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let grants = match read_column_grants(applier) {
        Ok(grants) => grants,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let (critical, other) = column_privilege_facts(&config.tables, &grants);
    if !critical.is_empty() {
        let facts: Vec<&str> = critical
            .iter()
            .chain(other.iter())
            .map(String::as_str)
            .collect();

        return Check::new(
            id,
            &label,
            &format!("{}\n      {COLUMN_PRIVILEGES_HINT}", facts.join("\n      ")),
            false,
        );
    }
    if other.is_empty() {
        return Check::new(id, &label, COLUMN_PRIVILEGES_HINT, true);
    }

    Check::at(
        id,
        &label,
        &format!("{}\n      {COLUMN_PRIVILEGES_HINT}", other.join("\n      ")),
        CheckLevel::Warn,
    )
}

fn check_require_atomic(applier: &dyn Applier) -> Check {
    let id = "require-atomic";
    let label = "require_atomic is off, so ordinary writes stay queued";
    match applier.run_query(&settings_query()) {
        Err(cause) => unreadable(id, label, &cause),
        Ok(rows) => {
            let Some(row) = rows.first() else {
                return unreadable(
                    id,
                    label,
                    &Error::Boundary(
                        "the settings probe returned no row, expected exactly 1".to_owned(),
                    ),
                );
            };
            let on = match optional_bool(row, "require_atomic") {
                Ok(on) => on.unwrap_or(false),
                Err(cause) => return unreadable(id, label, &cause),
            };
            if on {
                Check::new(
                    id,
                    label,
                    "run `kizunasync sync --no-require-atomic --yes`: the current client sends non-atomic ordinary writes, and KZP03 would dead-letter them",
                    false,
                )
            } else {
                Check::new(
                    id,
                    label,
                    "leave require_atomic off; --require-atomic is not supported in this release",
                    true,
                )
            }
        }
    }
}

// MARK: - ledger consistency

fn roles_query() -> String {
    format!("select rolname as name from pg_roles where rolname like '{SCHEMA}\\_%' order by 1;")
}

/// The three jobs the pack schedules, by name. Scoped to them rather than to a
/// `kizunasync-%` prefix: a job someone else scheduled is not a pack object the
/// ledger promised to record.
fn cron_jobs_query() -> String {
    let names = Job::ALL
        .iter()
        .map(|job| format!("'{}'", job.job_name()))
        .collect::<Vec<_>>()
        .join(", ");

    format!("select jobname as name from cron.job where jobname in ({names}) order by 1;")
}

fn policies_query() -> String {
    let (schema, table, _) = WAKEUP_POLICY;

    format!(
        "select schemaname || '.' || tablename || '.' || policyname as name\nfrom pg_policies\nwhere schemaname = '{SCHEMA}' or (schemaname = '{schema}' and tablename = '{table}')\norder by 1;"
    )
}

/// The catalog, as the ledger's own vocabulary describes it.
struct Objects {
    functions: BTreeMap<String, Vec<String>>,
    triggers: BTreeSet<String>,
    policies: BTreeSet<String>,
    roles: BTreeSet<String>,
    config_tables: BTreeSet<String>,
    cron_jobs: Option<BTreeSet<String>>,
}

/// `public.<table>`, the shape a config ledger row records, taken from the
/// owner that emits those names rather than spelled a second time here.
fn config_object_name(table: &str) -> String {
    let trigger = change_trigger_name(table);
    match trigger.rsplit_once('.') {
        Some((qualified_table, _)) => qualified_table.to_owned(),
        None => trigger,
    }
}

fn read_objects(applier: &dyn Applier) -> Result<Objects> {
    let cron_jobs = if has_pg_cron(applier)? {
        Some(read_names(applier, &cron_jobs_query(), "name")?)
    } else {
        None
    };

    Ok(Objects {
        functions: read_functions(applier)?,
        triggers: read_names(applier, &triggers_query(), "name")?,
        policies: read_names(applier, &policies_query(), "name")?,
        roles: read_names(applier, &roles_query(), "name")?,
        config_tables: read_names(applier, &config_query(), "table_name")?,
        cron_jobs,
    })
}

/// Whether the object a ledger row claims is really there. `None` means the
/// question cannot be answered on this database, which is the cron row's case
/// without pg_cron: reporting an unanswerable question as a missing object
/// would be a lie in the loud direction.
fn ledger_row_present(row: &ProvisionRow, objects: &Objects) -> Option<bool> {
    match &row.object_kind {
        ObjectKind::Function => {
            let Some(name) = row.object_name.strip_prefix(&format!("{SCHEMA}.")) else {
                return Some(false);
            };
            let Some(overloads) = objects.functions.get(name) else {
                return Some(false);
            };

            // A row with no recorded signature names the function alone, which
            // is how the pack ledgers its zero-argument ones.
            Some(match row.object_args.as_deref() {
                None => true,
                Some(args) => overloads.iter().any(|declared| declared == args),
            })
        }
        ObjectKind::Trigger => Some(objects.triggers.contains(&row.object_name)),
        ObjectKind::Policy => Some(objects.policies.contains(&row.object_name)),
        ObjectKind::Role => Some(objects.roles.contains(&row.object_name)),
        ObjectKind::Config => Some(
            row.object_name
                .split('.')
                .next_back()
                .is_some_and(|table| objects.config_tables.contains(table)),
        ),
        ObjectKind::Cron => objects
            .cron_jobs
            .as_ref()
            .map(|jobs| jobs.contains(&row.object_name)),
        // A pack-file row is accounting, not an object, and an unknown kind is
        // already reported by `kizunasync deprovision` as a row it cannot drop.
        ObjectKind::PackFile | ObjectKind::Unknown(_) => None,
    }
}

/// The objects the pack promises to ledger: every function it creates, the
/// cron jobs, its role, and, per synced table, the config row and the two
/// change-capture triggers. The attachments policies are deliberately absent:
/// the pack ledgers the cross-schema realtime policy only, and `kizunasync
/// deprovision --purge` is what removes the in-schema ones with the schema.
fn unledgered(objects: &Objects, rows: &[ProvisionRow]) -> Vec<String> {
    let recorded = |kind: &ObjectKind| -> BTreeSet<&str> {
        rows.iter()
            .filter(|row| row.object_kind == *kind)
            .map(|row| row.object_name.as_str())
            .collect()
    };

    let mut missing = Vec::new();
    push_missing_functions(objects, &recorded(&ObjectKind::Function), &mut missing);
    push_missing_configs(
        objects,
        &recorded(&ObjectKind::Config),
        &recorded(&ObjectKind::Trigger),
        &mut missing,
    );
    push_missing_roles(objects, &recorded(&ObjectKind::Role), &mut missing);
    push_missing_crons(objects, &recorded(&ObjectKind::Cron), &mut missing);

    missing
}

fn push_missing_functions(
    objects: &Objects,
    functions: &BTreeSet<&str>,
    missing: &mut Vec<String>,
) {
    for name in objects.functions.keys() {
        let qualified = format!("{SCHEMA}.{name}");
        if !functions.contains(qualified.as_str()) {
            missing.push(qualified);
        }
    }
}

/// Each synced table's config row, then its two change-capture triggers when
/// the pack actually creates them (a pull-only table has no delete trigger).
fn push_missing_configs(
    objects: &Objects,
    configs: &BTreeSet<&str>,
    triggers: &BTreeSet<&str>,
    missing: &mut Vec<String>,
) {
    for table in &objects.config_tables {
        let qualified = config_object_name(table);
        if !configs.contains(qualified.as_str()) {
            missing.push(qualified);
        }
        for trigger in [change_trigger_name(table), delete_trigger_name(table)] {
            if objects.triggers.contains(&trigger) && !triggers.contains(trigger.as_str()) {
                missing.push(trigger);
            }
        }
    }
}

fn push_missing_roles(objects: &Objects, roles: &BTreeSet<&str>, missing: &mut Vec<String>) {
    for role in &objects.roles {
        if !roles.contains(role.as_str()) {
            missing.push(role.clone());
        }
    }
}

fn push_missing_crons(objects: &Objects, crons: &BTreeSet<&str>, missing: &mut Vec<String>) {
    for job in objects.cron_jobs.iter().flatten() {
        if !crons.contains(job.as_str()) {
            missing.push(job.clone());
        }
    }
}

fn check_ledger(applier: &dyn Applier, pack_files: Option<&[PackFile]>) -> Check {
    let id = "ledger";
    let label =
        format!("{SCHEMA}._provisions describes what the database holds, in both directions");
    let rows = match read_ledger(applier) {
        Ok(rows) => rows,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let versions = match read_ledger_rows(applier) {
        Ok(versions) => versions,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let newer = ledger_newer(&versions, crate::VERSION);
    // A pack a newer build recorded gets one line, with the update it needs,
    // because this build cannot re-apply over it.
    let differing = match pack_files {
        Some(files) if newer.is_empty() => describe_offenders(&plan_provision(files, &versions)),
        _ => Vec::new(),
    };
    let objects = match read_objects(applier) {
        Ok(objects) => objects,
        Err(cause) => return unreadable(id, &label, &cause),
    };
    let absent: Vec<String> = rows
        .iter()
        .filter(|row| ledger_row_present(row, &objects) == Some(false))
        .map(|row| {
            format!(
                "[{}] {}{}",
                row.object_kind.as_str(),
                row.object_name,
                row.object_args
                    .as_deref()
                    .map(|args| format!("({args})"))
                    .unwrap_or_default()
            )
        })
        .collect();
    let missing = unledgered(&objects, &rows);
    if newer.is_empty() && differing.is_empty() && absent.is_empty() && missing.is_empty() {
        return Check::new(
            id,
            &format!("{label} ({} row(s))", rows.len()),
            &format!("{REAPPLY_HINT} when the ledger and the database disagree"),
            true,
        );
    }
    let mut faults: Vec<String> = newer
        .iter()
        .map(|row| {
            format!(
                "{}: recorded by kizunasync {}, newer than this build",
                row.name, row.pack_version
            )
        })
        .collect();
    if !differing.is_empty() {
        faults.push("this build's pack differs from the one the ledger records:".to_owned());
        faults.extend(differing.iter().map(|line| line.trim_start().to_owned()));
    }
    if !absent.is_empty() {
        faults.push(format!(
            "ledgered but absent, so `kizunasync deprovision` would not drop them: {}",
            absent.join(", ")
        ));
    }
    if !missing.is_empty() {
        faults.push(format!(
            "present but unledgered, so `kizunasync deprovision` would leave them: {}",
            missing.join(", ")
        ));
    }

    let closer = if newer.is_empty() {
        REAPPLY_HINT
    } else {
        UPDATE_HINT
    };

    Check::new(
        id,
        &label,
        &format!("{}\n      {closer}", faults.join("\n      ")),
        false,
    )
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
