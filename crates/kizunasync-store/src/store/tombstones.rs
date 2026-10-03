use super::LocalStore;
use crate::error::StoreError;
use crate::schema::{BOOTSTRAP_CURSOR, CLIENT_ID_KEY, LAST_MUTATION_ID_KEY, ORIGIN_HLC_KEY};
use crate::transaction::TransactionScope;
use kizunasync_protocol::ColumnValues;
use rusqlite::params;

impl LocalStore {
    /// Upsert the authoritative row a pull carried and clear any tombstone
    /// shadow for it (a server row always wins over a local no-resurrection
    /// shadow).
    ///
    /// # Errors
    ///
    /// [`StoreError::Json`] when `columns` will not encode, or
    /// [`StoreError::Sqlite`] when a write fails.
    pub fn put_server_row(
        &self,
        table: &str,
        pk: &str,
        columns: &ColumnValues,
        seq: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO _kizunasync_rows(table_name, pk, row_json, deleted, updated_seq)
             VALUES (?1, ?2, ?3, 0, ?4)
             ON CONFLICT(table_name, pk) DO UPDATE SET
               row_json = excluded.row_json,
               deleted = 0,
               updated_seq = excluded.updated_seq",
            params![table, pk, serde_json::to_string(columns)?, seq],
        )?;
        self.conn.execute(
            "DELETE FROM _kizunasync_tombstones WHERE table_name = ?1 AND pk = ?2",
            params![table, pk],
        )?;
        Ok(())
    }

    /// Delete the committed row and record a server-sequenced tombstone at
    /// `seq` so a later re-pull cannot resurrect it.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when a write fails.
    pub fn apply_tombstone(
        &self,
        table: &str,
        pk: &str,
        seq: &str,
        now: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM _kizunasync_rows WHERE table_name = ?1 AND pk = ?2",
            params![table, pk],
        )?;
        self.conn.execute(
            "INSERT INTO _kizunasync_tombstones(table_name, pk, seq, deleted_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(table_name, pk) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at",
            params![table, pk, seq, now],
        )?;
        Ok(())
    }

    /// Hard-remove the committed row WITHOUT a no-resurrection shadow: the row is
    /// not part of the fresh snapshot a `CHECKPOINT_EXPIRED` rehydration
    /// commits, driven by the snapshot-replace path in `kizunasync-engine`'s pull
    /// module. A compensating revert wants `revert_row(None)` instead, because
    /// that one MUST leave the shadow behind.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the delete fails.
    pub fn delete_row(&self, table: &str, pk: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM _kizunasync_rows WHERE table_name = ?1 AND pk = ?2",
            params![table, pk],
        )?;
        Ok(())
    }

    /// Compensating revert of a client-local write: `None` deletes the row and
    /// leaves a client-local no-resurrection shadow ([`Self::delete_row`]'s
    /// counterpart), `Some` restores the given pre-image as the committed row.
    ///
    /// # Errors
    ///
    /// [`StoreError::Json`] when `pre_image` will not encode, or
    /// [`StoreError::Sqlite`] when a write fails.
    pub fn revert_row(
        &self,
        table: &str,
        pk: &str,
        pre_image: Option<&ColumnValues>,
    ) -> Result<(), StoreError> {
        match pre_image {
            None => {
                // The row must not exist AND must not be resurrected by a later
                // local write, so the delete carries the no-resurrection shadow.
                // seq '0' with no `deleted_at`: a compensating revert is
                // client-local, never server-sequenced.
                self.conn.execute(
                    "DELETE FROM _kizunasync_rows WHERE table_name = ?1 AND pk = ?2",
                    params![table, pk],
                )?;
                self.conn.execute(
                    "INSERT INTO _kizunasync_tombstones(table_name, pk, seq, deleted_at)
                     VALUES (?1, ?2, '0', NULL)
                     ON CONFLICT(table_name, pk) DO UPDATE SET
                       seq = excluded.seq,
                       deleted_at = excluded.deleted_at",
                    params![table, pk],
                )?;
            }
            Some(cols) => {
                self.put_server_row(table, pk, cols, "0")?;
            }
        }
        Ok(())
    }

    /// Whether `table`/`pk` carries a tombstone (deleted, live, or a
    /// client-local no-resurrection shadow).
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the count cannot be read.
    pub fn has_tombstone(&self, table: &str, pk: &str) -> Result<bool, StoreError> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(1) FROM _kizunasync_tombstones WHERE table_name = ?1 AND pk = ?2",
            params![table, pk],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// The exactly-once push watermark, or `None` before the first applied verdict.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the `_kizunasync_meta` row cannot be read.
    pub fn last_mutation_id(&self) -> Result<Option<String>, StoreError> {
        let value = self.meta_get(LAST_MUTATION_ID_KEY)?;
        Ok(if value.is_empty() { None } else { Some(value) })
    }

    /// Writes the exactly-once push watermark.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the `_kizunasync_meta` row cannot be written.
    pub fn set_last_mutation_id(&self, mutation_id: &str) -> Result<(), StoreError> {
        self.meta_set(LAST_MUTATION_ID_KEY, mutation_id)
    }

    /// Wipe every local table and re-seed the bootstrap meta, returning the
    /// sandboxed attachment paths that existed before the wipe so the caller can
    /// delete the bytes (this store has no file port). The overwrite journal is
    /// part of the same wipe: leaving it would report conflicts for rows that no
    /// longer exist. So are the pushed mutation ids, which belong to the
    /// device's previous life. The origin HLC ([`ORIGIN_HLC_KEY`]) is written back after
    /// the meta wipe: the device starts over, its clock does not. `client_id`
    /// becomes the kept identity ([`CLIENT_ID_KEY`]), so the device also starts
    /// over as a new client. The wipe and the bootstrap re-seed commit as one
    /// transaction, so a failing statement leaves the store as it was.
    ///
    /// `schema_version` selects which schema this call re-seeds; the current
    /// schema has a single version, so the value is not read.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the path scan, the wipe, or the bootstrap
    /// re-seed fails.
    pub fn reset(&self, _schema_version: i64, client_id: &str) -> Result<Vec<String>, StoreError> {
        let paths = {
            let mut stmt = self.conn.prepare(
                "SELECT local_path FROM _kizunasync_attachments WHERE local_path IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<String>, rusqlite::Error>>()?
        };

        let tx = TransactionScope::begin(&self.conn)?;
        let origin_hlc = self.meta_get(ORIGIN_HLC_KEY)?;
        self.conn.execute_batch(
            "DELETE FROM _kizunasync_rows;
             DELETE FROM _kizunasync_outbox;
             DELETE FROM _kizunasync_tombstones;
             DELETE FROM _kizunasync_dead_letter;
             DELETE FROM _kizunasync_rejections;
             DELETE FROM _kizunasync_overwrites;
             DELETE FROM _kizunasync_attachments;
             DELETE FROM _kizunasync_pull_pages;
             DELETE FROM _kizunasync_pushed;
             DELETE FROM _kizunasync_meta;",
        )?;
        self.set_cursor(BOOTSTRAP_CURSOR)?;
        if !origin_hlc.is_empty() {
            self.meta_set(ORIGIN_HLC_KEY, &origin_hlc)?;
        }
        self.meta_set(CLIENT_ID_KEY, client_id)?;
        tx.commit()?;
        Ok(paths)
    }
}
