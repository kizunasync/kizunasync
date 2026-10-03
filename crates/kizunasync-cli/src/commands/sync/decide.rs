use std::collections::{BTreeSet, HashSet};

use crate::applier::Applier;
use crate::catalog::{SchemaSource, proposals_from_catalog};
use crate::commands::init::{
    ConnectionAnswers, DirectChoice, DirectConnection, Reopen, STEP_BACK, decided_without_asking,
    direct_connection_for, test_direct_connection,
};
use crate::commands::table_checks::{
    indented, keyed_choice, note_unavailable, refuse_rls_disabled, refuse_unkeyed, rekey_line,
};
use crate::commands::{OK, UNUSABLE};
use crate::config::{KizunaSyncConfig, ProjectSettings};
use crate::config_sql::DeclaredTableConfig;
use crate::db::{DbUrlSource, redact_db_url, resolve_db_url, session_mode};
use crate::discovery::{CONNECTION_PHASE, ConnectionCandidate, NOTHING_DISCOVERABLE, discover};
use crate::docs;
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::login_role::LinkedRoute;
use crate::management::redact_access_token;
use crate::project_ref::ProjectRef;
use crate::prompts::{PromptError, Prompter, TableChoice, WizardMode, sole_candidate};
use crate::proposals::{SchemaCatalog, TableProposal, introspect_catalog};
use crate::provision::LedgerRow;
use crate::supabase_cli::PushTarget;
use crate::sync_delta::DeltaUpdate;
use crate::token;
use crate::ui::Ui;
use crate::wizard::{Ladder, Reached, Step, table_choice};
use crate::wizard_theme::Mark;
use crate::workdir::ProjectPaths;

use super::keys::{rekey, rekey_kept, review_updates};
use super::{
    CANCELLED, LinkedConnector, NO_CONNECTION_ENTERED, NOTHING_WRITTEN, SyncFlags, SyncPorts,
    TableOptions,
};

// MARK: - the transport this run reads and applies through

/// Where this run reads `kizunasync._config` and applies its delta: a direct
/// Postgres connection, or the Management API's SQL endpoint when
/// `--project-ref` named a hosted project.
pub(crate) enum Target<'a> {
    /// A direct connection, held in memory only.
    Direct(DirectConnection),
    /// The Management API, already bound to a project and a token.
    Remote(&'a dyn Applier),
}

impl Target<'_> {
    /// The synced set this project already carries.
    ///
    /// # Errors
    /// Returns the transport's own failure, [`Error::Config`](crate::error::Error::Config)
    /// when `kizunasync._config` cannot be read, and
    /// [`Error::Boundary`](crate::error::Error::Boundary) when a row does not
    /// carry the columns the pack defines.
    pub(crate) fn read_config(
        &self,
        schemas: &dyn SchemaSource,
    ) -> crate::error::Result<KizunaSyncConfig> {
        match self {
            Self::Direct(direct) => schemas.read_config(&direct.url),
            Self::Remote(api) => crate::config::load_config_from_db(*api),
        }
    }

    /// The provision ledger's rows; empty when the ledger does not exist yet.
    ///
    /// # Errors
    /// Returns the transport's own failure, and
    /// [`Error::Provision`](crate::error::Error::Provision) when a row does
    /// not carry the columns the pack defines.
    pub(crate) fn read_ledger_rows(
        &self,
        schemas: &dyn SchemaSource,
    ) -> crate::error::Result<Vec<LedgerRow>> {
        match self {
            Self::Direct(direct) => schemas.ledger_rows(&direct.url),
            Self::Remote(api) => crate::provision::read_ledger_rows(*api),
        }
    }

    /// Tables, policies and columns in one schema.
    ///
    /// # Errors
    /// Returns the transport's own failure, [`Error::Db`](crate::error::Error::Db)
    /// when `schema` is not a valid Postgres identifier, and
    /// [`Error::Boundary`](crate::error::Error::Boundary) when a catalog row
    /// does not carry the columns the query selected.
    pub(crate) fn introspect(
        &self,
        schemas: &dyn SchemaSource,
        schema: &str,
    ) -> crate::error::Result<SchemaCatalog> {
        match self {
            Self::Direct(direct) => schemas.introspect(&direct.url, schema),
            Self::Remote(api) => introspect_catalog(*api, schema),
        }
    }
}

const NON_INTERACTIVE_USAGE: &str = concat!(
    "  nothing to change: pass --add <table> / --remove <table> (both repeatable),\n",
    "  or run `kizunasync sync` in a terminal to pick the synced set interactively."
);

/// What a flag-driven add knows about a table: its name, plus whatever the
/// per-table flags answered. Everything left unanswered is the pull-only
/// default a human can promote, the safe half of the sync contract.
const FLAG_PROVENANCE: &str = "[flag] added by kizunasync sync";

/// The same, when the flags did decide the contract.
const FLAG_PROVENANCE_ANSWERED: &str = "[flag] added by kizunasync sync with per-table options";

// MARK: - resolving the database

/// Every run reads `kizunasync._config`, so every run needs a database. A
/// scripted one resolves it from the same ladder the other DB-backed commands
/// use; a terminal with nothing to script gets the connection picker.
///
/// `answers` is what an earlier pass settled, which the picker reopens on.
///
/// # Errors
/// Returns the exit code the run stops with: no database resolved, or a
/// picker the user cancelled. Every sentence is already on the [`Ui`] by then.
#[expect(
    clippy::too_many_arguments,
    reason = "The run's context, threaded not stored."
)]
pub(crate) fn resolve_target<'a>(
    flags: &SyncFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    remote: Option<&'a dyn Applier>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
    answers: &mut ConnectionAnswers,
) -> std::result::Result<Target<'a>, i32> {
    if let Some(api) = remote {
        ui.log(&format!(
            "  project:          {} (Supabase Management API)",
            flags.project_ref.as_ref().map_or("", ProjectRef::as_str)
        ));

        return Ok(Target::Remote(api));
    }
    if let Some(connection) = &flags.connection {
        return Ok(Target::Direct(connection.clone()));
    }

    let scripted = !flags.add.is_empty() || !flags.remove.is_empty();
    if scripted || ports.prompter.is_none() {
        return resolve_url_scripted(flags, paths, env, env_files, scripted, ports.schemas, ui)
            .map(Target::Direct);
    }

    resolve_url_interactive(flags, paths, env, env_files, ports, ui, answers).map(Target::Direct)
}

/// The ladder every non-interactive command shares: `--db-url`, then the
/// environment, then the project's own files. only the redacted form is
/// ever echoed. The local stack's port rung pushes with `--local`; every other
/// rung with `--db-url`.
fn resolve_url_scripted(
    flags: &SyncFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    scripted: bool,
    schemas: &dyn SchemaSource,
    ui: &mut Ui,
) -> std::result::Result<DirectConnection, i32> {
    let resolved = match resolve_db_url(flags.db_url.as_deref(), env, env_files, paths) {
        Ok(resolved) => resolved,
        Err(cause) => {
            ui.log(&format!("  {cause}"));
            if !scripted {
                ui.log(NON_INTERACTIVE_USAGE);
            }

            return Err(UNUSABLE);
        }
    };

    crate::wizard_theme::detail(
        ui,
        &format!(
            "  database:         {} ({})",
            redact_db_url(&resolved.url),
            resolved.source
        ),
    );

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
    test_direct_connection(&connection, schemas, &mut None, ui)?;

    Ok(connection)
}

/// Resolve the connection, offering what this machine already has rather than
/// taking it silently. only the redacted form is ever echoed.
///
/// The line between deciding and asking is `init`'s, to the rung
/// ([`decided_without_asking`]): the `--db-url` flag and the process
/// environment are the user telling us where to go, so they still resolve
/// without a question, while a `.env` URL or the local stack is something we
/// FOUND and therefore something to confirm.
///
/// The candidates are the direct ones only ([`ConnectionCandidate::is_direct`]):
/// this command introspects a live schema and emits a migration. The linked
/// project is one of them, reached over a temporary Postgres login; when that
/// login cannot be opened, the picker is offered again without it.
///
/// Every settled connection is tested ([`test_direct_connection`]); a failed
/// test that asks for another pick lists the candidates again. Backspace on
/// the picker returns to the solution question, and a pass after the checkbox
/// went back reopens on the question `answers` settled.
fn resolve_url_interactive(
    flags: &SyncFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
    answers: &mut ConnectionAnswers,
) -> std::result::Result<DirectConnection, i32> {
    if answers.reopen_mark().is_none()
        && let Some(prompter) = ports.prompter.as_deref_mut()
        && let Err(error) = prompter.intro(docs::SYNC)
    {
        return Err(cancel_or_stop(prompter, &error, ui));
    }
    if let Some(direct) = decided_without_asking(flags.db_url.as_deref(), paths, env, env_files, ui)
    {
        match test_direct_connection(&direct, ports.schemas, &mut ports.prompter, ui) {
            Ok(_) => return Ok(direct),
            // Another pick was asked for: the candidates follow.
            Err(code) if code == STEP_BACK => {}
            Err(code) => return Err(code),
        }
    }

    if ports.prompter.is_none() {
        ui.log(NOTHING_DISCOVERABLE);
        ui.log(NON_INTERACTIVE_USAGE);

        return Err(UNUSABLE);
    }

    let mut candidates: Vec<ConnectionCandidate> = discover(paths, env, env_files)
        .map_err(|cause| {
            ui.error(&format!("  {cause}"));

            UNUSABLE
        })?
        .into_iter()
        .filter(ConnectionCandidate::is_direct)
        .collect();
    if candidates.is_empty() {
        ui.log(NOTHING_DISCOVERABLE);
        ui.log("");
    }
    candidates.push(ConnectionCandidate::Manual);

    let mut reopen = answers.reopening();
    loop {
        let solution = match answers.solution_mark(&reopen) {
            Some(solution) => solution,
            None => ask_solution(ports, ui)?,
        };
        let picker = Picker {
            flags,
            env,
            env_files,
            solution,
        };
        if let Some(direct) = pick_direct(&picker, &mut candidates, reopen, ports, ui, answers)? {
            return Ok(direct);
        }
        reopen = Reopen::Solution;
    }
}

/// The solution question and the connection phase under it, returning where
/// the question started.
fn ask_solution(ports: &mut SyncPorts<'_>, ui: &mut Ui) -> std::result::Result<Mark, i32> {
    let Some(prompter) = ports.prompter.as_deref_mut() else {
        ui.log(NON_INTERACTIVE_USAGE);

        return Err(UNUSABLE);
    };
    let solution = crate::wizard_theme::mark();
    if let Err(error) = prompter.select_solution() {
        return Err(cancel_or_stop(prompter, &error, ui));
    }
    if let Err(error) = prompter.phase(CONNECTION_PHASE) {
        return Err(cancel_or_stop(prompter, &error, ui));
    }

    Ok(solution)
}

/// What the picker and its rows read, fixed for one pass.
struct Picker<'a> {
    flags: &'a SyncFlags,
    env: &'a Env,
    env_files: &'a EnvFileValues,
    /// Where the solution question starts, which Backspace on the picker
    /// erases back to.
    solution: Mark,
}

/// The candidate list until the user settles on a connection that passes its
/// test, starting on `reopen`. A linked project whose login cannot be opened
/// leaves the list, and Backspace on the question a direct candidate asks
/// erases it and offers the list again, the way `init` rewinds to its own
/// list. `None` is Backspace on the picker, or on the connection string when
/// manual entry alone draws no picker: the solution question comes back.
fn pick_direct(
    picker: &Picker<'_>,
    candidates: &mut Vec<ConnectionCandidate>,
    mut reopen: Reopen,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
    answers: &mut ConnectionAnswers,
) -> std::result::Result<Option<DirectConnection>, i32> {
    loop {
        let list = answers.list_mark(&reopen);
        let drawn = sole_candidate(candidates).is_none();
        let Some(prompter) = ports.prompter.as_deref_mut() else {
            ui.log(NON_INTERACTIVE_USAGE);

            return Err(UNUSABLE);
        };
        let chosen = match std::mem::replace(&mut reopen, Reopen::Solution) {
            Reopen::Row(candidate) => candidate,
            Reopen::Solution | Reopen::Picker => {
                match prompter.select_candidate(candidates, answers.candidate()) {
                    Ok(chosen) => chosen,
                    Err(PromptError::Back) => {
                        crate::wizard_theme::rewind(picker.solution);

                        return Ok(None);
                    }
                    Err(error) => return Err(cancel_or_stop(prompter, &error, ui)),
                }
            }
        };
        answers.picked(&chosen);
        let row = crate::wizard_theme::mark();
        let Some(direct) = settle_row(picker, &chosen, candidates, ports, ui, answers, list)?
        else {
            if drawn {
                continue;
            }
            crate::wizard_theme::rewind(picker.solution);

            return Ok(None);
        };
        match test_direct_connection(&direct, ports.schemas, &mut ports.prompter, ui) {
            Ok(_) => {
                // Only a typed string and a `.env` URL ask a question of their own.
                let asks = matches!(
                    chosen,
                    ConnectionCandidate::Manual | ConnectionCandidate::EnvUrl { .. }
                );
                answers.settle(picker.solution, list, asks.then_some(row));

                return Ok(Some(direct));
            }
            Err(code) if code == STEP_BACK => {}
            Err(code) => return Err(code),
        }
    }
}

/// The connection the picked row names. `None` asks for the list again: a
/// linked project whose login cannot be opened leaves it, and Backspace on a
/// row's own question erases it back to `list`.
fn settle_row(
    picker: &Picker<'_>,
    chosen: &ConnectionCandidate,
    candidates: &mut Vec<ConnectionCandidate>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
    answers: &mut ConnectionAnswers,
    list: Mark,
) -> std::result::Result<Option<DirectConnection>, i32> {
    if let ConnectionCandidate::LinkedProject { project_ref, .. } = chosen {
        // The keychain is read only here, once the user has picked the project.
        let token = token::discover_token(
            picker.flags.access_token.as_deref(),
            picker.env,
            picker.env_files,
            ports.tokens,
        );
        let linked = linked_direct_url(
            project_ref,
            token.as_ref().map(|found| found.token.as_str()),
            ports.linked,
            ui,
        );
        if linked.is_none() {
            candidates.retain(|candidate| {
                !matches!(candidate, ConnectionCandidate::LinkedProject { .. })
            });
        }

        return Ok(linked);
    }

    let Some(prompter) = ports.prompter.as_deref_mut() else {
        ui.log(NON_INTERACTIVE_USAGE);

        return Err(UNUSABLE);
    };
    match direct_connection_for(
        chosen.clone(),
        NO_CONNECTION_ENTERED,
        picker.env_files,
        prompter,
        ui,
        answers.entered(),
    )? {
        DirectChoice::Url(direct) => {
            answers.settled_direct(chosen, &direct);

            Ok(Some(direct))
        }
        DirectChoice::Back => {
            crate::wizard_theme::rewind(list);

            Ok(None)
        }
        DirectChoice::Declined => Err(cancel_or_stop(prompter, &PromptError::Cancelled, ui)),
    }
}

/// A direct connection to the linked project the user picked, or `None` once
/// the reason it could not be opened is on `ui`, so the caller can offer the
/// other connections instead. Its migrations go through `--linked`: the
/// temporary login is read-only, and the Supabase CLI opens its own connection
/// for the linked project.
pub(crate) fn linked_direct_url(
    project_ref: &ProjectRef,
    token: Option<&str>,
    linked: &LinkedConnector<'_>,
    ui: &mut Ui,
) -> Option<DirectConnection> {
    match linked(project_ref, token) {
        Ok(connection) => {
            crate::wizard_theme::detail(
                ui,
                &format!(
                    "  database:         {} (linked project {project_ref}, {})",
                    redact_db_url(&connection.url),
                    match connection.route {
                        LinkedRoute::Direct => "direct host",
                        LinkedRoute::Pooler => "session pooler",
                    }
                ),
            );

            Some(DirectConnection {
                url: connection.url,
                push: PushTarget::Linked,
            })
        }
        Err(cause) => {
            ui.warn(&format!(
                "  linked project {project_ref}: {}; choose another connection",
                redact_access_token(&cause.to_string(), token.unwrap_or_default())
            ));

            None
        }
    }
}

// MARK: - deciding the new table set

/// The change to make: proposals to provision, already-synced tables whose
/// options move, names to unwind, and whatever the wizard's server sections
/// changed.
pub(crate) struct TablePlan {
    pub(crate) added: Vec<TableProposal>,
    pub(crate) updated: Vec<DeltaUpdate>,
    pub(crate) removed: Vec<String>,
    /// The project settings the wizard changed, absent when it never asked or
    /// the user accepted every value the project already carries.
    pub(crate) settings: Option<ProjectSettings>,
}

#[expect(
    clippy::large_enum_variant,
    reason = "One of these is built and consumed once per run, so boxing the plan would buy an allocation and a deref on a path that never repeats."
)]
pub(crate) enum Planned {
    Plan(TablePlan),
    Stop(i32),
}

/// Nothing to script and nobody to ask: the run cannot decide a set whatever
/// the database says, so it says how to ask before resolving one.
pub(crate) fn refuse_without_a_way_to_decide(
    flags: &SyncFlags,
    ports: &SyncPorts<'_>,
    ui: &mut Ui,
) -> Option<i32> {
    // A run that declared a project setting has something to do whatever the
    // table set is, so it is not a run with nothing to decide.
    if !flags.add.is_empty()
        || !flags.remove.is_empty()
        || flags.settings.is_any_set()
        || ports.prompter.is_some()
    {
        return None;
    }

    ui.log(NON_INTERACTIVE_USAGE);

    Some(UNUSABLE)
}

/// Flags win outright: with `--add`/`--remove` present the set is never
/// prompted for, so a scripted run is deterministic. Without them a terminal
/// gets the checkbox, and `wizard` keeps that walk open across the write
/// confirmation, so Backspace on it can reopen the question before. `config`
/// is the synced set and the settings the project already carries.
pub(crate) fn plan_tables(
    flags: &SyncFlags,
    target: &Target<'_>,
    config: &KizunaSyncConfig,
    wizard: &mut Option<InteractivePlan>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> Planned {
    if !flags.add.is_empty() || !flags.remove.is_empty() {
        let catalog = match read_flag_catalog(flags, target, ports, ui) {
            Ok(catalog) => catalog,
            Err(code) => return Planned::Stop(code),
        };

        return match plan_from_flags(flags, config, catalog.as_ref(), ui) {
            Ok(plan) => Planned::Plan(plan),
            Err(code) => Planned::Stop(code),
        };
    }
    // Settings alone, off a terminal: the synced set is not this run's
    // business, and there is nobody to offer the checkbox to.
    if ports.prompter.is_none() {
        return Planned::Plan(TablePlan {
            added: Vec::new(),
            updated: Vec::new(),
            removed: Vec::new(),
            settings: None,
        });
    }

    let opened = match wizard.take() {
        Some(opened) => opened,
        None => match InteractivePlan::open(flags, target, config.settings.as_ref(), ports, ui) {
            Ok(opened) => opened,
            Err(code) => return Planned::Stop(code),
        },
    };
    let wizard = wizard.insert(opened);
    let Some(prompter) = ports.prompter.as_deref_mut() else {
        ui.log(NON_INTERACTIVE_USAGE);

        return Planned::Stop(UNUSABLE);
    };

    wizard.decide(flags, config, prompter, ui)
}

/// The catalog a flag-driven run reads for the primary key of every table
/// `--add` names, the one read of the schema on that path. `Ok(None)` for a
/// run that adds nothing; `Err(2)` is a catalog that cannot be read.
fn read_flag_catalog(
    flags: &SyncFlags,
    target: &Target<'_>,
    ports: &SyncPorts<'_>,
    ui: &mut Ui,
) -> Result<Option<SchemaCatalog>, i32> {
    if flags.add.is_empty() {
        return Ok(None);
    }

    target
        .introspect(ports.schemas, &flags.schema)
        .map(Some)
        .map_err(|cause| {
            ui.error(&format!("  introspection failed:\n    {cause}"));

            UNUSABLE
        })
}

/// A flag-driven add reads no policy, so it provisions what the per-table
/// flags answered over the pull-only default, keyed as `catalog` holds each
/// table. A table that is already synced is an update when the run named an
/// option for it or its primary key moved, and a stated no-op otherwise;
/// removing one that is not synced is stated and dropped from the delta, not
/// treated as an error. `Err(2)` is a refusal already on `ui`.
fn plan_from_flags(
    flags: &SyncFlags,
    config: &KizunaSyncConfig,
    catalog: Option<&SchemaCatalog>,
    ui: &mut Ui,
) -> Result<TablePlan, i32> {
    let provenance = if flags.options.is_any_set() {
        FLAG_PROVENANCE_ANSWERED
    } else {
        FLAG_PROVENANCE
    };
    let from_flags = flags.options.declared();
    let mut added = Vec::new();
    let mut updated = Vec::new();
    for table in unique(&flags.add) {
        let Some(live) = config.tables.get(&table) else {
            let proposal = TableProposal::derived(&table, None, provenance);
            let proposal = match catalog {
                Some(catalog) => proposal.keyed_from(catalog),
                None => proposal,
            };
            added.push(flags.options.apply(proposal));
            continue;
        };
        let rekeyed = match catalog {
            Some(catalog) => rekey(&table, live, catalog).map_err(|refusal| {
                ui.error(&indented(&refusal));

                UNUSABLE
            })?,
            None => None,
        };
        if let Some(current) = &rekeyed {
            ui.log(&rekey_line(&table, &live.key_columns, current));
        }
        let declared = DeclaredTableConfig {
            key_columns: rekeyed,
            ..from_flags.clone()
        };
        if from_flags.is_any_set() {
            ui.log(&format!(
                "  {table} is already synced: updating the options this run named."
            ));
        } else if !declared.is_any_set() {
            ui.log(&format!("  {table} is already synced, nothing to add."));
            continue;
        }
        updated.push(DeltaUpdate {
            table,
            declared,
            relabel: false,
        });
    }
    if let Some(catalog) = catalog {
        let tables = added.iter().map(|proposal| proposal.table.as_str());
        if let Some(code) = refuse_unkeyed(tables, catalog, ui)
            .or_else(|| review_updates(&updated, config, catalog, ui))
        {
            return Err(code);
        }
    }
    if !added.is_empty() {
        let names: Vec<&str> = added
            .iter()
            .map(|proposal| proposal.table.as_str())
            .collect();
        ui.log(&format!(
            "  --add does not check row level security on {}.",
            names.join(", ")
        ));
    }
    let mut removed = Vec::new();
    for table in unique(&flags.remove) {
        if !config.tables.contains_key(&table) {
            ui.log(&format!("  {table} is not synced, nothing to remove."));
            continue;
        }
        removed.push(table);
    }

    Ok(TablePlan {
        added,
        updated,
        removed,
        settings: None,
    })
}

/// Mark every update in `updated` that moves its table to another bucket
/// column, so the delta relabels the table's changelog after the update.
/// `Some(2)` once the refusal is on `ui`, when such a move does not raise the
/// table's `min_schema_version` above the one `config` carries: the relabel
/// drops the tombstones the new column cannot scope, so every device has to
/// bootstrap the table again (@docs/reference/sql-pack.md).
pub(crate) fn mark_bucket_changes(
    updated: &mut [DeltaUpdate],
    config: &KizunaSyncConfig,
    ui: &mut Ui,
) -> Option<i32> {
    for update in updated {
        let (Some(live), Some(column)) = (
            config.tables.get(&update.table),
            update.declared.bucket_column.as_deref(),
        ) else {
            continue;
        };
        if live.bucket_column() == Some(column) {
            continue;
        }

        let current = live.min_schema_version;
        if update
            .declared
            .min_schema_version
            .is_some_and(|version| version > current)
        {
            update.relabel = true;
            continue;
        }

        ui.error(&format!(
            "  refusing to change the bucket column of {table} to {column} without raising --min-schema-version above {current}: the relabel drops every tombstone it cannot scope by {column}, so every device has to bootstrap {table} again.",
            table = update.table
        ));

        return Some(UNUSABLE);
    }

    None
}

/// The terminal's walk over one catalog. One checkbox IS the add/remove
/// surface: the schema's tables with the currently synced ones pre-checked,
/// so the final set is whatever the user confirms. Tables `_config` carries
/// but the schema does not hold are listed too (also pre-checked): leaving
/// them out would silently unsync a table just because it moved, and this
/// command never removes something the user did not uncheck.
///
/// The added tables then walk the [`Ladder`] up to its plan confirmation,
/// which this command asks later, after the history gate. The walk outlives
/// that question: Backspace on any step, the write confirmation included,
/// reopens the one before on its last answer, and on the mode question that
/// is the checkbox again, pre-checked as it was answered.
pub(crate) struct InteractivePlan {
    catalog: SchemaCatalog,
    ladder: Ladder,
    /// The tables the checkbox added, the per-table flags applied.
    added: Vec<TableProposal>,
    /// The synced tables the checkbox kept whose primary key moved, each
    /// recording its current key.
    updated: Vec<DeltaUpdate>,
    /// The synced tables the checkbox unchecked.
    removed: Vec<String>,
}

impl InteractivePlan {
    /// Read the catalog and open the walk on the checkbox.
    ///
    /// # Errors
    /// Returns the exit code the run stops with: the catalog cannot be read,
    /// or the step cannot be drawn.
    fn open(
        flags: &SyncFlags,
        target: &Target<'_>,
        live: Option<&ProjectSettings>,
        ports: &mut SyncPorts<'_>,
        ui: &mut Ui,
    ) -> Result<Self, i32> {
        // No schema question: `--schema` is the only way to name one and the
        // pack supports exactly one value.
        let catalog = introspect_with_spinner(target, ports, ui, &flags.schema)?;
        let Some(prompter) = ports.prompter.as_deref_mut() else {
            ui.log(NON_INTERACTIVE_USAGE);

            return Err(UNUSABLE);
        };
        if let Err(error) = prompter.phase(docs::TABLES_PHASE) {
            return Err(cancel_or_stop(prompter, &error, ui));
        }

        Ok(Self {
            catalog,
            ladder: Ladder::new(&flags.settings.declared().merged_with(live), None),
            added: Vec::new(),
            updated: Vec::new(),
            removed: Vec::new(),
        })
    }

    /// Walk from the current step to the write confirmation.
    fn decide(
        &mut self,
        flags: &SyncFlags,
        config: &KizunaSyncConfig,
        prompter: &mut dyn Prompter,
        ui: &mut Ui,
    ) -> Planned {
        loop {
            if self.ladder.step() == Step::Tables
                && let Err(code) = self.choose(flags, config, prompter, ui)
            {
                return Planned::Stop(code);
            }
            // Nothing added, or every field already answered by a flag,
            // leaves the ladder nothing to ask.
            if self.added.is_empty() || flags.options.is_complete() {
                return Planned::Plan(TablePlan {
                    added: self.added.clone(),
                    updated: self.updated.clone(),
                    removed: self.removed.clone(),
                    settings: None,
                });
            }

            match self.ladder.walk(prompter, &self.added, &self.catalog) {
                Ok(Reached::Tables) => {}
                Ok(Reached::Confirm) => {
                    return Planned::Plan(TablePlan {
                        added: self.ladder.proposals(&self.added),
                        updated: self.updated.clone(),
                        removed: self.removed.clone(),
                        settings: changed_settings(&self.ladder, config.settings.as_ref()),
                    });
                }
                Err(error) => return Planned::Stop(cancel_or_stop(prompter, &error, ui)),
            }
        }
    }

    /// The checkbox, then the refusals over what it kept: an added table the
    /// pack cannot key or whose row level security is disabled, and a synced
    /// table whose key moved in a way this run cannot record. `Err` is the
    /// exit, the wizard's chrome closed on a refusal.
    fn choose(
        &mut self,
        flags: &SyncFlags,
        config: &KizunaSyncConfig,
        prompter: &mut dyn Prompter,
        ui: &mut Ui,
    ) -> Result<(), i32> {
        (self.added, self.removed) = select_table_set(
            flags,
            &self.catalog,
            &config.synced_tables(),
            &flags.schema,
            &mut self.ladder,
            prompter,
            ui,
        )?;
        let tables = || self.added.iter().map(|proposal| proposal.table.as_str());
        let refused = refuse_unkeyed(tables(), &self.catalog, ui).or_else(|| {
            refuse_rls_disabled(tables(), &self.catalog.rls_disabled, flags.allow_no_rls, ui)
        });
        let rekeyed = match refused {
            Some(code) => Err(code),
            None => rekey_kept(config, &self.removed, &self.catalog, ui),
        };
        match rekeyed {
            Ok(updated) => {
                self.updated = updated;

                Ok(())
            }
            Err(code) => {
                let _ = prompter.outro_cancel(NOTHING_WRITTEN);

                Err(code)
            }
        }
    }

    /// Backspace on the write confirmation: the question before it reopens
    /// on its last answer at the next [`Self::decide`], the checkbox when the
    /// walk asked nothing after it.
    pub(crate) fn reopen_before_confirm(&mut self) {
        self.ladder.back();
    }
}

/// What the server sections changed. Accepting every value the project
/// already carries changes nothing, and a recommended walk asks nothing.
fn changed_settings(ladder: &Ladder, live: Option<&ProjectSettings>) -> Option<ProjectSettings> {
    if ladder.mode() != WizardMode::Customize {
        return None;
    }

    let changed = ladder.settings().changed_from(live);

    changed.is_any_set().then_some(changed)
}

/// Read the schema's catalog, narrating it through the spinner. The
/// connection was tested when it was settled; a failure here becomes the
/// terminal state: nothing asked of the user is worth attempting against a
/// catalog that cannot be read.
fn introspect_with_spinner(
    target: &Target<'_>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
    schema: &str,
) -> Result<SchemaCatalog, i32> {
    if let Some(prompter) = ports.prompter.as_deref_mut() {
        prompter.start_spin("Reading tables and RLS…");
    }
    match target.introspect(ports.schemas, schema) {
        Ok(catalog) => {
            if let Some(prompter) = ports.prompter.as_deref_mut() {
                prompter.stop_spin("Catalog ready");
            }
            Ok(catalog)
        }
        Err(cause) => {
            if let Some(prompter) = ports.prompter.as_deref_mut() {
                prompter.stop_spin("Introspection failed");
            }
            ui.error(&format!("  introspection failed:\n    {cause}"));

            Err(UNUSABLE)
        }
    }
}

/// The table set the user picks in the terminal: every proposal they keep
/// becomes `added` (already carrying whatever per-table flags this run
/// passed), and every current table they uncheck becomes `removed`. The
/// checkbox opens as `ladder` last saw it answered, the synced set before
/// that.
fn select_table_set(
    flags: &SyncFlags,
    catalog: &SchemaCatalog,
    current: &[String],
    schema: &str,
    ladder: &mut Ladder,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
) -> Result<(Vec<TableProposal>, Vec<String>), i32> {
    let proposals = proposals_from_catalog(catalog);
    let synced: HashSet<&str> = current.iter().map(String::as_str).collect();
    let known: HashSet<&str> = proposals
        .iter()
        .map(|proposal| proposal.table.as_str())
        .collect();
    let choices = table_choices(&proposals, current, &synced, &known, schema, ladder);
    let choices: Vec<TableChoice> = choices
        .into_iter()
        .map(|choice| {
            // A synced table stays on offer whatever its key, so it can be
            // unchecked.
            if synced.contains(choice.table.as_str()) {
                choice
            } else {
                keyed_choice(choice, catalog)
            }
        })
        .collect();
    note_unavailable(&choices, catalog, prompter);

    let chosen = match prompter.select_tables(&choices) {
        Ok(chosen) => chosen,
        // The run decides where Backspace on the checkbox lands: the
        // connection question before it, or the checkbox again when nothing
        // was asked.
        Err(PromptError::Back) => return Err(STEP_BACK),
        Err(error) => return Err(cancel_or_stop(prompter, &error, ui)),
    };

    let keep: HashSet<&str> = chosen.iter().map(String::as_str).collect();
    let added: Vec<TableProposal> = proposals
        .into_iter()
        .filter(|proposal| {
            keep.contains(proposal.table.as_str()) && !synced.contains(proposal.table.as_str())
        })
        .collect();
    let removed: Vec<String> = current
        .iter()
        .filter(|table| !keep.contains(table.as_str()))
        .cloned()
        .collect();
    // A flag the user typed decides the same field the wizard would have asked
    // about, so it is applied before the ladder runs and becomes that
    // question's starting answer. Five flags leave nothing to ask.
    let added: Vec<TableProposal> = added
        .into_iter()
        .map(|proposal| flags.options.apply(proposal))
        .collect();

    if !added.is_empty() && flags.options.is_any_set() {
        ui.log(&format!(
            "  per-table flags applied to {}: {}",
            plural_tables(added.len()),
            describe_options(&flags.options)
        ));
    }

    ladder.choose_tables(chosen);

    Ok((added, removed))
}

fn plural_tables(count: usize) -> String {
    if count == 1 {
        "1 added table".to_owned()
    } else {
        format!("{count} added tables")
    }
}

/// The flags that decided a contract, named back to the user so a question the
/// wizard did not ask is accounted for rather than silently skipped.
fn describe_options(options: &TableOptions) -> String {
    let register_clients = options.register_clients.map(|register| {
        if register {
            "--register-clients"
        } else {
            "--no-register-clients"
        }
        .to_owned()
    });

    [
        options.sync.map(|sync| format!("--sync {}", sync.as_str())),
        options
            .bucket_column
            .as_ref()
            .map(|column| format!("--bucket-column {column}")),
        register_clients,
        options
            .min_schema_version
            .map(|version| format!("--min-schema-version {version}")),
        options
            .soft_delete
            .as_ref()
            .map(|column| format!("--soft-delete {column}")),
        options
            .conflict
            .map(|conflict| format!("--conflict {}", conflict.as_str())),
        options
            .conflict_journal
            .then(|| "--conflict-journal".to_owned()),
        options
            .tombstone_ttl_days
            .map(|days| format!("--tombstone-ttl-days {days}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ")
}

fn table_choices(
    proposals: &[TableProposal],
    current: &[String],
    synced: &HashSet<&str>,
    known: &HashSet<&str>,
    schema: &str,
    ladder: &Ladder,
) -> Vec<TableChoice> {
    let mut choices: Vec<TableChoice> = proposals
        .iter()
        .map(|proposal| {
            let checked =
                ladder.is_checked(&proposal.table, synced.contains(proposal.table.as_str()));
            table_choice(proposal, checked)
        })
        .collect();
    choices.extend(
        current
            .iter()
            .filter(|table| !known.contains(table.as_str()))
            .map(|table| {
                TableChoice::new(table, ladder.is_checked(table, true))
                    .with_hint(&format!("synced, not in schema \"{schema}\""))
            }),
    );

    choices
}

/// [`stop_for`], closing the wizard's chrome first when the question was
/// cancelled.
fn cancel_or_stop(prompter: &mut dyn Prompter, error: &PromptError, ui: &mut Ui) -> i32 {
    if matches!(error, PromptError::Cancelled) {
        let _ = prompter.outro_cancel(NOTHING_WRITTEN);
    }

    stop_for(error, ui)
}

/// The exit a failed question produces: a cancelled wizard wrote nothing and is
/// not a failure, a vanished terminal is a usage error, anything else is real.
fn stop_for(error: &PromptError, ui: &mut Ui) -> i32 {
    match error {
        PromptError::Cancelled | PromptError::Back => {
            ui.log(CANCELLED);

            OK
        }
        PromptError::NotInteractive => {
            ui.log(NON_INTERACTIVE_USAGE);

            UNUSABLE
        }
        PromptError::Backend(_) | PromptError::Script(_) => {
            ui.error(&format!("  the wizard could not ask: {error}"));

            UNUSABLE
        }
    }
}

fn unique(names: &[String]) -> Vec<String> {
    names
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
