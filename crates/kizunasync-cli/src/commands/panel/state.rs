//! What the control panel knows about the database it opened on, as data.
//!
//! One refresh reads the status report, the ledger rows, and the plan against
//! this CLI's pack; everything the header says and every item the menu offers
//! is a function of the [`PanelState`] built from them, so each combination is
//! testable without a connection.

use std::str::FromStr;

use jiff::Timestamp;

use crate::commands::jobs::{Job, JobsReport};
use crate::commands::status::{ClientsStatus, StatusReport};
use crate::proposals::describe_key_columns;
use crate::provision::{DriftReason, LedgerRow, PACK_FILE_KIND, Plan, ledger_newer};
use crate::version::Version;
use crate::wizard_theme::wrap_at;

/// How the panel reaches the database, which decides what it can run there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Transport {
    /// A direct Postgres connection: every command runs.
    Direct,
    /// The Supabase Management API: `jobs` and `deprovision` take a direct
    /// connection, so their items say so instead of running.
    ManagementApi,
}

/// Where the installed pack stands against the one this CLI ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PackState {
    /// The ledger exists and records nothing, which is what a removal leaves.
    NotInstalled,
    /// Every pack file is recorded with this CLI's hash.
    UpToDate,
    /// Only files the ledger does not record differ, this many of them.
    Pending(usize),
    /// A recorded hash differs from this CLI's pack.
    Changed,
    /// Provisioned without a `pack-file` row, which `upgrade` refuses.
    Unversioned,
    /// This run has no shipped pack on disk to compare the ledger against.
    NoPackOnDisk,
    /// A newer kizunasync recorded the pack, so the panel only reads.
    Newer,
}

impl PackState {
    /// Whether the ledger's `pack-file` rows differ from this CLI's pack,
    /// which every item that writes offers to re-apply first.
    pub(crate) const fn differs(self) -> bool {
        matches!(self, Self::Pending(_) | Self::Changed)
    }
}

/// When something happened, as the header says it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum When {
    /// This many seconds before the refresh.
    Ago(i64),
    /// The database's own text, when it does not parse as an instant.
    At(String),
}

/// The newest run among the three jobs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LastRun {
    /// The job's short name, as `kizunasync jobs run` takes it.
    pub(crate) job: String,
    /// When it started.
    pub(crate) when: When,
}

/// The jobs line of the header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum JobsSummary {
    /// pg_cron is not installed, so nothing is scheduled.
    NoPgCron,
    /// How many of the three jobs pg_cron holds, and the newest run.
    Scheduled {
        /// Jobs with a `cron.job` row.
        count: usize,
        /// The newest run, `None` before any job has run.
        last_run: Option<LastRun>,
    },
}

/// The clients line of the header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClientsSummary {
    /// Rows in `kizunasync._clients`.
    pub(crate) registered: i64,
    /// Devices seen in the last hour, among the newest ones the report lists.
    pub(crate) active: usize,
    /// Whether every listed device was active while the registry holds more
    /// than the report lists, which makes `active` a lower bound.
    pub(crate) at_least: bool,
}

/// One synced table, its sync mode, and its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SyncedTable {
    /// The table name.
    pub(crate) name: String,
    /// `sync_mode` from `kizunasync._config`.
    pub(crate) mode: Option<String>,
    /// `key_columns` from `kizunasync._config`.
    pub(crate) key: Vec<String>,
}

/// Everything the header and the menu are drawn from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PanelState {
    /// The connection, as the header names it.
    pub(crate) title: String,
    /// How the panel reaches the database.
    pub(crate) transport: Transport,
    /// The pack against this CLI's.
    pub(crate) pack: PackState,
    /// The newest version a `pack-file` row records.
    pub(crate) pack_version: Option<String>,
    /// The synced tables, in name order.
    pub(crate) tables: Vec<SyncedTable>,
    /// The three jobs, `None` when the report carries no jobs section.
    pub(crate) jobs: Option<JobsSummary>,
    /// The client registry, `None` when the report carries no clients section.
    pub(crate) clients: Option<ClientsSummary>,
    /// Whether `supabase/migrations` exists, which `lint` needs.
    pub(crate) has_migrations: bool,
}

/// The reads one refresh makes, and the instant it made them.
pub(crate) struct PanelReads<'a> {
    /// The connection, as the header names it.
    pub(crate) title: String,
    /// How the panel reaches the database.
    pub(crate) transport: Transport,
    /// `status::build_report` over the connection.
    pub(crate) report: &'a StatusReport,
    /// The ledger rows.
    pub(crate) rows: &'a [LedgerRow],
    /// The plan against this CLI's pack, `None` without a pack on disk.
    pub(crate) plan: Option<&'a Plan>,
    /// Whether `supabase/migrations` exists.
    pub(crate) has_migrations: bool,
    /// The refresh instant, in UTC epoch seconds.
    pub(crate) now_unix: i64,
}

/// Seconds a device may be silent and still count as active.
const ACTIVE_WINDOW_SECONDS: i64 = 60 * 60;

impl PanelState {
    /// Build the state from one refresh's reads.
    pub(crate) fn from_reads(reads: &PanelReads<'_>) -> Self {
        Self {
            title: reads.title.clone(),
            transport: reads.transport,
            pack: pack_state(reads.rows, reads.plan),
            pack_version: recorded_version(reads.rows),
            tables: reads
                .report
                .tables
                .iter()
                .map(|table| SyncedTable {
                    name: table.table.clone(),
                    mode: table.sync_mode.clone(),
                    key: table.key.clone(),
                })
                .collect(),
            jobs: reads
                .report
                .jobs
                .as_ref()
                .map(|jobs| summarize_jobs(jobs, reads.now_unix)),
            clients: reads
                .report
                .clients
                .as_ref()
                .map(|clients| summarize_clients(clients, reads.now_unix)),
            has_migrations: reads.has_migrations,
        }
    }

    /// Whether a newer kizunasync recorded the pack, which leaves the panel
    /// with the items that only read.
    pub(crate) const fn is_read_only(&self) -> bool {
        matches!(self.pack, PackState::Newer)
    }
}

/// The ledger against this CLI: a newer build's row first, since it makes
/// every writing command refuse, then the plan.
fn pack_state(rows: &[LedgerRow], plan: Option<&Plan>) -> PackState {
    if !ledger_newer(rows, crate::VERSION).is_empty() {
        return PackState::Newer;
    }
    if rows.is_empty() {
        return PackState::NotInstalled;
    }
    let Some(plan) = plan else {
        return PackState::NoPackOnDisk;
    };

    match plan {
        Plan::Apply { .. } => PackState::NotInstalled,
        Plan::UpToDate { .. } => PackState::UpToDate,
        Plan::ProvisionedUnversioned { .. } => PackState::Unversioned,
        Plan::Drift { offending, .. } => {
            let pending = offending
                .iter()
                .filter(|offender| offender.reason == DriftReason::NotRecorded)
                .count();
            if pending == offending.len() {
                PackState::Pending(pending)
            } else {
                PackState::Changed
            }
        }
    }
}

/// The newest version a `pack-file` row records. A version this build cannot
/// order is shown only when no row carries one it can.
fn recorded_version(rows: &[LedgerRow]) -> Option<String> {
    let recorded: Vec<&str> = rows
        .iter()
        .filter(|row| row.object_kind == PACK_FILE_KIND)
        .map(|row| row.pack_version.as_str())
        .collect();

    recorded
        .iter()
        .filter_map(|version| Version::parse(version).map(|parsed| (parsed, *version)))
        .max_by(|left, right| left.0.cmp(&right.0))
        .map(|(_, version)| version)
        .or_else(|| recorded.first().copied())
        .map(ToOwned::to_owned)
}

fn summarize_jobs(jobs: &JobsReport, now_unix: i64) -> JobsSummary {
    if !jobs.pg_cron {
        return JobsSummary::NoPgCron;
    }

    let count = jobs
        .jobs
        .iter()
        .filter(|job| job.schedule.is_some())
        .count();
    let last_run = jobs
        .jobs
        .iter()
        .filter_map(|job| {
            let started = job.last_start.as_deref()?;

            Some((job.name.as_str(), started, parse_instant(started)))
        })
        .max_by_key(|(_, _, instant)| *instant)
        .map(|(name, started, instant)| LastRun {
            job: short_name(name),
            when: instant.map_or_else(
                || When::At(started.to_owned()),
                |instant| When::Ago(now_unix.saturating_sub(instant)),
            ),
        });

    JobsSummary::Scheduled { count, last_run }
}

/// A `cron.job` name as `kizunasync jobs run` spells the job, or the name
/// itself for one the pack does not schedule.
fn short_name(job_name: &str) -> String {
    Job::ALL
        .iter()
        .find(|job| job.job_name() == job_name)
        .map_or(job_name, |job| job.label())
        .to_owned()
}

fn summarize_clients(clients: &ClientsStatus, now_unix: i64) -> ClientsSummary {
    let active = clients
        .per_client
        .iter()
        .filter_map(|client| parse_instant(&client.last_seen))
        .filter(|seen| now_unix.saturating_sub(*seen) <= ACTIVE_WINDOW_SECONDS)
        .count();
    let listed = i64::try_from(clients.per_client.len()).unwrap_or(i64::MAX);

    ClientsSummary {
        registered: clients.clients,
        active,
        at_least: active == clients.per_client.len() && listed < clients.clients,
    }
}

/// A `timestamptz::text` value as epoch seconds. Postgres writes
/// `2026-09-28 10:12:34.5+00`, which is RFC 3339 with a space and an hour-only
/// offset.
pub(crate) fn parse_instant(text: &str) -> Option<i64> {
    Timestamp::from_str(text.trim())
        .ok()
        .map(Timestamp::as_second)
}

// MARK: - header

/// The column the header's values start at.
const LABEL_WIDTH: usize = 12;

/// The columns the note around the header takes from the terminal: the bar
/// and two spaces on the left, the padding and the border on the right.
const NOTE_FRAME: usize = 6;

/// The same for the note's title line, which the box's top edge follows.
const NOTE_TITLE_FRAME: usize = 7;

/// The header's title and body: the connection, then the pack, the tables,
/// the jobs, and the clients, or the reason a read-only panel only reads.
/// The title and each value wrap to `columns`, the terminal's width, at their
/// ` · ` separators, a value's continuation under the value column.
pub(crate) fn header(state: &PanelState, columns: usize) -> (String, String) {
    let title = wrap_at(
        &format!("Kizuna Sync · {}", state.title),
        columns.saturating_sub(NOTE_TITLE_FRAME),
        " · ",
    )
    .join("\n");
    let width = columns.saturating_sub(NOTE_FRAME);
    if state.is_read_only() {
        let reason = [
            format!(
                "This project runs pack {}; this CLI ships {}.",
                state.pack_version.as_deref().unwrap_or("?"),
                crate::VERSION
            ),
            "Update kizunasync before changing anything.".to_owned(),
        ];
        let lines: Vec<String> = reason
            .iter()
            .flat_map(|sentence| wrap_at(sentence, width, " "))
            .collect();

        return (title, lines.join("\n"));
    }

    let lines = [
        ("Pack", pack_line(state)),
        ("Tables", tables_line(&state.tables)),
        ("Jobs", jobs_line(state.jobs.as_ref())),
        ("Clients", clients_line(state.clients.as_ref())),
    ];
    let body = lines
        .iter()
        .flat_map(|(label, value)| {
            wrap_at(value, width.saturating_sub(LABEL_WIDTH), " · ")
                .into_iter()
                .enumerate()
                .map(move |(index, part)| {
                    let label = if index == 0 { *label } else { "" };

                    format!("{label:<LABEL_WIDTH$}{part}")
                })
        })
        .collect::<Vec<_>>()
        .join("\n");

    (title, body)
}

fn pack_line(state: &PanelState) -> String {
    let version = state.pack_version.as_deref().unwrap_or("unknown version");
    match state.pack {
        PackState::NotInstalled => "not installed".to_owned(),
        PackState::UpToDate => format!("{version} · matches this CLI"),
        PackState::Pending(files) => {
            format!("{version} · this CLI ships {files} pack file(s) the ledger does not record")
        }
        PackState::Changed => format!("{version} · this CLI ships a different pack"),
        PackState::Unversioned => {
            "no pack-file row · provisioned outside kizunasync init".to_owned()
        }
        PackState::NoPackOnDisk => format!("{version} · no pack on disk to compare"),
        PackState::Newer => format!("{version} · newer than this CLI"),
    }
}

fn tables_line(tables: &[SyncedTable]) -> String {
    if tables.is_empty() {
        return "none synced".to_owned();
    }

    let named = tables.iter().map(|table| {
        let key = format!("key {}", describe_key_columns(&table.key));
        match &table.mode {
            Some(mode) => format!("{} ({mode}, {key})", table.name),
            None => format!("{} ({key})", table.name),
        }
    });

    std::iter::once(format!("{} synced", tables.len()))
        .chain(named)
        .collect::<Vec<_>>()
        .join(" · ")
}

fn jobs_line(jobs: Option<&JobsSummary>) -> String {
    match jobs {
        None => "none".to_owned(),
        Some(JobsSummary::NoPgCron) => "pg_cron is not installed · nothing scheduled".to_owned(),
        Some(JobsSummary::Scheduled { count, last_run }) => {
            let last = last_run.as_ref().map_or_else(
                || "no run yet".to_owned(),
                |run| format!("last {} {}", run.job, describe_when(&run.when)),
            );

            format!("{count} scheduled · {last}")
        }
    }
}

fn clients_line(clients: Option<&ClientsSummary>) -> String {
    let Some(clients) = clients else {
        return "none".to_owned();
    };

    let plus = if clients.at_least { "+" } else { "" };

    format!(
        "{} registered · {}{plus} active in the last hour",
        clients.registered, clients.active
    )
}

/// An age in the largest whole unit that fits, or the database's own text.
pub(crate) fn describe_when(when: &When) -> String {
    const MINUTE: i64 = 60;
    const HOUR: i64 = 60 * MINUTE;
    const DAY: i64 = 24 * HOUR;

    match when {
        When::At(text) => format!("at {text}"),
        When::Ago(seconds) if *seconds < MINUTE => "just now".to_owned(),
        When::Ago(seconds) if *seconds < HOUR => format!("{} min ago", seconds / MINUTE),
        When::Ago(seconds) if *seconds < DAY => format!("{} h ago", seconds / HOUR),
        When::Ago(seconds) if *seconds < 2 * DAY => "1 day ago".to_owned(),
        When::Ago(seconds) => format!("{} days ago", seconds / DAY),
    }
}
