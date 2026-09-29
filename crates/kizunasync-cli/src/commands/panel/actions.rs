//! What each panel item runs. Every action calls the command module the
//! matching subcommand calls, over the connection the panel opened, and asks
//! the panel's own confirmation before a command that writes runs with `yes`.

use crate::commands::deprovision::{self, DeprovisionRequest};
use crate::commands::doctor::{self, DoctorFlags};
use crate::commands::init::{DirectConnection, STEP_BACK, WizardConnection, stop_for};
use crate::commands::jobs::{self, Job, JobsAction, JobsFlags};
use crate::commands::reconcile::{Gated, PackGate, ReapplyVia, gate_pack};
use crate::commands::smart::{self, SmartPorts};
use crate::commands::sync::{self, SettingsOptions, SyncFlags, SyncPorts};
use crate::commands::upgrade::{self, ApplyEnd, UpgradeFlags};
use crate::commands::{OK, lint, status};
use crate::config::{ProjectSettings, load_config_from_db};
use crate::config_sql::SYNCED_TABLE_SCHEMA;
use crate::prompts::{self, BackKey, PromptError, Prompter, RetentionJobs};
use crate::proposals::SchemaCatalog;
use crate::provision::plan_provision;
use crate::ui::Ui;
use crate::wizard::{Ladder, Reached};

use super::Panel;
use super::equivalent::Reach;
use super::menu::{JOB_MESSAGE, JOBS_MESSAGE, NEEDS_DIRECT, PanelAction, job_menu, jobs_menu};
use super::state::JobsSummary;

/// Where an action left the panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// It ran `kizunasync` with these arguments and changed nothing, whatever
    /// that ended on.
    Ran(Vec<String>),
    /// It applied a change with these arguments, so Backspace never reaches a
    /// step before the panel again.
    Applied(Vec<String>),
    /// Nothing ran: the user declined or went back, or the item cannot run
    /// over this connection.
    Nothing,
    /// The user closed the panel.
    Exit,
    /// A question was cancelled, which closes the panel.
    Cancelled,
    /// A question could not be asked: the panel stops on this exit code.
    Stop(i32),
    /// The pack gate re-applied the pack before the item, which then ended
    /// on the outcome inside.
    Reapplied(Box<Outcome>),
    /// The database refused a re-apply over tables an earlier build of the
    /// pack created: nothing was applied, and the next step is on the `Ui`.
    EarlierBuild,
}

/// An action's result: `Err` is the outcome an early question ended it on.
type Acted = Result<Outcome, Outcome>;

/// A nested step's result: `Ok(None)` is Backspace, which reopens the
/// question before it.
type Stepped = Result<Option<Outcome>, Outcome>;

const PURGE_QUESTION: &str = "Also drop the kizunasync schema and every bookkeeping table (purge)?";

const NOTHING_CHANGED: &str =
    "  nothing to change: every value is the one the project already carries.";

const NO_TOMBSTONE_FLAG: &str = "  `kizunasync sync` has no flag for the project tombstone retention, so the command below leaves that value out.";

/// Run `action`.
pub(crate) fn perform(
    panel: &Panel<'_>,
    action: PanelAction,
    ports: &mut SmartPorts<'_>,
    ui: &mut Ui,
) -> Outcome {
    let acted = match action {
        PanelAction::SyncedTables => Ok(edit_synced_tables(panel, ports, ui)),
        PanelAction::ProjectSettings => edit_settings(panel, ports, ui),
        PanelAction::UpdatePack => update_pack(panel, ports, ui),
        PanelAction::HealthCheck => Ok(health_check(panel, ports, ui)),
        PanelAction::Status => show_status(panel, ports, ui),
        PanelAction::BackgroundJobs => background_jobs(panel, ports, ui),
        PanelAction::PendingMigrations => {
            lint::run(panel.applier, panel.context.paths, ui);

            Ok(ran(&["lint"]))
        }
        PanelAction::RemoveKizuna => remove(panel, ports, ui),
        PanelAction::Exit => Ok(Outcome::Exit),
        PanelAction::ListJobs => list_jobs(panel, ui),
        PanelAction::RunJobNow => pick_job(panel, ports, ui).map(settled),
        PanelAction::RescheduleJobs => reschedule_jobs(panel, ports, ui).map(settled),
        PanelAction::RunJob(job) => run_job(panel, job, ports, ui).map(settled),
    };

    acted.unwrap_or_else(|ended| ended)
}

/// A nested step reached from the panel itself: Backspace on it returns to
/// the panel.
fn settled(stepped: Option<Outcome>) -> Outcome {
    stepped.unwrap_or(Outcome::Nothing)
}

fn ran(args: &[&str]) -> Outcome {
    Outcome::Ran(args.iter().map(|arg| (*arg).to_owned()).collect())
}

fn applied(args: &[&str]) -> Outcome {
    Outcome::Applied(args.iter().map(|arg| (*arg).to_owned()).collect())
}

/// The prompter the panel asks through, or the stop a missing one means.
fn lent_prompter<'p>(
    ports: &'p mut SmartPorts<'_>,
    ui: &mut Ui,
) -> Result<&'p mut dyn Prompter, Outcome> {
    match ports.init.prompter.as_deref_mut() {
        Some(prompter) => Ok(prompter),
        None => Err(Outcome::Stop(stop_for(&PromptError::NotInteractive, ui))),
    }
}

/// A question's answer, or the outcome it ends the action on: Backspace goes
/// back to the panel, a cancel closes it, and anything else stops it.
fn answered<T>(asked: prompts::Result<T>, ui: &mut Ui) -> Result<T, Outcome> {
    stepped(asked, ui)?.ok_or(Outcome::Nothing)
}

/// A nested question's answer, `None` for Backspace, which reopens the
/// question before it; a cancel closes the panel, and anything else stops it.
fn stepped<T>(asked: prompts::Result<T>, ui: &mut Ui) -> Result<Option<T>, Outcome> {
    match asked {
        Ok(value) => Ok(Some(value)),
        Err(PromptError::Back) => Ok(None),
        Err(PromptError::Cancelled) => Err(Outcome::Cancelled),
        Err(error) => Err(Outcome::Stop(stop_for(&error, ui))),
    }
}

/// The direct connection an item needs, or `Nothing` once the reason it cannot
/// run over the Management API is on `ui`.
fn direct<'p>(panel: &'p Panel<'_>, ui: &mut Ui) -> Result<&'p DirectConnection, Outcome> {
    match panel.connection {
        WizardConnection::Direct(direct) => Ok(direct),
        WizardConnection::Remote { .. } => {
            ui.warn(&format!("  {NEEDS_DIRECT}."));

            Err(Outcome::Nothing)
        }
    }
}

/// The pack gate before an item that writes ([`gate_pack`]): `Ok(true)` once
/// the pack was re-applied and its command printed, `Ok(false)` when this
/// CLI's pack matches the ledger. `Err` ends the item back at the panel with
/// nothing written: No, Backspace, or a refusal whose reason is on `ui`, and
/// [`Outcome::EarlierBuild`] for a re-apply refused over an earlier build's
/// tables.
fn gate_first(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Result<bool, Outcome> {
    let via = match panel.connection {
        WizardConnection::Direct(_) => ReapplyVia::Connection,
        WizardConnection::Remote { .. } => ReapplyVia::ManagementApi,
    };
    let gate = PackGate {
        plan: panel.plan.as_ref(),
        rows: &panel.rows,
        applier: panel.applier,
        via,
        reach: Some(Reach::of(panel.connection)),
        allow_no_cron: false,
    };
    let mut prompter = Some(lent_prompter(ports, ui)?);
    match gate_pack(&gate, &mut prompter, ui) {
        Ok(Gated::Clear) => Ok(false),
        Ok(Gated::Reapply) => {
            super::print_equivalent(panel.connection, &REAPPLY_ARGS.map(str::to_owned), ui);

            Ok(true)
        }
        Ok(Gated::Declined) | Err(ApplyEnd::Exit(_)) => Err(Outcome::Nothing),
        Err(ApplyEnd::EarlierBuild) => Err(Outcome::EarlierBuild),
    }
}

/// `upgrade --reapply --yes`, the command a re-apply at the gate stands for.
const REAPPLY_ARGS: [&str; 3] = ["upgrade", "--reapply", "--yes"];

/// `outcome`, marked as following a re-apply when the gate ran one.
fn after_gate(reapplied: bool, outcome: Outcome) -> Outcome {
    if reapplied {
        return Outcome::Reapplied(Box::new(outcome));
    }

    outcome
}

// MARK: - synced tables and settings

/// The `sync` wizard over the panel's connection, or the install path while no
/// table is synced. Backspace on their first question returns to the panel.
/// The install path cannot say whether it wrote, so any ending other than
/// Backspace counts as applied.
fn edit_synced_tables(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Outcome {
    match gate_first(panel, ports, ui) {
        Ok(reapplied) => after_gate(reapplied, synced_tables_after_gate(panel, ports, ui)),
        Err(outcome) => outcome,
    }
}

fn synced_tables_after_gate(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Outcome {
    let context = panel.context;
    let (finished, command) = if panel.state.tables.is_empty() {
        let code = smart::install(
            smart::NOTHING_SYNCED,
            panel.connection,
            context.flags,
            context.cwd,
            context.paths,
            context.env,
            ports,
            ui,
        );

        (sync::Finished { code, wrote: true }, "init")
    } else {
        let finished = smart::hand_off_to_sync(
            panel.connection.clone(),
            context.paths,
            context.env,
            context.env_files,
            ports,
            ui,
        );

        (finished, "sync")
    };
    if finished.code == STEP_BACK {
        return Outcome::Nothing;
    }
    if finished.wrote {
        return applied(&[command]);
    }

    ran(&[command])
}

/// The wizard's maintenance, push-policy, and pg_cron steps over the settings
/// the project carries, then the delta `kizunasync sync` writes for them.
fn edit_settings(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Acted {
    let reapplied = gate_first(panel, ports, ui)?;
    let acted = settings_after_gate(panel, ports, ui);

    Ok(after_gate(reapplied, acted.unwrap_or_else(|ended| ended)))
}

fn settings_after_gate(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Acted {
    let live = match load_config_from_db(panel.applier) {
        Ok(config) => config.settings,
        Err(cause) => {
            ui.error(&format!(
                "  {}",
                smart::redacted(panel.connection, &cause.to_string())
            ));

            return Ok(Outcome::Nothing);
        }
    };
    let Some((changed, allow_no_cron)) = decide_settings(panel, live.as_ref(), ports, ui)? else {
        return Ok(Outcome::Nothing);
    };

    let options = SettingsOptions::from_declared(&changed);
    let mut args = vec!["sync".to_owned()];
    args.extend(options.to_sync_args());
    if allow_no_cron {
        args.push("--allow-no-cron".to_owned());
    }
    args.push("--yes".to_owned());
    write_settings(panel, options, allow_no_cron, ports, ui);
    if changed.tombstone_ttl_days.is_some() {
        ui.log(NO_TOMBSTONE_FLAG);
    }

    Ok(Outcome::Applied(args))
}

/// Walk the server sections until the user confirms a change. `None` when
/// every answer keeps what the project carries or the user declined.
fn decide_settings(
    panel: &Panel<'_>,
    live: Option<&ProjectSettings>,
    ports: &mut SmartPorts<'_>,
    ui: &mut Ui,
) -> Result<Option<(ProjectSettings, bool)>, Outcome> {
    let prompter = lent_prompter(ports, ui)?;
    let mut ladder = Ladder::settings_only(
        &live.cloned().unwrap_or_default(),
        retention_jobs(panel.state.jobs.as_ref()),
    );
    loop {
        if answered(ladder.walk(prompter, &[], &SchemaCatalog::default()), ui)? == Reached::Tables {
            return Err(Outcome::Nothing);
        }
        let changed = ladder.settings().changed_from(live);
        if !changed.is_any_set() {
            ui.log(NOTHING_CHANGED);

            return Ok(None);
        }

        let allow_no_cron = ladder.cron_policy().unwrap_or(false);
        let listed = SettingsOptions::from_declared(&changed)
            .to_sync_args()
            .join(" ");
        let _ = prompter.note("Project settings", &listed);
        match prompter.confirm(&settings_question(panel.connection), false) {
            Ok(true) => return Ok(Some((changed, allow_no_cron))),
            Ok(false) => {
                ui.log("  nothing written.");

                return Ok(None);
            }
            Err(PromptError::Back) => {
                ladder.back();
            }
            Err(error) => return answered(Err(error), ui),
        }
    }
}

/// What `pg_cron` schedules, as the header's jobs line read it.
fn retention_jobs(jobs: Option<&JobsSummary>) -> RetentionJobs {
    match jobs {
        Some(JobsSummary::Scheduled { count, .. }) => RetentionJobs::Scheduled(*count),
        // A panel open on a database reads a jobs section whenever the pack is
        // installed, and it closes on one that is not.
        Some(JobsSummary::NoPgCron) | None => RetentionJobs::NoPgCron,
    }
}

fn settings_question(connection: &WizardConnection) -> String {
    match connection {
        WizardConnection::Direct(direct) => format!(
            "Write the settings migration and run supabase db push {} now?",
            direct.push.describe()
        ),
        WizardConnection::Remote { .. } => {
            "Apply these settings to the hosted project now?".to_owned()
        }
    }
}

/// `kizunasync sync` with the settings flags and `--yes`, over the panel's
/// connection: a migration pushed with `supabase db push`, or the delta
/// applied over the Management API.
fn write_settings(
    panel: &Panel<'_>,
    settings: SettingsOptions,
    allow_no_cron: bool,
    ports: &mut SmartPorts<'_>,
    ui: &mut Ui,
) {
    let (connection, project_ref, remote) = match panel.connection {
        WizardConnection::Direct(direct) => (Some(direct.clone()), None, None),
        WizardConnection::Remote { project_ref, .. } => {
            (None, Some(project_ref.clone()), Some(panel.applier))
        }
    };
    let flags = SyncFlags {
        settings,
        allow_no_cron,
        yes: true,
        schema: SYNCED_TABLE_SCHEMA.to_owned(),
        connection,
        project_ref,
        ..SyncFlags::default()
    };
    let mut sync_ports = SyncPorts {
        prompter: None,
        schemas: ports.init.schemas,
        supabase: ports.init.supabase,
        now_unix: ports.init.now_unix,
        tokens: ports.init.tokens,
        linked: ports.linked,
    };
    let context = panel.context;
    sync::run(
        &flags,
        context.paths,
        context.env,
        context.env_files,
        remote,
        &mut sync_ports,
        ui,
    );
}

// MARK: - the pack

/// `upgrade`'s plan and classification, one confirmation, then the apply with
/// `--yes`. A plan no apply moves is reported the way `upgrade` reports it, and
/// an apply refused over an earlier build's tables ends on
/// [`Outcome::EarlierBuild`].
fn update_pack(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Acted {
    let Ok(inputs) = upgrade::read_inputs(ui, panel.applier, panel.context.env) else {
        return Ok(ran(&["upgrade"]));
    };
    let plan = plan_provision(&inputs.files, &inputs.rows);
    if upgrade::refuse_ahead(ui, &plan, &inputs.rows).is_some() {
        return Ok(ran(&["upgrade"]));
    }
    let reach = Some(Reach::of(panel.connection));
    let Some(batch) = upgrade::batch_for(&plan, true) else {
        upgrade::run_plan(ui, panel.applier, &plan, &UpgradeFlags::default(), reach);

        return Ok(ran(&["upgrade"]));
    };

    let args: &[&str] = if batch.reapplies() {
        &["upgrade", "--reapply", "--yes"]
    } else {
        &["upgrade", "--yes"]
    };
    if upgrade::describe_batch(ui, panel.applier, &plan, &batch).is_err() {
        return Ok(ran(args));
    }
    let question = if batch.reapplies() {
        "Re-apply the pack now?"
    } else {
        "Apply the pending pack file(s) now?"
    };
    if !answered(lent_prompter(ports, ui)?.confirm(question, true), ui)? {
        ui.log("  nothing applied.");

        return Ok(Outcome::Nothing);
    }

    let end = upgrade::apply_batch(
        ui,
        panel.applier,
        &plan,
        &batch,
        &UpgradeFlags {
            yes: true,
            reapply: batch.reapplies(),
            ..UpgradeFlags::default()
        },
        reach,
    );
    if end == ApplyEnd::EarlierBuild {
        return Ok(Outcome::EarlierBuild);
    }

    Ok(applied(args))
}

// MARK: - reports

fn health_check(panel: &Panel<'_>, ports: &SmartPorts<'_>, ui: &mut Ui) -> Outcome {
    let (project_ref, access_token) = match panel.connection {
        WizardConnection::Direct(_) => (None, None),
        WizardConnection::Remote {
            project_ref,
            credential,
        } => (Some(project_ref.clone()), Some(credential.token.clone())),
    };
    let flags = DoctorFlags {
        project_ref,
        access_token,
        ..DoctorFlags::default()
    };
    doctor::run(
        &flags,
        panel.applier,
        panel.context.paths,
        panel.context.env,
        &ports.panel.doctor,
        ui,
    );

    ran(&["doctor"])
}

fn show_status(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Acted {
    status::render_in_session(lent_prompter(ports, ui)?, ui, &panel.report);

    Ok(ran(&["status"]))
}

// MARK: - background jobs

/// The jobs submenu. Backspace on a question it leads to reopens it on the
/// item that led there; Backspace on it returns to the panel.
fn background_jobs(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Acted {
    direct(panel, ui)?;
    let mut chosen = None;
    loop {
        let action = answered(
            lent_prompter(ports, ui)?.select_action(
                JOBS_MESSAGE,
                &jobs_menu(),
                chosen,
                BackKey::Honoured,
            ),
            ui,
        )?;
        chosen = Some(action);
        let stepped = match action {
            PanelAction::RunJobNow => pick_job(panel, ports, ui)?,
            PanelAction::RescheduleJobs => reschedule_jobs(panel, ports, ui)?,
            other => return Ok(perform(panel, other, ports, ui)),
        };
        if let Some(outcome) = stepped {
            return Ok(outcome);
        }
    }
}

fn list_jobs(panel: &Panel<'_>, ui: &mut Ui) -> Acted {
    direct(panel, ui)?;
    jobs::run(JobsAction::List, &JobsFlags::default(), panel.applier, ui);

    Ok(ran(&["jobs", "list"]))
}

/// The job picker, then the run confirmation, which Backspace leaves for the
/// picker on the same job.
fn pick_job(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Stepped {
    direct(panel, ui)?;
    let mut chosen = None;
    loop {
        let Some(action) = stepped(
            lent_prompter(ports, ui)?.select_action(
                JOB_MESSAGE,
                &job_menu(),
                chosen,
                BackKey::Honoured,
            ),
            ui,
        )?
        else {
            return Ok(None);
        };
        chosen = Some(action);
        let PanelAction::RunJob(job) = action else {
            return Ok(Some(perform(panel, action, ports, ui)));
        };
        if let Some(outcome) = run_job(panel, job, ports, ui)? {
            return Ok(Some(outcome));
        }
    }
}

fn run_job(panel: &Panel<'_>, job: Job, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Stepped {
    direct(panel, ui)?;
    let question = format!("Run {}() now?", job.function());
    let Some(run) = stepped(lent_prompter(ports, ui)?.confirm(&question, true), ui)? else {
        return Ok(None);
    };
    if !run {
        return Ok(Some(Outcome::Nothing));
    }

    jobs::run(
        JobsAction::Run(job),
        &JobsFlags::default(),
        panel.applier,
        ui,
    );

    Ok(Some(applied(&["jobs", "run", job.label()])))
}

/// The pack gate, then the reschedule confirmation. Backspace on the
/// confirmation reopens the jobs submenu, unless the gate re-applied the pack,
/// which returns to the panel to read the project again.
fn reschedule_jobs(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Stepped {
    direct(panel, ui)?;
    let reapplied = gate_first(panel, ports, ui)?;
    let question = "Reschedule the three jobs from kizunasync._settings now?";
    let answer = stepped(lent_prompter(ports, ui)?.confirm(question, true), ui);
    let outcome = match answer {
        Ok(None) if !reapplied => return Ok(None),
        Ok(None | Some(false)) => Outcome::Nothing,
        Ok(Some(true)) => {
            jobs::run(
                JobsAction::Schedule,
                &JobsFlags::default(),
                panel.applier,
                ui,
            );

            applied(&["jobs", "schedule"])
        }
        Err(ended) => ended,
    };

    Ok(Some(after_gate(reapplied, outcome)))
}

// MARK: - removal

/// `deprovision`'s dry run, the target typed out, the purge question, then the
/// apply with `--yes`, and `--purge --confirm <target>` when asked for.
fn remove(panel: &Panel<'_>, ports: &mut SmartPorts<'_>, ui: &mut Ui) -> Acted {
    let url = direct(panel, ui)?.url.as_str();
    let env = panel.context.env;
    let dry_run = DeprovisionRequest {
        dry_run: true,
        ..DeprovisionRequest::default()
    };
    let planned = deprovision::run_over(panel.applier, url, &dry_run, env, ui);
    if planned != OK {
        return Ok(ran(&["deprovision", "--dry-run"]));
    }

    let expected = deprovision::expected_confirmation(url);
    let prompter = lent_prompter(ports, ui)?;
    let message = format!("Type \"{expected}\" to remove Kizuna from this database");
    let mut typed = None;
    // Backspace on the purge question reopens the target on the text typed.
    let purge = loop {
        if !answered(
            prompter.ask_typed_confirmation(&message, &expected, typed),
            ui,
        )? {
            ui.error(&format!(
                "  that is not \"{expected}\": nothing was removed."
            ));

            return Ok(Outcome::Nothing);
        }
        typed = Some(expected.as_str());
        if let Some(purge) = stepped(prompter.confirm(PURGE_QUESTION, false), ui)? {
            break purge;
        }
    };

    let request = DeprovisionRequest {
        yes: true,
        purge,
        confirm: purge.then_some(expected.as_str()),
        ..DeprovisionRequest::default()
    };
    deprovision::run_over(panel.applier, url, &request, env, ui);
    let mut args = vec!["deprovision".to_owned(), "--yes".to_owned()];
    if purge {
        args.extend(["--purge".to_owned(), "--confirm".to_owned(), expected]);
    }

    Ok(Outcome::Applied(args))
}
