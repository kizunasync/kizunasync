//! `status`: what this project has provisioned, read-only.
//!
//! `doctor` answers "is my local setup sane?"; `status` answers "what is
//! actually out there?" in one report: the pack (the ledger, compared against
//! the shipped pack when there is one on disk), the synced tables
//! (`kizunasync._config`, which IS the declaration) plus the live columns of
//! each, the registered clients with the newest of them one by one, every
//! column of `kizunasync._settings`, the three background jobs, what retention
//! has left behind, the conflict journal's size, the attachment metadata, and
//! whether PostgREST exposes `kizunasync` at all.
//!
//! The ledger is the source, so a run without the shipped pack directory still
//! reports: it simply has nothing to compare the recorded files against.
//!
//! This command NEVER writes: no DDL, no ledger row, no file. It never prompts.
//! On a TTY it draws a Clack-style report (vermilion intro / boxed notes /
//! outro) through [`Prompter`]; in CI it is a
//! docker-cli one-shot: `--json` / `--format json` print ONE object on stdout
//! with stable keys and no chrome, `--format text` is compact labelled stderr,
//! and `-q` / `--quiet` prints only the pack state on stdout.

use serde::Serialize;

use crate::commands::OK;
use crate::commands::jobs::JobsReport;
use crate::prompts::{CliclackPrompter, Prompter};
use crate::ui::Ui;

mod build;
mod render;
mod sections;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

pub use build::{build_report, describe_pack};
pub use render::{report, report_pretty};

/// The one state string that gates every DB-backed section.
const NOT_PROVISIONED: &str = "not provisioned";

/// How many client rows the report names one by one. A project's fleet has no
/// bound, and the aggregate counts above the list are what describe the rest.
pub const PER_CLIENT_LIMIT: usize = 50;

/// How the human or machine view is rendered. Pretty Clack lives in
/// [`report_pretty`]: this enum is the non-interactive surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusView {
    /// One JSON object on stdout, no chrome.
    Json,
    /// Compact labelled lines on stderr.
    Text,
    /// Pack state only, one line on stdout.
    Quiet,
}

/// Which of its four shapes a report is drawn in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusRender {
    /// The pack state alone, on stdout.
    Quiet,
    /// One JSON object on stdout.
    Json,
    /// The Clack report on a terminal, falling back to text.
    Pretty,
    /// Compact labelled lines on stderr.
    Text,
}

/// Draw `status` the way `shape` asks. The Clack report falls back to the
/// text view when the terminal cannot take it.
pub fn render(ui: &mut Ui, status: &StatusReport, shape: StatusRender) -> i32 {
    match shape {
        StatusRender::Quiet => report(ui, status, StatusView::Quiet),
        StatusRender::Json => report(ui, status, StatusView::Json),
        StatusRender::Text => report(ui, status, StatusView::Text),
        StatusRender::Pretty => {
            let mut chrome = CliclackPrompter::for_display();
            if report_pretty(&mut chrome, status) == OK {
                return OK;
            }

            report(ui, status, StatusView::Text)
        }
    }
}

/// The report inside a session that already draws its own intro and outro,
/// with the same text fallback as [`render()`].
pub(crate) fn render_in_session(
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
    status: &StatusReport,
) -> i32 {
    if render::report_sections(prompter, status) == OK {
        return OK;
    }

    report(ui, status, StatusView::Text)
}

/// The pack section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackStatus {
    /// The human state sentence.
    pub state: String,
    /// How many files the shipped pack contains.
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    /// Drift only: what the ledger and the pack disagree about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offenders: Option<Vec<String>>,
    /// Upgrade-available only: the pack files the ledger has no row for.
    #[serde(rename = "pendingFiles", skip_serializing_if = "Option::is_none")]
    pub pending_files: Option<Vec<String>>,
}

/// How a table sits. `kizunasync._config` is the declaration, so a row IS the
/// synced contract; the variant stays in the payload because the key is part of
/// the `--json` surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum TableState {
    /// Declared in `kizunasync._config` and provisioned by it.
    Synced,
}

/// One live column of a provisioned table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColumnStatus {
    /// `information_schema.columns.table_schema`.
    pub schema: String,
    /// The column name.
    pub name: String,
    /// `information_schema.columns.data_type`.
    #[serde(rename = "dataType")]
    pub data_type: String,
}

/// One table's row in the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TableStatus {
    /// The table name.
    pub table: String,
    /// Where it sits.
    pub state: TableState,
    /// `sync_mode` from `kizunasync._config`.
    #[serde(rename = "syncMode")]
    pub sync_mode: Option<String>,
    /// `bucket_column`.
    #[serde(rename = "bucketColumn")]
    pub bucket_column: Option<String>,
    /// `conflict_mode`.
    #[serde(rename = "conflictMode")]
    pub conflict_mode: Option<String>,
    /// `conflict_journal`: server-side loser-value recording (D-conflict-journal-visibility: not on the wire).
    #[serde(rename = "conflictJournal", skip_serializing_if = "Option::is_none")]
    pub conflict_journal: Option<bool>,
    /// `soft_delete_column`.
    #[serde(rename = "softDeleteColumn", skip_serializing_if = "Option::is_none")]
    pub soft_delete_column: Option<String>,
    /// The retention this table's tombstones are reaped on: its own
    /// `tombstone_ttl_days`, or the project's when the column is null, which is
    /// the value `kizunasync.reap_tombstones()` coalesces to.
    #[serde(rename = "tombstoneTtlDays", skip_serializing_if = "Option::is_none")]
    pub tombstone_ttl_days: Option<i64>,
    /// Whether that value came from `kizunasync._settings` rather than from
    /// this row.
    #[serde(rename = "tombstoneTtlInherited")]
    pub tombstone_ttl_inherited: bool,
    /// `min_schema_version`.
    #[serde(rename = "minSchemaVersion", skip_serializing_if = "Option::is_none")]
    pub min_schema_version: Option<i64>,
    /// `register_clients`.
    #[serde(rename = "registerClients", skip_serializing_if = "Option::is_none")]
    pub register_clients: Option<bool>,
    /// `created_at` from `_config`, as text.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Live columns, empty when the table's columns could not be read.
    pub columns: Vec<ColumnStatus>,
}

/// One registered device, as `kizunasync._clients` carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClientStatus {
    /// `client_id`: the request key, or the JWT session id when the request
    /// carried none.
    #[serde(rename = "clientId")]
    pub client_id: String,
    /// `user_id`: who the device syncs as.
    #[serde(rename = "userId")]
    pub user_id: String,
    /// `last_seen`: the last pull or push that registered it.
    #[serde(rename = "lastSeen")]
    pub last_seen: String,
    /// `last_mutation_id`: the last mutation this device acknowledged through
    /// push. Replay protection is `_verdicts`; this is the progress watermark.
    #[serde(rename = "lastMutationId")]
    pub last_mutation_id: Option<String>,
    /// The high-water half of `cursor`, which is what
    /// `kizunasync.compact_changelog()` floors on.
    #[serde(rename = "cursorHighWater")]
    pub cursor_high_water: Option<i64>,
    /// Whether this device is silent past `client_ttl_days`.
    pub stale: bool,
}

/// The clients section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClientsStatus {
    /// Registered devices.
    pub clients: i64,
    /// Distinct users behind them.
    pub users: i64,
    /// Most recent `last_seen`, if any.
    #[serde(rename = "lastSeen")]
    pub last_seen: Option<String>,
    /// Devices silent for longer than `client_ttl_days`: what
    /// `kizunasync.prune_clients()` deletes and what stops holding the
    /// compaction floor down.
    pub stale: i64,
    /// `kizunasync._settings.client_ttl_days`, the threshold `stale` counts
    /// against.
    #[serde(rename = "ttlDays")]
    pub ttl_days: Option<i64>,
    /// The newest [`PER_CLIENT_LIMIT`] devices, `last_seen` first. A fleet is
    /// unbounded, so the report names the ones an operator is looking at rather
    /// than every row.
    #[serde(rename = "perClient")]
    pub per_client: Vec<ClientStatus>,
}

/// One table's row count, for the sections that report per table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TableCount {
    /// The table the rows belong to.
    pub table: String,
    /// How many there are.
    pub rows: i64,
}

/// The retention section: what the reaper and the compactor have left behind,
/// and how far the reaper has got.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RetentionStatus {
    /// Tombstones per table, in table order.
    pub tombstones: Vec<TableCount>,
    /// Tombstones in total.
    #[serde(rename = "tombstoneRows")]
    pub tombstone_rows: i64,
    /// Rows in `kizunasync._changelog`.
    #[serde(rename = "changelogRows")]
    pub changelog_rows: i64,
    /// `kizunasync._reap_state.reaped_seq`: the watermark a client checkpoint
    /// is fenced against.
    #[serde(rename = "reapedSeq")]
    pub reaped_seq: Option<i64>,
    /// `kizunasync._reap_state.reaped_at`: when the reaper last ran, which is
    /// how "nothing expired" is told from "it never ran".
    #[serde(rename = "reapedAt")]
    pub reaped_at: Option<String>,
}

/// The conflict-journal section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JournalStatus {
    /// Rows in `kizunasync._conflict_journal`.
    pub rows: i64,
}

/// One bucket's attachment count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BucketCount {
    /// `bucket_id`.
    pub bucket: String,
    /// How many rows reference it.
    pub rows: i64,
}

/// The attachments section. A row exists only once `attachment_confirm` has
/// run, so the split is by integrity metadata, which is what the confirm
/// writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttachmentsStatus {
    /// Rows in `kizunasync.attachments`.
    pub rows: i64,
    /// Rows carrying a `sha256`.
    #[serde(rename = "withSha")]
    pub with_sha: i64,
    /// Rows without one.
    #[serde(rename = "withoutSha")]
    pub without_sha: i64,
    /// Rows per bucket, in bucket order.
    pub buckets: Vec<BucketCount>,
}

/// The settings section: every column of the single-row
/// `kizunasync._settings`, so a knob the CLI can write is a knob it can read
/// back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingsStatus {
    /// `max_batch_size`, null meaning unlimited.
    #[serde(rename = "maxBatchSize")]
    pub max_batch_size: Option<i64>,
    /// `require_atomic`.
    #[serde(rename = "requireAtomic")]
    pub require_atomic: bool,
    /// `reap_schedule`: the UTC crontab of `kizunasync-reap-tombstones`.
    #[serde(rename = "reapSchedule")]
    pub reap_schedule: Option<String>,
    /// `compact_schedule`: the UTC crontab of `kizunasync-compact-changelog`.
    #[serde(rename = "compactSchedule")]
    pub compact_schedule: Option<String>,
    /// `client_prune_schedule`: the UTC crontab of `kizunasync-prune-clients`.
    #[serde(rename = "clientPruneSchedule")]
    pub client_prune_schedule: Option<String>,
    /// `client_ttl_days`: how long a silent device keeps its row.
    #[serde(rename = "clientTtlDays")]
    pub client_ttl_days: Option<i64>,
    /// `hlc_max_skew_ms`: how far ahead of the server an origin clock may run.
    #[serde(rename = "hlcMaxSkewMs")]
    pub hlc_max_skew_ms: Option<i64>,
    /// `tombstone_ttl_days`: the project-wide retention a table with no value
    /// of its own inherits.
    #[serde(rename = "tombstoneTtlDays")]
    pub tombstone_ttl_days: Option<i64>,
    /// `max_pull_scan`: how many candidates one pull page examines at most.
    #[serde(rename = "maxPullScan")]
    pub max_pull_scan: Option<i64>,
}

/// The whole report: the `--json` payload, and what the human view renders.
///
/// Every key is always present. A section that could not be read because
/// nothing is provisioned is `null`, never missing: a consumer tells "no pack"
/// from "no rows" by the section being null rather than by its absence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatusReport {
    /// Pack state.
    pub pack: PackStatus,
    /// Tables, sorted.
    pub tables: Vec<TableStatus>,
    /// Clients, absent when nothing is provisioned.
    pub clients: Option<ClientsStatus>,
    /// Settings, absent when nothing is provisioned.
    pub settings: Option<SettingsStatus>,
    /// The three background jobs, absent when nothing is provisioned.
    pub jobs: Option<JobsReport>,
    /// Tombstones, changelog, and the reap watermark.
    pub retention: Option<RetentionStatus>,
    /// The conflict journal's size.
    pub journal: Option<JournalStatus>,
    /// Attachment metadata rows.
    pub attachments: Option<AttachmentsStatus>,
    /// The exposed-schema verdict.
    #[serde(rename = "apiSchemas")]
    pub api_schemas: String,
}
