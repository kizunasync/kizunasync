//! Shared Turso database connection used by every Kizuna engine host.
//!
//! Native callers run on the engine's own thread. Browser connections use
//! synchronous worker-local I/O after asynchronous storage initialization.

#![forbid(unsafe_code)]

#[cfg(target_arch = "wasm32")]
pub mod browser;
#[cfg(not(target_arch = "wasm32"))]
mod migration;
mod params;
mod row;

use std::marker::PhantomData;

pub use params::{Params, ToSql, params_from_iter};
pub use row::{FromValue, Row, RowIndex};

/// SQL value types accepted by the store.
pub mod types {
    pub use turso::Value;
}

/// A database or value-conversion failure.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Turso could not complete an operation.
    #[error(transparent)]
    Turso(#[from] turso::Error),
    /// No row matched a query expecting one result.
    #[error("query returned no rows")]
    QueryReturnedNoRows,
    /// A parameter or result has the wrong type or range.
    #[error("database value: {0}")]
    Value(String),
    /// A filesystem operation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// A browser storage operation failed.
    #[error("browser storage: {0}")]
    Browser(String),
}

/// Result of a local database operation.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(not(target_arch = "wasm32"))]
fn wait<T>(future: impl Future<Output = turso::Result<T>>) -> Result<T> {
    Ok(pollster::block_on(future)?)
}

#[cfg(target_arch = "wasm32")]
fn wait<T>(future: impl Future<Output = turso::Result<T>>) -> Result<T> {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::task::{Context, Poll, Wake, Waker};
    struct Notification(AtomicBool);
    impl Wake for Notification {
        fn wake(self: Arc<Self>) {
            self.0.store(true, Ordering::Release);
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.store(true, Ordering::Release);
        }
    }
    let notification = Arc::new(Notification(AtomicBool::new(false)));
    let waker = Waker::from(Arc::clone(&notification));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        notification.0.store(false, Ordering::Release);
        match future.as_mut().poll(&mut context) {
            Poll::Ready(result) => return Ok(result?),
            Poll::Pending if notification.0.load(Ordering::Acquire) => {}
            Poll::Pending => {
                return Err(Error::Browser(
                    "asynchronous I/O inside a synchronous store operation".into(),
                ));
            }
        }
    }
}

/// One Turso connection and the database that owns it.
pub struct Connection {
    conn: turso::Connection,
    _database: turso::Database,
    // A store transaction spans several statements and must have one owner.
    _single_owner: PhantomData<std::cell::Cell<()>>,
    #[cfg(not(target_arch = "wasm32"))]
    migration: Option<migration::Migration>,
    #[cfg(target_arch = "wasm32")]
    lease: Option<browser::Lease>,
}

impl Connection {
    /// Open an in-memory database.
    ///
    /// # Errors
    /// Returns a Turso initialization error.
    pub fn open_in_memory() -> Result<Self> {
        #[cfg(not(target_arch = "wasm32"))]
        let database = wait(turso::Builder::new_local(":memory:").build())?;
        #[cfg(target_arch = "wasm32")]
        let lease = browser::Lease::memory();
        #[cfg(target_arch = "wasm32")]
        let database = wait(
            turso::Builder::new_local("database")
                .with_io_impl(std::sync::Arc::new(browser::BrowserIo::new(lease.id())))
                .build(),
        )?;
        let conn = database.connect()?;
        Ok(Self {
            conn,
            _database: database,
            _single_owner: PhantomData,
            #[cfg(not(target_arch = "wasm32"))]
            migration: None,
            #[cfg(target_arch = "wasm32")]
            lease: Some(lease),
        })
    }

    /// Open a native database, preserving a pre-Turso snapshot before writes.
    ///
    /// # Errors
    /// Returns storage, exclusive-migration-lock or Turso errors.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        let path = path.as_ref();
        if path == std::path::Path::new(":memory:") {
            return Self::open_in_memory();
        }
        let migration = migration::Migration::prepare(path)?;
        let text = path
            .to_str()
            .ok_or_else(|| Error::Value("database path is not UTF-8".into()))?;
        let database = wait(turso::Builder::new_local(text).build())?;
        let conn = database.connect()?;
        Ok(Self {
            conn,
            _database: database,
            _single_owner: PhantomData,
            migration: Some(migration),
        })
    }

    /// Open persistent worker storage without shared WebAssembly memory.
    ///
    /// # Errors
    /// Returns browser access/locking errors or a Turso open error.
    #[cfg(target_arch = "wasm32")]
    pub async fn open_browser(
        name: &str,
        directory: &str,
        legacy_idb: &str,
    ) -> Result<(Self, u32)> {
        let (lease, kind) = browser::Lease::open(name, directory, legacy_idb).await?;
        let io = std::sync::Arc::new(browser::BrowserIo::new(lease.id()));
        let database = wait(
            turso::Builder::new_local("database")
                .with_io_impl(io)
                .build(),
        )?;
        let conn = database.connect()?;
        Ok((
            Self {
                conn,
                _database: database,
                _single_owner: PhantomData,
                lease: Some(lease),
            },
            kind,
        ))
    }

    /// Record successful schema initialization after a native migration.
    ///
    /// # Errors
    /// Returns an error if the readiness marker cannot be persisted.
    pub fn finish_migration(&self) -> Result<()> {
        #[cfg(not(target_arch = "wasm32"))]
        let verify = self
            .migration
            .as_ref()
            .is_some_and(migration::Migration::needs_verification);
        #[cfg(target_arch = "wasm32")]
        let verify = self
            .lease
            .as_ref()
            .is_some_and(browser::Lease::needs_verification);
        if verify {
            let mut statement = self.prepare("PRAGMA integrity_check")?;
            let mut rows = statement.query([])?;
            let mut checked = false;
            while let Some(row) = rows.next()? {
                let result: String = row.get(0)?;
                if result != "ok" {
                    return Err(Error::Value(format!(
                        "database integrity check failed: {result}"
                    )));
                }
                checked = true;
            }
            if !checked {
                return Err(Error::Value(
                    "database integrity check returned no result".into(),
                ));
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(migration) = &self.migration {
            migration.finish()?;
        }
        #[cfg(target_arch = "wasm32")]
        if let Some(lease) = &self.lease {
            lease.mark_ready()?;
        }
        Ok(())
    }

    /// Execute one statement and return its affected-row count.
    ///
    /// # Errors
    /// Returns binding or database errors.
    pub fn execute(&self, sql: &str, params: impl Params) -> Result<usize> {
        let mut statement = self.prepare(sql)?;
        statement.execute(params)
    }

    /// Execute a batch of SQL statements.
    ///
    /// # Errors
    /// Returns the first database error.
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        wait(self.conn.execute_batch(sql))
    }

    /// Prepare a statement, reusing Turso's bounded statement cache.
    ///
    /// # Errors
    /// Returns a SQL preparation error.
    pub fn prepare(&self, sql: &str) -> Result<Statement<'_>> {
        Ok(Statement {
            statement: wait(self.conn.prepare_cached(sql))?,
            _owner: PhantomData,
        })
    }

    /// Decode the first row of a query.
    ///
    /// # Errors
    /// Returns a database, conversion or no-row error.
    pub fn query_row<T>(
        &self,
        sql: &str,
        params: impl Params,
        decode: impl FnOnce(&Row<'_>) -> Result<T>,
    ) -> Result<T> {
        self.prepare(sql)?.query_row(params, decode)
    }

    /// Whether this connection has no active transaction.
    ///
    /// # Errors
    /// Returns a connection-state error.
    pub fn is_autocommit(&self) -> Result<bool> {
        Ok(self.conn.is_autocommit()?)
    }
}

/// A prepared Turso statement.
pub struct Statement<'connection> {
    statement: turso::Statement,
    _owner: PhantomData<&'connection Connection>,
}

impl Statement<'_> {
    /// Execute a prepared statement.
    ///
    /// # Errors
    /// Returns parameter or database errors.
    pub fn execute(&mut self, params: impl Params) -> Result<usize> {
        let count = wait(self.statement.execute(params.values()?))?;
        usize::try_from(count).map_err(|_| Error::Value("affected-row count exceeds usize".into()))
    }
    /// Start a query over a prepared statement.
    ///
    /// # Errors
    /// Returns parameter or database errors.
    pub fn query(&mut self, params: impl Params) -> Result<Rows<'_>> {
        Ok(Rows {
            cursor: wait(self.statement.query(params.values()?))?,
            current: None,
            _owner: PhantomData,
        })
    }
    /// Decode the first query row.
    ///
    /// # Errors
    /// Returns database, conversion or no-row errors.
    pub fn query_row<T>(
        &mut self,
        params: impl Params,
        decode: impl FnOnce(&Row<'_>) -> Result<T>,
    ) -> Result<T> {
        let mut rows = self.query(params)?;
        decode(rows.next()?.ok_or(Error::QueryReturnedNoRows)?)
    }
    /// Decode each query row as an iterator.
    ///
    /// # Errors
    /// Returns parameter or query-start errors.
    pub fn query_map<T, F: FnMut(&Row<'_>) -> Result<T>>(
        &mut self,
        params: impl Params,
        decode: F,
    ) -> Result<MappedRows<'_, T, F>> {
        Ok(MappedRows {
            rows: self.query(params)?,
            decode,
            marker: PhantomData,
        })
    }
}

/// A streaming result set, with at most one decoded row retained.
pub struct Rows<'connection> {
    cursor: turso::Rows,
    current: Option<Row<'static>>,
    _owner: PhantomData<&'connection Connection>,
}
impl Rows<'_> {
    /// Advance to the next row.
    ///
    /// # Errors
    /// Returns a database error.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Result<Option<&Row<'static>>> {
        self.current = wait(self.cursor.next())?.map(Row::new);
        Ok(self.current.as_ref())
    }
}

/// Iterator applying a caller's decoder to each result row.
pub struct MappedRows<'connection, T, F> {
    rows: Rows<'connection>,
    decode: F,
    marker: PhantomData<T>,
}
impl<T, F: FnMut(&Row<'_>) -> Result<T>> Iterator for MappedRows<'_, T, F> {
    type Item = Result<T>;
    fn next(&mut self) -> Option<Self::Item> {
        match self.rows.next() {
            Ok(Some(row)) => Some((self.decode)(row)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        }
    }
}

/// Convert a no-row result to an optional value.
pub trait OptionalExtension<T> {
    /// Return `None` only for a query that returned no rows.
    ///
    /// # Errors
    /// Preserves all other errors.
    fn optional(self) -> Result<Option<T>>;
}
impl<T> OptionalExtension<T> for Result<T> {
    fn optional(self) -> Result<Option<T>> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error),
        }
    }
}
