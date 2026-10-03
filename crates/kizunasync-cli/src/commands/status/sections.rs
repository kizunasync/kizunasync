//! The operational sections: retention, the conflict journal, attachments, and
//! the stale half of the client registry.
//!
//! Each is one read of the pack's own bookkeeping tables. They run only after
//! the pack section proves something is provisioned, because on an
//! unprovisioned project every one of them is a missing relation, which is not
//! the same news as "no rows".

use crate::applier::Applier;
use crate::constants::SCHEMA;
use crate::error::Result;
use crate::row::{optional_number, optional_string, require_number, require_string};

use super::{AttachmentsStatus, BucketCount, JournalStatus, RetentionStatus, TableCount};

/// `kizunasync._tombstones`: the deletes a pull replays.
const TOMBSTONES: &str = "_tombstones";
/// `kizunasync._changelog`: the upserts a pull replays.
const CHANGELOG: &str = "_changelog";
/// `kizunasync._reap_state`: the reaper's single-row watermark.
const REAP_STATE: &str = "_reap_state";
/// `kizunasync._conflict_journal`: the overwritten values a push recorded.
const CONFLICT_JOURNAL: &str = "_conflict_journal";
/// `kizunasync.attachments`: one row per confirmed object.
const ATTACHMENTS: &str = "attachments";

fn retention_query() -> String {
    format!(
        "select\n  (select count(*) from {SCHEMA}.{TOMBSTONES})::int as tombstone_rows,\n  (select count(*) from {SCHEMA}.{CHANGELOG})::int as changelog_rows,\n  (select reaped_seq from {SCHEMA}.{REAP_STATE}) as reaped_seq,\n  (select reaped_at::text from {SCHEMA}.{REAP_STATE}) as reaped_at;"
    )
}

fn tombstones_by_table_query() -> String {
    format!(
        "select table_name, count(*)::int as row_count from {SCHEMA}.{TOMBSTONES} group by 1 order by 1;"
    )
}

fn journal_query() -> String {
    format!("select count(*)::int as row_count from {SCHEMA}.{CONFLICT_JOURNAL};")
}

fn attachments_query() -> String {
    format!(
        "select\n  (select count(*) from {SCHEMA}.{ATTACHMENTS})::int as row_count,\n  (select count(*) from {SCHEMA}.{ATTACHMENTS} where sha256 is not null)::int as with_sha,\n  (select count(*) from {SCHEMA}.{ATTACHMENTS} where sha256 is null)::int as without_sha;"
    )
}

fn attachments_by_bucket_query() -> String {
    format!(
        "select bucket_id, count(*)::int as row_count from {SCHEMA}.{ATTACHMENTS} group by 1 order by 1;"
    )
}

/// What the reaper and the compactor left, per table and in total.
///
/// # Errors
/// Returns the transport's own failure, or [`Error::Boundary`](crate::error::Error::Boundary)
/// when a row does not carry the columns the pack defines.
pub(crate) fn read_retention(applier: &dyn Applier) -> Result<Option<RetentionStatus>> {
    let rows = applier.run_query(&retention_query())?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };

    let tombstones = read_table_counts(applier, &tombstones_by_table_query())?;

    Ok(Some(RetentionStatus {
        tombstones,
        tombstone_rows: require_number(row, "tombstone_rows")?,
        changelog_rows: require_number(row, "changelog_rows")?,
        reaped_seq: optional_number(row, "reaped_seq")?,
        reaped_at: optional_string(row, "reaped_at")?,
    }))
}

fn read_table_counts(applier: &dyn Applier, sql: &str) -> Result<Vec<TableCount>> {
    let rows = applier.run_query(sql)?;
    let mut counts = Vec::with_capacity(rows.len());
    for row in &rows {
        counts.push(TableCount {
            table: require_string(row, "table_name")?,
            rows: require_number(row, "row_count")?,
        });
    }

    Ok(counts)
}

/// How many overwritten values the journal holds.
///
/// # Errors
/// Returns the transport's own failure, or a boundary error on an unreadable
/// count.
pub(crate) fn read_journal(applier: &dyn Applier) -> Result<Option<JournalStatus>> {
    let rows = applier.run_query(&journal_query())?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };

    Ok(Some(JournalStatus {
        rows: require_number(row, "row_count")?,
    }))
}

/// Attachment metadata rows, split by whether the confirm recorded a digest,
/// and counted per bucket.
///
/// # Errors
/// Returns the transport's own failure, or a boundary error on an unreadable
/// count.
pub(crate) fn read_attachments(applier: &dyn Applier) -> Result<Option<AttachmentsStatus>> {
    let rows = applier.run_query(&attachments_query())?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };

    let bucket_rows = applier.run_query(&attachments_by_bucket_query())?;
    let mut buckets = Vec::with_capacity(bucket_rows.len());
    for bucket in &bucket_rows {
        buckets.push(BucketCount {
            bucket: require_string(bucket, "bucket_id")?,
            rows: require_number(bucket, "row_count")?,
        });
    }

    Ok(Some(AttachmentsStatus {
        rows: require_number(row, "row_count")?,
        with_sha: require_number(row, "with_sha")?,
        without_sha: require_number(row, "without_sha")?,
        buckets,
    }))
}
