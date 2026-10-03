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
//!   nothing else in this binary removes.
//!
//! In a Supabase CLI project (a `supabase/config.toml` at the root) the
//! teardown is a migration, `<ts>_kizunasync_deprovision.sql`, applied with
//! `supabase db push` the way `init` applies its own: the migration history
//! records it, and replaying the directory reproduces the state. Each
//! statement in that file checks that what it needs exists, and under
//! `--purge` the file always ends with that purge, even over an empty ledger,
//! so it holds over whatever the files before it left. Anywhere else
//! the teardown runs as one transaction over the connection.

use crate::applier::Applier;
use crate::catalog::SchemaSource;
use crate::clock::migration_version;
use crate::commands::history_gate::{gate_migration_history, push_written};
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
use crate::migration_history::local_versions;
use crate::provision::{is_ledger_present, read_ledger_rows};
use crate::row::{optional_string, require_number, require_string};
use crate::supabase_cli::SupabaseCli;
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
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = after_scheme
        .split(['/', '?'])
        .next()
        .unwrap_or(after_scheme);
    let (user, host) = authority
        .rsplit_once('@')
        .map_or(("", authority), |(user, host)| (user, host));
    let host = host.split(':').next().unwrap_or(host);
    if let Some(rest) = host.strip_prefix("db.")
        && let Some(reference) = rest.strip_suffix(".supabase.co")
        && !reference.is_empty()
    {
        return reference.to_owned();
    }
    let user = user.split(':').next().unwrap_or(user);
    if let Some(reference) = user.strip_prefix("postgres.")
        && !reference.is_empty()
    {
        return reference.to_owned();
    }

    LOCAL_TARGET.to_owned()
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

/// The suffix of the migration a teardown writes.
pub const MIGRATION_LABEL: &str = "kizunasync_deprovision";

/// Whether a teardown in `paths` is delivered as a migration: the project is
/// one `supabase db push` applies, as `init` writes it.
#[must_use]
pub fn delivers_by_migration(paths: &ProjectPaths) -> bool {
    paths.config_toml.is_file()
}

/// The whole command over a connection the caller already resolved: read the
/// ledger, count what a purge would remove, then [`plan_and_apply`]. `url`
/// names the target a purge is confirmed with. A ledger a purge already
/// removed reads as empty.
pub fn run_over(
    applier: &dyn Applier,
    url: &str,
    request: &DeprovisionRequest<'_>,
    delivery: &Delivery<'_>,
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
                expected: expected_confirmation(url),
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

    plan_and_apply(&rows, &flags, env, applier, delivery, ui)
}

/// Refuse a ledger a newer kizunasync recorded, and anything outside the
/// schema that depends on the pack, then print the plan, then apply it if the
/// guard allows. `read` answers the ledger's `pack-file` versions and the
/// `pg_depend` read. Separated from transport resolution so tests drive it
/// with injected rows, a fake read port, and a fake delivery, never touching
/// a live schema.
pub fn plan_and_apply(
    rows: &[ProvisionRow],
    flags: &DeprovisionFlags,
    env: &Env,
    read: &dyn Applier,
    delivery: &Delivery<'_>,
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

    print_plan(&plan, &audit, flags, delivery.form(), ui);

    if let Some(code) = guard_before_apply(flags, env, ui) {
        return code;
    }

    let applied = match delivery {
        Delivery::Direct(execute) => execute(&render_down_migration(rows, flags.purge.as_ref()))
            .map_err(|cause| {
                ui.log(&format!("\n  deprovision apply failed:\n    {cause}"));

                FAILURE
            }),
        Delivery::Migration(push) => write_and_push(
            push,
            &render_deprovision_migration(rows, flags.purge.as_ref()),
            ui,
        ),
    };
    if let Err(code) = applied {
        return code;
    }

    print_apply_summary(&plan, flags, ui);
    report_kept_roles(&plan, read, ui);

    OK
}

/// Write `sql` as the next migration, named past every version the project
/// and the migration history hold, then push it the way `init` pushes its
/// own. The history is compared first, so a drifted one stops the run before
/// anything is written.
fn write_and_push(
    push: &MigrationPush<'_>,
    sql: &str,
    ui: &mut Ui,
) -> std::result::Result<(), i32> {
    let mut taken = gate_migration_history(
        push.direct,
        push.paths,
        push.schemas,
        push.supabase,
        &mut None,
        ui,
    )?;
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

        return Err(FAILURE);
    }
    ui.log(&format!("\n  emitted {name}"));
    push_written(
        push.direct,
        push.paths,
        &[name],
        push.schemas,
        push.supabase,
        &mut None,
        ui,
    )?;
    ui.log(&format!(
        "  applied via supabase db push {}.",
        push.direct.push.describe()
    ));

    Ok(())
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
    use std::cell::RefCell;

    use serde_json::Value;

    use super::*;
    use crate::applier::fake::{FakeApplier, row, text_row};
    use crate::config::KizunaSyncConfig;
    use crate::error::Error;
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
        let code = plan_and_apply(rows, flags, env, read, &Delivery::Direct(&execute), &mut ui);

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

    /// A database whose only answer is its migration history.
    struct History(Vec<AppliedMigration>);

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
            Ok(self.0.clone())
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
        let history = History(recorded(&["20231114221300_kizunasync_init"]));
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
        let history = History(recorded(&["20231114221300_kizunasync_init"]));
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
                "postgresql://local/db",
                &plain,
                &delivery,
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
                "postgresql://local/db",
                &purge,
                &delivery,
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
}
