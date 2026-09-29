use super::LocalStore;
use crate::error::StoreError;
use rusqlite::params;

/// How many pushed mutation ids [`LocalStore::record_pushed`] keeps: the newest
/// ones, so a conflict a pull delivers about a recent write of this device is
/// still recognised as its own.
pub const PUSHED_IDS_KEPT: u32 = 1000;

impl LocalStore {
    /// Remember `mutation_ids` as writes this device pushed and the server
    /// applied, keeping only the newest [`PUSHED_IDS_KEPT`]. An id recorded
    /// again counts as the newest. Runs inside the caller's transaction when
    /// there is one.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when an insert or the trim fails.
    pub fn record_pushed(&self, mutation_ids: &[&str], pushed_at: &str) -> Result<(), StoreError> {
        for mutation_id in mutation_ids {
            self.conn.execute(
                "INSERT OR REPLACE INTO _kizunasync_pushed(mutation_id, pushed_at) VALUES (?1, ?2)",
                params![mutation_id, pushed_at],
            )?;
        }
        // `INSERT OR REPLACE` gives a re-recorded id a new rowid, so rowid order is recording order.
        self.conn.execute(
            "DELETE FROM _kizunasync_pushed WHERE rowid NOT IN (
               SELECT rowid FROM _kizunasync_pushed ORDER BY rowid DESC LIMIT ?1
             )",
            params![PUSHED_IDS_KEPT],
        )?;
        Ok(())
    }

    /// Whether `mutation_id` is one of the writes [`Self::record_pushed`] keeps.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the lookup fails.
    pub fn was_pushed(&self, mutation_id: &str) -> Result<bool, StoreError> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(1) FROM _kizunasync_pushed WHERE mutation_id = ?1",
            params![mutation_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }
}
