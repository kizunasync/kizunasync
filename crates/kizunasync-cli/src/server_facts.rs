//! What a connection test reports: the server version, the database, and the
//! role the connection authenticated as.
//!
//! One read serves both transports (a direct Postgres connection and the
//! Management API's SQL endpoint), so every settled connection is proven the
//! same way and the user sees which database answered before anything is
//! asked of it.

use crate::applier::Applier;
use crate::error::{Error, Result};
use crate::row::require_string;

/// The facts a connection test reads back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerFacts {
    /// `server_version`, as the server reports it.
    pub version: String,
    /// `current_database()`.
    pub database: String,
    /// `current_user`.
    pub user: String,
}

impl ServerFacts {
    /// The one-line summary a connection test prints.
    #[must_use]
    pub fn describe(&self) -> String {
        format!(
            "PostgreSQL {}, database {} as {}",
            self.version, self.database, self.user
        )
    }
}

/// The one read behind [`read_server_facts`].
pub const SERVER_FACTS_QUERY: &str = "select current_setting('server_version') as version, current_database() as database, current_user as \"user\";";

/// Read the server facts over `applier`.
///
/// # Errors
/// Returns the transport's own failure, and [`Error::Boundary`] when the read
/// does not return exactly one row carrying the three text columns.
pub fn read_server_facts(applier: &dyn Applier) -> Result<ServerFacts> {
    let rows = applier.run_query(SERVER_FACTS_QUERY)?;
    if rows.len() != 1 {
        return Err(Error::Boundary(format!(
            "the server-facts probe returned {} rows, expected exactly 1",
            rows.len()
        )));
    }
    let Some(row) = rows.first() else {
        return Err(Error::Boundary(
            "the server-facts probe returned no row, expected exactly 1".to_owned(),
        ));
    };

    Ok(ServerFacts {
        version: require_string(row, "version")?,
        database: require_string(row, "database")?,
        user: require_string(row, "user")?,
    })
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::applier::fake::{FakeApplier, text_row};

    fn facts_row() -> Vec<crate::row::Row> {
        vec![text_row(&[
            ("version", "17.4"),
            ("database", "postgres"),
            ("user", "postgres"),
        ])]
    }

    #[test]
    fn the_facts_are_read_and_described_on_one_line() {
        let applier = FakeApplier::new().answer("server_version", facts_row());
        let facts = read_server_facts(&applier).unwrap();

        assert_eq!(
            facts.describe(),
            "PostgreSQL 17.4, database postgres as postgres"
        );
        assert_eq!(
            applier.executed.borrow().as_slice(),
            [SERVER_FACTS_QUERY.to_owned()]
        );
    }

    #[test]
    fn a_missing_column_is_a_boundary_error_naming_it() {
        let applier = FakeApplier::new().answer(
            "server_version",
            vec![text_row(&[("version", "17.4"), ("database", "postgres")])],
        );
        let error = read_server_facts(&applier).unwrap_err();

        assert!(matches!(error, Error::Boundary(_)), "{error:?}");
        assert!(error.to_string().contains("\"user\""), "{error}");
    }

    #[test]
    fn zero_rows_is_a_boundary_error() {
        let error = read_server_facts(&FakeApplier::new()).unwrap_err();

        assert!(matches!(error, Error::Boundary(_)), "{error:?}");
        assert!(error.to_string().contains("returned 0 rows"), "{error}");
    }

    #[test]
    fn a_transport_failure_is_returned_as_is() {
        let applier = FakeApplier::new().fail("server_version", "connection refused");
        let error = read_server_facts(&applier).unwrap_err();

        assert!(matches!(error, Error::Db(_)), "{error:?}");
    }
}
