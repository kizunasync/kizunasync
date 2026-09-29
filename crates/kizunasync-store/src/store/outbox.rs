use super::LocalStore;
use crate::error::StoreError;
use crate::mapping::{OUTBOX_SELECT, map_outbox};
use crate::types::OutboxEntry;
use rusqlite::params;

impl LocalStore {
    /// How many outbox entries are queued and not currently in flight.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the count cannot be read.
    pub fn outbox_depth(&self) -> Result<usize, StoreError> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM _kizunasync_outbox WHERE in_flight = 0",
            [],
            |r| r.get(0),
        )?;
        // `COUNT(*)` is never negative, so the saturation is unreachable.
        Ok(usize::try_from(n).unwrap_or(0))
    }

    /// The oldest `limit` queued entries in FIFO order.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] on a read failure, [`StoreError::Json`] when a
    /// stored payload is not valid JSON, and
    /// [`StoreError::UnknownVocabulary`] when a row's `op` is outside the
    /// closed union.
    pub fn list_outbox(&self, limit: usize) -> Result<Vec<OutboxEntry>, StoreError> {
        let mut stmt = self
            .conn
            .prepare(&format!("{OUTBOX_SELECT} ORDER BY seq ASC LIMIT ?1"))?;
        let mut rows = stmt.query(params![i64::try_from(limit).unwrap_or(i64::MAX)])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(map_outbox(row)?);
        }
        Ok(out)
    }

    /// The maximal CONSECUTIVE run of queued entries from `from_seq` that share
    /// `batch_id`: the whole atomic group, with no cap.
    ///
    /// [`Self::list_outbox`]'s bound would truncate a group larger than the
    /// caller's page, and a batch sent as two `atomic:true` requests is not
    /// all-or-nothing (P:verdict-completeness-transforms-and-conflict-rejection / D-atomic-batch-abort). The run stops at the first entry
    /// carrying a different `batch_id`, so a later re-use of the same id is a
    /// separate group, exactly as the FIFO scan treats it.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] on a read failure, [`StoreError::Json`] when a
    /// stored payload is not valid JSON, and
    /// [`StoreError::UnknownVocabulary`] when a row's `op` is outside the
    /// closed union.
    pub fn list_outbox_batch_run(
        &self,
        from_seq: i64,
        batch_id: &str,
    ) -> Result<Vec<OutboxEntry>, StoreError> {
        let mut stmt = self
            .conn
            .prepare(&format!("{OUTBOX_SELECT} AND seq >= ?1 ORDER BY seq ASC"))?;
        let mut rows = stmt.query(params![from_seq])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let entry = map_outbox(row)?;
            if entry.batch_id.as_deref() != Some(batch_id) {
                break;
            }
            out.push(entry);
        }
        Ok(out)
    }

    /// Delete every outbox entry whose `mutation_id` is in `ids`: the
    /// exactly-once clear after a confirmed push.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when a delete fails.
    pub fn clear_outbox_ids(&self, ids: &[String]) -> Result<(), StoreError> {
        for id in ids {
            self.conn.execute(
                "DELETE FROM _kizunasync_outbox WHERE mutation_id = ?1",
                params![id],
            )?;
        }
        Ok(())
    }
}
