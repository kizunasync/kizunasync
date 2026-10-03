use std::path::Path;

use crate::catalog::SchemaSource;
use crate::commands::history_gate::gate_migration_history;
use crate::commands::panel::equivalent::Reach;
use crate::commands::reconcile::{Gated, PackGate, ReapplyVia, ask_pack_gate};
use crate::commands::{FAILURE, OK, UNUSABLE, refuse_newer_ledger};
use crate::config::{KizunaSyncConfig, ProjectSettings};
use crate::db::{DbUrlSource, redact_db_url, resolve_db_url, session_mode};
use crate::discovery::{self, ConnectionCandidate};
use crate::docs;
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::management::{ProjectSummary, redact_access_token};
use crate::project_ref::ProjectRef;
use crate::prompts::{BackKey, PromptError, Prompter};
use crate::provision::{LedgerRow, Plan, plan_provision};
use crate::server_facts::ServerFacts;
use crate::supabase_cli::PushTarget;
use crate::token::{self, TokenStore};
use crate::ui::Ui;
use crate::wizard::settings_note;
use crate::wizard_theme::Mark;
use crate::workdir::ProjectPaths;

use super::{
    CANCELLED, CONFIRM_REFUSAL, ConnectContext, DatabaseState, Decided, EmitContext, InitFlags,
    InitPorts, InteractiveDecision, Introspection, NO_CONNECTION_ENTERED, PACK_NOT_FOUND, Written,
    perform_writes, plan_text, prepare_emit, recorded_contract, report_header, report_pg_cron,
    run_remote_with,
};

// MARK: - wizard

/// The interactive install: walk the connection, the synced set and the server
/// knobs with the user, then write what was confirmed. Returns the exit code
/// the command ends on.
pub(crate) fn run_wizard(
    flags: &InitFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    if let Some(prompter) = ports.prompter.as_deref_mut()
        && let Err(error) = prompter.intro(docs::INIT)
    {
        return cancel_or_stop(prompter, &error, ui);
    }
    let mut answers = ConnectionAnswers::default();
    loop {
        let attempt = crate::wizard_theme::mark();
        let connection =
            match choose_connection(flags, paths, env, env_files, ports, ui, &mut answers) {
                Ok(connection) => connection,
                Err(code) => return code,
            };
        // No at the pack gate returns to the connection question, when one
        // settled the connection.
        let back = if answers.reopen_mark().is_some() {
            BackKey::Honoured
        } else {
            BackKey::Ignored
        };
        let context = ConnectContext { paths, env, back };
        let code = provision_with(connection, flags, &context, ports, ui);
        if code == STEP_BACK {
            crate::wizard_theme::rewind(answers.reopen_mark().unwrap_or(attempt));
            continue;
        }
        return code;
    }
}

/// `init`, entered with the connection already chosen: the bare `kizunasync` flow
/// asks that question for itself and must not ask it twice. Everything after it
/// is the same run a plain `kizunasync init` performs.
pub fn run_with_connection(
    connection: WizardConnection,
    flags: &InitFlags,
    cwd: &Path,
    paths: &ProjectPaths,
    env: &Env,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let mode = describe_connection_mode(&connection, flags.dry_run);
    report_header(&mode, cwd, paths, ui);

    let context = ConnectContext {
        paths,
        env,
        back: BackKey::Honoured,
    };

    provision_with(connection, flags, &context, ports, ui)
}

/// The wizard's body once the connection is settled and tested: migration
/// history, schema, catalog, tables, plan, confirm, write. A project connection
/// goes to the Management API path instead, which writes no local files.
fn provision_with(
    connection: WizardConnection,
    flags: &InitFlags,
    context: &ConnectContext<'_>,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let direct = match connection {
        WizardConnection::Direct(direct) => direct,
        WizardConnection::Remote {
            project_ref,
            credential,
        } => {
            return run_remote_with(flags, context.env, &project_ref, &credential, ports, ui);
        }
    };

    let rows = match read_direct_ledger(&direct, ports.schemas, ui) {
        Ok(rows) => rows,
        Err(code) => return code,
    };
    let reapply = match reconcile_direct(
        &direct,
        &rows,
        context.env,
        ports.schemas,
        &mut ports.prompter,
        ui,
    ) {
        Ok(Gated::Clear) => false,
        Ok(Gated::Reapply) => true,
        Ok(Gated::Declined) => return declined_reapply(context.back, &mut ports.prompter),
        Err(code) => return code,
    };

    let recorded = match gate_migration_history(
        &direct,
        context.paths,
        ports.schemas,
        ports.supabase,
        &mut ports.prompter,
        ui,
    ) {
        Ok(versions) => versions,
        Err(code) => return code,
    };

    let synced = match recorded_contract(&rows, || ports.schemas.read_config(&direct.url)) {
        Ok(synced) => synced,
        Err(cause) => {
            ui.error(&format!("  {cause}"));

            return UNUSABLE;
        }
    };
    let basis = PlanBasis {
        direct: &direct,
        reapply,
        recorded: &recorded,
        ledger: &rows,
        synced: &synced,
    };
    let (emit, decided, proceed) = match plan_and_confirm(flags, context, &basis, ports, ui) {
        Ok(planned) => planned,
        Err(code) => return code,
    };
    if !proceed {
        ui.log(CANCELLED);

        return OK;
    }

    let code = perform_writes(&emit, Some(&direct), context.paths, ports, flags.yes, ui);
    if code != OK {
        return code;
    }

    let code = loop {
        let code = report_pg_cron(
            ports.schemas.pg_cron_present(&direct.url),
            decided.allow_no_cron,
            ui,
        );
        if code == OK {
            break code;
        }
        if crate::prompts::confirm_retry(&mut ports.prompter) {
            continue;
        }
        break code;
    };
    if code == OK {
        // Closing chrome (`outro`/`outro_cancel`/`note`) only decorates an exit
        // already decided by `code`; a terminal write failure here has nothing
        // left to affect and is dropped the same way at every call in this file.
        let _ = ports
            .prompter
            .as_deref_mut()
            .map(|prompter| prompter.outro("Kizuna is provisioned."));
    }

    code
}

/// The provision ledger's rows over `direct`, read before anything is asked
/// or written.
///
/// # Errors
/// Returns `1` when the ledger cannot be read, and `2` when a newer
/// kizunasync recorded one of its `pack-file` rows
/// ([`refuse_newer_ledger`]).
pub(crate) fn read_direct_ledger(
    direct: &DirectConnection,
    schemas: &dyn SchemaSource,
    ui: &mut Ui,
) -> Result<Vec<LedgerRow>, i32> {
    let rows = schemas.ledger_rows(&direct.url).map_err(|cause| {
        ui.error(&format!(
            "  could not read the provision ledger:\n    {cause}"
        ));

        FAILURE
    })?;
    if let Some(code) = refuse_newer_ledger(&rows, ui) {
        return Err(code);
    }

    Ok(rows)
}

/// The pack gate over `direct` ([`ask_pack_gate`]), when the database's
/// ledger, `rows`, differs from this CLI's pack. [`Gated::Reapply`] is a yes:
/// the pack is written again as a new migration with the rest of the run
/// ([`prepare_emit`]), and nothing is sent before the plan is confirmed. A
/// missing pack is left to [`prepare_emit`], which reports it where it always
/// has.
///
/// # Errors
/// Returns the exits [`ask_pack_gate`] does, and `2` when the pack cannot be
/// read.
pub(crate) fn reconcile_direct(
    direct: &DirectConnection,
    rows: &[LedgerRow],
    env: &Env,
    schemas: &dyn SchemaSource,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> Result<Gated, i32> {
    let Some(pack_dir) = crate::pack::resolve_pack_dir(env) else {
        return Ok(Gated::Clear);
    };

    let pack_files = crate::pack::read_pack_files(&pack_dir).map_err(|cause| {
        ui.error(&format!("  {cause}"));

        UNUSABLE
    })?;
    let plan = plan_provision(&pack_files, rows);
    if !matches!(plan, Plan::Drift { .. }) {
        return Ok(Gated::Clear);
    }

    let applier = schemas.pack_applier(&direct.url);
    let gate = PackGate {
        plan: Some(&plan),
        rows,
        applier: applier.as_ref(),
        via: ReapplyVia::Migration,
        reach: Some(Reach::DbUrl(&direct.url)),
        allow_no_cron: false,
    };

    ask_pack_gate(&gate, prompter, ui)
}

/// Where No at the pack gate leaves the wizard: back at the connection
/// question that settled the connection, or, with no question behind it,
/// closed with nothing written.
fn declined_reapply(back: BackKey, prompter: &mut Option<&mut dyn Prompter>) -> i32 {
    match back {
        BackKey::Honoured => STEP_BACK,
        BackKey::Ignored => {
            if let Some(prompter) = prompter.as_deref_mut() {
                let _ = prompter.outro_cancel(Written::Nothing.outro());
            }

            OK
        }
    }
}

/// What a wizard plan is built over, read before the walk opens.
#[derive(Clone, Copy)]
struct PlanBasis<'a> {
    /// The connection the catalog is read and the migrations are pushed over.
    direct: &'a DirectConnection,
    /// Whether the pack is written again as a new migration.
    reapply: bool,
    /// The migration history versions the new files are named past.
    recorded: &'a [String],
    /// The provision ledger the database holds.
    ledger: &'a [LedgerRow],
    /// The synced-table contract the project records.
    synced: &'a KizunaSyncConfig,
}

/// Introspect the schema, decide the table set, prepare the migrations to
/// write (the pack again as a new migration when `reapply`, named past the
/// `recorded` history versions), and ask the user to confirm. `Err` carries
/// the exit code to return immediately; `Ok` carries the plan and whether the
/// user confirmed it. Backspace on the confirmation reopens the step before
/// it, every answer kept.
fn plan_and_confirm(
    flags: &InitFlags,
    context: &ConnectContext<'_>,
    basis: &PlanBasis<'_>,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> Result<(EmitContext, Decided, bool), i32> {
    let PlanBasis {
        direct,
        reapply,
        recorded,
        ledger,
        synced,
    } = *basis;
    let schemas = ports.schemas;
    let introspection = Introspection {
        introspect: &|schema: &str| schemas.introspect(&direct.url, schema),
        recorded: synced,
    };
    let Some(prompter) = ports.prompter.as_deref_mut() else {
        ui.log(CONFIRM_REFUSAL);

        return Err(UNUSABLE);
    };
    let plan = crate::wizard_theme::mark();
    let erase_on_step_back = |code: i32| {
        if code == STEP_BACK {
            crate::wizard_theme::rewind(plan);
        }

        code
    };
    let mut wizard =
        InteractiveDecision::open(flags, &introspection, Written::Nothing, prompter, ui)
            .map_err(erase_on_step_back)?;
    loop {
        let decided = wizard.decide(prompter, ui).map_err(erase_on_step_back)?;
        let emit = match prepare_emit(
            context.paths,
            context.env,
            &decided,
            ports.now_unix,
            recorded,
            reapply,
            Some(&DatabaseState { ledger, synced }),
        ) {
            Ok(Some(emit)) => emit,
            Ok(None) => {
                ui.log(PACK_NOT_FOUND);

                return Err(UNUSABLE);
            }
            Err(cause) => {
                ui.error(&format!("  {cause}"));

                return Err(UNUSABLE);
            }
        };
        let _ = prompter.note(
            "Plan",
            &format!(
                "{}\n\n{}",
                plan_text(&emit),
                settings_note(
                    decided
                        .settings
                        .as_ref()
                        .unwrap_or(&ProjectSettings::default()),
                    decided.allow_no_cron
                )
            ),
        );
        let question = format!(
            "Write the migrations and run supabase db push {} now?",
            direct.push.describe()
        );
        match prompter.confirm(&question, false) {
            Ok(false) => {
                let _ = prompter.outro_cancel("Nothing written.");

                return Ok((emit, decided, false));
            }
            Ok(true) => return Ok((emit, decided, true)),
            Err(PromptError::Back) => wizard.reopen_before_confirm(),
            Err(error) => return Err(cancel_or_stop(prompter, &error, ui)),
        }
    }
}

/// The token a remote run carries, and the rung it came from. Only the rung is
/// ever printed. Deliberately not `Debug`: the token stays out of every
/// rendering a caller could reach for.
#[derive(Clone)]
pub struct RemoteCredential {
    /// The token itself, held in memory only.
    pub token: String,
    /// The rung it came from: the only half that is ever shown.
    pub origin: String,
}

/// A direct Postgres connection, plus where its migrations are applied.
/// Deliberately not `Debug`: the URL carries the password.
#[derive(Clone)]
pub struct DirectConnection {
    /// The connection string, held in memory only.
    pub url: String,
    /// The database `supabase db push` and `supabase migration repair` address
    /// for this connection.
    pub push: PushTarget,
}

/// What the wizard's connection step settled on.
#[derive(Clone)]
pub enum WizardConnection {
    /// A direct Postgres connection.
    Direct(DirectConnection),
    /// The Management API, against the project the user picked.
    Remote {
        /// The project the run is bound to.
        project_ref: ProjectRef,
        /// The token that reaches it.
        credential: RemoteCredential,
    },
}

/// The mode header's text for a connection already settled: `run_with_connection`
/// is entered with the transport already known, unlike the flags alone, which
/// cannot tell an account pick or a linked project from a plain direct one.
pub(crate) fn describe_connection_mode(connection: &WizardConnection, dry_run: bool) -> String {
    let suffix = if dry_run { " (dry-run)" } else { "" };
    match connection {
        WizardConnection::Direct(direct) => format!(
            "migrations, applied with supabase db push {}{suffix}",
            direct.push.describe()
        ),
        WizardConnection::Remote { project_ref, .. } => {
            format!("remote: project {project_ref} (Supabase Management API){suffix}")
        }
    }
}

/// What the connection step answered last. A Backspace from the step after
/// it reopens the step on its last question, with these answers as the
/// defaults, so nothing the user entered is asked for from scratch.
#[derive(Default)]
pub struct ConnectionAnswers {
    /// The row the picker settled on.
    candidate: Option<ConnectionCandidate>,
    /// The connection string typed at the masked prompt.
    entered: Option<String>,
    /// The token a project row reached its project with.
    credential: Option<RemoteCredential>,
    /// The project picked from the account's list.
    project: Option<String>,
    /// Where the settled step's questions start on screen, `None` until a
    /// question settled the step.
    marks: Option<StepMarks>,
}

/// Where the solution question, the picker, and the picked row's own
/// question start on screen.
#[derive(Clone, Copy)]
struct StepMarks {
    solution: Mark,
    list: Mark,
    /// `None` for a row that asks nothing after the picker.
    row: Option<Mark>,
}

/// The question a connection step opens on.
pub(crate) enum Reopen {
    /// The solution question: no question settled the step yet.
    Solution,
    /// The picker, on the row it settled.
    Picker,
    /// The settled row's own question.
    Row(ConnectionCandidate),
}

impl ConnectionAnswers {
    /// The point the screen is erased back to before the step reopens: the
    /// settled row's own question, or the picker for a row that asks
    /// nothing. `None` when no question settled the step.
    pub(crate) fn reopen_mark(&self) -> Option<Mark> {
        self.marks.map(|marks| marks.row.unwrap_or(marks.list))
    }

    /// The question the step opens on.
    pub(crate) fn reopening(&self) -> Reopen {
        match (&self.marks, &self.candidate) {
            (Some(StepMarks { row: Some(_), .. }), Some(candidate)) => {
                Reopen::Row(candidate.clone())
            }
            (Some(_), Some(_)) => Reopen::Picker,
            _ => Reopen::Solution,
        }
    }

    /// The row the picker opens on.
    pub(crate) fn candidate(&self) -> Option<&ConnectionCandidate> {
        self.candidate.as_ref()
    }

    /// The connection string the masked prompt opens on.
    pub(crate) fn entered(&self) -> Option<&str> {
        self.entered.as_deref()
    }

    /// The solution question's and the picker's marks when the step reopens
    /// past them, else fresh ones.
    pub(crate) fn solution_mark(&self, reopen: &Reopen) -> Option<Mark> {
        match (reopen, self.marks) {
            (Reopen::Picker | Reopen::Row(_), Some(marks)) => Some(marks.solution),
            _ => None,
        }
    }

    pub(crate) fn list_mark(&self, reopen: &Reopen) -> Mark {
        match (reopen, self.marks) {
            (Reopen::Picker | Reopen::Row(_), Some(marks)) => marks.list,
            _ => crate::wizard_theme::mark(),
        }
    }

    /// Remember the row the picker answered.
    pub(crate) fn picked(&mut self, candidate: &ConnectionCandidate) {
        self.candidate = Some(candidate.clone());
    }

    /// Remember the connection a direct row settled on: for the typed row,
    /// the string the masked prompt reopens on.
    pub(crate) fn settled_direct(
        &mut self,
        candidate: &ConnectionCandidate,
        direct: &DirectConnection,
    ) {
        if matches!(candidate, ConnectionCandidate::Manual) {
            self.entered = Some(direct.url.clone());
        }
    }

    /// The step settled: `row` is where the picked row's own question
    /// started, `None` when the row asked nothing after the picker.
    pub(crate) fn settle(&mut self, solution: Mark, list: Mark, row: Option<Mark>) {
        self.marks = Some(StepMarks {
            solution,
            list,
            row,
        });
    }
}

/// Ask which of the connections this machine already has to use.
///
/// An explicit input still decides without a question: the `--db-url` flag and
/// the process environment are the user telling us where to go. Everything else
/// (a linked project, a `.env` URL, the local stack, the user's account) is
/// offered as a candidate, so the wizard shows what it found instead of silently
/// taking the first rung that answered.
///
/// Discovery stays local: the token ladder runs only inside the two branches
/// that need one, so a run that never picks a remote project never reads the
/// credential store.
///
/// Every settled connection is tested before it is returned
/// (`test_connection`); a failed test offers the list again. `answers` is
/// what an earlier call settled: the step then reopens on its last question,
/// on those answers, because the step after it went back.
///
/// # Errors
/// Returns the exit code the command should stop with: `2` when the linked
/// project's ref is not a valid ref, the session cannot prompt, the user
/// entered nothing, or the connection test failed and no other pick was
/// wanted, `0` when the user cancelled.
pub fn choose_connection(
    flags: &InitFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
    answers: &mut ConnectionAnswers,
) -> Result<WizardConnection, i32> {
    if let Some(direct) = decided_without_asking(flags.db_url.as_deref(), paths, env, env_files, ui)
    {
        let connection = WizardConnection::Direct(direct);
        match test_connection(&connection, ports, ui) {
            Ok(_) => return Ok(connection),
            // Another pick was asked for: the candidates follow.
            Err(code) if code == STEP_BACK => {}
            Err(code) => return Err(code),
        }
    }

    let mut candidates = discovery::discover(paths, env, env_files).map_err(|cause| {
        ui.error(&format!("  {cause}"));

        UNUSABLE
    })?;
    if discovery::found_nothing_local(&candidates) {
        ui.log(discovery::NOTHING_DISCOVERABLE);
        ui.log("");
    }
    candidates.push(ConnectionCandidate::Manual);

    let mut reopen = answers.reopening();
    loop {
        let Some(prompter) = ports.prompter.as_deref_mut() else {
            return Err(UNUSABLE);
        };
        let solution = if let Some(solution) = answers.solution_mark(&reopen) {
            solution
        } else {
            let solution = crate::wizard_theme::mark();
            if let Err(error) = prompter.select_solution() {
                match error {
                    PromptError::Back => {
                        crate::wizard_theme::rewind(solution);
                        continue;
                    }
                    other => return Err(cancel_or_stop(prompter, &other, ui)),
                }
            }
            if let Err(error) = prompter.phase(discovery::CONNECTION_PHASE) {
                return Err(cancel_or_stop(prompter, &error, ui));
            }

            solution
        };
        let listed = ListContext {
            candidates: &candidates,
            flags,
            env,
            env_files,
            tokens: ports.tokens,
            browser_login: ports.browser_login,
            list_projects: ports.list_projects,
            solution,
        };
        if let Some(connection) = pick_until_settled(&listed, reopen, ports, ui, answers)? {
            return Ok(connection);
        }
        reopen = Reopen::Solution;
    }
}

/// What the picker and its rows read, fixed for one connection step.
struct ListContext<'a> {
    candidates: &'a [ConnectionCandidate],
    flags: &'a InitFlags,
    env: &'a Env,
    env_files: &'a EnvFileValues,
    tokens: &'a dyn TokenStore,
    browser_login: &'a dyn Fn() -> crate::error::Result<()>,
    list_projects: &'a dyn Fn(&str) -> crate::error::Result<Vec<ProjectSummary>>,
    /// Where the solution question starts, which Backspace on the picker
    /// erases back to.
    solution: Mark,
}

impl ListContext<'_> {
    /// The token a project row reached its project with before, else the
    /// ladder's, kept for the next time the step reopens.
    fn credential(
        &self,
        prompter: &mut dyn Prompter,
        ui: &mut Ui,
        answers: &mut ConnectionAnswers,
    ) -> Result<RemoteCredential, i32> {
        if let Some(kept) = &answers.credential {
            return Ok(kept.clone());
        }
        let credential = credential_for_remote(
            self.flags,
            self.env,
            self.env_files,
            self.tokens,
            self.browser_login,
            prompter,
            ui,
        )?;
        answers.credential = Some(credential.clone());

        Ok(credential)
    }
}

/// The picker and the picked row's questions until a connection settles and
/// passes its test, starting on `reopen`. `None` is Backspace on the picker:
/// the solution question comes back.
fn pick_until_settled(
    listed: &ListContext<'_>,
    mut reopen: Reopen,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
    answers: &mut ConnectionAnswers,
) -> Result<Option<WizardConnection>, i32> {
    loop {
        let list = answers.list_mark(&reopen);
        let Some(prompter) = ports.prompter.as_deref_mut() else {
            return Err(UNUSABLE);
        };
        let chosen = match std::mem::replace(&mut reopen, Reopen::Solution) {
            Reopen::Row(candidate) => candidate,
            Reopen::Solution | Reopen::Picker => {
                match prompter.select_candidate(listed.candidates, answers.candidate()) {
                    Ok(chosen) => chosen,
                    // Solution is the step before this list.
                    Err(PromptError::Back) => {
                        crate::wizard_theme::rewind(listed.solution);
                        return Ok(None);
                    }
                    Err(error) => return Err(cancel_or_stop(prompter, &error, ui)),
                }
            }
        };
        answers.picked(&chosen);
        let row = crate::wizard_theme::mark();
        let asks = !matches!(chosen, ConnectionCandidate::Local { .. });

        let Listed::Ready(connection) = settle_listed(chosen, listed, prompter, ui, list, answers)?
        else {
            continue;
        };
        match test_connection(&connection, ports, ui) {
            Ok(_) => {
                answers.settle(listed.solution, list, asks.then_some(row));

                return Ok(Some(connection));
            }
            Err(code) if code == STEP_BACK => crate::wizard_theme::rewind(list),
            Err(code) => return Err(code),
        }
    }
}

/// What one row of the connection list settled into.
enum Listed {
    /// The wizard can leave the list.
    Ready(WizardConnection),
    /// Backspace: the list is drawn again, and the row just answered is gone.
    Again,
}

fn back_to_list(list: Mark) -> Listed {
    crate::wizard_theme::rewind(list);
    Listed::Again
}

fn settle_listed(
    chosen: ConnectionCandidate,
    listed: &ListContext<'_>,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
    list: Mark,
    answers: &mut ConnectionAnswers,
) -> Result<Listed, i32> {
    match chosen {
        candidate @ (ConnectionCandidate::Manual
        | ConnectionCandidate::EnvUrl { .. }
        | ConnectionCandidate::Local { .. }) => {
            match direct_connection_for(
                candidate.clone(),
                NO_CONNECTION_ENTERED,
                listed.env_files,
                prompter,
                ui,
                answers.entered(),
            )? {
                DirectChoice::Url(direct) => {
                    answers.settled_direct(&candidate, &direct);

                    Ok(Listed::Ready(WizardConnection::Direct(direct)))
                }
                DirectChoice::Declined => Err(declined(prompter, ui)),
                DirectChoice::Back => Ok(back_to_list(list)),
            }
        }
        ConnectionCandidate::LinkedProject { project_ref, .. } => {
            match prompter.confirm(&format!("Use the linked project {project_ref}?"), true) {
                Ok(true) => {}
                Ok(false) => return Err(declined(prompter, ui)),
                Err(PromptError::Back) => return Ok(back_to_list(list)),
                Err(error) => return Err(cancel_or_stop(prompter, &error, ui)),
            }
            let credential = match listed.credential(prompter, ui, answers) {
                Ok(credential) => credential,
                Err(code) if code == STEP_BACK => return Ok(back_to_list(list)),
                Err(code) => return Err(code),
            };

            Ok(Listed::Ready(WizardConnection::Remote {
                project_ref,
                credential,
            }))
        }
        ConnectionCandidate::Account => {
            let credential = match listed.credential(prompter, ui, answers) {
                Ok(credential) => credential,
                Err(code) if code == STEP_BACK => return Ok(back_to_list(list)),
                Err(code) => return Err(code),
            };
            let kept = answers.project.clone();
            let project_ref = match pick_account_project(
                &credential,
                listed.list_projects,
                prompter,
                ui,
                kept.as_deref(),
            ) {
                Ok(project_ref) => project_ref,
                Err(code) if code == STEP_BACK => return Ok(back_to_list(list)),
                Err(code) => return Err(code),
            };
            answers.project = Some(project_ref.as_str().to_owned());

            Ok(Listed::Ready(WizardConnection::Remote {
                project_ref,
                credential,
            }))
        }
    }
}

/// The rungs that need no question: the flag, then the process environment. A
/// file or local-config rung is offered as a candidate instead of being taken
/// silently, which is the whole point of the picker.
///
/// Shared with `sync`'s interactive session, so both wizards draw the line
/// between "the user already told us" and "we found this, confirm it?" in the
/// same place. Migrations go to that same URL: `--db-url`.
pub fn decided_without_asking(
    flag: Option<&str>,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    ui: &mut Ui,
) -> Option<DirectConnection> {
    let resolved = resolve_db_url(flag, env, env_files, paths).ok()?;
    if !resolved.source.is_explicit() {
        return None;
    }

    crate::wizard_theme::detail(
        ui,
        &format!(
            "  database:         {} ({})",
            redact_db_url(&resolved.url),
            resolved.source
        ),
    );

    let url = session_mode(resolved.url, resolved.source.key(), ui);

    Some(DirectConnection {
        push: PushTarget::DbUrl(url.clone()),
        url,
    })
}

/// What a direct candidate settled on.
pub enum DirectChoice {
    /// The connection it names, held in memory only.
    Url(DirectConnection),
    /// The user said no to the candidate they picked. Nothing has been written,
    /// so each caller closes its own flow out however that flow should end.
    Declined,
    /// Backspace: reopen the question that offered this candidate.
    Back,
}

/// Exit code a question uses when Backspace should reopen the previous step.
pub(crate) const STEP_BACK: i32 = 3;

/// The connection a direct candidate names, asking whatever that candidate
/// needs: a confirm for a URL a file already declares, the masked prompt for
/// one typed by hand, nothing at all for the local stack. The local stack's
/// migrations go through `--local`; every other URL's through `--db-url`.
///
/// Shared with `sync` and the bare `kizunasync` flow, which offer the direct
/// candidates on their own. `on_empty_entry` is what an empty masked entry
/// prints before exiting 2: each command owns that copy, because what to do
/// instead differs by command. `entered` is the string the masked prompt
/// opens on, the one typed the last time the step settled.
///
/// # Errors
/// Returns the exit code the command should stop with: `2` when the session
/// cannot prompt or the masked entry was empty, `0` when the user cancelled.
pub fn direct_connection_for(
    candidate: ConnectionCandidate,
    on_empty_entry: &str,
    env_files: &EnvFileValues,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
    entered: Option<&str>,
) -> Result<DirectChoice, i32> {
    match candidate {
        ConnectionCandidate::Manual => enter_db_url(on_empty_entry, prompter, ui, entered),
        ConnectionCandidate::EnvUrl {
            key,
            file,
            redacted_url,
        } => use_env_url(key, file, &redacted_url, env_files, prompter, ui),
        ConnectionCandidate::Local { port, .. } => {
            let url = discovery::local_url(port);
            crate::wizard_theme::detail(
                ui,
                &format!(
                    "  database:         {} ({})",
                    redact_db_url(&url),
                    DbUrlSource::LocalConfig
                ),
            );

            Ok(DirectChoice::Url(DirectConnection {
                url,
                push: PushTarget::Local,
            }))
        }
        // Both callers keep the two project candidates to themselves: reaching one
        // needs a token ladder, which is not a connection string's business.
        ConnectionCandidate::Account | ConnectionCandidate::LinkedProject { .. } => {
            ui.error("  that candidate names a project, not a database to connect to.");

            Err(UNUSABLE)
        }
    }
}

fn enter_db_url(
    on_empty_entry: &str,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
    current: Option<&str>,
) -> Result<DirectChoice, i32> {
    let entered = match prompter.ask_db_url(current) {
        Ok(entered) => entered,
        Err(PromptError::Back) => return Ok(DirectChoice::Back),
        Err(error) => return Err(cancel_or_stop(prompter, &error, ui)),
    };
    if entered.is_empty() {
        ui.error(on_empty_entry);

        return Err(UNUSABLE);
    }

    crate::wizard_theme::detail(
        ui,
        &format!("  database:         {} (entered)", redact_db_url(&entered)),
    );

    Ok(DirectChoice::Url(db_url_connection(session_mode(
        entered,
        "the entered connection string",
        ui,
    ))))
}

fn use_env_url(
    key: &'static str,
    file: &'static str,
    redacted_url: &str,
    env_files: &EnvFileValues,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
) -> Result<DirectChoice, i32> {
    match prompter.confirm(&format!("Use {key} from {file}? {redacted_url}"), true) {
        Ok(true) => {}
        Ok(false) => return Ok(DirectChoice::Declined),
        Err(PromptError::Back) => return Ok(DirectChoice::Back),
        Err(error) => return Err(cancel_or_stop(prompter, &error, ui)),
    }
    // The candidate only ever carried the masked spelling; this is where the real one is read.
    let Some(url) = env_files.get(key) else {
        ui.error(&format!("  {key} is no longer set in {file}: aborting."));

        return Err(UNUSABLE);
    };

    crate::wizard_theme::detail(
        ui,
        &format!("  database:         {redacted_url} ({key} from {file})"),
    );

    Ok(DirectChoice::Url(db_url_connection(session_mode(
        url.to_owned(),
        key,
        ui,
    ))))
}

/// A connection whose migrations go to the URL itself.
fn db_url_connection(url: String) -> DirectConnection {
    DirectConnection {
        push: PushTarget::DbUrl(url.clone()),
        url,
    }
}

// MARK: - connection test

/// Test a direct connection: a spinner that ends on the server facts when the
/// session can prompt, a `connected:` line when it cannot.
///
/// # Errors
/// Returns [`STEP_BACK`] when the test failed and the user wants another
/// connection, `2` when they do not or the session cannot prompt, and the
/// cancel exit when the question was cancelled.
pub(crate) fn test_direct_connection(
    direct: &DirectConnection,
    schemas: &dyn SchemaSource,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> Result<ServerFacts, i32> {
    run_connection_test(
        || {
            schemas
                .probe(&direct.url)
                .map_err(|cause| cause.to_string())
        },
        prompter,
        ui,
    )
}

/// Test whichever connection the wizard settled on: a direct one over
/// Postgres, a project over the Management API with the token masked out of
/// any failure.
///
/// # Errors
/// The same exits as [`test_direct_connection`].
pub(crate) fn test_connection(
    connection: &WizardConnection,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> Result<ServerFacts, i32> {
    match connection {
        WizardConnection::Direct(direct) => {
            test_direct_connection(direct, ports.schemas, &mut ports.prompter, ui)
        }
        WizardConnection::Remote {
            project_ref,
            credential,
        } => {
            let probe_remote = ports.probe_remote;
            run_connection_test(
                || {
                    probe_remote(project_ref, &credential.token)
                        .map_err(|cause| redact_access_token(&cause.to_string(), &credential.token))
                },
                &mut ports.prompter,
                ui,
            )
        }
    }
}

fn run_connection_test(
    probe: impl FnOnce() -> Result<ServerFacts, String>,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> Result<ServerFacts, i32> {
    if let Some(prompter) = prompter.as_deref_mut() {
        prompter.start_spin("Testing the connection…");
    }
    let cause = match probe() {
        Ok(facts) => {
            match prompter.as_deref_mut() {
                Some(prompter) => prompter.stop_spin(&format!("Connected: {}", facts.describe())),
                None => crate::wizard_theme::detail(
                    ui,
                    &format!("  connected:        {}", facts.describe()),
                ),
            }

            return Ok(facts);
        }
        Err(cause) => cause,
    };

    if let Some(prompter) = prompter.as_deref_mut() {
        prompter.stop_spin("Connection failed");
    }
    ui.error(&format!(
        "  could not connect to the database:\n    {cause}"
    ));
    let Some(prompter) = prompter.as_deref_mut() else {
        return Err(UNUSABLE);
    };
    match prompter.confirm("Pick another connection?", true) {
        Ok(true) | Err(PromptError::Back) => Err(STEP_BACK),
        Ok(false) => Err(UNUSABLE),
        Err(error) => Err(cancel_or_stop(prompter, &error, ui)),
    }
}

/// The token a Management API run needs: the one the ladder finds, else the
/// official `supabase login` browser flow, else one pasted at a masked prompt.
///
/// The ladder runs here rather than during discovery, so the credential store is
/// read only once the user has chosen a path that needs it: on macOS that is
/// the difference between a keychain prompt on explicit intent and one on every
/// `kizunasync init`.
fn credential_for_remote(
    flags: &InitFlags,
    env: &Env,
    env_files: &EnvFileValues,
    tokens: &dyn TokenStore,
    browser_login: &dyn Fn() -> crate::error::Result<()>,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
) -> Result<RemoteCredential, i32> {
    prompter.start_spin("Looking for a Supabase access token…");
    let found = token::discover_token(flags.access_token.as_deref(), env, env_files, tokens);
    prompter.stop_spin(&found.as_ref().map_or_else(
        || "No stored token found".to_owned(),
        |token| format!("Token from {}", token.origin),
    ));
    if let Some(token) = found {
        return Ok(RemoteCredential {
            origin: token.origin.to_string(),
            token: token.token,
        });
    }
    if let Some(token) = login_via_browser(env, env_files, tokens, browser_login, prompter, ui) {
        return Ok(RemoteCredential {
            origin: token.origin.to_string(),
            token: token.token,
        });
    }
    let entered = match prompter.ask_access_token() {
        Ok(entered) => entered,
        Err(PromptError::Back) => return Err(STEP_BACK),
        Err(error) => return Err(cancel_or_stop(prompter, &error, ui)),
    };
    if entered.is_empty() {
        ui.error("  no access token provided: aborting.");

        return Err(UNUSABLE);
    }

    if !token::is_valid_token(&entered) {
        ui.error(
            "  that is not a Personal Access Token (sbp_…): a project secret or JWT cannot authorize the Management API.",
        );

        return Err(UNUSABLE);
    }

    Ok(RemoteCredential {
        token: entered,
        origin: "entered".to_owned(),
    })
}

/// Run the official browser login, then re-read the ladder. A failure or a
/// login that stored nothing falls through to the paste, never a hard abort.
fn login_via_browser(
    env: &Env,
    env_files: &EnvFileValues,
    tokens: &dyn TokenStore,
    browser_login: &dyn Fn() -> crate::error::Result<()>,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
) -> Option<token::DiscoveredToken> {
    ui.log("  opening supabase login in your browser…");
    match browser_login() {
        Ok(()) => {
            let found = token::discover_token(None, env, env_files, tokens);
            if found.is_some() {
                let _ = prompter.note("Logged in", "Token stored by supabase login.");
            } else {
                ui.warn("  supabase login finished, but no token was stored.");
            }

            found
        }
        Err(cause) => {
            ui.warn(&format!("  {cause}"));
            ui.log(&format!(
                "  {}",
                crate::docs::hyperlink("Create a token on supabase.com", token::TOKENS_PAGE)
            ));

            None
        }
    }
}

/// The account's projects, then the one the user picked, checked here, where
/// its ref enters the CLI. The list opens on `current`, the ref picked the
/// last time the step settled.
fn pick_account_project(
    credential: &RemoteCredential,
    list_projects: &dyn Fn(&str) -> crate::error::Result<Vec<ProjectSummary>>,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
    current: Option<&str>,
) -> Result<ProjectRef, i32> {
    prompter.start_spin("Reading your Supabase projects…");
    let listed = list_projects(&credential.token);
    let projects = match listed {
        Ok(projects) => {
            prompter.stop_spin(&format!("{} project(s) found", projects.len()));
            projects
        }
        Err(cause) => {
            prompter.stop_spin("Could not read your projects");
            ui.error(&format!(
                "  {} (token from {})",
                redact_access_token(&cause.to_string(), &credential.token),
                credential.origin
            ));

            return Err(UNUSABLE);
        }
    };
    let chosen = match prompter.select_project(&projects, current) {
        Ok(chosen) => chosen,
        Err(PromptError::Back) => return Err(STEP_BACK),
        Err(error) => return Err(cancel_or_stop(prompter, &error, ui)),
    };
    if chosen.is_empty() {
        ui.error(&format!(
            "  that token (from {}) reaches no projects: create one at https://supabase.com/dashboard.",
            credential.origin
        ));

        return Err(UNUSABLE);
    }

    ProjectRef::parse(&chosen).map_err(|cause| {
        ui.error(&format!(
            "  the account listed {chosen:?}, which is {cause}: aborting."
        ));

        UNUSABLE
    })
}

/// The user said no. Nothing was written, so this is a clean exit, not a
/// failure, the same shape every other declined confirm takes.
fn declined(prompter: &mut dyn Prompter, ui: &mut Ui) -> i32 {
    let _ = prompter.outro_cancel("Nothing written.");
    ui.log(CANCELLED);

    OK
}

/// Close the wizard's chrome for a question that produced no answer, then map
/// it to an exit code.
pub fn cancel_or_stop(prompter: &mut dyn Prompter, error: &PromptError, ui: &mut Ui) -> i32 {
    cancel_or_stop_after(prompter, error, Written::Nothing, ui)
}

/// [`cancel_or_stop`] for a run that has already applied `written`, which a
/// cancel names instead of claiming nothing was written.
pub(crate) fn cancel_or_stop_after(
    prompter: &mut dyn Prompter,
    error: &PromptError,
    written: Written,
    ui: &mut Ui,
) -> i32 {
    if matches!(error, PromptError::Back) {
        return STEP_BACK;
    }
    if matches!(error, PromptError::Cancelled) {
        let _ = prompter.outro_cancel(written.outro());
    }

    stop_for_after(error, written, ui)
}

/// The exit a failed question produces: a cancelled wizard wrote nothing and is
/// not a failure, a vanished terminal is a usage error, anything else is real.
pub fn stop_for(error: &PromptError, ui: &mut Ui) -> i32 {
    stop_for_after(error, Written::Nothing, ui)
}

/// [`stop_for`] for a run that has already applied `written`.
fn stop_for_after(error: &PromptError, written: Written, ui: &mut Ui) -> i32 {
    match error {
        PromptError::Cancelled => {
            ui.log(written.cancelled());

            OK
        }
        PromptError::Back => STEP_BACK,
        PromptError::NotInteractive => {
            ui.log(CONFIRM_REFUSAL);

            UNUSABLE
        }
        PromptError::Backend(_) | PromptError::Script(_) => {
            ui.error(&format!("  the wizard could not ask: {error}"));

            UNUSABLE
        }
    }
}
