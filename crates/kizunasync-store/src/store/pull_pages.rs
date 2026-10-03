use super::LocalStore;
use crate::error::StoreError;
use rusqlite::params;

impl LocalStore {
    /// Append one page body to the in-progress checkpoint's page set. One
    /// insert per page: staging `n` pages costs `n` single-row writes, never a
    /// read-modify-write of a growing blob.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the write fails.
    pub fn insert_pull_page(&self, body: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO _kizunasync_pull_pages(body) VALUES (?1)",
            params![body],
        )?;
        Ok(())
    }

    /// Every staged page body, oldest first (`page_no` order): the
    /// in-progress checkpoint's page set, left for the caller to decode.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the query fails.
    pub fn list_pull_pages(&self) -> Result<Vec<String>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT body FROM _kizunasync_pull_pages ORDER BY page_no ASC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    /// Drop every staged page: the checkpoint committed, or the sequence was
    /// abandoned.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the delete fails.
    pub fn clear_pull_pages(&self) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM _kizunasync_pull_pages", [])?;
        Ok(())
    }
}
