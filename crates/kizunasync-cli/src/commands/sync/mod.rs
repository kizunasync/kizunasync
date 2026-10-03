//! `sync`: add and remove synced tables after `kizunasync init`.
//!
//! `kizunasync._config` IS the synced set, so this command reads it, decides the
//! new one, and emits the migration that moves the database from one to the
//! other:
//!
//! 1. Resolve a database and read the synced set from it ([`crate::config`]),
//!    after refusing a ledger a newer kizunasync recorded.
//! 2. Decide the new set: `--add`/`--remove` for scripts and CI, or one
//!    checkbox with the currently-synced tables pre-checked for a terminal.
//! 3. Emit one delta migration ([`crate::sync_delta`]): added tables go through
//!    the same provisioning SQL `init` uses, removed tables unwind their
//!    triggers, config row, and ledger rows, all inside one transaction.
//! 4. Apply it with `supabase db push`, unless `--local-only`.
//!
//! What removal does not do: delete the changelog and tombstone rows the table
//! already produced. Retention reaps those; deleting them here would rewrite
//! history other clients may still be reading. Every run says so.
//!
//! Safety: `--dry-run` writes nothing and prints the full plan + SQL, and every
//! outside capability arrives through [`SyncPorts`], so no test path can reach
//! a live database or spawn the Supabase CLI.

use crate::applier::Applier;
use crate::commands::history_gate::gate_migration_history;
use crate::commands::init::{ConnectionAnswers, STEP_BACK, report_pg_cron, verify_pg_cron};
use crate::commands::panel::equivalent::Reach;
use crate::commands::reconcile::{Gated, PackGate, ReapplyVia, gate_pack};
use crate::commands::table_checks::{
    review_proposal_keys, warn_unscoped_deletes, warn_unscoped_proposals,
};
use crate::commands::upgrade::ApplyEnd;
use crate::commands::{FAILURE, OK, UNUSABLE, refuse_newer_ledger};
use crate::config::{KizunaSyncConfig, MaxBatchSize, ProjectSettings};
use crate::config_sql::{CronGate, ResolvedTableConfig, SYNCED_TABLE_SCHEMA};
use crate::db::is_valid_schema_name;
use crate::emit::next_migration_second;
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::migration_history::local_versions;
use crate::provision::{LedgerRow, Plan, plan_provision};
use crate::sync_delta::{DeltaInput, render_sync_delta_sql};
use crate::ui::Ui;
use crate::verify::{Expectation, ExpectedTable, describe_gaps, read_provisioning_gaps};
use crate::workdir::ProjectPaths;

mod decide;
mod flags;
mod keys;
mod plan;
mod writes;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

pub(crate) use decide::*;
pub use flags::{
    LinkedConnector, NO_CONNECTION_ENTERED, SettingsOptions, SyncFlags, SyncPorts, TableOptions,
};
pub(crate) use plan::*;
pub(crate) use writes::*;

// MARK: - copy

const CONFIRM_REFUSAL: &str = concat!(
    "\n  refusing to write without confirmation: re-run with --yes (or run it in a\n",
    "  terminal to confirm interactively)."
);

const CANCELLED: &str = "  cancelled, nothing written.";

/// The line a cancelled wizard closes its chrome with.
const NOTHING_WRITTEN: &str = "Nothing written.";

/// Run the command against the resolved project root, reporting through `ui`.
///
/// `remote` is the Management API transport `--project-ref` selected, which
/// reads and applies in place of a connection string and writes no local
/// migration.
///
/// Backspace on the table checkbox reopens the connection question before
/// it. A connection that came without a question has none: the caller's
/// connection (`flags.connection`) hands `STEP_BACK` back to the caller, and
/// any other run asks the checkbox again.
pub fn run(
    flags: &SyncFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    remote: Option<&dyn Applier>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    run_session(flags, paths, env, env_files, remote, ports, ui).code
}

/// How a run ended.
pub(crate) struct Finished {
    /// The exit code.
    pub(crate) code: i32,
    /// Whether the run passed its write confirmation and wrote the delta.
    pub(crate) wrote: bool,
}

impl Finished {
    /// A run that ended on `code` with nothing written.
    pub(crate) const fn on(code: i32) -> Self {
        Self { code, wrote: false }
    }
}

/// [`run`], saying whether the delta was written.
pub(crate) fn run_session(
    flags: &SyncFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    remote: Option<&dyn Applier>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> Finished {
    ui.log("kizunasync sync: managing the synced tables\n");

    if let Some(code) = refuse_early(flags, ports, ui) {
        return Finished::on(code);
    }

    let mut answers = ConnectionAnswers::default();
    loop {
        let finished = run_connected(
            flags,
            paths,
            env,
            env_files,
            remote,
            ports,
            ui,
            &mut answers,
        );
        if finished.code != STEP_BACK {
            return finished;
        }
        if let Some(reopened) = answers.reopen_mark() {
            crate::wizard_theme::rewind(reopened);
            continue;
        }
        if flags.connection.is_some() {
            return finished;
        }
        ui.log(CANCELLED);

        return Finished::on(OK);
    }
}

/// One pass over one connection: resolve it, read the synced set, then walk
/// and apply. [`STEP_BACK`] is Backspace on the table checkbox.
#[expect(
    clippy::too_many_arguments,
    reason = "The run's context, threaded not stored."
)]
fn run_connected(
    flags: &SyncFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    remote: Option<&dyn Applier>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
    answers: &mut ConnectionAnswers,
) -> Finished {
    let (target, config) =
        match resolve_target_and_config(flags, paths, env, env_files, remote, ports, ui, answers) {
            Ok(resolved) => resolved,
            Err(code) => return Finished::on(code),
        };

    // Nothing asked before the checkbox, so Backspace there leaves it open.
    let checkbox_first = answers.reopen_mark().is_none() && flags.connection.is_none();
    let mut wizard = None;
    loop {
        let (plan, settings) = match decide_plan(flags, &target, &config, &mut wizard, ports, ui) {
            Ok(decided) => decided,
            Err(code) if code == STEP_BACK && checkbox_first => continue,
            Err(code) => return Finished::on(code),
        };
        let change = Change {
            flags,
            plan: &plan,
            settings,
            target: &target,
            paths,
            config: &config,
        };
        match apply_change(&change, wizard.is_some(), ports, ui) {
            Applied::Exit(code) => return Finished::on(code),
            Applied::Wrote(code) => return Finished { code, wrote: true },
            Applied::Back => {
                if let Some(wizard) = wizard.as_mut() {
                    wizard.reopen_before_confirm();
                }
            }
        }
    }
}

/// The four flag/config sanity checks that run before anything is asked of a
/// database: names, `--max-batch-size` range, schema support, and whether
/// this run has any way at all to decide the new set.
fn refuse_early(flags: &SyncFlags, ports: &mut SyncPorts<'_>, ui: &mut Ui) -> Option<i32> {
    if let Some(code) = refuse_bad_names(flags, ui) {
        return Some(code);
    }
    if let Some(code) = refuse_out_of_range(flags, ui) {
        return Some(code);
    }
    if let Some(code) = refuse_unsupported_schema(flags, ui) {
        return Some(code);
    }
    if let Some(code) = refuse_without_a_way_to_decide(flags, ports, ui) {
        return Some(code);
    }

    None
}

/// Resolve the transport, refuse a ledger a newer kizunasync recorded, pass
/// the pack gate unless the run writes nothing to the database, read
/// `kizunasync._config` through it, and report the synced table count. `Err`
/// carries the exit code to return immediately, [`STEP_BACK`] for No at the
/// pack gate.
#[expect(
    clippy::too_many_arguments,
    reason = "The run's context, threaded not stored."
)]
fn resolve_target_and_config<'a>(
    flags: &SyncFlags,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    remote: Option<&'a dyn Applier>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
    answers: &mut ConnectionAnswers,
) -> std::result::Result<(Target<'a>, KizunaSyncConfig), i32> {
    let target = resolve_target(flags, paths, env, env_files, remote, ports, ui, answers)?;
    let rows = match target.read_ledger_rows(ports.schemas) {
        Ok(rows) => rows,
        Err(cause) => {
            ui.error(&format!(
                "  could not read the provision ledger:\n    {cause}"
            ));

            return Err(UNUSABLE);
        }
    };
    if let Some(code) = refuse_newer_ledger(&rows, ui) {
        return Err(code);
    }
    if !flags.dry_run && !flags.local_only {
        match gate_target(flags, &target, &rows, env, ports, ui)? {
            Gated::Clear | Gated::Reapply => {}
            Gated::Declined => return Err(STEP_BACK),
        }
    }
    let config = match target.read_config(ports.schemas) {
        Ok(config) => config,
        Err(cause) => {
            ui.error(&format!("  {cause}"));

            return Err(UNUSABLE);
        }
    };
    ui.log(&format!(
        "  synced tables:    {} in kizunasync._config",
        config.tables.len()
    ));

    Ok((target, config))
}

/// The pack gate over `target` ([`gate_pack`]), a re-apply running at once
/// over it. `--yes` never prompts, so it meets the gate the way a session
/// without a terminal does.
///
/// # Errors
/// Returns the exits [`gate_pack`] does, and `2` when the pack on disk cannot
/// be read.
fn gate_target(
    flags: &SyncFlags,
    target: &Target<'_>,
    rows: &[LedgerRow],
    env: &Env,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> std::result::Result<Gated, i32> {
    let plan = match crate::pack::resolve_pack_dir(env) {
        Some(pack_dir) => match crate::pack::read_pack_files(&pack_dir) {
            Ok(files) => plan_provision(&files, rows),
            Err(cause) => {
                ui.error(&format!("  {cause}"));

                return Err(UNUSABLE);
            }
        },
        None => return Ok(Gated::Clear),
    };
    if !matches!(plan, Plan::Drift { .. }) {
        return Ok(Gated::Clear);
    }

    let direct_applier;
    let (applier, via, reach): (&dyn Applier, _, _) = match target {
        Target::Direct(direct) => {
            direct_applier = ports.schemas.pack_applier(&direct.url);
            (
                direct_applier.as_ref(),
                ReapplyVia::Connection,
                Some(Reach::DbUrl(&direct.url)),
            )
        }
        Target::Remote(api) => (
            *api,
            ReapplyVia::ManagementApi,
            flags.project_ref.as_ref().map(Reach::ProjectRef),
        ),
    };
    let gate = PackGate {
        plan: Some(&plan),
        rows,
        applier,
        via,
        reach,
        allow_no_cron: flags.allow_no_cron,
    };
    let mut unasked = None;
    let prompter = if flags.yes {
        &mut unasked
    } else {
        &mut ports.prompter
    };

    gate_pack(&gate, prompter, ui).map_err(ApplyEnd::code)
}

/// Decide the new table set and the settings that go with it, then check
/// whether there is anything to change at all. `Err` carries the exit code to
/// return immediately, including the `OK` "nothing to change" exit. `wizard`
/// is the terminal's walk, kept open across the write confirmation, whose
/// chrome a refusal here closes.
fn decide_plan(
    flags: &SyncFlags,
    target: &Target<'_>,
    config: &KizunaSyncConfig,
    wizard: &mut Option<InteractivePlan>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> std::result::Result<(TablePlan, Option<ProjectSettings>), i32> {
    let declared = flags.settings.declared();
    let mut plan = match plan_tables(flags, target, config, wizard, ports, ui) {
        Planned::Stop(code) => return Err(code),
        Planned::Plan(plan) => plan,
    };
    if let Some(code) = mark_bucket_changes(&mut plan.updated, config, ui)
        .or_else(|| review_proposal_keys(&plan.added, ui))
    {
        if wizard.is_some()
            && let Some(prompter) = ports.prompter.as_deref_mut()
        {
            let _ = prompter.outro_cancel(NOTHING_WRITTEN);
        }

        return Err(code);
    }
    warn_unscoped_changes(&plan, config, ui);
    // The wizard's answer wins over the flags that pre-filled its steps, the
    // same precedence the per-table flags keep.
    let settings = plan
        .settings
        .clone()
        .or_else(|| declared.is_any_set().then(|| declared.clone()));
    if let Some(settings) = &settings {
        ui.log(&format!(
            "  project settings: {}",
            describe_settings(settings, config.settings.as_ref())
        ));
    }
    if plan.added.is_empty()
        && plan.updated.is_empty()
        && plan.removed.is_empty()
        && settings.is_none()
    {
        ui.log("\n  nothing to change.");

        return Err(OK);
    }

    Ok((plan, settings))
}

/// [`warn_unscoped_deletes`] for every table the plan adds, and for every
/// synced one as its update leaves it.
fn warn_unscoped_changes(plan: &TablePlan, config: &KizunaSyncConfig, ui: &mut Ui) {
    warn_unscoped_proposals(&plan.added, ui);
    for update in &plan.updated {
        if let Some(live) = config.tables.get(&update.table) {
            warn_unscoped_deletes(&update.table, &update.declared.over(live), ui);
        }
    }
}

/// Everything the second half of the run needs once the new set is decided:
/// the flags, the decided plan and settings, where the delta goes, and the
/// project root a direct target writes its migration under.
struct Change<'a> {
    flags: &'a SyncFlags,
    plan: &'a TablePlan,
    /// The project settings this run declared, absent when it declared none.
    settings: Option<ProjectSettings>,
    target: &'a Target<'a>,
    paths: &'a ProjectPaths,
    /// The synced set the project carried before this run.
    config: &'a KizunaSyncConfig,
}

impl Change<'_> {
    /// What the database must hold once the delta applied: the pack (the
    /// gate compared its hashes before anything was written), every added and
    /// updated table as the plan leaves it, and none of the removed ones.
    fn expectation(&self) -> Expectation {
        let added = self.plan.added.iter().map(|proposal| {
            ExpectedTable::of(
                &proposal.table,
                &ResolvedTableConfig::from_proposal(proposal).as_table_config(),
            )
        });
        let updated = self.plan.updated.iter().filter_map(|update| {
            let live = self.config.tables.get(&update.table)?;

            Some(ExpectedTable::of(
                &update.table,
                &update.declared.over(live),
            ))
        });

        Expectation {
            pack_files: None,
            tables: added.chain(updated).collect(),
            removed: self.plan.removed.clone(),
        }
    }
}

/// Where [`apply_change`] left the run.
enum Applied {
    /// The run ends on this exit code with nothing written.
    Exit(i32),
    /// The confirmed delta was written, and the run ends on this exit code.
    Wrote(i32),
    /// Backspace on the write confirmation: the walk reopens the question
    /// before it.
    Back,
}

/// Render the delta, report it, then write and apply it unless this is a dry
/// run or a gate stops it. `can_step_back` is a terminal walk the write
/// confirmation belongs to: Backspace on it hands the run back to that walk,
/// and on a flag-driven run it declines.
fn apply_change(
    change: &Change<'_>,
    can_step_back: bool,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> Applied {
    let remote = matches!(change.target, Target::Remote(_));
    let migration_name = migration_name(next_migration_second(
        ports.now_unix,
        &local_versions(&change.paths.migrations_dir),
    ));
    let delta_sql = render_sync_delta_sql(&DeltaInput {
        added: change.plan.added.iter().map(delta_table).collect(),
        updated: change.plan.updated.clone(),
        removed: change.plan.removed.clone(),
        settings: change.settings.clone(),
        cron: CronGate::from_allow_no_cron(change.flags.allow_no_cron),
    });
    if remote {
        describe_remote_plan(change.plan, ui);
    } else {
        describe_plan(change.plan, &migration_name, ui);
    }
    ui.log("  --- delta SQL ---");
    ui.write_stdout(&delta_sql);
    crate::wizard_theme::commit_stdout(&delta_sql);

    if change.flags.dry_run {
        return Applied::Exit(compare_dry_run(change, ports, ui));
    }

    if let Err(code) = gate_history(change, ports, ui) {
        return Applied::Exit(code);
    }

    let question = if remote {
        "Apply this delta to the hosted project now?".to_owned()
    } else {
        format!("Write {migration_name} now?")
    };
    match gate(change.flags, &question, ports, ui) {
        Gate::Refuse => {
            ui.log(CONFIRM_REFUSAL);

            return Applied::Exit(UNUSABLE);
        }
        Gate::Back if can_step_back => return Applied::Back,
        Gate::Declined | Gate::Back => {
            ui.log(CANCELLED);

            return Applied::Exit(OK);
        }
        Gate::Proceed => {}
    }

    Applied::Wrote(write_change(change, &migration_name, &delta_sql, ports, ui))
}

/// The comparison the real run makes before it writes, with nobody to ask:
/// drift is reported with the command that settles it, never repaired, and
/// ends the dry run on the exit the real run would.
fn compare_dry_run(change: &Change<'_>, ports: &mut SyncPorts<'_>, ui: &mut Ui) -> i32 {
    let compared = match change.target {
        Target::Direct(direct) if !change.flags.local_only => gate_migration_history(
            direct,
            change.paths,
            ports.schemas,
            ports.supabase,
            &mut None,
            ui,
        )
        .map(|_| ()),
        Target::Direct(_) | Target::Remote(_) => Ok(()),
    };
    ui.log("\n  --dry-run: nothing was written.");

    compared.err().unwrap_or(OK)
}

/// The history gate a direct, pushing run passes before it writes. `--yes`
/// never prompts, so it meets the gate the way a session without a terminal
/// does.
fn gate_history(
    change: &Change<'_>,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> std::result::Result<(), i32> {
    let Target::Direct(direct) = change.target else {
        return Ok(());
    };
    if change.flags.local_only {
        return Ok(());
    }

    let mut unasked = None;
    let prompter = if change.flags.yes {
        &mut unasked
    } else {
        &mut ports.prompter
    };
    match gate_migration_history(
        direct,
        change.paths,
        ports.schemas,
        ports.supabase,
        prompter,
        ui,
    ) {
        Ok(_) => Ok(()),
        // The history question guards the write rather than being a step of
        // the walk, so Backspace on it ends the run with nothing written.
        Err(code) if code == STEP_BACK => {
            ui.log(CANCELLED);

            Err(OK)
        }
        Err(code) => Err(code),
    }
}

/// Write and apply the confirmed delta, then say whether the schedule it
/// declares has a `pg_cron` to run it.
fn write_change(
    change: &Change<'_>,
    migration_name: &str,
    delta_sql: &str,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let code = match change.target {
        Target::Remote(api) => apply_remotely(*api, delta_sql, ui),
        Target::Direct(direct) => perform_writes(
            &Writes {
                migration_name,
                delta_sql,
                local_only: change.flags.local_only,
                yes: change.flags.yes,
                connection: direct,
            },
            change.paths,
            ports,
            ui,
        ),
    };
    if code != OK {
        return code;
    }
    if !change.flags.local_only {
        if let Some(code) = verify_applied(change, ports, ui) {
            return code;
        }
        let direct = match change.target {
            Target::Direct(direct) => Some(direct),
            Target::Remote(_) => None,
        };
        report_applied(direct, ui);
    }

    // A schedule written into a project with no pg_cron is a job nobody runs,
    // so the run that declared one says so, exactly as `init` does.
    let declares_a_schedule = change
        .settings
        .as_ref()
        .is_some_and(ProjectSettings::declares_a_schedule);
    if !declares_a_schedule || change.flags.local_only {
        return OK;
    }

    match change.target {
        Target::Remote(api) => verify_pg_cron(*api, change.flags.allow_no_cron, ui),
        Target::Direct(direct) => report_pg_cron(
            ports.schemas.pg_cron_present(&direct.url),
            change.flags.allow_no_cron,
            ui,
        ),
    }
}

/// `Some(1)` once the reason is on `ui`, when the database does not hold what
/// the delta provisions, or cannot be read: a push that applied nothing ends
/// here rather than in a success line.
fn verify_applied(change: &Change<'_>, ports: &SyncPorts<'_>, ui: &mut Ui) -> Option<i32> {
    let expected = change.expectation();
    let gaps = match change.target {
        Target::Direct(direct) => ports.schemas.provisioning_gaps(&direct.url, &expected),
        Target::Remote(api) => read_provisioning_gaps(*api, &expected),
    };
    match gaps {
        Ok(gaps) if gaps.is_empty() => None,
        Ok(gaps) => {
            ui.error(&describe_gaps(&gaps));

            Some(FAILURE)
        }
        Err(cause) => {
            ui.error(&format!(
                "\n  could not read what the database holds after the delta applied:\n    {cause}"
            ));

            Some(FAILURE)
        }
    }
}

/// The settings as one line, so a run that declares them says what the project
/// carries afterwards.
fn describe_settings(declared: &ProjectSettings, live: Option<&ProjectSettings>) -> String {
    let merged = declared.merged_with(live);
    let batch = merged.max_batch_size.map_or_else(
        || "unlimited batches".to_owned(),
        |size| match size {
            MaxBatchSize::Unlimited => "unlimited batches".to_owned(),
            MaxBatchSize::Mutations(size) => format!("max {size} per push"),
        },
    );
    let atomic = if merged.require_atomic == Some(true) {
        "atomic required"
    } else {
        "atomic not required"
    };
    let mut parts = vec![batch, atomic.to_owned()];
    if declared.declares_a_schedule() {
        parts.push("schedules rewritten".to_owned());
    }

    parts.join(", ")
}

/// The pack provisions `public.<table>` in every trigger and every render, so a
/// schema this command cannot provision into is a refusal rather than a table
/// silently created somewhere else. There is no picker to offer an alternative:
/// the flag names the one supported value or the run stops.
fn refuse_unsupported_schema(flags: &SyncFlags, ui: &mut Ui) -> Option<i32> {
    if !is_valid_schema_name(&flags.schema) {
        ui.log(&format!(
            "  invalid --schema {:?}: must be a valid Postgres identifier.",
            flags.schema
        ));

        return Some(UNUSABLE);
    }

    if flags.schema == SYNCED_TABLE_SCHEMA {
        return None;
    }

    ui.log(&format!(
        "  --schema {} is not supported: the pack addresses {SYNCED_TABLE_SCHEMA}.<table> in every trigger and RPC, so a synced table lives in {SYNCED_TABLE_SCHEMA}.",
        flags.schema
    ));

    Some(UNUSABLE)
}

/// A number the server would refuse, or silently honour to the project's cost,
/// is answered here rather than at `supabase db push` with a file already
/// written.
pub(crate) fn refuse_out_of_range(flags: &SyncFlags, ui: &mut Ui) -> Option<i32> {
    let refusal = flags
        .options
        .refuse_out_of_range()
        .or_else(|| flags.options.refuse_invalid_identifiers())
        .or_else(|| flags.settings.refuse_out_of_range())
        .or_else(|| {
            // This command can clear the cap, so it says so.
            flags
                .settings
                .refuse_max_batch_size()
                .map(|refusal| format!("{refusal} Use --no-max-batch-size for unlimited."))
        })
        .or_else(|| {
            flags
                .settings
                .refuse_require_atomic()
                .map(|refusal| format!("{refusal} Use --no-require-atomic (the default)."))
        })?;
    ui.log(&format!("  {refusal}"));

    Some(UNUSABLE)
}

/// An invalid identifier, or a name on both sides, is a contradiction rather
/// than a preference: refuse before touching anything.
fn refuse_bad_names(flags: &SyncFlags, ui: &mut Ui) -> Option<i32> {
    let invalid: Vec<&str> = flags
        .add
        .iter()
        .chain(&flags.remove)
        .filter(|name| !is_valid_schema_name(name))
        .map(String::as_str)
        .collect();
    if !invalid.is_empty() {
        ui.log(&format!(
            "  invalid table name(s): {}. They must be valid Postgres identifiers.",
            invalid.join(", ")
        ));

        return Some(UNUSABLE);
    }

    let both: Vec<&str> = flags
        .add
        .iter()
        .filter(|name| flags.remove.contains(name))
        .map(String::as_str)
        .collect();
    if !both.is_empty() {
        ui.log(&format!(
            "  {} passed to both --add and --remove: pick one.",
            both.join(", ")
        ));

        return Some(UNUSABLE);
    }

    None
}
