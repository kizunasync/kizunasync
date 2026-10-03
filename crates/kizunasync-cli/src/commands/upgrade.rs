//! `upgrade`: bring an already-provisioned project's ledger current with the
//! pack.
//!
//! The lifecycle's middle step, between `init` (installer) and `deprovision`
//! (teardown). `upgrade` never installs from scratch: a fresh (empty) ledger
//! refuses and points at `kizunasync init`. Against an already-provisioned project
//! it reconciles three states:
//!
//! * `provisioned-unversioned`: the ledger records objects but no `pack-file`
//!   row, so no hash can be compared. `kizunasync init` writes a `pack-file` row on
//!   every install it makes, so this project was provisioned some other way and
//!   `upgrade` refuses it.
//! * `drift` where every offending file is `not-recorded`: classify each
//!   pending file's SQL with the same rules `kizunasync lint` uses and refuse if any
//!   statement is breaking, so a pending batch applies only when every statement
//!   in it is additive.
//! * `drift` with a genuine offender (a hash mismatch): this build's pack
//!   differs from the one the project records. Without `--reapply` the run
//!   lists the offenders and names `kizunasync upgrade --reapply --yes`; with
//!   it, every pack file runs again and its ledger hash is replaced, in one
//!   transaction.
//!
//! Before any of that, a ledger whose `pack-file` rows a newer build wrote, or
//! that names files this build does not ship, is refused (exit 2): this build
//! would otherwise put its own pack over one it does not know.
//!
//! Applying is gated on `--yes`: this binary never prompts, so a session
//! without it is refused (exit 2) rather than silently applying.
//!
//! The batch is one transaction. Every pending file and the ledger row that
//! accounts for it go in the same `begin` … `commit`, so a failure halfway
//! through rolls all of it back and the ledger never claims a file whose SQL
//! did not land. The transaction opens with the provisioning lock and a check
//! that the ledger still records what the plan read, so a second run that got
//! there first makes this one roll back instead of applying over it.
//! `--dry-run` prints that exact script on stdout. After a successful apply
//! the job schedules are re-applied from `kizunasync._settings`, which is what
//! keeps an operator's own timings. A `_schedule_jobs()` that fails there ends
//! the run on exit 1, the upgrade itself applied, unless `--allow-no-cron`
//! accepts running retention by hand.
//!
//! `--reapply` changes two states. Up to date: every pack file the ledger
//! already records runs again, in name order, inside one transaction and with
//! no ledger row, which restores a pack object someone dropped or altered. Hash
//! mismatch: every pack file runs again the same way, each followed by the
//! upsert that records its new hash. Either way every file it runs is
//! classified first, like a pending file, and a breaking statement refuses the
//! batch. The pack is written so a re-run leaves operator and user data alone.
//! Every other state behaves exactly as it does without the flag.

use crate::applier::Applier;
use crate::commands::jobs::apply_schedules;
use crate::commands::panel::equivalent::Reach;
use crate::commands::reconcile::{REAPPLY_EFFECT, describe_offenders, earlier_build_step};
use crate::commands::{FAILURE, OK, UNUSABLE};
use crate::config::config_query;
use crate::constants::{INTERNAL_PROVISIONS, SCHEMA};
use crate::env::Env;
use crate::error::Result;
use crate::lint::{Severity, classify_sql};
use crate::pack::{self, PackFile};
use crate::provision::{
    DriftReason, LedgerRow, LedgerState, Plan, PlanFile, describe_ledger_ahead, ledger_ahead,
    plan_provision, read_ledger_rows, read_ledger_state, reconcile_pack, render_ledger_guard,
    render_pack_file_ledger_sql, render_reconcile,
};
use crate::row::require_string;
use crate::ui::Ui;

/// Flags `upgrade` accepts.
// A flag surface is a bag of switches; a state machine would only hide which
// flag the user typed.
#[expect(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Default)]
pub struct UpgradeFlags {
    /// Plan only; change nothing.
    pub dry_run: bool,
    /// Confirm the apply. Without it a non-interactive session refuses.
    pub yes: bool,
    /// Re-apply every pack file of an up-to-date plan, or of a plan whose
    /// ledger records another hash, recording this build's. No other plan
    /// state reads it.
    pub reapply: bool,
    /// Finish on exit 0 when the job schedules cannot be applied after the
    /// upgrade, retention then run by hand.
    pub allow_no_cron: bool,
}

const NON_INTERACTIVE_REFUSAL: &str =
    "\n  refusing to apply without confirmation, re-run with --yes (upgrade never prompts).";

const DRY_RUN_NOTE: &str =
    "\n  --dry-run: the SQL above is what would be applied; nothing was changed.";

const ROLLED_BACK: &str =
    "the batch ran inside one transaction, so nothing was applied and no ledger row was written.";

/// The shipped pack and the ledger rows an upgrade plans from.
pub(crate) struct UpgradeInputs {
    /// This build's pack files.
    pub(crate) files: Vec<PackFile>,
    /// The rows the ledger holds.
    pub(crate) rows: Vec<LedgerRow>,
}

/// Resolve this build's pack and read the ledger over `applier`.
///
/// # Errors
/// Returns the exit code the run stops with, the reason already on the
/// [`Ui`]: `2` when the pack cannot be located or read, `1` when the ledger
/// cannot be read.
pub(crate) fn read_inputs(
    ui: &mut Ui,
    applier: &dyn Applier,
    env: &Env,
) -> std::result::Result<UpgradeInputs, i32> {
    let Some(pack_dir) = pack::resolve_pack_dir(env) else {
        ui.log(&format!("  {}", pack::not_found_message()));

        return Err(UNUSABLE);
    };
    let files = pack::read_pack_files(&pack_dir).map_err(|cause| {
        ui.error(&format!("\n  {cause}"));

        UNUSABLE
    })?;
    let rows = read_ledger_rows(applier).map_err(|cause| {
        ui.error(&format!("\n  {cause}"));

        FAILURE
    })?;

    Ok(UpgradeInputs { files, rows })
}

/// The whole command over a connection the caller already resolved: read the
/// pack and the ledger, then [`run`]. `reach` is the connection the command
/// was given, which a printed next step names.
pub(crate) fn run_over(
    ui: &mut Ui,
    applier: &dyn Applier,
    env: &Env,
    flags: &UpgradeFlags,
    reach: Option<Reach<'_>>,
) -> i32 {
    match read_inputs(ui, applier, env) {
        Ok(inputs) => run(ui, applier, &inputs.files, &inputs.rows, flags, reach),
        Err(code) => code,
    }
}

/// Plan `pack_files` against the ledger `rows` and dispatch the plan, unless
/// the ledger records a pack this build cannot reconcile: one written by a
/// newer build, or naming files this build does not ship. That refuses before
/// anything is read or applied (exit 2).
pub(crate) fn run(
    ui: &mut Ui,
    applier: &dyn Applier,
    pack_files: &[PackFile],
    rows: &[LedgerRow],
    flags: &UpgradeFlags,
    reach: Option<Reach<'_>>,
) -> i32 {
    let plan = plan_provision(pack_files, rows);
    if let Some(code) = refuse_ahead(ui, &plan, rows) {
        return code;
    }

    run_plan(ui, applier, &plan, flags, reach)
}

/// `Some(2)` once the refusal is on `ui`, when the ledger `rows` record a pack
/// this build cannot reconcile against `plan`.
pub(crate) fn refuse_ahead(ui: &mut Ui, plan: &Plan, rows: &[LedgerRow]) -> Option<i32> {
    let ahead = ledger_ahead(plan.files(), rows, crate::VERSION);
    if ahead.is_empty() {
        return None;
    }

    ui.error(&format!(
        "\n{}",
        describe_ledger_ahead(&ahead, crate::VERSION)
    ));

    Some(UNUSABLE)
}

/// Dispatch an already-computed plan. Split from any transport resolution so
/// tests exercise refusal, drift, and pending without touching the real on-disk
/// pack.
pub(crate) fn run_plan(
    ui: &mut Ui,
    applier: &dyn Applier,
    plan: &Plan,
    flags: &UpgradeFlags,
    reach: Option<Reach<'_>>,
) -> i32 {
    let Some(batch) = batch_for(plan, flags.reapply) else {
        return report_unmoved(ui, applier, plan);
    };
    if let Err(code) = describe_batch(ui, applier, plan, &batch) {
        return code;
    }

    apply_batch(ui, applier, plan, &batch, flags, reach).code()
}

/// What an apply runs, once the plan has something to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Batch {
    /// Pack files shipped since the ones the ledger records, each applied
    /// with the ledger row that accounts for it.
    Pending(Vec<PlanFile>),
    /// Every pack file of an up-to-date plan, run again with no ledger row, to
    /// restore a pack object someone dropped or altered.
    Reapply,
    /// Every pack file of a plan whose ledger records another hash, each
    /// followed by the upsert that records this build's.
    Reconcile,
}

impl Batch {
    /// Whether this is the batch `--reapply` asks for.
    pub(crate) const fn reapplies(&self) -> bool {
        matches!(self, Self::Reapply | Self::Reconcile)
    }

    /// The pack files the batch runs: the pending ones, or every file of
    /// `plan`.
    pub(crate) fn files<'p>(&'p self, plan: &'p Plan) -> &'p [PlanFile] {
        match self {
            Self::Pending(pending) => pending,
            Self::Reapply | Self::Reconcile => plan.files(),
        }
    }
}

/// The batch `plan` runs, `reapply` being `--reapply`. `None` when no apply
/// moves the plan: nothing is provisioned, the ledger records no pack file, or
/// the pack is up to date or changed and `--reapply` was not given.
pub(crate) fn batch_for(plan: &Plan, reapply: bool) -> Option<Batch> {
    match plan {
        Plan::Apply { .. } | Plan::ProvisionedUnversioned { .. } => None,
        Plan::UpToDate { .. } => reapply.then_some(Batch::Reapply),
        Plan::Drift { files, offending } => {
            let genuine = offending
                .iter()
                .any(|offender| offender.reason != DriftReason::NotRecorded);
            if genuine {
                return reapply.then_some(Batch::Reconcile);
            }

            Some(Batch::Pending(
                files
                    .iter()
                    .filter(|file| offending.iter().any(|offender| offender.name == file.name))
                    .cloned()
                    .collect(),
            ))
        }
    }
}

/// A plan no apply moves, reported with the exit it ends on.
fn report_unmoved(ui: &mut Ui, applier: &dyn Applier, plan: &Plan) -> i32 {
    match plan {
        Plan::Apply { .. } => {
            ui.log("\n  nothing is provisioned yet: run `kizunasync init` first.");

            UNUSABLE
        }
        Plan::UpToDate { .. } => {
            ui.log("\n  the pack is up to date, nothing to upgrade.");
            report_ledger(ui, applier);

            OK
        }
        Plan::ProvisionedUnversioned {
            recorded_objects, ..
        } => {
            ui.error(&format!(
                "\n  refusing: the ledger records {recorded_objects} object(s) but no per-file row for this pack,\n  \
                 so there is nothing to reconcile against. `kizunasync init` records one on every install\n  \
                 it makes, so this project was provisioned some other way. Nothing was applied."
            ));

            FAILURE
        }
        Plan::Drift { offending, .. } => {
            ui.error("\n  drift: the ledger does not match this pack:");
            for offender in offending {
                let recorded = offender
                    .recorded_hash
                    .as_ref()
                    .map_or_else(String::new, |hash| format!(" (ledger has md5 {hash})"));
                ui.error(&format!(
                    "    ! {}: {}{recorded}",
                    offender.name, offender.reason
                ));
            }
            ui.error(&format!(
                "\n  this build's pack differs from the one the ledger records: `kizunasync upgrade --reapply --yes` re-applies it and records its hash.\n  {REAPPLY_EFFECT}"
            ));

            FAILURE
        }
    }
}

/// What `batch` runs and how every statement in it classifies, in the words
/// `upgrade` prints before it applies.
///
/// # Errors
/// Returns `1` once the reason is on the [`Ui`]: a breaking statement refuses
/// the batch, and so does a synced set that cannot be read or classified.
pub(crate) fn describe_batch(
    ui: &mut Ui,
    applier: &dyn Applier,
    plan: &Plan,
    batch: &Batch,
) -> std::result::Result<(), i32> {
    match batch {
        Batch::Pending(pending) => {
            classify_batch(ui, applier, pending)?;
            ui.log("\n  pending pack file(s):");
            for file in pending {
                ui.log(&format!("    + {}   md5 {}", file.name, file.content_hash));
            }

            Ok(())
        }
        Batch::Reapply => {
            let files = plan.files();
            ui.log(&format!("\n  re-applying {} pack file(s):", files.len()));
            for file in files {
                ui.log(&format!("    ~ {}   md5 {}", file.name, file.content_hash));
            }
            ui.log(&format!("  {REAPPLY_EFFECT}"));

            classify_batch(ui, applier, files)
        }
        Batch::Reconcile => {
            ui.log("\n  this build's pack differs from the one the ledger records:");
            for line in describe_offenders(plan) {
                ui.log(&line);
            }
            ui.log(&format!("  {REAPPLY_EFFECT}"));

            classify_batch(ui, applier, plan.files())
        }
    }
}

/// Where [`apply_batch`] left the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplyEnd {
    /// The exit code the run ends on.
    Exit(i32),
    /// The database refused the batch over a column or a table it does not
    /// have, so nothing was applied, and the way out through a fresh install is
    /// already on the [`Ui`]. The run ends on exit `1`.
    EarlierBuild,
}

impl ApplyEnd {
    /// The exit code the run ends on.
    pub(crate) const fn code(self) -> i32 {
        match self {
            Self::Exit(code) => code,
            Self::EarlierBuild => FAILURE,
        }
    }
}

/// Run `batch`: `--dry-run` prints its script, a run without `--yes` is
/// refused, and an apply ends on the job schedules and the ledger summary.
/// `reach` is the connection a printed next step names.
pub(crate) fn apply_batch(
    ui: &mut Ui,
    applier: &dyn Applier,
    plan: &Plan,
    batch: &Batch,
    flags: &UpgradeFlags,
    reach: Option<Reach<'_>>,
) -> ApplyEnd {
    if flags.dry_run {
        ui.write_stdout(&batch_script(plan, batch));
        ui.log(DRY_RUN_NOTE);

        return ApplyEnd::Exit(OK);
    }

    if !flags.yes {
        ui.log(NON_INTERACTIVE_REFUSAL);

        return ApplyEnd::Exit(UNUSABLE);
    }

    let outcome = match batch {
        Batch::Pending(_) | Batch::Reapply => applier
            .run_script(&batch_script(plan, batch))
            .map_err(|cause| (format!("{cause}\n  {ROLLED_BACK}"), cause)),
        Batch::Reconcile => {
            reconcile_pack(plan, applier).map_err(|cause| (cause.to_string(), cause))
        }
    };
    if let Err((message, cause)) = outcome {
        if !cause.is_undefined_column_or_table() {
            return ApplyEnd::Exit(fail(ui, &message));
        }

        fail(ui, &format!("{message}\n  {}", earlier_build_step(reach)));

        return ApplyEnd::EarlierBuild;
    }
    report_applied(ui, plan, batch);

    ApplyEnd::Exit(finish_after_apply(ui, applier, flags))
}

/// The one script `batch` sends.
fn batch_script(plan: &Plan, batch: &Batch) -> String {
    match batch {
        Batch::Pending(pending) => render_transaction(plan, pending),
        Batch::Reapply => render_reapply(plan),
        Batch::Reconcile => render_reconcile(plan),
    }
}

/// One line per file the batch ran, then the count.
fn report_applied(ui: &mut Ui, plan: &Plan, batch: &Batch) {
    match batch {
        Batch::Pending(pending) => {
            for file in pending {
                ui.log(&format!("  applied {}", file.name));
            }
            ui.log(&format!("\n  applied {} pack file(s).", pending.len()));
        }
        Batch::Reapply => {
            for file in plan.files() {
                ui.log(&format!("  re-applied {}", file.name));
            }
            ui.log(&format!(
                "\n  re-applied {} pack file(s).",
                plan.files().len()
            ));
        }
        Batch::Reconcile => {
            for file in plan.files() {
                ui.log(&format!("  re-applied {}", file.name));
            }
            ui.log(&format!(
                "\n  re-applied {} pack file(s) and recorded their hashes.",
                plan.files().len()
            ));
        }
    }
}

/// Classify every file a batch would run, with the same additive/breaking
/// rules `kizunasync lint` runs, against the synced-table set read live from
/// `kizunasync._config`, one line per hit.
///
/// # Errors
/// Returns the exit code the run stops with, the reason already on the
/// [`Ui`]: `1` when a statement is breaking, which refuses the whole batch,
/// or when the synced set cannot be read or classified.
pub(crate) fn classify_batch(
    ui: &mut Ui,
    applier: &dyn Applier,
    files: &[PlanFile],
) -> std::result::Result<(), i32> {
    let tables = read_synced_tables(applier).map_err(|cause| fail(ui, &cause.to_string()))?;
    let mut breaking = false;
    for file in files {
        let hits =
            classify_sql(&file.sql, &tables).map_err(|cause| fail(ui, &cause.to_string()))?;
        for hit in hits {
            let label = format!("{}  [{}]  {}", file.name, hit.table, hit.detail);
            match hit.severity {
                Severity::Breaking => {
                    breaking = true;
                    ui.error(&format!("BREAKING  {label}"));
                }
                Severity::Additive => ui.success(&format!("additive  {label}")),
            }
        }
    }
    if breaking {
        ui.error(
            "\n  refusing: this pack change is breaking for the sync contract. See `kizunasync lint`.",
        );

        return Err(FAILURE);
    }

    Ok(())
}

/// Every pending file and its ledger row in one transaction, so a failure
/// halfway through leaves the database exactly as it was: the ledger cannot
/// claim a file whose SQL did not land, and a file cannot land unledgered.
/// It opens with [`render_ledger_guard`] over `plan`, and is sent as one
/// script for the reason [`render_reconcile`] gives.
#[must_use]
pub fn render_transaction(plan: &Plan, pending: &[PlanFile]) -> String {
    let blocks: Vec<String> = pending
        .iter()
        .map(|file| {
            format!(
                "\n-- {}\n{}\n{}\n",
                file.name,
                file.sql.trim_end(),
                render_pack_file_ledger_sql(&file.name, &file.content_hash)
            )
        })
        .collect();

    format!(
        "{TRANSACTION_HEADER}begin;\n{}{}\ncommit;\n",
        render_ledger_guard(plan),
        blocks.concat()
    )
}

const TRANSACTION_HEADER: &str = "-- Generated by `kizunasync upgrade`. Every pending pack file and its ledger row,\n\
     -- in one transaction: a failure rolls the whole batch back.\n";

/// Every pack file of an up-to-date plan in one transaction, with no ledger
/// row, opening with [`render_ledger_guard`] and sent as one script for the
/// same reason [`render_transaction`] is.
#[must_use]
pub fn render_reapply(plan: &Plan) -> String {
    let blocks: Vec<String> = plan
        .files()
        .iter()
        .map(|file| format!("\n-- {}\n{}\n", file.name, file.sql.trim_end()))
        .collect();

    format!(
        "{REAPPLY_HEADER}begin;\n{}{}\ncommit;\n",
        render_ledger_guard(plan),
        blocks.concat()
    )
}

const REAPPLY_HEADER: &str = "-- Generated by `kizunasync upgrade --reapply`. Every pack file the ledger records,\n\
     -- in one transaction: a failure rolls the whole batch back.\n";

/// The schedules the apply left behind. `_schedule_jobs()` is the single writer
/// of the three cron jobs, and it reads `kizunasync._settings`, so calling it
/// here is what keeps an operator's own timings after a re-apply instead of
/// whatever the pack file happened to write. `false` when the call failed,
/// which is reported here.
pub(crate) fn report_schedules(ui: &mut Ui, applier: &dyn Applier) -> bool {
    match apply_schedules(applier) {
        Err(cause) => {
            ui.error(&format!("\n  could not apply the job schedules: {cause}"));

            false
        }
        Ok(outcome) => {
            if outcome.pg_cron {
                ui.log("\n  job schedules, from kizunasync._settings:");
            } else {
                ui.log("\n  job schedules (pg_cron is absent, so nothing is scheduled):");
            }
            for (name, schedule) in &outcome.jobs {
                ui.log(&format!("    {name:<32}{schedule}"));
            }

            true
        }
    }
}

/// What every successful apply ends on: the schedules re-applied, the ledger
/// summary, and the exit. The pack is applied either way; a schedule that did
/// not land leaves retention unscheduled, which is a failure unless
/// `--allow-no-cron` accepts it.
fn finish_after_apply(ui: &mut Ui, applier: &dyn Applier, flags: &UpgradeFlags) -> i32 {
    let scheduled = report_schedules(ui, applier);
    report_ledger(ui, applier);

    if scheduled {
        return OK;
    }

    if flags.allow_no_cron {
        ui.warn(SCHEDULES_WAIVED);

        return OK;
    }

    ui.error(SCHEDULES_FAILED);

    FAILURE
}

const SCHEDULES_FAILED: &str = "\n  the upgrade is applied, but retention is not scheduled: fix the cause above and run `kizunasync jobs schedule`, or pass --allow-no-cron to run retention yourself.";

/// What `--allow-no-cron` prints over a schedule that did not land.
pub(crate) const SCHEDULES_WAIVED: &str = "\n  --allow-no-cron: retention is not scheduled. Run `kizunasync jobs run all` on a schedule of your own.";

fn fail(ui: &mut Ui, message: &str) -> i32 {
    ui.error(&format!("\n  {message}"));

    FAILURE
}

fn read_synced_tables(applier: &dyn Applier) -> Result<Vec<String>> {
    let rows = applier.run_query(&config_query())?;
    let mut tables = Vec::with_capacity(rows.len());
    for row in &rows {
        tables.push(require_string(row, "table_name")?);
    }

    Ok(tables)
}

/// The ledger summary that closes every successful run. A read failure here is
/// reported, never fatal: the work it summarizes already happened.
fn report_ledger(ui: &mut Ui, applier: &dyn Applier) {
    match read_ledger_state(applier) {
        Err(cause) => ui.error(&format!("\n  could not read the ledger summary: {cause}")),
        Ok(LedgerState::Absent) => ui.log(&format!(
            "\n  ledger:           {SCHEMA}.{INTERNAL_PROVISIONS} does not exist yet"
        )),
        Ok(LedgerState::Present(entries)) => {
            ui.log("\n  ledger:");
            for entry in entries {
                ui.log(&format!("    {:<22}{}", entry.object_kind, entry.count));
            }
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::applier::fake::{FakeApplier, text_row};
    use crate::provision::{Drift, DriftReason};
    use crate::ui::Capture;

    fn file(name: &str, sql: &str) -> PlanFile {
        PlanFile {
            name: name.to_owned(),
            sql: sql.to_owned(),
            content_hash: "md5hash".to_owned(),
        }
    }

    fn provisioned() -> FakeApplier {
        provisioned_over(FakeApplier::new())
    }

    /// The provisioned project's answers, after whatever `base` already
    /// answers: the first matching answer wins.
    fn provisioned_over(base: FakeApplier) -> FakeApplier {
        base.answer(
            "pg_proc",
            vec![
                text_row(&[("proname", "pull")]),
                text_row(&[("proname", "push")]),
            ],
        )
        .answer("to_regclass", vec![text_row(&[("present", "t")])])
        .answer(
            "count(*)::int as count",
            vec![text_row(&[("object_kind", "function"), ("count", "2")])],
        )
        .answer(
            "from kizunasync._config",
            vec![text_row(&[("table_name", "todos")])],
        )
        .answer(
            "_schedule_jobs()::text",
            vec![text_row(&[(
                "schedules",
                r#"{"jobs": {"kizunasync-reap-tombstones": "16 3 * * *"}, "pg_cron": true}"#,
            )])],
        )
    }

    fn drive(applier: &FakeApplier, plan: &Plan, flags: &UpgradeFlags) -> (i32, Capture) {
        let (mut ui, capture) = Ui::capture();
        let code = run_plan(&mut ui, applier, plan, flags, None);

        (code, capture)
    }

    fn yes() -> UpgradeFlags {
        UpgradeFlags {
            dry_run: false,
            yes: true,
            reapply: false,
            allow_no_cron: false,
        }
    }

    fn reapply_yes() -> UpgradeFlags {
        UpgradeFlags {
            reapply: true,
            ..yes()
        }
    }

    /// Two recorded files, already in the name order the planner sorts into.
    fn recorded_files() -> Vec<PlanFile> {
        vec![
            file("0001_a.sql", "create table if not exists a ();\n"),
            file("0002_b.sql", "create table if not exists b ();\n"),
        ]
    }

    fn up_to_date() -> Plan {
        Plan::UpToDate {
            files: recorded_files(),
        }
    }

    fn ran(applier: &FakeApplier, needle: &str) -> bool {
        applier
            .executed
            .borrow()
            .iter()
            .any(|sql| sql.contains(needle))
    }

    /// The synced tables a breaking file is weighed against come from whole
    /// `_config` rows, like every other read of that table.
    #[test]
    fn the_synced_tables_are_read_from_whole_config_rows() {
        let applier = FakeApplier::new().answer(
            "from kizunasync._config",
            vec![text_row(&[
                ("table_name", "todos"),
                ("sync_mode", "read-write"),
            ])],
        );

        assert_eq!(read_synced_tables(&applier).unwrap(), ["todos"]);
        assert_eq!(
            *applier.executed.borrow(),
            ["select * from kizunasync._config order by table_name;"]
        );
    }

    #[test]
    fn a_fresh_project_is_sent_to_init() {
        let (code, capture) = drive(&provisioned(), &Plan::Apply { files: Vec::new() }, &yes());

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("run `kizunasync init` first"));
    }

    #[test]
    fn an_up_to_date_pack_reports_the_ledger_and_exits_zero() {
        let (code, capture) = drive(
            &provisioned(),
            &Plan::UpToDate { files: Vec::new() },
            &yes(),
        );

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("the pack is up to date"));
        assert!(capture.stderr().contains("function              2"));
    }

    #[test]
    fn an_object_ledgered_install_is_refused_rather_than_adopted() {
        let applier = provisioned();
        let plan = Plan::ProvisionedUnversioned {
            files: vec![file("0001.sql", "create table t();")],
            recorded_objects: 4,
        };
        let (code, capture) = drive(&applier, &plan, &yes());

        assert_eq!(code, FAILURE);
        assert!(capture.stderr().contains("no per-file row for this pack"));
        let executed = applier.executed.borrow().clone();
        assert!(
            !executed
                .iter()
                .any(|sql| sql.contains("insert into kizunasync._provisions"))
        );
        assert!(!executed.iter().any(|sql| sql.contains("create table t()")));
    }

    #[test]
    fn without_yes_a_pending_apply_is_refused_rather_than_prompted_for() {
        let applier = provisioned();
        let plan = drift(DriftReason::NotRecorded, None, "select 1;");
        let (code, capture) = drive(&applier, &plan, &UpgradeFlags::default());

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("re-run with --yes"));
        assert!(
            !applier
                .executed
                .borrow()
                .iter()
                .any(|sql| sql.contains("insert into"))
        );
    }

    fn drift(reason: DriftReason, hash: Option<&str>, sql: &str) -> Plan {
        Plan::Drift {
            files: vec![file("0002.sql", sql)],
            offending: vec![Drift {
                name: "0002.sql".to_owned(),
                reason,
                recorded_hash: hash.map(ToOwned::to_owned),
            }],
        }
    }

    #[test]
    fn a_hash_mismatch_without_the_flag_names_the_command_that_reconciles_it() {
        let applier = provisioned();
        let plan = drift(DriftReason::HashMismatch, Some("deadbeef"), "select 1;");
        let (code, capture) = drive(&applier, &plan, &yes());
        let stderr = capture.stderr();

        assert_eq!(code, FAILURE);
        assert!(
            stderr.contains("0002.sql: hash-mismatch (ledger has md5 deadbeef)"),
            "{stderr}"
        );
        assert!(
            stderr.contains(&format!(
                "this build's pack differs from the one the ledger records: `kizunasync upgrade --reapply --yes` re-applies it and records its hash.\n  {REAPPLY_EFFECT}"
            )),
            "{stderr}"
        );
        assert!(!stderr.contains("changed since"), "{stderr}");
        assert!(!ran(&applier, "select 1;"));
    }

    fn pack_file(name: &str, sql: &str) -> PackFile {
        PackFile {
            name: name.to_owned(),
            sql: sql.to_owned(),
        }
    }

    fn ledger_row(name: &str, hash: &str, version: &str) -> LedgerRow {
        LedgerRow {
            object_kind: "pack-file".to_owned(),
            object_name: name.to_owned(),
            content_hash: hash.to_owned(),
            pack_version: version.to_owned(),
        }
    }

    fn drive_rows(
        applier: &FakeApplier,
        pack: &[PackFile],
        rows: &[LedgerRow],
        flags: &UpgradeFlags,
    ) -> (i32, Capture) {
        let (mut ui, capture) = Ui::capture();
        let code = run(&mut ui, applier, pack, rows, flags, None);

        (code, capture)
    }

    /// A newer build wrote the ledger, so this build's older pack must not go
    /// over it: not under `--reapply`, not under a dry run, not even to report
    /// the ledger up to date.
    #[test]
    fn a_ledger_a_newer_build_wrote_is_refused_under_every_flag() {
        let pack = [pack_file("0001_a.sql", "select 1;\n")];
        let rows = [ledger_row(
            "0001_a.sql",
            &crate::provision::hash_pack_file("select 1;\n"),
            "999.0.0",
        )];
        for flags in [
            yes(),
            reapply_yes(),
            UpgradeFlags {
                dry_run: true,
                reapply: true,
                ..UpgradeFlags::default()
            },
        ] {
            let applier = provisioned();
            let (code, capture) = drive_rows(&applier, &pack, &rows, &flags);
            let stderr = capture.stderr();

            assert_eq!(code, UNUSABLE, "{flags:?}: {stderr}");
            assert!(
                stderr.contains(
                    "! 0001_a.sql: recorded by kizunasync 999.0.0, newer than this build"
                ),
                "{stderr}"
            );
            assert!(stderr.contains("update kizunasync"), "{stderr}");
            assert!(applier.executed.borrow().is_empty(), "{flags:?}");
            assert_eq!(capture.stdout(), "");
        }
    }

    #[test]
    fn a_ledger_naming_a_file_this_build_does_not_ship_is_refused() {
        let applier = provisioned();
        let pack = [pack_file("0001_a.sql", "select 1;\n")];
        let rows = [
            ledger_row(
                "0001_a.sql",
                &crate::provision::hash_pack_file("select 1;\n"),
                crate::VERSION,
            ),
            ledger_row("0002_b.sql", "abc", crate::VERSION),
        ];
        let (code, capture) = drive_rows(&applier, &pack, &rows, &reapply_yes());

        assert_eq!(code, UNUSABLE);
        assert!(
            capture.stderr().contains(&format!(
                "! 0002_b.sql: recorded by kizunasync {}, not in this build's pack",
                crate::VERSION
            )),
            "{}",
            capture.stderr()
        );
        assert!(applier.executed.borrow().is_empty());
    }

    /// A ledger this build or an older one wrote plans as it always has.
    #[test]
    fn a_ledger_an_older_build_wrote_is_planned_and_dispatched() {
        let applier = provisioned();
        let pack = [pack_file("0001_a.sql", "select 1;\n")];
        let rows = [ledger_row(
            "0001_a.sql",
            &crate::provision::hash_pack_file("select 1;\n"),
            "0.0.1",
        )];
        let (code, capture) = drive_rows(&applier, &pack, &rows, &yes());

        assert_eq!(code, OK, "{}", capture.stderr());
        assert!(capture.stderr().contains("the pack is up to date"));
    }

    #[test]
    fn a_hash_mismatch_dry_run_under_the_flag_prints_the_reconcile_script() {
        let applier = provisioned();
        let plan = drift(DriftReason::HashMismatch, Some("deadbeef"), "select 1;");
        let flags = UpgradeFlags {
            dry_run: true,
            reapply: true,
            ..UpgradeFlags::default()
        };
        let (code, capture) = drive(&applier, &plan, &flags);
        let stderr = capture.stderr();

        assert_eq!(code, OK);
        assert_eq!(capture.stdout(), render_reconcile(&plan));
        assert!(
            stderr.contains("    ! 0002.sql: ledger md5 deadbeef, pack md5 md5hash"),
            "{stderr}"
        );
        assert!(stderr.contains("--dry-run"), "{stderr}");
        assert_eq!(
            executed_beyond_the_synced_table_read(&applier),
            Vec::<String>::new()
        );
    }

    #[test]
    fn without_yes_a_hash_mismatch_re_apply_is_refused_rather_than_prompted_for() {
        let applier = provisioned();
        let plan = drift(DriftReason::HashMismatch, Some("deadbeef"), "select 1;");
        let flags = UpgradeFlags {
            reapply: true,
            ..UpgradeFlags::default()
        };
        let (code, capture) = drive(&applier, &plan, &flags);

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("re-run with --yes"));
        assert_eq!(
            executed_beyond_the_synced_table_read(&applier),
            Vec::<String>::new()
        );
    }

    /// The reconcile script, then the schedules and the ledger summary, like
    /// every other successful run.
    #[test]
    fn a_hash_mismatch_under_reapply_yes_re_applies_and_records_the_hash() {
        let applier = provisioned();
        let plan = drift(DriftReason::HashMismatch, Some("deadbeef"), "select 1;");
        let (code, capture) = drive(&applier, &plan, &reapply_yes());
        let stderr = capture.stderr();

        assert_eq!(code, OK, "{stderr}");
        assert_eq!(
            executed_beyond_the_synced_table_read(&applier)[0],
            render_reconcile(&plan)
        );
        assert!(ran(&applier, "do update set content_hash"));
        assert!(
            stderr.contains(
                "  re-applied 0002.sql\n\n  re-applied 1 pack file(s) and recorded their hashes.\n"
            ),
            "{stderr}"
        );
        assert!(ran(&applier, "kizunasync._schedule_jobs()"));
        assert!(stderr.contains("function              2"), "{stderr}");
        assert_eq!(capture.stdout(), "");
    }

    #[test]
    fn a_failed_hash_mismatch_re_apply_says_the_ledger_is_unchanged() {
        let applier = provisioned().fail("select 1;", "permission denied");
        let plan = drift(DriftReason::HashMismatch, Some("deadbeef"), "select 1;");
        let (code, capture) = drive(&applier, &plan, &reapply_yes());
        let stderr = capture.stderr();

        assert_eq!(code, FAILURE);
        assert!(stderr.contains("permission denied"), "{stderr}");
        assert!(stderr.contains("the ledger is unchanged"), "{stderr}");
        assert!(!ran(&applier, "kizunasync._schedule_jobs()"));
    }

    const DB_URL: &str = "postgresql://postgres:secret@127.0.0.1:55322/kz_drift";

    /// Apply `batch` of `plan` under `--reapply --yes` over an applier whose
    /// server refuses the script with `sqlstate`.
    fn refused_apply(
        plan: &Plan,
        batch: &Batch,
        sqlstate: &str,
        reach: Option<Reach<'_>>,
    ) -> (ApplyEnd, Capture, FakeApplier) {
        let applier = provisioned_over(FakeApplier::new().fail_sql(
            "select 1;",
            sqlstate,
            &format!(
                "{sqlstate}: column \"max_pull_scan\" of relation \"_settings\" does not exist"
            ),
        ));
        let (mut ui, capture) = Ui::capture();
        let end = apply_batch(&mut ui, &applier, plan, batch, &reapply_yes(), reach);

        (end, capture, applier)
    }

    /// A re-apply the database refuses over a column or a table it does not
    /// have rolls back, then names the fresh install over the same connection,
    /// its password left to `PGPASSWORD`.
    #[test]
    fn a_re_apply_refused_over_a_missing_column_or_table_names_a_fresh_install() {
        let changed = drift(DriftReason::HashMismatch, Some("deadbeef"), "select 1;");
        let current = Plan::UpToDate {
            files: vec![file("0002.sql", "select 1;")],
        };
        for (plan, batch) in [(&changed, Batch::Reconcile), (&current, Batch::Reapply)] {
            for sqlstate in ["42703", "42P01"] {
                let (end, capture, applier) =
                    refused_apply(plan, &batch, sqlstate, Some(Reach::DbUrl(DB_URL)));
                let stderr = capture.stderr();
                let rolled_back = stderr.find("nothing was applied").unwrap_or(usize::MAX);
                let next_step = stderr
                    .find("\n  the database holds kizunasync tables from an earlier build of the pack, which a re-apply does not reshape. ")
                    .unwrap_or_default();

                assert_eq!(
                    end,
                    ApplyEnd::EarlierBuild,
                    "{batch:?} {sqlstate}: {stderr}"
                );
                assert_eq!(end.code(), FAILURE);
                assert!(rolled_back < next_step, "{batch:?} {sqlstate}: {stderr}");
                assert!(
                    stderr.contains(
                        "Remove Kizuna with `PGPASSWORD=… kizunasync deprovision --purge --db-url postgresql://postgres@127.0.0.1:55322/kz_drift` (your application tables and their data stay), then install it again with `PGPASSWORD=… kizunasync init --db-url postgresql://postgres@127.0.0.1:55322/kz_drift`."
                    ),
                    "{batch:?} {sqlstate}: {stderr}"
                );
                assert!(!stderr.contains("secret"), "{stderr}");
                assert!(!ran(&applier, "kizunasync._schedule_jobs()"));
            }
        }
    }

    /// With no connection flag the commands name none either, so they reach
    /// the database the same resolution finds.
    #[test]
    fn without_a_connection_flag_the_fresh_install_names_the_bare_commands() {
        let plan = drift(DriftReason::HashMismatch, Some("deadbeef"), "select 1;");
        let (end, capture, _) = refused_apply(&plan, &Batch::Reconcile, "42703", None);

        assert_eq!(end, ApplyEnd::EarlierBuild);
        assert!(
            capture.stderr().contains(
                "Remove Kizuna with `kizunasync deprovision --purge` (your application tables and their data stay), then install it again with `kizunasync init`."
            ),
            "{}",
            capture.stderr()
        );
    }

    /// Any other statement the database refuses ends on exit `1` with its own
    /// cause and no fresh install.
    #[test]
    fn another_refused_statement_names_no_fresh_install() {
        let plan = drift(DriftReason::HashMismatch, Some("deadbeef"), "select 1;");
        let (end, capture, _) = refused_apply(
            &plan,
            &Batch::Reconcile,
            "42501",
            Some(Reach::DbUrl(DB_URL)),
        );

        assert_eq!(end, ApplyEnd::Exit(FAILURE));
        assert!(capture.stderr().contains("the ledger is unchanged"));
        assert!(!capture.stderr().contains("earlier build"));
        assert!(!capture.stderr().contains("deprovision"));
    }

    #[test]
    fn an_additive_pending_file_applies_and_is_recorded() {
        let applier = provisioned();
        let plan = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos add column a text;",
        );
        let (code, capture) = drive(&applier, &plan, &yes());

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("additive  0002.sql  [todos]"));
        assert!(capture.stderr().contains("applied 1 pack file(s)."));
        let executed = applier.executed.borrow().clone();
        assert!(executed.iter().any(|sql| sql.contains("add column a text")));
        assert!(
            executed
                .iter()
                .any(|sql| sql.contains("insert into kizunasync._provisions"))
        );
    }

    #[test]
    fn a_breaking_pending_file_refuses_the_whole_batch() {
        let applier = provisioned();
        let plan = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos drop column a;",
        );
        let (code, capture) = drive(&applier, &plan, &yes());

        assert_eq!(code, FAILURE);
        assert!(capture.stderr().contains("BREAKING  0002.sql  [todos]"));
        assert!(
            capture
                .stderr()
                .contains("refusing: this pack change is breaking")
        );
        assert!(
            !applier
                .executed
                .borrow()
                .iter()
                .any(|sql| sql.contains("drop column a"))
        );
    }

    /// One `begin` … `commit`, with each file's ledger row beside the file it
    /// accounts for, and nothing else in between.
    #[test]
    fn the_batch_is_one_transaction_carrying_its_own_ledger_rows() {
        let applier = provisioned();
        let plan = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos add column a text;",
        );
        drive(&applier, &plan, &yes());
        let executed = applier.executed.borrow().clone();
        let script = executed
            .iter()
            .find(|sql| sql.contains("add column a text"))
            .expect("the batch script");

        assert!(script.starts_with("-- Generated by `kizunasync upgrade`."));
        assert!(script.contains("\nbegin;\n"));
        assert!(script.trim_end().ends_with("commit;"));
        assert!(script.contains("-- 0002.sql\n"));
        let apply = script.find("add column a text").unwrap();
        let record = script.find("insert into kizunasync._provisions").unwrap();
        assert!(apply < record, "the ledger row follows the file it records");
        assert_eq!(
            script.matches("begin;").count(),
            1,
            "one transaction, not one per file"
        );
    }

    #[test]
    fn a_dry_run_prints_the_sql_it_would_apply_and_writes_nothing() {
        let applier = provisioned();
        let plan = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos add column a text;",
        );
        let (code, capture) = drive(
            &applier,
            &plan,
            &UpgradeFlags {
                dry_run: true,
                ..UpgradeFlags::default()
            },
        );

        assert_eq!(code, OK);
        assert!(capture.stdout().contains("begin;"));
        assert!(capture.stdout().contains("add column a text"));
        assert!(
            capture
                .stdout()
                .contains("insert into kizunasync._provisions")
        );
        assert!(capture.stdout().trim_end().ends_with("commit;"));
        assert!(capture.stderr().contains("--dry-run"));
        assert!(
            !applier
                .executed
                .borrow()
                .iter()
                .any(|sql| sql.contains("add column a text"))
        );
    }

    /// A failed batch is one rolled-back transaction, and the message says so:
    /// an operator who reads "applying failed" must not go looking for a
    /// half-applied file.
    #[test]
    fn a_failed_batch_says_nothing_was_applied() {
        let applier = provisioned().fail("add column a text", "permission denied");
        let plan = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos add column a text;",
        );
        let (code, capture) = drive(&applier, &plan, &yes());

        assert_eq!(code, FAILURE);
        assert!(
            capture
                .stderr()
                .contains("nothing was applied and no ledger row was written")
        );
    }

    /// `_schedule_jobs()` is the single writer of the three cron jobs, so the
    /// schedules an upgrade leaves behind are the settings row's, not whatever
    /// the re-applied pack file wrote.
    #[test]
    fn a_successful_apply_reports_the_schedules_it_re_applied() {
        let applier = provisioned();
        let plan = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos add column a text;",
        );
        let (code, capture) = drive(&applier, &plan, &yes());

        assert_eq!(code, OK);
        assert!(
            applier
                .executed
                .borrow()
                .iter()
                .any(|sql| sql.contains("kizunasync._schedule_jobs()"))
        );
        assert!(
            capture
                .stderr()
                .contains("job schedules, from kizunasync._settings:")
        );
        assert!(
            capture
                .stderr()
                .contains("kizunasync-reap-tombstones      16 3 * * *")
        );
    }

    /// A pending batch, an up-to-date re-apply, and a hash-mismatch re-apply,
    /// each with the flags that apply it.
    fn every_apply() -> [(Plan, UpgradeFlags); 3] {
        [
            (
                drift(
                    DriftReason::NotRecorded,
                    None,
                    "alter table todos add column a text;",
                ),
                yes(),
            ),
            (
                Plan::UpToDate {
                    files: recorded_files(),
                },
                reapply_yes(),
            ),
            (
                drift(DriftReason::HashMismatch, Some("deadbeef"), "select 1;"),
                reapply_yes(),
            ),
        ]
    }

    /// The pack applied, but `_schedule_jobs()` did not: retention is left
    /// unscheduled, so the run fails naming the command that re-applies the
    /// schedules and the flag that accepts the gap.
    #[test]
    fn a_schedule_that_fails_after_an_apply_ends_the_upgrade_on_exit_one() {
        for (plan, flags) in every_apply() {
            let applier = provisioned_over(
                FakeApplier::new().fail("_schedule_jobs()", "invalid schedule: \"61 * * * *\""),
            );
            let (code, capture) = drive(&applier, &plan, &flags);
            let stderr = capture.stderr();

            assert_eq!(code, FAILURE, "{plan:?}: {stderr}");
            assert!(
                stderr.contains("could not apply the job schedules: "),
                "{stderr}"
            );
            assert!(stderr.contains("invalid schedule"), "{stderr}");
            assert!(
                stderr.contains("the upgrade is applied, but retention is not scheduled"),
                "{stderr}"
            );
            assert!(stderr.contains("`kizunasync jobs schedule`"), "{stderr}");
            assert!(stderr.contains("--allow-no-cron"), "{stderr}");
            assert!(
                applier
                    .executed
                    .borrow()
                    .iter()
                    .any(|sql| sql.contains("begin;")),
                "the batch itself ran"
            );
        }
    }

    #[test]
    fn allow_no_cron_ends_a_failed_schedule_on_zero_and_says_retention_runs_by_hand() {
        for (plan, flags) in every_apply() {
            let applier =
                provisioned_over(FakeApplier::new().fail("_schedule_jobs()", "invalid schedule"));
            let flags = UpgradeFlags {
                allow_no_cron: true,
                ..flags
            };
            let (code, capture) = drive(&applier, &plan, &flags);
            let stderr = capture.stderr();

            assert_eq!(code, OK, "{plan:?}: {stderr}");
            assert!(
                stderr.contains("could not apply the job schedules"),
                "{stderr}"
            );
            assert!(
                stderr.contains("--allow-no-cron: retention is not scheduled"),
                "{stderr}"
            );
            assert!(stderr.contains("`kizunasync jobs run all`"), "{stderr}");
        }
    }

    /// pg_cron being absent is not a failed call: `_schedule_jobs()` answers
    /// that nothing is scheduled, and the upgrade ends as before.
    #[test]
    fn a_schedule_call_that_reports_no_pg_cron_still_ends_on_zero() {
        let applier = provisioned_over(FakeApplier::new().answer(
            "_schedule_jobs()::text",
            vec![text_row(&[(
                "schedules",
                r#"{"jobs": {"kizunasync-reap-tombstones": "16 3 * * *"}, "pg_cron": false}"#,
            )])],
        ));
        let (plan, flags) = every_apply().into_iter().next().unwrap();
        let (code, capture) = drive(&applier, &plan, &flags);

        assert_eq!(code, OK, "{}", capture.stderr());
        assert!(
            capture
                .stderr()
                .contains("pg_cron is absent, so nothing is scheduled")
        );
    }

    #[test]
    fn a_pending_apply_that_fails_reports_the_transports_own_error() {
        let applier = provisioned().fail("add column a text", "permission denied");
        let plan = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos add column a text;",
        );
        let (code, capture) = drive(&applier, &plan, &yes());

        assert_eq!(code, FAILURE);
        assert!(capture.stderr().contains("permission denied"));
    }

    #[test]
    fn every_line_of_the_run_stays_off_stdout() {
        let plan = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos add column a text;",
        );
        let (_, capture) = drive(&provisioned(), &plan, &yes());

        assert_eq!(capture.stdout(), "");
    }

    /// One `begin` … `commit` carrying every recorded file in name order, and
    /// no ledger row: the ledger already records each one with this hash.
    #[test]
    fn a_re_apply_runs_every_recorded_file_in_one_transaction_with_no_ledger_row() {
        let applier = provisioned();
        let (code, _) = drive(&applier, &up_to_date(), &reapply_yes());
        let executed = applier.executed.borrow().clone();
        let script = executed
            .iter()
            .find(|sql| sql.contains("create table if not exists a ()"))
            .expect("the re-apply script");

        assert_eq!(code, OK);
        assert_eq!(*script, render_reapply(&up_to_date()));
        assert!(script.starts_with(
            "-- Generated by `kizunasync upgrade --reapply`. Every pack file the ledger records,\n\
             -- in one transaction: a failure rolls the whole batch back.\nbegin;\n"
        ));
        assert!(script.trim_end().ends_with("commit;"));
        assert_eq!(
            script.matches("begin;").count(),
            1,
            "one transaction, not one per file"
        );
        let first = script.find("-- 0001_a.sql\n").unwrap();
        let second = script.find("-- 0002_b.sql\n").unwrap();
        assert!(first < second, "the files run in name order");
        assert!(!ran(&applier, "insert into kizunasync._provisions"));
    }

    /// The same closing steps as an apply: the schedules from
    /// `kizunasync._settings`, then the ledger summary.
    #[test]
    fn a_re_apply_names_each_file_then_reports_the_schedules_and_the_ledger() {
        let applier = provisioned();
        let (code, capture) = drive(&applier, &up_to_date(), &reapply_yes());
        let stderr = capture.stderr();

        assert_eq!(code, OK);
        assert!(
            stderr.starts_with(
                "\n  re-applying 2 pack file(s):\n    ~ 0001_a.sql   md5 md5hash\n    ~ 0002_b.sql   md5 md5hash\n"
            ),
            "{stderr}"
        );
        assert!(
            stderr.contains(
                "  re-applied 0001_a.sql\n  re-applied 0002_b.sql\n\n  re-applied 2 pack file(s).\n"
            ),
            "{stderr}"
        );
        assert!(ran(&applier, "kizunasync._schedule_jobs()"));
        assert!(stderr.contains("job schedules, from kizunasync._settings:"));
        assert!(stderr.contains("kizunasync-reap-tombstones      16 3 * * *"));
        assert!(stderr.contains("function              2"));
        assert!(!stderr.contains("the pack is up to date"), "{stderr}");
        assert_eq!(capture.stdout(), "");
    }

    #[test]
    fn without_yes_a_re_apply_is_refused_rather_than_prompted_for() {
        let applier = provisioned();
        let flags = UpgradeFlags {
            reapply: true,
            ..UpgradeFlags::default()
        };
        let (code, capture) = drive(&applier, &up_to_date(), &flags);

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("re-run with --yes"));
        assert!(!ran(&applier, "create table if not exists a ()"));
        assert!(!ran(&applier, "kizunasync._schedule_jobs()"));
    }

    #[test]
    fn a_re_apply_dry_run_prints_the_script_and_changes_nothing() {
        let applier = provisioned();
        let flags = UpgradeFlags {
            dry_run: true,
            reapply: true,
            ..UpgradeFlags::default()
        };
        let (code, capture) = drive(&applier, &up_to_date(), &flags);

        assert_eq!(code, OK);
        assert_eq!(capture.stdout(), render_reapply(&up_to_date()));
        assert!(
            !capture
                .stdout()
                .contains("insert into kizunasync._provisions")
        );
        assert!(capture.stderr().contains("~ 0001_a.sql   md5 md5hash"));
        assert!(capture.stderr().contains("--dry-run"));
        assert!(!ran(&applier, "create table if not exists a ()"));
    }

    #[test]
    fn a_failed_re_apply_says_nothing_was_applied() {
        let applier = provisioned().fail("create table if not exists b ()", "permission denied");
        let (code, capture) = drive(&applier, &up_to_date(), &reapply_yes());
        let stderr = capture.stderr();

        assert_eq!(code, FAILURE);
        assert!(stderr.contains("permission denied"), "{stderr}");
        assert!(
            stderr.contains("nothing was applied and no ledger row was written"),
            "{stderr}"
        );
        assert!(!stderr.contains("re-applied"), "{stderr}");
        assert!(!ran(&applier, "kizunasync._schedule_jobs()"));
    }

    fn executed_beyond_the_synced_table_read(applier: &FakeApplier) -> Vec<String> {
        applier
            .executed
            .borrow()
            .iter()
            .filter(|sql| **sql != config_query())
            .cloned()
            .collect()
    }

    /// A re-apply runs every pack file, so every one is classified: a breaking
    /// statement refuses the batch before anything runs, dry run included.
    #[test]
    fn a_reapply_over_a_changed_pack_refuses_a_breaking_file() {
        let plan = drift(
            DriftReason::HashMismatch,
            Some("deadbeef"),
            "alter table todos drop column a;",
        );
        for flags in [
            reapply_yes(),
            UpgradeFlags {
                dry_run: true,
                reapply: true,
                ..UpgradeFlags::default()
            },
        ] {
            let applier = provisioned();
            let (code, capture) = drive(&applier, &plan, &flags);
            let stderr = capture.stderr();

            assert_eq!(code, FAILURE, "{flags:?}: {stderr}");
            assert!(stderr.contains("BREAKING  0002.sql  [todos]"), "{stderr}");
            assert!(
                stderr.contains("refusing: this pack change is breaking"),
                "{stderr}"
            );
            assert_eq!(
                executed_beyond_the_synced_table_read(&applier),
                Vec::<String>::new()
            );
            assert_eq!(capture.stdout(), "");
        }
    }

    #[test]
    fn an_up_to_date_reapply_refuses_a_breaking_file() {
        let applier = provisioned();
        let plan = Plan::UpToDate {
            files: vec![file("0001_a.sql", "alter table todos drop column a;\n")],
        };
        let (code, capture) = drive(&applier, &plan, &reapply_yes());

        assert_eq!(code, FAILURE, "{}", capture.stderr());
        assert!(capture.stderr().contains("BREAKING  0001_a.sql  [todos]"));
        assert_eq!(
            executed_beyond_the_synced_table_read(&applier),
            Vec::<String>::new()
        );
    }

    /// The not-recorded file rides the same re-apply, so it is classified with
    /// the changed one.
    #[test]
    fn a_reapply_classifies_a_not_recorded_file_beside_the_changed_one() {
        let applier = provisioned();
        let plan = Plan::Drift {
            files: vec![
                file("0001_a.sql", "select 1;\n"),
                file("0002_b.sql", "alter table todos rename column a to b;\n"),
            ],
            offending: vec![
                Drift {
                    name: "0001_a.sql".to_owned(),
                    reason: DriftReason::HashMismatch,
                    recorded_hash: Some("deadbeef".to_owned()),
                },
                Drift {
                    name: "0002_b.sql".to_owned(),
                    reason: DriftReason::NotRecorded,
                    recorded_hash: None,
                },
            ],
        };
        let (code, capture) = drive(&applier, &plan, &reapply_yes());
        let stderr = capture.stderr();

        assert_eq!(code, FAILURE, "{stderr}");
        assert!(stderr.contains("BREAKING  0002_b.sql  [todos]"), "{stderr}");
        assert!(
            stderr.contains("! 0002_b.sql: not recorded in the ledger, pack md5 md5hash"),
            "{stderr}"
        );
        assert_eq!(
            executed_beyond_the_synced_table_read(&applier),
            Vec::<String>::new()
        );
    }

    /// Both upgrade scripts take the provisioning lock and re-check the ledger
    /// as the plan read it, right after `begin` and before any file.
    #[test]
    fn every_upgrade_script_takes_the_lock_then_rechecks_the_ledger() {
        let pending = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos add column a text;\n",
        );
        let pending_guard = render_ledger_guard(&pending);

        assert_eq!(
            render_transaction(&pending, pending.files()),
            format!(
                "-- Generated by `kizunasync upgrade`. Every pending pack file and its ledger row,\n\
                 -- in one transaction: a failure rolls the whole batch back.\n\
                 begin;\n\
                 {pending_guard}\n\
                 -- 0002.sql\n\
                 alter table todos add column a text;\n\
                 {}\n\n\
                 commit;\n",
                render_pack_file_ledger_sql("0002.sql", "md5hash")
            )
        );
        assert!(pending_guard.starts_with("select pg_advisory_xact_lock(1264210777, 2);\ndo $$\n"));
        assert!(
            pending_guard.contains("object_name = '0002.sql') is distinct from null\n"),
            "{pending_guard}"
        );

        let recorded = up_to_date();
        let recorded_guard = render_ledger_guard(&recorded);
        assert_eq!(
            render_reapply(&recorded),
            format!(
                "-- Generated by `kizunasync upgrade --reapply`. Every pack file the ledger records,\n\
                 -- in one transaction: a failure rolls the whole batch back.\n\
                 begin;\n\
                 {recorded_guard}\n\
                 -- 0001_a.sql\n\
                 create table if not exists a ();\n\n\
                 -- 0002_b.sql\n\
                 create table if not exists b ();\n\n\
                 commit;\n"
            )
        );
        for name in ["0001_a.sql", "0002_b.sql"] {
            assert!(
                recorded_guard.contains(&format!(
                    "object_name = '{name}') is distinct from 'md5hash'"
                )),
                "{recorded_guard}"
            );
        }
    }

    /// A pending file is still an apply under the flag: it lands with its own
    /// ledger row, never as a re-apply of the files already recorded.
    #[test]
    fn a_pending_file_applies_with_its_ledger_row_under_the_flag() {
        let applier = provisioned();
        let plan = drift(
            DriftReason::NotRecorded,
            None,
            "alter table todos add column a text;",
        );
        let (code, capture) = drive(&applier, &plan, &reapply_yes());

        assert_eq!(code, OK);
        assert!(capture.stderr().contains("applied 1 pack file(s)."));
        assert!(!capture.stderr().contains("re-appl"));
        assert!(ran(&applier, "insert into kizunasync._provisions"));
    }

    #[test]
    fn a_fresh_project_is_still_sent_to_init_under_the_flag() {
        let applier = provisioned();
        let plan = Plan::Apply {
            files: recorded_files(),
        };
        let (code, capture) = drive(&applier, &plan, &reapply_yes());

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("run `kizunasync init` first"));
        assert!(!ran(&applier, "create table if not exists a ()"));
    }

    /// Every state but up-to-date, under every guard combination, produces the
    /// same exit code, output, and statements with and without the flag.
    #[test]
    fn every_other_plan_state_behaves_exactly_as_it_does_without_the_flag() {
        let plans = [
            Plan::Apply {
                files: recorded_files(),
            },
            Plan::ProvisionedUnversioned {
                files: recorded_files(),
                recorded_objects: 4,
            },
            drift(
                DriftReason::NotRecorded,
                None,
                "alter table todos add column a text;",
            ),
            drift(
                DriftReason::NotRecorded,
                None,
                "alter table todos drop column a;",
            ),
        ];
        let guards = [
            UpgradeFlags::default(),
            yes(),
            UpgradeFlags {
                dry_run: true,
                ..UpgradeFlags::default()
            },
        ];
        for plan in &plans {
            for guard in &guards {
                let flagged = UpgradeFlags {
                    reapply: true,
                    ..guard.clone()
                };
                let (plain_applier, flagged_applier) = (provisioned(), provisioned());
                let (plain_code, plain) = drive(&plain_applier, plan, guard);
                let (flagged_code, with_flag) = drive(&flagged_applier, plan, &flagged);

                assert_eq!(flagged_code, plain_code, "{plan:?} {guard:?}");
                assert_eq!(with_flag.stdout(), plain.stdout(), "{plan:?} {guard:?}");
                assert_eq!(with_flag.stderr(), plain.stderr(), "{plan:?} {guard:?}");
                assert_eq!(
                    *flagged_applier.executed.borrow(),
                    *plain_applier.executed.borrow(),
                    "{plan:?} {guard:?}"
                );
            }
        }
    }
}
