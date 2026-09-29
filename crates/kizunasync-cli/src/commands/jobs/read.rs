use std::collections::BTreeMap;

use crate::applier::Applier;
use crate::config::settings_query;
use crate::constants::SCHEMA;
use crate::error::{Error, Result};
use crate::row::{optional_bool, optional_string, require_bool, require_number, require_string};

use super::{Job, JobRun, JobStatus, JobsReport, ScheduleOutcome};

/// pg_cron is optional at install time, so every read that touches the `cron`
/// schema asks this first: selecting from `cron.job` where the extension is
/// absent is a missing-relation error, which is not the same news as "no job is
/// scheduled".
fn pg_cron_query() -> String {
    "select exists (select 1 from pg_extension where extname = 'pg_cron') as present;".to_owned()
}

/// The three jobs with the latest run of each. `left join lateral` keeps a job
/// that has never run in the result with null run columns, which is a state the
/// report distinguishes from a failed run.
fn cron_jobs_query() -> String {
    let names = Job::ALL
        .iter()
        .map(|job| format!("'{}'", job.job_name()))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "select\n  j.jobname,\n  j.schedule,\n  j.active,\n  d.start_time::text as last_start,\n  d.status as last_status,\n  d.return_message as last_message\nfrom cron.job j\nleft join lateral (\n  select r.start_time, r.status, r.return_message\n  from cron.job_run_details r\n  where r.jobid = j.jobid\n  order by r.start_time desc nulls last\n  limit 1\n) d on true\nwhere j.jobname in ({names})\norder by j.jobname;"
    )
}

/// Whether pg_cron is installed on this database.
///
/// # Errors
/// Returns the transport's own failure, or [`Error::Boundary`] when the probe
/// answers a shape it was not asked for.
pub fn has_pg_cron(applier: &dyn Applier) -> Result<bool> {
    let rows = applier.run_query(&pg_cron_query())?;
    let Some(row) = rows.first() else {
        return Err(Error::Boundary(
            "the pg_cron probe returned no row, expected exactly 1".to_owned(),
        ));
    };

    require_bool(row, "present")
}

/// One job's settings schedule and its `cron.job` row, merged.
struct CronRow {
    schedule: Option<String>,
    active: Option<bool>,
    last_start: Option<String>,
    last_status: Option<String>,
    last_message: Option<String>,
}

/// The three jobs as `cron.job`, `cron.job_run_details` and
/// `kizunasync._settings` together describe them.
///
/// # Errors
/// Returns the transport's own failure, or [`Error::Boundary`] when a row is
/// missing a column this reader asked for.
pub fn read_jobs(applier: &dyn Applier) -> Result<JobsReport> {
    let pg_cron = has_pg_cron(applier)?;
    let declared = read_settings_schedules(applier)?;
    let scheduled = if pg_cron {
        read_cron_rows(applier)?
    } else {
        BTreeMap::new()
    };
    let mut jobs = Vec::with_capacity(Job::ALL.len());
    for job in Job::ALL {
        let settings_schedule = declared.get(job.job_name()).cloned();
        let found = scheduled.get(job.job_name());
        let schedule = found.and_then(|row| row.schedule.clone());
        let drift = match (schedule.as_ref(), settings_schedule.as_ref()) {
            (Some(live), Some(declared)) => live != declared,
            _ => false,
        };
        jobs.push(JobStatus {
            name: job.job_name().to_owned(),
            schedule,
            active: found.and_then(|row| row.active),
            settings_schedule,
            drift,
            last_start: found.and_then(|row| row.last_start.clone()),
            last_status: found.and_then(|row| row.last_status.clone()),
            last_message: found.and_then(|row| row.last_message.clone()),
        });
    }

    Ok(JobsReport { pg_cron, jobs })
}

/// The schedules the settings row declares, keyed by job name. An unprovisioned
/// project has no settings row at all, which reads as "nothing declared" rather
/// than as a failure: the pack section of `status` is what reports that.
fn read_settings_schedules(applier: &dyn Applier) -> Result<BTreeMap<String, String>> {
    let rows = applier.run_query(&settings_query())?;
    let Some(row) = rows.first() else {
        return Ok(BTreeMap::new());
    };

    let mut declared = BTreeMap::new();
    for job in Job::ALL {
        if let Some(schedule) = optional_string(row, job.schedule_column())? {
            declared.insert(job.job_name().to_owned(), schedule);
        }
    }

    Ok(declared)
}

fn read_cron_rows(applier: &dyn Applier) -> Result<BTreeMap<String, CronRow>> {
    let rows = applier.run_query(&cron_jobs_query())?;
    let mut scheduled = BTreeMap::new();
    for row in &rows {
        scheduled.insert(
            require_string(row, "jobname")?,
            CronRow {
                schedule: optional_string(row, "schedule")?,
                active: optional_bool(row, "active")?,
                last_start: optional_string(row, "last_start")?,
                last_status: optional_string(row, "last_status")?,
                last_message: optional_string(row, "last_message")?,
            },
        );
    }

    Ok(scheduled)
}

/// Call each job's function in the order given and collect what it returned.
/// The first failure stops the batch: a raise means the connection cannot run
/// that job, and the ones after it would raise the same way.
///
/// # Errors
/// Returns the transport's own failure, naming the function that raised.
pub fn run_jobs(applier: &dyn Applier, jobs: &[Job]) -> Result<Vec<JobRun>> {
    let mut runs = Vec::with_capacity(jobs.len());
    for job in jobs {
        let rows = applier
            .run_query(&format!("select {}() as count;", job.function()))
            .map_err(|cause| Error::Db(format!("{}() failed: {cause}", job.function())))?;
        let Some(row) = rows.first() else {
            return Err(Error::Boundary(format!(
                "{}() returned no row, expected exactly 1",
                job.function()
            )));
        };

        runs.push(JobRun {
            job: job.label().to_owned(),
            function: job.function().to_owned(),
            count: require_number(row, "count")?,
        });
    }

    Ok(runs)
}

fn schedule_jobs_query() -> String {
    format!("select {SCHEMA}._schedule_jobs()::text as schedules;")
}

/// Hand the settings row to `kizunasync._schedule_jobs()` and read back what it
/// applied. The function is the only writer of the three cron jobs, so this is
/// the only way the CLI changes a schedule.
///
/// # Errors
/// Returns the transport's own failure, or [`Error::Boundary`] when the
/// function answers something that is not the documented object.
pub fn apply_schedules(applier: &dyn Applier) -> Result<ScheduleOutcome> {
    let rows = applier.run_query(&schedule_jobs_query())?;
    let Some(row) = rows.first() else {
        return Err(Error::Boundary(
            "kizunasync._schedule_jobs() returned no row, expected exactly 1".to_owned(),
        ));
    };

    parse_schedule_outcome(&require_string(row, "schedules")?)
}

/// The function's `jsonb` answer, which arrives as text over the simple query
/// protocol and as a string over the Management API alike.
///
/// # Errors
/// Returns [`Error::Boundary`] when the payload is not the `{ jobs, pg_cron }`
/// object the function documents.
pub(crate) fn parse_schedule_outcome(payload: &str) -> Result<ScheduleOutcome> {
    let boundary = || {
        Error::Boundary(format!(
            "kizunasync._schedule_jobs() answered {payload:?}, not a {{ jobs, pg_cron }} object"
        ))
    };
    let value: serde_json::Value = serde_json::from_str(payload).map_err(|_| boundary())?;
    let pg_cron = value.get("pg_cron").and_then(serde_json::Value::as_bool);
    let jobs = value.get("jobs").and_then(serde_json::Value::as_object);
    let (Some(pg_cron), Some(jobs)) = (pg_cron, jobs) else {
        return Err(boundary());
    };

    let mut schedules = BTreeMap::new();
    for (name, schedule) in jobs {
        let Some(schedule) = schedule.as_str() else {
            return Err(boundary());
        };
        schedules.insert(name.clone(), schedule.to_owned());
    }

    Ok(ScheduleOutcome {
        pg_cron,
        jobs: schedules,
    })
}
