//! The one error type the command surface carries.
//!
//! Every variant is a category a caller can branch on; the payload is the human
//! sentence the CLI prints.

/// A failure raised while running a command.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// A database connection, query, or script failed.
    #[error("{0}")]
    Db(String),
    /// The database answered a statement with an error, over a direct
    /// connection or relayed by the Management API.
    #[error("{text}")]
    Sql {
        /// The SQLSTATE the database gave it.
        sqlstate: String,
        /// The sentence the CLI prints, which names that SQLSTATE.
        text: String,
    },
    /// A response row (from Postgres or the Management API) did not carry the
    /// shape the caller asked for.
    #[error("{0}")]
    Boundary(String),
    /// A provisioning step (plan, apply, ledger read) failed loudly.
    #[error("{0}")]
    Provision(String),
    /// An HTTP call to the Management API or the Data API failed.
    #[error("{0}")]
    Transport(String),
    /// The project's own configuration record, `kizunasync._config` and
    /// `kizunasync._settings`, could not be read, or a command was asked for a
    /// synced table it cannot resolve.
    #[error("{0}")]
    Config(String),
    /// The shipped SQL pack could not be located or read.
    #[error("{0}")]
    Pack(String),
    /// The Supabase CLI could not be spawned, or ran and exited non-zero.
    #[error("{0}")]
    Cli(String),
    /// A built-in invariant broke: a compiled-in pattern that failed to
    /// compile, for instance. Surfaced instead of panicking so a user-facing
    /// path never aborts the process.
    #[error("{0}")]
    Internal(String),
}

impl Error {
    /// Whether the database refused a statement over a column (42703) or a
    /// table (42P01) it does not have.
    #[must_use]
    pub(crate) fn is_undefined_column_or_table(&self) -> bool {
        matches!(self, Self::Sql { sqlstate, .. } if matches!(sqlstate.as_str(), "42703" | "42P01"))
    }
}

/// Result alias for the command surface.
pub type Result<T> = std::result::Result<T, Error>;
