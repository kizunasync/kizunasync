use crate::commands::jobs::JobsReport;
use crate::commands::{OK, UNUSABLE};
use crate::docs;
use crate::prompts::Prompter;
use crate::proposals::PREFERRED_SCHEMA;
use crate::ui::Ui;

use super::{
    AttachmentsStatus, ClientsStatus, ColumnStatus, JournalStatus, NOT_PROVISIONED,
    RetentionStatus, SettingsStatus, StatusReport, StatusView, TableState, TableStatus,
};

const LABEL_WIDTH: usize = 18;

/// Render the non-interactive report. Pretty Clack is [`report_pretty`].
pub fn report(ui: &mut Ui, status: &StatusReport, view: StatusView) -> i32 {
    match view {
        StatusView::Json => report_json(ui, status),
        StatusView::Quiet => {
            ui.write_stdout(&format!("{}\n", status.pack.state));

            OK
        }
        StatusView::Text => report_text(ui, status),
    }
}

fn report_json(ui: &mut Ui, status: &StatusReport) -> i32 {
    match serde_json::to_string(status) {
        Ok(payload) => ui.write_stdout(&format!("{payload}\n")),
        Err(cause) => {
            ui.error(&format!("  could not render the report as JSON: {cause}"));

            return UNUSABLE;
        }
    }

    OK
}

fn report_text(ui: &mut Ui, status: &StatusReport) -> i32 {
    ui.log(&labelled(
        "pack:",
        &format!(
            "{} ({} pack file(s))",
            status.pack.state, status.pack.file_count
        ),
    ));
    for offender in status.pack.offenders.iter().flatten() {
        ui.log(&format!("    ! {offender}"));
    }
    for pending in status.pack.pending_files.iter().flatten() {
        ui.log(&format!("    + {pending}"));
    }

    let count = status.tables.len();
    ui.log(&labelled(
        "tables:",
        &if count == 0 {
            "none".to_owned()
        } else {
            count.to_string()
        },
    ));
    log_tables(ui, &status.tables);

    ui.log(&labelled(
        "clients:",
        &describe_clients(status.clients.as_ref()),
    ));
    for line in client_lines(status.clients.as_ref()) {
        ui.log(&format!("    {line}"));
    }
    ui.log(&labelled(
        "settings:",
        &describe_settings(status.settings.as_ref()),
    ));
    for line in settings_lines(status.settings.as_ref()) {
        ui.log(&format!("    {line}"));
    }
    ui.log(&labelled("jobs:", &describe_jobs(status.jobs.as_ref())));
    for line in job_lines(status.jobs.as_ref()) {
        ui.log(&format!("    {line}"));
    }
    ui.log(&labelled(
        "retention:",
        &describe_retention(status.retention.as_ref()),
    ));
    for line in tombstone_lines(status.retention.as_ref()) {
        ui.log(&format!("    {line}"));
    }
    ui.log(&labelled(
        "journal:",
        &describe_journal(status.journal.as_ref()),
    ));
    ui.log(&labelled(
        "attachments:",
        &describe_attachments(status.attachments.as_ref()),
    ));
    for line in bucket_lines(status.attachments.as_ref()) {
        ui.log(&format!("    {line}"));
    }
    ui.log(&labelled("api schemas:", &status.api_schemas));

    OK
}

/// One line per synced table, then its columns and metadata lines when either
/// is non-empty.
fn log_tables(ui: &mut Ui, tables: &[TableStatus]) {
    for table in tables {
        ui.log(&format!(
            "    {:<24}{}{}",
            table.table,
            describe_table_state(table.state),
            describe_table_config(table)
        ));
        let columns = describe_columns(&table.columns);
        if !columns.is_empty() {
            ui.log(&format!("      columns: {columns}"));
        }
        let meta = describe_table_meta(table);
        if !meta.is_empty() {
            ui.log(&format!("      {meta}"));
        }
    }
}

/// Clack-style TTY report. Never prompts; chrome goes through [`Prompter`] so
/// tests inject a recorder instead of drawing on a real terminal.
pub fn report_pretty(prompter: &mut dyn Prompter, status: &StatusReport) -> i32 {
    if prompter.intro(docs::STATUS).is_err() {
        return UNUSABLE;
    }

    if report_sections(prompter, status) != OK {
        return UNUSABLE;
    }
    let outro = if status.pack.state == NOT_PROVISIONED {
        "nothing is provisioned: run kizunasync init"
    } else {
        "read-only, nothing was written"
    };
    if prompter.outro(outro).is_err() {
        return UNUSABLE;
    }

    OK
}

/// The boxed notes alone, for a session that already has its own intro and
/// outro: the control panel's Status item.
pub(crate) fn report_sections(prompter: &mut dyn Prompter, status: &StatusReport) -> i32 {
    for (title, body) in pretty_sections(status) {
        if prompter.note(&title, &body).is_err() {
            return UNUSABLE;
        }
    }

    OK
}

/// The boxed notes a TTY report draws, one section each, so tests can assert
/// the copy without `cliclack`.
pub(crate) fn pretty_sections(status: &StatusReport) -> Vec<(String, String)> {
    let mut pack_lines = vec![status.pack.state.clone()];
    if status.pack.file_count > 0 {
        pack_lines.push(format!("{} pack file(s)", status.pack.file_count));
    }
    for offender in status.pack.offenders.iter().flatten() {
        pack_lines.push(format!("! {offender}"));
    }
    for pending in status.pack.pending_files.iter().flatten() {
        pack_lines.push(format!("+ {pending}"));
    }

    let mut table_lines = vec![if status.tables.is_empty() {
        "none".to_owned()
    } else {
        format!("{} table(s)", status.tables.len())
    }];
    table_lines.extend(table_detail_lines(&status.tables));

    let mut client_body = vec![describe_clients(status.clients.as_ref())];
    client_body.extend(client_lines(status.clients.as_ref()));
    let mut settings_body = vec![describe_settings(status.settings.as_ref())];
    settings_body.extend(settings_lines(status.settings.as_ref()));
    let mut job_body = vec![describe_jobs(status.jobs.as_ref())];
    job_body.extend(job_lines(status.jobs.as_ref()));
    let mut retention_body = vec![describe_retention(status.retention.as_ref())];
    retention_body.extend(tombstone_lines(status.retention.as_ref()));
    let mut attachment_body = vec![describe_attachments(status.attachments.as_ref())];
    attachment_body.extend(bucket_lines(status.attachments.as_ref()));

    vec![
        ("pack".to_owned(), pack_lines.join("\n")),
        ("tables".to_owned(), table_lines.join("\n")),
        ("clients".to_owned(), client_body.join("\n")),
        ("settings".to_owned(), settings_body.join("\n")),
        ("jobs".to_owned(), job_body.join("\n")),
        ("retention".to_owned(), retention_body.join("\n")),
        (
            "journal".to_owned(),
            describe_journal(status.journal.as_ref()),
        ),
        ("attachments".to_owned(), attachment_body.join("\n")),
        ("api schemas".to_owned(), status.api_schemas.clone()),
    ]
}

/// [`log_tables`]'s lines, collected instead of logged: one entry per synced
/// table, then its columns and metadata lines when either is non-empty.
fn table_detail_lines(tables: &[TableStatus]) -> Vec<String> {
    let mut lines = Vec::new();
    for table in tables {
        lines.push(format!(
            "{}  {}{}",
            table.table,
            describe_table_state(table.state),
            describe_table_config(table)
        ));
        let columns = describe_columns(&table.columns);
        if !columns.is_empty() {
            lines.push(format!("  {columns}"));
        }
        let meta = describe_table_meta(table);
        if !meta.is_empty() {
            lines.push(format!("  {meta}"));
        }
    }

    lines
}

fn labelled(label: &str, value: &str) -> String {
    format!("  {label:<LABEL_WIDTH$}{value}")
}

const fn describe_table_state(state: TableState) -> &'static str {
    match state {
        TableState::Synced => "synced",
    }
}

fn describe_table_config(table: &TableStatus) -> String {
    let parts: Vec<String> = [
        table.sync_mode.clone(),
        table
            .bucket_column
            .as_ref()
            .map(|value| format!("bucket {value}")),
        table
            .conflict_mode
            .as_ref()
            .map(|value| format!("conflict {value}")),
    ]
    .into_iter()
    .flatten()
    .collect();

    if parts.is_empty() {
        String::new()
    } else {
        format!("   {}", parts.join("  "))
    }
}

fn describe_table_meta(table: &TableStatus) -> String {
    let mut parts = Vec::new();
    if let Some(column) = &table.soft_delete_column {
        parts.push(format!("soft-delete {column}"));
    }
    if let Some(days) = table.tombstone_ttl_days {
        let source = if table.tombstone_ttl_inherited {
            " (project default)"
        } else {
            ""
        };
        parts.push(format!("ttl {days}d{source}"));
    }
    if let Some(version) = table.min_schema_version {
        parts.push(format!("schema v{version}"));
    }
    if table.register_clients == Some(true) {
        parts.push("register-clients".to_owned());
    }
    if table.conflict_journal == Some(true) {
        parts.push("conflict-journal".to_owned());
    }
    if let Some(created) = &table.created_at {
        parts.push(format!("created {created}"));
    }

    parts.join("  ")
}

fn describe_columns(columns: &[ColumnStatus]) -> String {
    if columns.is_empty() {
        return String::new();
    }

    let show_schema = columns
        .iter()
        .any(|column| column.schema != PREFERRED_SCHEMA);
    columns
        .iter()
        .map(|column| {
            if show_schema {
                format!("{}.{} {}", column.schema, column.name, column.data_type)
            } else {
                format!("{} {}", column.name, column.data_type)
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn describe_clients(clients: Option<&ClientsStatus>) -> String {
    let Some(clients) = clients else {
        return NOT_PROVISIONED.to_owned();
    };

    let last_seen = clients.last_seen.as_deref().unwrap_or("never");
    let stale = clients.ttl_days.map_or_else(
        || format!("{} stale", clients.stale),
        |days| format!("{} stale (silent over {days}d)", clients.stale),
    );

    format!(
        "{} client(s), {} user(s), {stale}, last seen {last_seen}",
        clients.clients, clients.users
    )
}

/// One line per registered device, newest first: who it syncs as, when it was
/// last seen, how far its cursor has got, and the mutation it last acknowledged
/// through push.
fn client_lines(clients: Option<&ClientsStatus>) -> Vec<String> {
    let Some(clients) = clients else {
        return Vec::new();
    };

    clients
        .per_client
        .iter()
        .map(|client| {
            format!(
                "{}  user {}  last seen {}  cursor {}  mutation {}{}",
                client.client_id,
                client.user_id,
                client.last_seen,
                client
                    .cursor_high_water
                    .map_or_else(|| "unread".to_owned(), |seq| seq.to_string()),
                client.last_mutation_id.as_deref().unwrap_or("none"),
                if client.stale { "  stale" } else { "" }
            )
        })
        .collect()
}

/// The seven settings the summary line does not carry, one per line so a knob is
/// looked up rather than parsed out of a sentence.
pub(crate) fn settings_lines(settings: Option<&SettingsStatus>) -> Vec<String> {
    let Some(settings) = settings else {
        return Vec::new();
    };

    let mut lines = Vec::new();
    for (label, schedule) in [
        ("reap schedule", settings.reap_schedule.as_deref()),
        ("compact schedule", settings.compact_schedule.as_deref()),
        (
            "client prune schedule",
            settings.client_prune_schedule.as_deref(),
        ),
    ] {
        lines.push(format!("{label:<24}{}", schedule.unwrap_or(UNSET)));
    }
    for (label, value, unit) in [
        ("client ttl", settings.client_ttl_days, "day(s)"),
        ("hlc max skew", settings.hlc_max_skew_ms, "ms"),
        ("tombstone ttl", settings.tombstone_ttl_days, "day(s)"),
        ("max pull scan", settings.max_pull_scan, "candidate(s)"),
    ] {
        lines.push(format!(
            "{label:<24}{}",
            value.map_or_else(|| UNSET.to_owned(), |value| format!("{value} {unit}"))
        ));
    }

    lines
}

/// What a settings column with no value reads as. Every one of the seven is
/// `not null` in the pack, so this is a pack older than the column.
const UNSET: &str = "not set";

/// The jobs section's one-line summary. The table itself is `kizunasync jobs list`:
/// this says how many of the three are scheduled and whether any of them runs
/// on a timing the settings row does not declare.
fn describe_jobs(jobs: Option<&JobsReport>) -> String {
    let Some(jobs) = jobs else {
        return NOT_PROVISIONED.to_owned();
    };

    let scheduled = jobs
        .jobs
        .iter()
        .filter(|job| job.schedule.is_some())
        .count();
    let drifted = jobs.jobs.iter().filter(|job| job.drift).count();
    let drift = if drifted > 0 {
        format!(", {drifted} off the declared schedule")
    } else {
        String::new()
    };

    format!(
        "{scheduled}/{} scheduled, pg_cron {}{drift}",
        jobs.jobs.len(),
        if jobs.pg_cron { "present" } else { "absent" }
    )
}

fn job_lines(jobs: Option<&JobsReport>) -> Vec<String> {
    let Some(jobs) = jobs else {
        return Vec::new();
    };

    jobs.jobs
        .iter()
        .map(|job| {
            format!(
                "{:<30}{:<14}{}",
                job.name,
                job.schedule
                    .as_deref()
                    .or(job.settings_schedule.as_deref())
                    .unwrap_or_default(),
                job.last_status.as_deref().map_or_else(
                    || "never ran".to_owned(),
                    |status| format!(
                        "last run {} {status}",
                        job.last_start.as_deref().unwrap_or_default()
                    )
                )
            )
        })
        .collect()
}

fn describe_retention(retention: Option<&RetentionStatus>) -> String {
    let Some(retention) = retention else {
        return NOT_PROVISIONED.to_owned();
    };

    let reaped = match (&retention.reaped_at, retention.reaped_seq) {
        (Some(at), Some(seq)) => format!("reaped to seq {seq} at {at}"),
        (None, Some(seq)) => format!("reaped to seq {seq}, never run"),
        _ => "never reaped".to_owned(),
    };

    format!(
        "{} tombstone(s), {} changelog row(s), {reaped}",
        retention.tombstone_rows, retention.changelog_rows
    )
}

fn tombstone_lines(retention: Option<&RetentionStatus>) -> Vec<String> {
    let Some(retention) = retention else {
        return Vec::new();
    };

    retention
        .tombstones
        .iter()
        .map(|count| format!("{:<24}{} tombstone(s)", count.table, count.rows))
        .collect()
}

fn describe_journal(journal: Option<&JournalStatus>) -> String {
    journal.map_or_else(
        || NOT_PROVISIONED.to_owned(),
        |journal| format!("{} overwritten value(s) recorded", journal.rows),
    )
}

fn describe_attachments(attachments: Option<&AttachmentsStatus>) -> String {
    let Some(attachments) = attachments else {
        return NOT_PROVISIONED.to_owned();
    };

    format!(
        "{} row(s), {} with sha256, {} without",
        attachments.rows, attachments.with_sha, attachments.without_sha
    )
}

fn bucket_lines(attachments: Option<&AttachmentsStatus>) -> Vec<String> {
    let Some(attachments) = attachments else {
        return Vec::new();
    };

    attachments
        .buckets
        .iter()
        .map(|count| format!("{:<24}{} row(s)", count.bucket, count.rows))
        .collect()
}

pub(crate) fn describe_settings(settings: Option<&SettingsStatus>) -> String {
    let Some(settings) = settings else {
        return NOT_PROVISIONED.to_owned();
    };

    let max_batch = settings
        .max_batch_size
        .map_or_else(|| "unlimited".to_owned(), |value| value.to_string());

    format!(
        "max batch {max_batch}, require atomic {}",
        settings.require_atomic
    )
}
