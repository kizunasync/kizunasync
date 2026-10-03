use crate::error::StoreError;
use crate::types::{AttachmentEntry, OutboxEntry, stored};

pub(crate) const ATTACHMENT_SELECT: &str =
    "SELECT ref, upload_id, table_name, pk, column_name, bucket, owner,
    sha256, content_type, size, local_path, direction, state, in_flight, fingerprint,
    progress, attempts, permanent, chunk_offset, tus_url, error, created_at, updated_at,
    error_code
    FROM _kizunasync_attachments";

/// Reads one attachment row, in the column order [`ATTACHMENT_SELECT`] fixes.
///
/// # Errors
///
/// [`StoreError::Sqlite`] when a column cannot be read, or
/// [`StoreError::UnknownVocabulary`] when the stored `state` falls outside
/// [`crate::AttachmentState`].
pub(crate) fn map_attachment(r: &rusqlite::Row<'_>) -> Result<AttachmentEntry, StoreError> {
    let state: String = r.get(12)?;

    Ok(AttachmentEntry {
        reference: r.get(0)?,
        upload_id: r.get(1)?,
        table: r.get(2)?,
        pk: r.get(3)?,
        column: r.get(4)?,
        bucket: r.get(5)?,
        owner: r.get(6)?,
        sha256: r.get(7)?,
        content_type: r.get(8)?,
        size: r.get(9)?,
        local_path: r.get(10)?,
        direction: r.get(11)?,
        state: stored("state", &state)?,
        in_flight: r.get::<_, i64>(13)? != 0,
        fingerprint: r.get(14)?,
        progress: r.get(15)?,
        attempts: r.get(16)?,
        permanent: r.get::<_, i64>(17)? != 0,
        chunk_offset: r.get(18)?,
        tus_url: r.get(19)?,
        error: r.get(20)?,
        created_at: r.get(21)?,
        updated_at: r.get(22)?,
        error_code: r.get(23)?,
    })
}

pub(crate) const OUTBOX_SELECT: &str = "SELECT seq, mutation_id, table_name, pk, op, columns_json,
    transforms_json, precondition_json, batch_id, pre_image_json, hlc, created_at
    FROM _kizunasync_outbox WHERE in_flight = 0";

/// Reads one queued write, in the column order [`OUTBOX_SELECT`] fixes.
///
/// # Errors
///
/// [`StoreError::Sqlite`] when a column cannot be read,
/// [`StoreError::UnknownVocabulary`] when the stored `op` falls outside the
/// wire set, or [`StoreError::Json`] when a stored JSON column cannot be
/// decoded.
pub(crate) fn map_outbox(r: &rusqlite::Row<'_>) -> Result<OutboxEntry, StoreError> {
    let op: String = r.get(4)?;
    let columns: String = r.get(5)?;
    let transforms: Option<String> = r.get(6)?;
    let precondition: Option<String> = r.get(7)?;
    let pre_image: Option<String> = r.get(9)?;

    Ok(OutboxEntry {
        seq: r.get(0)?,
        mutation_id: r.get(1)?,
        table: r.get(2)?,
        pk: r.get(3)?,
        op: stored("op", &op)?,
        columns: serde_json::from_str(&columns)?,
        transforms: transforms
            .filter(|json| !json.is_empty())
            .map(|json| serde_json::from_str(&json))
            .transpose()?,
        precondition: precondition
            .map(|json| serde_json::from_str(&json))
            .transpose()?,
        batch_id: r.get(8)?,
        pre_image: pre_image
            .map(|json| serde_json::from_str(&json))
            .transpose()?,
        hlc: r.get(10)?,
        created_at: r.get(11)?,
    })
}

/// One attachment-patch value as `SQLite` sees it. A boolean binds as 0/1 (the
/// `in_flight` flag crosses the bridge as JSON `true`/`false`), and anything the
/// column set cannot hold (an array, an object) fails loud instead of binding
/// a stringified surprise.
pub(crate) fn sql_value(
    column: &str,
    value: &serde_json::Value,
) -> Result<rusqlite::types::Value, StoreError> {
    use rusqlite::types::Value as Sql;
    use serde_json::Value as Json;
    match value {
        Json::Null => Ok(Sql::Null),
        Json::Bool(flag) => Ok(Sql::Integer(i64::from(*flag))),
        Json::String(text) => Ok(Sql::Text(text.clone())),
        Json::Number(number) => number
            .as_i64()
            .map(Sql::Integer)
            .or_else(|| number.as_f64().map(Sql::Real))
            .ok_or_else(|| {
                StoreError::Constraint(format!("attachment patch \"{column}\" is not a number"))
            }),
        Json::Array(_) | Json::Object(_) => Err(StoreError::Constraint(format!(
            "attachment patch \"{column}\" must be a scalar"
        ))),
    }
}
