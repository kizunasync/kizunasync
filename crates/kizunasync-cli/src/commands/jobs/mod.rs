//! `jobs`: the three background jobs the pack schedules.
//!
//! `list` reports what `cron.job` holds beside what `kizunasync._settings`
//! declares, and names the difference as drift. `run` calls a retention
//! function by hand over the connection it was given, which is what makes the
//! pack's "callable by kizunasync" true on a database whose cron never fires.
//! `schedule` calls `kizunasync._schedule_jobs()`, the single writer of all
//! three jobs, so every schedule in the database comes from the settings row.
//!
//! Exit codes: `0`; `1` when a hand-run job raised; `2` when the command could
//! not run, which includes `list` and `schedule` on a database without pg_cron,
//! where there is no `cron.job` to read or to write.
//!
//! Output split, as everywhere else in this binary: `--json` is one object on
//! stdout with stable keys, and the human table is status on stderr.

use serde::Serialize;

use crate::applier::Applier;
use crate::commands::{FAILURE, OK, UNUSABLE};
use crate::ui::Ui;

mod read;
mod render;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

pub use read::{apply_schedules, has_pg_cron, read_jobs, run_jobs};
pub use render::{report_list, report_run, report_schedule};

/// One of the three jobs `kizunasync._schedule_jobs()` writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Job {
    /// `kizunasync.reap_tombstones()`.
    Reap,
    /// `kizunasync.compact_changelog()`.
    Compact,
    /// `kizunasync.prune_clients()`.
    Prune,
}

impl Job {
    /// The three, in the order every report prints them.
    pub const ALL: [Self; 3] = [Self::Reap, Self::Compact, Self::Prune];

    /// The `cron.job` name the pack schedules it under.
    #[must_use]
    pub const fn job_name(self) -> &'static str {
        match self {
            Self::Reap => "kizunasync-reap-tombstones",
            Self::Compact => "kizunasync-compact-changelog",
            Self::Prune => "kizunasync-prune-clients",
        }
    }

    /// The schema-qualified function the job calls.
    #[must_use]
    pub const fn function(self) -> &'static str {
        match self {
            Self::Reap => "kizunasync.reap_tombstones",
            Self::Compact => "kizunasync.compact_changelog",
            Self::Prune => "kizunasync.prune_clients",
        }
    }

    /// The word a user types for it, and the key `--json` carries.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Reap => "reap",
            Self::Compact => "compact",
            Self::Prune => "prune",
        }
    }

    /// What the returned count counts.
    #[must_use]
    pub const fn counts(self) -> &'static str {
        match self {
            Self::Reap => "tombstone(s) reaped",
            Self::Compact => "changelog row(s) compacted",
            Self::Prune => "client(s) pruned",
        }
    }

    /// The `kizunasync._settings` column that carries its schedule.
    #[must_use]
    pub const fn schedule_column(self) -> &'static str {
        match self {
            Self::Reap => "reap_schedule",
            Self::Compact => "compact_schedule",
            Self::Prune => "client_prune_schedule",
        }
    }
}

/// One job as `cron.job`, its latest `cron.job_run_details` row, and
/// `kizunasync._settings` together describe it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobStatus {
    /// The `cron.job` name.
    pub name: String,
    /// The schedule pg_cron holds, absent when the job is not scheduled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    /// `cron.job.active`, absent when the job is not scheduled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    /// The schedule `kizunasync._settings` declares for it.
    #[serde(rename = "settingsSchedule", skip_serializing_if = "Option::is_none")]
    pub settings_schedule: Option<String>,
    /// True when both schedules are known and differ: pg_cron is running this
    /// job on a timing the settings row does not declare.
    pub drift: bool,
    /// `start_time` of the latest run, absent when it never ran.
    #[serde(rename = "lastStart", skip_serializing_if = "Option::is_none")]
    pub last_start: Option<String>,
    /// `status` of the latest run (`succeeded`, `failed`, `running`, ...).
    #[serde(rename = "lastStatus", skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    /// `return_message` of the latest run.
    #[serde(rename = "lastMessage", skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
}

/// The `cron.job_run_details.status` a finished, successful run carries.
pub const RUN_SUCCEEDED: &str = "succeeded";

impl JobStatus {
    /// Whether the latest run finished successfully. `None` means it never ran,
    /// which is not a failure: a freshly installed pack has no run yet.
    #[must_use]
    pub fn last_run_succeeded(&self) -> Option<bool> {
        self.last_status
            .as_ref()
            .map(|status| status == RUN_SUCCEEDED)
    }
}

/// The whole `jobs list` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobsReport {
    /// Whether pg_cron is installed at all.
    #[serde(rename = "pgCron")]
    pub pg_cron: bool,
    /// The three jobs, in [`Job::ALL`] order.
    pub jobs: Vec<JobStatus>,
}

/// One hand-run job and what it returned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobRun {
    /// [`Job::label`].
    pub job: String,
    /// [`Job::function`].
    pub function: String,
    /// The count the function returned.
    pub count: i64,
}

/// What `kizunasync._schedule_jobs()` reported it applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScheduleOutcome {
    /// Whether pg_cron was there to write to.
    #[serde(rename = "pgCron")]
    pub pg_cron: bool,
    /// Job name to schedule, as the function returned them.
    pub jobs: std::collections::BTreeMap<String, String>,
}

/// What a `jobs` invocation asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobsAction {
    /// The three jobs, their schedules, and their latest run.
    List,
    /// Call one retention function by hand.
    Run(Job),
    /// Call all three, in [`Job::ALL`] order.
    RunAll,
    /// Reschedule from `kizunasync._settings`.
    Schedule,
}

/// Flags `jobs` accepts.
#[derive(Debug, Clone, Copy, Default)]
pub struct JobsFlags {
    /// Print one JSON object on stdout instead of the human table.
    pub json: bool,
}

/// Run the action against an already-resolved connection.
pub fn run(action: JobsAction, flags: &JobsFlags, applier: &dyn Applier, ui: &mut Ui) -> i32 {
    match action {
        JobsAction::List => match read_jobs(applier) {
            Ok(report) => report_list(ui, &report, flags.json),
            Err(cause) => unusable(ui, &cause.to_string()),
        },
        JobsAction::Run(job) => run_and_report(&[job], *flags, applier, ui),
        JobsAction::RunAll => run_and_report(&Job::ALL, *flags, applier, ui),
        JobsAction::Schedule => match apply_schedules(applier) {
            Ok(outcome) => report_schedule(ui, &outcome, flags.json),
            Err(cause) => unusable(ui, &cause.to_string()),
        },
    }
}

/// A hand-run that raised is a failure the command reports (exit 1), not a
/// command that could not run: the connection answered, the function did not.
fn run_and_report(jobs: &[Job], flags: JobsFlags, applier: &dyn Applier, ui: &mut Ui) -> i32 {
    match run_jobs(applier, jobs) {
        Ok(runs) => report_run(ui, &runs, flags.json),
        Err(cause) => {
            ui.error(&format!("  {cause}"));

            FAILURE
        }
    }
}

fn unusable(ui: &mut Ui, cause: &str) -> i32 {
    ui.error(&format!("  {cause}"));

    UNUSABLE
}

/// The exit code a report carries: `2` when pg_cron is absent, `0` otherwise.
/// `list` and `schedule` share it because both are about the jobs pg_cron holds.
const fn pg_cron_exit(pg_cron: bool) -> i32 {
    if pg_cron { OK } else { UNUSABLE }
}
