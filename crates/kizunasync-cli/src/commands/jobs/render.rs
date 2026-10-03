use serde::Serialize;

use crate::commands::{OK, UNUSABLE};
use crate::ui::Ui;

use super::{Job, JobRun, JobStatus, JobsReport, ScheduleOutcome, pg_cron_exit};

/// Column widths of the `jobs list` table. The job names are the pack's own and
/// the schedules are five crontab fields, so both are bounded.
const NAME_WIDTH: usize = 30;
const SCHEDULE_WIDTH: usize = 14;
const ACTIVE_WIDTH: usize = 8;
const DRIFT_WIDTH: usize = 7;
const START_WIDTH: usize = 31;
/// Where a hand-run's count sits, so the three lines align under each other.
const FUNCTION_WIDTH: usize = 38;

/// What the schedule cell says for a job pg_cron does not hold.
const NOT_SCHEDULED: &str = "not scheduled";
/// What the last-run cell says for a job that has never run.
const NEVER: &str = "never";

/// The line that explains an empty `cron.job`: the extension carries the
/// scheduler, and without it the three functions are still callable by hand.
const NO_PG_CRON: &str = "  pg_cron is not installed, so this database schedules nothing. `kizunasync jobs run all` runs the three functions by hand, and `kizunasync doctor` reports the extension.";

/// Render the list and produce the exit code.
pub fn report_list(ui: &mut Ui, report: &JobsReport, json: bool) -> i32 {
    if json {
        let code = write_json(ui, report);
        if code != OK {
            return code;
        }

        return pg_cron_exit_with_hint(ui, report.pg_cron);
    }
    ui.log("kizunasync jobs: the pack's background jobs\n");
    ui.log(&header_row());
    for job in &report.jobs {
        ui.log(&job_row(job));
        if let Some(message) = failed_message(job) {
            ui.log(&format!("    → {message}"));
        }
    }
    ui.log("");
    if !report.pg_cron {
        ui.log(NO_PG_CRON);

        return UNUSABLE;
    }

    let drifted = report.jobs.iter().filter(|job| job.drift).count();
    if drifted > 0 {
        ui.warn(&format!(
            "{drifted} job(s) run on a schedule kizunasync._settings does not declare: `kizunasync jobs schedule` applies the settings."
        ));
    }

    OK
}

/// Render one hand-run batch. Every run listed answered: a raise never reaches
/// here.
pub fn report_run(ui: &mut Ui, runs: &[JobRun], json: bool) -> i32 {
    if json {
        return write_json(ui, &serde_json::json!({ "ran": runs }));
    }
    ui.log(&format!(
        "kizunasync jobs run: {} job(s) on this database\n",
        runs.len()
    ));
    for run in runs {
        ui.success(&format!(
            "{:<FUNCTION_WIDTH$}{:>8}  {}",
            format!("{}()", run.function),
            run.count,
            counts_of(&run.job)
        ));
    }

    OK
}

/// Render what `kizunasync._schedule_jobs()` applied.
pub fn report_schedule(ui: &mut Ui, outcome: &ScheduleOutcome, json: bool) -> i32 {
    if json {
        let code = write_json(ui, outcome);
        if code != OK {
            return code;
        }

        return pg_cron_exit_with_hint(ui, outcome.pg_cron);
    }
    if outcome.pg_cron {
        ui.log("kizunasync jobs schedule: applied kizunasync._settings to pg_cron\n");
    } else {
        ui.log("kizunasync jobs schedule: kizunasync._settings declares\n");
    }
    for (name, schedule) in &outcome.jobs {
        ui.log(&format!("  {name:<NAME_WIDTH$}{schedule}"));
    }
    ui.log("");

    pg_cron_exit_with_hint(ui, outcome.pg_cron)
}

/// The exit code for a report read with or without pg_cron. Without it, stderr
/// says why nothing is scheduled in every output mode: `--json` keeps stdout to
/// the one object and still owes a person reading stderr the reason.
fn pg_cron_exit_with_hint(ui: &mut Ui, pg_cron: bool) -> i32 {
    if !pg_cron {
        ui.log(NO_PG_CRON);
    }

    pg_cron_exit(pg_cron)
}

/// One JSON object on stdout. A payload that will not serialize is the same
/// usage error `status --json` reports.
fn write_json<T: Serialize>(ui: &mut Ui, payload: &T) -> i32 {
    match serde_json::to_string(payload) {
        Ok(body) => {
            ui.write_stdout(&format!("{body}\n"));

            OK
        }
        Err(cause) => {
            ui.error(&format!("  could not render the report as JSON: {cause}"));

            UNUSABLE
        }
    }
}

fn header_row() -> String {
    format!(
        "  {:<NAME_WIDTH$}{:<SCHEDULE_WIDTH$}{:<ACTIVE_WIDTH$}{:<SCHEDULE_WIDTH$}{:<DRIFT_WIDTH$}{:<START_WIDTH$}{}",
        "job", "schedule", "active", "settings", "drift", "last run", "status"
    )
}

fn job_row(job: &JobStatus) -> String {
    format!(
        "  {:<NAME_WIDTH$}{:<SCHEDULE_WIDTH$}{:<ACTIVE_WIDTH$}{:<SCHEDULE_WIDTH$}{:<DRIFT_WIDTH$}{:<START_WIDTH$}{}",
        job.name,
        job.schedule.as_deref().unwrap_or(NOT_SCHEDULED),
        active_cell(job.active),
        job.settings_schedule.as_deref().unwrap_or_default(),
        if job.drift { "yes" } else { "" },
        job.last_start.as_deref().unwrap_or(NEVER),
        job.last_status.as_deref().unwrap_or_default()
    )
}

const fn active_cell(active: Option<bool>) -> &'static str {
    match active {
        Some(true) => "yes",
        Some(false) => "no",
        None => "",
    }
}

/// The run message, printed only for a run that did not succeed: pg_cron stores
/// the function's own output there, which is noise for a healthy job.
fn failed_message(job: &JobStatus) -> Option<&str> {
    if job.last_run_succeeded() != Some(false) {
        return None;
    }

    job.last_message
        .as_deref()
        .filter(|message| !message.is_empty())
}

/// What a hand-run count counts, resolved from the label the run carries.
fn counts_of(label: &str) -> &'static str {
    Job::ALL
        .iter()
        .find(|job| job.label() == label)
        .map_or("row(s)", |job| job.counts())
}
