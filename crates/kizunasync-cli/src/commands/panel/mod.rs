//! The control panel bare `kizunasync` opens on a database that has Kizuna
//! installed.
//!
//! Each round reads the project over the connection the picker settled, draws
//! a header from that read, and offers a menu. Every item runs the command
//! module its subcommand runs, over the same connection, then prints the
//! one-shot command that does the same thing and reads the project again. An
//! item that was cancelled or backed out of ran nothing, so it prints none.
//! The menu reopens on the item chosen last. Backspace on the menu returns to
//! the connection question before it until an item applies a change; from
//! then on no step lies behind the menu, so Backspace there does nothing and
//! its key legend leaves it out. The same holds from the start when the
//! environment chose the connection with no question. Ctrl+C at any question
//! closes the panel with exit `0`.
//!
//! A round whose ledger records nothing, which is what a removal leaves,
//! closes the panel: the bare flow carries on down its install path for that
//! database. A pack a newer kizunasync recorded leaves the items that only
//! read, the way every writing command refuses such a ledger. A pack that
//! differs from this CLI's opens every menu on "Update the pack", and each
//! item that writes passes the pack gate first. Once a re-apply fails over
//! tables an earlier build of the pack created, the menus of a direct
//! connection open on "Remove Kizuna" instead (@docs/cli/cli.md).

use std::cell::Cell;
use std::path::Path;

use crate::applier::Applier;
use crate::commands::doctor::DoctorPorts;
use crate::commands::init::{InitFlags, InitPorts, STEP_BACK, WizardConnection, stop_for};
use crate::commands::smart::{self, SmartPorts};
use crate::commands::status::{StatusReport, build_report};
use crate::commands::{OK, UNUSABLE};
use crate::db::split_db_url_password;
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::pack::{read_pack_files, resolve_pack_dir};
use crate::prompts::{BackKey, PromptError, Prompter};
use crate::provision::{LedgerRow, Plan, plan_provision, read_ledger_rows};
use crate::supabase_cli::PushTarget;
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

mod actions;
pub(crate) mod equivalent;
mod lent;
mod menu;
mod state;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
pub(crate) mod fixtures;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

pub use menu::{PanelAction, PanelItem};

use actions::Outcome;
use lent::Lent;
use menu::{MENU_MESSAGE, panel_menu};
use state::{PackState, PanelReads, PanelState, Transport, header};

// MARK: - ports

/// Opens the applier every panel action reads and writes through.
pub type Opener<'a> = dyn Fn(&WizardConnection) -> crate::error::Result<Box<dyn Applier>> + 'a;

/// What the panel reaches beyond the bare flow's own ports.
pub struct PanelPorts<'a> {
    /// The applier over the transport the connection names. Production
    /// opens Postgres or the Management API; a test answers from a fixture.
    pub open: &'a Opener<'a>,
    /// What the health check reaches beyond the database.
    pub doctor: DoctorPorts<'a>,
    /// The current instant in UTC epoch seconds, read at every round for the
    /// header's ages and the name of the next migration.
    pub clock: &'a dyn Fn() -> i64,
}

/// Where the panel runs.
pub struct PanelContext<'a> {
    /// The directory the command runs against.
    pub cwd: &'a Path,
    /// The resolved project root and the paths under it.
    pub paths: &'a ProjectPaths,
    /// The environment the commands consult.
    pub env: &'a Env,
    /// What the project's `.env` files declare.
    pub env_files: &'a EnvFileValues,
    /// The flags the install path runs with while no table is synced.
    pub flags: &'a InitFlags,
    /// What Backspace on the menu does before an item applies a change:
    /// [`BackKey::Honoured`] reopens the connection question a picker
    /// settled, and [`BackKey::Ignored`] is a connection the environment chose
    /// with no question, so no step lies behind the menu.
    pub menu_back: BackKey,
}

/// One round of the panel: the connection, what was read over it, and where
/// it runs.
pub(crate) struct Panel<'p> {
    connection: &'p WizardConnection,
    context: &'p PanelContext<'p>,
    applier: &'p dyn Applier,
    state: PanelState,
    report: StatusReport,
    /// The ledger rows the round read.
    rows: Vec<LedgerRow>,
    /// This CLI's pack planned against `rows`, `None` without a pack on disk.
    plan: Option<Plan>,
}

/// What closes the panel.
enum Ending {
    /// The Exit item.
    Exit,
    /// A cancelled question.
    Cancelled,
    /// Backspace on the menu before any item applied a change: back to the
    /// connection question.
    Back,
    /// The ledger records nothing: the database reads as not installed.
    NotInstalled,
    /// A failure that stops the run on this exit code.
    Code(i32),
}

/// The line that closes the panel.
const PANEL_CLOSED: &str = "Control panel closed.";

// MARK: - run

/// Open the panel on `connection` and run it until the user leaves.
/// [`STEP_BACK`] asks the caller for the connection picker again. A ledger that
/// records nothing closes the panel onto the bare flow's install path, whose
/// exit code this returns.
pub(crate) fn run(
    connection: &WizardConnection,
    context: &PanelContext<'_>,
    ports: &mut SmartPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let applier = match (ports.panel.open)(connection) {
        Ok(applier) => applier,
        Err(cause) => {
            ui.error(&format!(
                "  {}",
                smart::redacted(connection, &cause.to_string())
            ));

            return UNUSABLE;
        }
    };
    let Some(inner) = ports.init.prompter.take() else {
        return stop_for(&PromptError::NotInteractive, ui);
    };
    let cancelled = Cell::new(false);
    let mut lent = Lent::new(inner, &cancelled);
    let ending = {
        let mut lent_ports = lend(ports, &mut lent);
        drive(
            connection,
            context,
            applier.as_ref(),
            &mut lent_ports,
            &cancelled,
            ui,
        )
    };
    let inner = lent.into_inner();
    // The closing chrome only decorates an exit already decided.
    let code = match ending {
        Ending::Exit => {
            let _ = inner.outro(PANEL_CLOSED);

            OK
        }
        Ending::Cancelled => {
            let _ = inner.outro_cancel(PANEL_CLOSED);

            OK
        }
        Ending::Back => STEP_BACK,
        Ending::NotInstalled => {
            ports.init.prompter = Some(inner);

            return smart::install_fresh(
                connection,
                context.flags,
                context.cwd,
                context.paths,
                context.env,
                ports,
                ui,
            );
        }
        Ending::Code(code) => code,
    };
    ports.init.prompter = Some(inner);

    code
}

/// The rounds: read, draw, ask, act, and print the equivalent command.
fn drive(
    connection: &WizardConnection,
    context: &PanelContext<'_>,
    applier: &dyn Applier,
    ports: &mut SmartPorts<'_>,
    cancelled: &Cell<bool>,
    ui: &mut Ui,
) -> Ending {
    let (title, transport) = describe(connection);
    let mut last = None;
    let mut back = context.menu_back;
    let mut earlier_build = false;
    loop {
        let now = (ports.panel.clock)();
        ports.init.now_unix = now;
        let panel = match read_round(connection, context, applier, &title, transport, now) {
            Ok(panel) => panel,
            Err(cause) => {
                ui.error(&format!(
                    "  could not read the project: {}",
                    smart::redacted(connection, &cause.to_string())
                ));

                return Ending::Code(UNUSABLE);
            }
        };
        if panel.state.pack == PackState::NotInstalled {
            return Ending::NotInstalled;
        }
        let Some(prompter) = ports.init.prompter.as_deref_mut() else {
            return Ending::Code(stop_for(&PromptError::NotInteractive, ui));
        };
        let (heading, body) = header(&panel.state, crate::wizard_theme::columns());
        let round = crate::wizard_theme::mark();
        let opened_on = match (panel.state.pack.differs(), earlier_build) {
            (true, true) => Some(PanelAction::RemoveKizuna),
            (true, false) => Some(PanelAction::UpdatePack),
            (false, _) => last,
        };
        let chosen = prompter.note(&heading, &body).and_then(|()| {
            prompter.select_action(MENU_MESSAGE, &panel_menu(&panel.state), opened_on, back)
        });
        let action = match chosen {
            Ok(action) => action,
            // A backend that answers Back where it was told to ignore it still
            // never reaches a step before the panel.
            Err(PromptError::Back) if back == BackKey::Ignored => {
                crate::wizard_theme::rewind(round);
                continue;
            }
            Err(PromptError::Back) => return Ending::Back,
            Err(PromptError::Cancelled) => return Ending::Cancelled,
            Err(error) => return Ending::Code(stop_for(&error, ui)),
        };
        last = Some(action);

        let mut outcome = actions::perform(&panel, action, ports, ui);
        while let Outcome::Reapplied(then) = outcome {
            back = BackKey::Ignored;
            outcome = *then;
        }
        if cancelled.get() {
            return Ending::Cancelled;
        }
        match outcome {
            Outcome::Applied(args) => {
                back = BackKey::Ignored;
                print_equivalent(connection, &args, ui);
            }
            Outcome::Ran(args) => print_equivalent(connection, &args, ui),
            // Remove Kizuna needs a direct connection, so a Management API
            // panel keeps opening on Update the pack.
            Outcome::EarlierBuild => earlier_build = transport == Transport::Direct,
            Outcome::Nothing | Outcome::Reapplied(_) => {}
            Outcome::Exit => return Ending::Exit,
            Outcome::Cancelled => return Ending::Cancelled,
            Outcome::Stop(code) => return Ending::Code(code),
        }
    }
}

/// The one-shot command an action that ran stands for.
fn print_equivalent(connection: &WizardConnection, args: &[String], ui: &mut Ui) {
    ui.log(&format!(
        "\n  Equivalent command:\n    {}",
        equivalent::render(connection, args)
    ));
}

/// Read the project for one round: the status report, the ledger rows, and
/// the plan against this CLI's pack.
fn read_round<'p>(
    connection: &'p WizardConnection,
    context: &'p PanelContext<'p>,
    applier: &'p dyn Applier,
    title: &str,
    transport: Transport,
    now_unix: i64,
) -> crate::error::Result<Panel<'p>> {
    let report = build_report(applier, context.paths, context.env)?;
    let rows = read_ledger_rows(applier)?;
    let plan = match resolve_pack_dir(context.env) {
        Some(pack_dir) => Some(plan_provision(&read_pack_files(&pack_dir)?, &rows)),
        None => None,
    };
    let state = PanelState::from_reads(&PanelReads {
        title: title.to_owned(),
        transport,
        report: &report,
        rows: &rows,
        plan: plan.as_ref(),
        has_migrations: context.paths.migrations_dir.is_dir(),
        now_unix,
    });

    Ok(Panel {
        connection,
        context,
        applier,
        state,
        report,
        rows,
        plan,
    })
}

/// The connection as the header names it, and how it reaches the database.
fn describe(connection: &WizardConnection) -> (String, Transport) {
    match connection {
        WizardConnection::Direct(direct) => {
            let title = match &direct.push {
                PushTarget::Local => "local stack".to_owned(),
                PushTarget::Linked => "linked project".to_owned(),
                PushTarget::DbUrl(_) => split_db_url_password(&direct.url).0,
            };

            (title, Transport::Direct)
        }
        WizardConnection::Remote { project_ref, .. } => (
            format!("project {project_ref} · Management API"),
            Transport::ManagementApi,
        ),
    }
}

/// The bare flow's ports with `prompter` in place of its own, for as long as
/// the panel is open.
fn lend<'x>(ports: &'x SmartPorts<'_>, prompter: &'x mut dyn Prompter) -> SmartPorts<'x> {
    SmartPorts {
        init: InitPorts {
            prompter: Some(prompter),
            schemas: ports.init.schemas,
            supabase: ports.init.supabase,
            now_unix: ports.init.now_unix,
            tokens: ports.init.tokens,
            list_projects: ports.init.list_projects,
            browser_login: ports.init.browser_login,
            probe_remote: ports.init.probe_remote,
        },
        ledger: ports.ledger,
        config: ports.config,
        linked: ports.linked,
        panel: PanelPorts {
            open: ports.panel.open,
            doctor: DoctorPorts {
                env_files: ports.panel.doctor.env_files,
                data_api: ports.panel.doctor.data_api,
                management: ports.panel.doctor.management,
            },
            clock: ports.panel.clock,
        },
    }
}
