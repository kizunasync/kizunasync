//! The control panel's menus as data: which items a [`PanelState`] offers,
//! the label and hint each one reads, and the one action they resolve to.

use crate::commands::jobs::Job;

use super::state::{PackState, PanelState, Transport};

/// Everything the panel does: its own menu, then the background jobs submenu
/// and the job it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelAction {
    /// Add, remove, or change the synced tables.
    SyncedTables,
    /// The server maintenance, push-policy, and pg_cron steps.
    ProjectSettings,
    /// Apply the pending pack files, or re-apply the pack.
    UpdatePack,
    /// Every `doctor` check.
    HealthCheck,
    /// The full `status` report.
    Status,
    /// The background jobs submenu.
    BackgroundJobs,
    /// `lint` over `supabase/migrations`.
    PendingMigrations,
    /// `deprovision`, with a dry run first.
    RemoveKizuna,
    /// Close the panel.
    Exit,
    /// `jobs list`.
    ListJobs,
    /// Pick one job, then run it.
    RunJobNow,
    /// `jobs schedule`.
    RescheduleJobs,
    /// `jobs run` for one job.
    RunJob(Job),
}

impl PanelAction {
    /// The `kizunasync` subcommand this action runs, `None` for closing the
    /// panel.
    #[must_use]
    pub const fn command(self) -> Option<&'static str> {
        match self {
            Self::SyncedTables | Self::ProjectSettings => Some("sync"),
            Self::UpdatePack => Some("upgrade"),
            Self::HealthCheck => Some("doctor"),
            Self::Status => Some("status"),
            Self::BackgroundJobs
            | Self::ListJobs
            | Self::RunJobNow
            | Self::RescheduleJobs
            | Self::RunJob(_) => Some("jobs"),
            Self::PendingMigrations => Some("lint"),
            Self::RemoveKizuna => Some("deprovision"),
            Self::Exit => None,
        }
    }

    /// The line the menu shows for it.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::SyncedTables => "Synced tables",
            Self::ProjectSettings => "Project settings",
            Self::UpdatePack => "Update the pack",
            Self::HealthCheck => "Health check",
            Self::Status => "Status",
            Self::BackgroundJobs => "Background jobs",
            Self::PendingMigrations => "Pending migrations",
            Self::RemoveKizuna => "Remove Kizuna",
            Self::Exit => "Exit",
            Self::ListJobs => "List the jobs",
            Self::RunJobNow => "Run a job now",
            Self::RescheduleJobs => "Reschedule from settings",
            Self::RunJob(job) => job.label(),
        }
    }
}

/// One row of a panel select.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelItem {
    /// What choosing it does.
    pub action: PanelAction,
    /// The line the user reads.
    pub label: String,
    /// The muted column beside it.
    pub hint: String,
}

impl PanelItem {
    fn new(action: PanelAction, hint: &str) -> Self {
        Self {
            action,
            label: action.label().to_owned(),
            hint: hint.to_owned(),
        }
    }
}

/// The panel's question.
pub(crate) const MENU_MESSAGE: &str = "What do you want to do?";

/// The background jobs submenu's question.
pub(crate) const JOBS_MESSAGE: &str = "Background jobs";

/// The job picker's question.
pub(crate) const JOB_MESSAGE: &str = "Which job?";

/// Why `jobs` and `deprovision` do not run over the Management API.
pub(crate) const NEEDS_DIRECT: &str =
    "unavailable over the Management API: needs a direct Postgres connection";

/// The panel's menu for `state`. A pack a newer kizunasync recorded leaves
/// the items that only read.
pub(crate) fn panel_menu(state: &PanelState) -> Vec<PanelItem> {
    if state.is_read_only() {
        return [
            PanelAction::Status,
            PanelAction::HealthCheck,
            PanelAction::Exit,
        ]
        .into_iter()
        .map(|action| PanelItem::new(action, ""))
        .collect();
    }

    let direct_only = |hint: &str| match state.transport {
        Transport::Direct => hint.to_owned(),
        Transport::ManagementApi => NEEDS_DIRECT.to_owned(),
    };
    let mut items = vec![
        PanelItem::new(
            PanelAction::SyncedTables,
            "add, remove or change what syncs",
        ),
        PanelItem::new(
            PanelAction::ProjectSettings,
            "batch size, retention, schedules",
        ),
        PanelItem::new(PanelAction::UpdatePack, &update_hint(state.pack)),
        PanelItem::new(PanelAction::HealthCheck, "run every doctor check"),
        PanelItem::new(PanelAction::Status, "full report"),
        PanelItem::new(
            PanelAction::BackgroundJobs,
            &direct_only("list, run now, reschedule"),
        ),
    ];
    if state.has_migrations {
        items.push(PanelItem::new(
            PanelAction::PendingMigrations,
            "classify additive vs breaking",
        ));
    }
    items.push(PanelItem::new(
        PanelAction::RemoveKizuna,
        &direct_only("deprovision, with a dry run first"),
    ));
    items.push(PanelItem::new(PanelAction::Exit, ""));

    items
}

/// What "Update the pack" would do, beside its label.
fn update_hint(pack: PackState) -> String {
    match pack {
        PackState::UpToDate => "up to date · re-apply to restore dropped objects".to_owned(),
        PackState::Pending(files) => format!("{files} pending pack file(s) to apply"),
        PackState::Changed => "this CLI's pack differs · re-apply and record its hash".to_owned(),
        PackState::Unversioned => {
            "provisioned outside kizunasync init · upgrade refuses it".to_owned()
        }
        PackState::NoPackOnDisk => "no pack on disk to compare".to_owned(),
        PackState::NotInstalled => "nothing installed · Synced tables installs the pack".to_owned(),
        PackState::Newer => "update kizunasync first".to_owned(),
    }
}

/// The background jobs submenu.
pub(crate) fn jobs_menu() -> Vec<PanelItem> {
    vec![
        PanelItem::new(PanelAction::ListJobs, "schedule, last run, drift"),
        PanelItem::new(
            PanelAction::RunJobNow,
            "reap, compact or prune, over this connection",
        ),
        PanelItem::new(
            PanelAction::RescheduleJobs,
            "apply kizunasync._settings to pg_cron",
        ),
    ]
}

/// One row per job, each naming the function it calls.
pub(crate) fn job_menu() -> Vec<PanelItem> {
    Job::ALL
        .into_iter()
        .map(|job| PanelItem::new(PanelAction::RunJob(job), &format!("{}()", job.function())))
        .collect()
}
