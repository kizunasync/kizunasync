//! Bare `kizunasync`: what a terminal gets when no subcommand was named.
//!
//! Without a terminal this module is never reached: `lib.rs` prints the help, as
//! it always has. With one, "what did you want?" is answerable from two facts
//! the database the user picks answers for itself: whether it carries the
//! Kizuna ledger, and whether `kizunasync._config` holds a row. The flow asks
//! for a connection ONCE and then hands off:
//!
//! | synced tables | ledger  | hands off to                                  |
//! | ------------- | ------- | --------------------------------------------- |
//! | any           | present | the control panel ([`crate::commands::panel`]) |
//! | some          | absent  | `init`: provision this database               |
//! | none          | absent  | `init`: the full install                      |
//!
//! The panel's Synced tables item is where the `sync` wizard runs, or `init`'s
//! proposal from the RLS policies while no table is synced. A ledger that
//! records nothing, which is what a removal leaves, closes the panel onto the
//! install path, as if the ledger were absent.
//!
//! The ledger is read first, and the synced-table read follows inside whichever
//! branch it answered. Once the ledger proves the pack is installed, a
//! `kizunasync._config` that cannot be read is a failure and the flow stops.
//! Without the ledger nothing is installed, the table does not exist, and a
//! failed read is the expected answer rather than a failure: there it only
//! decides which of the two install questions to ask, and both lead to the same
//! installer.
//!
//! Nothing here forks a command: the connection picker, the token ladder, the
//! ledger read, and both wizards are the ones `init` and `sync` already use.
//! This module only decides which of them to run, and hands each the connection
//! it already resolved so nobody is asked twice.
//!
//! The one exception is stated, never worked around: the `sync` this flow hands
//! off to writes its delta as a migration and pushes it with `supabase db push`,
//! which takes a direct Postgres connection. A project picked through the
//! Management API is reached directly with the same token when it is the linked
//! project; any other is told exactly that, pointed at `kizunasync sync
//! --project-ref` (which edits it over the API with no migration file), and
//! offered the direct connections: the ledger state already read stands.

use std::path::Path;
use std::rc::Rc;

use crate::applier::Applier;
use crate::catalog::SchemaSource;
use crate::commands::deprovision::{self, ExposureTarget};
use crate::commands::init::{
    self, DirectChoice, DirectConnection, InitFlags, InitPorts, WizardConnection,
};
use crate::commands::panel::{self, Opened, PanelContext, PanelPorts};
use crate::commands::{OK, UNUSABLE, sync};
use crate::config::{KizunaSyncConfig, load_config_from_db};
use crate::discovery::{self, ConnectionCandidate};
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::error::Result;
use crate::management::{
    ExposeOutcome, ExposedSchemas, ManagementApi, ReqwestTransport, UnexposeOutcome,
    redact_access_token, resolve_access_token,
};
use crate::pg::PgApplier;
use crate::prompts::{BackKey, PromptError, Prompter};
use crate::provision::{LedgerState, read_ledger_state};
use crate::token::ACCESS_TOKEN_ENV;
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

// MARK: - ports

/// Everything the bare flow reaches outside through: `init`'s ports (the
/// wizard, the schema reads, the push, the token store, the account listing),
/// which both hand-offs need anyway, plus the one read that is this flow's own.
pub struct SmartPorts<'a> {
    /// The ports the connection picker and both hand-offs run on.
    pub init: InitPorts<'a>,
    /// Whether the chosen connection already carries the ledger. Production
    /// reads it over whichever transport the connection names; a test answers
    /// from a fixture, so no unit test opens a socket.
    pub ledger: &'a dyn Fn(&WizardConnection) -> Result<LedgerState>,
    /// What that connection already syncs, read the same way and only once the
    /// ledger proves there is a `kizunasync._config` to read.
    pub config: &'a dyn Fn(&WizardConnection) -> Result<KizunaSyncConfig>,
    /// Opens a direct connection to the linked project for the `sync`
    /// hand-off.
    pub linked: &'a sync::LinkedConnector<'a>,
    /// What the control panel reaches beyond the ports above.
    pub panel: PanelPorts<'a>,
}

// MARK: - copy

/// The schema both wizards default to, matching their own `--schema` default.
const DEFAULT_SCHEMA: &str = "public";

const INSTALL_HERE: &str = "Kizuna is not installed on this database: install it now?";

pub(crate) const NOTHING_SYNCED: &str =
    "This database has Kizuna installed but syncs no tables yet. Pick them now?";

pub(crate) const FRESH_INSTALL: &str = "Install Kizuna Sync in this project?";

const DECLINED_OUTRO: &str =
    "Nothing done: `kizunasync init` installs, `kizunasync --help` lists the rest.";

const DECLINED: &str =
    "  nothing done: run `kizunasync init` to install, or `kizunasync --help` for the rest.";

const LEDGER_UNREADABLE: &str = "  could not read the Kizuna ledger:";

const CONFIG_UNREADABLE: &str = "  could not read the synced tables:";

/// The hand-off writes a migration and pushes it with `supabase db push`,
/// which takes a direct Postgres connection; the Management API the picked
/// project answered on applies SQL in place instead. The limitation is stated
/// before anything else is asked, never worked around silently.
const SYNC_NEEDS_POSTGRES: &str = concat!(
    "Editing the synced tables here writes a migration and pushes it with supabase db push,\n",
    "which needs a DIRECT Postgres connection. The project you just picked answers over the\n",
    "Management API: pick a direct connection, or run `kizunasync sync --project-ref <ref>`\n",
    "to edit it over the API with no migration file."
);

const SYNC_NEEDS_POSTGRES_TITLE: &str = "A direct connection is needed";

const SYNC_DECLINED_OUTRO: &str = concat!(
    "Run `kizunasync sync --db-url <session pooler URL>` when you want to change what syncs. ",
    "CLI reference: https://kizunasync.com/docs/cli"
);

const SYNC_DECLINED: &str = concat!(
    "  nothing changed: run `kizunasync sync --db-url <session pooler URL>` to edit the\n",
    "  synced tables. CLI reference: https://kizunasync.com/docs/cli"
);

// MARK: - run

/// Ask which database, look at what is already there, and run the command that
/// answers. Reports through `ui` exactly as the command it hands off to does.
pub fn run(
    cwd: &Path,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    mut ports: SmartPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    if let Some(prompter) = ports.init.prompter.as_deref_mut()
        && let Err(error) = prompter.intro(crate::docs::BARE)
    {
        return init::cancel_or_stop(prompter, &error, ui);
    }
    // No subcommand means no flags: every rung below is the discovered one.
    let flags = InitFlags {
        dry_run: false,
        yes: false,
        local_only: false,
        schema: DEFAULT_SCHEMA.to_owned(),
        project_ref: None,
        db_url: None,
        access_token: None,
        options: crate::commands::sync::TableOptions::default(),
        settings: crate::commands::sync::SettingsOptions::default(),
        allow_no_cron: false,
        allow_no_rls: false,
    };
    let mut answers = init::ConnectionAnswers::default();
    loop {
        let attempt = crate::wizard_theme::mark();
        let connection = match init::choose_connection(
            &flags,
            paths,
            env,
            env_files,
            &mut ports.init,
            ui,
            &mut answers,
        ) {
            Ok(connection) => connection,
            Err(code) => return code,
        };

        let installed = match (ports.ledger)(&connection) {
            Ok(state) => matches!(state, LedgerState::Present(_)),
            Err(cause) => {
                ui.error(&format!(
                    "{LEDGER_UNREADABLE}\n    {}",
                    redacted(&connection, &cause.to_string())
                ));

                return UNUSABLE;
            }
        };

        let code = if installed {
            // No question settled a connection the environment chose, so no
            // step lies behind the panel.
            let menu_back = if answers.reopen_mark().is_some() {
                BackKey::Honoured
            } else {
                BackKey::Ignored
            };
            let context = PanelContext {
                cwd,
                paths,
                env,
                env_files,
                flags: &flags,
                menu_back,
            };
            continue_installed(&connection, &context, &mut ports, ui)
        } else {
            install_fresh(&connection, &flags, cwd, paths, env, &mut ports, ui)
        };
        if code == init::STEP_BACK {
            crate::wizard_theme::rewind(answers.reopen_mark().unwrap_or(attempt));
            continue;
        }
        return code;
    }
}

/// No ledger means nothing is installed, so `kizunasync._config` is not
/// expected to exist: an unreadable one is the same news as an empty one
/// here, and only picks which install question to ask. The control panel
/// closes onto this path when its ledger records nothing.
pub(crate) fn install_fresh(
    connection: &WizardConnection,
    flags: &InitFlags,
    cwd: &Path,
    paths: &ProjectPaths,
    env: &Env,
    ports: &mut SmartPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let question = if has_synced_tables(&(ports.config)(connection)) {
        INSTALL_HERE
    } else {
        FRESH_INSTALL
    };

    install(question, connection, flags, cwd, paths, env, ports, ui)
}

/// The pack IS installed, so a `_config` that cannot be read is a real
/// failure; a readable one opens the control panel, whatever it syncs.
fn continue_installed(
    connection: &WizardConnection,
    context: &PanelContext<'_>,
    ports: &mut SmartPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    if let Err(cause) = (ports.config)(connection) {
        ui.error(&format!(
            "{CONFIG_UNREADABLE}\n    {}",
            redacted(connection, &cause.to_string())
        ));

        return UNUSABLE;
    }

    panel::run(connection, context, ports, ui)
}

/// The production applier: Postgres for a direct connection, the Management
/// API for a project. Every read and write the bare flow makes goes through
/// one of these two.
///
/// # Errors
/// Returns the transport's own failure when the Management API client cannot
/// be built.
pub fn open_applier(connection: &WizardConnection) -> Result<Box<dyn Applier>> {
    match connection {
        WizardConnection::Direct(direct) => Ok(Box::new(PgApplier::new(&direct.url))),
        WizardConnection::Remote {
            project_ref,
            credential,
        } => Ok(Box::new(ManagementApi::new(
            ReqwestTransport::new()?,
            &credential.token,
            project_ref,
            None,
        ))),
    }
}

/// The production panel opener: the applier the connection names, and the
/// exposed-schema list a purge edits through the Management API. A project
/// picked through the API shares one client between the two. A direct
/// connection to a hosted project gets a client of its own when a token
/// (`SUPABASE_ACCESS_TOKEN`) and the project's ref reach it
/// ([`deprovision::exposure_target`]).
///
/// # Errors
/// Returns the transport's own failure when the Management API client cannot
/// be built.
pub fn open_panel(
    connection: &WizardConnection,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
) -> Result<Opened> {
    let direct = match connection {
        WizardConnection::Direct(direct) => direct,
        WizardConnection::Remote {
            project_ref,
            credential,
        } => {
            let api = Rc::new(ManagementApi::new(
                ReqwestTransport::new()?,
                &credential.token,
                project_ref,
                None,
            ));

            return Ok(Opened {
                applier: Box::new(SharedApi(Rc::clone(&api))),
                exposure: Some((project_ref.clone(), Box::new(SharedApi(api)))),
                warning: None,
            });
        }
    };
    let linked = discovery::linked_project_ref(paths, env, env_files)
        .ok()
        .flatten()
        .map(|(project_ref, _)| project_ref);
    let hosted = matches!(
        deprovision::exposure_target(direct, paths, linked.as_ref(), true),
        ExposureTarget::ManagementApi(_)
    );
    // The CLI's own line for a token the environment holds that is not one,
    // said only where a hosted target would have used it.
    let (token, warning) = match resolve_access_token(None, env) {
        Ok(token) => (Some(token), None),
        Err(cause) if hosted && env.get(ACCESS_TOKEN_ENV).is_some() => {
            (None, Some(format!("  {cause}")))
        }
        Err(_) => (None, None),
    };
    let target = deprovision::exposure_target(direct, paths, linked.as_ref(), token.is_some());
    let exposure = match (target, token) {
        (ExposureTarget::ManagementApi(project_ref), Some(token)) => {
            ReqwestTransport::new().ok().map(|http| {
                let api = ManagementApi::new(http, &token.token, &project_ref, None);

                (project_ref, Box::new(api) as Box<dyn ExposedSchemas>)
            })
        }
        (ExposureTarget::ManagementApi(_), None)
        | (ExposureTarget::ConfigToml | ExposureTarget::ByHand, _) => None,
    };

    Ok(Opened {
        applier: open_applier(connection)?,
        exposure,
        warning,
    })
}

/// One Management API client the panel's applier and its exposed-schema list
/// share.
struct SharedApi(Rc<ManagementApi<ReqwestTransport>>);

impl Applier for SharedApi {
    fn run_query(&self, sql: &str) -> Result<Vec<crate::row::Row>> {
        self.0.run_query(sql)
    }
}

impl ExposedSchemas for SharedApi {
    fn exposed_schemas(&self) -> Result<Vec<String>> {
        self.0.exposed_schemas()
    }

    fn unexpose_schema(&self, schema: &str) -> Result<UnexposeOutcome> {
        self.0.unexpose_schema(schema)
    }

    fn expose_schema(&self, schema: &str) -> Result<ExposeOutcome> {
        self.0.expose_schema(schema)
    }
}

/// The production ledger read, over [`open_applier`].
///
/// # Errors
/// Whatever the transport or the ledger read returned.
pub fn read_ledger_over(connection: &WizardConnection) -> Result<LedgerState> {
    read_ledger_state(open_applier(connection)?.as_ref())
}

/// Whether the read found a synced table. An unreadable `_config` counts as
/// none, which is only ever consulted where the ledger has already established
/// that nothing is installed.
fn has_synced_tables(synced: &Result<KizunaSyncConfig>) -> bool {
    synced
        .as_ref()
        .is_ok_and(|config| !config.tables.is_empty())
}

/// The production synced-set read, over [`open_applier`].
///
/// # Errors
/// Whatever the transport or the `kizunasync._config` read returned.
pub fn read_config_over(connection: &WizardConnection) -> Result<KizunaSyncConfig> {
    load_config_from_db(open_applier(connection)?.as_ref())
}

/// A Management API failure can quote the request that carried the token,
/// so a remote message is masked before anyone reads it.
pub(crate) fn redacted(connection: &WizardConnection, message: &str) -> String {
    match connection {
        WizardConnection::Direct(_) => message.to_owned(),
        WizardConnection::Remote { credential, .. } => {
            redact_access_token(message, &credential.token)
        }
    }
}

/// Confirm, then run `init`'s wizard from the connection already chosen. A "no"
/// is a clean exit: nothing has been written yet, and the user is told which
/// command to run when they want it.
#[expect(
    clippy::too_many_arguments,
    reason = "The wizard's context, threaded not stored."
)]
pub(crate) fn install(
    question: &str,
    connection: &WizardConnection,
    flags: &InitFlags,
    cwd: &Path,
    paths: &ProjectPaths,
    env: &Env,
    ports: &mut SmartPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    loop {
        let step = crate::wizard_theme::mark();
        let Some(prompter) = ports.init.prompter.as_deref_mut() else {
            return init::stop_for(&PromptError::NotInteractive, ui);
        };
        match prompter.confirm(question, true) {
            Ok(true) => {}
            Ok(false) => {
                let _ = prompter.outro_cancel(DECLINED_OUTRO);
                ui.log(DECLINED);

                return OK;
            }
            Err(PromptError::Back) => {
                crate::wizard_theme::rewind(step);
                return init::STEP_BACK;
            }
            Err(error) => return init::cancel_or_stop(prompter, &error, ui),
        }

        let code = init::run_with_connection(
            connection.clone(),
            flags,
            cwd,
            paths,
            env,
            &mut ports.init,
            ui,
        );
        if code == init::STEP_BACK {
            crate::wizard_theme::rewind(step);
            continue;
        }
        return code;
    }
}

/// Hand the already-provisioned project to `sync`'s wizard, carrying the
/// settled connection (and where its migrations go) across so it never asks
/// again. The prompter is lent, so the control panel asks on after it.
pub(crate) fn hand_off_to_sync(
    connection: WizardConnection,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    ports: &mut SmartPorts<'_>,
    ui: &mut Ui,
) -> sync::Finished {
    let direct = match connection {
        WizardConnection::Direct(direct) => direct,
        WizardConnection::Remote {
            project_ref,
            credential,
        } => {
            // The linked project carries its own direct connection, opened
            // with the token that already reached it. A linked ref that is not
            // valid names no project here; the picker below refuses it.
            let linked = discovery::linked_project_ref(paths, env, env_files)
                .ok()
                .flatten()
                .filter(|(linked_ref, _)| *linked_ref == project_ref)
                .and_then(|_| {
                    sync::linked_direct_url(&project_ref, Some(&credential.token), ports.linked, ui)
                });
            if let Some(direct) = linked {
                direct
            } else {
                let Some(prompter) = ports.init.prompter.as_deref_mut() else {
                    return sync::Finished::on(init::stop_for(&PromptError::NotInteractive, ui));
                };
                match direct_connection_for_sync(
                    paths,
                    env,
                    env_files,
                    ports.init.schemas,
                    prompter,
                    ui,
                ) {
                    Ok(direct) => direct,
                    Err(code) => return sync::Finished::on(code),
                }
            }
        }
    };

    let flags = sync::SyncFlags {
        schema: DEFAULT_SCHEMA.to_owned(),
        connection: Some(direct),
        ..sync::SyncFlags::default()
    };
    let mut sync_ports = sync::SyncPorts {
        prompter: ports
            .init
            .prompter
            .as_deref_mut()
            .map(|prompter| prompter as &mut dyn Prompter),
        schemas: ports.init.schemas,
        supabase: ports.init.supabase,
        now_unix: ports.init.now_unix,
        tokens: ports.init.tokens,
        linked: ports.linked,
    };

    sync::run_session(&flags, paths, env, env_files, None, &mut sync_ports, ui)
}

/// Say why the project selection cannot serve `sync`, then offer the direct
/// connections this project has. Not the connection question asked twice: the
/// answer already given cannot carry `supabase db push`, and the note says so
/// before anything is asked. The ledger state read over the Management API stands;
/// this only replaces the transport. The pick is tested like every other
/// connection, and a failed test that asks for another offers the list again.
fn direct_connection_for_sync(
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    schemas: &dyn SchemaSource,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
) -> std::result::Result<DirectConnection, i32> {
    let _ = prompter.note(SYNC_NEEDS_POSTGRES_TITLE, SYNC_NEEDS_POSTGRES);
    // Reached when the linked project is not the one picked or its login
    // failed, so it is not offered again.
    let mut candidates: Vec<ConnectionCandidate> = discovery::discover(paths, env, env_files)
        .map_err(|cause| {
            ui.error(&format!("  {cause}"));

            UNUSABLE
        })?
        .into_iter()
        .filter(|candidate| {
            candidate.is_direct() && !matches!(candidate, ConnectionCandidate::LinkedProject { .. })
        })
        .collect();
    candidates.push(ConnectionCandidate::Manual);
    loop {
        let chosen = match prompter.select_candidate(&candidates, None) {
            Ok(chosen) => chosen,
            Err(error) => return Err(init::cancel_or_stop(prompter, &error, ui)),
        };

        // This flow is on its way into `sync`'s wizard, so it speaks sync's copy.
        let direct = match init::direct_connection_for(
            chosen,
            sync::NO_CONNECTION_ENTERED,
            env_files,
            prompter,
            ui,
            None,
        )? {
            DirectChoice::Url(direct) => direct,
            DirectChoice::Back => return Err(init::STEP_BACK),
            DirectChoice::Declined => {
                let _ = prompter.outro_cancel(SYNC_DECLINED_OUTRO);
                ui.log(SYNC_DECLINED);

                return Err(OK);
            }
        };
        match init::test_direct_connection(&direct, schemas, &mut Some(&mut *prompter), ui) {
            Ok(_) => return Ok(direct),
            Err(code) if code == init::STEP_BACK => {}
            Err(code) => return Err(code),
        }
    }
}

// MARK: - tests

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::path::PathBuf;
    use std::rc::Rc;

    use crate::applier::fake::{FakeApplier, text_row};
    use crate::catalog::SchemaSource;
    use crate::commands::doctor::DoctorPorts;
    use crate::commands::panel::fixtures::{self, Ledger, NoDataApi, Synced};
    use crate::commands::panel::{PanelAction, PanelPorts};
    use crate::constants::INTERNAL_CONFIG;
    use crate::discovery::ConnectionCandidate;
    use crate::management::ProjectSummary;
    use crate::project_ref::ProjectRef;
    use crate::prompts::{Answer, Ask, Prompter, ScriptedPrompter, WizardMode};
    use crate::proposals::{PolicyRow, SchemaCatalog};
    use crate::provision::LedgerStateEntry;
    use crate::server_facts::ServerFacts;
    use crate::supabase_cli::PushTarget;
    use crate::supabase_cli::fake::RecordingCli;
    use crate::ui::Capture;

    use super::*;

    const FIXED_NOW: i64 = 1_700_000_000;

    /// The connection the process ladder hands over without a question.
    const ENV_DB_URL: &str = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

    /// Structurally valid, and nothing like a real token or project.
    const WIZARD_PAT: &str = "sbp_0123456789abcdef0123456789abcdef01234567";
    const LINKED_REF: &str = "abcdefghijklmnopqrst";

    /// A `.env` URL, and the password that must never reach any output.
    const ENV_FILE_PASSWORD: &str = "s3cr3t";
    const ENV_FILE_URL: &str = "postgresql://postgres:s3cr3t@db.example:5432/postgres";

    /// The synced set a provisioned database answers with: the two tables the
    /// fake catalog holds.
    fn synced_rows() -> FakeApplier {
        FakeApplier::new().answer(
            INTERNAL_CONFIG,
            vec![
                text_row(&[
                    ("table_name", "todos"),
                    ("sync_mode", "read-write"),
                    ("bucket_column", "user_id"),
                    ("tombstone_ttl_days", "30"),
                ]),
                text_row(&[("table_name", "notes"), ("sync_mode", "pull-only")]),
            ],
        )
    }

    // MARK: - fakes

    /// The database both wizards read through: `todos` carries an owner-keyed
    /// RLS policy, `notes` does not. A probe error either fails every probe
    /// or, `once`, only the first.
    struct FakeSchemas {
        probe_error: std::cell::RefCell<Option<String>>,
        once: bool,
        config: FakeApplier,
    }

    impl FakeSchemas {
        fn ok() -> Self {
            Self {
                probe_error: std::cell::RefCell::new(None),
                once: false,
                config: synced_rows(),
            }
        }

        fn failing_probe(reason: &str) -> Self {
            Self {
                probe_error: std::cell::RefCell::new(Some(reason.to_owned())),
                ..Self::ok()
            }
        }

        fn failing_first_probe(reason: &str) -> Self {
            Self {
                once: true,
                ..Self::failing_probe(reason)
            }
        }
    }

    /// What every fake connection test answers.
    fn test_facts() -> ServerFacts {
        ServerFacts {
            version: "17.4".to_owned(),
            database: "postgres".to_owned(),
            user: "postgres".to_owned(),
        }
    }

    #[expect(clippy::unnecessary_wraps)] // Matches the fallible port signature.
    fn remote_facts_ok(_project_ref: &ProjectRef, _token: &str) -> Result<ServerFacts> {
        Ok(test_facts())
    }

    impl SchemaSource for FakeSchemas {
        fn probe(&self, _url: &str) -> crate::error::Result<ServerFacts> {
            let error = if self.once {
                self.probe_error.borrow_mut().take()
            } else {
                self.probe_error.borrow().clone()
            };

            error.map_or_else(
                || Ok(test_facts()),
                |reason| Err(crate::error::Error::Db(reason)),
            )
        }

        fn introspect(&self, _url: &str, _schema: &str) -> crate::error::Result<SchemaCatalog> {
            Ok(SchemaCatalog {
                tables: vec!["todos".to_owned(), "notes".to_owned()],
                policies: vec![PolicyRow {
                    table: "todos".to_owned(),
                    qual: "(auth.uid() = user_id)".to_owned(),
                }],
                ..Default::default()
            }
            .keyed_by_uuid_id())
        }

        fn read_config(&self, _url: &str) -> crate::error::Result<KizunaSyncConfig> {
            load_config_from_db(&self.config)
        }

        fn pg_cron_present(&self, _url: &str) -> crate::error::Result<bool> {
            Ok(true)
        }

        fn applied_migrations(
            &self,
            _url: &str,
        ) -> crate::error::Result<Vec<crate::migration_history::AppliedMigration>> {
            Ok(Vec::new())
        }

        /// A fresh ledger: the bare flow's tests never meet a changed pack.
        fn ledger_rows(
            &self,
            _url: &str,
        ) -> crate::error::Result<Vec<crate::provision::LedgerRow>> {
            Ok(Vec::new())
        }

        fn pack_applier(&self, _url: &str) -> Box<dyn crate::applier::Applier + '_> {
            panic!("a fresh ledger never re-applies the pack")
        }

        fn provisioning_gaps(
            &self,
            _url: &str,
            _expected: &crate::verify::Expectation,
        ) -> crate::error::Result<Vec<String>> {
            Ok(Vec::new())
        }
    }

    /// The account rung, for every test that must never reach it.
    fn unreachable_projects(_token: &str) -> crate::error::Result<Vec<ProjectSummary>> {
        Err(crate::error::Error::Transport(
            "unreachable, no test lists projects over the network".to_owned(),
        ))
    }

    // Both answer the ledger port, whose signature is fallible even where a
    // fixture cannot fail.
    #[expect(clippy::unnecessary_wraps)] // Matches the fallible port signature.
    fn absent(_connection: &WizardConnection) -> Result<LedgerState> {
        Ok(LedgerState::Absent)
    }

    #[expect(clippy::unnecessary_wraps)] // Matches the fallible port signature.
    fn present(_connection: &WizardConnection) -> Result<LedgerState> {
        Ok(LedgerState::Present(vec![LedgerStateEntry {
            object_kind: "function".to_owned(),
            count: 12,
        }]))
    }

    fn unreadable(_connection: &WizardConnection) -> Result<LedgerState> {
        Err(crate::error::Error::Db("permission denied".to_owned()))
    }

    fn synced(_connection: &WizardConnection) -> Result<KizunaSyncConfig> {
        load_config_from_db(&synced_rows())
    }

    #[expect(clippy::unnecessary_wraps)] // Matches the fallible port signature.
    fn nothing_synced(_connection: &WizardConnection) -> Result<KizunaSyncConfig> {
        Ok(KizunaSyncConfig::default())
    }

    fn unreadable_config(_connection: &WizardConnection) -> Result<KizunaSyncConfig> {
        Err(crate::error::Error::Config(
            crate::config::unreadable_message(&crate::error::Error::Db(
                "permission denied".to_owned(),
            )),
        ))
    }

    // MARK: - fixtures

    /// The pack this checkout ships, addressed from the crate's manifest so a
    /// build directory outside the repository cannot make a test skip itself.
    fn test_pack_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/supabase-pack")
    }

    /// The pack override plus a connection string on the process ladder: the
    /// rung that decides without asking.
    fn env_with_db() -> Env {
        Env::from_pairs(&[
            ("KSYNC_PACK_DIR", test_pack_dir().to_string_lossy().as_ref()),
            ("KSYNC_DB_URL", ENV_DB_URL),
        ])
    }

    /// The pack override alone: nothing is discoverable, so the picker asks.
    fn env_without_db() -> Env {
        Env::from_pairs(&[("KSYNC_PACK_DIR", test_pack_dir().to_string_lossy().as_ref())])
    }

    struct SmartRun {
        code: i32,
        capture: Capture,
        prompter: ScriptedPrompter,
        /// Every `supabase db push` the run made, by target.
        pushes: Vec<PushTarget>,
    }

    impl SmartRun {
        /// Every confirm the run put to the user, in order.
        fn confirms(&self) -> Vec<String> {
            self.prompter
                .asked()
                .iter()
                .filter_map(|ask| match ask {
                    Ask::Confirm { message, .. } => Some(message.clone()),
                    _ => None,
                })
                .collect()
        }

        /// Every candidate list the run put to the user, in order.
        fn candidate_lists(&self) -> Vec<Vec<ConnectionCandidate>> {
            self.prompter
                .asked()
                .iter()
                .filter_map(|ask| match ask {
                    Ask::Candidate { candidates, .. } => Some(candidates.clone()),
                    _ => None,
                })
                .collect()
        }

        /// Every panel menu the run drew.
        fn menus(&self) -> usize {
            self.prompter
                .asked()
                .iter()
                .filter(|ask| matches!(ask, Ask::Action { .. }))
                .count()
        }

        fn times_asked(&self, wanted: &Ask) -> usize {
            self.prompter
                .asked()
                .iter()
                .filter(|ask| std::mem::discriminant(*ask) == std::mem::discriminant(wanted))
                .count()
        }
    }

    /// The notes that say why a project selection cannot serve `sync`.
    fn limitation_notes(run: &SmartRun) -> Vec<String> {
        run.prompter
            .notes()
            .iter()
            .filter(|(title, _)| title == SYNC_NEEDS_POSTGRES_TITLE)
            .map(|(_, body)| body.clone())
            .collect()
    }

    fn run_in(
        dir: &Path,
        env: &Env,
        answers: Vec<Answer>,
        ledger: &dyn Fn(&WizardConnection) -> Result<LedgerState>,
    ) -> SmartRun {
        run_with(
            dir,
            env,
            answers,
            ledger,
            &synced,
            &FakeSchemas::ok(),
            &no_linked,
            fixtures::database(Ledger::Current, Synced::TodosAndNotes),
        )
    }

    /// A linked connector that fails the way a missing token does.
    fn no_linked(
        _project_ref: &ProjectRef,
        _token: Option<&str>,
    ) -> Result<crate::login_role::LinkedConnection> {
        Err(crate::error::Error::Transport(
            "no Supabase access token".to_owned(),
        ))
    }

    fn run_with_config(
        dir: &Path,
        env: &Env,
        answers: Vec<Answer>,
        ledger: &dyn Fn(&WizardConnection) -> Result<LedgerState>,
        config: &dyn Fn(&WizardConnection) -> Result<KizunaSyncConfig>,
    ) -> SmartRun {
        run_with(
            dir,
            env,
            answers,
            ledger,
            config,
            &FakeSchemas::ok(),
            &no_linked,
            fixtures::database(Ledger::Current, Synced::Nothing),
        )
    }

    fn run_with_schemas(
        dir: &Path,
        env: &Env,
        answers: Vec<Answer>,
        ledger: &dyn Fn(&WizardConnection) -> Result<LedgerState>,
        schemas: &dyn SchemaSource,
    ) -> SmartRun {
        run_with(
            dir,
            env,
            answers,
            ledger,
            &synced,
            schemas,
            &no_linked,
            fixtures::database(Ledger::Current, Synced::TodosAndNotes),
        )
    }

    /// The panel's clock: the instant every fixture reads.
    fn fixed_clock() -> i64 {
        fixtures::FIXED_NOW
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Every port a bare run reaches, varied per test."
    )]
    fn run_with(
        dir: &Path,
        env: &Env,
        answers: Vec<Answer>,
        ledger: &dyn Fn(&WizardConnection) -> Result<LedgerState>,
        config: &dyn Fn(&WizardConnection) -> Result<KizunaSyncConfig>,
        schemas: &dyn SchemaSource,
        linked: &sync::LinkedConnector<'_>,
        database: FakeApplier,
    ) -> SmartRun {
        let (mut ui, capture) = Ui::capture();
        let mut scripted = ScriptedPrompter::new(answers);
        let cli = RecordingCli::new();
        let env_files = crate::env_file::load(dir);
        let database = Rc::new(database);
        let open = fixtures::opener(&database);
        let code = {
            let ports = SmartPorts {
                init: InitPorts {
                    prompter: Some(&mut scripted as &mut dyn Prompter),
                    schemas,
                    supabase: &cli,
                    now_unix: FIXED_NOW,
                    tokens: &crate::token::NoTokenStore,
                    list_projects: &unreachable_projects,
                    browser_login: &|| {
                        Err(crate::error::Error::Cli("no browser in tests".to_owned()))
                    },
                    probe_remote: &remote_facts_ok,
                },
                ledger,
                config,
                linked,
                panel: PanelPorts {
                    open: &open,
                    doctor: DoctorPorts {
                        env_files: &env_files,
                        data_api: &NoDataApi,
                        management: None,
                    },
                    clock: &fixed_clock,
                },
            };

            run(
                dir,
                &ProjectPaths::rooted_at(dir.to_path_buf()),
                env,
                &env_files,
                ports,
                &mut ui,
            )
        };

        SmartRun {
            code,
            capture,
            prompter: scripted,
            pushes: cli.pushes.take(),
        }
    }

    /// The answers `init`'s wizard asks for once the flow has handed off:
    /// schema, tables, recommended, and the write confirm. Recommended asks no
    /// server section, which is what leaves every knob as the pack seeds it.
    fn init_wizard_answers() -> Vec<Answer> {
        vec![
            Answer::Tables(vec!["todos".to_owned()]),
            Answer::Mode(WizardMode::Recommended),
            Answer::Confirm(true),
        ]
    }

    fn project(dir: &Path) {
        std::fs::write(dir.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    }

    /// A provisioned project that also has a linked project ref and a `.env`
    /// URL, so the first picker offers both kinds and the second can filter.
    /// Returns `answers` prefixed with the linked project's own two questions.
    fn with_linked_project(dir: &Path, answers: Vec<Answer>) -> Vec<Answer> {
        provisioned_project(dir);
        let temp = dir.join("supabase").join(".temp");
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join("project-ref"), LINKED_REF).unwrap();
        std::fs::write(dir.join(".env"), format!("DATABASE_URL={ENV_FILE_URL}\n")).unwrap();

        vec![
            Answer::Candidate(ConnectionCandidate::LinkedProject {
                project_ref: ProjectRef::parse(LINKED_REF).unwrap(),
                origin: crate::discovery::ProjectRefOrigin::LinkFile,
            }),
            Answer::Confirm(true),
            Answer::AccessToken(WIZARD_PAT.to_owned()),
        ]
        .into_iter()
        .chain(answers)
        .collect()
    }

    /// The `.env` candidate as the picker offers it: masked, never the secret.
    fn env_url_candidate() -> ConnectionCandidate {
        ConnectionCandidate::EnvUrl {
            key: "DATABASE_URL",
            file: ".env",
            redacted_url: "postgresql://postgres:***@db.example:5432/postgres".to_owned(),
        }
    }

    /// What `sync`'s wizard asks once it has a connection: schema, the table
    /// set to keep, and the write confirm.
    fn sync_wizard_answers() -> Vec<Answer> {
        vec![
            Answer::Confirm(true),
            Answer::Tables(vec!["todos".to_owned()]),
            Answer::Confirm(true),
        ]
    }

    /// The project shape both hand-offs need on disk. What is provisioned lives
    /// in the database, so this is the same tree either way.
    fn provisioned_project(dir: &Path) {
        project(dir);
    }

    fn migrations(dir: &Path) -> Vec<String> {
        let path = dir.join("supabase").join("migrations");
        if !path.exists() {
            return Vec::new();
        }
        let mut names: Vec<String> = std::fs::read_dir(path)
            .unwrap()
            .filter_map(|entry| {
                entry
                    .ok()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
            })
            .collect();
        names.sort();

        names
    }

    // MARK: - the four states

    /// Neither half exists: the full install, after one question.
    #[test]
    fn a_fresh_database_offers_the_full_install_and_runs_the_init_wizard() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let mut answers = vec![Answer::Confirm(true)];
        answers.extend(init_wizard_answers());
        let run = run_with_config(
            dir.path(),
            &env_with_db(),
            answers,
            &absent,
            &unreadable_config,
        );

        assert_eq!(run.code, OK);
        assert_eq!(
            run.confirms().first().map(String::as_str),
            Some(FRESH_INSTALL)
        );
        assert!(
            run.capture
                .stderr()
                .contains("provisioning Kizuna into this project")
        );
        assert!(
            migrations(dir.path())
                .iter()
                .any(|name| name.contains("_kizunasync_"))
        );
    }

    /// Config rows against a database whose ledger records nothing: the same
    /// installer, asked as the install it is.
    #[test]
    fn synced_tables_without_the_ledger_offer_to_install_this_database() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let mut answers = vec![Answer::Confirm(true)];
        answers.extend(init_wizard_answers());
        let run = run_in(dir.path(), &env_with_db(), answers, &absent);

        assert_eq!(run.code, OK);
        assert_eq!(
            run.confirms().first().map(String::as_str),
            Some(INSTALL_HERE)
        );
    }

    /// Installed, but nothing synced yet: the same installer, asked for what it
    /// would actually do: read the RLS policies and propose a set.
    #[test]
    fn an_installed_database_that_syncs_nothing_offers_to_pick_the_tables() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let mut answers = vec![
            Answer::Action(PanelAction::SyncedTables),
            Answer::Confirm(true),
        ];
        answers.extend(init_wizard_answers());
        answers.push(Answer::Action(PanelAction::Exit));
        let run = run_with_config(
            dir.path(),
            &env_with_db(),
            answers,
            &present,
            &nothing_synced,
        );

        assert_eq!(run.code, OK);
        assert_eq!(
            run.confirms().first().map(String::as_str),
            Some(NOTHING_SYNCED)
        );
        assert!(
            run.capture
                .stderr()
                .contains("provisioning Kizuna into this project")
        );
    }

    /// Installed and already syncing is the steady state: no install question at
    /// all, the control panel, and its Synced tables item is the synced-table
    /// editor.
    #[test]
    fn a_provisioned_project_opens_the_panel_whose_synced_tables_item_runs_sync() {
        let dir = tempfile::tempdir().unwrap();
        provisioned_project(dir.path());
        let run = run_in(
            dir.path(),
            &env_with_db(),
            vec![
                Answer::Action(PanelAction::SyncedTables),
                Answer::Tables(vec!["todos".to_owned()]),
                Answer::Confirm(true),
                Answer::Action(PanelAction::Exit),
            ],
            &present,
        );

        assert_eq!(run.code, OK);
        assert!(
            run.capture
                .stderr()
                .contains("kizunasync sync: managing the synced tables")
        );
        assert!(
            !run.capture
                .stderr()
                .contains("provisioning Kizuna into this project")
        );
        let sync_migration = migrations(dir.path())
            .into_iter()
            .find(|name| name.ends_with("_kizunasync_sync.sql"))
            .expect("the sync delta");
        let sql = std::fs::read_to_string(
            dir.path()
                .join("supabase")
                .join("migrations")
                .join(sync_migration),
        )
        .unwrap();
        assert!(sql.contains("delete from kizunasync._config where table_name = 'notes';"));
    }

    /// The local stack settles as a `--local` push, and the hand-off to `sync`
    /// carries that target across instead of re-deriving one from a URL.
    #[test]
    fn a_direct_hand_off_to_sync_keeps_its_push_target() {
        let dir = tempfile::tempdir().unwrap();
        provisioned_project(dir.path());
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        std::fs::create_dir_all(dir.path().join("supabase")).unwrap();
        std::fs::write(
            dir.path().join("supabase").join("config.toml"),
            format!("[db]\nport = {port}\n"),
        )
        .unwrap();
        let run = run_in(
            dir.path(),
            &env_without_db(),
            vec![
                Answer::Candidate(ConnectionCandidate::Local {
                    port,
                    reachable: false,
                }),
                Answer::Action(PanelAction::SyncedTables),
                Answer::Tables(vec!["todos".to_owned()]),
                Answer::Confirm(true),
                Answer::Action(PanelAction::Exit),
            ],
            &present,
        );

        assert_eq!(run.code, OK, "{}", run.capture.stderr());
        assert!(
            run.capture
                .stderr()
                .contains("kizunasync sync: managing the synced tables")
        );
        assert_eq!(run.pushes, [PushTarget::Local]);
    }

    /// Once the ledger proves the pack is installed, `kizunasync._config` must
    /// answer: a failing read stops the flow instead of being taken for
    /// "nothing is synced".
    #[test]
    fn a_config_table_that_cannot_be_read_stops_before_asking_anything() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let run = run_with_config(
            dir.path(),
            &env_with_db(),
            Vec::new(),
            &present,
            &unreadable_config,
        );

        assert_eq!(run.code, UNUSABLE);
        assert!(
            run.capture
                .stderr()
                .contains("could not read the synced tables")
        );
        assert_eq!(run.confirms(), Vec::<String>::new());
    }

    // MARK: - declining, and asking only once

    #[test]
    fn declining_writes_nothing_and_points_at_the_commands() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let run = run_in(
            dir.path(),
            &env_with_db(),
            vec![Answer::Confirm(false)],
            &absent,
        );

        assert_eq!(run.code, OK);
        assert!(run.capture.stderr().contains("kizunasync init"));
        assert!(run.capture.stderr().contains("kizunasync --help"));
        assert_eq!(migrations(dir.path()), Vec::<String>::new());
    }

    /// The process ladder decides without a question, and says which rung it
    /// took.
    #[test]
    fn a_connection_on_the_environment_is_used_without_asking() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let run = run_in(
            dir.path(),
            &env_with_db(),
            vec![Answer::Confirm(false)],
            &absent,
        );

        assert_eq!(
            run.times_asked(&Ask::Candidate {
                candidates: Vec::new(),
                current: None,
            }),
            0
        );
        assert!(run.capture.stderr().contains("env:KSYNC_DB_URL"));
    }

    /// Nothing discoverable: the picker asks, and the connection it settles is
    /// carried into `init`, which must not ask for it a second time.
    #[test]
    fn the_picker_answer_is_carried_into_the_hand_off_and_never_asked_twice() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let mut answers = vec![
            Answer::Candidate(ConnectionCandidate::Manual),
            Answer::DbUrl(ENV_DB_URL.to_owned()),
            Answer::Confirm(true),
        ];
        answers.extend(init_wizard_answers());
        let run = run_in(dir.path(), &env_without_db(), answers, &absent);

        assert_eq!(run.code, OK);
        assert_eq!(
            run.times_asked(&Ask::Candidate {
                candidates: Vec::new(),
                current: None,
            }),
            1
        );
        assert_eq!(run.times_asked(&Ask::DbUrl { current: None }), 1);
        assert!(
            migrations(dir.path())
                .iter()
                .any(|name| name.ends_with("_kizunasync_config.sql"))
        );
    }

    // MARK: - the two ways the look-up fails

    /// 2f: a database that does not answer stops the flow exactly where `init`
    /// stops, with the message `init` prints.
    #[test]
    fn an_unreachable_database_stops_with_inits_own_message() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let run = run_with_schemas(
            dir.path(),
            &env_with_db(),
            Vec::new(),
            &absent,
            &FakeSchemas::failing_probe("connection refused"),
        );

        assert_eq!(run.code, UNUSABLE);
        assert!(
            run.capture
                .stderr()
                .contains("could not connect to the database")
        );
        assert!(run.capture.stderr().contains("connection refused"));
    }

    // MARK: - a project selection cannot serve the sync wizard

    /// The project the user picked answers over the Management API only, so
    /// the flow says why and offers the direct connections: the account and
    /// the linked project are not among them, and the ledger read over the
    /// Management API stands.
    #[test]
    fn a_project_selection_is_told_why_and_offered_the_direct_connections() {
        let dir = tempfile::tempdir().unwrap();
        let reads = std::cell::Cell::new(0_usize);
        let counted = |connection: &WizardConnection| {
            reads.set(reads.get() + 1);

            present(connection)
        };
        let run = run_in(
            dir.path(),
            &env_without_db(),
            with_linked_project(
                dir.path(),
                vec![
                    Answer::Action(PanelAction::SyncedTables),
                    Answer::Candidate(env_url_candidate()),
                ],
            )
            .into_iter()
            .chain(sync_wizard_answers())
            .chain([Answer::Action(PanelAction::Exit)])
            .collect(),
            &counted,
        );
        let offered = run.candidate_lists();

        assert_eq!(run.code, OK);
        assert_eq!(
            reads.get(),
            1,
            "the ledger read over the Management API stands: the direct connection does not re-check it"
        );
        assert_eq!(
            limitation_notes(&run),
            [SYNC_NEEDS_POSTGRES.to_owned()],
            "the limitation is stated before the second picker"
        );
        assert!(run.capture.stderr().contains(&format!(
            "linked project {LINKED_REF}: no Supabase access token; choose another connection"
        )));
        assert_eq!(offered.len(), 2, "the picker ran once, then once filtered");
        assert!(offered[0].contains(&ConnectionCandidate::Account));
        assert!(
            offered[0]
                .iter()
                .any(|candidate| matches!(candidate, ConnectionCandidate::LinkedProject { .. }))
        );
        assert_eq!(
            offered[1],
            vec![env_url_candidate(), ConnectionCandidate::Manual],
            "only direct candidates are offered the second time"
        );
        assert!(
            run.capture
                .stderr()
                .contains("kizunasync sync: managing the synced tables")
        );
        // neither the token that got here nor the URL's password is echoed.
        assert!(!run.capture.stderr().contains(WIZARD_PAT));
        assert!(!run.capture.stderr().contains(ENV_FILE_PASSWORD));
        assert!(!run.capture.stdout().contains(ENV_FILE_PASSWORD));
    }

    /// The fallback picker tests its pick like every other connection: a failed
    /// test that asks for another offers the same direct list again.
    #[test]
    fn a_failed_test_in_the_sync_fallback_picker_offers_the_list_again() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_with_schemas(
            dir.path(),
            &env_without_db(),
            with_linked_project(
                dir.path(),
                vec![
                    Answer::Action(PanelAction::SyncedTables),
                    Answer::Candidate(env_url_candidate()),
                    Answer::Confirm(true),
                    Answer::Confirm(true),
                    Answer::Candidate(env_url_candidate()),
                ],
            )
            .into_iter()
            .chain(sync_wizard_answers())
            .chain([Answer::Action(PanelAction::Exit)])
            .collect(),
            &present,
            &FakeSchemas::failing_first_probe("connection refused"),
        );
        let offered = run.candidate_lists();

        assert_eq!(run.code, OK, "{}", run.capture.stderr());
        assert_eq!(
            offered.len(),
            3,
            "the first picker, then the fallback twice"
        );
        assert_eq!(offered[1], offered[2]);
        assert_eq!(
            offered[2],
            vec![env_url_candidate(), ConnectionCandidate::Manual]
        );
        assert!(
            run.confirms()
                .contains(&"Pick another connection?".to_owned())
        );
        assert!(
            run.capture
                .stderr()
                .contains("could not connect to the database:\n    connection refused")
        );
        assert_eq!(run.pushes, [PushTarget::DbUrl(ENV_FILE_URL.to_owned())]);
    }

    /// The linked project carries its own direct connection, opened with the
    /// token that reached it, so the hand-off asks nothing more.
    #[test]
    fn the_linked_project_hands_off_to_sync_over_its_temporary_login() {
        let dir = tempfile::tempdir().unwrap();
        let asked = std::cell::RefCell::new(Vec::new());
        let linked = |project_ref: &ProjectRef, token: Option<&str>| {
            asked
                .borrow_mut()
                .push((project_ref.to_string(), token.map(ToOwned::to_owned)));

            Ok(crate::login_role::LinkedConnection {
                url: format!(
                    "postgresql://cli_login_postgres.{project_ref}:m1nt3d@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require"
                ),
                route: crate::login_role::LinkedRoute::Pooler,
                minted: true,
            })
        };
        // No `.env` confirm this time: the sync wizard's table set and write
        // confirm follow the linked project's own two questions directly.
        let answers = with_linked_project(
            dir.path(),
            vec![
                Answer::Action(PanelAction::SyncedTables),
                Answer::Tables(vec!["todos".to_owned()]),
                Answer::Confirm(true),
                Answer::Action(PanelAction::Exit),
            ],
        );
        let (mut ui, capture) = Ui::capture();
        let mut scripted = ScriptedPrompter::new(answers);
        let cli = RecordingCli::new();
        let env_files = crate::env_file::load(dir.path());
        let database = Rc::new(fixtures::database(Ledger::Current, Synced::TodosAndNotes));
        let open = fixtures::opener(&database);
        let code = run(
            dir.path(),
            &ProjectPaths::rooted_at(dir.path().to_path_buf()),
            &env_without_db(),
            &env_files,
            SmartPorts {
                init: InitPorts {
                    prompter: Some(&mut scripted as &mut dyn Prompter),
                    schemas: &FakeSchemas::ok(),
                    supabase: &cli,
                    now_unix: FIXED_NOW,
                    tokens: &crate::token::NoTokenStore,
                    list_projects: &unreachable_projects,
                    browser_login: &|| {
                        Err(crate::error::Error::Cli("no browser in tests".to_owned()))
                    },
                    probe_remote: &remote_facts_ok,
                },
                ledger: &present,
                config: &synced,
                linked: &linked,
                panel: PanelPorts {
                    open: &open,
                    doctor: DoctorPorts {
                        env_files: &env_files,
                        data_api: &NoDataApi,
                        management: None,
                    },
                    clock: &fixed_clock,
                },
            },
            &mut ui,
        );
        let run = SmartRun {
            code,
            capture,
            prompter: scripted,
            pushes: cli.pushes.take(),
        };

        assert_eq!(run.code, OK, "{}", run.capture.stderr());
        assert_eq!(
            run.pushes,
            [PushTarget::Linked],
            "the temporary login is read-only: the delta goes through --linked"
        );
        assert!(
            run.capture
                .stderr()
                .contains("applied via supabase db push --linked")
        );
        assert_eq!(
            asked.borrow().as_slice(),
            [(LINKED_REF.to_owned(), Some(WIZARD_PAT.to_owned()))]
        );
        assert_eq!(run.candidate_lists().len(), 1, "no second picker");
        assert_eq!(limitation_notes(&run), Vec::<String>::new());
        assert!(
            run.capture
                .stderr()
                .contains(&format!("(linked project {LINKED_REF}, session pooler)"))
        );
        assert!(!run.capture.stderr().contains("m1nt3d"));
        assert!(!run.capture.stderr().contains(WIZARD_PAT));
    }

    #[test]
    fn declining_the_direct_connection_points_at_sync_with_a_db_url() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_in(
            dir.path(),
            &env_without_db(),
            with_linked_project(
                dir.path(),
                vec![
                    Answer::Action(PanelAction::SyncedTables),
                    Answer::Candidate(env_url_candidate()),
                    Answer::Confirm(false),
                    Answer::Action(PanelAction::Exit),
                ],
            ),
            &present,
        );

        assert_eq!(run.code, OK);
        assert!(run.capture.stderr().contains("kizunasync sync --db-url"));
        assert!(
            run.capture
                .stderr()
                .contains("https://kizunasync.com/docs/cli")
        );
        assert_eq!(migrations(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn a_ledger_that_cannot_be_read_stops_before_asking_anything() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let run = run_in(dir.path(), &env_with_db(), Vec::new(), &unreadable);

        assert_eq!(run.code, UNUSABLE);
        assert!(
            run.capture
                .stderr()
                .contains("could not read the Kizuna ledger")
        );
        assert!(run.capture.stderr().contains("permission denied"));
        assert_eq!(run.confirms(), Vec::<String>::new());
    }

    // MARK: - the control panel

    /// An installed database opens the panel, and Exit ends the bare run on
    /// zero with nothing written.
    #[test]
    fn an_installed_database_opens_the_control_panel() {
        let dir = tempfile::tempdir().unwrap();
        provisioned_project(dir.path());
        let run = run_in(
            dir.path(),
            &env_with_db(),
            vec![Answer::Action(PanelAction::Exit)],
            &present,
        );

        assert_eq!(run.code, OK);
        assert_eq!(run.menus(), 1);
        assert_eq!(run.confirms(), Vec::<String>::new());
        assert_eq!(migrations(dir.path()), Vec::<String>::new());
    }

    /// Ctrl+C at the bare flow's first questions closes the chrome and exits
    /// `0` with nothing written, on the picker and on the install question.
    #[test]
    fn ctrl_c_in_the_bare_flow_closes_it_with_its_cancel_outro() {
        for answers in [
            vec![Answer::Cancel],
            vec![
                Answer::Candidate(ConnectionCandidate::Manual),
                Answer::DbUrl(ENV_DB_URL.to_owned()),
                Answer::Cancel,
            ],
        ] {
            let dir = tempfile::tempdir().unwrap();
            project(dir.path());
            let run = run_in(dir.path(), &env_without_db(), answers, &absent);

            assert_eq!(run.code, OK, "{}", run.capture.stderr());
            assert_eq!(run.prompter.unused(), 0);
            assert_eq!(run.prompter.cancel_outros(), ["Nothing written."]);
            assert_eq!(migrations(dir.path()), Vec::<String>::new());
        }
    }

    /// Every connection string the masked prompt was opened on, in order.
    fn db_url_openings(run: &SmartRun) -> Vec<Option<String>> {
        run.prompter
            .asked()
            .iter()
            .filter_map(|ask| match ask {
                Ask::DbUrl { current } => Some(current.clone()),
                _ => None,
            })
            .collect()
    }

    /// Backspace on the panel's menu reopens the connection question right
    /// before it, the masked prompt, on the string it settled; an empty
    /// answer keeps it.
    #[test]
    fn backspace_on_the_panel_reopens_the_connection_string_it_settled_on() {
        let dir = tempfile::tempdir().unwrap();
        provisioned_project(dir.path());
        let run = run_in(
            dir.path(),
            &env_without_db(),
            vec![
                Answer::Candidate(ConnectionCandidate::Manual),
                Answer::DbUrl(ENV_DB_URL.to_owned()),
                Answer::Back,
                Answer::DbUrl(String::new()),
                Answer::Action(PanelAction::Exit),
            ],
            &present,
        );

        assert_eq!(run.code, OK, "{}", run.capture.stderr());
        assert_eq!(run.prompter.unused(), 0);
        assert_eq!(run.candidate_lists().len(), 1);
        assert_eq!(db_url_openings(&run), [None, Some(ENV_DB_URL.to_owned())]);
        assert_eq!(run.menus(), 2);
    }

    /// Backspace on the install question does the same: the connection string
    /// comes back on the one entered, and the install carries on from it.
    #[test]
    fn backspace_on_the_install_question_reopens_the_connection_string_it_settled_on() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path());
        let mut answers = vec![
            Answer::Candidate(ConnectionCandidate::Manual),
            Answer::DbUrl(ENV_DB_URL.to_owned()),
            Answer::Back,
            Answer::DbUrl(String::new()),
            Answer::Confirm(true),
        ];
        answers.extend(init_wizard_answers());
        let run = run_in(dir.path(), &env_without_db(), answers, &absent);

        assert_eq!(run.code, OK, "{}", run.capture.stderr());
        assert_eq!(run.prompter.unused(), 0);
        assert_eq!(run.candidate_lists().len(), 1);
        assert_eq!(db_url_openings(&run), [None, Some(ENV_DB_URL.to_owned())]);
        assert_eq!(
            run.confirms().first().map(String::as_str),
            Some(INSTALL_HERE)
        );
    }

    /// Backspace on the masked prompt reopens the picker on the row that led
    /// to it.
    #[test]
    fn backspace_on_the_connection_string_reopens_the_picker_on_that_row() {
        let dir = tempfile::tempdir().unwrap();
        provisioned_project(dir.path());
        let run = run_in(
            dir.path(),
            &env_without_db(),
            vec![
                Answer::Candidate(ConnectionCandidate::Manual),
                Answer::Back,
                Answer::Candidate(ConnectionCandidate::Manual),
                Answer::DbUrl(ENV_DB_URL.to_owned()),
                Answer::Action(PanelAction::Exit),
            ],
            &present,
        );
        let openings: Vec<Option<ConnectionCandidate>> = run
            .prompter
            .asked()
            .iter()
            .filter_map(|ask| match ask {
                Ask::Candidate { current, .. } => Some(current.clone()),
                _ => None,
            })
            .collect();

        assert_eq!(run.code, OK, "{}", run.capture.stderr());
        assert_eq!(run.prompter.unused(), 0);
        assert_eq!(openings, [None, Some(ConnectionCandidate::Manual)]);
    }

    /// Once the panel applied a sync, Backspace on its menu does nothing: the
    /// connection is a step before an applied operation.
    #[test]
    fn backspace_on_the_panel_after_an_applied_sync_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        provisioned_project(dir.path());
        let run = run_in(
            dir.path(),
            &env_without_db(),
            vec![
                Answer::Candidate(ConnectionCandidate::Manual),
                Answer::DbUrl(ENV_DB_URL.to_owned()),
                Answer::Action(PanelAction::SyncedTables),
                Answer::Tables(vec!["todos".to_owned()]),
                Answer::Confirm(true),
                Answer::Back,
                Answer::Action(PanelAction::Exit),
            ],
            &present,
        );

        assert_eq!(run.code, OK, "{}", run.capture.stderr());
        assert_eq!(run.prompter.unused(), 0);
        assert_eq!(db_url_openings(&run), [None]);
        assert_eq!(run.menus(), 2);
    }

    /// What Backspace did on every panel menu the run drew.
    fn menu_backs(run: &SmartRun) -> Vec<crate::prompts::BackKey> {
        run.prompter
            .asked()
            .iter()
            .filter_map(|ask| match ask {
                Ask::Action { back, .. } => Some(*back),
                _ => None,
            })
            .collect()
    }

    /// The environment chose the connection and no picker was shown, so no
    /// step lies behind the panel: Backspace on its menu does nothing, and the
    /// menu's key line leaves it out.
    #[test]
    fn with_the_connection_from_the_environment_backspace_on_the_panel_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        provisioned_project(dir.path());
        let run = run_in(
            dir.path(),
            &env_with_db(),
            vec![Answer::Back, Answer::Action(PanelAction::Exit)],
            &present,
        );

        assert_eq!(run.code, OK, "{}", run.capture.stderr());
        assert_eq!(run.prompter.unused(), 0);
        assert_eq!(menu_backs(&run), [crate::prompts::BackKey::Ignored]);
    }

    /// A removal that empties the ledger closes the panel, and the bare flow
    /// carries on as it does for a database with nothing installed: the fresh
    /// install question, then `init`'s wizard over the same connection.
    #[test]
    fn a_removal_in_the_panel_continues_on_the_install_path() {
        let dir = tempfile::tempdir().unwrap();
        provisioned_project(dir.path());
        let removed = fixtures::database(Ledger::Current, Synced::TodosAndNotes).then(
            "-- Generated by `kizunasync deprovision",
            fixtures::database(Ledger::Empty, Synced::Nothing),
        );
        let mut answers = vec![
            Answer::Action(PanelAction::RemoveKizuna),
            Answer::Typed("local".to_owned()),
            Answer::Confirm(false),
            Answer::Confirm(true),
        ];
        answers.extend(init_wizard_answers());
        let run = run_with(
            dir.path(),
            &env_with_db(),
            answers,
            &present,
            &nothing_synced,
            &FakeSchemas::ok(),
            &no_linked,
            removed,
        );

        assert_eq!(run.code, OK, "{}", run.capture.stderr());
        assert_eq!(run.prompter.unused(), 0);
        assert_eq!(run.menus(), 1);
        assert_eq!(run.confirms()[1], FRESH_INSTALL);
        assert!(
            run.capture
                .stderr()
                .contains("provisioning Kizuna into this project")
        );
    }

    // MARK: - the panel opener

    /// An environment token that is not one is dropped with the CLI's own
    /// one-line warning, and only where a hosted target would have used it.
    #[test]
    fn the_panel_opener_warns_once_about_an_environment_token_it_drops() {
        let dir = tempfile::tempdir().unwrap();
        let paths = ProjectPaths::rooted_at(dir.path().to_path_buf());
        let env = Env::from_pairs(&[("SUPABASE_ACCESS_TOKEN", "eyJhbGciOiJIUzI1NiJ9.e30.x")]);
        let env_files = crate::env_file::load(dir.path());
        let direct = |url: &str| {
            WizardConnection::Direct(DirectConnection {
                url: url.to_owned(),
                push: PushTarget::DbUrl(url.to_owned()),
            })
        };
        for (connection, warned) in [
            (
                direct(
                    "postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
                ),
                true,
            ),
            (
                direct("postgresql://postgres:pw@127.0.0.1:54322/postgres"),
                false,
            ),
        ] {
            let opened = open_panel(&connection, &paths, &env, &env_files).unwrap();

            assert!(opened.exposure.is_none());
            assert_eq!(
                opened
                    .warning
                    .as_deref()
                    .is_some_and(|warning| warning
                        .starts_with("  that is not a Personal Access Token (sbp_…)")),
                warned,
                "{:?}",
                opened.warning
            );
        }
    }
}
