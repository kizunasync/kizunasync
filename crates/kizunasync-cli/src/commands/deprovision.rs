//! `deprovision`: remove exactly what the ledger recorded.
//!
//! Reads `kizunasync._provisions` and generates a DROP for every recorded
//! object in reverse dependency order. The user's own tables and data are never
//! dropped (config rows are metadata deletes, not table drops). The
//! ledger→DROP-SQL translation is the pure core in [`crate::ledger`]; this is
//! the I/O shell around it.
//!
//! Destructive guard: the plan is printed first, and applying needs `--yes` or
//! `KSYNC_ALLOW_DEPROVISION=1`. This binary never prompts, so a session with
//! neither is refused (exit 2). `--dry-run` alone is always safe.
//!
//! Ledger-honest teardown: the generated down-migration ends with one cleanup
//! DELETE removing every `_provisions` row that produced a DROP above
//! (`pack-file` rows already delete their own row). Rows that produced only a
//! warning are never deleted: the ledger keeps claiming them, which is the
//! honest state.
//!
//! A ledger whose `pack-file` rows a newer kizunasync recorded is refused
//! first (exit 2): this build does not know the objects that pack installed.
//!
//! The drops cascade, so before anything is planned `pg_depend` is read for
//! objects outside the schema that depend on a pack object: a view over a pack
//! table, a column default calling a pack function, a trigger nobody ledgered.
//! Any one of them refuses the run (exit 2), listed, because the cascade would
//! take it with the pack. What the pack owns is not a dependent: objects on
//! the pack's own tables, and the ledgered triggers and policies it put on
//! yours.
//!
//! Two behaviours, one command:
//!
//! * The default removes what the ledger names, which is the functions, the
//!   policies, the cron jobs, the role, and the per-table config rows and
//!   triggers. The schema, its bookkeeping tables and their rows stay, so the
//!   project can be provisioned again over the same data.
//! * `--purge` continues into the schema itself: the policies inside it, the
//!   grants, and then `drop schema … cascade`, which takes every table,
//!   sequence and index with it, the ledger last of all, then every
//!   `kizunasync*` role no other database still uses. It needs the target
//!   typed out with `--confirm` on top of `--yes`, because it removes data
//!   nothing else in this binary removes. Before the purge runs, `kizunasync`
//!   leaves the Data API's exposed schemas, the inverse of `init`'s step:
//!   PostgREST cannot build its schema cache while an exposed schema is
//!   missing (PGRST002). That is the project's PostgREST config over the
//!   Management API, read back until it no longer lists the schema;
//!   `[api].schemas` in `supabase/config.toml` locally; and a warning to do
//!   it by hand anywhere else. A purge that then fails puts the entry back.
//!
//! In a Supabase CLI project (a `supabase/config.toml` at the root) the
//! teardown is a migration, `<ts>_kizunasync_deprovision.sql`, applied with
//! `supabase db push` the way `init` applies its own: the migration history
//! records it, and replaying the directory reproduces the state. Each
//! statement in that file checks that what it needs exists, and under
//! `--purge` the file always ends with that purge, even over an empty ledger,
//! so it holds over whatever the files before it left. Anywhere else, and
//! always over the Management API (`--project-ref`), the teardown runs as one
//! transaction over the connection: a run through the API writes no local
//! file, as `init --project-ref` writes none.

use std::path::Path;
use std::time::Duration;

use crate::api_schemas::{UnpatchOutcome, unpatch_api_schemas};
use crate::applier::Applier;
use crate::catalog::SchemaSource;
use crate::clock::migration_version;
use crate::commands::history_gate::{gate_migration_history, is_recorded, push_written};
use crate::commands::init::DirectConnection;
use crate::commands::{FAILURE, OK, UNUSABLE, refuse_newer_ledger};
use crate::constants::{INTERNAL_PROVISIONS, SCHEMA};
use crate::emit::next_migration_second;
use crate::env::Env;
use crate::error::Result;
use crate::ledger::{
    CanonicalizationReport, DropPlan, DropStatement, ObjectKind, ProvisionRow, audit_object_names,
    build_drop_plan, required_relation,
};
use crate::management::{ExposedSchemas, UnexposeOutcome, unexpose_outcome};
use crate::migration_history::local_versions;
use crate::project_ref::ProjectRef;
use crate::provision::{is_ledger_present, read_ledger_rows};
use crate::row::{optional_string, require_bool, require_number, require_string};
use crate::supabase_cli::{PushTarget, SupabaseCli};
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

/// Flags `deprovision` accepts.
#[derive(Debug, Clone, Default)]
pub struct DeprovisionFlags {
    /// Print the plan and stop.
    pub dry_run: bool,
    /// Confirm the destructive apply.
    pub yes: bool,
    /// Refuse: there is no ledger to read without a database.
    pub local_only: bool,
    /// `--purge`: the schema teardown, carrying what it will remove and the
    /// word the operator has to type for it. `None` is the default behaviour,
    /// which removes the ledgered objects and leaves the data.
    pub purge: Option<PurgeRequest>,
}

/// One RLS policy inside the schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaPolicy {
    /// The table it is attached to.
    pub table: String,
    /// The policy name.
    pub name: String,
}

/// What the schema still holds, counted before `--purge` removes it. The
/// numbers are what the plan prints: an operator sees the size of the thing
/// before typing the confirmation, not after.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SchemaCounts {
    /// Tables in the schema, with their rows.
    pub tables: i64,
    /// Sequences.
    pub sequences: i64,
    /// Indexes.
    pub indexes: i64,
    /// Functions.
    pub functions: i64,
    /// Policies, named so the plan can drop each one before the schema goes.
    pub policies: Vec<SchemaPolicy>,
}

/// Everything `--purge` needs beyond the ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgeRequest {
    /// The word this connection's purge must be confirmed with: the project
    /// ref, or `local`.
    pub expected: String,
    /// What `--confirm` carried.
    pub typed: Option<String>,
    /// What the schema still holds.
    pub counts: SchemaCounts,
}

impl PurgeRequest {
    /// Whether the operator typed the target. `--yes` is deliberately not
    /// enough: it is the same flag a routine deprovision carries, and this
    /// drops the data too.
    #[must_use]
    pub fn confirmed(&self) -> bool {
        self.typed
            .as_deref()
            .map(str::trim)
            .is_some_and(|typed| typed == self.expected)
    }
}

/// What a purge over this connection must be confirmed with: the Supabase
/// project ref when the URL names a hosted project (the `db.<ref>.supabase.co`
/// host, or the `postgres.<ref>` pooler user), and `local` for anything else.
#[must_use]
pub fn expected_confirmation(url: &str) -> String {
    hosted_project_ref(url).unwrap_or(LOCAL_TARGET).to_owned()
}

/// The Supabase project ref a connection string names: the
/// `db.<ref>.supabase.co` host, or the `postgres.<ref>` pooler user.
fn hosted_project_ref(url: &str) -> Option<&str> {
    let (user, host) = user_and_host(url);
    if let Some(rest) = host.strip_prefix("db.")
        && let Some(reference) = rest.strip_suffix(".supabase.co")
        && !reference.is_empty()
    {
        return Some(reference);
    }

    user.strip_prefix("postgres.")
        .filter(|reference| !reference.is_empty())
}

/// The user and the host of a connection string, without the password, the
/// port, or an IPv6 host's brackets.
fn user_and_host(url: &str) -> (&str, &str) {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = after_scheme
        .split(['/', '?'])
        .next()
        .unwrap_or(after_scheme);
    let (user, host) = authority
        .rsplit_once('@')
        .map_or(("", authority), |(user, host)| (user, host));
    let host = match host.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next().unwrap_or(bracketed),
        None => host.split(':').next().unwrap_or(host),
    };

    (user.split(':').next().unwrap_or(user), host)
}

/// The list a direct connection's purge takes `kizunasync` out of, decided by
/// the database the teardown reaches, never by the files beside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExposureTarget {
    /// The local stack, whose `supabase/config.toml` lists the schemas.
    ConfigToml,
    /// The hosted project with this ref, through the Management API.
    ManagementApi(ProjectRef),
    /// Neither: the plan warns to do it by hand.
    ByHand,
}

/// Where a purge over `connection` takes `kizunasync` out of the exposed
/// schemas. The local stack (`--local`, or a URL to this machine) edits
/// `supabase/config.toml` when there is one. A hosted project goes through
/// the Management API when the run `has_token` and the ref is known:
/// `linked` for a `--linked` push, else the one the URL names. A pooler user
/// (`postgres.<ref>`) names a hosted project even on this machine's address,
/// as a tunnel does. Anything else is by hand: a local file never stands in
/// for a hosted project's settings.
#[must_use]
pub fn exposure_target(
    connection: &DirectConnection,
    paths: &ProjectPaths,
    linked: Option<&ProjectRef>,
    has_token: bool,
) -> ExposureTarget {
    let project_ref = match &connection.push {
        PushTarget::Linked => linked.cloned(),
        PushTarget::DbUrl(url) if is_hosted(url) => {
            hosted_project_ref(url).and_then(|reference| ProjectRef::parse(reference).ok())
        }
        PushTarget::Local | PushTarget::DbUrl(_) => {
            return if paths.config_toml.is_file() {
                ExposureTarget::ConfigToml
            } else {
                ExposureTarget::ByHand
            };
        }
    };

    match project_ref {
        Some(project_ref) if has_token => ExposureTarget::ManagementApi(project_ref),
        _ => ExposureTarget::ByHand,
    }
}

/// Whether a connection string reaches a hosted project: a pooler user that
/// names a project ref, or any host but this machine. The local stack's own
/// pooler user (`postgres.pooler-dev`) names none.
fn is_hosted(url: &str) -> bool {
    let (user, host) = user_and_host(url);
    let names_a_project = user
        .strip_prefix("postgres.")
        .is_some_and(|reference| ProjectRef::parse(reference).is_ok());

    names_a_project || !crate::tls_url::is_loopback_host(host)
}

/// What a connection that names no hosted project is confirmed with.
pub const LOCAL_TARGET: &str = "local";

fn schema_counts_query() -> String {
    format!(
        "select\n  (select count(*) from pg_tables where schemaname = '{SCHEMA}')::int as tables,\n  (select count(*) from pg_sequences where schemaname = '{SCHEMA}')::int as sequences,\n  (select count(*) from pg_indexes where schemaname = '{SCHEMA}')::int as indexes,\n  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = '{SCHEMA}')::int as functions;"
    )
}

fn schema_policies_query() -> String {
    format!(
        "select tablename as table_name, policyname as name from pg_policies where schemaname = '{SCHEMA}' order by 1, 2;"
    )
}

/// Count what the schema holds, for the purge plan.
///
/// # Errors
/// Returns the transport's own failure, or a boundary error when a row does not
/// carry the counts asked for.
pub fn read_schema_counts(applier: &dyn Applier) -> Result<SchemaCounts> {
    let rows = applier.run_query(&schema_counts_query())?;
    let Some(row) = rows.first() else {
        return Err(crate::error::Error::Boundary(
            "the schema-count probe returned no row, expected exactly 1".to_owned(),
        ));
    };

    let policy_rows = applier.run_query(&schema_policies_query())?;
    let mut policies = Vec::with_capacity(policy_rows.len());
    for policy in &policy_rows {
        policies.push(SchemaPolicy {
            table: require_string(policy, "table_name")?,
            name: require_string(policy, "name")?,
        });
    }

    Ok(SchemaCounts {
        tables: require_number(row, "tables")?,
        sequences: require_number(row, "sequences")?,
        indexes: require_number(row, "indexes")?,
        functions: require_number(row, "functions")?,
        policies,
    })
}

/// SELECT the ledger. A null or empty `object_args` means no signature was
/// recorded for that row.
#[must_use]
pub fn ledger_query() -> String {
    format!(
        "select\n  object_kind,\n  object_name,\n  object_args\nfrom {SCHEMA}.{INTERNAL_PROVISIONS}\norder by id;"
    )
}

/// Read the ledger into [`ProvisionRow`]s. Unknown kinds are preserved as-is
/// (the planner turns them into warnings) rather than dropped, so nothing is
/// silently lost. A null/empty `object_args` means "no signature recorded".
///
/// # Errors
/// Returns the transport's own failure, or a boundary error when a row is
/// missing one of its columns.
pub fn read_ledger(applier: &dyn Applier) -> Result<Vec<ProvisionRow>> {
    let rows = applier.run_query(&ledger_query())?;
    let mut parsed = Vec::with_capacity(rows.len());
    for row in &rows {
        let args = optional_string(row, "object_args")?.filter(|value| !value.is_empty());
        parsed.push(ProvisionRow {
            object_kind: ObjectKind::parse(&require_string(row, "object_kind")?),
            object_name: require_string(row, "object_name")?,
            object_args: args,
        });
    }

    Ok(parsed)
}

/// An object outside the schema that depends on a pack object, so a cascading
/// drop of the pack would drop it too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalDependent {
    /// What Postgres calls it: `view`, `trigger`, `default value`, ...
    pub kind: String,
    /// Its schema-qualified identity.
    pub identity: String,
    /// The pack object it depends on, kind first.
    pub depends_on: String,
}

/// Every object outside the schema that depends on an object inside it,
/// with the name a ledger row would record it under. Only normal and
/// automatic dependencies count: an internal one (a pack table's TOAST table)
/// is part of the object it hangs off. A view is reached through its
/// `_RETURN` rule, so the rule is reported as the view that owns it.
fn external_dependents_query() -> String {
    format!(
        "select distinct\n  \
         coalesce(relation.type, dependent.type) as kind,\n  \
         coalesce(relation.identity, dependent.identity) as identity,\n  \
         array_to_string(address.object_names, '.') as ledger_name,\n  \
         referenced.type || ' ' || referenced.identity as depends_on\n\
         from pg_depend d\n\
         cross join lateral pg_identify_object(d.refclassid, d.refobjid, 0) referenced\n\
         cross join lateral pg_identify_object(d.classid, d.objid, d.objsubid) dependent\n\
         cross join lateral pg_identify_object_as_address(d.classid, d.objid, d.objsubid) address\n\
         left join pg_rewrite r on d.classid = 'pg_rewrite'::regclass and r.oid = d.objid\n\
         left join lateral pg_identify_object('pg_class'::regclass, r.ev_class, 0) relation on true\n\
         where d.deptype in ('n', 'a')\n  \
         and referenced.schema = '{SCHEMA}'\n  \
         and address.object_names[1] is distinct from '{SCHEMA}'\n\
         order by 2, 4;"
    )
}

/// Read what depends on the pack from outside its schema, leaving out the
/// objects the ledger `rows` record: the triggers and policies the pack put
/// on tables outside the schema are its own, and the drops remove them by
/// name. Objects on the pack's own tables never appear, because the address
/// of a trigger, policy, or default names its table's schema first.
///
/// # Errors
/// Returns the transport's own failure, or a boundary error when a row does
/// not carry the columns asked for.
pub fn read_external_dependents(
    applier: &dyn Applier,
    rows: &[ProvisionRow],
) -> Result<Vec<ExternalDependent>> {
    let found = applier.run_query(&external_dependents_query())?;
    let mut dependents = Vec::with_capacity(found.len());
    for row in &found {
        let kind = require_string(row, "kind")?;
        let ledger_name = require_string(row, "ledger_name")?;
        let ledgered = rows.iter().any(|recorded| {
            recorded.object_kind.as_str() == kind && recorded.object_name == ledger_name
        });
        if ledgered {
            continue;
        }

        dependents.push(ExternalDependent {
            kind,
            identity: require_string(row, "identity")?,
            depends_on: require_string(row, "depends_on")?,
        });
    }

    Ok(dependents)
}

/// Wrap the ordered DROPs in a single transactional down-migration, followed by
/// one cleanup DELETE for every `_provisions` row that produced a DROP above,
/// and, under `--purge`, the schema teardown the ledger does not name.
#[must_use]
pub fn render_down_migration(rows: &[ProvisionRow], purge: Option<&PurgeRequest>) -> String {
    let plan = build_drop_plan(rows);
    let cleanup =
        cleanup_statement(&plan).map_or_else(String::new, |cleanup| format!("  {cleanup}\n"));
    let statements = plan
        .statements
        .iter()
        .map(|statement| format!("  {}", statement.sql))
        .collect::<Vec<_>>()
        .join("\n");
    let Some(purge) = purge else {
        return format!(
            "-- Generated by `kizunasync deprovision`. Drops every kizunasync._provisions object\n\
             -- in reverse dependency order. Your tables and data are untouched.\n\
             begin;\n{statements}\n{cleanup}commit;\n"
        );
    };
    let tail = purge_tail(&purge.counts, Form::Transaction)
        .iter()
        .map(|statement| format!("  {statement}"))
        .collect::<Vec<_>>()
        .join("\n");
    let tail = format!("  -- purge: {}\n{tail}", describe_counts(&purge.counts));

    format!("{PURGE_HEADER}begin;\n{statements}\n{cleanup}{tail}\ncommit;\n")
}

/// The header of a `--purge` teardown, in either form.
const PURGE_HEADER: &str = "-- Generated by `kizunasync deprovision --purge`. Drops every kizunasync._provisions\n\
     -- object in reverse dependency order, then the schema itself with every table,\n\
     -- sequence, index, policy, and grant in it, and every kizunasync role.\n\
     -- YOUR OWN tables are untouched; the sync bookkeeping, including the ledger, is not.\n";

/// The teardown as a migration file: the statements of
/// [`render_down_migration`] without its own `begin`/`commit`, like every
/// migration the pack ships, and each one that needs a table or the schema
/// run only when it exists, so a replay over a database the earlier files
/// left in another state still applies it.
#[must_use]
pub fn render_deprovision_migration(rows: &[ProvisionRow], purge: Option<&PurgeRequest>) -> String {
    let plan = build_drop_plan(rows);
    let mut statements: Vec<String> = plan
        .statements
        .iter()
        .map(|statement| ledger_statement(statement, Form::Migration))
        .collect();
    if let Some(cleanup) = cleanup_statement(&plan) {
        statements.push(when_relation_exists(
            &format!("{SCHEMA}.{INTERNAL_PROVISIONS}"),
            &cleanup,
        ));
    }
    let Some(purge) = purge else {
        return format!(
            "-- Generated by `kizunasync deprovision`. Drops every kizunasync._provisions object\n\
             -- in reverse dependency order. Your tables and data are untouched.\n{}\n",
            statements.join("\n")
        );
    };
    statements.push(format!("-- purge: {}", describe_counts(&purge.counts)));
    statements.extend(purge_tail(&purge.counts, Form::Migration));

    format!("{PURGE_HEADER}{}\n", statements.join("\n"))
}

/// The one DELETE that removes every `_provisions` row a statement of `plan`
/// drops (`pack-file` rows delete their own), `None` when there is none.
fn cleanup_statement(plan: &DropPlan) -> Option<String> {
    let pairs: Vec<String> = plan
        .statements
        .iter()
        .filter(|statement| statement.row.object_kind != ObjectKind::PackFile)
        .map(|statement| {
            format!(
                "('{}', '{}')",
                escape_literal(statement.row.object_kind.as_str()),
                escape_literal(&statement.row.object_name)
            )
        })
        .collect();
    if pairs.is_empty() {
        return None;
    }

    Some(format!(
        "delete from {SCHEMA}.{INTERNAL_PROVISIONS} where (object_kind, object_name) in ({});",
        pairs.join(", ")
    ))
}

/// How the teardown is written down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Form {
    /// One transaction over a database the plan was just read from.
    Transaction,
    /// A migration file, which a replay can apply over any state: every
    /// statement that needs a relation runs only when it exists.
    Migration,
}

/// `statement` as `form` writes it.
fn ledger_statement(statement: &DropStatement, form: Form) -> String {
    match (form, required_relation(&statement.row)) {
        (Form::Migration, Some(relation)) => when_relation_exists(&relation, &statement.sql),
        _ => statement.sql.clone(),
    }
}

/// The teardown the ledger does not name, as `form` writes it. The policies go
/// first so the plan names each one it removes, then the grants, then the
/// schema, which takes the tables, the sequence, the indexes, and the ledger
/// itself with it: the ledger is the last of the schema to go, because every
/// statement above it was read from it. [`ROLE_CLEANUP`] follows, which no
/// ledger row has to name. The migration form guards each policy and grant
/// statement on what it needs.
fn purge_tail(counts: &SchemaCounts, form: Form) -> Vec<String> {
    let schema_exists = format!("exists (select 1 from pg_namespace where nspname = '{SCHEMA}')");
    let mut statements: Vec<String> = counts
        .policies
        .iter()
        .map(|policy| match form {
            Form::Transaction => drop_schema_policy(policy),
            Form::Migration => when_relation_exists(
                &format!("{SCHEMA}.{}", quote_ident(&policy.table)),
                &drop_schema_policy(policy),
            ),
        })
        .collect();
    statements.extend(schema_revokes().iter().map(|revoke| match form {
        Form::Transaction => revoke.clone(),
        Form::Migration => guarded(&schema_exists, revoke),
    }));
    statements.push(drop_schema());
    statements.push(ROLE_CLEANUP.to_owned());

    statements
}

/// Every role named like the pack's, whatever the ledger says: what it owns in
/// this database goes, then the role, kept when another database of the
/// server still depends on it (the same rule as a ledgered role).
const ROLE_CLEANUP: &str = "do $$ declare role_name text; begin for role_name in select rolname from pg_roles where rolname like 'kizunasync%' loop execute format('drop owned by %I', role_name); begin execute format('drop role %I', role_name); exception when dependent_objects_still_exist then null; end; end loop; end $$;";

/// `statement`, run only when `relation` exists.
fn when_relation_exists(relation: &str, statement: &str) -> String {
    guarded(
        &format!("to_regclass('{}') is not null", escape_literal(relation)),
        statement,
    )
}

/// `statement` in a DO block that runs it only when `condition` holds. The
/// dollar-quote tag is one the body does not contain, so no name in it can
/// close the quoting: the body holds fewer tags than it has characters, so
/// one of the first that many is free.
fn guarded(condition: &str, statement: &str) -> String {
    let body = format!("begin if {condition} then {statement} end if; end");
    let tag = (0..=body.len())
        .map(|attempt| match attempt {
            0 => "$kizunasync$".to_owned(),
            _ => format!("$kizunasync{attempt}$"),
        })
        .find(|tag| !body.contains(tag.as_str()))
        .unwrap_or_default();

    format!("do {tag} {body} {tag};")
}

fn drop_schema_policy(policy: &SchemaPolicy) -> String {
    format!(
        "drop policy if exists {} on {SCHEMA}.{};",
        quote_ident(&policy.name),
        quote_ident(&policy.table)
    )
}

fn schema_revokes() -> Vec<String> {
    let mut revokes: Vec<String> = ["tables", "sequences", "routines"]
        .iter()
        .map(|object| {
            format!(
                "revoke all on all {object} in schema {SCHEMA} from public, anon, authenticated, service_role;"
            )
        })
        .collect();
    revokes.push(format!(
        "revoke usage on schema {SCHEMA} from authenticated, service_role;"
    ));

    revokes
}

fn drop_schema() -> String {
    format!("drop schema if exists {SCHEMA} cascade;")
}

fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// The size of what a purge removes, as the plan reports it.
#[must_use]
pub fn describe_counts(counts: &SchemaCounts) -> String {
    format!(
        "{} table(s), {} sequence(s), {} index(es), {} function(s), {} policy(ies)",
        counts.tables,
        counts.sequences,
        counts.indexes,
        counts.functions,
        counts.policies.len()
    )
}

fn escape_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// What `deprovision` was asked, as its flags or as the control panel's
/// answers.
#[derive(Debug, Clone, Copy, Default)]
pub struct DeprovisionRequest<'a> {
    /// Print the plan and stop.
    pub dry_run: bool,
    /// Confirm the destructive apply.
    pub yes: bool,
    /// Continue into the schema itself.
    pub purge: bool,
    /// The target typed out for the purge.
    pub confirm: Option<&'a str>,
}

/// How the teardown reaches the database.
pub enum Delivery<'a> {
    /// One transaction, run through the function.
    Direct(&'a dyn Fn(&str) -> Result<()>),
    /// A migration in the project, applied with `supabase db push`.
    Migration(MigrationPush<'a>),
}

impl Delivery<'_> {
    const fn form(&self) -> Form {
        match self {
            Self::Direct(_) => Form::Transaction,
            Self::Migration(_) => Form::Migration,
        }
    }
}

/// What a [`Delivery::Migration`] writes and pushes with.
pub struct MigrationPush<'a> {
    /// The database `supabase db push` addresses.
    pub direct: &'a DirectConnection,
    /// The project the migration is written into.
    pub paths: &'a ProjectPaths,
    /// Reads the migration history before anything is written.
    pub schemas: &'a dyn SchemaSource,
    /// Runs `supabase db push`.
    pub supabase: &'a dyn SupabaseCli,
    /// The current instant in UTC epoch seconds, for the migration's name.
    pub now_unix: i64,
}

/// Where `--purge` takes `kizunasync` out of the Data API's exposed schemas,
/// before the schema goes: PostgREST cannot build its schema cache while an
/// exposed schema is missing (PGRST002), and the whole Data API stops. A
/// plain teardown keeps the schema, and with it the exposure.
pub enum Exposure<'a> {
    /// The hosted project's PostgREST config, through the Management API.
    ManagementApi {
        /// The project's exposed-schema list.
        api: &'a dyn ExposedSchemas,
        /// The project, which the next step after an unknown outcome names.
        project_ref: &'a ProjectRef,
    },
    /// `[api].schemas` in this `supabase/config.toml`.
    ConfigToml(&'a Path),
    /// A connection no config file describes: the plan warns to do it by hand.
    ByHand,
}

/// What the Data API step changed before the purge, which a purge that did
/// not apply puts back.
enum Unexposed<'a> {
    /// Nothing.
    Nothing,
    /// The Management API list of this project no longer holds the schema.
    Listed {
        api: &'a dyn ExposedSchemas,
        project_ref: &'a ProjectRef,
    },
    /// `supabase/config.toml` held `body` before the step.
    ConfigToml { path: &'a Path, body: String },
}

/// The label `init` puts before its exposure line.
const DATA_API: &str = "  Data API:         ";

/// The warning a purge over a connection no config file describes prints.
const BY_HAND: &str = "  Data API:         remove kizunasync from this project's Data API exposed schemas (dashboard: Project Settings, Data API) before this purge, or the Data API stops serving every schema (PGRST002) until you do; or run the purge with --project-ref, which does it for you";

/// What follows the removal from `supabase/config.toml`.
const RESTART: &str = "the local stack reads it at start, so restart it (`supabase stop`, then `supabase start`) after the purge";

/// The refusal when the schema is the only one the project exposes.
const ONLY_EXPOSED: &str = "kizunasync deprovision: refusing, kizunasync is the only exposed schema of this project, and the Data API cannot run with none. Expose the schemas your app uses in its place (Project Settings, Data API), then run this again. Nothing was applied.";

/// The refusal when the schema is the only entry of `[api].schemas`.
const ONLY_ENTRY: &str = "kizunasync deprovision: refusing, kizunasync is the only entry in [api].schemas of supabase/config.toml, and the Data API cannot run with none. Put the schemas your app uses in its place, then run this again. Nothing was applied.";

/// The line for a schema the Management API's list does not hold.
const NOT_EXPOSED: &str = "  Data API:         kizunasync is not exposed";

/// The line for a `supabase/config.toml` that does not list the schema.
const NOT_IN_CONFIG: &str = "  Data API:         supabase/config.toml does not expose kizunasync";

/// The line for a `supabase/config.toml` that does not parse, left untouched.
const CONFIG_UNPARSEABLE: &str = "  Data API:         supabase/config.toml does not parse: left untouched. Remove \"kizunasync\" from [api].schemas by hand.";

/// The wait between two reads while a removal reaches the Management API's
/// list.
const CONVERGE_EVERY: Duration = Duration::from_secs(3);

/// The reads at most, [`CONVERGE_EVERY`] apart: 60 s in all.
const CONVERGE_READS: u32 = 20;

/// A teardown that did not apply: the exit code, the migration file it left
/// in the project when it wrote one, and whether it committed.
struct Unapplied {
    code: i32,
    written: Option<String>,
    committed: Committed,
}

/// What is known about whether a teardown that failed committed.
enum Committed {
    /// It did not: the database refused the script, or the migration history
    /// does not record the file.
    No,
    /// It may have, for this reason: the connection gave up without the
    /// database's answer, or the history records the file or cannot be read.
    Unknown(String),
}

/// The suffix of the migration a teardown writes.
pub const MIGRATION_LABEL: &str = "kizunasync_deprovision";

/// Whether a teardown in `paths` is delivered as a migration: the project is
/// one `supabase db push` applies, as `init` writes it.
#[must_use]
pub fn delivers_by_migration(paths: &ProjectPaths) -> bool {
    paths.config_toml.is_file()
}

/// The whole command over a connection the caller already resolved: read the
/// ledger, count what a purge would remove, then [`plan_and_apply`]. `target`
/// is the word a purge is confirmed with: [`expected_confirmation`] of a
/// connection string, or the project ref. A ledger a purge already removed
/// reads as empty.
pub fn run_over(
    applier: &dyn Applier,
    target: &str,
    request: &DeprovisionRequest<'_>,
    delivery: &Delivery<'_>,
    exposure: &Exposure<'_>,
    env: &Env,
    ui: &mut Ui,
) -> i32 {
    let present = is_ledger_present(applier);
    let rows = match present.and_then(|present| {
        if present {
            read_ledger(applier)
        } else {
            Ok(Vec::new())
        }
    }) {
        Ok(rows) => rows,
        Err(cause) => {
            ui.log(&format!(
                "kizunasync deprovision: could not read the ledger:\n  {cause}"
            ));

            return UNUSABLE;
        }
    };
    let purge = if request.purge {
        match read_schema_counts(applier) {
            Ok(counts) => Some(PurgeRequest {
                expected: target.to_owned(),
                typed: request.confirm.map(ToOwned::to_owned),
                counts,
            }),
            Err(cause) => {
                ui.log(&format!(
                    "kizunasync deprovision: could not read what the schema holds:\n  {cause}"
                ));

                return UNUSABLE;
            }
        }
    } else {
        None
    };
    let flags = DeprovisionFlags {
        dry_run: request.dry_run,
        yes: request.yes,
        local_only: false,
        purge,
    };

    plan_and_apply(&rows, &flags, env, applier, delivery, exposure, ui)
}

/// [`run_over`] through the Management API: the plan is read and applied
/// through `api` as one transaction, a purge is confirmed with `project_ref`,
/// and before it runs `kizunasync` leaves the project's exposed schemas.
pub fn run_over_api<A: Applier + ExposedSchemas>(
    api: &A,
    project_ref: &ProjectRef,
    request: &DeprovisionRequest<'_>,
    env: &Env,
    ui: &mut Ui,
) -> i32 {
    let execute = |sql: &str| api.run_script(sql);

    run_over(
        api,
        project_ref.as_str(),
        request,
        &Delivery::Direct(&execute),
        &Exposure::ManagementApi { api, project_ref },
        env,
        ui,
    )
}

/// Refuse a ledger a newer kizunasync recorded, and anything outside the
/// schema that depends on the pack, then print the plan, then apply it if the
/// guard allows. `read` answers the ledger's `pack-file` versions and the
/// `pg_depend` read. A purge takes `kizunasync` out of `exposure` first.
/// Separated from transport resolution so tests drive it with injected rows,
/// a fake read port, and a fake delivery, never touching a live schema.
pub fn plan_and_apply(
    rows: &[ProvisionRow],
    flags: &DeprovisionFlags,
    env: &Env,
    read: &dyn Applier,
    delivery: &Delivery<'_>,
    exposure: &Exposure<'_>,
    ui: &mut Ui,
) -> i32 {
    if let Some(code) = refuse_newer_pack(read, ui) {
        return code;
    }
    if let Some(code) = refuse_external_dependents(read, rows, ui) {
        return code;
    }

    let plan = build_drop_plan(rows);
    let audit = audit_object_names(rows);

    // Print the plan first, always. The DROP statements are the machine-stable
    // payload (stdout); the surrounding chrome is human status (stderr).
    ui.log(if flags.purge.is_some() {
        "kizunasync deprovision --purge: plan (reverse dependency order, then the schema)\n"
    } else {
        "kizunasync deprovision: plan (reverse dependency order)\n"
    });
    if plan.statements.is_empty() && flags.purge.is_none() {
        ui.log("  the ledger is empty, nothing to deprovision.");

        return OK;
    }

    if flags.purge.is_some()
        && let Some(code) = preview_exposure(exposure, ui)
    {
        return code;
    }
    print_plan(&plan, &audit, flags, delivery.form(), ui);

    if let Some(code) = guard_before_apply(flags, env, ui) {
        return code;
    }

    let unexposed = if flags.purge.is_some() {
        match unexpose_first(exposure, ui) {
            Ok(unexposed) => unexposed,
            Err(code) => return code,
        }
    } else {
        Unexposed::Nothing
    };
    let applied = match delivery {
        Delivery::Direct(execute) => execute(&render_down_migration(rows, flags.purge.as_ref()))
            .map_err(|cause| {
                ui.log(&format!("\n  deprovision apply failed:\n    {cause}"));

                Unapplied {
                    code: FAILURE,
                    written: None,
                    committed: match cause {
                        // The database answered: the transaction rolled back.
                        crate::error::Error::Sql { .. } => Committed::No,
                        other => Committed::Unknown(other.to_string()),
                    },
                }
            }),
        Delivery::Migration(push) => write_and_push(
            push,
            &render_deprovision_migration(rows, flags.purge.as_ref()),
            ui,
        ),
    };
    if let Err(unapplied) = applied {
        expose_again(&unexposed, read, &unapplied, ui);

        return unapplied.code;
    }

    print_apply_summary(&plan, flags, ui);
    report_kept_roles(&plan, read, ui);

    OK
}

/// What the plan says about the Data API step, read before anything changes.
enum Preview {
    /// The line the plan prints.
    Line(String),
    /// Nothing this run can edit: the warning.
    ByHand,
    /// The schema is the only one the Management API's list holds.
    OnlyExposed,
    /// The schema is the only entry of `[api].schemas`.
    OnlyEntry,
    /// The list could not be read, for this reason.
    Unreadable(String),
}

fn read_preview(exposure: &Exposure<'_>) -> Preview {
    match exposure {
        Exposure::ManagementApi { api, .. } => match api.exposed_schemas() {
            Ok(exposed) => match unexpose_outcome(&exposed, SCHEMA) {
                UnexposeOutcome::Removed => Preview::Line(removed_line("would remove")),
                UnexposeOutcome::NotPresent => Preview::Line(NOT_EXPOSED.to_owned()),
                UnexposeOutcome::OnlyExposed => Preview::OnlyExposed,
            },
            Err(cause) => Preview::Unreadable(cause.to_string()),
        },
        Exposure::ConfigToml(path) => match read_config(path) {
            Ok(body) => match unpatch_api_schemas(&body).outcome {
                UnpatchOutcome::Removed => Preview::Line(config_removed_line("would remove")),
                UnpatchOutcome::NotPresent => Preview::Line(NOT_IN_CONFIG.to_owned()),
                UnpatchOutcome::Unparseable => Preview::Line(CONFIG_UNPARSEABLE.to_owned()),
                UnpatchOutcome::OnlyEntry => Preview::OnlyEntry,
            },
            Err(cause) => Preview::Unreadable(cause),
        },
        Exposure::ByHand => Preview::ByHand,
    }
}

/// Print what the Data API step will do, ahead of the plan since it runs
/// first. `Some(2)` refuses the purge before anything changes: the list
/// cannot be read, or the schema is the only one it holds.
fn preview_exposure(exposure: &Exposure<'_>, ui: &mut Ui) -> Option<i32> {
    match read_preview(exposure) {
        Preview::Line(line) => {
            ui.log(&line);

            None
        }
        Preview::ByHand => {
            ui.warn(BY_HAND);

            None
        }
        Preview::OnlyExposed => Some(refuse(ONLY_EXPOSED, ui)),
        Preview::OnlyEntry => Some(refuse(ONLY_ENTRY, ui)),
        Preview::Unreadable(cause) => Some(unreadable(&cause, ui)),
    }
}

/// What a purge would do to the Data API, for a plan confirmed before the
/// purge is chosen: the control panel's removal shows it ahead of its typed
/// confirmation. A purge the step would refuse is named here, not refused.
pub fn announce_exposure(exposure: &Exposure<'_>, ui: &mut Ui) {
    ui.log("\n  a purge also takes kizunasync out of the Data API first:");
    match read_preview(exposure) {
        Preview::Line(line) => ui.log(&line),
        Preview::ByHand => ui.warn(BY_HAND),
        Preview::OnlyExposed => ui.warn(&format!(
            "{DATA_API}{SCHEMA} is the only exposed schema of this project, so a purge would be refused"
        )),
        Preview::OnlyEntry => ui.warn(&format!(
            "{DATA_API}{SCHEMA} is the only entry in [api].schemas, so a purge would be refused"
        )),
        Preview::Unreadable(cause) => ui.warn(&format!(
            "{DATA_API}could not read the exposed schemas: {cause}"
        )),
    }
}

fn refuse(reason: &str, ui: &mut Ui) -> i32 {
    ui.error(reason);

    UNUSABLE
}

fn unreadable(cause: &str, ui: &mut Ui) -> i32 {
    ui.error(&format!(
        "kizunasync deprovision: could not read the exposed schemas:\n  {cause}\n  nothing was applied."
    ));

    UNUSABLE
}

/// The Data API step, before the purge: what it changed, or the exit code
/// once the reason is on `ui` and nothing was dropped.
fn unexpose_first<'a>(
    exposure: &Exposure<'a>,
    ui: &mut Ui,
) -> std::result::Result<Unexposed<'a>, i32> {
    match exposure {
        Exposure::ManagementApi { api, project_ref } => unexpose_over_api(*api, project_ref, ui),
        Exposure::ConfigToml(path) => unexpose_in_config(path, ui),
        Exposure::ByHand => Ok(Unexposed::Nothing),
    }
}

/// Drop the schema from the Management API's list, then read the list every
/// [`CONVERGE_EVERY`] until it no longer holds the schema: the API applies a
/// PATCH some time after it answers it, and the purge must not run before.
fn unexpose_over_api<'a>(
    api: &'a dyn ExposedSchemas,
    project_ref: &'a ProjectRef,
    ui: &mut Ui,
) -> std::result::Result<Unexposed<'a>, i32> {
    match api.unexpose_schema(SCHEMA) {
        Ok(UnexposeOutcome::Removed) => {}
        Ok(UnexposeOutcome::NotPresent) => {
            ui.log(NOT_EXPOSED);

            return Ok(Unexposed::Nothing);
        }
        Ok(UnexposeOutcome::OnlyExposed) => return Err(refuse(ONLY_EXPOSED, ui)),
        Err(cause) => return Err(not_removed(&cause.to_string(), ui)),
    }

    for _ in 0..CONVERGE_READS {
        api.wait(CONVERGE_EVERY);
        match api.exposed_schemas() {
            Ok(exposed) if !exposed.iter().any(|entry| entry == SCHEMA) => {
                ui.log(&removed_line("removed"));

                return Ok(Unexposed::Listed { api, project_ref });
            }
            Ok(_) => {}
            Err(cause) => {
                ui.error(&format!(
                    "{DATA_API}the removal of {SCHEMA} from the exposed schemas was accepted but could not be confirmed ({cause}), so nothing was dropped; run the same command again."
                ));

                return Err(FAILURE);
            }
        }
    }
    ui.error(&format!(
        "{DATA_API}the removal of {SCHEMA} from the exposed schemas was requested but Supabase has not applied it yet, so nothing was dropped; run the same command again."
    ));

    Err(FAILURE)
}

/// Take the schema out of `[api].schemas` before the purge.
fn unexpose_in_config<'a>(path: &'a Path, ui: &mut Ui) -> std::result::Result<Unexposed<'a>, i32> {
    let body = read_config(path).map_err(|cause| not_removed(&cause, ui))?;
    let unpatch = unpatch_api_schemas(&body);
    match unpatch.outcome {
        UnpatchOutcome::Removed => {
            std::fs::write(path, &unpatch.body).map_err(|cause| {
                not_removed(
                    &format!("could not write supabase/config.toml: {cause}"),
                    ui,
                )
            })?;
            ui.log(&format!("{}; {RESTART}", config_removed_line("removed")));

            Ok(Unexposed::ConfigToml { path, body })
        }
        UnpatchOutcome::NotPresent => {
            ui.log(NOT_IN_CONFIG);

            Ok(Unexposed::Nothing)
        }
        UnpatchOutcome::Unparseable => {
            ui.log(CONFIG_UNPARSEABLE);

            Ok(Unexposed::Nothing)
        }
        UnpatchOutcome::OnlyEntry => Err(refuse(ONLY_ENTRY, ui)),
    }
}

fn not_removed(cause: &str, ui: &mut Ui) -> i32 {
    ui.error(&format!(
        "{DATA_API}could not remove {SCHEMA} from the exposed schemas:\n    {cause}\n  nothing was dropped. Run the same command again."
    ));

    FAILURE
}

/// Put back what the Data API step changed, only when the purge is known
/// not to have committed and the schema is still there: exposing a schema the
/// failed run dropped after all would stop the Data API (PGRST002). Best
/// effort: every outcome is reported, and the purge's own failure stays the
/// exit code. When a put-back follows a written migration, the run says that
/// file still drops the schema the list holds again.
fn expose_again(unexposed: &Unexposed<'_>, read: &dyn Applier, unapplied: &Unapplied, ui: &mut Ui) {
    let next_step = match unexposed {
        Unexposed::Nothing => return,
        Unexposed::Listed { project_ref, .. } => format!(
            "so {SCHEMA} stays unexposed; run `kizunasync status --project-ref {project_ref}`: if the schema is still there, `kizunasync init --project-ref {project_ref}` exposes it again"
        ),
        Unexposed::ConfigToml { .. } => format!(
            "so supabase/config.toml stays without {SCHEMA}; run `kizunasync status`: if the schema is still there, `kizunasync init` exposes it again"
        ),
    };
    if let Committed::Unknown(cause) = &unapplied.committed {
        ui.warn(&format!(
            "{DATA_API}the purge's outcome is unknown ({cause}), {next_step}"
        ));

        return;
    }
    match schema_present(read) {
        Ok(true) => {}
        Ok(false) => {
            ui.log(&format!(
                "{DATA_API}the {SCHEMA} schema is gone, so {SCHEMA} stays unexposed"
            ));

            return;
        }
        Err(cause) => {
            ui.warn(&format!(
                "{DATA_API}could not read whether the {SCHEMA} schema still exists ({cause}), so {SCHEMA} stays unexposed: the schema may be gone"
            ));

            return;
        }
    }

    let holder = match unexposed {
        Unexposed::Nothing => return,
        Unexposed::Listed { api, .. } => match api.expose_schema(SCHEMA) {
            Ok(_) => {
                ui.log(&format!(
                    "{DATA_API}exposed {SCHEMA} again, since the purge did not apply"
                ));

                "the project's exposed schemas list"
            }
            Err(cause) => {
                ui.error(&format!(
                    "{DATA_API}could not expose {SCHEMA} again after the failed purge:\n    {cause}\n  add it back to the project's exposed schemas (Project Settings, Data API)."
                ));

                return;
            }
        },
        Unexposed::ConfigToml { path, body } => match std::fs::write(path, body) {
            Ok(()) => {
                ui.log(&format!(
                    "{DATA_API}put supabase/config.toml back, since the purge did not apply"
                ));

                "supabase/config.toml lists"
            }
            Err(cause) => {
                ui.error(&format!(
                    "{DATA_API}could not put supabase/config.toml back:\n    {cause}\n  add \"{SCHEMA}\" to [api].schemas again by hand."
                ));

                return;
            }
        },
    };
    if let Some(file) = &unapplied.written {
        ui.log(&format!(
            "  the migration {file} drops the schema while {holder} {SCHEMA} again, so run `kizunasync deprovision --purge` again instead of pushing {file} by hand."
        ));
    }
}

/// Whether the `kizunasync` schema exists.
fn schema_present(read: &dyn Applier) -> Result<bool> {
    let rows = read.run_query(&format!(
        "select exists (select 1 from pg_namespace where nspname = '{SCHEMA}') as present;"
    ))?;
    let Some(row) = rows.first() else {
        return Err(crate::error::Error::Boundary(
            "the schema probe returned no row, expected exactly 1".to_owned(),
        ));
    };

    require_bool(row, "present")
}

fn read_config(path: &Path) -> std::result::Result<String, String> {
    std::fs::read_to_string(path)
        .map_err(|cause| format!("could not read supabase/config.toml: {cause}"))
}

/// The Management API line for the removal, `removal` naming it as planned
/// or as done.
fn removed_line(removal: &str) -> String {
    format!("{DATA_API}{removal} {SCHEMA} from the exposed schemas")
}

/// The `supabase/config.toml` line for the removal, `removal` naming it as
/// planned or as done.
fn config_removed_line(removal: &str) -> String {
    format!("{DATA_API}{removal} \"{SCHEMA}\" from [api].schemas in supabase/config.toml")
}

/// Write `sql` as the next migration, named past every version the project
/// and the migration history hold, then push it the way `init` pushes its
/// own. The history is compared first, so a drifted one stops the run before
/// anything is written.
fn write_and_push(
    push: &MigrationPush<'_>,
    sql: &str,
    ui: &mut Ui,
) -> std::result::Result<(), Unapplied> {
    let unwritten = |code| Unapplied {
        code,
        written: None,
        committed: Committed::No,
    };
    let mut taken = gate_migration_history(
        push.direct,
        push.paths,
        push.schemas,
        push.supabase,
        &mut None,
        ui,
    )
    .map_err(unwritten)?;
    taken.extend(local_versions(&push.paths.migrations_dir));
    let name = format!(
        "{}_{MIGRATION_LABEL}.sql",
        migration_version(next_migration_second(push.now_unix, &taken))
    );
    let written = std::fs::create_dir_all(&push.paths.migrations_dir)
        .and_then(|()| std::fs::write(push.paths.migrations_dir.join(&name), sql));
    if let Err(cause) = written {
        ui.error(&format!(
            "\n  could not write {name}:\n    {cause}\n  nothing was applied."
        ));

        return Err(unwritten(FAILURE));
    }
    ui.log(&format!("\n  emitted {name}"));
    push_written(
        push.direct,
        push.paths,
        std::slice::from_ref(&name),
        push.schemas,
        push.supabase,
        &mut None,
        ui,
    )
    .map_err(|code| Unapplied {
        code,
        committed: pushed_or_not(push, &name),
        written: Some(name.clone()),
    })?;
    ui.log(&format!(
        "  applied via supabase db push {}.",
        push.direct.push.describe()
    ));

    Ok(())
}

/// Whether the teardown `name` a failed push left committed, as the migration
/// history read again says: not recorded is not applied; recorded, or a
/// history that cannot be read, leaves it unknown.
fn pushed_or_not(push: &MigrationPush<'_>, name: &str) -> Committed {
    match push.schemas.applied_migrations(&push.direct.url) {
        Ok(applied) if !is_recorded(name, &applied) => Committed::No,
        Ok(_) => Committed::Unknown(format!("the migration history records {name} as applied")),
        Err(cause) => Committed::Unknown(format!("could not read the migration history: {cause}")),
    }
}

/// `Some(2)` when a newer kizunasync recorded one of the ledger's
/// `pack-file` rows, whose objects this build does not know, or when that
/// cannot be read: either way nothing is planned or applied.
fn refuse_newer_pack(read: &dyn Applier, ui: &mut Ui) -> Option<i32> {
    match read_ledger_rows(read) {
        Ok(rows) => refuse_newer_ledger(&rows, ui),
        Err(cause) => {
            ui.error(&format!(
                "kizunasync deprovision: could not read the ledger's pack versions:\n  {cause}\n  nothing was applied."
            ));

            Some(UNUSABLE)
        }
    }
}

/// `Some(2)` when an object outside the schema depends on the pack, or when
/// that cannot be read: either way nothing is planned or applied.
fn refuse_external_dependents(
    read: &dyn Applier,
    rows: &[ProvisionRow],
    ui: &mut Ui,
) -> Option<i32> {
    let dependents = match read_external_dependents(read, rows) {
        Ok(dependents) => dependents,
        Err(cause) => {
            ui.error(&format!(
                "kizunasync deprovision: could not read what depends on the pack:\n  {cause}\n  nothing was applied."
            ));

            return Some(UNUSABLE);
        }
    };
    if dependents.is_empty() {
        return None;
    }

    let lines: Vec<String> = dependents
        .iter()
        .map(|dependent| {
            format!(
                "    ! {} {} depends on {}",
                dependent.kind, dependent.identity, dependent.depends_on
            )
        })
        .collect();
    ui.error(&format!(
        "kizunasync deprovision: refusing, these objects outside the {SCHEMA} schema depend on the pack:\n{}\n  the drops cascade, so they would be dropped with it. Drop them or remove what they use from {SCHEMA}, then run this again. Nothing was applied.",
        lines.join("\n")
    ));

    Some(UNUSABLE)
}

/// The DROP statements in dependency order and `--purge`'s own statements,
/// as `form` writes them, and any warnings or ledger-format notes. Print-only: nothing here decides
/// whether the run continues.
fn print_plan(
    plan: &DropPlan,
    audit: &CanonicalizationReport,
    flags: &DeprovisionFlags,
    form: Form,
    ui: &mut Ui,
) {
    for statement in &plan.statements {
        ui.write_stdout(&format!(
            "  [{}] {}\n",
            statement.row.object_kind.as_str(),
            ledger_statement(statement, form)
        ));
    }
    if let Some(purge) = &flags.purge {
        for statement in purge_tail(&purge.counts, form) {
            ui.write_stdout(&format!("  [purge] {statement}\n"));
        }
    }
    if !plan.warnings.is_empty() {
        ui.log("\n  WARNINGS (rows that did NOT produce a DROP: review by hand):");
        for warning in &plan.warnings {
            ui.log(&format!(
                "    ! [{}] {}: {}",
                warning.row.object_kind.as_str(),
                warning.row.object_name,
                warning.reason
            ));
        }
    }
    if audit.warranted {
        ui.log("\n  NOTE: the ledger mixes object_name formats:");
        for note in &audit.notes {
            ui.log(&format!("    · {note}"));
        }
    }

    if let Some(purge) = &flags.purge {
        ui.log(&format!(
            "\n  --purge also removes the {SCHEMA} schema: {}.",
            describe_counts(&purge.counts)
        ));
        ui.log("  Every row of sync bookkeeping goes with it, including the ledger. Your own tables are untouched.");
    }
}

/// The three gates between showing the plan and running it: `--dry-run`
/// stops here, the destructive-by-default confirmation, and `--purge`'s own
/// typed confirmation. `None` means every gate passed.
fn guard_before_apply(flags: &DeprovisionFlags, env: &Env, ui: &mut Ui) -> Option<i32> {
    if flags.dry_run {
        ui.log("\n  --dry-run: plan shown; nothing applied.");

        return Some(OK);
    }

    if !(flags.yes || env.equals("KSYNC_ALLOW_DEPROVISION", "1")) {
        ui.log("\n  this is destructive. Re-run with --yes (or set KSYNC_ALLOW_DEPROVISION=1) to apply.");

        return Some(UNUSABLE);
    }

    if let Some(purge) = &flags.purge
        && !purge.confirmed()
    {
        ui.error(&format!(
            "\n  --purge needs the target typed out: --yes alone does not apply it.\n  \
             Re-run with --confirm {} (the project ref, or \"{LOCAL_TARGET}\" for a connection that names no project).",
            purge.expected
        ));

        return Some(UNUSABLE);
    }

    None
}

/// What ran: how many objects the ledger's own DROP statements removed, plus
/// `--purge`'s schema-level count when it applied.
fn print_apply_summary(plan: &DropPlan, flags: &DeprovisionFlags, ui: &mut Ui) {
    ui.log(&format!(
        "\n  deprovisioned {} object(s).",
        plan.statements.len()
    ));
    if let Some(purge) = &flags.purge {
        ui.log(&format!(
            "  purged the {SCHEMA} schema: {}.",
            describe_counts(&purge.counts)
        ));
    }
}

/// Every role the plan dropped that is still there after the apply. Its drop
/// met 2BP01 inside its savepoint: another database of this server still owns
/// objects through it, so the role stays and the teardown committed anyway.
fn report_kept_roles(plan: &DropPlan, read: &dyn Applier, ui: &mut Ui) {
    let dropped: Vec<String> = plan
        .statements
        .iter()
        .filter(|statement| statement.row.object_kind == ObjectKind::Role)
        .map(|statement| format!("'{}'", escape_literal(&statement.row.object_name)))
        .collect();
    if dropped.is_empty() {
        return;
    }

    let query = format!(
        "select rolname from pg_roles where rolname in ({}) order by 1;",
        dropped.join(", ")
    );
    let kept = match read.run_query(&query) {
        Ok(kept) => kept,
        Err(cause) => {
            ui.warn(&format!(
                "  could not check whether the pack's role was dropped:\n    {cause}"
            ));

            return;
        }
    };
    for row in &kept {
        match require_string(row, "rolname") {
            Ok(role) => ui.log(&format!(
                "  kept the role {role}: other databases of this server still use it. To drop it later, run `drop owned by {role};` in each database that still uses it, then `drop role {role};`."
            )),
            Err(cause) => ui.warn(&format!(
                "  could not check whether the pack's role was dropped:\n    {cause}"
            )),
        }
    }
}

/// `--local-only` has no ledger to read; say so instead of pretending.
pub fn refuse_local_only(ui: &mut Ui) -> i32 {
    ui.log(
        "kizunasync deprovision: --local-only has no ledger to read (the ledger lives in your\n  project DB). Run without --local-only against a resolvable database.",
    );

    UNUSABLE
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::time::Duration;

    use serde_json::Value;

    use super::*;
    use crate::applier::fake::{FakeApplier, row, text_row};
    use crate::config::KizunaSyncConfig;
    use crate::error::Error;
    use crate::management::ExposeOutcome;
    use crate::migration_history::AppliedMigration;
    use crate::migration_history::fake::recorded;
    use crate::proposals::SchemaCatalog;
    use crate::row::Row;
    use crate::server_facts::ServerFacts;
    use crate::supabase_cli::PushTarget;
    use crate::supabase_cli::fake::RecordingCli;
    use crate::ui::Capture;

    fn provision(kind: &str, name: &str) -> ProvisionRow {
        ProvisionRow {
            object_kind: ObjectKind::parse(kind),
            object_name: name.to_owned(),
            object_args: None,
        }
    }

    struct Recorder {
        applied: RefCell<Vec<String>>,
        fail: bool,
    }

    impl Recorder {
        fn new(fail: bool) -> Self {
            Self {
                applied: RefCell::new(Vec::new()),
                fail,
            }
        }

        fn execute(&self) -> impl Fn(&str) -> Result<()> + '_ {
            move |sql: &str| {
                self.applied.borrow_mut().push(sql.to_owned());
                if self.fail {
                    return Err(Error::Db("relation does not exist".to_owned()));
                }

                Ok(())
            }
        }
    }

    /// The probe [`crate::provision::read_ledger_rows`] opens with.
    const LEDGER_PRESENT: &str = "to_regclass('kizunasync._provisions')";

    /// The read port of a database whose ledger this build wrote: it
    /// exists, and no `pack-file` row names a newer build.
    fn read_port() -> FakeApplier {
        FakeApplier::new().answer(LEDGER_PRESENT, vec![text_row(&[("present", "t")])])
    }

    /// A database where nothing outside the schema depends on the pack.
    fn drive(
        rows: &[ProvisionRow],
        flags: &DeprovisionFlags,
        env: &Env,
        recorder: &Recorder,
    ) -> (i32, Capture) {
        drive_over(&read_port(), rows, flags, env, recorder)
    }

    fn drive_over(
        read: &FakeApplier,
        rows: &[ProvisionRow],
        flags: &DeprovisionFlags,
        env: &Env,
        recorder: &Recorder,
    ) -> (i32, Capture) {
        let (mut ui, capture) = Ui::capture();
        let execute = recorder.execute();
        let code = plan_and_apply(
            rows,
            flags,
            env,
            read,
            &Delivery::Direct(&execute),
            &Exposure::ByHand,
            &mut ui,
        );

        (code, capture)
    }

    fn dependent(kind: &str, identity: &str, ledger_name: &str, depends_on: &str) -> Row {
        text_row(&[
            ("kind", kind),
            ("identity", identity),
            ("ledger_name", ledger_name),
            ("depends_on", depends_on),
        ])
    }

    /// What `pg_depend` answers on a provisioned project that also carries a
    /// view over a pack table: the ledgered trigger on `todos` and the view.
    fn depends_on_the_pack() -> FakeApplier {
        read_port().answer(
            "from pg_depend",
            vec![
                dependent(
                    "trigger",
                    "kizunasync_track_change on public.todos",
                    "public.todos.kizunasync_track_change",
                    "function kizunasync.track_change()",
                ),
                dependent(
                    "view",
                    "public.todo_feed",
                    "public.todo_feed._RETURN",
                    "table kizunasync._changelog",
                ),
            ],
        )
    }

    fn ledgered_todos() -> Vec<ProvisionRow> {
        vec![
            provision("function", "kizunasync.track_change"),
            provision("trigger", "public.todos.kizunasync_track_change"),
            provision("config", "public.todos"),
        ]
    }

    #[test]
    fn the_dependents_read_leaves_out_what_the_ledger_records() {
        let dependents =
            read_external_dependents(&depends_on_the_pack(), &ledgered_todos()).unwrap();

        assert_eq!(
            dependents,
            [ExternalDependent {
                kind: "view".to_owned(),
                identity: "public.todo_feed".to_owned(),
                depends_on: "table kizunasync._changelog".to_owned(),
            }]
        );
    }

    /// A ledger row only excuses the object it names, and of the kind it
    /// records: a trigger that shares a ledgered policy's name is still a
    /// dependent.
    #[test]
    fn a_ledger_row_excuses_only_its_own_kind_and_name() {
        let read = FakeApplier::new().answer(
            "from pg_depend",
            vec![dependent(
                "trigger",
                "audit on public.todos",
                "public.todos.audit",
                "function kizunasync.track_change()",
            )],
        );
        let rows = [provision("policy", "public.todos.audit")];

        assert_eq!(read_external_dependents(&read, &rows).unwrap().len(), 1);
    }

    #[test]
    fn the_dependents_read_asks_pg_depend_for_objects_outside_the_schema_only() {
        let read = FakeApplier::new();
        read_external_dependents(&read, &[]).unwrap();
        let executed = read.executed.borrow();

        assert_eq!(executed.len(), 1);
        assert!(executed[0].contains("from pg_depend d"), "{}", executed[0]);
        assert!(executed[0].contains("d.deptype in ('n', 'a')"));
        assert!(executed[0].contains("referenced.schema = 'kizunasync'"));
        assert!(executed[0].contains("address.object_names[1] is distinct from 'kizunasync'"));
    }

    /// The drops cascade, so an object outside the schema that uses the pack
    /// would go with it: the run stops before the plan, listing it, whatever
    /// the flags allow.
    #[test]
    fn an_external_dependent_refuses_the_run_before_anything_is_planned() {
        for flags in [
            DeprovisionFlags {
                yes: true,
                ..DeprovisionFlags::default()
            },
            DeprovisionFlags {
                yes: true,
                purge: Some(purge_request(Some(LOCAL_TARGET))),
                ..DeprovisionFlags::default()
            },
            DeprovisionFlags {
                dry_run: true,
                ..DeprovisionFlags::default()
            },
        ] {
            let recorder = Recorder::new(false);
            let (code, capture) = drive_over(
                &depends_on_the_pack(),
                &ledgered_todos(),
                &flags,
                &Env::default(),
                &recorder,
            );
            let stderr = capture.stderr();

            assert_eq!(code, UNUSABLE, "{flags:?}");
            assert!(
                stderr
                    .contains("    ! view public.todo_feed depends on table kizunasync._changelog"),
                "{stderr}"
            );
            assert!(!stderr.contains("kizunasync_track_change on"), "{stderr}");
            assert!(stderr.contains("Nothing was applied."), "{stderr}");
            assert_eq!(capture.stdout(), "", "no plan is printed");
            assert!(recorder.applied.borrow().is_empty());
        }
    }

    #[test]
    fn a_dependents_read_that_fails_refuses_the_run() {
        let recorder = Recorder::new(false);
        let read = read_port().fail("from pg_depend", "permission denied for pg_depend");
        let flags = DeprovisionFlags {
            yes: true,
            ..DeprovisionFlags::default()
        };
        let (code, capture) =
            drive_over(&read, &ledgered_todos(), &flags, &Env::default(), &recorder);

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("could not read what depends on the pack")
        );
        assert!(capture.stderr().contains("permission denied for pg_depend"));
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn only_the_ledgered_dependents_let_the_run_through() {
        let recorder = Recorder::new(false);
        let read = read_port().answer(
            "from pg_depend",
            vec![dependent(
                "trigger",
                "kizunasync_track_change on public.todos",
                "public.todos.kizunasync_track_change",
                "function kizunasync.track_change()",
            )],
        );
        let flags = DeprovisionFlags {
            yes: true,
            ..DeprovisionFlags::default()
        };
        let (code, _) = drive_over(&read, &ledgered_todos(), &flags, &Env::default(), &recorder);

        assert_eq!(code, OK);
        assert_eq!(recorder.applied.borrow().len(), 1);
    }

    /// A ledger row a newer build wrote names a pack this build does not
    /// know, so the teardown is refused before anything is read or planned.
    #[test]
    fn a_ledger_a_newer_build_wrote_refuses_the_teardown_before_anything_is_planned() {
        for flags in [
            DeprovisionFlags {
                yes: true,
                ..DeprovisionFlags::default()
            },
            DeprovisionFlags {
                dry_run: true,
                ..DeprovisionFlags::default()
            },
            DeprovisionFlags {
                yes: true,
                purge: Some(purge_request(Some(LOCAL_TARGET))),
                ..DeprovisionFlags::default()
            },
        ] {
            let recorder = Recorder::new(false);
            let read = read_port().answer(
                "content_hash, pack_version",
                vec![text_row(&[
                    ("object_kind", "pack-file"),
                    ("object_name", "0001_kizuna_init.sql"),
                    ("content_hash", "recorded"),
                    ("pack_version", "99.0.0"),
                ])],
            );
            let (code, capture) =
                drive_over(&read, &ledgered_todos(), &flags, &Env::default(), &recorder);
            let stderr = capture.stderr();

            assert_eq!(code, UNUSABLE, "{flags:?}: {stderr}");
            assert!(
                stderr.contains("recorded by kizunasync 99.0.0, newer than this build"),
                "{stderr}"
            );
            assert!(stderr.contains("update kizunasync"), "{stderr}");
            assert_eq!(capture.stdout(), "", "no plan is printed");
            assert!(
                !read
                    .executed
                    .borrow()
                    .iter()
                    .any(|sql| sql.contains("from pg_depend")),
                "the refusal comes first"
            );
            assert!(recorder.applied.borrow().is_empty());
        }
    }

    #[test]
    fn the_ledger_read_maps_kinds_names_and_the_optional_signature() {
        let applier = FakeApplier::new().answer(
            "from kizunasync._provisions",
            vec![
                text_row(&[
                    ("object_kind", "function"),
                    ("object_name", "kizunasync.pull"),
                    ("object_args", "p_hlc text"),
                ]),
                row(&[
                    ("object_kind", Value::from("function")),
                    ("object_name", Value::from("kizunasync.reap_tombstones")),
                    ("object_args", Value::Null),
                ]),
                text_row(&[
                    ("object_kind", "config"),
                    ("object_name", "public.todos"),
                    ("object_args", ""),
                ]),
            ],
        );
        let rows = read_ledger(&applier).unwrap();

        assert_eq!(rows[0].object_args.as_deref(), Some("p_hlc text"));
        assert_eq!(rows[1].object_args, None);
        assert_eq!(rows[2].object_args, None);
        assert_eq!(rows[1].object_kind, ObjectKind::Function);
    }

    #[test]
    fn an_unknown_kind_survives_the_read_to_become_a_warning() {
        let applier = FakeApplier::new().answer(
            "from kizunasync._provisions",
            vec![text_row(&[
                ("object_kind", "gremlin"),
                ("object_name", "x"),
            ])],
        );
        let rows = read_ledger(&applier).unwrap();

        assert_eq!(
            rows[0].object_kind,
            ObjectKind::Unknown("gremlin".to_owned())
        );
    }

    fn purge_request(typed: Option<&str>) -> PurgeRequest {
        PurgeRequest {
            expected: LOCAL_TARGET.to_owned(),
            typed: typed.map(ToOwned::to_owned),
            counts: SchemaCounts {
                tables: 11,
                sequences: 1,
                indexes: 7,
                functions: 45,
                policies: vec![SchemaPolicy {
                    table: "attachments".to_owned(),
                    name: "Attachments are visible to their owner.".to_owned(),
                }],
            },
        }
    }

    #[test]
    fn the_down_migration_is_transactional_and_cleans_up_its_own_ledger_rows() {
        let sql = render_down_migration(
            &[
                provision("function", "kizunasync.reap_tombstones"),
                provision("config", "public.todos"),
            ],
            None,
        );

        assert!(sql.starts_with("-- Generated by `kizunasync deprovision`."));
        assert!(sql.contains("begin;\n"));
        assert!(
            sql.contains("  drop function if exists \"kizunasync\".\"reap_tombstones\" cascade;")
        );
        assert!(sql.contains(
            "delete from kizunasync._provisions where (object_kind, object_name) in (('function', 'kizunasync.reap_tombstones'), ('config', 'public.todos'));"
        ));
        assert!(sql.trim_end().ends_with("commit;"));
    }

    #[test]
    fn a_pack_file_row_is_not_cleaned_up_twice() {
        let sql = render_down_migration(&[provision("pack-file", "0001.sql")], None);

        assert_eq!(sql.matches("delete from kizunasync._provisions").count(), 1);
    }

    #[test]
    fn a_row_that_produced_only_a_warning_is_never_deleted_from_the_ledger() {
        let sql = render_down_migration(
            &[provision("gremlin", "x"), provision("config", "public.t")],
            None,
        );

        assert!(!sql.contains("'gremlin'"));
    }

    /// The purge tail runs inside the same transaction, after the ledger-driven
    /// drops and the cleanup DELETE that reads from the ledger: the schema, and
    /// with it `_provisions`, is the last thing to go.
    #[test]
    fn the_purge_tail_drops_the_schema_last_and_inside_the_same_transaction() {
        let request = purge_request(Some(LOCAL_TARGET));
        let sql = render_down_migration(&[provision("config", "public.todos")], Some(&request));

        assert_eq!(sql.matches("begin;").count(), 1);
        assert!(sql.contains(
            "drop policy if exists \"Attachments are visible to their owner.\" on kizunasync.\"attachments\";"
        ));
        assert!(sql.contains(
            "revoke all on all tables in schema kizunasync from public, anon, authenticated, service_role;"
        ));
        assert!(
            sql.contains("revoke usage on schema kizunasync from authenticated, service_role;")
        );
        assert!(sql.contains(
            "-- purge: 11 table(s), 1 sequence(s), 7 index(es), 45 function(s), 1 policy(ies)"
        ));
        let cleanup = sql.find("delete from kizunasync._provisions").unwrap();
        let drop_schema = sql
            .find("drop schema if exists kizunasync cascade;")
            .unwrap();
        assert!(
            cleanup < drop_schema,
            "the ledger is read before it is dropped"
        );
        assert!(sql.trim_end().ends_with("commit;"));
        assert!(sql.contains("YOUR OWN tables are untouched"));
    }

    /// A purge over the connection removes the same roles as the migration
    /// file does, whatever the ledger names, inside its transaction and after
    /// the schema.
    #[test]
    fn a_direct_purge_drops_every_kizunasync_role_after_the_schema() {
        let request = purge_request(Some(LOCAL_TARGET));
        let sql = render_down_migration(&[], Some(&request));
        let drop_schema = sql
            .find("drop schema if exists kizunasync cascade;")
            .unwrap();
        let roles = sql.find(ROLE_CLEANUP).unwrap();

        assert!(drop_schema < roles, "{sql}");
        assert!(
            sql.trim_end()
                .ends_with(&format!("{ROLE_CLEANUP}\ncommit;")),
            "{sql}"
        );
        assert_eq!(
            purge_tail(&request.counts, Form::Transaction).last(),
            Some(&ROLE_CLEANUP.to_owned())
        );
        assert!(sql.contains("and every kizunasync role"), "{sql}");
    }

    /// The default is unchanged: nothing outside the ledger is touched.
    #[test]
    fn without_purge_the_schema_is_never_dropped() {
        let sql = render_down_migration(&[provision("config", "public.todos")], None);

        assert!(!sql.contains("drop schema"));
        assert!(!sql.contains("revoke"));
        assert!(sql.contains("Your tables and data are untouched."));
    }

    #[test]
    fn purge_needs_the_target_typed_out_and_yes_is_not_enough() {
        let recorder = Recorder::new(false);
        let flags = DeprovisionFlags {
            yes: true,
            purge: Some(purge_request(None)),
            ..DeprovisionFlags::default()
        };
        let (code, capture) = drive(
            &[provision("config", "public.todos")],
            &flags,
            &Env::default(),
            &recorder,
        );

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("--yes alone does not apply it"));
        assert!(capture.stderr().contains("--confirm local"));
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn a_confirmation_for_another_target_is_refused() {
        let recorder = Recorder::new(false);
        let flags = DeprovisionFlags {
            yes: true,
            purge: Some(purge_request(Some("abcdefghijklmnop"))),
            ..DeprovisionFlags::default()
        };
        let (code, _) = drive(
            &[provision("config", "public.todos")],
            &flags,
            &Env::default(),
            &recorder,
        );

        assert_eq!(code, UNUSABLE);
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn the_typed_target_applies_the_purge_and_reports_the_counts() {
        let recorder = Recorder::new(false);
        let flags = DeprovisionFlags {
            yes: true,
            purge: Some(purge_request(Some(LOCAL_TARGET))),
            ..DeprovisionFlags::default()
        };
        let (code, capture) = drive(
            &[provision("config", "public.todos")],
            &flags,
            &Env::default(),
            &recorder,
        );

        assert_eq!(code, OK);
        assert_eq!(recorder.applied.borrow().len(), 1);
        assert!(recorder.applied.borrow()[0].contains("drop schema if exists kizunasync cascade;"));
        assert!(
            capture
                .stderr()
                .contains("purged the kizunasync schema: 11 table(s)")
        );
        assert!(
            capture
                .stdout()
                .contains("[purge] drop schema if exists kizunasync cascade;")
        );
    }

    /// A purge is the one run that has something to do with an empty ledger:
    /// the schema is still there even when nothing claims it.
    #[test]
    fn an_empty_ledger_still_purges() {
        let recorder = Recorder::new(false);
        let flags = DeprovisionFlags {
            dry_run: true,
            purge: Some(purge_request(Some(LOCAL_TARGET))),
            ..DeprovisionFlags::default()
        };
        let (code, capture) = drive(&[], &flags, &Env::default(), &recorder);

        assert_eq!(code, OK);
        assert!(!capture.stderr().contains("the ledger is empty"));
        assert!(capture.stdout().contains("[purge] drop schema"));
    }

    #[test]
    fn the_confirmation_target_is_read_from_the_connection() {
        assert_eq!(
            expected_confirmation("postgresql://postgres:postgres@127.0.0.1:55322/postgres"),
            LOCAL_TARGET
        );
        assert_eq!(
            expected_confirmation(
                "postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres"
            ),
            "abcdefghijklmnop"
        );
        assert_eq!(
            expected_confirmation(
                "postgres://postgres.abcdefghijklmnop:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require"
            ),
            "abcdefghijklmnop"
        );
        assert_eq!(
            expected_confirmation("postgres://localhost/postgres"),
            LOCAL_TARGET
        );
        assert_eq!(expected_confirmation(""), LOCAL_TARGET);
    }

    #[test]
    fn the_schema_counts_read_carries_the_policies_it_will_drop() {
        let applier = FakeApplier::new()
            .answer(
                "as tables",
                vec![text_row(&[
                    ("tables", "11"),
                    ("sequences", "1"),
                    ("indexes", "7"),
                    ("functions", "45"),
                ])],
            )
            .answer(
                "from pg_policies",
                vec![text_row(&[
                    ("table_name", "attachments"),
                    ("name", "Attachments are visible to their owner."),
                ])],
            );
        let counts = read_schema_counts(&applier).unwrap();

        assert_eq!(counts.tables, 11);
        assert_eq!(counts.policies.len(), 1);
        assert_eq!(counts.policies[0].table, "attachments");
        assert_eq!(
            describe_counts(&counts),
            "11 table(s), 1 sequence(s), 7 index(es), 45 function(s), 1 policy(ies)"
        );
    }

    #[test]
    fn an_empty_ledger_is_a_clean_no_op() {
        let recorder = Recorder::new(false);
        let (code, capture) = drive(
            &[],
            &DeprovisionFlags::default(),
            &Env::default(),
            &recorder,
        );

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("the ledger is empty"));
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn the_plan_is_the_machine_payload_on_stdout_and_the_chrome_is_on_stderr() {
        let recorder = Recorder::new(false);
        let flags = DeprovisionFlags {
            dry_run: true,
            ..DeprovisionFlags::default()
        };
        let (code, capture) = drive(
            &[provision("config", "public.todos")],
            &flags,
            &Env::default(),
            &recorder,
        );

        assert_eq!(code, OK);
        assert_eq!(
            capture.stdout(),
            "  [config] delete from kizunasync._config where table_name = 'todos';\n"
        );
        assert!(
            capture
                .stderr()
                .contains("--dry-run: plan shown; nothing applied.")
        );
    }

    #[test]
    fn warnings_and_the_canonicalization_note_are_reported_not_hidden() {
        let recorder = Recorder::new(false);
        let flags = DeprovisionFlags {
            dry_run: true,
            ..DeprovisionFlags::default()
        };
        let rows = [
            provision("gremlin", "x"),
            provision("function", "kizunasync.pull"),
            provision("config", "public.todos"),
        ];
        let (_, capture) = drive(&rows, &flags, &Env::default(), &recorder);

        assert!(
            capture
                .stderr()
                .contains("! [gremlin] x: unknown object_kind \"gremlin\"")
        );
        assert!(
            capture
                .stderr()
                .contains("ledger mixes object_name formats")
        );
    }

    #[test]
    fn without_a_guard_the_apply_is_refused() {
        let recorder = Recorder::new(false);
        let (code, capture) = drive(
            &[provision("config", "public.todos")],
            &DeprovisionFlags::default(),
            &Env::default(),
            &recorder,
        );

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("this is destructive"));
        assert!(recorder.applied.borrow().is_empty());
    }

    #[test]
    fn the_environment_escape_hatch_allows_the_apply() {
        let recorder = Recorder::new(false);
        let env = Env::from_pairs(&[("KSYNC_ALLOW_DEPROVISION", "1")]);
        let (code, capture) = drive(
            &[provision("config", "public.todos")],
            &DeprovisionFlags::default(),
            &env,
            &recorder,
        );

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("deprovisioned 1 object(s)."));
        assert_eq!(recorder.applied.borrow().len(), 1);
    }

    #[test]
    fn yes_applies_the_generated_down_migration_exactly_once() {
        let recorder = Recorder::new(false);
        let flags = DeprovisionFlags {
            yes: true,
            ..DeprovisionFlags::default()
        };
        let (code, _) = drive(
            &[provision("config", "public.todos")],
            &flags,
            &Env::default(),
            &recorder,
        );

        assert_eq!(code, OK);
        assert_eq!(recorder.applied.borrow().len(), 1);
        assert!(recorder.applied.borrow()[0].contains("begin;"));
    }

    fn ledgered_role() -> Vec<ProvisionRow> {
        vec![
            provision("function", "kizunasync.track_change"),
            provision("role", "kizunasync_rls"),
        ]
    }

    /// A role another database of the cluster still uses survives its
    /// savepoint: the run succeeds and says how to drop the role later.
    #[test]
    fn a_role_other_databases_still_use_is_kept_and_named_with_how_to_drop_it() {
        let recorder = Recorder::new(false);
        let flags = DeprovisionFlags {
            yes: true,
            ..DeprovisionFlags::default()
        };
        let read = read_port().answer(
            "from pg_roles",
            vec![text_row(&[("rolname", "kizunasync_rls")])],
        );
        let (code, capture) =
            drive_over(&read, &ledgered_role(), &flags, &Env::default(), &recorder);
        let stderr = capture.stderr();

        assert_eq!(code, OK, "{stderr}");
        assert!(
            stderr.contains(
                "kept the role kizunasync_rls: other databases of this server still use it."
            ),
            "{stderr}"
        );
        assert!(stderr.contains("drop role kizunasync_rls;"), "{stderr}");
    }

    #[test]
    fn a_role_the_teardown_dropped_is_not_reported_kept() {
        let recorder = Recorder::new(false);
        let flags = DeprovisionFlags {
            yes: true,
            ..DeprovisionFlags::default()
        };
        let (code, capture) = drive(&ledgered_role(), &flags, &Env::default(), &recorder);

        assert_eq!(code, OK);
        assert!(!capture.stderr().contains("kept the role"));
    }

    #[test]
    fn a_failed_apply_is_exit_one_and_reports_the_transport_error() {
        let recorder = Recorder::new(true);
        let flags = DeprovisionFlags {
            yes: true,
            ..DeprovisionFlags::default()
        };
        let (code, capture) = drive(
            &[provision("config", "public.todos")],
            &flags,
            &Env::default(),
            &recorder,
        );

        assert_eq!(code, FAILURE);
        assert!(capture.stderr().contains("relation does not exist"));
    }

    #[test]
    fn local_only_refuses_with_a_named_reason() {
        let (mut ui, capture) = Ui::capture();

        assert_eq!(refuse_local_only(&mut ui), UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("--local-only has no ledger to read")
        );
    }

    // MARK: - delivery as a migration

    /// A database whose only answer is its migration history. Once a teardown
    /// file sits in `after_write`'s directory, the history records it, or
    /// cannot be read when the flag says so: what a push that failed halfway
    /// leaves.
    struct History {
        applied: Vec<AppliedMigration>,
        after_write: Option<(std::path::PathBuf, bool)>,
    }

    impl History {
        fn of(applied: Vec<AppliedMigration>) -> Self {
            Self {
                applied,
                after_write: None,
            }
        }
    }

    impl SchemaSource for History {
        fn probe(&self, _url: &str) -> Result<ServerFacts> {
            panic!("the teardown never tests the connection")
        }

        fn introspect(&self, _url: &str, _schema: &str) -> Result<SchemaCatalog> {
            panic!("the teardown never introspects")
        }

        fn read_config(&self, _url: &str) -> Result<KizunaSyncConfig> {
            panic!("the teardown never reads the synced set")
        }

        fn pg_cron_present(&self, _url: &str) -> Result<bool> {
            panic!("the teardown never reads pg_cron")
        }

        fn applied_migrations(&self, _url: &str) -> Result<Vec<AppliedMigration>> {
            let mut applied = self.applied.clone();
            let Some((dir, unreadable)) = &self.after_write else {
                return Ok(applied);
            };
            let written: Vec<String> = std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .filter_map(std::result::Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.ends_with(&format!("_{MIGRATION_LABEL}.sql")))
                .map(|name| name.trim_end_matches(".sql").to_owned())
                .collect();
            if written.is_empty() {
                return Ok(applied);
            }
            if *unreadable {
                return Err(Error::Db("the migration history is unreachable".to_owned()));
            }
            applied.extend(recorded(
                &written.iter().map(String::as_str).collect::<Vec<_>>(),
            ));

            Ok(applied)
        }

        fn ledger_rows(&self, _url: &str) -> Result<Vec<crate::provision::LedgerRow>> {
            panic!("the teardown reads the ledger through its own port")
        }

        fn pack_applier(&self, _url: &str) -> Box<dyn Applier + '_> {
            panic!("the teardown never applies the pack")
        }

        fn provisioning_gaps(
            &self,
            _url: &str,
            _expected: &crate::verify::Expectation,
        ) -> Result<Vec<String>> {
            panic!("the teardown never verifies a provision")
        }
    }

    /// The migration `init` wrote and the history recorded before the teardown.
    const INIT_MIGRATION: &str = "20231114221300_kizunasync_init.sql";

    /// A Supabase CLI project holding [`INIT_MIGRATION`].
    fn cli_project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("supabase/migrations")).unwrap();
        std::fs::write(
            dir.path().join("supabase/config.toml"),
            "project_id = \"x\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("supabase/migrations").join(INIT_MIGRATION),
            "select 1;\n",
        )
        .unwrap();

        dir
    }

    fn ledgered_table() -> Vec<ProvisionRow> {
        vec![
            provision("pack-file", "0001_kizuna_init.sql"),
            provision("role", "kizunasync_rls"),
            provision("function", "kizunasync.reap_tombstones"),
            provision("config", "public.todos"),
            provision("trigger", "public.todos.kizunasync_changes"),
            provision("policy", "public.todos.Owners read their rows."),
        ]
    }

    #[test]
    fn a_supabase_cli_project_takes_the_teardown_as_a_migration() {
        let project = cli_project();
        let bare = tempfile::tempdir().unwrap();

        assert!(delivers_by_migration(&ProjectPaths::rooted_at(
            project.path().to_path_buf()
        )));
        assert!(!delivers_by_migration(&ProjectPaths::rooted_at(
            bare.path().to_path_buf()
        )));
    }

    /// `supabase db push` runs each file in its own transaction, and a replay
    /// meets whatever the files before it left: every statement that needs a
    /// relation runs only when it exists.
    #[test]
    fn the_migration_runs_outside_a_transaction_and_guards_what_needs_a_relation() {
        let sql = render_deprovision_migration(&ledgered_table(), None);
        let lines: Vec<&str> = sql.lines().collect();

        assert!(!lines.contains(&"begin;"), "{sql}");
        assert!(!lines.contains(&"commit;"), "{sql}");
        assert!(lines.contains(
            &"do $kizunasync$ begin if to_regclass('\"public\".\"todos\"') is not null then drop trigger if exists \"kizunasync_changes\" on \"public\".\"todos\"; end if; end $kizunasync$;"
        ), "{sql}");
        assert!(lines.contains(
            &"do $kizunasync$ begin if to_regclass('\"public\".\"todos\"') is not null then drop policy if exists \"Owners read their rows.\" on \"public\".\"todos\"; end if; end $kizunasync$;"
        ), "{sql}");
        assert!(lines.contains(
            &"do $kizunasync$ begin if to_regclass('kizunasync._config') is not null then delete from kizunasync._config where table_name = 'todos'; end if; end $kizunasync$;"
        ), "{sql}");
        assert!(lines.contains(
            &"do $kizunasync$ begin if to_regclass('kizunasync._provisions') is not null then delete from kizunasync._provisions where object_kind = 'pack-file' and object_name = '0001_kizuna_init.sql'; end if; end $kizunasync$;"
        ), "{sql}");
        assert!(
            lines.iter().any(|line| line
                .starts_with("drop function if exists \"kizunasync\".\"reap_tombstones\"")),
            "{sql}"
        );
        assert!(
            lines.last().unwrap().starts_with(
                "do $kizunasync$ begin if to_regclass('kizunasync._provisions') is not null then delete from kizunasync._provisions where (object_kind, object_name) in ("
            ),
            "{sql}"
        );
        assert!(!sql.contains("drop schema"), "{sql}");
    }

    /// The tail holds over any state, so it is written even when the ledger is
    /// empty: a replay after the earlier files still removes what they created.
    #[test]
    fn a_purge_migration_ends_with_the_schema_and_every_kizunasync_role_over_an_empty_ledger() {
        let sql = render_deprovision_migration(&[], Some(&purge_request(Some(LOCAL_TARGET))));
        let lines: Vec<&str> = sql.lines().collect();

        assert_eq!(lines.last(), Some(&ROLE_CLEANUP), "{sql}");
        assert_eq!(
            lines.get(lines.len() - 2),
            Some(&"drop schema if exists kizunasync cascade;"),
            "{sql}"
        );
        assert!(lines.contains(
            &"do $kizunasync$ begin if to_regclass('kizunasync.\"attachments\"') is not null then drop policy if exists \"Attachments are visible to their owner.\" on kizunasync.\"attachments\"; end if; end $kizunasync$;"
        ), "{sql}");
        assert!(lines.contains(
            &"do $kizunasync$ begin if exists (select 1 from pg_namespace where nspname = 'kizunasync') then revoke usage on schema kizunasync from authenticated, service_role; end if; end $kizunasync$;"
        ), "{sql}");
        assert!(!lines.contains(&"begin;"), "{sql}");
        assert!(ROLE_CLEANUP.contains("where rolname like 'kizunasync%'"));
        assert!(ROLE_CLEANUP.contains("exception when dependent_objects_still_exist then null;"));
    }

    /// A name the ledger carries cannot close the quoting it is written in.
    #[test]
    fn the_guard_quotes_with_a_tag_its_body_does_not_contain() {
        assert_eq!(
            guarded("true", "select 1;"),
            "do $kizunasync$ begin if true then select 1; end if; end $kizunasync$;"
        );
        assert_eq!(
            guarded("true", "select '$kizunasync$';"),
            "do $kizunasync1$ begin if true then select '$kizunasync$'; end if; end $kizunasync1$;"
        );
    }

    /// The teardown is named past every version the directory and the history
    /// hold, written, and pushed to the connection's target; the transaction
    /// form is never run.
    #[test]
    fn a_migration_delivery_writes_the_teardown_and_pushes_it() {
        let project = cli_project();
        let paths = ProjectPaths::rooted_at(project.path().to_path_buf());
        let direct = DirectConnection {
            url: "postgresql://postgres:postgres@127.0.0.1:55322/scratch".to_owned(),
            push: PushTarget::Local,
        };
        let history = History::of(recorded(&["20231114221300_kizunasync_init"]));
        let cli = RecordingCli::new();
        let delivery = Delivery::Migration(MigrationPush {
            direct: &direct,
            paths: &paths,
            schemas: &history,
            supabase: &cli,
            now_unix: 1_700_000_000,
        });
        let flags = DeprovisionFlags {
            yes: true,
            purge: Some(purge_request(Some(LOCAL_TARGET))),
            ..DeprovisionFlags::default()
        };
        let rows = ledgered_table();
        let (mut ui, capture) = Ui::capture();
        let code = plan_and_apply(
            &rows,
            &flags,
            &Env::default(),
            &read_port(),
            &delivery,
            &Exposure::ConfigToml(&paths.config_toml),
            &mut ui,
        );
        let name = "20231114221320_kizunasync_deprovision.sql";
        let written = std::fs::read_to_string(paths.migrations_dir.join(name)).unwrap_or_default();

        assert_eq!(code, OK, "{}", capture.stderr());
        assert_eq!(
            written,
            render_deprovision_migration(&rows, flags.purge.as_ref())
        );
        assert_eq!(*cli.pushes.borrow(), [PushTarget::Local]);
        assert!(capture.stderr().contains(&format!("emitted {name}")));
        assert!(
            capture
                .stderr()
                .contains("applied via supabase db push --local.")
        );
        assert!(
            capture
                .stdout()
                .contains("[purge] drop schema if exists kizunasync cascade;")
        );
        assert!(
            capture
                .stdout()
                .contains(&format!("[purge] {ROLE_CLEANUP}"))
        );
    }

    /// A failed push names the file it wrote and ends the run on exit 1.
    #[test]
    fn a_failed_push_of_the_teardown_is_exit_one() {
        let project = cli_project();
        let paths = ProjectPaths::rooted_at(project.path().to_path_buf());
        let direct = DirectConnection {
            url: "postgresql://postgres:postgres@127.0.0.1:55322/scratch".to_owned(),
            push: PushTarget::Local,
        };
        let history = History::of(recorded(&["20231114221300_kizunasync_init"]));
        let cli = RecordingCli::answering(
            crate::supabase_cli::CliResult {
                ok: false,
                stderr: "connection refused".to_owned(),
            },
            crate::supabase_cli::CliResult {
                ok: true,
                stderr: String::new(),
            },
        );
        let delivery = Delivery::Migration(MigrationPush {
            direct: &direct,
            paths: &paths,
            schemas: &history,
            supabase: &cli,
            now_unix: 1_700_000_000,
        });
        let flags = DeprovisionFlags {
            yes: true,
            ..DeprovisionFlags::default()
        };
        let (mut ui, capture) = Ui::capture();
        let code = plan_and_apply(
            &ledgered_table(),
            &flags,
            &Env::default(),
            &read_port(),
            &delivery,
            &Exposure::ConfigToml(&paths.config_toml),
            &mut ui,
        );

        assert_eq!(code, FAILURE, "{}", capture.stderr());
        assert!(capture.stderr().contains("connection refused"));
        assert!(!capture.stderr().contains("deprovisioned"));
    }

    /// After a purge the ledger table is gone: the run reads it as empty
    /// rather than failing, so a second purge still writes its tail.
    #[test]
    fn a_ledger_a_purge_removed_reads_as_empty() {
        let read = FakeApplier::new()
            .answer(LEDGER_PRESENT, vec![text_row(&[("present", "f")])])
            .answer(
                "as tables",
                vec![text_row(&[
                    ("tables", "0"),
                    ("sequences", "0"),
                    ("indexes", "0"),
                    ("functions", "0"),
                ])],
            );
        let recorder = Recorder::new(false);
        let execute = recorder.execute();
        let delivery = Delivery::Direct(&execute);
        let plain = DeprovisionRequest {
            yes: true,
            ..DeprovisionRequest::default()
        };
        let (mut ui, capture) = Ui::capture();

        assert_eq!(
            run_over(
                &read,
                LOCAL_TARGET,
                &plain,
                &delivery,
                &Exposure::ByHand,
                &Env::default(),
                &mut ui
            ),
            OK
        );
        assert!(
            capture
                .stderr()
                .contains("the ledger is empty, nothing to deprovision.")
        );
        assert!(recorder.applied.borrow().is_empty());
        assert!(
            !read
                .executed
                .borrow()
                .iter()
                .any(|sql| sql.contains("object_args"))
        );

        let purge = DeprovisionRequest {
            yes: true,
            purge: true,
            confirm: Some(LOCAL_TARGET),
            ..DeprovisionRequest::default()
        };
        let (mut ui, capture) = Ui::capture();

        assert_eq!(
            run_over(
                &read,
                LOCAL_TARGET,
                &purge,
                &delivery,
                &Exposure::ByHand,
                &Env::default(),
                &mut ui
            ),
            OK,
            "{}",
            capture.stderr()
        );
        assert_eq!(recorder.applied.borrow().len(), 1);
        assert!(recorder.applied.borrow()[0].contains("drop schema if exists kizunasync cascade;"));
    }

    // MARK: - over the Management API

    const PROJECT_REF: &str = "abcdefghijklmnopqrst";

    /// The header every teardown script opens with.
    const TEARDOWN: &str = "-- Generated by `kizunasync deprovision";

    fn project_ref() -> ProjectRef {
        ProjectRef::parse(PROJECT_REF).unwrap()
    }

    /// A hosted project: its database, and the exposed-schema list its
    /// PostgREST config carries, which a removal reaches only after `stale`
    /// reads, the way the Management API applies a PATCH.
    struct Hosted {
        db: FakeApplier,
        exposed: RefCell<Vec<String>>,
        /// Whether the teardown had already run, at each unexpose call.
        unexposed: RefCell<Vec<bool>>,
        /// Reads after a removal that still list the schema.
        stale: usize,
        pending: Cell<usize>,
        /// Every wait between two reads.
        waits: RefCell<Vec<Duration>>,
        /// Every re-expose call.
        reexposed: RefCell<Vec<String>>,
        /// What an unexpose call fails with.
        refuse: Option<&'static str>,
        /// What a re-expose call fails with.
        refuse_expose: Option<&'static str>,
        /// What a read of the list fails with.
        unreadable: Option<&'static str>,
        /// What a read of the list fails with once a removal was accepted.
        unreadable_after_patch: Option<&'static str>,
        /// What the teardown script fails with in transit, its outcome unknown.
        teardown_in_transit: Option<&'static str>,
    }

    impl Hosted {
        fn new(db: FakeApplier, exposed: &[&str]) -> Self {
            Self {
                db,
                exposed: RefCell::new(exposed.iter().map(|schema| (*schema).to_owned()).collect()),
                unexposed: RefCell::new(Vec::new()),
                stale: 0,
                pending: Cell::new(0),
                waits: RefCell::new(Vec::new()),
                reexposed: RefCell::new(Vec::new()),
                refuse: None,
                refuse_expose: None,
                unreadable: None,
                unreadable_after_patch: None,
                teardown_in_transit: None,
            }
        }

        /// The statements the run sent that change the database: the
        /// teardown is the only one, and the reads around it all start with
        /// `select`.
        fn writes(&self) -> Vec<String> {
            self.db
                .executed
                .borrow()
                .iter()
                .filter(|sql| !sql.trim_start().starts_with("select"))
                .cloned()
                .collect()
        }
    }

    impl Applier for Hosted {
        fn run_query(&self, sql: &str) -> Result<Vec<Row>> {
            if let Some(cause) = self.teardown_in_transit
                && sql.starts_with(TEARDOWN)
            {
                return Err(Error::Transport(cause.to_owned()));
            }

            self.db.run_query(sql)
        }
    }

    impl ExposedSchemas for Hosted {
        fn exposed_schemas(&self) -> Result<Vec<String>> {
            if let Some(cause) = self.unreadable {
                return Err(Error::Transport(cause.to_owned()));
            }
            if let Some(cause) = self.unreadable_after_patch
                && !self.unexposed.borrow().is_empty()
            {
                return Err(Error::Transport(cause.to_owned()));
            }
            let mut exposed = self.exposed.borrow().clone();
            if self.pending.get() > 0 {
                self.pending.set(self.pending.get() - 1);
                exposed.push(SCHEMA.to_owned());
            }

            Ok(exposed)
        }

        fn unexpose_schema(&self, schema: &str) -> Result<UnexposeOutcome> {
            let torn_down = self
                .db
                .executed
                .borrow()
                .iter()
                .any(|sql| sql.starts_with(TEARDOWN));
            self.unexposed.borrow_mut().push(torn_down);
            if let Some(cause) = self.refuse {
                return Err(Error::Transport(cause.to_owned()));
            }
            let outcome = unexpose_outcome(&self.exposed.borrow(), schema);
            if outcome == UnexposeOutcome::Removed {
                self.exposed.borrow_mut().retain(|entry| entry != schema);
                self.pending.set(self.stale);
            }

            Ok(outcome)
        }

        fn expose_schema(&self, schema: &str) -> Result<ExposeOutcome> {
            self.reexposed.borrow_mut().push(schema.to_owned());
            if let Some(cause) = self.refuse_expose {
                return Err(Error::Transport(cause.to_owned()));
            }
            self.exposed.borrow_mut().push(schema.to_owned());

            Ok(ExposeOutcome::Added)
        }

        fn wait(&self, duration: Duration) {
            self.waits.borrow_mut().push(duration);
        }
    }

    const EXPOSED: [&str; 3] = ["public", "graphql_public", "kizunasync"];

    /// A hosted project whose ledger records a synced `todos`.
    fn hosted() -> FakeApplier {
        read_port().answer(
            "object_args\nfrom kizunasync._provisions",
            vec![
                text_row(&[
                    ("object_kind", "function"),
                    ("object_name", "kizunasync.reap_tombstones"),
                ]),
                text_row(&[("object_kind", "config"), ("object_name", "public.todos")]),
            ],
        )
    }

    fn schema_counts() -> FakeApplier {
        hosted().answer(
            "as tables",
            vec![text_row(&[
                ("tables", "11"),
                ("sequences", "1"),
                ("indexes", "7"),
                ("functions", "45"),
            ])],
        )
    }

    fn purge_over_the_api() -> DeprovisionRequest<'static> {
        DeprovisionRequest {
            yes: true,
            purge: true,
            confirm: Some(PROJECT_REF),
            ..DeprovisionRequest::default()
        }
    }

    fn run_api(api: &Hosted, request: &DeprovisionRequest<'_>) -> (i32, Capture) {
        let (mut ui, capture) = Ui::capture();
        let code = run_over_api(api, &project_ref(), request, &Env::default(), &mut ui);

        (code, capture)
    }

    /// The plan is read through the API and applied through it as one
    /// transaction, never as a migration file: a hosted project has no local
    /// tree for `supabase db push` to read.
    #[test]
    fn over_the_management_api_the_teardown_is_one_transaction_through_the_api() {
        let api = Hosted::new(hosted(), &EXPOSED);
        let request = DeprovisionRequest {
            yes: true,
            ..DeprovisionRequest::default()
        };
        let (code, capture) = run_api(&api, &request);
        let writes = api.writes();

        assert_eq!(code, OK, "{}", capture.stderr());
        assert_eq!(writes.len(), 1, "{writes:?}");
        let script = &writes[0];
        assert!(
            script.starts_with("-- Generated by `kizunasync deprovision`."),
            "{script}"
        );
        assert_eq!(script.matches("begin;").count(), 1, "{script}");
        assert!(script.trim_end().ends_with("commit;"), "{script}");
        assert!(
            script.contains("delete from kizunasync._config where table_name = 'todos';"),
            "{script}"
        );
        assert!(!script.contains("do $kizunasync$"), "{script}");
        assert!(!script.contains("drop schema"), "{script}");
        assert!(capture.stderr().contains("deprovisioned 2 object(s)."));
        assert!(!capture.stderr().contains("emitted"));
    }

    /// A purge over the API is confirmed with the project ref, the word a
    /// direct connection to the same project is confirmed with.
    #[test]
    fn over_the_management_api_a_purge_is_confirmed_with_the_project_ref() {
        let refused = Hosted::new(schema_counts(), &EXPOSED);
        let request = DeprovisionRequest {
            confirm: Some(LOCAL_TARGET),
            ..purge_over_the_api()
        };
        let (code, capture) = run_api(&refused, &request);

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains(&format!("Re-run with --confirm {PROJECT_REF}")),
            "{}",
            capture.stderr()
        );
        assert_eq!(refused.writes(), Vec::<String>::new());
        assert!(refused.unexposed.borrow().is_empty());

        let confirmed = Hosted::new(schema_counts(), &EXPOSED);
        let (code, capture) = run_api(&confirmed, &purge_over_the_api());

        assert_eq!(code, OK, "{}", capture.stderr());
        let writes = confirmed.writes();
        assert_eq!(writes.len(), 1, "{writes:?}");
        assert!(writes[0].contains("drop schema if exists kizunasync cascade;"));
        assert!(writes[0].trim_end().ends_with("commit;"));
    }

    /// `--dry-run` over the API prints the plan and sends nothing that writes.
    #[test]
    fn over_the_management_api_a_dry_run_writes_nothing() {
        let api = Hosted::new(hosted(), &EXPOSED);
        let request = DeprovisionRequest {
            dry_run: true,
            ..DeprovisionRequest::default()
        };
        let (code, capture) = run_api(&api, &request);

        assert_eq!(code, OK);
        assert!(
            capture
                .stdout()
                .contains("[config] delete from kizunasync._config")
        );
        assert_eq!(api.writes(), Vec::<String>::new());
    }

    // MARK: - the Data API step

    /// The line of a removal over the Management API that applied.
    const REMOVED: &str = "  Data API:         removed kizunasync from the exposed schemas";

    /// PostgREST cannot build its schema cache while an exposed schema is
    /// missing, so the schema leaves the list first, and the purge runs only
    /// once a read shows it gone.
    #[test]
    fn a_purge_over_the_api_unexposes_the_schema_before_the_transaction() {
        let api = Hosted::new(schema_counts(), &EXPOSED);
        let (code, capture) = run_api(&api, &purge_over_the_api());
        let stderr = capture.stderr();

        assert_eq!(code, OK, "{stderr}");
        assert_eq!(*api.unexposed.borrow(), [false]);
        assert_eq!(*api.exposed.borrow(), ["public", "graphql_public"]);
        assert_eq!(api.writes().len(), 1);
        let removed = stderr.find(REMOVED).unwrap();
        let purged = stderr.find("purged the kizunasync schema").unwrap();
        assert!(removed < purged, "{stderr}");
        assert!(api.reexposed.borrow().is_empty());
    }

    /// The Management API applies the PATCH later than it answers it: the
    /// run reads the list every 3 s until the schema is gone.
    #[test]
    fn the_purge_waits_for_a_read_that_no_longer_lists_the_schema() {
        let api = Hosted {
            stale: 1,
            ..Hosted::new(schema_counts(), &EXPOSED)
        };
        let (code, capture) = run_api(&api, &purge_over_the_api());

        assert_eq!(code, OK, "{}", capture.stderr());
        assert_eq!(*api.waits.borrow(), [Duration::from_secs(3); 2]);
        assert_eq!(api.writes().len(), 1);
    }

    /// A removal no read confirms within 60 s drops nothing: the run says
    /// the removal was asked for and to run the command again.
    #[test]
    fn a_removal_that_never_applies_stops_before_anything_is_dropped() {
        let api = Hosted {
            stale: usize::MAX,
            ..Hosted::new(schema_counts(), &EXPOSED)
        };
        let (code, capture) = run_api(&api, &purge_over_the_api());
        let stderr = capture.stderr();

        assert_eq!(code, FAILURE, "{stderr}");
        assert!(api.writes().is_empty(), "{:?}", api.writes());
        assert_eq!(
            api.waits.borrow().iter().sum::<Duration>(),
            Duration::from_secs(60)
        );
        assert!(
            stderr.contains("was requested but Supabase has not applied it yet"),
            "{stderr}"
        );
        assert!(stderr.contains("nothing was dropped"), "{stderr}");
        assert!(stderr.contains("run the same command again"), "{stderr}");
    }

    /// What the existence check answers after a purge that did not apply.
    const SCHEMA_PRESENT: &str = "from pg_namespace where nspname = 'kizunasync'";

    /// The script the database refused (a SQL error), which rolled back.
    fn refused_purge() -> FakeApplier {
        schema_counts().fail_sql("drop schema if exists", "40P01", "40P01: deadlock detected")
    }

    /// A purge transaction the database refused puts the schema back in the
    /// list, and reports either outcome of that.
    #[test]
    fn a_failed_purge_exposes_the_schema_again() {
        for refuse_expose in [
            None,
            Some("Supabase Management API PATCH /postgrest failed: 500 boom"),
        ] {
            let api = Hosted {
                refuse_expose,
                ..Hosted::new(
                    refused_purge().answer(SCHEMA_PRESENT, vec![text_row(&[("present", "t")])]),
                    &EXPOSED,
                )
            };
            let (code, capture) = run_api(&api, &purge_over_the_api());
            let stderr = capture.stderr();

            assert_eq!(code, FAILURE, "{stderr}");
            assert!(stderr.contains("deadlock detected"), "{stderr}");
            assert_eq!(*api.reexposed.borrow(), ["kizunasync"]);
            if refuse_expose.is_some() {
                assert!(
                    stderr.contains("could not expose kizunasync again"),
                    "{stderr}"
                );
                assert!(stderr.contains("500 boom"), "{stderr}");
            } else {
                assert!(
                    stderr.contains("  Data API:         exposed kizunasync again, since the purge did not apply"),
                    "{stderr}"
                );
                assert!(api.exposed.borrow().contains(&SCHEMA.to_owned()));
            }
        }
    }

    /// The put-back runs only over a schema that is still there: a schema the
    /// failed run dropped after all, or one nobody can confirm, stays
    /// unexposed, and the run says so.
    #[test]
    fn the_schema_is_exposed_again_only_while_it_still_exists() {
        for (present, said) in [
            (
                Some("f"),
                "  Data API:         the kizunasync schema is gone, so kizunasync stays unexposed",
            ),
            (
                None,
                "could not read whether the kizunasync schema still exists",
            ),
        ] {
            let failing = refused_purge();
            let db = match present {
                Some(value) => {
                    failing.answer(SCHEMA_PRESENT, vec![text_row(&[("present", value)])])
                }
                None => failing.fail(SCHEMA_PRESENT, "connection reset"),
            };
            let api = Hosted::new(db, &EXPOSED);
            let (code, capture) = run_api(&api, &purge_over_the_api());
            let stderr = capture.stderr();

            assert_eq!(code, FAILURE, "{stderr}");
            assert!(api.reexposed.borrow().is_empty(), "{present:?}");
            assert!(stderr.contains(said), "{stderr}");
            if present.is_none() {
                assert!(stderr.contains("connection reset"), "{stderr}");
                assert!(stderr.contains("so kizunasync stays unexposed"), "{stderr}");
            }
        }
    }

    /// A teardown that failed without the database refusing it may still
    /// commit server-side, so the schema is not exposed again: the run says
    /// how to find out, and how to expose it if it survived.
    #[test]
    fn a_purge_with_an_unknown_outcome_leaves_the_schema_unexposed() {
        let present = || vec![text_row(&[("present", "t")])];
        for (api, cause) in [
            (
                Hosted::new(
                    schema_counts()
                        .fail("drop schema if exists", "connection reset by peer")
                        .answer(SCHEMA_PRESENT, present()),
                    &EXPOSED,
                ),
                "connection reset by peer",
            ),
            (
                Hosted {
                    teardown_in_transit: Some(
                        "Supabase Management API POST /database/query failed: timed out",
                    ),
                    ..Hosted::new(schema_counts().answer(SCHEMA_PRESENT, present()), &EXPOSED)
                },
                "timed out",
            ),
        ] {
            let (code, capture) = run_api(&api, &purge_over_the_api());
            let stderr = capture.stderr();

            assert_eq!(code, FAILURE, "{stderr}");
            assert!(api.reexposed.borrow().is_empty(), "{stderr}");
            assert!(
                stderr.contains("  Data API:         the purge's outcome is unknown ("),
                "{stderr}"
            );
            assert!(stderr.contains(cause), "{stderr}");
            assert!(
                stderr.contains(
                    "), so kizunasync stays unexposed; run `kizunasync status --project-ref abcdefghijklmnopqrst`: if the schema is still there, `kizunasync init --project-ref abcdefghijklmnopqrst` exposes it again"
                ),
                "{stderr}"
            );
        }
    }

    /// A read that fails once the API accepted the removal leaves nothing
    /// confirmed, so nothing is dropped.
    #[test]
    fn a_removal_the_reads_cannot_confirm_stops_before_anything_is_dropped() {
        let api = Hosted {
            unreadable_after_patch: Some(
                "Supabase Management API GET /postgrest failed: 502 bad gateway",
            ),
            ..Hosted::new(schema_counts(), &EXPOSED)
        };
        let (code, capture) = run_api(&api, &purge_over_the_api());
        let stderr = capture.stderr();

        assert_eq!(code, FAILURE, "{stderr}");
        assert!(
            stderr.contains(
                "the removal of kizunasync from the exposed schemas was accepted but could not be confirmed (Supabase Management API GET /postgrest failed: 502 bad gateway), so nothing was dropped; run the same command again"
            ),
            "{stderr}"
        );
        assert_eq!(api.writes(), Vec::<String>::new());
    }

    /// The Data API cannot run with no exposed schema, so a purge that would
    /// leave none is refused before anything changes, dry run included.
    #[test]
    fn the_only_exposed_schema_refuses_the_purge_before_anything_changes() {
        for request in [
            purge_over_the_api(),
            DeprovisionRequest {
                dry_run: true,
                ..purge_over_the_api()
            },
        ] {
            let api = Hosted::new(schema_counts(), &["kizunasync"]);
            let (code, capture) = run_api(&api, &request);
            let stderr = capture.stderr();

            assert_eq!(code, UNUSABLE, "{stderr}");
            assert!(
                stderr.contains("kizunasync is the only exposed schema of this project"),
                "{stderr}"
            );
            assert_eq!(api.writes(), Vec::<String>::new());
            assert!(api.unexposed.borrow().is_empty());
            assert_eq!(capture.stdout(), "");
        }
    }

    #[test]
    fn a_schema_that_is_not_exposed_lets_the_purge_run_with_nothing_to_remove() {
        let api = Hosted::new(schema_counts(), &["public"]);
        let (code, capture) = run_api(&api, &purge_over_the_api());
        let stderr = capture.stderr();

        assert_eq!(code, OK, "{stderr}");
        assert_eq!(
            stderr
                .matches("  Data API:         kizunasync is not exposed")
                .count(),
            2,
            "{stderr}"
        );
        assert!(api.waits.borrow().is_empty());
        assert_eq!(api.writes().len(), 1);
    }

    /// A removal the API refuses drops nothing.
    #[test]
    fn a_refused_removal_stops_before_anything_is_dropped() {
        let api = Hosted {
            refuse: Some("Supabase Management API PATCH /postgrest failed: 500 boom"),
            ..Hosted::new(schema_counts(), &EXPOSED)
        };
        let (code, capture) = run_api(&api, &purge_over_the_api());
        let stderr = capture.stderr();

        assert_eq!(code, FAILURE, "{stderr}");
        assert!(stderr.contains("500 boom"), "{stderr}");
        assert!(stderr.contains("nothing was dropped"), "{stderr}");
        assert_eq!(api.writes(), Vec::<String>::new());
    }

    /// A plain teardown keeps the schema, so it keeps the schema exposed: the
    /// Data API is neither read nor written, whatever the flags.
    #[test]
    fn a_plain_teardown_never_touches_the_data_api() {
        for request in [
            DeprovisionRequest {
                yes: true,
                ..DeprovisionRequest::default()
            },
            DeprovisionRequest {
                dry_run: true,
                ..DeprovisionRequest::default()
            },
        ] {
            let api = Hosted {
                unreadable: Some("the list must not be read"),
                ..Hosted::new(hosted(), &EXPOSED)
            };
            let (code, capture) = run_api(&api, &request);

            assert_eq!(code, OK, "{request:?}: {}", capture.stderr());
            assert!(api.unexposed.borrow().is_empty(), "{request:?}");
            assert_eq!(*api.exposed.borrow(), EXPOSED, "{request:?}");
            assert!(!capture.stderr().contains("Data API"), "{request:?}");
        }
    }

    /// The dry run names the Data API step first, since it runs first.
    #[test]
    fn a_purge_dry_run_previews_the_data_api_step_first_and_changes_nothing() {
        let api = Hosted::new(schema_counts(), &EXPOSED);
        let request = DeprovisionRequest {
            dry_run: true,
            ..purge_over_the_api()
        };
        let (code, capture) = run_api(&api, &request);
        let stderr = capture.stderr();

        assert_eq!(code, OK);
        let preview = stderr
            .find("  Data API:         would remove kizunasync from the exposed schemas")
            .unwrap();
        let schema = stderr
            .find("--purge also removes the kizunasync schema")
            .unwrap();
        assert!(preview < schema, "{stderr}");
        assert!(api.unexposed.borrow().is_empty());
        assert_eq!(api.writes(), Vec::<String>::new());
    }

    #[test]
    fn an_unreadable_exposed_schema_list_refuses_the_purge_before_anything_is_applied() {
        let api = Hosted {
            unreadable: Some("Supabase Management API GET /postgrest failed: 403 forbidden"),
            ..Hosted::new(schema_counts(), &EXPOSED)
        };
        let (code, capture) = run_api(&api, &purge_over_the_api());
        let stderr = capture.stderr();

        assert_eq!(code, UNUSABLE, "{stderr}");
        assert!(stderr.contains("403 forbidden"), "{stderr}");
        assert!(stderr.contains("nothing was applied"), "{stderr}");
        assert_eq!(api.writes(), Vec::<String>::new());
        assert!(api.unexposed.borrow().is_empty());
    }

    /// Without a config file there is no list this run can edit: the plan
    /// warns that the Data API stops serving every schema until the purged
    /// one leaves the project's list, under `--yes` too.
    #[test]
    fn without_a_config_file_a_purge_warns_about_the_exposed_schema() {
        let recorder = Recorder::new(false);
        let purge = DeprovisionFlags {
            yes: true,
            purge: Some(purge_request(Some(LOCAL_TARGET))),
            ..DeprovisionFlags::default()
        };
        let (code, capture) = drive(
            &[provision("config", "public.todos")],
            &purge,
            &Env::default(),
            &recorder,
        );
        let stderr = capture.stderr();

        assert_eq!(code, OK, "{stderr}");
        assert_eq!(stderr.matches(BY_HAND).count(), 1, "{stderr}");
        assert!(stderr.contains("PGRST002"), "{stderr}");
        assert!(stderr.contains("--project-ref"), "{stderr}");

        let plain = DeprovisionFlags {
            yes: true,
            ..DeprovisionFlags::default()
        };
        let (_, capture) = drive(
            &[provision("config", "public.todos")],
            &plain,
            &Env::default(),
            &recorder,
        );

        assert!(!capture.stderr().contains("Data API"));
    }

    // MARK: - the Data API step in supabase/config.toml

    /// A Supabase CLI project whose `[api].schemas` reads `config`.
    fn exposing_project(config: &str) -> (tempfile::TempDir, ProjectPaths) {
        let project = cli_project();
        let paths = ProjectPaths::rooted_at(project.path().to_path_buf());
        std::fs::write(&paths.config_toml, config).unwrap();

        (project, paths)
    }

    const EXPOSING: &str =
        "project_id = \"x\"\n\n[api]\nschemas = [\"public\", \"graphql_public\", \"kizunasync\"]\n";

    fn schema_present(value: &str) -> FakeApplier {
        read_port().answer(SCHEMA_PRESENT, vec![text_row(&[("present", value)])])
    }

    fn purge_by_migration(
        paths: &ProjectPaths,
        flags: &DeprovisionFlags,
        cli: &RecordingCli,
    ) -> (i32, Capture) {
        purge_by_migration_over(paths, flags, cli, &read_port())
    }

    fn purge_by_migration_over(
        paths: &ProjectPaths,
        flags: &DeprovisionFlags,
        cli: &RecordingCli,
        read: &FakeApplier,
    ) -> (i32, Capture) {
        let history = History::of(recorded(&["20231114221300_kizunasync_init"]));

        purge_by_migration_with(paths, flags, cli, read, &history)
    }

    fn purge_by_migration_with(
        paths: &ProjectPaths,
        flags: &DeprovisionFlags,
        cli: &RecordingCli,
        read: &FakeApplier,
        history: &History,
    ) -> (i32, Capture) {
        let direct = DirectConnection {
            url: "postgresql://postgres:postgres@127.0.0.1:55322/scratch".to_owned(),
            push: PushTarget::Local,
        };
        let delivery = Delivery::Migration(MigrationPush {
            direct: &direct,
            paths,
            schemas: history,
            supabase: cli,
            now_unix: 1_700_000_000,
        });
        let (mut ui, capture) = Ui::capture();
        let code = plan_and_apply(
            &ledgered_table(),
            flags,
            &Env::default(),
            read,
            &delivery,
            &Exposure::ConfigToml(&paths.config_toml),
            &mut ui,
        );

        (code, capture)
    }

    fn purge_flags() -> DeprovisionFlags {
        DeprovisionFlags {
            yes: true,
            purge: Some(purge_request(Some(LOCAL_TARGET))),
            ..DeprovisionFlags::default()
        }
    }

    fn failing_push() -> RecordingCli {
        RecordingCli::answering(
            crate::supabase_cli::CliResult {
                ok: false,
                stderr: "connection refused".to_owned(),
            },
            crate::supabase_cli::CliResult {
                ok: true,
                stderr: String::new(),
            },
        )
    }

    /// The entry leaves `[api].schemas` before the teardown is pushed, and
    /// the line says the local stack reads the file at start.
    #[test]
    fn a_local_purge_takes_the_schema_out_of_config_toml_before_the_push() {
        let (_project, paths) = exposing_project(EXPOSING);
        let cli = RecordingCli::new().snapshotting(&paths.config_toml);
        let (code, capture) = purge_by_migration(&paths, &purge_flags(), &cli);
        let stderr = capture.stderr();
        let unexposed = "project_id = \"x\"\n\n[api]\nschemas = [\"public\", \"graphql_public\"]\n";

        assert_eq!(code, OK, "{stderr}");
        assert_eq!(*cli.snapshots.borrow(), [unexposed]);
        assert_eq!(
            std::fs::read_to_string(&paths.config_toml).unwrap(),
            unexposed
        );
        assert!(
            stderr.contains(
                "  Data API:         would remove \"kizunasync\" from [api].schemas in supabase/config.toml"
            ),
            "{stderr}"
        );
        let removed = stderr
            .find("  Data API:         removed \"kizunasync\" from [api].schemas in supabase/config.toml")
            .unwrap();
        let pushed = stderr.find("applied via supabase db push").unwrap();
        assert!(removed < pushed, "{stderr}");
        assert!(
            stderr.contains("the local stack reads it at start, so restart it (`supabase stop`, then `supabase start`) after the purge"),
            "{stderr}"
        );
    }

    /// A push that fails after the surgery puts the file back byte for byte,
    /// and says the migration it left drops the schema the file lists again.
    #[test]
    fn a_failed_push_puts_config_toml_back() {
        let (_project, paths) = exposing_project(EXPOSING);
        let cli = failing_push().snapshotting(&paths.config_toml);
        let (code, capture) =
            purge_by_migration_over(&paths, &purge_flags(), &cli, &schema_present("t"));
        let stderr = capture.stderr();

        assert_eq!(code, FAILURE, "{stderr}");
        assert!(!cli.snapshots.borrow()[0].contains("kizunasync"));
        assert_eq!(
            std::fs::read_to_string(&paths.config_toml).unwrap(),
            EXPOSING
        );
        assert!(
            stderr.contains(
                "  Data API:         put supabase/config.toml back, since the purge did not apply"
            ),
            "{stderr}"
        );
        assert!(
            stderr.contains(
                "  the migration 20231114221320_kizunasync_deprovision.sql drops the schema while supabase/config.toml lists kizunasync again, so run `kizunasync deprovision --purge` again instead of pushing 20231114221320_kizunasync_deprovision.sql by hand."
            ),
            "{stderr}"
        );
    }

    /// A push the migration history records, or one the history cannot be
    /// read about, may have dropped the schema, so the file keeps the entry
    /// out and the run says how to find out.
    #[test]
    fn a_failed_push_that_may_have_applied_leaves_config_toml_without_the_schema() {
        for unreadable in [false, true] {
            let (_project, paths) = exposing_project(EXPOSING);
            let history = History {
                applied: recorded(&["20231114221300_kizunasync_init"]),
                after_write: Some((paths.migrations_dir.clone(), unreadable)),
            };
            let (code, capture) = purge_by_migration_with(
                &paths,
                &purge_flags(),
                &failing_push(),
                &schema_present("t"),
                &history,
            );
            let stderr = capture.stderr();

            assert_eq!(code, FAILURE, "{unreadable}: {stderr}");
            assert!(
                !std::fs::read_to_string(&paths.config_toml)
                    .unwrap()
                    .contains("kizunasync"),
                "{stderr}"
            );
            assert!(
                stderr.contains("  Data API:         the purge's outcome is unknown ("),
                "{stderr}"
            );
            assert!(
                stderr.contains(
                    "), so supabase/config.toml stays without kizunasync; run `kizunasync status`: if the schema is still there, `kizunasync init` exposes it again"
                ),
                "{stderr}"
            );
        }
    }

    /// A schema the failed push dropped after all, or one nobody can
    /// confirm, keeps the file without the entry.
    #[test]
    fn config_toml_is_put_back_only_while_the_schema_still_exists() {
        for (read, said) in [
            (
                schema_present("f"),
                "  Data API:         the kizunasync schema is gone, so kizunasync stays unexposed",
            ),
            (
                read_port().fail(SCHEMA_PRESENT, "connection reset"),
                "could not read whether the kizunasync schema still exists",
            ),
        ] {
            let (_project, paths) = exposing_project(EXPOSING);
            let (code, capture) =
                purge_by_migration_over(&paths, &purge_flags(), &failing_push(), &read);
            let stderr = capture.stderr();

            assert_eq!(code, FAILURE, "{stderr}");
            assert!(
                !std::fs::read_to_string(&paths.config_toml)
                    .unwrap()
                    .contains("kizunasync"),
                "{stderr}"
            );
            assert!(stderr.contains(said), "{stderr}");
        }
    }

    /// Without a local target the file is never edited: a `--linked` push
    /// with no token warns instead, and leaves `supabase/config.toml` alone.
    #[test]
    fn a_purge_that_warns_never_edits_config_toml() {
        let (_project, paths) = exposing_project(EXPOSING);
        let cli = RecordingCli::new().snapshotting(&paths.config_toml);
        let direct = DirectConnection {
            url: "postgres://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres".to_owned(),
            push: PushTarget::Linked,
        };
        let history = History::of(recorded(&["20231114221300_kizunasync_init"]));
        let delivery = Delivery::Migration(MigrationPush {
            direct: &direct,
            paths: &paths,
            schemas: &history,
            supabase: &cli,
            now_unix: 1_700_000_000,
        });
        let (mut ui, capture) = Ui::capture();
        let code = plan_and_apply(
            &ledgered_table(),
            &purge_flags(),
            &Env::default(),
            &read_port(),
            &delivery,
            &Exposure::ByHand,
            &mut ui,
        );
        let stderr = capture.stderr();

        assert_eq!(code, OK, "{stderr}");
        assert_eq!(*cli.snapshots.borrow(), [EXPOSING]);
        assert_eq!(
            std::fs::read_to_string(&paths.config_toml).unwrap(),
            EXPOSING
        );
        assert_eq!(stderr.matches(BY_HAND).count(), 1, "{stderr}");
    }

    /// A dry run and a plain teardown leave the file as it was.
    #[test]
    fn config_toml_stays_as_it_was_without_a_purge_to_apply() {
        for flags in [
            DeprovisionFlags {
                dry_run: true,
                ..purge_flags()
            },
            DeprovisionFlags {
                yes: true,
                ..DeprovisionFlags::default()
            },
        ] {
            let (_project, paths) = exposing_project(EXPOSING);
            let (code, capture) = purge_by_migration(&paths, &flags, &RecordingCli::new());

            assert_eq!(code, OK, "{flags:?}: {}", capture.stderr());
            assert_eq!(
                std::fs::read_to_string(&paths.config_toml).unwrap(),
                EXPOSING,
                "{flags:?}"
            );
            assert!(
                !capture.stderr().contains("Data API:         removed"),
                "{flags:?}"
            );
        }
    }

    /// The only entry stays, so a purge that would drop its schema is
    /// refused before anything changes.
    #[test]
    fn the_only_entry_in_config_toml_refuses_the_purge() {
        let only = "[api]\nschemas = [\"kizunasync\"]\n";
        let (_project, paths) = exposing_project(only);
        let cli = RecordingCli::new();
        let (code, capture) = purge_by_migration(&paths, &purge_flags(), &cli);
        let stderr = capture.stderr();

        assert_eq!(code, UNUSABLE, "{stderr}");
        assert_eq!(std::fs::read_to_string(&paths.config_toml).unwrap(), only);
        assert!(cli.pushes.borrow().is_empty());
        assert!(
            stderr.contains("kizunasync is the only entry in [api].schemas"),
            "{stderr}"
        );
        assert!(stderr.contains("Nothing was applied."), "{stderr}");
    }

    #[test]
    fn an_unparseable_config_toml_is_reported_and_left_alone() {
        let broken = "[api]\nschemas = [\n  \"kizunasync\",\n";
        let (_project, paths) = exposing_project(broken);
        let cli = RecordingCli::new();
        let (code, capture) = purge_by_migration(&paths, &purge_flags(), &cli);
        let stderr = capture.stderr();

        assert_eq!(code, OK, "{stderr}");
        assert_eq!(std::fs::read_to_string(&paths.config_toml).unwrap(), broken);
        assert!(
            stderr.contains("  Data API:         supabase/config.toml does not parse"),
            "{stderr}"
        );
        assert!(
            stderr.contains("Remove \"kizunasync\" from [api].schemas by hand"),
            "{stderr}"
        );
    }

    // MARK: - which list a direct connection's purge edits

    const REF: &str = "abcdefghijklmnopqrst";

    fn connection(push: PushTarget) -> DirectConnection {
        DirectConnection {
            url: "postgresql://postgres:pw@127.0.0.1:54322/postgres".to_owned(),
            push,
        }
    }

    fn db_url(url: &str) -> DirectConnection {
        DirectConnection {
            url: url.to_owned(),
            push: PushTarget::DbUrl(url.to_owned()),
        }
    }

    fn api_target() -> ExposureTarget {
        ExposureTarget::ManagementApi(ProjectRef::parse(REF).unwrap())
    }

    /// One row: the connection, the project beside it, the linked ref, whether
    /// the run holds a token, and the list the purge edits.
    type Case<'a> = (
        DirectConnection,
        &'a ProjectPaths,
        Option<&'a ProjectRef>,
        bool,
        ExposureTarget,
    );

    fn assert_targets(cases: Vec<Case<'_>>) {
        for (connection, paths, linked, has_token, expected) in cases {
            assert_eq!(
                exposure_target(&connection, paths, linked, has_token),
                expected,
                "{} {:?} {linked:?} {has_token}",
                connection.url,
                connection.push
            );
        }
    }

    /// The local stack edits `supabase/config.toml` when there is one,
    /// whatever the token, its own pooler user included; with no file the
    /// purge warns.
    #[test]
    fn the_local_stack_takes_config_toml() {
        let (_project, with_config) = exposing_project(EXPOSING);
        let empty = tempfile::tempdir().unwrap();
        let bare = ProjectPaths::rooted_at(empty.path().to_path_buf());
        let local_pooler = "postgres://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres";
        let config = ExposureTarget::ConfigToml;
        assert_targets(vec![
            (
                connection(PushTarget::Local),
                &with_config,
                None,
                true,
                config.clone(),
            ),
            (
                connection(PushTarget::Local),
                &bare,
                None,
                true,
                ExposureTarget::ByHand,
            ),
            (
                db_url("postgresql://postgres:pw@localhost:54322/postgres"),
                &with_config,
                None,
                true,
                config.clone(),
            ),
            (
                db_url("postgresql://postgres:pw@127.0.0.1:54322/postgres"),
                &with_config,
                None,
                false,
                config.clone(),
            ),
            (
                db_url("postgresql://postgres:pw@[::1]:54322/postgres"),
                &with_config,
                None,
                false,
                config.clone(),
            ),
            (db_url(local_pooler), &with_config, None, true, config),
        ]);
    }

    /// A hosted project, reached by its host, its pooler user (a tunnel
    /// included), or `--linked`, goes through the Management API when a token
    /// and a ref reach it, and warns otherwise: a local file never stands in
    /// for its settings.
    #[test]
    fn a_hosted_project_takes_the_management_api_with_a_token() {
        let (_project, with_config) = exposing_project(EXPOSING);
        let linked = ProjectRef::parse(REF).unwrap();
        let hosted = format!("postgresql://postgres:pw@db.{REF}.supabase.co:5432/postgres");
        let pooler = format!(
            "postgres://postgres.{REF}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
        );
        let tunnel = format!("postgres://postgres.{REF}:pw@127.0.0.1:6543/postgres");
        let elsewhere = "postgresql://postgres:pw@db.example.com:5432/postgres";
        let by_hand = ExposureTarget::ByHand;
        assert_targets(vec![
            (db_url(&hosted), &with_config, None, true, api_target()),
            (db_url(&hosted), &with_config, None, false, by_hand.clone()),
            (db_url(&pooler), &with_config, None, true, api_target()),
            (db_url(&tunnel), &with_config, None, true, api_target()),
            (db_url(elsewhere), &with_config, None, true, by_hand.clone()),
            (
                connection(PushTarget::Linked),
                &with_config,
                Some(&linked),
                true,
                api_target(),
            ),
            (
                connection(PushTarget::Linked),
                &with_config,
                Some(&linked),
                false,
                by_hand.clone(),
            ),
            (
                connection(PushTarget::Linked),
                &with_config,
                None,
                true,
                by_hand,
            ),
        ]);
    }
}
