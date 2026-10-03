use std::fmt;

use crate::catalog::SchemaSource;
use crate::commands::history_gate::gate_migration_history;
use crate::commands::sync::{SettingsOptions, TableOptions};
use crate::commands::table_checks::{
    refuse_rls_disabled, refuse_unkeyed, rekeyed_proposals, review_proposal_keys,
    warn_unscoped_proposals,
};
use crate::commands::{OK, UNUSABLE};
use crate::config::KizunaSyncConfig;
use crate::db::{DbUrlSource, is_valid_schema_name, redact_db_url, resolve_db_url, session_mode};
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::management::ProjectSummary;
use crate::project_ref::ProjectRef;
use crate::prompts::Prompter;
use crate::proposals::{SchemaCatalog, describe_key_columns};
use crate::provision::LedgerRow;
use crate::server_facts::ServerFacts;
use crate::supabase_cli::{PushTarget, SupabaseCli};
use crate::token::TokenStore;
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

use super::{
    CONFIRM_REFUSAL, DatabaseState, Decided, DirectConnection, PACK_NOT_FOUND, RunContext,
    decide_from_flags, perform_writes, prepare_emit, print_dry_run, read_direct_ledger,
    reconcile_direct, recorded_contract, report_pg_cron, test_direct_connection,
};

// MARK: - flags and ports

/// What `kizunasync init` was asked to do.
// A flag surface is a bag of switches; a state machine would only hide which
// flag the user typed.
#[expect(clippy::struct_excessive_bools)]
#[derive(Clone)]
pub struct InitFlags {
    /// Print the plan and change nothing.
    pub dry_run: bool,
    /// Write without asking.
    pub yes: bool,
    /// Write migrations but do not apply.
    pub local_only: bool,
    /// Schema for non-interactive introspection.
    pub schema: String,
    /// Provision the hosted project over the Management API.
    pub project_ref: Option<ProjectRef>,
    /// Explicit Postgres URL for introspection.
    pub db_url: Option<String>,
    /// PAT for `--project-ref`.
    pub access_token: Option<String>,
    /// The contract every provisioned table is given, for the columns `init`
    /// has flags for.
    pub options: TableOptions,
    /// The project settings this run declares.
    pub settings: SettingsOptions,
    /// Install even when pg_cron is absent, with retention run by hand.
    pub allow_no_cron: bool,
    /// Provision a table whose row level security is disabled.
    pub allow_no_rls: bool,
}

impl fmt::Debug for InitFlags {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InitFlags")
            .field("dry_run", &self.dry_run)
            .field("yes", &self.yes)
            .field("local_only", &self.local_only)
            .field("schema", &self.schema)
            .field("project_ref", &self.project_ref)
            .field("db_url", &self.db_url.as_deref().map(redact_db_url))
            .field("access_token", &self.access_token.as_ref().map(|_| "***"))
            .field("options", &self.options)
            .field("settings", &self.settings)
            .field("allow_no_cron", &self.allow_no_cron)
            .field("allow_no_rls", &self.allow_no_rls)
            .finish()
    }
}

/// Everything `init` reaches outside through.
pub struct InitPorts<'a> {
    /// The question backend, absent when the session cannot prompt.
    pub prompter: Option<&'a mut dyn Prompter>,
    /// Live introspection: schemas, base tables, policies, and columns.
    pub schemas: &'a dyn SchemaSource,
    /// The Supabase CLI: `supabase db push` applies the emitted migrations and
    /// `supabase migration repair` settles the history before they are written.
    /// Spawns the real binary in production.
    pub supabase: &'a dyn SupabaseCli,
    /// The instant the emitted migrations are named after, in UTC epoch
    /// seconds.
    pub now_unix: i64,
    /// The OS credential store the token ladder's keyring rung reads. Injected
    /// so no test can reach a real keychain.
    pub tokens: &'a dyn TokenStore,
    /// The account's projects, fetched only once the user picks the account
    /// candidate: the wizard's one network call before a transport exists.
    pub list_projects: &'a dyn Fn(&str) -> crate::error::Result<Vec<ProjectSummary>>,
    /// Official `supabase login` (browser → keychain). Injected so tests
    /// never spawn a browser. A failure falls through to the masked paste.
    pub browser_login: &'a dyn Fn() -> crate::error::Result<()>,
    /// The connection test for a project reached over the Management API,
    /// given its ref and the token: reads the server facts over the API.
    pub probe_remote: &'a dyn Fn(&ProjectRef, &str) -> crate::error::Result<ServerFacts>,
}

/// What an empty masked entry prints here. `sync` passes its own, which names
/// the flags that skip the database entirely.
pub const NO_CONNECTION_ENTERED: &str = "  no connection string provided: aborting.";

// MARK: - non-interactive path

/// The flag-driven install: resolve the connection from the flags and the
/// environment, decide the contract without asking anything, and write.
/// Returns the exit code the command ends on.
pub(crate) fn run_non_interactive(
    flags: &InitFlags,
    context: &RunContext<'_>,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let connection = if flags.local_only {
        ui.log("  --local-only: skipping DB checks (no pg_policies read, no RLS check).");
        None
    } else {
        match read_policies(
            flags,
            context.paths,
            context.env,
            context.env_files,
            ports,
            ui,
        ) {
            Ok(connection) => Some(connection),
            Err(code) => return code,
        }
    };
    let unread = SchemaCatalog::default();
    let catalog = connection
        .as_ref()
        .map_or(&unread, |connection| &connection.catalog);
    let mut decided = decide_from_flags(flags, catalog);
    if let Some(code) = check_proposed_tables(flags, &decided, connection.as_ref(), ui) {
        return code;
    }
    let synced = match read_recorded(connection.as_ref(), &mut decided, ports.schemas, ui) {
        Ok(synced) => synced,
        Err(code) => return code,
    };
    let database = connection.as_ref().map(|read| DatabaseState {
        ledger: &read.ledger,
        synced: &synced,
    });

    let recorded = match &connection {
        Some(read) if flags.yes && !flags.local_only && !flags.dry_run => {
            match gate_before_writes(read, context, ports, ui) {
                Ok(versions) => versions,
                Err(code) => return code,
            }
        }
        Some(_) | None => Vec::new(),
    };

    let emit = match prepare_emit(
        context.paths,
        context.env,
        &decided,
        ports.now_unix,
        &recorded,
        false,
        database.as_ref(),
    ) {
        Ok(Some(emit)) => emit,
        Ok(None) => {
            ui.log(PACK_NOT_FOUND);

            return UNUSABLE;
        }
        Err(cause) => {
            ui.error(&format!("  {cause}"));

            return UNUSABLE;
        }
    };

    if flags.dry_run {
        let code = print_dry_run(&emit, ui);
        let Some(read) = &connection else {
            return code;
        };

        // The comparison the real run makes before it writes, with nobody to
        // ask: drift is reported with the command that settles it, never
        // repaired, and ends the dry run on the exit the real run would.
        return match gate_migration_history(
            &read.connection,
            context.paths,
            ports.schemas,
            ports.supabase,
            &mut None,
            ui,
        ) {
            Ok(_) => code,
            Err(stop) => stop,
        };
    }

    if !flags.yes {
        ui.log(CONFIRM_REFUSAL);

        return UNUSABLE;
    }

    let direct = connection
        .as_ref()
        .map(|read| &read.connection)
        .filter(|_| !flags.local_only);
    let code = perform_writes(&emit, direct, context.paths, ports, flags.yes, ui);
    if code != OK {
        return code;
    }

    let Some(read) = connection.filter(|_| !flags.local_only) else {
        return OK;
    };

    report_pg_cron(
        ports.schemas.pg_cron_present(&read.connection.url),
        decided.allow_no_cron,
        ui,
    )
}

/// The pack gate and the migration-history gate a run that writes passes
/// first, over `read`'s connection with nobody to ask. `Ok` carries the
/// versions the history recorded.
fn gate_before_writes(
    read: &PolicyRead,
    context: &RunContext<'_>,
    ports: &InitPorts<'_>,
    ui: &mut Ui,
) -> Result<Vec<String>, i32> {
    reconcile_direct(
        &read.connection,
        &read.ledger,
        context.env,
        ports.schemas,
        &mut None,
        ui,
    )?;

    gate_migration_history(
        &read.connection,
        context.paths,
        ports.schemas,
        ports.supabase,
        &mut None,
        ui,
    )
}

/// The catalog the tables the run provisions were derived from, the
/// connection that answered, which is also the one the pg_cron gate asks and
/// the one the migrations are pushed to, and the provision ledger it holds.
struct PolicyRead {
    catalog: SchemaCatalog,
    connection: DirectConnection,
    ledger: Vec<LedgerRow>,
}

/// Name the tables `connection` proposed, refuse one the pack cannot key,
/// one whose row level security is disabled, and a read-write one keyed by a
/// generated always identity, then note the offline inserts of a read-write
/// one whose key has a database default and warn about the deletes of an
/// unscoped read-write one. `Some(2)` is the refusal.
fn check_proposed_tables(
    flags: &InitFlags,
    decided: &Decided,
    connection: Option<&PolicyRead>,
    ui: &mut Ui,
) -> Option<i32> {
    if let Some(read) = connection {
        report_proposals(decided, ui);
        let tables = || {
            decided
                .proposals
                .iter()
                .map(|proposal| proposal.table.as_str())
        };
        if let Some(code) = refuse_unkeyed(tables(), &read.catalog, ui).or_else(|| {
            refuse_rls_disabled(tables(), &read.catalog.rls_disabled, flags.allow_no_rls, ui)
        }) {
            return Some(code);
        }
    }
    if let Some(code) = review_proposal_keys(&decided.proposals, ui) {
        return Some(code);
    }

    warn_unscoped_proposals(&decided.proposals, ui);

    None
}

/// The synced-table contract `read`'s database records, none without a
/// connection, with the tables of `decided` whose key moves past it recorded
/// on `decided`.
///
/// # Errors
/// Returns `2` once the reason is on `ui`: the contract cannot be read, or a
/// key moves without the schema version the move needs.
fn read_recorded(
    read: Option<&PolicyRead>,
    decided: &mut Decided,
    schemas: &dyn crate::catalog::SchemaSource,
    ui: &mut Ui,
) -> Result<KizunaSyncConfig, i32> {
    let synced = match read {
        Some(read) => recorded_contract(&read.ledger, || schemas.read_config(&read.connection.url))
            .map_err(|cause| {
                ui.error(&format!("  {cause}"));

                UNUSABLE
            })?,
        None => KizunaSyncConfig::default(),
    };
    decided.rekeyed = rekeyed_proposals(&decided.proposals, &synced, ui)?;

    Ok(synced)
}

/// The tables this run provisions, named back with the provenance that
/// proposed them.
fn report_proposals(decided: &Decided, ui: &mut Ui) {
    ui.log(&format!(
        "  proposed {} synced table(s) from RLS policies:",
        decided.proposals.len()
    ));
    for proposal in &decided.proposals {
        ui.log(&format!(
            "    - {}  key {}  {}",
            proposal.table,
            describe_key_columns(&proposal.key_columns()),
            proposal.provenance
        ));
    }
    ui.log("");
}

fn read_policies(
    flags: &InitFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    ports: &InitPorts<'_>,
    ui: &mut Ui,
) -> Result<PolicyRead, i32> {
    if !is_valid_schema_name(&flags.schema) {
        ui.log(&format!(
            "  invalid --schema {:?}: must be a valid Postgres identifier.",
            flags.schema
        ));

        return Err(UNUSABLE);
    }

    let resolved = match resolve_db_url(flags.db_url.as_deref(), env, env_files, paths) {
        Ok(resolved) => resolved,
        Err(cause) => {
            ui.log(&format!(
                "  {cause}\n  or re-run with --local-only to skip the DB checks entirely."
            ));

            return Err(UNUSABLE);
        }
    };

    ui.log(&format!(
        "  database:         {} ({})",
        redact_db_url(&resolved.url),
        resolved.source
    ));
    let push_to_local = resolved.source == DbUrlSource::LocalConfig;
    let url = session_mode(resolved.url, resolved.source.key(), ui);
    let connection = DirectConnection {
        push: if push_to_local {
            PushTarget::Local
        } else {
            PushTarget::DbUrl(url.clone())
        },
        url,
    };

    if let Err(code) = test_direct_connection(&connection, ports.schemas, &mut None, ui) {
        ui.log("  re-run with --local-only to write migrations without the DB checks.");

        return Err(code);
    }

    let ledger = read_direct_ledger(&connection, ports.schemas, ui)?;
    let catalog = match ports.schemas.introspect(&connection.url, &flags.schema) {
        Ok(catalog) => catalog,
        Err(cause) => {
            ui.log(&format!("  pg_policies introspection failed:\n    {cause}"));

            return Err(UNUSABLE);
        }
    };

    Ok(PolicyRead {
        catalog,
        connection,
        ledger,
    })
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn flags() -> InitFlags {
        InitFlags {
            dry_run: false,
            yes: true,
            local_only: false,
            schema: "public".to_owned(),
            project_ref: None,
            db_url: Some("postgresql://postgres:hunter2@127.0.0.1:54322/postgres".to_owned()),
            access_token: Some("sbp_0123456789abcdef0123456789abcdef01234567".to_owned()),
            options: TableOptions::default(),
            settings: SettingsOptions::default(),
            allow_no_cron: false,
            allow_no_rls: false,
        }
    }

    #[test]
    fn debug_never_prints_the_db_password_or_the_access_token() {
        let rendered = format!("{:?}", flags());

        assert!(!rendered.contains("hunter2"), "{rendered}");
        assert!(!rendered.contains("sbp_0123456789abcdef"), "{rendered}");
        assert!(rendered.contains("127.0.0.1:54322"), "{rendered}");
        assert!(
            rendered.contains("access_token: Some(\"***\")"),
            "{rendered}"
        );
    }
}
