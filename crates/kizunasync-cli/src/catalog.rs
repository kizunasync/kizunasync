//! Live reads over a connection string, for `init` and `sync`.
//!
//! Both commands introspect the developer's Postgres to propose synced tables,
//! and `sync` reads the synced set the project already carries. The reads go
//! through [`SchemaSource`] so tests inject fakes and production uses a
//! short-lived [`crate::pg::PgApplier`] per call.

use crate::applier::Applier;
use crate::config::{KizunaSyncConfig, load_config_from_db};
use crate::error::Result;
use crate::migration_history::{AppliedMigration, read_applied_migrations};
use crate::pg::PgApplier;
use crate::proposals::{SchemaCatalog, introspect_catalog};
use crate::provision::{LedgerRow, read_ledger_rows};
use crate::server_facts::{ServerFacts, read_server_facts};
use crate::verify::{Expectation, read_provisioning_gaps};

pub use crate::proposals::{SchemaCatalog as Catalog, proposals_from_catalog};

/// A read that owns everything it needs, so it can run on a thread of its own
/// that the caller stops waiting for.
pub type OwnedRead<T> = Box<dyn FnOnce() -> Result<T> + Send>;

/// Everything `init` and `sync` ask of a live database.
pub trait SchemaSource {
    /// Prove the connection answers, and say which server it reached.
    ///
    /// # Errors
    /// Returns [`Error::Db`](crate::error::Error::Db) when the database is
    /// unreachable or refuses the connection, and
    /// [`Error::Boundary`](crate::error::Error::Boundary) when the facts read
    /// does not carry the columns it selected.
    fn probe(&self, url: &str) -> Result<ServerFacts>;

    /// Base tables, policies, and columns in one schema.
    ///
    /// # Errors
    /// Returns [`Error::Db`](crate::error::Error::Db) when the schema name is
    /// not a valid identifier, when a query cannot run, or when a row does not
    /// carry the columns the read expects.
    fn introspect(&self, url: &str, schema: &str) -> Result<SchemaCatalog>;

    /// The synced-table contract this project already carries.
    ///
    /// # Errors
    /// Returns [`Error::Config`](crate::error::Error::Config) when
    /// `kizunasync._config` cannot be read.
    fn read_config(&self, url: &str) -> Result<KizunaSyncConfig>;

    /// Whether `pg_cron` is installed, which decides whether the pack's three
    /// retention jobs can be scheduled at all.
    ///
    /// # Errors
    /// Returns [`Error::Db`](crate::error::Error::Db) when the catalog cannot
    /// be read.
    fn pg_cron_present(&self, url: &str) -> Result<bool>;

    /// The migrations the database's migration history records, each version
    /// with its recorded name, empty when the Supabase CLI never pushed to it.
    ///
    /// # Errors
    /// Returns [`Error::Db`](crate::error::Error::Db) when the history cannot
    /// be read, and [`Error::Boundary`](crate::error::Error::Boundary) when a
    /// row does not carry the columns the read expects.
    fn applied_migrations(&self, url: &str) -> Result<Vec<AppliedMigration>>;

    /// [`Self::applied_migrations`] as an [`OwnedRead`]. The default reads at
    /// once, on the calling thread, which suits a source that answers from
    /// memory; a source that reads over the network returns the read itself.
    fn applied_migrations_owned(&self, url: &str) -> OwnedRead<Vec<AppliedMigration>> {
        let applied = self.applied_migrations(url);

        Box::new(move || applied)
    }

    /// The provision ledger's rows, which the pack is planned against; empty
    /// when the ledger does not exist yet.
    ///
    /// # Errors
    /// Returns [`Error::Db`](crate::error::Error::Db) when the ledger cannot
    /// be read, and [`Error::Provision`](crate::error::Error::Provision) when a
    /// ledger row does not carry the columns the read expects.
    fn ledger_rows(&self, url: &str) -> Result<Vec<LedgerRow>>;

    /// The applier that writes to this database, for a re-apply of the pack.
    /// Production opens a connection per call; tests hand back a fake.
    fn pack_applier(&self, url: &str) -> Box<dyn Applier + '_>;

    /// What the database lacks against `expected` once a run's migrations
    /// applied ([`crate::verify::provisioning_gaps`]), empty when it holds
    /// everything.
    ///
    /// # Errors
    /// Returns the transport's own failure, or a boundary error when a row
    /// does not carry the columns the pack defines.
    fn provisioning_gaps(&self, url: &str, expected: &Expectation) -> Result<Vec<String>>;
}

/// Production reads: one connection per call.
#[derive(Debug, Default, Clone, Copy)]
pub struct PgSchemaSource;

impl SchemaSource for PgSchemaSource {
    fn probe(&self, url: &str) -> Result<ServerFacts> {
        read_server_facts(&PgApplier::new(url))
    }

    fn introspect(&self, url: &str, schema: &str) -> Result<SchemaCatalog> {
        introspect_catalog(&PgApplier::new(url), schema)
    }

    fn read_config(&self, url: &str) -> Result<KizunaSyncConfig> {
        load_config_from_db(&PgApplier::new(url) as &dyn Applier)
    }

    fn pg_cron_present(&self, url: &str) -> Result<bool> {
        crate::provision::read_pg_cron_present(&PgApplier::new(url))
    }

    fn applied_migrations(&self, url: &str) -> Result<Vec<AppliedMigration>> {
        read_applied_migrations(&PgApplier::new(url))
    }

    fn applied_migrations_owned(&self, url: &str) -> OwnedRead<Vec<AppliedMigration>> {
        let applier = PgApplier::new(url);

        Box::new(move || read_applied_migrations(&applier))
    }

    fn ledger_rows(&self, url: &str) -> Result<Vec<LedgerRow>> {
        read_ledger_rows(&PgApplier::new(url))
    }

    fn pack_applier(&self, url: &str) -> Box<dyn Applier + '_> {
        Box::new(PgApplier::new(url))
    }

    fn provisioning_gaps(&self, url: &str, expected: &Expectation) -> Result<Vec<String>> {
        read_provisioning_gaps(&PgApplier::new(url), expected)
    }
}
