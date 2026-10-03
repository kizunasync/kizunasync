//! The synced-table contract, read from the server that carries it.
//!
//! `kizunasync._config` (one row per synced table) and `kizunasync._settings`
//! (the single-row project settings) ARE the configuration record. There is no
//! configuration file: the migrations under `supabase/migrations` are the
//! reviewable declaration, and these two tables are what they provision.
//!
//! The read goes through the [`Applier`] port, so both transports answer it and
//! a test drives it with a scripted fake. An unreachable database is an error
//! and never an empty table set: "nothing is synced" and "we could not ask"
//! must not look alike.

use std::collections::BTreeMap;

use crate::applier::Applier;
use crate::commands::reconcile::earlier_build_step;
use crate::constants::{INTERNAL_CONFIG, INTERNAL_SETTINGS, SCHEMA};
use crate::error::{Error, Result};
use crate::row::{
    optional_bool, optional_number, optional_string, optional_string_array, require_string,
};

/// `conflict`'s documented default (P:verdict-completeness-transforms-and-conflict-rejection), applied when a `_config` row carries
/// no conflict mode.
const DEFAULT_CONFLICT: &str = "arrival";

/// The project-wide tombstone lifetime the pack seeds into
/// `_settings.tombstone_ttl_days`, and what a `_config` row inherits when its
/// own column is null.
pub const DEFAULT_TOMBSTONE_TTL_DAYS: i64 = 30;

/// The sync mode a table gets when nothing else decided one, the safe half of
/// the contract, and what a bare flag-driven add has always provisioned.
pub const DEFAULT_SYNC_MODE: &str = "pull-only";

/// The schema version a newly synced table starts at. The database is the
/// record, so what a row carries is what a re-render writes back.
pub const DEFAULT_MIN_SCHEMA_VERSION: i64 = 1;

/// Whether a newly synced table registers its clients. Off: the registry is
/// storage and per-client bookkeeping a project has not asked for until it
/// says so.
pub const DEFAULT_REGISTER_CLIENTS: bool = false;

/// The tombstone reaper's schedule, as the pack seeds it (UTC).
pub const DEFAULT_REAP_SCHEDULE: &str = "16 3 * * *";

/// The changelog compactor's schedule, as the pack seeds it (UTC).
pub const DEFAULT_COMPACT_SCHEDULE: &str = "47 3 * * *";

/// The client pruner's schedule, as the pack seeds it (UTC).
pub const DEFAULT_CLIENT_PRUNE_SCHEDULE: &str = "31 3 * * *";

/// Days of silence after which a client row is stale, as the pack seeds it.
pub const DEFAULT_CLIENT_TTL_DAYS: i64 = 90;

/// The forward-drift tolerance for an origin HLC, as the pack seeds it.
pub const DEFAULT_HLC_MAX_SKEW_MS: i64 = 5000;

/// The largest push a fresh install accepts, as the pack seeds it.
pub const DEFAULT_MAX_BATCH_SIZE: i64 = 500;

/// The candidates one pull page examines at most, as the pack seeds it.
pub const DEFAULT_MAX_PULL_SCAN: i64 = 5000;

/// The key column a `_config` row records when nothing wrote one, as the
/// pack's own column default declares it.
pub const DEFAULT_KEY_COLUMN: &str = "id";

/// [`DEFAULT_KEY_COLUMN`] as the key column list it stands for.
#[must_use]
pub fn default_key_columns() -> Vec<String> {
    vec![DEFAULT_KEY_COLUMN.to_owned()]
}

/// A bucket descriptor, narrowed to the column the provisioning SQL writes. The
/// `kind` (`byOwner` / `byColumn`) is authoring intent the runtime branches on,
/// not something `kizunasync._config` records.
#[derive(Debug, Clone)]
pub struct BucketSpec {
    /// The bucket column.
    pub column: String,
}

/// The largest push the server accepts, as a value rather than a number.
///
/// The pack's column is nullable and null IS a setting (unlimited), so a bare
/// `Option<i64>` would have to mean both "unlimited" and "this run says
/// nothing about it", which is exactly the confusion that reset a project's
/// policy on every re-apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaxBatchSize {
    /// No cap: `max_batch_size` is null.
    Unlimited,
    /// At most this many mutations per push.
    Mutations(i64),
}

impl MaxBatchSize {
    /// The literal the `_settings` column carries.
    #[must_use]
    pub fn as_sql(self) -> String {
        match self {
            Self::Unlimited => "null".to_owned(),
            Self::Mutations(size) => size.to_string(),
        }
    }

    /// The cap as a number, when there is one.
    #[must_use]
    pub const fn mutations(self) -> Option<i64> {
        match self {
            Self::Unlimited => None,
            Self::Mutations(size) => Some(size),
        }
    }
}

/// The single-row project settings: the push policy plus the retention knobs
/// and job schedules.
///
/// Every field is optional and `None` means one thing only: this run says
/// nothing about that column. That is what keeps an emitted `update` from
/// resetting a value the user never named, and what a live read fills in from
/// the row it found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectSettings {
    /// The largest push the server accepts.
    pub max_batch_size: Option<MaxBatchSize>,
    /// Whether a non-atomic push is rejected.
    pub require_atomic: Option<bool>,
    /// Crontab (UTC) for `kizunasync-reap-tombstones`.
    pub reap_schedule: Option<String>,
    /// Crontab (UTC) for `kizunasync-compact-changelog`.
    pub compact_schedule: Option<String>,
    /// Crontab (UTC) for `kizunasync-prune-clients`.
    pub client_prune_schedule: Option<String>,
    /// Days of silence after which a client row is pruned and its cursor stops
    /// holding the compaction floor.
    pub client_ttl_days: Option<i64>,
    /// Forward-drift tolerance for an origin HLC, in milliseconds.
    pub hlc_max_skew_ms: Option<i64>,
    /// The project-wide tombstone lifetime a `_config` row with no value of its
    /// own inherits.
    pub tombstone_ttl_days: Option<i64>,
    /// Candidates one pull page examines at most, the rows it withholds
    /// included.
    pub max_pull_scan: Option<i64>,
}

impl ProjectSettings {
    /// Every knob at the value the pack seeds: what the wizard preselects and
    /// what a project that has never been configured already behaves as.
    #[must_use]
    pub fn pack_defaults() -> Self {
        Self {
            max_batch_size: Some(MaxBatchSize::Mutations(DEFAULT_MAX_BATCH_SIZE)),
            require_atomic: Some(false),
            reap_schedule: Some(DEFAULT_REAP_SCHEDULE.to_owned()),
            compact_schedule: Some(DEFAULT_COMPACT_SCHEDULE.to_owned()),
            client_prune_schedule: Some(DEFAULT_CLIENT_PRUNE_SCHEDULE.to_owned()),
            client_ttl_days: Some(DEFAULT_CLIENT_TTL_DAYS),
            hlc_max_skew_ms: Some(DEFAULT_HLC_MAX_SKEW_MS),
            tombstone_ttl_days: Some(DEFAULT_TOMBSTONE_TTL_DAYS),
            max_pull_scan: Some(DEFAULT_MAX_PULL_SCAN),
        }
    }

    /// Whether this run declared anything at all. Nothing declared emits no
    /// `_settings` statement.
    #[must_use]
    pub const fn is_any_set(&self) -> bool {
        self.max_batch_size.is_some()
            || self.require_atomic.is_some()
            || self.reap_schedule.is_some()
            || self.compact_schedule.is_some()
            || self.client_prune_schedule.is_some()
            || self.client_ttl_days.is_some()
            || self.hlc_max_skew_ms.is_some()
            || self.tombstone_ttl_days.is_some()
            || self.max_pull_scan.is_some()
    }

    /// Whether a schedule column was declared, which is what makes the emitted
    /// SQL call `kizunasync._schedule_jobs()`.
    #[must_use]
    pub const fn declares_a_schedule(&self) -> bool {
        self.reap_schedule.is_some()
            || self.compact_schedule.is_some()
            || self.client_prune_schedule.is_some()
    }

    /// What the row carries after this run applies: a declared field wins, an
    /// undeclared one keeps whatever the project already has.
    #[must_use]
    pub fn merged_with(&self, live: Option<&Self>) -> Self {
        let live = live.cloned().unwrap_or_default();

        Self {
            max_batch_size: self.max_batch_size.or(live.max_batch_size),
            require_atomic: self.require_atomic.or(live.require_atomic),
            reap_schedule: self.reap_schedule.clone().or(live.reap_schedule),
            compact_schedule: self.compact_schedule.clone().or(live.compact_schedule),
            client_prune_schedule: self
                .client_prune_schedule
                .clone()
                .or(live.client_prune_schedule),
            client_ttl_days: self.client_ttl_days.or(live.client_ttl_days),
            hlc_max_skew_ms: self.hlc_max_skew_ms.or(live.hlc_max_skew_ms),
            tombstone_ttl_days: self.tombstone_ttl_days.or(live.tombstone_ttl_days),
            max_pull_scan: self.max_pull_scan.or(live.max_pull_scan),
        }
    }

    /// The columns of this declaration that differ from `live`. A wizard opens
    /// every step on the value the project already carries, so accepting them
    /// all has to write nothing at all.
    #[must_use]
    pub fn changed_from(&self, live: Option<&Self>) -> Self {
        let live = live.cloned().unwrap_or_default();

        Self {
            max_batch_size: changed(self.max_batch_size, live.max_batch_size.as_ref()),
            require_atomic: changed(self.require_atomic, live.require_atomic.as_ref()),
            reap_schedule: changed(self.reap_schedule.clone(), live.reap_schedule.as_ref()),
            compact_schedule: changed(
                self.compact_schedule.clone(),
                live.compact_schedule.as_ref(),
            ),
            client_prune_schedule: changed(
                self.client_prune_schedule.clone(),
                live.client_prune_schedule.as_ref(),
            ),
            client_ttl_days: changed(self.client_ttl_days, live.client_ttl_days.as_ref()),
            hlc_max_skew_ms: changed(self.hlc_max_skew_ms, live.hlc_max_skew_ms.as_ref()),
            tombstone_ttl_days: changed(self.tombstone_ttl_days, live.tombstone_ttl_days.as_ref()),
            max_pull_scan: changed(self.max_pull_scan, live.max_pull_scan.as_ref()),
        }
    }

    /// The same settings with every field this one leaves undeclared taken from
    /// `other`: how the wizard's sections each answer their own half of one
    /// declaration without clobbering the half answered before them.
    #[must_use]
    pub fn or(&self, other: &Self) -> Self {
        self.merged_with(Some(other))
    }
}

/// A declared column, when it says something the project does not already say.
fn changed<T: PartialEq>(declared: Option<T>, live: Option<&T>) -> Option<T> {
    declared.filter(|value| live != Some(value))
}

/// One table's sync contract, narrowed to what the Rust commands read.
#[derive(Debug, Clone)]
pub struct TableConfig {
    /// The sync mode (`pull-only` / `read-write`).
    pub sync: String,
    /// The bucket the table's rows are scoped by, when it has one.
    pub bucket: Option<BucketSpec>,
    /// The conflict mode, when recorded.
    pub conflict: Option<String>,
    /// When true, overwritten same-column values are recorded server-side.
    /// Default false; not on the wire (D-conflict-journal-visibility).
    pub conflict_journal: Option<bool>,
    /// The soft-delete column, when the table has one.
    pub soft_delete: Option<String>,
    /// When true, the pack records one `kizunasync._clients` row per client
    /// that pulls or pushes this table.
    pub register_clients: Option<bool>,
    /// The lowest client schema version this table's contract is valid for.
    pub min_schema_version: i64,
    /// How long this table's tombstones are retained, in days. `None` is the
    /// project default in `kizunasync._settings`, which is what the pack's
    /// reaper coalesces to.
    pub tombstone_ttl_days: Option<i64>,
    /// The primary key columns every change of this table is keyed by, in
    /// key order.
    pub key_columns: Vec<String>,
}

impl TableConfig {
    /// The conflict mode to provision: what was recorded, else the documented
    /// default.
    #[must_use]
    pub fn conflict(&self) -> &str {
        self.conflict.as_deref().unwrap_or(DEFAULT_CONFLICT)
    }

    /// Whether the server-side loser-value journal is on for this table.
    #[must_use]
    pub fn conflict_journal(&self) -> bool {
        self.conflict_journal.unwrap_or(false)
    }

    /// Whether the pack registers clients for this table.
    #[must_use]
    pub fn register_clients(&self) -> bool {
        self.register_clients.unwrap_or(DEFAULT_REGISTER_CLIENTS)
    }

    /// The bucket column, when the table has a bucket.
    #[must_use]
    pub fn bucket_column(&self) -> Option<&str> {
        self.bucket.as_ref().map(|bucket| bucket.column.as_str())
    }
}

/// The whole configuration record, narrowed to what the Rust commands read.
#[derive(Debug, Clone, Default)]
pub struct KizunaSyncConfig {
    /// Every synced table, keyed by name.
    pub tables: BTreeMap<String, TableConfig>,
    /// The project settings this run declares or read back.
    pub settings: Option<ProjectSettings>,
}

impl KizunaSyncConfig {
    /// The synced table names, sorted. The shared primitive `lint`, `mock`,
    /// `sync`, and `status` all key on.
    #[must_use]
    pub fn synced_tables(&self) -> Vec<String> {
        self.tables.keys().cloned().collect()
    }
}

/// Read the configuration record out of the project's own tables.
///
/// # Errors
/// Returns [`Error::Config`] when `kizunasync._config` cannot be read (an
/// unreachable database, or a project with no pack installed), and
/// [`Error::Boundary`] when a row does not carry the columns the pack defines.
pub fn load_config_from_db(applier: &dyn Applier) -> Result<KizunaSyncConfig> {
    Ok(KizunaSyncConfig {
        tables: load_synced_tables(applier)?,
        settings: read_settings(applier)?,
    })
}

/// The `kizunasync._config` half of [`load_config_from_db`]: every synced
/// table's contract, without the project settings.
///
/// # Errors
/// As [`load_config_from_db`].
pub fn load_synced_tables(applier: &dyn Applier) -> Result<BTreeMap<String, TableConfig>> {
    let rows = applier
        .run_query(&config_query())
        .map_err(|cause| Error::Config(unreadable_message(&cause)))?;
    let mut tables = BTreeMap::new();
    for row in &rows {
        tables.insert(
            require_string(row, "table_name")?,
            TableConfig {
                sync: optional_string(row, "sync_mode")?
                    .unwrap_or_else(|| DEFAULT_SYNC_MODE.to_owned()),
                bucket: optional_string(row, "bucket_column")?.map(|column| BucketSpec { column }),
                conflict: optional_string(row, "conflict_mode")?,
                conflict_journal: Some(optional_bool(row, "conflict_journal")?.unwrap_or(false)),
                soft_delete: optional_string(row, "soft_delete_column")?,
                register_clients: Some(
                    optional_bool(row, "register_clients")?.unwrap_or(DEFAULT_REGISTER_CLIENTS),
                ),
                min_schema_version: optional_number(row, "min_schema_version")?
                    .unwrap_or(DEFAULT_MIN_SCHEMA_VERSION),
                tombstone_ttl_days: optional_number(row, "tombstone_ttl_days")?,
                key_columns: optional_string_array(row, "key_columns")?
                    .unwrap_or_else(default_key_columns),
            },
        );
    }

    Ok(tables)
}

/// The message an unreadable `_config` prints: the transport's own failure,
/// then what makes it readable. A database that was never reached needs one
/// that is running, and the right one. A missing column or table (42703,
/// 42P01) is an installed pack that differs from this CLI's, which a re-apply
/// settles unless the tables come from an earlier build of the pack. Any other
/// error the server answered with speaks for itself.
#[must_use]
pub fn unreadable_message(cause: &Error) -> String {
    let remedy = match cause {
        Error::Db(_) => {
            "\n  start the local stack with `supabase start`, or point --db-url at the database this project is provisioned in.".to_owned()
        }
        Error::Sql { .. } if cause.is_undefined_column_or_table() => format!(
            "\n  the installed pack differs from this CLI's: `kizunasync upgrade --reapply --yes` re-applies it. If the re-apply fails the same way, {}",
            earlier_build_step(None)
        ),
        _ => String::new(),
    };

    format!("could not read {SCHEMA}.{INTERNAL_CONFIG}:\n    {cause}{remedy}")
}

/// `_settings` is one row the pack seeds, but a project provisioned before the
/// row existed can carry none, which is the pack's own defaults, not a failure.
/// An unreadable table IS a failure and travels as one.
fn read_settings(applier: &dyn Applier) -> Result<Option<ProjectSettings>> {
    let rows = applier
        .run_query(&settings_query())
        .map_err(|cause| Error::Config(unreadable_message(&cause)))?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };

    Ok(Some(ProjectSettings {
        max_batch_size: Some(
            optional_number(row, "max_batch_size")?
                .map_or(MaxBatchSize::Unlimited, MaxBatchSize::Mutations),
        ),
        require_atomic: Some(optional_bool(row, "require_atomic")?.unwrap_or(false)),
        reap_schedule: optional_string(row, "reap_schedule")?,
        compact_schedule: optional_string(row, "compact_schedule")?,
        client_prune_schedule: optional_string(row, "client_prune_schedule")?,
        client_ttl_days: optional_number(row, "client_ttl_days")?,
        hlc_max_skew_ms: optional_number(row, "hlc_max_skew_ms")?,
        tombstone_ttl_days: optional_number(row, "tombstone_ttl_days")?,
        max_pull_scan: optional_number(row, "max_pull_scan")?,
    }))
}

/// Every `_config` row, whole, in name order, which keeps a migration
/// rendered from this read byte-stable and lets a re-render keep what each
/// row already carries.
///
/// This read and [`settings_query`] select the whole row rather than a
/// column list: a column an older pack does not have then reads as absent
/// and takes its documented default, where naming it would fail the read.
pub(crate) fn config_query() -> String {
    format!("select * from {SCHEMA}.{INTERNAL_CONFIG} order by table_name;")
}

/// The single `_settings` row, whole, for the reason [`config_query`] gives.
pub(crate) fn settings_query() -> String {
    format!("select * from {SCHEMA}.{INTERNAL_SETTINGS};")
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::applier::fake::{FakeApplier, text_row};

    fn applier() -> FakeApplier {
        FakeApplier::new()
    }

    #[test]
    fn every_config_column_reaches_the_in_memory_contract() {
        let applier = applier()
            .answer(
                INTERNAL_CONFIG,
                vec![text_row(&[
                    ("table_name", "todos"),
                    ("sync_mode", "read-write"),
                    ("bucket_column", "user_id"),
                    ("soft_delete_column", "deleted_at"),
                    ("conflict_mode", "hlc"),
                    ("conflict_journal", "t"),
                    ("register_clients", "t"),
                    ("tombstone_ttl_days", "7"),
                    ("min_schema_version", "3"),
                    ("key_columns", "{owner_id,slug}"),
                ])],
            )
            .answer(
                INTERNAL_SETTINGS,
                vec![text_row(&[
                    ("max_batch_size", "50"),
                    ("require_atomic", "t"),
                    ("reap_schedule", "16 3 * * *"),
                    ("compact_schedule", "47 3 * * *"),
                    ("client_prune_schedule", "31 3 * * *"),
                    ("client_ttl_days", "90"),
                    ("hlc_max_skew_ms", "5000"),
                    ("tombstone_ttl_days", "30"),
                    ("max_pull_scan", "2500"),
                ])],
            );
        let config = load_config_from_db(&applier).unwrap();
        let todos = config.tables.get("todos").unwrap();
        let settings = config.settings.clone().unwrap();

        assert_eq!(config.synced_tables(), ["todos"]);
        assert_eq!(todos.sync, "read-write");
        assert_eq!(todos.bucket_column(), Some("user_id"));
        assert_eq!(todos.soft_delete.as_deref(), Some("deleted_at"));
        assert_eq!(todos.conflict(), "hlc");
        assert!(todos.conflict_journal());
        assert!(todos.register_clients());
        assert_eq!(todos.min_schema_version, 3);
        assert_eq!(todos.tombstone_ttl_days, Some(7));
        assert_eq!(todos.key_columns, ["owner_id", "slug"]);
        assert_eq!(settings.max_batch_size, Some(MaxBatchSize::Mutations(50)));
        assert_eq!(settings.require_atomic, Some(true));
        assert_eq!(settings.reap_schedule.as_deref(), Some("16 3 * * *"));
        assert_eq!(settings.compact_schedule.as_deref(), Some("47 3 * * *"));
        assert_eq!(
            settings.client_prune_schedule.as_deref(),
            Some("31 3 * * *")
        );
        assert_eq!(settings.client_ttl_days, Some(90));
        assert_eq!(settings.hlc_max_skew_ms, Some(5000));
        assert_eq!(settings.tombstone_ttl_days, Some(30));
        assert_eq!(settings.max_pull_scan, Some(2500));
    }

    #[test]
    fn both_reads_select_the_whole_row() {
        assert_eq!(
            config_query(),
            "select * from kizunasync._config order by table_name;"
        );
        assert_eq!(settings_query(), "select * from kizunasync._settings;");
    }

    /// A settings row an older pack wrote carries no `max_pull_scan`: the
    /// column reads as absent, and every other knob as the row holds it.
    #[test]
    fn a_settings_column_the_installed_pack_lacks_reads_as_absent() {
        let applier = applier().answer(
            INTERNAL_SETTINGS,
            vec![text_row(&[
                ("max_batch_size", "50"),
                ("client_ttl_days", "90"),
            ])],
        );
        let settings = load_config_from_db(&applier).unwrap().settings.unwrap();

        assert_eq!(settings.max_pull_scan, None);
        assert_eq!(settings.max_batch_size, Some(MaxBatchSize::Mutations(50)));
        assert_eq!(settings.client_ttl_days, Some(90));
        assert_eq!(settings.require_atomic, Some(false));
    }

    #[test]
    fn a_row_that_omits_the_optional_columns_takes_the_documented_defaults() {
        let applier = applier().answer(
            INTERNAL_CONFIG,
            vec![text_row(&[
                ("table_name", "notes"),
                ("sync_mode", "pull-only"),
            ])],
        );
        let config = load_config_from_db(&applier).unwrap();
        let notes = config.tables.get("notes").unwrap();

        assert_eq!(notes.min_schema_version, DEFAULT_MIN_SCHEMA_VERSION);
        assert_eq!(notes.conflict(), DEFAULT_CONFLICT);
        assert!(!notes.conflict_journal());
        assert!(!notes.register_clients());
        assert_eq!(notes.bucket_column(), None);
        assert_eq!(notes.soft_delete, None);
        assert_eq!(notes.key_columns, ["id"]);
    }

    /// The Management API hands `key_columns` over as a JSON array, the
    /// simple query protocol as an array literal; both read the same.
    #[test]
    fn the_recorded_key_reads_from_either_transport_and_a_malformed_one_fails() {
        let json = applier().answer(
            INTERNAL_CONFIG,
            vec![crate::applier::fake::row(&[
                ("table_name", serde_json::json!("seats")),
                ("key_columns", serde_json::json!(["hall", "seat"])),
            ])],
        );
        let malformed = applier().answer(
            INTERNAL_CONFIG,
            vec![text_row(&[
                ("table_name", "seats"),
                ("key_columns", "hall"),
            ])],
        );

        assert_eq!(
            load_config_from_db(&json).unwrap().tables["seats"].key_columns,
            ["hall", "seat"]
        );
        assert!(matches!(
            load_config_from_db(&malformed).unwrap_err(),
            Error::Boundary(_)
        ));
    }

    /// A null `_config.tombstone_ttl_days` is the project default, which the
    /// pack's reaper coalesces to. Reading it as a number would turn "inherit"
    /// into a value this table carries of its own.
    #[test]
    fn a_null_per_table_retention_stays_absent_rather_than_becoming_a_number() {
        let applier = applier().answer(
            INTERNAL_CONFIG,
            vec![text_row(&[
                ("table_name", "notes"),
                ("sync_mode", "pull-only"),
            ])],
        );
        let config = load_config_from_db(&applier).unwrap();

        assert_eq!(config.tables["notes"].tombstone_ttl_days, None);
    }

    #[test]
    fn the_tables_come_back_sorted_whatever_order_the_rows_arrived_in() {
        let applier = applier().answer(
            INTERNAL_CONFIG,
            vec![
                text_row(&[("table_name", "todos"), ("sync_mode", "read-write")]),
                text_row(&[("table_name", "notes"), ("sync_mode", "pull-only")]),
            ],
        );

        assert_eq!(
            load_config_from_db(&applier).unwrap().synced_tables(),
            ["notes", "todos"]
        );
    }

    #[test]
    fn a_project_with_no_synced_tables_reads_as_an_empty_set_not_a_failure() {
        let config = load_config_from_db(&applier()).unwrap();

        assert!(config.tables.is_empty());
        assert!(config.settings.is_none());
    }

    #[test]
    fn an_unreadable_config_table_names_the_cause_and_the_local_stack() {
        let applier = applier().fail(INTERNAL_CONFIG, "connection refused");
        let Error::Config(message) = load_config_from_db(&applier).unwrap_err() else {
            panic!("an unreadable config table is a config failure");
        };

        assert!(
            message.contains("could not read kizunasync._config"),
            "{message}"
        );
        assert!(message.contains("connection refused"), "{message}");
        assert!(message.contains("supabase start"), "{message}");
    }

    /// A column or a table the installed pack does not have is the pack
    /// differing from this CLI's: the message names the re-apply, then the
    /// fresh install for a re-apply that fails the same way. The database was
    /// reached, so the local stack is not named.
    #[test]
    fn a_missing_column_or_table_names_the_reapply_instead_of_the_local_stack() {
        for (sqlstate, text) in [
            ("42703", "42703: column \"max_pull_scan\" does not exist"),
            (
                "42P01",
                "42P01: relation \"kizunasync._settings\" does not exist",
            ),
        ] {
            let applier = applier().fail_sql(INTERNAL_CONFIG, sqlstate, text);
            let Error::Config(message) = load_config_from_db(&applier).unwrap_err() else {
                panic!("an unreadable config table is a config failure");
            };

            assert!(message.contains(text), "{message}");
            assert!(
                message.contains("the installed pack differs from this CLI's"),
                "{message}"
            );
            assert!(
                message.contains("`kizunasync upgrade --reapply --yes` re-applies it. If the re-apply fails the same way, the database holds kizunasync tables from an earlier build of the pack"),
                "{message}"
            );
            assert!(
                message.contains("`kizunasync deprovision --purge`"),
                "{message}"
            );
            assert!(message.contains("`kizunasync init`"), "{message}");
            assert!(!message.contains("supabase start"), "{message}");
            assert!(!message.contains("--db-url"), "{message}");
        }
    }

    /// Any other error the server answered with is printed as it came.
    #[test]
    fn another_sql_error_is_printed_without_a_remedy_it_does_not_need() {
        let text = "42501: permission denied for table _config";
        let applier = applier().fail_sql(INTERNAL_CONFIG, "42501", text);
        let Error::Config(message) = load_config_from_db(&applier).unwrap_err() else {
            panic!("an unreadable config table is a config failure");
        };

        assert!(message.contains(text), "{message}");
        assert!(!message.contains("supabase start"), "{message}");
        assert!(!message.contains("upgrade --reapply"), "{message}");
    }

    #[test]
    fn an_unreadable_settings_row_is_a_failure_not_a_permissive_default() {
        let applier = applier()
            .answer(
                INTERNAL_CONFIG,
                vec![text_row(&[
                    ("table_name", "todos"),
                    ("sync_mode", "read-write"),
                ])],
            )
            .fail(INTERNAL_SETTINGS, "permission denied");

        assert!(load_config_from_db(&applier).is_err());
    }

    /// The database is the record, so a version something else raised must
    /// survive the trip out and back: a re-render writes what the row carried,
    /// not the version a fresh table starts at.
    #[test]
    fn a_raised_min_schema_version_round_trips_through_the_render() {
        let applier = applier().answer(
            INTERNAL_CONFIG,
            vec![text_row(&[
                ("table_name", "todos"),
                ("sync_mode", "read-write"),
                ("tombstone_ttl_days", "30"),
                ("min_schema_version", "2"),
            ])],
        );
        let config = load_config_from_db(&applier).unwrap();

        assert_eq!(config.tables["todos"].min_schema_version, 2);
        assert!(
            crate::config_sql::render_config_sql(&config, crate::config_sql::CronGate::Optional)
                .contains("  'todos', 'read-write', null, null, 'arrival', false, false, 30, 2")
        );
    }

    /// Every other column in the loop propagates a shape we did not ask for, and
    /// the boolean ones are no exception: a journal flag that cannot be read
    /// would otherwise be written back out as `false` in the next migration.
    #[test]
    fn a_malformed_boolean_column_is_a_boundary_failure_not_a_false() {
        for column in ["conflict_journal", "register_clients"] {
            let applier = applier().answer(
                INTERNAL_CONFIG,
                vec![text_row(&[
                    ("table_name", "todos"),
                    ("sync_mode", "read-write"),
                    (column, "perhaps"),
                ])],
            );
            let Error::Boundary(message) = load_config_from_db(&applier).unwrap_err() else {
                panic!("a malformed boolean column is a boundary failure");
            };

            assert!(message.contains(column), "{message}");
        }
    }

    #[test]
    fn a_malformed_settings_boolean_is_a_boundary_failure_too() {
        let applier = applier()
            .answer(
                INTERNAL_CONFIG,
                vec![text_row(&[
                    ("table_name", "todos"),
                    ("sync_mode", "read-write"),
                ])],
            )
            .answer(
                INTERNAL_SETTINGS,
                vec![text_row(&[("require_atomic", "perhaps")])],
            );
        let Error::Boundary(message) = load_config_from_db(&applier).unwrap_err() else {
            panic!("a malformed settings boolean is a boundary failure");
        };

        assert!(message.contains("require_atomic"), "{message}");
    }

    #[test]
    fn a_row_without_a_table_name_is_a_boundary_failure() {
        let applier = applier().answer(
            INTERNAL_CONFIG,
            vec![text_row(&[("sync_mode", "read-write")])],
        );

        assert!(load_config_from_db(&applier).is_err());
    }

    // MARK: - the declared settings

    #[test]
    fn nothing_declared_is_nothing_to_emit() {
        let settings = ProjectSettings::default();

        assert!(!settings.is_any_set());
        assert!(!settings.declares_a_schedule());
    }

    #[test]
    fn a_declared_field_wins_and_an_undeclared_one_keeps_what_the_project_has() {
        let live = ProjectSettings {
            max_batch_size: Some(MaxBatchSize::Mutations(10)),
            require_atomic: Some(true),
            client_ttl_days: Some(90),
            ..ProjectSettings::default()
        };
        let declared = ProjectSettings {
            client_ttl_days: Some(30),
            ..ProjectSettings::default()
        };
        let merged = declared.merged_with(Some(&live));

        assert_eq!(merged.client_ttl_days, Some(30));
        assert_eq!(merged.max_batch_size, Some(MaxBatchSize::Mutations(10)));
        assert_eq!(merged.require_atomic, Some(true));
    }

    #[test]
    fn only_the_columns_that_differ_from_the_project_count_as_changed() {
        let live = ProjectSettings {
            max_batch_size: Some(MaxBatchSize::Unlimited),
            require_atomic: Some(false),
            reap_schedule: Some("16 3 * * *".to_owned()),
            ..ProjectSettings::default()
        };
        let accepted = live.clone();
        let edited = ProjectSettings {
            reap_schedule: Some("0 5 * * *".to_owned()),
            ..live.clone()
        };

        assert!(!accepted.changed_from(Some(&live)).is_any_set());
        let changed = edited.changed_from(Some(&live));
        assert_eq!(changed.reap_schedule.as_deref(), Some("0 5 * * *"));
        assert_eq!(changed.max_batch_size, None);
        assert_eq!(changed.require_atomic, None);
    }

    /// What the wizard opens on is what a fresh install carries: the pack
    /// seeds batches of at most 500 mutations and a scan cap of 5000.
    #[test]
    fn the_pack_defaults_are_what_a_fresh_install_seeds() {
        let defaults = ProjectSettings::pack_defaults();

        assert_eq!(defaults.max_batch_size, Some(MaxBatchSize::Mutations(500)));
        assert_eq!(defaults.max_pull_scan, Some(5000));
    }

    #[test]
    fn a_declared_scan_cap_is_merged_and_compared_like_every_other_knob() {
        let live = ProjectSettings {
            max_pull_scan: Some(5000),
            ..ProjectSettings::default()
        };
        let declared = ProjectSettings {
            max_pull_scan: Some(1000),
            ..ProjectSettings::default()
        };

        assert!(declared.is_any_set());
        assert_eq!(declared.merged_with(Some(&live)).max_pull_scan, Some(1000));
        assert_eq!(
            ProjectSettings::default()
                .merged_with(Some(&live))
                .max_pull_scan,
            Some(5000)
        );
        assert_eq!(declared.changed_from(Some(&live)).max_pull_scan, Some(1000));
        assert!(!live.changed_from(Some(&live)).is_any_set());
    }

    /// A project with no `_settings` row at all has nothing to compare against,
    /// so every answered column is a change.
    #[test]
    fn a_project_without_a_settings_row_counts_every_answer_as_changed() {
        let answered = ProjectSettings::pack_defaults();

        assert!(answered.changed_from(None).is_any_set());
    }
}
