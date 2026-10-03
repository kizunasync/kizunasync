//! Which tables to propose syncing: the vocabulary, and the reads that answer it.
//!
//! `init` never asks a human to enumerate their schema. It reads the project's
//! own catalog and RLS policies and proposes a synced-table set from them: the
//! column an `auth.uid()` policy keys on IS the owner bucket, so a table whose
//! RLS already scopes rows to a user needs no further explanation. A foreign key
//! to `auth.users` is the fallback when no policy names an owner. Every proposal
//! carries an `[auto]` provenance note ([`TableProposal::provenance`]) so the
//! human reading the plan can see why it was proposed.
//!
//! A proposal is what the wizard answers on top of and what
//! [`build_table_config`] resolves into the contract
//! [`crate::config_sql`] provisions, so an inferred default and an answered one
//! travel the same path into `kizunasync._config`.
//!
//! The reads go through the [`Applier`] port rather than a connection, which is
//! what lets the whole wizard run in a test with no database. The catalog carries
//! tables, policies, columns, and foreign keys to `auth.users`: recommended
//! settings still derive from RLS first, and the customize ladder uses the
//! column list for soft-delete.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::applier::Applier;
use crate::config::default_key_columns;
use crate::db::{
    auth_user_fk_query, columns_query, is_valid_schema_name, policies_query, primary_keys_query,
    rls_disabled_query, tables_query,
};
use crate::error::{Error, Result};
use crate::row::{Row, optional_string, require_string};

// MARK: - the proposal vocabulary

/// One table's sync contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    /// Pulled, but a push targeting it is rejected server-side.
    PullOnly,
    /// Bidirectional.
    ReadWrite,
}

impl SyncMode {
    /// The literal `kizunasync._config.sync_mode` carries.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PullOnly => "pull-only",
            Self::ReadWrite => "read-write",
        }
    }
}

/// One table's conflict resolution mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictMode {
    /// Column-LWW by server arrival order (the default).
    Arrival,
    /// Column-LWW keyed on the origin HLC.
    Hlc,
}

impl ConflictMode {
    /// The literal `kizunasync._config.conflict_mode` carries.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Arrival => "arrival",
            Self::Hlc => "hlc",
        }
    }
}

/// A bucket spec, carrying the authoring intent the runtime branches on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bucket {
    /// The owner equality RLS keys on.
    ByOwner(String),
    /// A runtime-parameterized tenant column.
    ByColumn(String),
}

impl Bucket {
    /// The column the bucket scopes rows by.
    #[must_use]
    pub fn column(&self) -> &str {
        match self {
            Self::ByOwner(column) | Self::ByColumn(column) => column,
        }
    }
}

/// The bucket decision for one table. A kind never travels without its column,
/// so "answered, but with what?" is unrepresentable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum BucketAnswer {
    /// Unanswered: fall back to the inferred owner column, if there is one.
    #[default]
    Inferred,
    /// Explicitly no bucket, even when an owner was inferred.
    Omitted,
    /// An answered bucket, which wins over the inferred owner.
    Answered(Bucket),
}

/// One synced-table proposal: what introspection derived, plus whatever the
/// wizard answered on top of it. Build with [`TableProposal::derived`] and
/// override the answered fields through struct-update syntax.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableProposal {
    /// The table name.
    pub table: String,
    /// The owner/tenant column an RLS policy keys on, if one was inferred.
    pub owner_column: Option<String>,
    /// The `[auto]` note recorded as provenance in the plan.
    pub provenance: String,
    /// An answered sync mode; absent falls back to the owner inference.
    pub sync: Option<SyncMode>,
    /// The bucket decision.
    pub bucket: BucketAnswer,
    /// An answered conflict mode; absent falls back to the documented default.
    pub conflict: Option<ConflictMode>,
    /// Whether the server-side loser-value journal is on.
    pub conflict_journal: bool,
    /// Whether the pack registers one client row per client that syncs this
    /// table.
    pub register_clients: bool,
    /// An answered lowest client schema version; absent starts at the
    /// documented one.
    pub min_schema_version: Option<i64>,
    /// An answered tombstone retention in days; absent inherits the project's.
    pub tombstone_ttl_days: Option<i64>,
    /// The soft-delete column, when the table has one.
    pub soft_delete: Option<String>,
    /// The table's primary key as the catalog read it, `None` until a catalog
    /// read one.
    pub key: Option<PrimaryKey>,
}

impl TableProposal {
    /// A proposal carrying only what introspection derived, with no answers.
    #[must_use]
    pub fn derived(table: &str, owner_column: Option<&str>, provenance: &str) -> Self {
        Self {
            table: table.to_owned(),
            owner_column: owner_column.map(ToOwned::to_owned),
            provenance: provenance.to_owned(),
            sync: None,
            bucket: BucketAnswer::Inferred,
            conflict: None,
            conflict_journal: false,
            register_clients: false,
            min_schema_version: None,
            tombstone_ttl_days: None,
            soft_delete: None,
            key: None,
        }
    }

    /// The same proposal carrying the primary key `catalog` holds for its
    /// table.
    #[must_use]
    pub fn keyed_from(self, catalog: &SchemaCatalog) -> Self {
        Self {
            key: catalog.primary_keys.get(&self.table).cloned(),
            ..self
        }
    }

    /// The columns `kizunasync._config.key_columns` records for the table: its
    /// primary key's, in key order, or the pack's own default for a table no
    /// catalog read, which the push then refuses as it refuses a missing
    /// table.
    #[must_use]
    pub fn key_columns(&self) -> Vec<String> {
        self.key
            .as_ref()
            .map_or_else(default_key_columns, PrimaryKey::column_names)
    }
}

/// A proposal with every undecided field resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableConfigDraft {
    /// The sync mode.
    pub sync: SyncMode,
    /// The bucket, when the table has one.
    pub bucket: Option<Bucket>,
    /// The conflict mode, when one was answered.
    pub conflict: Option<ConflictMode>,
    /// Whether the server-side loser-value journal is on.
    pub conflict_journal: bool,
    /// Whether the pack registers one client row per client that syncs this
    /// table.
    pub register_clients: bool,
    /// An answered lowest client schema version; absent starts at the
    /// documented one.
    pub min_schema_version: Option<i64>,
    /// An answered tombstone retention in days; absent inherits the project's.
    pub tombstone_ttl_days: Option<i64>,
    /// The soft-delete column, when the table has one.
    pub soft_delete: Option<String>,
}

/// Resolve one proposal into what will be provisioned. Undecided fields fall
/// back to the owner inference: an owner means `read-write` + a byOwner bucket,
/// no owner means `pull-only` and nothing else.
#[must_use]
pub fn build_table_config(proposal: &TableProposal) -> TableConfigDraft {
    let inferred_sync = if proposal.owner_column.is_some() {
        SyncMode::ReadWrite
    } else {
        SyncMode::PullOnly
    };

    TableConfigDraft {
        sync: proposal.sync.unwrap_or(inferred_sync),
        bucket: resolve_bucket(proposal),
        conflict: proposal.conflict,
        conflict_journal: proposal.conflict_journal,
        register_clients: proposal.register_clients,
        min_schema_version: proposal.min_schema_version,
        tombstone_ttl_days: proposal.tombstone_ttl_days,
        soft_delete: proposal.soft_delete.clone(),
    }
}

/// An answered bucket wins; `Omitted` refuses one outright; unanswered falls
/// back to the inferred owner column.
fn resolve_bucket(proposal: &TableProposal) -> Option<Bucket> {
    match &proposal.bucket {
        BucketAnswer::Omitted => None,
        BucketAnswer::Answered(bucket) => Some(bucket.clone()),
        BucketAnswer::Inferred => proposal
            .owner_column
            .as_deref()
            .map(|column| Bucket::ByOwner(column.to_owned())),
    }
}

// MARK: - the catalog

/// One `pg_policies` row: the table it applies to and its USING expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyRow {
    /// The table the policy is attached to.
    pub table: String,
    /// The policy's USING expression, empty when it has none.
    pub qual: String,
}

/// One column of a catalogued table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnInfo {
    /// The column name.
    pub name: String,
    /// `information_schema.columns.data_type`.
    pub data_type: String,
}

/// The types a key column may have. Each renders the same text on the device
/// and on the server, so a pk computed on either side names the same row
/// (@packages/protocol/decisions/D-row-key.md).
pub const KEY_COLUMN_TYPES: [&str; 6] = [
    "uuid",
    "text",
    "character varying",
    "smallint",
    "integer",
    "bigint",
];

/// The one key default a device reproduces on its own: any uuid it mints is as
/// good as the server's.
const MINTED_UUID_DEFAULT: &str = "gen_random_uuid()";

/// How an identity column fills itself in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Identity {
    /// `generated always as identity`: the database refuses a supplied value.
    Always,
    /// `generated by default as identity`: the sequence fills a value the
    /// insert left out.
    ByDefault,
}

/// One column of a table's primary key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyColumn {
    /// The column name.
    pub name: String,
    /// The declared type as `format_type` spells it, modifier included.
    pub data_type: String,
    /// The type under every domain, without its modifier: what
    /// [`KEY_COLUMN_TYPES`] is matched against.
    pub base_type: String,
    /// The identity the column is generated as, if any.
    pub identity: Option<Identity>,
    /// The column default as `pg_get_expr` renders it, if any.
    pub default: Option<String>,
}

impl KeyColumn {
    /// Whether the pack can key a row by this column.
    #[must_use]
    pub fn is_keyable(&self) -> bool {
        KEY_COLUMN_TYPES.contains(&self.base_type.as_str())
    }

    /// Whether the database fills this column in when an insert leaves it
    /// out, with a value a device offline cannot know: an identity by default,
    /// a serial or any other default except a minted uuid.
    #[must_use]
    pub fn has_database_default(&self) -> bool {
        self.identity == Some(Identity::ByDefault)
            || self
                .default
                .as_deref()
                .is_some_and(|expression| expression != MINTED_UUID_DEFAULT)
    }

    /// The column as a reader names it: `amount numeric`.
    #[must_use]
    pub fn describe(&self) -> String {
        format!("{} {}", self.name, self.data_type)
    }
}

/// A table's primary key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimaryKey {
    /// The constraint's name.
    pub constraint: String,
    /// The key's columns in key order.
    pub columns: Vec<KeyColumn>,
}

impl PrimaryKey {
    /// The key's column names, in key order.
    #[must_use]
    pub fn column_names(&self) -> Vec<String> {
        self.columns
            .iter()
            .map(|column| column.name.clone())
            .collect()
    }

    /// The key as a reader names it: `(user_id uuid, geoname_id bigint)`.
    #[must_use]
    pub fn describe(&self) -> String {
        let columns: Vec<String> = self.columns.iter().map(KeyColumn::describe).collect();

        format!("({})", columns.join(", "))
    }

    /// The key columns whose type the pack cannot key a row by.
    #[must_use]
    pub fn unkeyable_columns(&self) -> Vec<&KeyColumn> {
        self.columns
            .iter()
            .filter(|column| !column.is_keyable())
            .collect()
    }

    /// The key columns generated always as identity, which no device can
    /// supply a value for.
    #[must_use]
    pub fn generated_always_columns(&self) -> Vec<&KeyColumn> {
        self.columns
            .iter()
            .filter(|column| column.identity == Some(Identity::Always))
            .collect()
    }

    /// The key columns [`KeyColumn::has_database_default`] names.
    #[must_use]
    pub fn defaulted_columns(&self) -> Vec<&KeyColumn> {
        self.columns
            .iter()
            .filter(|column| column.has_database_default())
            .collect()
    }
}

/// `items` as a sentence lists them: `a`, `a and b`, `a, b, and c`.
pub(crate) fn listed(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [only] => only.clone(),
        [first, second] => format!("{first} and {second}"),
        [init @ .., last] => format!("{}, and {last}", init.join(", ")),
    }
}

/// Key columns as a reader names them: `id`, or `(hall, seat)` for a key of
/// several.
#[must_use]
pub fn describe_key_columns(columns: &[String]) -> String {
    match columns {
        [only] => only.clone(),
        _ => format!("({})", columns.join(", ")),
    }
}

/// A read-only snapshot of one schema, as the derivation below consumes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SchemaCatalog {
    /// Base table names, in catalog order.
    pub tables: Vec<String>,
    /// Every policy in the schema.
    pub policies: Vec<PolicyRow>,
    /// Columns keyed by table name, catalog order within each table.
    pub columns: BTreeMap<String, Vec<ColumnInfo>>,
    /// One column per table that references `auth.users`.
    ///
    /// The preferred name is `user_id`, then `owner_id`, then `id`, then the
    /// first foreign-key column in catalog order. [`proposals_from_catalog`]
    /// uses it only when no RLS policy already named an owner.
    pub auth_user_fks: BTreeMap<String, String>,
    /// Base tables whose row level security is disabled.
    pub rls_disabled: BTreeSet<String>,
    /// Each table's primary key; a table with none has no entry.
    pub primary_keys: BTreeMap<String, PrimaryKey>,
}

#[cfg(test)]
impl SchemaCatalog {
    /// The same catalog, every table in it keyed by a uuid column named `id`.
    pub(crate) fn keyed_by_uuid_id(mut self) -> Self {
        for table in &self.tables {
            self.primary_keys.insert(
                table.clone(),
                PrimaryKey::of(&format!("{table}_pkey"), &[("id", "uuid")]),
            );
        }

        self
    }
}

#[cfg(test)]
impl PrimaryKey {
    /// A key named `constraint` over `columns`, each a name and its type,
    /// none of them an identity or defaulted.
    pub(crate) fn of(constraint: &str, columns: &[(&str, &str)]) -> Self {
        Self::over(
            constraint,
            columns
                .iter()
                .map(|(name, data_type)| KeyColumn::plain(name, data_type))
                .collect(),
        )
    }

    /// A key named `constraint` over `columns`.
    pub(crate) fn over(constraint: &str, columns: Vec<KeyColumn>) -> Self {
        Self {
            constraint: constraint.to_owned(),
            columns,
        }
    }
}

#[cfg(test)]
impl KeyColumn {
    /// A column of `data_type`, its own base type, with no identity and no
    /// default.
    pub(crate) fn plain(name: &str, data_type: &str) -> Self {
        Self {
            name: name.to_owned(),
            data_type: data_type.to_owned(),
            base_type: data_type.to_owned(),
            identity: None,
            default: None,
        }
    }

    /// The same column generated as `identity`.
    pub(crate) fn generated(self, identity: Identity) -> Self {
        Self {
            identity: Some(identity),
            ..self
        }
    }

    /// The same column defaulting to `expression`.
    pub(crate) fn defaulting(self, expression: &str) -> Self {
        Self {
            default: Some(expression.to_owned()),
            ..self
        }
    }

    /// The same column, declared as a domain over `base_type`.
    pub(crate) fn over_base(self, base_type: &str) -> Self {
        Self {
            base_type: base_type.to_owned(),
            ..self
        }
    }
}

/// The schema every synced table lives in: the pack addresses `public.<table>`
/// in every trigger and RPC, so it is the only value `--schema` accepts.
pub const PREFERRED_SCHEMA: &str = "public";

/// The schema's policies, for the non-interactive path's proposals.
///
/// # Errors
/// Returns [`Error::Db`] when the schema name is not a
/// valid identifier, the query cannot run, or a policy's table name carries a
/// control character, and [`Error::Boundary`] when a row does not carry the
/// columns the read expects.
pub fn read_policy_rows(applier: &dyn Applier, schema: &str) -> Result<Vec<PolicyRow>> {
    let rows = applier.run_query(&policies_query(schema)?)?;
    let mut policies = Vec::with_capacity(rows.len());
    for row in &rows {
        policies.push(PolicyRow {
            table: refuse_control_chars(require_string(row, "tablename")?)?,
            qual: require_string(row, "qual")?,
        });
    }

    Ok(policies)
}

/// `table`, refused when it carries a control character: a catalog table name
/// reaches a `-- <table>: ...` SQL comment and the terminal, either of which a
/// raw newline or other control byte could break out of or garble.
fn refuse_control_chars(table: String) -> Result<String> {
    if table.chars().any(char::is_control) {
        return Err(Error::Db(format!(
            "table name {table:?} carries a control character: refusing to introspect it"
        )));
    }

    Ok(table)
}

/// The whole snapshot the wizard derives from: base tables plus policies.
///
/// # Errors
/// Returns [`Error::Db`] when the schema name is not a
/// valid identifier, a query cannot run, or a table name carries a control
/// character, and [`Error::Boundary`] when a row does not carry the columns
/// the read expects.
pub fn introspect_catalog(applier: &dyn Applier, schema: &str) -> Result<SchemaCatalog> {
    if !is_valid_schema_name(schema) {
        return Err(Error::Db(format!("invalid schema name: {schema:?}")));
    }

    let rows = applier.run_query(&tables_query(schema)?)?;
    let mut tables = Vec::with_capacity(rows.len());
    for row in &rows {
        tables.push(refuse_control_chars(require_string(row, "table_name")?)?);
    }

    Ok(SchemaCatalog {
        tables,
        policies: read_policy_rows(applier, schema)?,
        columns: read_columns(applier, schema)?,
        auth_user_fks: read_auth_user_fks(applier, schema)?,
        rls_disabled: read_rls_disabled(applier, schema)?,
        primary_keys: read_primary_keys(applier, schema)?,
    })
}

/// The primary key of every table in `schema` that has one.
///
/// # Errors
/// Returns [`Error::Db`] when the schema name is not a valid identifier, the
/// query cannot run, or a table name carries a control character, and
/// [`Error::Boundary`] when a row does not carry the columns the read expects.
pub fn read_primary_keys(
    applier: &dyn Applier,
    schema: &str,
) -> Result<BTreeMap<String, PrimaryKey>> {
    let rows = applier.run_query(&primary_keys_query(schema)?)?;
    let mut keys: BTreeMap<String, PrimaryKey> = BTreeMap::new();
    for row in &rows {
        let table = refuse_control_chars(require_string(row, "table_name")?)?;
        let constraint = require_string(row, "constraint_name")?;
        let column = KeyColumn {
            name: require_string(row, "column_name")?,
            data_type: require_string(row, "data_type")?,
            base_type: require_string(row, "base_type")?,
            identity: read_identity(row)?,
            default: optional_string(row, "default_expression")?,
        };
        keys.entry(table)
            .or_insert_with(|| PrimaryKey {
                constraint,
                columns: Vec::new(),
            })
            .columns
            .push(column);
    }

    Ok(keys)
}

/// `pg_attribute.attidentity` as the key read selects it: null for a column
/// that is not an identity.
fn read_identity(row: &Row) -> Result<Option<Identity>> {
    match optional_string(row, "identity")?.as_deref() {
        None => Ok(None),
        Some("a") => Ok(Some(Identity::Always)),
        Some("d") => Ok(Some(Identity::ByDefault)),
        Some(other) => Err(Error::Boundary(format!(
            "row carries an unknown \"identity\": {other}"
        ))),
    }
}

/// The base tables in `schema` whose row level security is disabled.
///
/// # Errors
/// Returns [`Error::Db`] when the schema name is not a valid identifier, the
/// query cannot run, or a table name carries a control character, and
/// [`Error::Boundary`] when a row does not carry the columns the read expects.
pub fn read_rls_disabled(applier: &dyn Applier, schema: &str) -> Result<BTreeSet<String>> {
    let rows = applier.run_query(&rls_disabled_query(schema)?)?;
    let mut tables = BTreeSet::new();
    for row in &rows {
        tables.insert(refuse_control_chars(require_string(row, "table_name")?)?);
    }

    Ok(tables)
}

fn read_columns(applier: &dyn Applier, schema: &str) -> Result<BTreeMap<String, Vec<ColumnInfo>>> {
    let rows = applier.run_query(&columns_query(schema)?)?;
    let mut by_table: BTreeMap<String, Vec<ColumnInfo>> = BTreeMap::new();
    for row in &rows {
        let table = refuse_control_chars(require_string(row, "table_name")?)?;
        by_table.entry(table).or_default().push(ColumnInfo {
            name: require_string(row, "column_name")?,
            data_type: require_string(row, "data_type")?,
        });
    }

    Ok(by_table)
}

/// Columns in this schema whose foreign key targets `auth.users`, one preferred
/// column per table.
fn read_auth_user_fks(applier: &dyn Applier, schema: &str) -> Result<BTreeMap<String, String>> {
    let rows = applier.run_query(&auth_user_fk_query(schema)?)?;
    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &rows {
        let table = refuse_control_chars(require_string(row, "table_name")?)?;
        let column = require_string(row, "column_name")?;
        grouped.entry(table).or_default().push(column);
    }

    Ok(grouped
        .into_iter()
        .filter_map(|(table, columns)| {
            preferred_auth_user_column(&columns).map(|column| (table, column))
        })
        .collect())
}

/// `user_id`, then `owner_id`, then `id`, then whatever the catalog listed first.
///
/// A profile primary key is often `id`. A name such as `auth_user_id` matches
/// none of those, so it is chosen only when it is the sole foreign key. The
/// returned spelling is the catalog's, not the lowercase name we ranked.
fn preferred_auth_user_column(columns: &[String]) -> Option<String> {
    const RANKED: [&str; 3] = ["user_id", "owner_id", "id"];
    for wanted in RANKED {
        if let Some(found) = columns
            .iter()
            .find(|column| column.eq_ignore_ascii_case(wanted))
        {
            return Some(found.clone());
        }
    }

    columns.first().cloned()
}

// MARK: - derivation

/// The two Supabase ownership shapes an RLS policy is written in.
const OWNER_PATTERN: &str =
    r"(?i)auth\.uid\(\)\s*=\s*([a-z_][a-z0-9_]*)|([a-z_][a-z0-9_]*)\s*=\s*auth\.uid\(\)";

/// Catalog `pg_policies.qual` often wraps `auth.uid()` as `(SELECT auth.uid() AS uid)`.
const AUTH_UID_SELECT: &str = r"(?i)\(\s*select\s+auth\.uid\(\)(?:\s+as\s+[a-z_][a-z0-9_]*)?\s*\)";

fn unwrap_auth_uid_select(qual: &str) -> String {
    static WRAP: OnceLock<Option<Regex>> = OnceLock::new();
    // AUTH_UID_SELECT is a fixed literal exercised by tests; a compile failure
    // would be a build-time bug, so this degrades to the qualifier unchanged.
    WRAP.get_or_init(|| Regex::new(AUTH_UID_SELECT).ok())
        .as_ref()
        .map_or_else(
            || qual.to_owned(),
            |wrap| wrap.replace_all(qual, "auth.uid()").into_owned(),
        )
}

/// The owner column a policy expression keys on, when it is one of the shapes
/// above. A policy that scopes rows some other way yields `None`: a proposal we
/// cannot justify is left for the human to promote.
#[must_use]
pub fn infer_owner_column(qual: &str) -> Option<String> {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();

    // OWNER_PATTERN is a fixed literal exercised by tests; a compile failure
    // would be a build-time bug, so this degrades to "no owner inferred".
    let normalized = unwrap_auth_uid_select(qual);
    let pattern = PATTERN
        .get_or_init(|| Regex::new(OWNER_PATTERN).ok())
        .as_ref()?;
    let captures = pattern.captures(&normalized)?;

    captures
        .get(1)
        .or_else(|| captures.get(2))
        .map(|matched| matched.as_str().to_owned())
}

/// One proposal per table carrying a policy; its owner column is the first
/// policy on that table an owner could be inferred from. Sorted by table name so
/// the generated config is deterministic.
#[must_use]
pub fn proposals_from_rows(rows: &[PolicyRow]) -> Vec<TableProposal> {
    let mut by_table: BTreeMap<&str, TableProposal> = BTreeMap::new();
    for row in rows {
        if row.table.is_empty() {
            continue;
        }
        let owner = infer_owner_column(&row.qual);
        match by_table.get_mut(row.table.as_str()) {
            None => {
                by_table.insert(
                    row.table.as_str(),
                    TableProposal::derived(
                        &row.table,
                        owner.as_deref(),
                        &provenance(owner.as_deref()),
                    ),
                );
            }
            // A later policy that DOES name an owner upgrades a proposal that had none.
            Some(existing) if existing.owner_column.is_none() => {
                if let Some(column) = owner {
                    existing.provenance = provenance(Some(&column));
                    existing.owner_column = Some(column);
                }
            }
            Some(_) => {}
        }
    }

    by_table.into_values().collect()
}

/// Every proposal the policies justify, plus a derived entry for every other
/// base table: a table with no RLS at all is invisible to a policy-only read,
/// and silently omitting it would hide it from review.
#[must_use]
pub fn proposals_from_catalog(catalog: &SchemaCatalog) -> Vec<TableProposal> {
    let mut by_table: BTreeMap<String, TableProposal> = proposals_from_rows(&catalog.policies)
        .into_iter()
        .map(|proposal| (proposal.table.clone(), proposal))
        .collect();
    for table in &catalog.tables {
        by_table.entry(table.clone()).or_insert_with(|| {
            TableProposal::derived(
                table,
                None,
                "[auto] no RLS policies found: review sync mode",
            )
        });
    }
    for proposal in by_table.values_mut() {
        proposal.key = catalog.primary_keys.get(&proposal.table).cloned();
    }
    // RLS already decided an owner. The foreign key only fills a gap, so a
    // policy that keys on `user_id` is not rewritten to a different column.
    for (table, column) in &catalog.auth_user_fks {
        let Some(existing) = by_table.get_mut(table) else {
            continue;
        };
        if existing.owner_column.is_some() {
            continue;
        }
        existing.provenance = auth_user_provenance(column);
        existing.owner_column = Some(column.clone());
    }

    by_table.into_values().collect()
}

fn auth_user_provenance(column: &str) -> String {
    format!("[auto] {column} references auth.users → byOwner('{column}')")
}

fn provenance(owner_column: Option<&str>) -> String {
    owner_column.map_or_else(
        || "[auto] has RLS policies; no owner column inferred: review sync mode".to_owned(),
        |column| format!("[auto] RLS policy keys on {column} → byOwner('{column}')"),
    )
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::applier::fake::{FakeApplier, text_row};

    fn policies(rows: &[(&str, &str)]) -> Vec<PolicyRow> {
        rows.iter()
            .map(|(table, qual)| PolicyRow {
                table: (*table).to_owned(),
                qual: (*qual).to_owned(),
            })
            .collect()
    }

    fn tables_of(proposals: &[TableProposal]) -> Vec<&str> {
        proposals
            .iter()
            .map(|proposal| proposal.table.as_str())
            .collect()
    }

    // MARK: - owner inference

    #[test]
    fn both_supabase_ownership_shapes_infer_the_column() {
        assert_eq!(
            infer_owner_column("(auth.uid() = user_id)").as_deref(),
            Some("user_id")
        );
        assert_eq!(
            infer_owner_column("(owner_id = auth.uid())").as_deref(),
            Some("owner_id")
        );
        assert_eq!(
            infer_owner_column("(AUTH.UID()  =  Owner_Id)").as_deref(),
            Some("Owner_Id")
        );
        assert_eq!(
            infer_owner_column("(( SELECT auth.uid() AS uid) = user_id)").as_deref(),
            Some("user_id")
        );
        assert_eq!(
            infer_owner_column("(user_id = (select auth.uid()))").as_deref(),
            Some("user_id")
        );
    }

    #[test]
    fn a_policy_that_scopes_rows_some_other_way_infers_nothing() {
        assert_eq!(infer_owner_column(""), None);
        assert_eq!(infer_owner_column("(true)"), None);
        assert_eq!(
            infer_owner_column("(is_member(workspace_id, auth.jwt()))"),
            None
        );
    }

    // MARK: - proposals from policies

    #[test]
    fn one_proposal_per_table_sorted_with_its_provenance() {
        let proposals = proposals_from_rows(&policies(&[
            ("todos", "(auth.uid() = user_id)"),
            ("audit", "(true)"),
        ]));

        assert_eq!(tables_of(&proposals), ["audit", "todos"]);
        assert_eq!(
            proposals[0].provenance,
            "[auto] has RLS policies; no owner column inferred: review sync mode"
        );
        assert_eq!(proposals[1].owner_column.as_deref(), Some("user_id"));
        assert_eq!(
            proposals[1].provenance,
            "[auto] RLS policy keys on user_id → byOwner('user_id')"
        );
    }

    #[test]
    fn a_later_policy_that_names_an_owner_upgrades_the_proposal() {
        let proposals = proposals_from_rows(&policies(&[
            ("todos", "(true)"),
            ("todos", "(auth.uid() = user_id)"),
        ]));

        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].owner_column.as_deref(), Some("user_id"));
    }

    #[test]
    fn the_first_inferable_owner_wins_and_is_not_overwritten() {
        let proposals = proposals_from_rows(&policies(&[
            ("todos", "(auth.uid() = user_id)"),
            ("todos", "(auth.uid() = other_id)"),
        ]));

        assert_eq!(proposals[0].owner_column.as_deref(), Some("user_id"));
    }

    #[test]
    fn a_row_without_a_table_name_is_skipped() {
        assert_eq!(
            proposals_from_rows(&policies(&[("", "(true)")])),
            Vec::<TableProposal>::new()
        );
    }

    // MARK: - proposals from the catalog

    #[test]
    fn a_table_with_no_policies_still_gets_a_reviewable_entry() {
        let catalog = SchemaCatalog {
            tables: vec!["todos".to_owned(), "settings".to_owned()],
            policies: policies(&[("todos", "(auth.uid() = user_id)")]),
            ..Default::default()
        };
        let proposals = proposals_from_catalog(&catalog);

        assert_eq!(tables_of(&proposals), ["settings", "todos"]);
        assert_eq!(
            proposals[0].provenance,
            "[auto] no RLS policies found: review sync mode"
        );
        assert_eq!(proposals[0].owner_column, None);
        assert_eq!(proposals[1].owner_column.as_deref(), Some("user_id"));
    }

    #[test]
    fn an_auth_users_foreign_key_fills_in_an_owner_rls_did_not_name() {
        let mut auth_user_fks = BTreeMap::new();
        auth_user_fks.insert("users".to_owned(), "auth_user_id".to_owned());
        let catalog = SchemaCatalog {
            tables: vec!["users".to_owned(), "todos".to_owned()],
            policies: policies(&[("users", "(true)"), ("todos", "(auth.uid() = user_id)")]),
            auth_user_fks,
            ..Default::default()
        };
        let proposals = proposals_from_catalog(&catalog);
        let users = proposals
            .iter()
            .find(|proposal| proposal.table == "users")
            .unwrap();
        let todos = proposals
            .iter()
            .find(|proposal| proposal.table == "todos")
            .unwrap();

        assert_eq!(users.owner_column.as_deref(), Some("auth_user_id"));
        assert_eq!(
            users.provenance,
            "[auto] auth_user_id references auth.users → byOwner('auth_user_id')"
        );
        assert_eq!(todos.owner_column.as_deref(), Some("user_id"));
        assert_eq!(
            todos.provenance,
            "[auto] RLS policy keys on user_id → byOwner('user_id')"
        );
    }

    #[test]
    fn a_policy_on_a_table_the_catalog_does_not_list_is_still_proposed() {
        // A view carries policies but is not a BASE TABLE: the policy read sees it.
        let catalog = SchemaCatalog {
            tables: Vec::new(),
            policies: policies(&[("todos_view", "(auth.uid() = user_id)")]),
            ..Default::default()
        };

        assert_eq!(tables_of(&proposals_from_catalog(&catalog)), ["todos_view"]);
    }

    // MARK: - the reads

    fn catalog_applier() -> FakeApplier {
        FakeApplier::new()
            .answer(
                "information_schema.tables",
                vec![
                    text_row(&[("table_name", "todos")]),
                    text_row(&[("table_name", "settings")]),
                ],
            )
            .answer(
                "pg_policies",
                vec![text_row(&[
                    ("tablename", "todos"),
                    ("qual", "(auth.uid() = user_id)"),
                ])],
            )
    }

    #[test]
    fn the_catalog_read_assembles_tables_and_policies() {
        let applier = catalog_applier();
        let catalog = introspect_catalog(&applier, "public").unwrap();

        assert_eq!(catalog.tables, ["todos", "settings"]);
        assert_eq!(
            catalog.policies,
            policies(&[("todos", "(auth.uid() = user_id)")])
        );
        assert!(catalog.auth_user_fks.is_empty());
        assert!(
            applier
                .executed
                .borrow()
                .iter()
                .any(|sql| sql.contains("pg_constraint"))
        );
    }

    #[test]
    fn the_catalog_read_names_each_tables_primary_key_in_key_order() {
        let key_row = |table: &str, column: &str, data_type: &str, base_type: &str| {
            text_row(&[
                ("table_name", table),
                ("constraint_name", &format!("{table}_pkey")),
                ("column_name", column),
                ("data_type", data_type),
                ("base_type", base_type),
            ])
        };
        let mut counter = key_row("counters", "id", "bigint", "bigint");
        counter.insert("identity".to_owned(), serde_json::Value::from("d"));
        let mut events = key_row("events", "id", "bigint", "bigint");
        events.insert("identity".to_owned(), serde_json::Value::from("a"));
        let mut todos = key_row("todos", "id", "uuid", "uuid");
        todos.insert(
            "default_expression".to_owned(),
            serde_json::Value::from("gen_random_uuid()"),
        );
        let applier = catalog_applier().answer(
            "indisprimary",
            vec![
                counter,
                events,
                key_row("favorites", "user_id", "uuid", "uuid"),
                key_row("favorites", "geoname_id", "bigint", "bigint"),
                key_row(
                    "labels",
                    "code",
                    "character varying(64)",
                    "character varying",
                ),
                key_row("slugs", "slug", "slug_domain", "text"),
                todos,
            ],
        );
        let catalog = introspect_catalog(&applier, "public").unwrap();

        assert_eq!(
            catalog.primary_keys.get("favorites"),
            Some(&PrimaryKey::of(
                "favorites_pkey",
                &[("user_id", "uuid"), ("geoname_id", "bigint")]
            ))
        );
        assert_eq!(
            catalog.primary_keys.get("counters"),
            Some(&PrimaryKey::over(
                "counters_pkey",
                vec![KeyColumn::plain("id", "bigint").generated(Identity::ByDefault)]
            ))
        );
        assert_eq!(
            catalog.primary_keys.get("events"),
            Some(&PrimaryKey::over(
                "events_pkey",
                vec![KeyColumn::plain("id", "bigint").generated(Identity::Always)]
            ))
        );
        assert_eq!(
            catalog.primary_keys.get("labels"),
            Some(&PrimaryKey::over(
                "labels_pkey",
                vec![
                    KeyColumn::plain("code", "character varying(64)")
                        .over_base("character varying")
                ]
            ))
        );
        assert_eq!(
            catalog.primary_keys.get("slugs"),
            Some(&PrimaryKey::over(
                "slugs_pkey",
                vec![KeyColumn::plain("slug", "slug_domain").over_base("text")]
            ))
        );
        assert_eq!(
            catalog.primary_keys.get("todos"),
            Some(&PrimaryKey::over(
                "todos_pkey",
                vec![KeyColumn::plain("id", "uuid").defaulting("gen_random_uuid()")]
            ))
        );
        assert!(!catalog.primary_keys.contains_key("settings"));
    }

    #[test]
    fn an_identity_the_read_does_not_know_is_a_boundary_failure() {
        let applier = catalog_applier().answer(
            "indisprimary",
            vec![text_row(&[
                ("table_name", "todos"),
                ("constraint_name", "todos_pkey"),
                ("column_name", "id"),
                ("data_type", "bigint"),
                ("base_type", "bigint"),
                ("identity", "x"),
            ])],
        );

        assert!(matches!(
            introspect_catalog(&applier, "public").unwrap_err(),
            Error::Boundary(_)
        ));
    }

    // MARK: - the key columns the pack can sync by

    #[test]
    fn every_type_whose_text_form_matches_on_both_sides_is_keyable() {
        for data_type in [
            "uuid",
            "text",
            "character varying",
            "smallint",
            "integer",
            "bigint",
        ] {
            let key = PrimaryKey::of("t_pkey", &[("id", data_type)]);

            assert!(key.unkeyable_columns().is_empty(), "{data_type}");
        }
        assert_eq!(KEY_COLUMN_TYPES.len(), 6);
    }

    #[test]
    fn every_other_type_is_unkeyable() {
        for data_type in [
            "numeric",
            "real",
            "double precision",
            "boolean",
            "date",
            "timestamp with time zone",
            "timestamp without time zone",
            "time without time zone",
            "interval",
            "bytea",
            "character",
            "json",
            "jsonb",
            "text[]",
            "uuid[]",
            "citext",
            "inet",
            "money",
        ] {
            let key = PrimaryKey::of("t_pkey", &[("id", data_type)]);

            assert_eq!(
                key.unkeyable_columns(),
                [&KeyColumn::plain("id", data_type)],
                "{data_type}"
            );
        }
    }

    /// A domain renders its base type's text, so the base type decides: a
    /// modifier on `character varying(64)` changes nothing either.
    #[test]
    fn a_domain_or_a_modifier_is_judged_by_the_base_type_under_it() {
        let slug = KeyColumn::plain("slug", "slug_domain").over_base("text");
        let price = KeyColumn::plain("price", "price_domain").over_base("numeric");
        let code = KeyColumn::plain("code", "character varying(64)").over_base("character varying");

        assert!(slug.is_keyable());
        assert!(code.is_keyable());
        assert!(!price.is_keyable());
    }

    #[test]
    fn a_composite_key_keeps_its_order_and_names_only_its_unkeyable_columns() {
        let key = PrimaryKey::of(
            "t_pkey",
            &[
                ("hall", "bigint"),
                ("price", "numeric"),
                ("seat", "integer"),
            ],
        );

        assert_eq!(key.column_names(), ["hall", "price", "seat"]);
        assert_eq!(
            key.unkeyable_columns(),
            [&KeyColumn::plain("price", "numeric")]
        );
        assert_eq!(key.describe(), "(hall bigint, price numeric, seat integer)");
    }

    #[test]
    fn a_generated_always_identity_is_told_apart_from_one_by_default() {
        let always = PrimaryKey::over(
            "t_pkey",
            vec![KeyColumn::plain("id", "bigint").generated(Identity::Always)],
        );
        let by_default = PrimaryKey::over(
            "t_pkey",
            vec![KeyColumn::plain("id", "bigint").generated(Identity::ByDefault)],
        );

        assert_eq!(always.generated_always_columns().len(), 1);
        assert_eq!(always.defaulted_columns(), Vec::<&KeyColumn>::new());
        assert_eq!(
            by_default.generated_always_columns(),
            Vec::<&KeyColumn>::new()
        );
        assert_eq!(by_default.defaulted_columns().len(), 1);
    }

    /// A sequence value is the server's to pick, while any uuid a device mints
    /// is as good as the server's.
    #[test]
    fn every_key_default_but_a_minted_uuid_is_a_database_default() {
        let serial =
            KeyColumn::plain("id", "integer").defaulting("nextval('events_id_seq'::regclass)");
        let constant = KeyColumn::plain("code", "text").defaulting("'x'::text");
        let minted = KeyColumn::plain("id", "uuid").defaulting("gen_random_uuid()");
        let plain = KeyColumn::plain("id", "uuid");

        assert!(serial.has_database_default());
        assert!(constant.has_database_default());
        assert!(!minted.has_database_default());
        assert!(!plain.has_database_default());
    }

    #[test]
    fn key_columns_read_as_one_name_or_a_parenthesized_list() {
        assert_eq!(describe_key_columns(&["id".to_owned()]), "id");
        assert_eq!(
            describe_key_columns(&["hall".to_owned(), "seat".to_owned()]),
            "(hall, seat)"
        );
    }

    /// A proposal carries the key the catalog read for its table; one no
    /// catalog read records the pack's default key.
    #[test]
    fn a_proposal_records_the_key_its_catalog_read() {
        let mut catalog = SchemaCatalog {
            tables: vec!["seats".to_owned(), "todos".to_owned()],
            ..Default::default()
        };
        catalog.primary_keys.insert(
            "seats".to_owned(),
            PrimaryKey::of("seats_pkey", &[("hall", "bigint"), ("seat", "integer")]),
        );
        let proposals = proposals_from_catalog(&catalog);

        assert_eq!(proposals[0].key_columns(), ["hall", "seat"]);
        assert_eq!(proposals[1].key, None);
        assert_eq!(proposals[1].key_columns(), ["id"]);
        assert_eq!(
            TableProposal::derived("seats", None, "[flag]")
                .keyed_from(&catalog)
                .key_columns(),
            ["hall", "seat"]
        );
    }

    #[test]
    fn a_key_reads_as_its_columns_and_their_types() {
        assert_eq!(
            PrimaryKey::of("t_pkey", &[("user_id", "uuid"), ("geoname_id", "bigint")]).describe(),
            "(user_id uuid, geoname_id bigint)"
        );
        assert_eq!(
            PrimaryKey::of("t_pkey", &[("id", "bigint")]).describe(),
            "(id bigint)"
        );
    }

    #[test]
    fn a_key_row_missing_a_column_fails_the_catalog() {
        let applier = catalog_applier().answer(
            "indisprimary",
            vec![text_row(&[("table_name", "todos"), ("column_name", "id")])],
        );

        assert!(introspect_catalog(&applier, "public").is_err());
    }

    #[test]
    fn the_catalog_read_prefers_user_id_then_owner_id_then_id() {
        let applier = catalog_applier().answer(
            "pg_constraint",
            vec![
                text_row(&[("table_name", "profiles"), ("column_name", "legacy_id")]),
                text_row(&[("table_name", "profiles"), ("column_name", "User_Id")]),
                text_row(&[("table_name", "accounts"), ("column_name", "owner_id")]),
                text_row(&[("table_name", "accounts"), ("column_name", "id")]),
                text_row(&[("table_name", "users"), ("column_name", "auth_user_id")]),
                text_row(&[("table_name", "members"), ("column_name", "id")]),
            ],
        );
        let catalog = introspect_catalog(&applier, "public").unwrap();

        assert_eq!(
            catalog.auth_user_fks.get("profiles").map(String::as_str),
            Some("User_Id")
        );
        assert_eq!(
            catalog.auth_user_fks.get("accounts").map(String::as_str),
            Some("owner_id")
        );
        assert_eq!(
            catalog.auth_user_fks.get("users").map(String::as_str),
            Some("auth_user_id")
        );
        assert_eq!(
            catalog.auth_user_fks.get("members").map(String::as_str),
            Some("id")
        );
    }

    #[test]
    fn the_catalog_read_names_the_tables_whose_row_level_security_is_disabled() {
        let applier = catalog_applier().answer(
            "relrowsecurity",
            vec![text_row(&[("table_name", "settings")])],
        );
        let catalog = introspect_catalog(&applier, "public").unwrap();

        assert_eq!(
            catalog.rls_disabled.iter().collect::<Vec<_>>(),
            ["settings"]
        );
    }

    #[test]
    fn a_row_level_security_read_failure_fails_the_catalog() {
        let applier = catalog_applier().fail("relrowsecurity", "permission denied");

        assert!(introspect_catalog(&applier, "public").is_err());
    }

    #[test]
    fn an_auth_user_read_failure_fails_the_catalog() {
        let applier = catalog_applier().fail("pg_constraint", "permission denied");

        assert!(introspect_catalog(&applier, "public").is_err());
    }

    #[test]
    fn an_invalid_schema_is_refused_before_any_statement_is_composed() {
        let applier = catalog_applier();
        let Error::Db(message) =
            introspect_catalog(&applier, "public'; drop table x; --").unwrap_err()
        else {
            panic!("an invalid schema name is a database failure");
        };

        assert!(message.starts_with("invalid schema name:"), "{message}");
        assert!(applier.executed.borrow().is_empty());
    }

    #[test]
    fn a_read_failure_is_reported_never_an_empty_proposal_set() {
        let applier = FakeApplier::new().fail("pg_policies", "permission denied");

        assert!(read_policy_rows(&applier, "public").is_err());
    }

    #[test]
    fn a_policy_row_missing_a_column_is_a_boundary_failure() {
        let applier =
            FakeApplier::new().answer("pg_policies", vec![text_row(&[("tablename", "todos")])]);

        assert!(read_policy_rows(&applier, "public").is_err());
    }

    #[test]
    fn a_table_name_carrying_a_control_character_is_refused_everywhere_it_is_read() {
        let control = "todos\ndrop table users";

        let policies = FakeApplier::new().answer(
            "pg_policies",
            vec![text_row(&[("tablename", control), ("qual", "true")])],
        );
        let Error::Db(message) = read_policy_rows(&policies, "public").unwrap_err() else {
            panic!("a control character in a policy's table name is a database failure");
        };
        assert!(message.contains("control character"), "{message}");

        let tables = FakeApplier::new().answer(
            "information_schema.tables",
            vec![text_row(&[("table_name", control)])],
        );
        assert!(introspect_catalog(&tables, "public").is_err());

        let columns = FakeApplier::new().answer(
            "information_schema.columns",
            vec![text_row(&[
                ("table_name", control),
                ("column_name", "id"),
                ("data_type", "uuid"),
            ])],
        );
        assert!(read_columns(&columns, "public").is_err());

        let fks = FakeApplier::new().answer(
            "con.contype = 'f'",
            vec![text_row(&[
                ("table_name", control),
                ("column_name", "user_id"),
            ])],
        );
        assert!(read_auth_user_fks(&fks, "public").is_err());
    }
}
