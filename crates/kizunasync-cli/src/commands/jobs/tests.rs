use serde_json::Value;

use super::read::parse_schedule_outcome;
use super::*;
use crate::applier::fake::{FakeApplier, row, text_row};
use crate::ui::Capture;

const PG_CRON_PROBE: &str = "extname = 'pg_cron'";
const SETTINGS: &str = "select * from kizunasync._settings;";
const CRON_JOBS: &str = "from cron.job j";
const SCHEDULE_CALL: &str = "_schedule_jobs()::text";

fn settings_row() -> Vec<crate::row::Row> {
    vec![text_row(&[
        ("reap_schedule", "16 3 * * *"),
        ("compact_schedule", "47 3 * * *"),
        ("client_prune_schedule", "31 3 * * *"),
    ])]
}

/// A database with pg_cron, the three jobs, and one run of each.
fn scheduled() -> FakeApplier {
    FakeApplier::new()
        .answer(PG_CRON_PROBE, vec![text_row(&[("present", "t")])])
        .answer(SETTINGS, settings_row())
        .answer(
            CRON_JOBS,
            vec![
                text_row(&[
                    ("jobname", "kizunasync-compact-changelog"),
                    ("schedule", "47 3 * * *"),
                    ("active", "t"),
                    ("last_start", "2026-09-11 03:47:00.101+00"),
                    ("last_status", "succeeded"),
                    ("last_message", ""),
                ]),
                text_row(&[
                    ("jobname", "kizunasync-prune-clients"),
                    ("schedule", "31 3 * * *"),
                    ("active", "t"),
                ]),
                text_row(&[
                    ("jobname", "kizunasync-reap-tombstones"),
                    ("schedule", "16 3 * * *"),
                    ("active", "t"),
                    ("last_start", "2026-09-11 03:16:00.007+00"),
                    ("last_status", "succeeded"),
                    ("last_message", ""),
                ]),
            ],
        )
}

/// The same database without the extension.
fn no_pg_cron() -> FakeApplier {
    FakeApplier::new()
        .answer(PG_CRON_PROBE, vec![text_row(&[("present", "f")])])
        .answer(SETTINGS, settings_row())
}

fn drive(action: JobsAction, applier: &FakeApplier, json: bool) -> (i32, Capture) {
    let (mut ui, capture) = Ui::capture();
    let code = run(action, &JobsFlags { json }, applier, &mut ui);

    (code, capture)
}

#[test]
fn the_three_jobs_are_reported_in_a_fixed_order_with_their_settings_schedule() {
    let report = read_jobs(&scheduled()).unwrap();

    assert!(report.pg_cron);
    assert_eq!(
        report
            .jobs
            .iter()
            .map(|job| job.name.as_str())
            .collect::<Vec<_>>(),
        [
            "kizunasync-reap-tombstones",
            "kizunasync-compact-changelog",
            "kizunasync-prune-clients"
        ]
    );
    assert_eq!(report.jobs[0].schedule.as_deref(), Some("16 3 * * *"));
    assert_eq!(
        report.jobs[0].settings_schedule.as_deref(),
        Some("16 3 * * *")
    );
    assert!(report.jobs.iter().all(|job| !job.drift));
}

#[test]
fn a_schedule_the_settings_row_does_not_declare_is_drift() {
    let applier = FakeApplier::new()
        .answer(PG_CRON_PROBE, vec![text_row(&[("present", "t")])])
        .answer(SETTINGS, settings_row())
        .answer(
            CRON_JOBS,
            vec![text_row(&[
                ("jobname", "kizunasync-reap-tombstones"),
                ("schedule", "0 4 * * *"),
                ("active", "t"),
            ])],
        );
    let report = read_jobs(&applier).unwrap();

    assert!(report.jobs[0].drift);
    assert_eq!(report.jobs[0].schedule.as_deref(), Some("0 4 * * *"));
    assert_eq!(
        report.jobs[0].settings_schedule.as_deref(),
        Some("16 3 * * *")
    );
    // A job pg_cron does not hold at all is not drift: there is no live
    // schedule to disagree with the declared one.
    assert!(!report.jobs[1].drift);
    assert_eq!(report.jobs[1].schedule, None);
}

/// The schedules come from the whole settings row, so a column an older pack
/// lacks reads as absent rather than failing the report.
#[test]
fn the_settings_schedules_are_read_from_the_whole_row() {
    let applier = scheduled();
    read_jobs(&applier).unwrap();

    assert!(
        applier
            .executed
            .borrow()
            .contains(&"select * from kizunasync._settings;".to_owned()),
        "{:?}",
        applier.executed.borrow()
    );
}

#[test]
fn a_job_that_never_ran_carries_no_run_columns() {
    let report = read_jobs(&scheduled()).unwrap();
    let prune = &report.jobs[2];

    assert_eq!(prune.last_start, None);
    assert_eq!(prune.last_status, None);
    assert_eq!(prune.last_run_succeeded(), None);
}

#[test]
fn without_the_extension_nothing_is_scheduled_and_the_settings_still_report() {
    let report = read_jobs(&no_pg_cron()).unwrap();

    assert!(!report.pg_cron);
    assert!(report.jobs.iter().all(|job| job.schedule.is_none()));
    assert_eq!(
        report.jobs[1].settings_schedule.as_deref(),
        Some("47 3 * * *")
    );
}

#[test]
fn the_cron_schema_is_never_queried_without_the_extension() {
    let applier = no_pg_cron();
    read_jobs(&applier).unwrap();

    assert!(
        !applier
            .executed
            .borrow()
            .iter()
            .any(|sql| sql.contains("from cron.job")),
        "a missing relation is not the same news as an unscheduled job"
    );
}

#[test]
fn list_exits_two_without_the_extension_and_says_what_still_works() {
    let (code, capture) = drive(JobsAction::List, &no_pg_cron(), false);

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("pg_cron is not installed"));
    assert!(capture.stderr().contains("kizunasync jobs run all"));
    assert_eq!(capture.stdout(), "");
}

#[test]
fn list_json_without_the_extension_says_what_still_works_on_stderr() {
    let (code, capture) = drive(JobsAction::List, &no_pg_cron(), true);
    let payload: Value = serde_json::from_str(capture.stdout().trim()).unwrap();

    assert_eq!(code, UNUSABLE);
    assert_eq!(payload["pgCron"], false);
    assert!(capture.stderr().contains("pg_cron is not installed"));
    assert!(capture.stderr().contains("kizunasync jobs run all"));
}

#[test]
fn list_json_with_the_extension_keeps_the_hint_off_stderr() {
    let (code, capture) = drive(JobsAction::List, &scheduled(), true);
    let payload: Value = serde_json::from_str(capture.stdout().trim()).unwrap();

    assert_eq!(code, OK);
    assert_eq!(payload["pgCron"], true);
    assert!(!capture.stderr().contains("pg_cron is not installed"));
}

#[test]
fn list_json_is_one_object_on_stdout_and_keeps_the_exit_code() {
    let (code, capture) = drive(JobsAction::List, &no_pg_cron(), true);
    let payload: Value = serde_json::from_str(capture.stdout().trim()).unwrap();

    assert_eq!(code, UNUSABLE);
    assert_eq!(payload["pgCron"], false);
    assert_eq!(payload["jobs"][0]["name"], "kizunasync-reap-tombstones");
    assert_eq!(payload["jobs"][0]["settingsSchedule"], "16 3 * * *");
    assert_eq!(payload["jobs"][0]["drift"], false);
    assert!(payload["jobs"][0].get("schedule").is_none());
}

#[test]
fn the_list_table_carries_every_column_the_report_holds() {
    let (code, capture) = drive(JobsAction::List, &scheduled(), false);
    let text = capture.stderr();

    assert_eq!(code, OK);
    assert!(text.contains("job                           schedule      active  settings      drift  last run                       status"));
    assert!(text.contains(
        "kizunasync-reap-tombstones    16 3 * * *    yes     16 3 * * *           2026-09-11 03:16:00.007+00     succeeded"
    ));
    assert!(text.contains(
        "kizunasync-prune-clients      31 3 * * *    yes     31 3 * * *           never"
    ));
}

#[test]
fn a_drifted_schedule_is_called_out_under_the_table() {
    let applier = FakeApplier::new()
        .answer(PG_CRON_PROBE, vec![text_row(&[("present", "t")])])
        .answer(SETTINGS, settings_row())
        .answer(
            CRON_JOBS,
            vec![text_row(&[
                ("jobname", "kizunasync-reap-tombstones"),
                ("schedule", "0 4 * * *"),
                ("active", "t"),
            ])],
        );
    let (code, capture) = drive(JobsAction::List, &applier, false);

    assert_eq!(code, OK);
    assert!(capture.stderr().contains("1 job(s) run on a schedule"));
    assert!(capture.stderr().contains("kizunasync jobs schedule"));
}

#[test]
fn a_failed_run_prints_its_message_and_a_successful_one_does_not() {
    let applier = FakeApplier::new()
        .answer(PG_CRON_PROBE, vec![text_row(&[("present", "t")])])
        .answer(SETTINGS, settings_row())
        .answer(
            CRON_JOBS,
            vec![
                text_row(&[
                    ("jobname", "kizunasync-reap-tombstones"),
                    ("schedule", "16 3 * * *"),
                    ("active", "t"),
                    ("last_status", "failed"),
                    ("last_message", "permission denied for table _tombstones"),
                ]),
                text_row(&[
                    ("jobname", "kizunasync-compact-changelog"),
                    ("schedule", "47 3 * * *"),
                    ("active", "t"),
                    ("last_status", "succeeded"),
                    ("last_message", "1 row"),
                ]),
            ],
        );
    let (_, capture) = drive(JobsAction::List, &applier, false);

    assert!(
        capture
            .stderr()
            .contains("    → permission denied for table _tombstones")
    );
    assert!(!capture.stderr().contains("1 row"));
}

#[test]
fn run_all_calls_the_three_functions_in_order_and_prints_their_counts() {
    let applier = FakeApplier::new()
        .answer("reap_tombstones()", vec![text_row(&[("count", "7")])])
        .answer("compact_changelog()", vec![text_row(&[("count", "12")])])
        .answer("prune_clients()", vec![row(&[("count", Value::from(0))])]);
    let (code, capture) = drive(JobsAction::RunAll, &applier, false);

    assert_eq!(code, OK);
    assert_eq!(
        applier.executed.borrow().clone(),
        [
            "select kizunasync.reap_tombstones() as count;",
            "select kizunasync.compact_changelog() as count;",
            "select kizunasync.prune_clients() as count;"
        ]
    );
    let text = capture.stderr();
    assert!(text.contains("kizunasync.reap_tombstones()                 7  tombstone(s) reaped"));
    assert!(
        text.contains("kizunasync.compact_changelog()              12  changelog row(s) compacted")
    );
    assert!(text.contains("kizunasync.prune_clients()                   0  client(s) pruned"));
}

#[test]
fn run_one_calls_only_that_function() {
    let applier = FakeApplier::new().answer("prune_clients()", vec![text_row(&[("count", "3")])]);
    let (code, capture) = drive(JobsAction::Run(Job::Prune), &applier, true);
    let payload: Value = serde_json::from_str(capture.stdout().trim()).unwrap();

    assert_eq!(code, OK);
    assert_eq!(applier.executed.borrow().len(), 1);
    assert_eq!(payload["ran"][0]["job"], "prune");
    assert_eq!(payload["ran"][0]["function"], "kizunasync.prune_clients");
    assert_eq!(payload["ran"][0]["count"], 3);
}

#[test]
fn a_run_that_raises_is_exit_one_and_names_the_function() {
    let applier = FakeApplier::new().fail("reap_tombstones()", "permission denied");
    let (code, capture) = drive(JobsAction::RunAll, &applier, false);

    assert_eq!(code, FAILURE);
    assert!(
        capture
            .stderr()
            .contains("kizunasync.reap_tombstones() failed: permission denied")
    );
    // The batch stops at the first raise: the next function would raise the
    // same way on the same connection.
    assert_eq!(applier.executed.borrow().len(), 1);
}

#[test]
fn a_schedule_run_prints_the_applied_settings_and_every_job_schedule() {
    let applier = FakeApplier::new().answer(
        SCHEDULE_CALL,
        vec![text_row(&[(
            "schedules",
            r#"{"jobs": {"kizunasync-compact-changelog": "47 3 * * *", "kizunasync-prune-clients": "31 3 * * *", "kizunasync-reap-tombstones": "16 3 * * *"}, "pg_cron": true}"#,
        )])],
    );
    let (code, capture) = drive(JobsAction::Schedule, &applier, false);

    assert_eq!(code, OK);
    assert!(
        capture
            .stderr()
            .contains("applied kizunasync._settings to pg_cron")
    );
    assert!(
        capture
            .stderr()
            .contains("kizunasync-reap-tombstones    16 3 * * *")
    );
}

#[test]
fn schedule_without_the_extension_is_exit_two_and_still_reports_the_settings() {
    let applier = FakeApplier::new().answer(
        SCHEDULE_CALL,
        vec![text_row(&[(
            "schedules",
            r#"{"jobs": {"kizunasync-reap-tombstones": "16 3 * * *"}, "pg_cron": false}"#,
        )])],
    );
    let (code, capture) = drive(JobsAction::Schedule, &applier, false);

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("kizunasync._settings declares"));
    assert!(capture.stderr().contains("pg_cron is not installed"));
}

#[test]
fn schedule_json_without_the_extension_says_so_on_stderr() {
    let applier = FakeApplier::new().answer(
        SCHEDULE_CALL,
        vec![text_row(&[(
            "schedules",
            r#"{"jobs": {"kizunasync-reap-tombstones": "16 3 * * *"}, "pg_cron": false}"#,
        )])],
    );
    let (code, capture) = drive(JobsAction::Schedule, &applier, true);
    let payload: Value = serde_json::from_str(capture.stdout().trim()).unwrap();

    assert_eq!(code, UNUSABLE);
    assert_eq!(payload["pgCron"], false);
    assert_eq!(payload["jobs"]["kizunasync-reap-tombstones"], "16 3 * * *");
    assert!(capture.stderr().contains("pg_cron is not installed"));
    assert!(capture.stderr().contains("kizunasync jobs run all"));
}

#[test]
fn a_schedule_answer_that_is_not_the_documented_object_is_refused() {
    assert!(parse_schedule_outcome("{\"jobs\": {}}").is_err());
    assert!(parse_schedule_outcome("[]").is_err());
    assert!(parse_schedule_outcome("{\"jobs\": {\"a\": 1}, \"pg_cron\": true}").is_err());
    assert!(
        parse_schedule_outcome("{\"jobs\": {}, \"pg_cron\": true}")
            .unwrap()
            .pg_cron
    );
}

#[test]
fn an_unreadable_settings_row_is_exit_two_not_a_silent_empty_table() {
    let applier = FakeApplier::new()
        .answer(PG_CRON_PROBE, vec![text_row(&[("present", "t")])])
        .fail(SETTINGS, "relation \"kizunasync._settings\" does not exist");
    let (code, capture) = drive(JobsAction::List, &applier, false);

    assert_eq!(code, UNUSABLE);
    assert!(capture.stderr().contains("does not exist"));
}

#[test]
fn every_line_of_a_human_run_stays_off_stdout() {
    let applier = FakeApplier::new().answer("reap_tombstones()", vec![text_row(&[("count", "0")])]);
    let (_, capture) = drive(JobsAction::Run(Job::Reap), &applier, false);

    assert_eq!(capture.stdout(), "");
}
