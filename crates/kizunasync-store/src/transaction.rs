use crate::error::StoreError;
use rusqlite::Connection;

/// A `BEGIN IMMEDIATE` scope that rolls back unless it is committed.
///
/// `rusqlite::Connection::transaction` needs `&mut Connection` while every store
/// method takes `&self`, so the scope is driven by raw statements instead. `Drop`
/// is the safety net: an early return, a `?`, or an unwind releases the guard and
/// the partial write is undone.
pub(crate) struct TransactionScope<'a> {
    conn: &'a Connection,
    committed: bool,
}

impl<'a> TransactionScope<'a> {
    /// Opens the scope with `BEGIN IMMEDIATE`, taking the write lock up front
    /// rather than at the first write.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the transaction cannot begin, which includes
    /// another connection already holding the write lock.
    pub(crate) fn begin(conn: &'a Connection) -> Result<Self, StoreError> {
        conn.execute("BEGIN IMMEDIATE", [])?;
        Ok(Self {
            conn,
            committed: false,
        })
    }

    /// Commits the scope and disarms the rollback in [`Drop`].
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the commit fails, after which `Drop` still
    /// rolls the scope back.
    pub(crate) fn commit(mut self) -> Result<(), StoreError> {
        self.conn.execute("COMMIT", [])?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for TransactionScope<'_> {
    fn drop(&mut self) {
        if !self.committed {
            // A failing rollback leaves nothing to do and nothing to report from
            // `Drop`: either the connection already left the transaction (the
            // COMMIT that failed) or it is unusable, and the caller is already
            // carrying the original error.
            let _ = self.conn.execute("ROLLBACK", []);
        }
    }
}
