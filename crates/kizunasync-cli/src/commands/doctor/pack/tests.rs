use super::*;
use crate::applier::fake::{FakeApplier, text_row};
use crate::commands::jobs::Job;
use crate::provision::hash_pack_file;
use crate::row::Row;

const PG_CRON: &str = "extname = 'pg_cron'";
const SETTINGS: &str = "select * from kizunasync._settings;";
const CRON_JOBS: &str = "from cron.job j";
const FUNCTIONS: &str = "pg_get_function_identity_arguments";
const TRIGGERS: &str = "from pg_trigger t";
const REALTIME_POLICY: &str = "select 1 from pg_policies";
const ROLE_PROBE: &str = "role_present";
const GRANTS: &str = "aclexplode";
const ROLES: &str = "rolname like";
const LEDGER_CRON: &str = "from cron.job where jobname in";
const LEDGER_POLICIES: &str = "|| policyname as name";
const LEDGER: &str = "from kizunasync._provisions";
const LEDGER_PRESENT: &str = "to_regclass('kizunasync._provisions')";
const PACK_FILE_ROWS: &str = "content_hash, pack_version";
const CONFIG_ROWS: &str = "select * from kizunasync._config order by table_name;";
const COLUMN_PRIVILEGES: &str = "has_column_privilege";
const STAMP_TRIGGER_PROBE: &str = "from pg_trigger st";
const SEQUENCE_CACHE: &str = "from pg_sequences";
const QUEUED_CHANGES: &str = "from kizunasync._change_pending";
const RLS_DISABLED: &str = "not c.relrowsecurity";
const UNPINNED_TRIGGERS: &str = "search_path=%";
const PRIMARY_KEYS: &str = "indisprimary";

/// One column of `table`'s primary key, as the key read returns it.
fn key_row(table: &str, column: &str, data_type: &str) -> Row {
    text_row(&[
        ("table_name", table),
        ("constraint_name", &format!("{table}_pkey")),
        ("column_name", column),
        ("data_type", data_type),
    ])
}

/// Every function the pack creates in this fixture, with the identity
/// arguments both the catalog and the ledger carry for it.
fn pack_functions() -> Vec<(&'static str, &'static str)> {
    let mut functions: Vec<(&str, &str)> = PUBLIC_RPCS.to_vec();
    functions.extend([
        ("reap_tombstones", ""),
        ("compact_changelog", ""),
        ("prune_clients", ""),
        ("_schedule_jobs", ""),
        ("jobs_status", ""),
    ]);

    functions
}

fn function_rows() -> Vec<Row> {
    pack_functions()
        .into_iter()
        .map(|(name, args)| text_row(&[("name", name), ("args", args)]))
        .collect()
}

fn ledger_rows() -> Vec<Row> {
    let mut rows: Vec<Row> = pack_functions()
        .into_iter()
        .map(|(name, args)| {
            text_row(&[
                ("object_kind", "function"),
                ("object_name", &format!("kizunasync.{name}")),
                ("object_args", args),
            ])
        })
        .collect();
    rows.push(text_row(&[
        ("object_kind", "policy"),
        ("object_name", "realtime.messages.kizunasync wakeup receive"),
        ("object_args", ""),
    ]));
    for job in Job::ALL {
        rows.push(text_row(&[
            ("object_kind", "cron"),
            ("object_name", job.job_name()),
            ("object_args", ""),
        ]));
    }
    rows.push(text_row(&[
        ("object_kind", "role"),
        ("object_name", "kizunasync_rls"),
        ("object_args", ""),
    ]));
    rows.push(text_row(&[
        ("object_kind", "config"),
        ("object_name", "public.todos"),
        ("object_args", ""),
    ]));
    for trigger in [change_trigger_name("todos"), delete_trigger_name("todos")] {
        rows.push(text_row(&[
            ("object_kind", "trigger"),
            ("object_name", &trigger),
            ("object_args", ""),
        ]));
    }
    rows.push(text_row(&[
        ("object_kind", "pack-file"),
        ("object_name", "0001_kizuna_init.sql"),
        ("object_args", ""),
    ]));

    rows
}

fn grant_rows() -> Vec<Row> {
    let mut rows: Vec<Row> = PUBLIC_RPCS
        .iter()
        .map(|(name, _)| text_row(&[("name", name), ("grantee", "authenticated")]))
        .collect();
    rows.extend(
        SERVICE_FUNCTIONS
            .iter()
            .map(|name| text_row(&[("name", name), ("grantee", "service_role")])),
    );

    rows
}

/// Rows for [`COLUMN_PRIVILEGES`], `(column, select, update)` per column of
/// the fixture's one synced table, `todos`.
fn column_privilege_rows(columns: &[(&str, bool, bool)]) -> Vec<Row> {
    columns
        .iter()
        .map(|(column, select, update)| {
            text_row(&[
                ("table_name", "todos"),
                ("column_name", column),
                ("column_select", if *select { "t" } else { "f" }),
                ("column_update", if *update { "t" } else { "f" }),
            ])
        })
        .collect()
}

fn cron_job_rows() -> Vec<Row> {
    Job::ALL
        .iter()
        .map(|job| {
            text_row(&[
                ("jobname", job.job_name()),
                (
                    "schedule",
                    match job {
                        Job::Reap => "16 3 * * *",
                        Job::Compact => "47 3 * * *",
                        Job::Prune => "31 3 * * *",
                    },
                ),
                ("active", "t"),
                ("last_start", "2026-09-11 03:16:00+00"),
                ("last_status", "succeeded"),
            ])
        })
        .collect()
}

/// The stamp trigger's catalog row, as `t`/`f` for deferrable, initially
/// deferred, and enabled.
fn stamp_trigger_row(deferrable: &str, initially_deferred: &str, enabled: &str) -> Row {
    text_row(&[
        ("deferrable", deferrable),
        ("initially_deferred", initially_deferred),
        ("enabled", enabled),
    ])
}

/// A provisioned database with one synced table. `overrides` are consulted
/// first, so a test replaces exactly the one answer it is about.
fn database(overrides: Vec<(&str, Vec<Row>)>) -> FakeApplier {
    let mut applier = FakeApplier::new();
    for (needle, rows) in overrides {
        applier = applier.answer(needle, rows);
    }

    applier
        .answer(PG_CRON, vec![text_row(&[("present", "t")])])
        .answer(SETTINGS, vec![settings_row("f")])
        .answer(CRON_JOBS, cron_job_rows())
        .answer(FUNCTIONS, function_rows())
        .answer(
            CONFIG_ROWS,
            vec![text_row(&[
                ("table_name", "todos"),
                ("sync_mode", "read-write"),
                ("bucket_column", "user_id"),
            ])],
        )
        .answer(
            COLUMN_PRIVILEGES,
            column_privilege_rows(&[
                ("id", true, true),
                ("user_id", true, true),
                ("title", true, true),
            ]),
        )
        .answer(
            TRIGGERS,
            vec![
                text_row(&[("name", &change_trigger_name("todos"))]),
                text_row(&[("name", &delete_trigger_name("todos"))]),
            ],
        )
        .answer(PRIMARY_KEYS, vec![key_row("todos", "id", "uuid")])
        .answer(STAMP_TRIGGER_PROBE, vec![stamp_trigger_row("t", "t", "t")])
        .answer(SEQUENCE_CACHE, vec![text_row(&[("cache_size", "1")])])
        .answer(QUEUED_CHANGES, vec![text_row(&[("queued", "0")])])
        .answer(REALTIME_POLICY, vec![text_row(&[("present", "t")])])
        .answer(
            ROLE_PROBE,
            vec![text_row(&[
                ("role_present", "t"),
                ("authenticated_usage", "t"),
                ("service_usage", "t"),
                ("service_table_select", "t"),
            ])],
        )
        .answer(GRANTS, grant_rows())
        .answer(ROLES, vec![text_row(&[("name", "kizunasync_rls")])])
        .answer(
            LEDGER_CRON,
            Job::ALL
                .iter()
                .map(|job| text_row(&[("name", job.job_name())]))
                .collect(),
        )
        .answer(
            LEDGER_POLICIES,
            vec![
                text_row(&[(
                    "name",
                    "kizunasync.attachments.Attachments are visible to their owner.",
                )]),
                text_row(&[("name", "realtime.messages.kizunasync wakeup receive")]),
            ],
        )
        .answer(LEDGER_PRESENT, vec![text_row(&[("present", "t")])])
        .answer(PACK_FILE_ROWS, vec![pack_file_row(crate::VERSION)])
        .answer(LEDGER, ledger_rows())
}

/// The settings row with the pack's schedules and `require_atomic` as `t`/`f`.
fn settings_row(require_atomic: &str) -> Row {
    text_row(&[
        ("require_atomic", require_atomic),
        ("reap_schedule", "16 3 * * *"),
        ("compact_schedule", "47 3 * * *"),
        ("client_prune_schedule", "31 3 * * *"),
    ])
}

/// The `pack-file` row the planner reads, as the build `version` wrote it.
fn pack_file_row(version: &str) -> Row {
    text_row(&[
        ("object_kind", "pack-file"),
        ("object_name", "0001_kizuna_init.sql"),
        ("content_hash", "recorded"),
        ("pack_version", version),
    ])
}

fn run_pack_checks(applier: &FakeApplier) -> Vec<Check> {
    run_checks(applier, None)
}

/// This build's pack, as the ledger check compares it: one file.
fn shipped(sql: &str) -> Vec<PackFile> {
    vec![PackFile {
        name: "0001_kizuna_init.sql".to_owned(),
        sql: sql.to_owned(),
    }]
}

/// The `pack-file` row that records `sql`'s md5 for `0001_kizuna_init.sql`.
fn recording(sql: &str) -> Row {
    text_row(&[
        ("object_kind", "pack-file"),
        ("object_name", "0001_kizuna_init.sql"),
        ("content_hash", &hash_pack_file(sql)),
        ("pack_version", crate::VERSION),
    ])
}

fn check_named<'a>(checks: &'a [Check], id: &str) -> &'a Check {
    checks
        .iter()
        .find(|check| check.id == id)
        .unwrap_or_else(|| panic!("no check with id {id}"))
}

#[test]
fn a_provisioned_database_passes_every_pack_check() {
    let checks = run_pack_checks(&database(Vec::new()));

    assert_eq!(
        checks
            .iter()
            .map(|check| check.id.as_str())
            .collect::<Vec<_>>(),
        [
            "pg-cron",
            "jobs",
            "job-runs",
            "core-rpcs",
            "triggers",
            "table-primary-key",
            "rls-enabled",
            "trigger-search-path",
            "change-stamp",
            "realtime-policy",
            "role-and-grants",
            "column-privileges",
            "require-atomic",
            "ledger"
        ]
    );
    for check in &checks {
        assert!(check.passed(), "{}: {}", check.id, check.hint);
    }
}

/// The pack's triggers key every change by `new.id` and `old.id`, so a synced
/// table keyed otherwise fails every insert and delete. The check names each
/// such table with the key it has.
#[test]
fn a_synced_table_keyed_otherwise_fails_the_primary_key_check_naming_its_key() {
    for (rows, named) in [
        (
            vec![
                key_row("todos", "user_id", "uuid"),
                key_row("todos", "slug", "text"),
            ],
            "todos: primary key (user_id uuid, slug text)",
        ),
        (
            vec![key_row("todos", "id", "bigint")],
            "todos: primary key (id bigint)",
        ),
        (Vec::new(), "todos: no primary key"),
    ] {
        let checks = run_pack_checks(&database(vec![(PRIMARY_KEYS, rows)]));
        let check = check_named(&checks, "table-primary-key");

        assert_eq!(check.level, CheckLevel::Error, "{named}");
        assert!(check.hint.contains(named), "{}", check.hint);
        assert!(
            check.hint.contains("kizunasync sync --remove"),
            "{}",
            check.hint
        );
        for other in checks.iter().filter(|other| other.id != check.id) {
            assert!(other.passed(), "{}: {}", other.id, other.hint);
        }
    }
}

/// `require_atomic` comes from the whole settings row: on fails the check, and
/// a row without the column, as an older pack wrote it, reads as off.
#[test]
fn the_require_atomic_check_reads_the_whole_settings_row() {
    let on = database(vec![(SETTINGS, vec![settings_row("t")])]);
    let without = database(vec![(
        SETTINGS,
        vec![text_row(&[("reap_schedule", "16 3 * * *")])],
    )]);

    assert!(!check_named(&run_pack_checks(&on), "require-atomic").passed());
    assert!(check_named(&run_pack_checks(&without), "require-atomic").passed());
    assert!(
        !without
            .executed
            .borrow()
            .iter()
            .any(|sql| sql.contains("select require_atomic")),
        "{:?}",
        without.executed.borrow()
    );
}

/// The synced tables the trigger and ledger checks weigh come from whole
/// `_config` rows, like every other read of that table.
#[test]
fn the_synced_tables_are_read_from_whole_config_rows() {
    let applier = database(Vec::new());
    let checks = run_pack_checks(&applier);

    assert!(check_named(&checks, "triggers").passed());
    assert!(
        !applier
            .executed
            .borrow()
            .iter()
            .any(|sql| sql.contains("select table_name from kizunasync._config")),
        "{:?}",
        applier.executed.borrow()
    );
}

#[test]
fn every_check_carries_a_hint_even_when_it_passed() {
    for check in run_pack_checks(&database(Vec::new())) {
        assert!(!check.hint.is_empty(), "{} has no hint", check.id);
        assert!(!check.label.is_empty(), "{} has no label", check.id);
    }
}

#[test]
fn without_the_extension_only_pg_cron_is_an_error() {
    let checks = run_pack_checks(&database(vec![(
        PG_CRON,
        vec![text_row(&[("present", "f")])],
    )]));

    assert_eq!(check_named(&checks, "pg-cron").level, CheckLevel::Error);
    assert_eq!(check_named(&checks, "jobs").level, CheckLevel::Warn);
    assert_eq!(check_named(&checks, "job-runs").level, CheckLevel::Warn);
    assert!(
        check_named(&checks, "pg-cron")
            .hint
            .contains("kizunasync jobs run all")
    );
}

#[test]
fn a_job_running_on_an_undeclared_schedule_fails_the_jobs_check() {
    let mut drifted = cron_job_rows();
    drifted[0] = text_row(&[
        ("jobname", Job::Reap.job_name()),
        ("schedule", "0 4 * * *"),
        ("active", "t"),
    ]);
    let checks = run_pack_checks(&database(vec![(CRON_JOBS, drifted)]));
    let jobs = check_named(&checks, "jobs");

    assert_eq!(jobs.level, CheckLevel::Error);
    assert!(jobs.hint.contains("does not declare"));
    assert!(jobs.hint.contains("kizunasync jobs schedule"));
}

#[test]
fn a_job_that_is_not_scheduled_at_all_fails_the_jobs_check() {
    let checks = run_pack_checks(&database(vec![(
        CRON_JOBS,
        vec![cron_job_rows()[0].clone()],
    )]));
    let jobs = check_named(&checks, "jobs");

    assert_eq!(jobs.level, CheckLevel::Error);
    assert!(
        jobs.hint
            .contains("not scheduled: kizunasync-compact-changelog")
    );
}

#[test]
fn a_job_that_never_ran_is_a_warning_and_a_failed_one_is_an_error() {
    let never: Vec<Row> = Job::ALL
        .iter()
        .map(|job| {
            text_row(&[
                ("jobname", job.job_name()),
                (
                    "schedule",
                    match job {
                        Job::Reap => "16 3 * * *",
                        Job::Compact => "47 3 * * *",
                        Job::Prune => "31 3 * * *",
                    },
                ),
                ("active", "t"),
            ])
        })
        .collect();
    let checks = run_pack_checks(&database(vec![(CRON_JOBS, never)]));
    let runs = check_named(&checks, "job-runs");

    assert_eq!(runs.level, CheckLevel::Warn);
    assert!(runs.hint.contains("never ran yet"));

    let mut failed = cron_job_rows();
    failed[0] = text_row(&[
        ("jobname", Job::Reap.job_name()),
        ("schedule", "16 3 * * *"),
        ("active", "t"),
        ("last_status", "failed"),
        ("last_message", "permission denied for table _tombstones"),
    ]);
    let checks = run_pack_checks(&database(vec![(CRON_JOBS, failed)]));
    let runs = check_named(&checks, "job-runs");

    assert_eq!(runs.level, CheckLevel::Error);
    assert!(
        runs.hint
            .contains("permission denied for table _tombstones")
    );
}

#[test]
fn a_missing_rpc_and_a_moved_signature_both_fail_core_rpcs() {
    let without_pull: Vec<Row> = function_rows()
        .into_iter()
        .filter(|row| row.get("name") != Some(&serde_json::Value::String("pull".to_owned())))
        .collect();
    let checks = run_pack_checks(&database(vec![(FUNCTIONS, without_pull)]));
    let rpcs = check_named(&checks, "core-rpcs");

    assert_eq!(rpcs.level, CheckLevel::Error);
    assert!(rpcs.hint.contains("kizunasync.pull is missing"));

    let moved: Vec<Row> = function_rows()
        .into_iter()
        .map(|row| {
            if row.get("name") == Some(&serde_json::Value::String("push".to_owned())) {
                return text_row(&[
                    ("name", "push"),
                    (
                        "args",
                        "batch jsonb, last_mutation_id uuid, schema_version integer",
                    ),
                ]);
            }

            row
        })
        .collect();
    let checks = run_pack_checks(&database(vec![(FUNCTIONS, moved)]));
    let rpcs = check_named(&checks, "core-rpcs");

    assert_eq!(rpcs.level, CheckLevel::Error);
    assert!(
        rpcs.hint
            .contains("the pack creates kizunasync.push(batch jsonb")
    );
}

/// The line every failing `change-stamp` hint closes on.
const STAMP_WHY: &str = "a change the stamp never numbers never reaches a pull";

#[test]
fn a_deferred_stamp_a_one_value_cache_and_an_empty_queue_pass_the_change_stamp_check() {
    let checks = run_pack_checks(&database(Vec::new()));
    let stamp = check_named(&checks, "change-stamp");

    assert!(stamp.passed(), "{}", stamp.hint);
    assert_eq!(stamp.label, "changes are numbered at commit");
    assert_eq!(
        stamp.hint,
        "re-apply the pack with `kizunasync upgrade --reapply --yes` if the stamp trigger is ever dropped or disabled"
    );
}

#[test]
fn a_missing_stamp_trigger_fails_the_change_stamp_check_on_its_own() {
    let checks = run_pack_checks(&database(vec![(STAMP_TRIGGER_PROBE, Vec::new())]));
    let stamp = check_named(&checks, "change-stamp");

    assert_eq!(stamp.level, CheckLevel::Error);
    assert_eq!(
        stamp.hint,
        format!(
            "the stamp trigger kizunasync_stamp_change is missing on kizunasync._change_pending: re-apply the pack with `kizunasync upgrade --reapply --yes`, or recreate it as Troubleshooting shows under \"The stamp trigger is missing, disabled, or not deferred\"\n      {STAMP_WHY}"
        )
    );
}

#[test]
fn a_disabled_stamp_trigger_names_its_own_repair() {
    let checks = run_pack_checks(&database(vec![(
        STAMP_TRIGGER_PROBE,
        vec![stamp_trigger_row("t", "t", "f")],
    )]));
    let stamp = check_named(&checks, "change-stamp");

    assert_eq!(stamp.level, CheckLevel::Error);
    assert_eq!(
        stamp.hint,
        format!(
            "the stamp trigger kizunasync_stamp_change is disabled: run `alter table kizunasync._change_pending enable trigger kizunasync_stamp_change;` or re-apply the pack with `kizunasync upgrade --reapply --yes`\n      {STAMP_WHY}"
        )
    );
}

#[test]
fn a_stamp_trigger_that_fires_before_commit_names_its_own_repair() {
    let checks = run_pack_checks(&database(vec![(
        STAMP_TRIGGER_PROBE,
        vec![stamp_trigger_row("f", "f", "t")],
    )]));
    let stamp = check_named(&checks, "change-stamp");

    assert_eq!(stamp.level, CheckLevel::Error);
    assert_eq!(
        stamp.hint,
        format!(
            "the stamp trigger kizunasync_stamp_change is not deferrable and initially deferred: re-apply the pack with `kizunasync upgrade --reapply --yes`, or recreate it as Troubleshooting shows under \"The stamp trigger is missing, disabled, or not deferred\"\n      {STAMP_WHY}"
        )
    );
}

#[test]
fn a_disabled_stamp_trigger_that_fires_early_reports_both_lines() {
    let checks = run_pack_checks(&database(vec![(
        STAMP_TRIGGER_PROBE,
        vec![stamp_trigger_row("t", "f", "f")],
    )]));
    let stamp = check_named(&checks, "change-stamp");

    assert_eq!(stamp.level, CheckLevel::Error);
    assert!(
        stamp.hint.contains("is disabled: run `alter table"),
        "{}",
        stamp.hint
    );
    assert!(
        stamp
            .hint
            .contains("is not deferrable and initially deferred"),
        "{}",
        stamp.hint
    );
    assert!(stamp.hint.ends_with(STAMP_WHY), "{}", stamp.hint);
}

#[test]
fn a_cached_change_sequence_fails_the_change_stamp_check_with_its_size() {
    let checks = run_pack_checks(&database(vec![(
        SEQUENCE_CACHE,
        vec![text_row(&[("cache_size", "20")])],
    )]));
    let stamp = check_named(&checks, "change-stamp");

    assert_eq!(stamp.level, CheckLevel::Error);
    assert_eq!(
        stamp.hint,
        format!(
            "kizunasync._change_seq caches 20 values: re-apply the pack with `kizunasync upgrade --reapply --yes`, or run `alter sequence kizunasync._change_seq cache 1;`\n      {STAMP_WHY}"
        )
    );
}

#[test]
fn a_committed_queued_change_fails_the_change_stamp_check() {
    let checks = run_pack_checks(&database(vec![(
        QUEUED_CHANGES,
        vec![text_row(&[("queued", "3")])],
    )]));
    let stamp = check_named(&checks, "change-stamp");

    assert_eq!(stamp.level, CheckLevel::Error);
    assert_eq!(
        stamp.hint,
        format!(
            "3 queued change(s) committed without a sequence number, so no pull delivers them: restore the stamp trigger, then re-queue them as Troubleshooting shows under \"Changes queued without a sequence number\"\n      {STAMP_WHY}"
        )
    );
}

#[test]
fn a_synced_table_missing_a_tracker_fails_the_triggers_check() {
    let checks = run_pack_checks(&database(vec![(
        TRIGGERS,
        vec![text_row(&[("name", &change_trigger_name("todos"))])],
    )]));
    let triggers = check_named(&checks, "triggers");

    assert_eq!(triggers.level, CheckLevel::Error);
    assert!(
        triggers
            .hint
            .contains("missing: public.todos.kizunasync_track_delete")
    );
    assert!(triggers.hint.contains("kizunasync sync --add"));
}

#[test]
fn a_synced_table_without_row_level_security_fails_the_rls_check() {
    let checks = run_pack_checks(&database(vec![(
        RLS_DISABLED,
        vec![
            text_row(&[("table_name", "notes")]),
            text_row(&[("table_name", "todos")]),
        ],
    )]));
    let rls = check_named(&checks, "rls-enabled");

    assert_eq!(rls.level, CheckLevel::Error);
    assert!(
        rls.hint
            .contains("row level security is disabled on: notes, todos"),
        "{}",
        rls.hint
    );
    assert!(
        rls.hint
            .contains("alter table public.<table> enable row level security;"),
        "{}",
        rls.hint
    );
}

#[test]
fn a_trigger_function_without_a_fixed_search_path_fails_its_check() {
    let checks = run_pack_checks(&database(vec![(
        UNPINNED_TRIGGERS,
        vec![text_row(&[
            ("trigger_name", "public.todos.touch_updated_at"),
            ("function_name", "touch_updated_at()"),
        ])],
    )]));
    let search_path = check_named(&checks, "trigger-search-path");

    assert_eq!(search_path.level, CheckLevel::Error);
    assert!(
        search_path.hint.contains(
            "public.todos.touch_updated_at runs touch_updated_at() without a fixed search_path"
        ),
        "{}",
        search_path.hint
    );
    assert!(
        search_path
            .hint
            .contains("alter function <function> set search_path = '';"),
        "{}",
        search_path.hint
    );
}

#[test]
fn an_unreadable_catalog_fails_both_table_checks_with_the_cause() {
    let checks = run_pack_checks(&database(vec![
        (RLS_DISABLED, Vec::new()),
        (UNPINNED_TRIGGERS, Vec::new()),
    ]));
    for id in ["rls-enabled", "trigger-search-path"] {
        assert!(check_named(&checks, id).passed(), "{id}");
    }

    let unreadable = FakeApplier::new()
        .fail(RLS_DISABLED, "permission denied")
        .fail(UNPINNED_TRIGGERS, "permission denied");
    let checks = run_pack_checks(&unreadable);
    for id in ["rls-enabled", "trigger-search-path"] {
        let check = check_named(&checks, id);

        assert_eq!(check.level, CheckLevel::Error, "{id}");
        assert!(
            check.hint.contains("permission denied"),
            "{id}: {}",
            check.hint
        );
    }
}

#[test]
fn an_absent_wakeup_policy_is_an_error() {
    let checks = run_pack_checks(&database(vec![(
        REALTIME_POLICY,
        vec![text_row(&[("present", "f")])],
    )]));
    let policy = check_named(&checks, "realtime-policy");

    assert_eq!(policy.level, CheckLevel::Error);
    assert!(policy.label.contains("kizunasync wakeup receive"));
}

#[test]
fn the_grants_check_names_a_missing_grant_an_over_grant_and_a_missing_role() {
    let checks = run_pack_checks(&database(vec![(
        ROLE_PROBE,
        vec![text_row(&[
            ("role_present", "f"),
            ("authenticated_usage", "t"),
            ("service_usage", "f"),
            ("service_table_select", "f"),
        ])],
    )]));
    let grants = check_named(&checks, "role-and-grants");

    assert_eq!(grants.level, CheckLevel::Error);
    assert!(grants.hint.contains("the role kizunasync_rls is missing"));
    assert!(grants.hint.contains("service_role has no usage"));
    assert!(
        grants
            .hint
            .contains("service_role cannot select kizunasync.attachments")
    );

    let mut over = grant_rows();
    over.push(text_row(&[
        ("name", "_apply_upsert"),
        ("grantee", "authenticated"),
    ]));
    let checks = run_pack_checks(&database(vec![(GRANTS, over)]));
    let grants = check_named(&checks, "role-and-grants");

    assert_eq!(grants.level, CheckLevel::Error);
    assert!(
        grants
            .hint
            .contains("authenticated can execute more than the public RPCs: _apply_upsert")
    );

    let without_service: Vec<Row> = grant_rows()
        .into_iter()
        .filter(|row| {
            row.get("grantee") != Some(&serde_json::Value::String("service_role".to_owned()))
        })
        .collect();
    let checks = run_pack_checks(&database(vec![(GRANTS, without_service)]));
    let grants = check_named(&checks, "role-and-grants");

    assert_eq!(grants.level, CheckLevel::Error);
    assert!(
        grants
            .hint
            .contains("service_role cannot execute: reap_tombstones")
    );
}

/// The two grants the sync inspector's operator panels depend on: without
/// either one the check passed while the panel it feeds answered nothing.
#[test]
fn the_grants_check_names_the_operator_rpc_and_the_attachments_read() {
    let without_jobs_status: Vec<Row> = grant_rows()
        .into_iter()
        .filter(|row| row.get("name") != Some(&serde_json::Value::String("jobs_status".to_owned())))
        .collect();
    let checks = run_pack_checks(&database(vec![(GRANTS, without_jobs_status)]));
    let grants = check_named(&checks, "role-and-grants");

    assert_eq!(grants.level, CheckLevel::Error);
    assert!(
        grants
            .hint
            .contains("service_role cannot execute: jobs_status")
    );

    let checks = run_pack_checks(&database(vec![(
        ROLE_PROBE,
        vec![text_row(&[
            ("role_present", "t"),
            ("authenticated_usage", "t"),
            ("service_usage", "t"),
            ("service_table_select", "f"),
        ])],
    )]));
    let grants = check_named(&checks, "role-and-grants");

    assert_eq!(grants.level, CheckLevel::Error);
    assert!(
        grants
            .hint
            .contains("service_role cannot select kizunasync.attachments")
    );
}

/// A column that is neither `id` nor the bucket column, hidden from both
/// `SELECT` and `UPDATE`, is a warning naming it both ways: it never fails
/// `doctor`'s exit code, because the restriction is a deliberate, hand-applied
/// choice `kizunasync upgrade` cannot fix.
#[test]
fn a_hidden_non_critical_column_is_a_warning_naming_it_unreadable_and_unwritable() {
    let checks = run_pack_checks(&database(vec![(
        COLUMN_PRIVILEGES,
        column_privilege_rows(&[
            ("id", true, true),
            ("user_id", true, true),
            ("likes", false, false),
        ]),
    )]));
    let privileges = check_named(&checks, "column-privileges");

    assert_eq!(privileges.level, CheckLevel::Warn);
    assert!(
        privileges.hint.contains(
            "todos: likes is not readable by authenticated; likes is not writable by authenticated"
        ),
        "{}",
        privileges.hint
    );
}

/// `id` unreadable is an error, not a warning, because it names `KZL02`: that
/// column is what every pull selects to run at all.
#[test]
fn an_unreadable_id_column_fails_the_check_naming_kzl02() {
    let checks = run_pack_checks(&database(vec![(
        COLUMN_PRIVILEGES,
        column_privilege_rows(&[
            ("id", false, true),
            ("user_id", true, true),
            ("title", true, true),
        ]),
    )]));
    let privileges = check_named(&checks, "column-privileges");

    assert_eq!(privileges.level, CheckLevel::Error);
    assert!(
        privileges
            .hint
            .contains("id is not readable by authenticated")
    );
    assert!(privileges.hint.contains("KZL02"));
}

/// The bucket column is exactly as critical as `id`: losing it fails the same
/// pull with `KZL02`, so it is an error too.
#[test]
fn an_unreadable_bucket_column_fails_the_check_naming_kzl02() {
    let checks = run_pack_checks(&database(vec![(
        COLUMN_PRIVILEGES,
        column_privilege_rows(&[
            ("id", true, true),
            ("user_id", false, true),
            ("title", true, true),
        ]),
    )]));
    let privileges = check_named(&checks, "column-privileges");

    assert_eq!(privileges.level, CheckLevel::Error);
    assert!(
        privileges
            .hint
            .contains("user_id is not readable by authenticated")
    );
    assert!(privileges.hint.contains("KZL02"));
}

/// A critical fact (an unreadable `id` or bucket column) still surfaces a
/// non-critical fact about another column in the same hint: an error-level
/// check does not hide the rest of what it found.
#[test]
fn a_critical_and_a_non_critical_fact_both_appear_when_id_is_unreadable() {
    let checks = run_pack_checks(&database(vec![(
        COLUMN_PRIVILEGES,
        column_privilege_rows(&[
            ("id", false, true),
            ("user_id", true, true),
            ("likes", false, true),
        ]),
    )]));
    let privileges = check_named(&checks, "column-privileges");

    assert_eq!(privileges.level, CheckLevel::Error);
    assert!(
        privileges
            .hint
            .contains("id is not readable by authenticated")
    );
    assert!(
        privileges
            .hint
            .contains("likes is not readable by authenticated")
    );
}

/// A `pull-only` table never pushes, so a column `authenticated` cannot
/// `UPDATE` is not a fact this check reports for it.
#[test]
fn a_pull_only_table_is_not_warned_for_a_column_it_cannot_write() {
    let checks = run_pack_checks(&database(vec![
        (
            CONFIG_ROWS,
            vec![text_row(&[
                ("table_name", "todos"),
                ("sync_mode", "pull-only"),
                ("bucket_column", "user_id"),
            ])],
        ),
        (
            COLUMN_PRIVILEGES,
            column_privilege_rows(&[
                ("id", true, false),
                ("user_id", true, false),
                ("title", true, false),
            ]),
        ),
    ]));

    assert!(check_named(&checks, "column-privileges").passed());
}

#[test]
fn a_ledger_row_whose_object_is_gone_fails_the_ledger_check() {
    let without_prune: Vec<Row> = function_rows()
        .into_iter()
        .filter(|row| {
            row.get("name") != Some(&serde_json::Value::String("prune_clients".to_owned()))
        })
        .collect();
    let checks = run_pack_checks(&database(vec![(FUNCTIONS, without_prune)]));
    let ledger = check_named(&checks, "ledger");

    assert_eq!(ledger.level, CheckLevel::Error);
    assert!(ledger.hint.contains("ledgered but absent"));
    assert!(ledger.hint.contains("[function] kizunasync.prune_clients"));
}

#[test]
fn an_object_the_ledger_does_not_record_fails_the_ledger_check() {
    let mut extra = function_rows();
    extra.push(text_row(&[("name", "_apply_ghost"), ("args", "p_a text")]));
    let checks = run_pack_checks(&database(vec![(FUNCTIONS, extra)]));
    let ledger = check_named(&checks, "ledger");

    assert_eq!(ledger.level, CheckLevel::Error);
    assert!(ledger.hint.contains("present but unledgered"));
    assert!(ledger.hint.contains("kizunasync._apply_ghost"));
}

/// The pack ledgers the cross-schema realtime policy only. The policies it
/// creates inside its own schema go with the schema under
/// `kizunasync deprovision --purge`, so they are not an unledgered object.
#[test]
fn the_in_schema_attachment_policies_are_not_reported_as_unledgered() {
    let checks = run_pack_checks(&database(Vec::new()));

    assert!(check_named(&checks, "ledger").passed());
}

/// Without pg_cron there is no `cron.job` to ask, so a cron ledger row is a
/// question this database cannot answer: reporting it as an absent object
/// would be a failure the operator cannot act on.
#[test]
fn a_cron_ledger_row_is_not_reported_absent_without_the_extension() {
    let checks = run_pack_checks(&database(vec![(
        PG_CRON,
        vec![text_row(&[("present", "f")])],
    )]));

    assert!(check_named(&checks, "ledger").passed());
}

/// A passing check still names the command that repairs it, and every repair
/// that runs the pack again is `kizunasync upgrade --reapply --yes`.
#[test]
fn a_passing_pack_check_names_the_re_apply_that_would_repair_it() {
    let checks = run_pack_checks(&database(Vec::new()));

    for (id, hint) in [
        (
            "realtime-policy",
            "re-apply the pack with `kizunasync upgrade --reapply --yes`: without this policy a client never receives the realtime wakeup and falls back to its own schedule",
        ),
        (
            "role-and-grants",
            "re-apply the pack with `kizunasync upgrade --reapply --yes` to restore the grants",
        ),
        (
            "ledger",
            "re-apply the pack with `kizunasync upgrade --reapply --yes` when the ledger and the database disagree",
        ),
    ] {
        let check = check_named(&checks, id);

        assert!(check.passed(), "{id}: {}", check.hint);
        assert_eq!(check.hint, hint, "{id}");
    }
}

/// Each failing check closes on the re-apply after its own fault lines; a
/// missing RPC also names `kizunasync init`, since an unprovisioned project fails
/// the same way.
#[test]
fn a_failing_pack_check_closes_on_the_re_apply() {
    let without_pull: Vec<Row> = function_rows()
        .into_iter()
        .filter(|row| row.get("name") != Some(&serde_json::Value::String("pull".to_owned())))
        .collect();
    let without_jobs_status: Vec<Row> = grant_rows()
        .into_iter()
        .filter(|row| row.get("name") != Some(&serde_json::Value::String("jobs_status".to_owned())))
        .collect();
    let checks = run_pack_checks(&database(vec![
        (FUNCTIONS, without_pull),
        (REALTIME_POLICY, vec![text_row(&[("present", "f")])]),
        (GRANTS, without_jobs_status),
    ]));

    for (id, closer) in [
        (
            "core-rpcs",
            "\n      run `kizunasync init` to provision this project, or re-apply the pack with `kizunasync upgrade --reapply --yes` if it is already provisioned",
        ),
        (
            "realtime-policy",
            "re-apply the pack with `kizunasync upgrade --reapply --yes`: without this policy a client never receives the realtime wakeup and falls back to its own schedule",
        ),
        (
            "role-and-grants",
            "\n      re-apply the pack with `kizunasync upgrade --reapply --yes`: the grants are what keep the client surface to the public RPCs",
        ),
        (
            "ledger",
            "\n      re-apply the pack with `kizunasync upgrade --reapply --yes`",
        ),
    ] {
        let check = check_named(&checks, id);

        assert_eq!(check.level, CheckLevel::Error, "{id}: {}", check.hint);
        assert!(check.hint.ends_with(closer), "{id}: {}", check.hint);
    }
}

#[test]
fn an_unreachable_database_fails_every_pack_check_with_the_transports_message() {
    let applier = FakeApplier::new().fail("", "connection refused");
    let checks = run_pack_checks(&applier);

    assert_eq!(checks.len(), 14);
    for check in &checks {
        assert_eq!(check.level, CheckLevel::Error, "{}", check.id);
        assert!(
            check.hint.contains("connection refused"),
            "{}: {}",
            check.id,
            check.hint
        );
        assert!(check.hint.contains("kizunasync init"), "{}", check.id);
    }
}

/// A `pack-file` row whose md5 is not this build's pack fails the ledger
/// check with both hashes and the re-apply, and every other check still
/// reports.
#[test]
fn a_ledger_that_records_another_pack_fails_the_ledger_check() {
    let files = shipped("select 1;\n");
    let checks = run_checks(&database(Vec::new()), Some(files.as_slice()));
    let ledger = check_named(&checks, "ledger");

    assert_eq!(ledger.level, CheckLevel::Error, "{}", ledger.hint);
    assert!(
        ledger
            .hint
            .contains("this build's pack differs from the one the ledger records"),
        "{}",
        ledger.hint
    );
    assert!(
        ledger.hint.contains(&format!(
            "0001_kizuna_init.sql: ledger md5 recorded, pack md5 {}",
            hash_pack_file("select 1;\n")
        )),
        "{}",
        ledger.hint
    );
    assert!(ledger.hint.contains(REAPPLY_HINT), "{}", ledger.hint);
    for check in checks.iter().filter(|check| check.id != "ledger") {
        assert!(check.passed(), "{}: {}", check.id, check.hint);
    }
}

/// A pack file the ledger has no row for differs from the ledger too.
#[test]
fn a_pack_file_the_ledger_does_not_record_fails_the_ledger_check() {
    let mut files = shipped("select 1;\n");
    files.push(PackFile {
        name: "0002_later.sql".to_owned(),
        sql: "select 2;\n".to_owned(),
    });
    let checks = run_checks(
        &database(vec![(PACK_FILE_ROWS, vec![recording("select 1;\n")])]),
        Some(files.as_slice()),
    );
    let ledger = check_named(&checks, "ledger");

    assert_eq!(ledger.level, CheckLevel::Error, "{}", ledger.hint);
    assert!(
        ledger
            .hint
            .contains("0002_later.sql: not recorded in the ledger"),
        "{}",
        ledger.hint
    );
    assert!(
        !ledger.hint.contains("0001_kizuna_init.sql:"),
        "{}",
        ledger.hint
    );
}

#[test]
fn a_ledger_that_records_this_pack_passes_the_ledger_check() {
    let files = shipped("select 1;\n");
    let checks = run_checks(
        &database(vec![(PACK_FILE_ROWS, vec![recording("select 1;\n")])]),
        Some(files.as_slice()),
    );
    let ledger = check_named(&checks, "ledger");

    assert!(ledger.passed(), "{}", ledger.hint);
}

/// The pack a newer build recorded is reported once, as newer: this build
/// cannot re-apply over it, so it is not also offered as a differing pack.
#[test]
fn a_ledger_a_newer_build_wrote_is_not_also_reported_as_a_differing_pack() {
    let files = shipped("select 1;\n");
    let checks = run_checks(
        &database(vec![(PACK_FILE_ROWS, vec![pack_file_row("99.0.0")])]),
        Some(files.as_slice()),
    );
    let ledger = check_named(&checks, "ledger");

    assert!(
        ledger.hint.contains("newer than this build"),
        "{}",
        ledger.hint
    );
    assert!(!ledger.hint.contains("differs"), "{}", ledger.hint);
    assert!(!ledger.hint.contains("--reapply"), "{}", ledger.hint);
}

/// A ledger a newer build wrote fails the ledger check with the update it
/// needs instead of the re-apply this build would refuse, and every other
/// check still reports.
#[test]
fn a_ledger_a_newer_build_wrote_fails_the_ledger_check_and_names_the_update() {
    let checks = run_pack_checks(&database(vec![(
        PACK_FILE_ROWS,
        vec![pack_file_row("99.0.0")],
    )]));
    let ledger = check_named(&checks, "ledger");

    assert_eq!(ledger.level, CheckLevel::Error, "{}", ledger.hint);
    assert!(
        ledger
            .hint
            .contains("0001_kizuna_init.sql: recorded by kizunasync 99.0.0, newer than this build"),
        "{}",
        ledger.hint
    );
    assert!(ledger.hint.contains("update kizunasync"), "{}", ledger.hint);
    assert!(!ledger.hint.contains("--reapply"), "{}", ledger.hint);
    for check in checks.iter().filter(|check| check.id != "ledger") {
        assert!(check.passed(), "{}: {}", check.id, check.hint);
    }
}
