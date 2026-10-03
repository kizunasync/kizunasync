//! Parse `kizunasync._provisions` rows into ordered DROP SQL.
//!
//! `deprovision` removes exactly what `init` recorded, no more, no less. This
//! module is the pure core: rows in, ordered DROP statements out. No DB access.
//!
//! `object_name` carries three shapes, and the only reliable discriminator is
//! `object_kind`: `schema.name` for a function, `schema.table.name` for a
//! policy or a trigger, and `schema.table` for a config row. A policy and a
//! trigger share one shape, so they are told apart by kind, never by parsing
//! the name.

use std::collections::BTreeMap;

use crate::constants::{INTERNAL_CONFIG, INTERNAL_PROVISIONS, SCHEMA};

/// The object kinds the ledger records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectKind {
    /// A function.
    Function,
    /// A trigger.
    Trigger,
    /// A pg_cron job.
    Cron,
    /// An RLS policy.
    Policy,
    /// A `kizunasync._config` metadata row.
    Config,
    /// A cluster role (e.g. the RLS-enforcing owner role).
    Role,
    /// A per-file accounting row.
    PackFile,
    /// Anything the ledger holds that this version does not know.
    Unknown(String),
}

impl ObjectKind {
    /// Read a ledger `object_kind` value.
    #[must_use]
    pub fn parse(value: &str) -> Self {
        match value {
            "function" => Self::Function,
            "trigger" => Self::Trigger,
            "cron" => Self::Cron,
            "policy" => Self::Policy,
            "config" => Self::Config,
            "role" => Self::Role,
            "pack-file" => Self::PackFile,
            other => Self::Unknown(other.to_owned()),
        }
    }

    /// The ledger's own spelling.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Function => "function",
            Self::Trigger => "trigger",
            Self::Cron => "cron",
            Self::Policy => "policy",
            Self::Config => "config",
            Self::Role => "role",
            Self::PackFile => "pack-file",
            Self::Unknown(value) => value,
        }
    }
}

/// One ledger row, as `deprovision` consumes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvisionRow {
    /// What kind of object it is.
    pub object_kind: ObjectKind,
    /// Its recorded name.
    pub object_name: String,
    /// For `function`: the identity argument signature. A function the pack
    /// seeds with no arguments records NULL here, and its DROP falls back to
    /// the no-parens, args-agnostic form. Ignored for every other kind.
    pub object_args: Option<String>,
}

/// A DROP the plan will run, and the row that produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DropStatement {
    /// Provenance for the human plan.
    pub row: ProvisionRow,
    /// The statement.
    pub sql: String,
}

/// A row that could not be turned into a DROP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseWarning {
    /// The row.
    pub row: ProvisionRow,
    /// Why it produced nothing.
    pub reason: String,
}

/// The ordered teardown.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DropPlan {
    /// Statements, in reverse dependency order.
    pub statements: Vec<DropStatement>,
    /// Rows that produced no DROP, never silent drops.
    pub warnings: Vec<ParseWarning>,
}

/// DROP in reverse of how `init` builds up: dependents before their
/// dependencies. Triggers and policies hang off tables and reference functions,
/// so they go first; then cron jobs; then functions; then the owning role,
/// dropped only after the functions it owns are gone, so `drop owned by` has
/// nothing left but grants to revoke. Config and pack-file rows trail.
const KIND_DROP_ORDER: [&str; 7] = [
    "trigger",
    "policy",
    "cron",
    "function",
    "role",
    "config",
    "pack-file",
];

fn kind_rank(kind: &ObjectKind) -> usize {
    KIND_DROP_ORDER
        .iter()
        .position(|entry| *entry == kind.as_str())
        .unwrap_or(KIND_DROP_ORDER.len())
}

/// Schema-qualify and double-quote an identifier so a reserved word or odd name
/// survives.
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

fn escape_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// A Postgres function argument signature (`p_x text, numeric(10,2), text[]`,
/// quoted idents allowed): the one ledger field interpolated raw into DROP
/// FUNCTION. Whitelist only the characters legitimate signatures use; a `;`, a
/// quote, a comment (`-`/`/`) or a `$` cannot appear, so a tampered
/// `_provisions` row cannot break out of the signature to inject SQL.
fn is_safe_arg_signature(value: &str) -> bool {
    value.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, '_' | ',' | '.' | '(' | ')' | '[' | ']' | '"')
            || c.is_whitespace()
    })
}

struct NameParts<'a> {
    schema: &'a str,
    table: &'a str,
    rest: &'a str,
}

fn split_first_two(name: &str) -> Option<NameParts<'_>> {
    let first = name.find('.')?;
    let (schema, after_first) = (name.get(..first)?, name.get(first + 1..)?);

    match after_first.find('.') {
        None => Some(NameParts {
            schema,
            table: after_first,
            rest: "",
        }),
        Some(second) => Some(NameParts {
            schema,
            table: after_first.get(..second)?,
            rest: after_first.get(second + 1..)?,
        }),
    }
}

/// The name after the schema, re-joined when the row carried more dots than the
/// kind expects.
fn tail(parts: &NameParts<'_>) -> String {
    if parts.rest.is_empty() {
        parts.table.to_owned()
    } else {
        format!("{}.{}", parts.table, parts.rest)
    }
}

/// Build the DROP SQL for one ledger row. Never panics.
///
/// One arm per ledger object kind, deliberately kept as a single exhaustive
/// match: the compiler is what guarantees a new kind cannot be added without a
/// drop rule, and splitting the dispatch would trade that guarantee for a line
/// count.
///
/// # Errors
/// Returns a [`ParseWarning`] when the recorded name does not fit the kind's
/// shape, when a function signature is unsafe to interpolate, when a name that
/// lands inside a dollar-quoted block carries `$`, or when the kind is one this
/// version does not know.
pub fn drop_for_row(row: &ProvisionRow) -> std::result::Result<DropStatement, ParseWarning> {
    let name = row.object_name.as_str();
    let parts = split_first_two(name);

    let sql = match &row.object_kind {
        ObjectKind::Function => drop_function_sql(name, parts, row.object_args.as_deref()),
        ObjectKind::Trigger => drop_on_table_sql("trigger", name, parts, "schema.table.trigger"),
        ObjectKind::Policy => drop_on_table_sql("policy", name, parts, "schema.table.<policy>"),
        ObjectKind::Config => drop_config_sql(name, parts),
        ObjectKind::Role => drop_role_sql(name),
        ObjectKind::PackFile => Ok(format!(
            "delete from {SCHEMA}.{INTERNAL_PROVISIONS} where object_kind = 'pack-file' and object_name = '{}';",
            escape_literal(name)
        )),
        ObjectKind::Cron => drop_cron_sql(name),
        ObjectKind::Unknown(kind) => Err(format!("unknown object_kind \"{kind}\"")),
    };

    sql.map(|sql| DropStatement {
        row: row.clone(),
        sql,
    })
    .map_err(|reason| ParseWarning {
        row: row.clone(),
        reason,
    })
}

fn drop_function_sql(
    name: &str,
    parts: Option<NameParts<'_>>,
    args: Option<&str>,
) -> std::result::Result<String, String> {
    let Some(parts) = parts else {
        return Err(format!("function name \"{name}\" is not schema-qualified"));
    };
    let target = format!(
        "{}.{}",
        quote_ident(parts.schema),
        quote_ident(&tail(&parts))
    );
    let signature = match args {
        None => String::new(),
        Some(args) if is_safe_arg_signature(args) => format!("({args})"),
        Some(_) => {
            return Err(format!(
                "function \"{name}\" has an unsafe object_args signature: refused"
            ));
        }
    };

    Ok(format!(
        "drop function if exists {target}{signature} cascade;"
    ))
}

/// `drop trigger`/`drop policy` share a shape: both live on `schema.table.<name>`.
fn drop_on_table_sql(
    kind: &str,
    name: &str,
    parts: Option<NameParts<'_>>,
    expected_shape: &str,
) -> std::result::Result<String, String> {
    match parts {
        Some(parts) if !parts.rest.is_empty() => Ok(format!(
            "drop {kind} if exists {} on {}.{};",
            quote_ident(parts.rest),
            quote_ident(parts.schema),
            quote_ident(parts.table)
        )),
        _ => Err(format!("{kind} name \"{name}\" must be {expected_shape}")),
    }
}

fn drop_config_sql(
    name: &str,
    parts: Option<NameParts<'_>>,
) -> std::result::Result<String, String> {
    let Some(parts) = parts else {
        return Err(format!("config name \"{name}\" is not schema.table"));
    };

    Ok(format!(
        "delete from {SCHEMA}.{INTERNAL_CONFIG} where table_name = '{}';",
        escape_literal(&tail(&parts))
    ))
}

/// The prefix every role the pack creates carries. `drop owned by` drops
/// whatever the role still owns in this database, so a ledger row naming any
/// other role (`postgres`, `authenticated`) would take that role's objects
/// with it: such a row is refused into a warning instead.
const ROLE_PREFIX: &str = "kizunasync";

/// The name is interpolated INSIDE `do $$ … $$`, so a `$` in it could close
/// the dollar quoting and let the rest parse as SQL: refuse it (same guard as
/// [`drop_cron_sql`]). `drop owned by` first clears the role's grants and any
/// object it still owns in this database (its functions are dropped earlier
/// by their own ledger rows). A role is a cluster object, so another database
/// of the same server can still own objects through it: `drop role` runs in
/// its own savepoint (the block's exception handler), and on 2BP01 the role
/// stays while the rest of the teardown commits. Guarded by an existence check
/// so a re-run is idempotent. Only a role named with [`ROLE_PREFIX`] is
/// dropped.
fn drop_role_sql(name: &str) -> std::result::Result<String, String> {
    if !name.starts_with(ROLE_PREFIX) {
        return Err(format!(
            "role \"{name}\" does not start with \"{ROLE_PREFIX}\", so it is not a role the pack created: refused"
        ));
    }
    if name.contains('$') {
        return Err(format!(
            "role \"{name}\" contains \"$\", which would break the DO block's dollar quoting: refused"
        ));
    }
    let escaped = escape_literal(name);
    let ident = quote_ident(name);

    Ok(format!(
        "do $$ begin if exists (select 1 from pg_roles where rolname = '{escaped}') then \
         drop owned by {ident}; \
         begin drop role {ident}; exception when dependent_objects_still_exist then null; end; \
         end if; end $$;"
    ))
}

/// The name is interpolated INSIDE `do $$ … $$`, so a `$` in it could close
/// the dollar quoting and let the rest parse as SQL. Doubling quotes cannot
/// help there: refuse the row into the same not-dropped warning an
/// unparseable name gets.
fn drop_cron_sql(name: &str) -> std::result::Result<String, String> {
    if name.contains('$') {
        return Err(format!(
            "cron job \"{name}\" contains \"$\", which would break the DO block's dollar quoting: refused"
        ));
    }
    let escaped = escape_literal(name);

    Ok(format!(
        "do $$ begin if exists (select 1 from pg_extension where extname = 'pg_cron') then \
         perform cron.unschedule('{escaped}') where exists \
         (select 1 from cron.job where jobname = '{escaped}'); end if; end $$;"
    ))
}

/// The relation `row`'s DROP statement needs to run: the table a trigger or
/// policy sits on, and the bookkeeping table a config or `pack-file` row is
/// deleted from. `None` for the statements that run over any state (a
/// function's `if exists`, and the role and cron blocks that check first).
#[must_use]
pub fn required_relation(row: &ProvisionRow) -> Option<String> {
    match &row.object_kind {
        ObjectKind::Trigger | ObjectKind::Policy => split_first_two(&row.object_name)
            .map(|parts| format!("{}.{}", quote_ident(parts.schema), quote_ident(parts.table))),
        ObjectKind::Config => Some(format!("{SCHEMA}.{INTERNAL_CONFIG}")),
        ObjectKind::PackFile => Some(format!("{SCHEMA}.{INTERNAL_PROVISIONS}")),
        ObjectKind::Function | ObjectKind::Role | ObjectKind::Cron | ObjectKind::Unknown(_) => None,
    }
}

/// Turn the full ledger into an ordered DROP plan. Rows are sorted by
/// reverse-dependency kind rank; within a kind the ledger order is reversed so
/// the newest-provisioned object drops first. Unparseable rows become warnings,
/// never silent drops.
#[must_use]
pub fn build_drop_plan(rows: &[ProvisionRow]) -> DropPlan {
    let mut indexed: Vec<(usize, &ProvisionRow)> = rows.iter().enumerate().collect();
    indexed.sort_by(|(left_index, left), (right_index, right)| {
        kind_rank(&left.object_kind)
            .cmp(&kind_rank(&right.object_kind))
            .then(right_index.cmp(left_index))
    });

    let mut plan = DropPlan::default();
    for (_, row) in indexed {
        match drop_for_row(row) {
            Ok(statement) => plan.statements.push(statement),
            Err(warning) => plan.warnings.push(warning),
        }
    }

    plan
}

/// Whether the ledger mixes `object_name` formats. The ledger is never
/// rewritten here: the CLI reports mixed formats so a human can inspect them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CanonicalizationReport {
    /// True if mixed `object_name` formats were found.
    pub warranted: bool,
    /// One note per finding.
    pub notes: Vec<String>,
}

/// Audit the ledger's name formats.
#[must_use]
pub fn audit_object_names(rows: &[ProvisionRow]) -> CanonicalizationReport {
    let mut notes = Vec::new();
    let mut arity_by_kind: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut policy_with_spaces = false;

    for row in rows {
        let arity = row.object_name.split('.').count();
        let entry = arity_by_kind
            .entry(row.object_kind.as_str().to_owned())
            .or_default();
        if !entry.contains(&arity) {
            entry.push(arity);
        }
        if row.object_kind == ObjectKind::Policy && row.object_name.chars().any(char::is_whitespace)
        {
            policy_with_spaces = true;
        }
    }

    for (kind, arities) in &arity_by_kind {
        if arities.len() > 1 {
            let mut sorted: Vec<String> = arities.iter().map(ToString::to_string).collect();
            sorted.sort();
            notes.push(format!(
                "object_kind=\"{kind}\" mixes {} dot-arities ({}): name format is not uniform",
                arities.len(),
                sorted.join(", ")
            ));
        }
    }
    if policy_with_spaces {
        notes.push(
            "policy object_name carries spaces (schema.table.<policy with spaces>): only the object_kind distinguishes it from a trigger; a purely structural parser would misread it".to_owned(),
        );
    }
    // function "schema.name" (arity 2) vs trigger/policy "schema.table.name"
    // (arity 3) vs config "schema.table" (arity 2): function and config collide
    // on arity, so kind is load-bearing for parsing. Flag that explicitly.
    let has_two = |kind: &str| {
        arity_by_kind
            .get(kind)
            .is_some_and(|arities| arities.contains(&2))
    };
    if has_two("function") && has_two("config") {
        notes.push(
            "object_kind=\"function\" and \"config\" both use 2-part \"schema.name\" object_names, they are only told apart by object_kind, not by the name".to_owned(),
        );
    }

    CanonicalizationReport {
        warranted: !notes.is_empty(),
        notes,
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn row(kind: &str, name: &str) -> ProvisionRow {
        ProvisionRow {
            object_kind: ObjectKind::parse(kind),
            object_name: name.to_owned(),
            object_args: None,
        }
    }

    fn sql_of(kind: &str, name: &str) -> String {
        drop_for_row(&row(kind, name))
            .map(|statement| statement.sql)
            .unwrap()
    }

    #[test]
    fn a_function_row_with_no_recorded_args_drops_without_parentheses() {
        assert_eq!(
            sql_of("function", "kizunasync.track_change"),
            "drop function if exists \"kizunasync\".\"track_change\" cascade;"
        );
    }

    #[test]
    fn a_self_describing_function_row_drops_by_exact_signature() {
        let mut function = row("function", "kizunasync.pull");
        function.object_args = Some("p_hlc text, p_now timestamptz".to_owned());

        assert_eq!(
            drop_for_row(&function).unwrap().sql,
            "drop function if exists \"kizunasync\".\"pull\"(p_hlc text, p_now timestamptz) cascade;"
        );
    }

    #[test]
    fn an_unsafe_signature_is_refused_into_a_warning() {
        let mut function = row("function", "kizunasync.pull");
        function.object_args = Some("text); drop table users; --".to_owned());

        let warning = drop_for_row(&function).unwrap_err();
        assert!(warning.reason.contains("unsafe object_args signature"));
    }

    #[test]
    fn triggers_and_policies_are_told_apart_by_kind_not_by_name_shape() {
        assert_eq!(
            sql_of("trigger", "public.todos.kizunasync_track_change"),
            "drop trigger if exists \"kizunasync_track_change\" on \"public\".\"todos\";"
        );
        assert_eq!(
            sql_of("policy", "realtime.messages.kizunasync wakeup receive"),
            "drop policy if exists \"kizunasync wakeup receive\" on \"realtime\".\"messages\";"
        );
    }

    #[test]
    fn a_config_row_is_a_metadata_delete_never_a_table_drop() {
        assert_eq!(
            sql_of("config", "public.todos"),
            "delete from kizunasync._config where table_name = 'todos';"
        );
    }

    #[test]
    fn a_pack_file_row_deletes_itself_and_is_never_schema_split() {
        assert_eq!(
            sql_of("pack-file", "0001_kizuna_init.sql"),
            "delete from kizunasync._provisions where object_kind = 'pack-file' and object_name = '0001_kizuna_init.sql';"
        );
    }

    #[test]
    fn a_cron_row_is_guarded_and_refuses_a_dollar_in_its_name() {
        let sql = sql_of("cron", "kizunasync_retention");
        assert!(sql.starts_with(
            "do $$ begin if exists (select 1 from pg_extension where extname = 'pg_cron')"
        ));
        assert!(sql.contains("cron.unschedule('kizunasync_retention')"));

        let warning = drop_for_row(&row("cron", "job$$evil")).unwrap_err();
        assert!(warning.reason.contains("dollar quoting"));
    }

    #[test]
    fn a_role_drops_owned_then_the_role_guarded_and_refuses_a_dollar() {
        let sql = sql_of("role", "kizunasync_rls");
        assert!(
            sql.contains("if exists (select 1 from pg_roles where rolname = 'kizunasync_rls')")
        );
        assert!(sql.contains("drop owned by \"kizunasync_rls\";"));
        assert!(sql.contains("drop role \"kizunasync_rls\";"));

        let warning = drop_for_row(&row("role", "kizunasync_ev$$il")).unwrap_err();
        assert!(warning.reason.contains("dollar quoting"));
    }

    /// The role is a cluster object: `drop owned by` clears it from this
    /// database, and `drop role` runs in its own savepoint, so a role another
    /// database still uses (2BP01) stays and the teardown goes on.
    #[test]
    fn a_role_another_database_still_uses_is_kept_inside_a_savepoint() {
        let sql = sql_of("role", "kizunasync_rls");
        let owned = sql.find("drop owned by \"kizunasync_rls\";").unwrap();
        let savepoint = sql.find("begin drop role \"kizunasync_rls\";").unwrap();

        assert!(owned < savepoint, "{sql}");
        assert!(
            sql.contains("exception when dependent_objects_still_exist then null; end;"),
            "{sql}"
        );
    }

    /// `drop owned by` drops what the role owns, so a tampered or foreign row
    /// naming a role the pack never created is a warning, never a drop.
    #[test]
    fn a_role_the_pack_did_not_create_is_never_dropped() {
        for name in [
            "postgres",
            "authenticated",
            "service_role",
            "kizuna_rls",
            "",
        ] {
            let warning = drop_for_row(&row("role", name)).unwrap_err();

            assert!(
                warning.reason.contains("not a role the pack created"),
                "{name}: {}",
                warning.reason
            );
        }

        let plan = build_drop_plan(&[row("role", "postgres"), row("role", "kizunasync_rls")]);
        assert_eq!(plan.statements.len(), 1);
        assert!(plan.statements[0].sql.contains("\"kizunasync_rls\""));
        assert_eq!(plan.warnings.len(), 1);
    }

    #[test]
    fn a_role_drops_after_the_functions_it_owns() {
        let rows = vec![
            row("role", "kizunasync_rls"),
            row("function", "kizunasync._render_user_row"),
            row("config", "public.todos"),
        ];
        let plan = build_drop_plan(&rows);
        let kinds: Vec<&str> = plan
            .statements
            .iter()
            .map(|s| s.row.object_kind.as_str())
            .collect();

        assert_eq!(kinds, ["function", "role", "config"]);
    }

    #[test]
    fn an_unparseable_name_becomes_a_warning_never_a_silent_drop() {
        assert!(drop_for_row(&row("function", "bare_name")).is_err());
        assert!(drop_for_row(&row("trigger", "public.todos")).is_err());
        assert!(drop_for_row(&row("policy", "public.todos")).is_err());
        assert!(drop_for_row(&row("config", "bare")).is_err());
        assert!(drop_for_row(&row("gremlin", "whatever")).is_err());
    }

    #[test]
    fn the_plan_orders_dependents_before_dependencies_and_reverses_within_a_kind() {
        let rows = vec![
            row("pack-file", "0001_kizuna_init.sql"),
            row("function", "kizunasync.pull"),
            row("function", "kizunasync.push"),
            row("trigger", "public.todos.kizunasync_track_change"),
            row("config", "public.todos"),
        ];
        let plan = build_drop_plan(&rows);
        let kinds: Vec<&str> = plan
            .statements
            .iter()
            .map(|s| s.row.object_kind.as_str())
            .collect();

        assert_eq!(
            kinds,
            ["trigger", "function", "function", "config", "pack-file"]
        );
        // Newest-provisioned first within a kind: push was recorded after pull.
        assert!(plan.statements[1].sql.contains("push"));
        assert!(plan.statements[2].sql.contains("pull"));
        assert_eq!(plan.warnings, Vec::<ParseWarning>::new());
    }

    #[test]
    fn unknown_kinds_are_warned_about_and_never_ordered_into_the_drops() {
        let plan = build_drop_plan(&[row("gremlin", "x"), row("config", "public.t")]);

        assert_eq!(plan.statements.len(), 1);
        assert_eq!(plan.warnings.len(), 1);
        assert_eq!(plan.warnings[0].reason, "unknown object_kind \"gremlin\"");
    }

    #[test]
    fn a_ledger_mixing_arities_spaced_names_and_a_kind_only_collision_warrants_canonicalization() {
        let report = audit_object_names(&[
            row("function", "kizunasync.pull"),
            row("config", "public.todos"),
            row("policy", "realtime.messages.kizunasync wakeup receive"),
            row("trigger", "public.todos.t"),
            row("trigger", "public.t2"),
        ]);

        assert!(report.warranted);
        assert!(
            report
                .notes
                .iter()
                .any(|note| note.contains("mixes 2 dot-arities"))
        );
        assert!(
            report
                .notes
                .iter()
                .any(|note| note.contains("policy object_name carries spaces"))
        );
        assert!(
            report
                .notes
                .iter()
                .any(|note| note.contains("only told apart by object_kind"))
        );
    }

    #[test]
    fn a_uniform_ledger_warrants_nothing() {
        let report = audit_object_names(&[
            row("trigger", "public.todos.t"),
            row("trigger", "public.notes.t"),
        ]);

        assert_eq!(report, CanonicalizationReport::default());
    }
}
