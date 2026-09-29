use super::LocalStore;
use crate::error::StoreError;
use crate::types::{
    DeadLetterEntry, DeadLetterRecord, RejectionKind, RejectionRecord, op_as_str, stored,
};
use rusqlite::params;
use std::collections::BTreeSet;

impl LocalStore {
    /// Drop the doomed entries: forensic row, journal row, optimistic revert, and
    /// outbox delete, all in one transaction so the local mirror never diverges
    /// from the untouched server.
    ///
    /// Entries are processed last-applied first, so a same-pk group settles on the
    /// earliest pre-image (parity with `sync-engine.ts`'s reverse walk of `doomed`).
    /// The reverts wipe the effect of writes still queued behind the doomed ones,
    /// so the walk ends with [`Self::overlay_pending`] over the reverted rows,
    /// `now` stamping a replayed delete.
    ///
    /// # Errors
    ///
    /// [`StoreError::Json`] when a payload will not encode, or
    /// [`StoreError::Sqlite`] when a write fails, plus the faults
    /// [`Self::overlay_pending`] reports.
    pub fn dead_letter(&self, records: &[DeadLetterRecord], now: &str) -> Result<(), StoreError> {
        self.transaction(|| self.dead_letter_inner(records, now))
    }

    fn dead_letter_inner(&self, records: &[DeadLetterRecord], now: &str) -> Result<(), StoreError> {
        let mut reset = BTreeSet::new();
        for record in records.iter().rev() {
            let entry = &record.entry;

            self.conn.execute(
                "INSERT INTO _kizunasync_dead_letter(
                    mutation_id, table_name, pk, op, columns_json, reason, server_row_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
                params![
                    entry.mutation_id,
                    entry.table,
                    entry.pk,
                    op_as_str(entry.op),
                    serde_json::to_string(&entry.columns)?,
                    record.reason,
                    record.created_at,
                ],
            )?;
            self.insert_rejection(&RejectionRecord {
                mutation_id: entry.mutation_id.clone(),
                table: entry.table.clone(),
                pk: entry.pk.clone(),
                kind: RejectionKind::DeadLetter,
                reason: record.reason.clone(),
                changed_columns: entry.columns.keys().cloned().collect(),
                server_row: None,
                at: record.at,
                dismissed: false,
            })?;

            self.revert_row(&entry.table, &entry.pk, entry.pre_image.as_ref())?;
            self.conn.execute(
                "DELETE FROM _kizunasync_outbox WHERE seq = ?1",
                params![entry.seq],
            )?;
            reset.insert((entry.table.clone(), entry.pk.clone()));
        }
        self.overlay_pending(&reset, now)
    }

    /// Every dead-lettered write, oldest first: the forensic trail behind a drop.
    ///
    /// # Errors
    ///
    /// [`StoreError::UnknownVocabulary`] when a row's `op` falls outside the
    /// closed union, [`StoreError::Json`] when a stored payload will not
    /// decode, or [`StoreError::Sqlite`] when the query fails.
    pub fn list_dead_letters(&self) -> Result<Vec<DeadLetterEntry>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT mutation_id, table_name, pk, op, columns_json, reason, server_row_json, created_at
             FROM _kizunasync_dead_letter ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            <(
                String,
                String,
                String,
                String,
                String,
                String,
                Option<String>,
                String,
            )>::try_from(r)
        })?;
        let mut out = Vec::new();
        for item in rows {
            let (mutation_id, table, pk, op, columns, reason, server_row, created_at) = item?;
            out.push(DeadLetterEntry {
                mutation_id,
                table,
                pk,
                op: stored("op", &op)?,
                columns: serde_json::from_str(&columns)?,
                reason,
                server_row: server_row.map(|s| serde_json::from_str(&s)).transpose()?,
                created_at,
            });
        }
        Ok(out)
    }
}
