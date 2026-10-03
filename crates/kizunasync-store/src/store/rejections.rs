use super::LocalStore;
use crate::error::StoreError;
use crate::types::{RejectionRecord, stored};
use rusqlite::params;

const REJECTION_SELECT: &str = "SELECT mutation_id, table_name, pk, kind, reason,
    changed_columns, server_row, at, dismissed
    FROM _kizunasync_rejections";

impl LocalStore {
    /// Journal a rejected mutation. Re-journalling the same `mutation_id` replaces
    /// the row and clears any prior dismissal.
    ///
    /// # Errors
    ///
    /// [`StoreError::Json`] when `server_row` or `changed_columns` will not
    /// encode, or [`StoreError::Sqlite`] when the write fails.
    pub fn insert_rejection(&self, record: &RejectionRecord) -> Result<(), StoreError> {
        let server_row = record
            .server_row
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        self.conn.execute(
            "INSERT OR REPLACE INTO _kizunasync_rejections(
                mutation_id, table_name, pk, kind, reason, changed_columns, server_row, at, dismissed
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                record.mutation_id,
                record.table,
                record.pk,
                record.kind.as_str(),
                record.reason,
                serde_json::to_string(&record.changed_columns)?,
                server_row,
                record.at,
                i64::from(record.dismissed),
            ],
        )?;
        Ok(())
    }

    /// Newest first: the order a "what happened to my writes" surface shows.
    /// Dismissed entries are excluded unless `include_dismissed` is set.
    ///
    /// # Errors
    ///
    /// [`StoreError::UnknownVocabulary`] when a row's `kind` falls outside the
    /// closed union, [`StoreError::Json`] when a stored payload will not
    /// decode, or [`StoreError::Sqlite`] when the query fails.
    pub fn list_rejections(
        &self,
        include_dismissed: bool,
    ) -> Result<Vec<RejectionRecord>, StoreError> {
        let filter = if include_dismissed {
            ""
        } else {
            " WHERE dismissed = 0"
        };
        let sql = format!("{REJECTION_SELECT}{filter} ORDER BY at DESC");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            <(
                String,
                String,
                String,
                String,
                String,
                String,
                Option<String>,
                i64,
                i64,
            )>::try_from(r)
        })?;
        let mut out = Vec::new();
        for item in rows {
            let (mutation_id, table, pk, kind, reason, changed, server_row, at, dismissed) = item?;
            out.push(RejectionRecord {
                mutation_id,
                table,
                pk,
                kind: stored("kind", &kind)?,
                reason,
                changed_columns: serde_json::from_str(&changed)?,
                server_row: server_row.map(|s| serde_json::from_str(&s)).transpose()?,
                at,
                dismissed: dismissed != 0,
            });
        }
        Ok(out)
    }

    /// Acknowledge one journalled rejection. Returns `false` when no row matched.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the update fails.
    pub fn dismiss_rejection(&self, mutation_id: &str) -> Result<bool, StoreError> {
        let n = self.conn.execute(
            "UPDATE _kizunasync_rejections SET dismissed = 1 WHERE mutation_id = ?1",
            params![mutation_id],
        )?;
        Ok(n == 1)
    }
}
