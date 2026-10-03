mod attachments;
mod dead_letter;
mod outbox;
mod overwrites;
mod pull_pages;
mod pushed;
mod rejections;
mod rows;
mod tombstones;

pub use pushed::PUSHED_IDS_KEPT;

use crate::VfsKind;
use crate::error::StoreError;
use crate::schema::{BOOTSTRAP_CURSOR, CURSOR_KEY, SCHEMA};
use crate::transaction::TransactionScope;
#[cfg(target_arch = "wasm32")]
use crate::wasm_vfs::BestVfs;
#[cfg(target_arch = "wasm32")]
use rusqlite::OpenFlags;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

/// A single `SQLite` local store: rows, outbox, tombstones, dead letters,
/// rejections, overwrites, attachments, the ids of pushed writes, and the
/// `_kizunasync_meta` bookkeeping table, opened over one connection.
///
/// `Send` and not `Sync` (it owns a `rusqlite::Connection`): one store serves
/// one thread at a time.
pub struct LocalStore {
    conn: Connection,
    kind: VfsKind,
}

impl LocalStore {
    /// Run `work` as ONE all-or-nothing store transaction (`BEGIN IMMEDIATE`).
    ///
    /// The transaction is ambient on the store's connection, so `work` calls the
    /// ordinary `&self` methods and no signature has to carry a handle. `work`
    /// may fail with any error that can hold a [`StoreError`] (a caller in
    /// another crate keeps its own error type), and any failure rolls the whole
    /// scope back.
    ///
    /// Synchronous by design: the scope opens and closes inside one call, never
    /// across an `await`, so it adds no lock an embedder could hold between
    /// calls (the engine thread in `kizunasync-napi` serializes calls anyway).
    ///
    /// NOT reentrant: `SQLite` refuses a transaction inside a transaction, so
    /// `work` must not call a method that opens its own ([`Self::apply`],
    /// [`Self::dead_letter`], [`Self::reset`]).
    ///
    /// # Errors
    ///
    /// Returns whatever `work` returns, or [`StoreError::Sqlite`] when the
    /// transaction cannot begin or commit.
    pub fn transaction<R, E>(&self, work: impl FnOnce() -> Result<R, E>) -> Result<R, E>
    where
        E: From<StoreError>,
    {
        let scope = TransactionScope::begin(&self.conn)?;
        let value = work()?;
        scope.commit()?;
        Ok(value)
    }

    /// Opens an in-memory `SQLite` database and applies the store schema.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when `SQLite` cannot open the database or the
    /// schema migration fails.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        Self::finish_open(conn, VfsKind::Memory)
    }

    /// Opens (or creates) the `SQLite` file at `path` and applies the store schema.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when `SQLite` cannot open the file or the schema
    /// migration fails.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open_path(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        Self::finish_open(conn, VfsKind::File)
    }

    /// Always fails on `wasm32`: installing a persistent VFS is asynchronous
    /// (OPFS access handles and `IndexedDB` reads are both async browser APIs),
    /// so a synchronous open cannot wait for it. Use [`Self::open_path_async`].
    ///
    /// # Errors
    ///
    /// Always returns [`StoreError::Unsupported`] on this target.
    #[cfg(target_arch = "wasm32")]
    pub fn open_path(_path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Err(StoreError::Unsupported(
            "wasm store: use open_path_async (the OPFS or IndexedDB VFS installs asynchronously)",
        ))
    }

    /// Opens (or creates) the `SQLite` database named `name` on the best
    /// persistent VFS the current context offers (OPFS synchronous-access-handle
    /// pool, then relaxed-durability `IndexedDB`) and applies the store schema.
    /// A browser that refuses the OPFS root directory itself gets the private
    /// store [`Self::open_in_memory`] opens instead.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::VfsBusy`] when the OPFS sahpool for `name` is
    /// still held by another browser context after ten install attempts
    /// (nine 200 ms waits between them, about 1.8 s total),
    /// [`StoreError::VfsUnavailable`] when neither persistent VFS is
    /// available at all (for example, outside a dedicated worker), or
    /// [`StoreError::Sqlite`] when `SQLite` cannot open the database or the
    /// schema migration fails.
    #[cfg(target_arch = "wasm32")]
    pub async fn open_path_async(name: &str) -> Result<Self, StoreError> {
        let (kind, vfs_name) = match crate::wasm_vfs::install_best_vfs(name).await? {
            BestVfs::Persistent { kind, vfs_name } => (kind, vfs_name),
            BestVfs::Memory => return Self::open_in_memory(),
        };
        let conn =
            Connection::open_with_flags_and_vfs(name, OpenFlags::default(), vfs_name.as_str())?;
        Self::finish_open(conn, kind)
    }

    /// Shared post-open setup for every constructor: the journal-mode pragma
    /// and the schema. Factored out so the wasm async opener cannot drift from
    /// what the native and in-memory openers run.
    fn finish_open(conn: Connection, kind: VfsKind) -> Result<Self, StoreError> {
        let store = Self { conn, kind };
        store.set_journal_mode()?;
        store.init()?;
        Ok(store)
    }

    /// Which VFS backs this connection.
    #[must_use]
    pub const fn kind(&self) -> VfsKind {
        self.kind
    }

    /// The backing connection, so a test can install a fault trigger and read
    /// the connection's transaction state.
    #[cfg(test)]
    pub(crate) const fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Journal mode is a persistent per-file property, so without setting it
    /// here a database created by this store would silently stay on the
    /// rollback journal, losing the reader/writer concurrency every other
    /// client file has.
    ///
    /// The pragma answers with the resulting mode instead of returning nothing, so
    /// it is a query; an in-memory database answers "memory". This
    /// return value is discarded, so a VFS that cannot honor WAL (the OPFS
    /// sahpool falls back to its own supported mode) succeeds the same way
    /// instead of erroring.
    fn set_journal_mode(&self) -> Result<(), StoreError> {
        let _: String = self
            .conn
            .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        Ok(())
    }

    fn init(&self) -> Result<(), StoreError> {
        self.conn.execute_batch(SCHEMA)?;
        self.add_missing_column("_kizunasync_attachments", "error_code", "TEXT")?;

        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM _kizunasync_meta WHERE key = ?1",
                params![CURSOR_KEY],
                |r| r.get(0),
            )
            .optional()?;
        match existing {
            Some(_) => {}
            None => {
                self.conn.execute(
                    "INSERT OR IGNORE INTO _kizunasync_meta(key, value) VALUES (?1, ?2)",
                    params![CURSOR_KEY, BOOTSTRAP_CURSOR],
                )?;
            }
        }
        Ok(())
    }

    /// Add `column` to `table` when the table predates it: `CREATE TABLE IF NOT
    /// EXISTS` leaves an existing table as it was.
    fn add_missing_column(&self, table: &str, column: &str, kind: &str) -> Result<(), StoreError> {
        let present: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
            params![table, column],
            |r| r.get(0),
        )?;
        if present == 0 {
            self.conn
                .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind}"))?;
        }
        Ok(())
    }

    /// Reads the sync cursor, defaulting to `"0"` on a fresh database.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the `_kizunasync_meta` row cannot be read.
    pub fn get_cursor(&self) -> Result<String, StoreError> {
        let v: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM _kizunasync_meta WHERE key = ?1",
                params![CURSOR_KEY],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.unwrap_or_else(|| BOOTSTRAP_CURSOR.to_string()))
    }

    /// Writes the sync cursor the next pull resumes from.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the `_kizunasync_meta` row cannot be written.
    pub fn set_cursor(&self, cursor: &str) -> Result<(), StoreError> {
        self.meta_set(CURSOR_KEY, cursor)
    }

    /// Reads a `_kizunasync_meta` value, defaulting to an empty string when `key`
    /// is absent.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the `_kizunasync_meta` row cannot be read.
    pub fn meta_get(&self, key: &str) -> Result<String, StoreError> {
        let v: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM _kizunasync_meta WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.unwrap_or_default())
    }

    /// Writes a `_kizunasync_meta` value, replacing any existing value for `key`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the `_kizunasync_meta` row cannot be written.
    pub fn meta_set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO _kizunasync_meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}
