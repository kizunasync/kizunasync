//! The pack gate every path that writes `kizunasync._config`,
//! `kizunasync._settings` or table triggers passes first.
//!
//! A pack edited in place changes its md5 while the ledger keeps the one the
//! install recorded, and a newer build can ship a pack file the ledger does not
//! record yet. Either way the plan reads as drift, and a write over it would
//! target a schema this CLI's pack does not describe (a column the installed
//! pack lacks, for one). On a terminal the gate offers the re-apply `kizunasync
//! upgrade --reapply` runs; without one it stops before anything is written and
//! names that command. `init` over a direct connection writes a confirmed
//! re-apply as a new migration pushed with the rest of its run; every other
//! path runs it at once (@docs/cli/cli.md).

use crate::applier::Applier;
use crate::commands::init::{STEP_BACK, cancel_or_stop};
use crate::commands::panel::equivalent::{Reach, render_over, render_over_unknown_url};
use crate::commands::upgrade::{self, ApplyEnd, Batch, UpgradeFlags, classify_batch};
use crate::commands::{OK, UNUSABLE};
use crate::prompts::{PromptError, Prompter};
use crate::provision::{DriftReason, LedgerRow, Plan};
use crate::ui::Ui;

/// How a confirmed re-apply reaches the database, which decides what the
/// offer says about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReapplyVia {
    /// Written as a new migration and pushed with the run's other migrations.
    Migration,
    /// Run at once over a direct connection.
    Connection,
    /// Run at once through the Management API, with no local tree to write
    /// into.
    ManagementApi,
}

impl ReapplyVia {
    /// What a yes does, ahead of [`REAPPLY_EFFECT`].
    const fn note(self) -> &'static str {
        match self {
            Self::Migration => {
                "This build's pack differs from the one this project records. On a yes it is written as a new migration in supabase/migrations, its SQL followed by the ledger row that records its md5, and supabase db push applies it with this run's other migrations once you confirm the plan, so the repository rebuilds to this pack. Nothing is written or applied before that."
            }
            Self::Connection => {
                "This build's pack differs from the one this project records. On a yes it runs over this connection the way `kizunasync upgrade --reapply` runs it, in one transaction that also records its md5 in the ledger. A failure rolls the whole batch back and leaves the ledger unchanged. No migration file records the re-apply."
            }
            Self::ManagementApi => {
                "This build's pack differs from the one this project records. On a yes it runs through the Management API in one transaction and records its md5 in the ledger; a failure rolls the whole batch back and leaves the ledger unchanged. The Management API path has no local project tree, so this run writes no local migration file for it: supabase/migrations does not record the re-apply."
            }
        }
    }

    /// The line a declined offer ends on, naming the command that re-applies
    /// the pack on its own.
    const fn declined(self) -> &'static str {
        match self {
            Self::Migration => {
                "  nothing written. `kizunasync upgrade --reapply --yes` re-applies it over the connection instead, with no migration file."
            }
            Self::Connection | Self::ManagementApi => {
                "  nothing applied. `kizunasync upgrade --reapply --yes` re-applies it on its own."
            }
        }
    }
}

/// What running the pack again does to a provisioned project, stated wherever
/// a re-apply is offered or refused.
pub(crate) const REAPPLY_EFFECT: &str = "A re-apply runs the pack again: it resets the kizunasync schema's grants for public, anon and authenticated to the pack's and recreates the pack's policies and its two change-stamp triggers, kizunasync_arm_stamp and kizunasync_stamp_transaction. Synced tables, their data, and kizunasync._settings stay as they are.";

/// The question every offer asks.
pub(crate) const REAPPLY_QUESTION: &str = "Re-apply the pack now?";

/// One line per pack file a re-apply would change, in name order: the md5 the
/// ledger records beside the one the shipped pack carries, or that the ledger
/// has no row for it. Empty unless the plan drifted.
pub(crate) fn describe_offenders(plan: &Plan) -> Vec<String> {
    let Plan::Drift { files, offending } = plan else {
        return Vec::new();
    };

    files
        .iter()
        .filter_map(|file| {
            let offender = offending
                .iter()
                .find(|offender| offender.name == file.name)?;
            let recorded = match offender.reason {
                DriftReason::HashMismatch => format!(
                    "ledger md5 {}",
                    offender.recorded_hash.as_deref().unwrap_or_default()
                ),
                DriftReason::NotRecorded => "not recorded in the ledger".to_owned(),
            };

            Some(format!(
                "    ! {}: {recorded}, pack md5 {}",
                file.name, file.content_hash
            ))
        })
        .collect()
}

/// Where the gate left a write path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Gated {
    /// The ledger records this CLI's pack, or there is no pack on disk to
    /// compare it with: the write goes on.
    Clear,
    /// Yes to the re-apply.
    Reapply,
    /// No: nothing was written, and the write path returns to the step
    /// before it.
    Declined,
}

/// What one write path's gate compares, and where a re-apply goes.
pub(crate) struct PackGate<'a> {
    /// This CLI's pack planned against `rows`, `None` without a pack on disk.
    pub(crate) plan: Option<&'a Plan>,
    /// The ledger rows the plan read.
    pub(crate) rows: &'a [LedgerRow],
    /// The connection the classification reads and an at-once re-apply runs
    /// over.
    pub(crate) applier: &'a dyn Applier,
    /// How a yes reaches the database.
    pub(crate) via: ReapplyVia,
    /// The connection the refusal's command names; `None` names none.
    pub(crate) reach: Option<Reach<'a>>,
    /// `--allow-no-cron`, for the schedules an at-once re-apply ends on.
    pub(crate) allow_no_cron: bool,
}

/// Offer a re-apply when the ledger's `pack-file` rows differ from this CLI's
/// pack: a changed hash, or a pack file the ledger does not record.
/// [`Gated::Reapply`] is a yes, which the caller writes.
///
/// A ledger that records a pack this build cannot reconcile is refused before
/// anything is asked, and so is a batch [`classify_batch`] finds breaking.
/// Without a prompter the run stops, naming the differing files and the
/// `kizunasync upgrade --reapply` command over `gate.reach`.
///
/// # Errors
/// Returns the exit code the run stops with: `2` for a ledger this build cannot
/// reconcile or a session that cannot be asked, `1` for a breaking file,
/// [`STEP_BACK`] for Backspace, and the cancel exit for a cancelled question.
pub(crate) fn ask_pack_gate(
    gate: &PackGate<'_>,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> Result<Gated, i32> {
    let Some((plan, batch)) = drifted(gate.plan) else {
        return Ok(Gated::Clear);
    };
    if let Some(code) = upgrade::refuse_ahead(ui, plan, gate.rows) {
        return Err(code);
    }

    let lines = describe_offenders(plan);
    let Some(prompter) = prompter.as_deref_mut() else {
        ui.error(&format!(
            "{}\n  this build's pack differs from the one the ledger records, so nothing was written. Re-apply it first with `{}`.",
            lines.join("\n"),
            reapply_command(gate.reach)
        ));

        return Err(UNUSABLE);
    };
    classify_batch(ui, gate.applier, batch.files(plan))?;

    let listed: Vec<&str> = lines.iter().map(|line| line.trim_start()).collect();
    // The note only decorates the question that follows; the answer decides.
    let _ = prompter.note(
        "Pack changed",
        &format!(
            "{}\n\n{} {REAPPLY_EFFECT}",
            listed.join("\n"),
            gate.via.note()
        ),
    );
    match prompter.confirm(REAPPLY_QUESTION, false) {
        Ok(true) => Ok(Gated::Reapply),
        Ok(false) => {
            ui.log(gate.via.declined());

            Ok(Gated::Declined)
        }
        Err(PromptError::Back) => Err(STEP_BACK),
        Err(error) => Err(cancel_or_stop(prompter, &error, ui)),
    }
}

/// [`ask_pack_gate`], then on a yes the batch `kizunasync upgrade --reapply
/// --yes` runs, over `gate.applier`: the pack files, the job schedules, and the
/// ledger summary. [`Gated::Reapply`] then means the pack ran.
///
/// # Errors
/// Returns the exits [`ask_pack_gate`] does as [`ApplyEnd::Exit`], and where
/// the apply ended when it did not end on `0`.
pub(crate) fn gate_pack(
    gate: &PackGate<'_>,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> Result<Gated, ApplyEnd> {
    let gated = ask_pack_gate(gate, prompter, ui).map_err(ApplyEnd::Exit)?;
    let (Gated::Reapply, Some((plan, batch))) = (gated, drifted(gate.plan)) else {
        return Ok(gated);
    };

    let flags = UpgradeFlags {
        yes: true,
        reapply: true,
        allow_no_cron: gate.allow_no_cron,
        ..UpgradeFlags::default()
    };
    match upgrade::apply_batch(ui, gate.applier, plan, &batch, &flags, gate.reach) {
        ApplyEnd::Exit(OK) => Ok(Gated::Reapply),
        end => Err(end),
    }
}

/// The drifted plan and the batch `upgrade --reapply` runs for it.
fn drifted(plan: Option<&Plan>) -> Option<(&Plan, Batch)> {
    let plan = plan.filter(|plan| matches!(plan, Plan::Drift { .. }))?;

    Some((plan, upgrade::batch_for(plan, true)?))
}

/// `kizunasync upgrade --reapply --yes`, over `reach` when there is one.
fn reapply_command(reach: Option<Reach<'_>>) -> String {
    command_over(reach, &["upgrade", "--reapply", "--yes"])
}

/// `kizunasync` with `args`, over `reach` when there is one.
fn command_over(reach: Option<Reach<'_>>, args: &[&str]) -> String {
    let args = owned(args);

    reach.map_or_else(
        || format!("kizunasync {}", args.join(" ")),
        |reach| render_over(reach, &args),
    )
}

/// The next step once the database refused a re-apply over a column or a table
/// it does not have. The pack's `create table if not exists` leaves a table an
/// earlier build created as it is, so only a fresh install over `reach`
/// reshapes it. `deprovision` takes no `--project-ref`, so over the Management
/// API both commands name the project's direct connection instead.
pub(crate) fn earlier_build_step(reach: Option<Reach<'_>>) -> String {
    let remove = ["deprovision", "--purge"];
    let (lead, remove, install) = match reach {
        Some(Reach::ProjectRef(_)) => (
            "The Management API path cannot run `kizunasync deprovision`, so remove Kizuna over the project's direct connection with",
            render_over_unknown_url(&owned(&remove)),
            render_over_unknown_url(&owned(&["init"])),
        ),
        Some(Reach::DbUrl(_)) | None => (
            "Remove Kizuna with",
            command_over(reach, &remove),
            command_over(reach, &["init"]),
        ),
    };

    format!(
        "the database holds kizunasync tables from an earlier build of the pack, which a re-apply does not reshape. {lead} `{remove}` (your application tables and their data stay), then install it again with `{install}`."
    )
}

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::applier::fake::{FakeApplier, text_row};
    use crate::commands::FAILURE;
    use crate::project_ref::ProjectRef;
    use crate::prompts::{Answer, Ask, ScriptedPrompter};
    use crate::provision::fake::changed_and_unrecorded;
    use crate::provision::{Drift, PlanFile, render_reconcile};
    use crate::ui::Capture;

    fn file(name: &str, sql: &str, hash: &str) -> PlanFile {
        PlanFile {
            name: name.to_owned(),
            sql: sql.to_owned(),
            content_hash: hash.to_owned(),
        }
    }

    fn mismatched() -> Plan {
        Plan::Drift {
            files: vec![file(
                "0001_kizuna_init.sql",
                "create or replace view v;\n",
                "new",
            )],
            offending: vec![Drift {
                name: "0001_kizuna_init.sql".to_owned(),
                reason: DriftReason::HashMismatch,
                recorded_hash: Some("old".to_owned()),
            }],
        }
    }

    /// A drift whose only offender is a file the ledger does not record yet.
    fn pending() -> Plan {
        Plan::Drift {
            files: vec![
                file("0001_kizuna_init.sql", "select 1;\n", "same"),
                file("0002_later.sql", "create or replace view w;\n", "later"),
            ],
            offending: vec![Drift {
                name: "0002_later.sql".to_owned(),
                reason: DriftReason::NotRecorded,
                recorded_hash: None,
            }],
        }
    }

    /// The one read the gate makes before it asks: the synced tables its
    /// files are classified against.
    const SYNCED_TABLES_READ: &str = "select * from kizunasync._config order by table_name;";

    const DB_URL: &str = "postgresql://postgres:secret@127.0.0.1:55322/kz_drift";

    fn schedules() -> FakeApplier {
        FakeApplier::new().answer(
            "_schedule_jobs()::text",
            vec![text_row(&[(
                "schedules",
                r#"{"jobs": {"kizunasync-reap-tombstones": "16 3 * * *"}, "pg_cron": true}"#,
            )])],
        )
    }

    /// The ledger [`mismatched`] was planned against, written by `version`.
    fn ledger(version: &str) -> Vec<LedgerRow> {
        vec![LedgerRow {
            object_kind: "pack-file".to_owned(),
            object_name: "0001_kizuna_init.sql".to_owned(),
            content_hash: "old".to_owned(),
            pack_version: version.to_owned(),
        }]
    }

    fn gate<'a>(
        plan: &'a Plan,
        rows: &'a [LedgerRow],
        applier: &'a FakeApplier,
        via: ReapplyVia,
    ) -> PackGate<'a> {
        PackGate {
            plan: Some(plan),
            rows,
            applier,
            via,
            reach: None,
            allow_no_cron: false,
        }
    }

    fn run(
        gate: &PackGate<'_>,
        prompter: Option<&mut ScriptedPrompter>,
    ) -> (Result<Gated, ApplyEnd>, Capture) {
        let (mut ui, capture) = Ui::capture();
        let mut prompter: Option<&mut dyn Prompter> =
            prompter.map(|prompter| prompter as &mut dyn Prompter);
        let result = gate_pack(gate, &mut prompter, &mut ui);

        (result, capture)
    }

    fn ask(gate: &PackGate<'_>, prompter: &mut ScriptedPrompter) -> (Result<Gated, i32>, Capture) {
        let (mut ui, capture) = Ui::capture();
        let mut lent: Option<&mut dyn Prompter> = Some(prompter);
        let result = ask_pack_gate(gate, &mut lent, &mut ui);

        (result, capture)
    }

    /// A newer build wrote the ledger: this one's pack would go over a pack it
    /// does not know, so nothing is asked or run, prompter or not.
    #[test]
    fn a_ledger_a_newer_build_wrote_is_refused_before_anything_is_asked() {
        let applier = schedules();
        let plan = mismatched();
        let rows = ledger("999.0.0");
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = run(
            &gate(&plan, &rows, &applier, ReapplyVia::Connection),
            Some(&mut prompter),
        );

        assert_eq!(result, Err(ApplyEnd::Exit(UNUSABLE)));
        assert!(prompter.asked().is_empty());
        assert!(applier.executed.borrow().is_empty());
        let stderr = capture.stderr();
        assert!(
            stderr.contains(
                "! 0001_kizuna_init.sql: recorded by kizunasync 999.0.0, newer than this build"
            ),
            "{stderr}"
        );
        assert!(stderr.contains("update kizunasync"), "{stderr}");
    }

    #[test]
    fn a_ledger_naming_a_file_this_build_does_not_ship_is_refused() {
        let applier = schedules();
        let plan = mismatched();
        let mut rows = ledger(crate::VERSION);
        rows.push(LedgerRow {
            object_name: "0009_later.sql".to_owned(),
            ..rows[0].clone()
        });
        let (result, capture) = run(&gate(&plan, &rows, &applier, ReapplyVia::Connection), None);

        assert_eq!(result, Err(ApplyEnd::Exit(UNUSABLE)));
        assert!(
            capture
                .stderr()
                .contains("! 0009_later.sql: recorded by kizunasync"),
            "{}",
            capture.stderr()
        );
        assert!(!capture.stderr().contains("upgrade --reapply"));
        assert!(applier.executed.borrow().is_empty());
    }

    /// An up-to-date plan, and a run with no pack on disk to plan with, pass
    /// the gate without a question or a statement.
    #[test]
    fn a_plan_that_does_not_drift_is_clear() {
        let applier = schedules();
        let rows = ledger(crate::VERSION);
        let up_to_date = Plan::UpToDate {
            files: vec![file("0001_kizuna_init.sql", "select 1;", "old")],
        };
        let mut prompter = ScriptedPrompter::new(Vec::new());
        let mut without_pack = gate(&up_to_date, &rows, &applier, ReapplyVia::Connection);
        let (up_to_date_result, up_to_date_capture) = run(
            &gate(&up_to_date, &rows, &applier, ReapplyVia::Connection),
            Some(&mut prompter),
        );
        without_pack.plan = None;
        let (without_pack_result, _) = run(&without_pack, None);

        assert_eq!(up_to_date_result, Ok(Gated::Clear));
        assert_eq!(without_pack_result, Ok(Gated::Clear));
        assert!(prompter.asked().is_empty());
        assert!(applier.executed.borrow().is_empty());
        assert_eq!(up_to_date_capture.stderr(), "");
    }

    /// A changed file beside one the ledger does not record: the re-apply runs
    /// both, so the note names both.
    fn changed_init_unrecorded_later(unrecorded_sql: &str) -> Plan {
        changed_and_unrecorded(
            file("0001_kizuna_init.sql", "create or replace view v;\n", "new"),
            file("0002_later.sql", unrecorded_sql, "later"),
        )
    }

    #[test]
    fn the_note_lists_a_not_recorded_file_beside_the_changed_one() {
        let applier = schedules();
        let plan = changed_init_unrecorded_later("create or replace view w;\n");
        let rows = ledger(crate::VERSION);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
        let (result, _) = run(
            &gate(&plan, &rows, &applier, ReapplyVia::Connection),
            Some(&mut prompter),
        );

        assert_eq!(result, Ok(Gated::Declined));
        let (_, body) = &prompter.notes()[0];
        assert!(
            body.starts_with(
                "! 0001_kizuna_init.sql: ledger md5 old, pack md5 new\n! 0002_later.sql: not recorded in the ledger, pack md5 later\n\n"
            ),
            "{body}"
        );
    }

    /// Every file the re-apply would run is classified against the synced
    /// tables first: a breaking statement refuses the batch before anything is
    /// asked.
    #[test]
    fn a_breaking_file_refuses_the_re_apply_before_anything_is_asked() {
        let applier = schedules().answer(
            SYNCED_TABLES_READ,
            vec![text_row(&[("table_name", "todos")])],
        );
        let plan = changed_init_unrecorded_later("alter table todos drop column title;\n");
        let rows = ledger(crate::VERSION);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = run(
            &gate(&plan, &rows, &applier, ReapplyVia::Connection),
            Some(&mut prompter),
        );
        let stderr = capture.stderr();

        assert_eq!(result, Err(ApplyEnd::Exit(FAILURE)));
        assert!(prompter.asked().is_empty());
        assert!(
            stderr.contains("BREAKING  0002_later.sql  [todos]"),
            "{stderr}"
        );
        assert!(
            stderr.contains("refusing: this pack change is breaking"),
            "{stderr}"
        );
        assert!(
            !applier
                .executed
                .borrow()
                .iter()
                .any(|sql| sql.contains("drop column title"))
        );
    }

    /// With nobody to ask, a changed hash and a file the ledger lacks both
    /// stop the run before anything is sent, naming the files and the
    /// re-apply over the same connection with its secrets left out.
    #[test]
    fn without_a_prompter_the_run_stops_naming_the_reapply_over_its_connection() {
        let applier = schedules();
        let rows = ledger(crate::VERSION);
        let project_ref = ProjectRef::parse("abcdefghijklmnopqrst").unwrap();
        for (plan, offender) in [
            (
                mismatched(),
                "    ! 0001_kizuna_init.sql: ledger md5 old, pack md5 new",
            ),
            (
                pending(),
                "    ! 0002_later.sql: not recorded in the ledger, pack md5 later",
            ),
        ] {
            for (reach, command) in [
                (
                    Some(Reach::DbUrl(DB_URL)),
                    "`PGPASSWORD=… kizunasync upgrade --reapply --yes --db-url postgresql://postgres@127.0.0.1:55322/kz_drift`",
                ),
                (
                    Some(Reach::ProjectRef(&project_ref)),
                    "`SUPABASE_ACCESS_TOKEN=… kizunasync upgrade --reapply --yes --project-ref abcdefghijklmnopqrst`",
                ),
                (None, "`kizunasync upgrade --reapply --yes`"),
            ] {
                let mut refused = gate(&plan, &rows, &applier, ReapplyVia::Connection);
                refused.reach = reach;
                let (result, capture) = run(&refused, None);
                let stderr = capture.stderr();

                assert_eq!(result, Err(ApplyEnd::Exit(UNUSABLE)), "{stderr}");
                assert!(stderr.contains(offender), "{stderr}");
                assert!(stderr.contains("nothing was written"), "{stderr}");
                assert!(stderr.contains(command), "{stderr}");
                assert!(!stderr.contains("secret"), "{stderr}");
            }
        }
        assert!(applier.executed.borrow().is_empty());
    }

    #[test]
    fn a_declined_reapply_runs_nothing_and_steps_back() {
        let applier = schedules();
        let plan = mismatched();
        let rows = ledger(crate::VERSION);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
        let (result, capture) = run(
            &gate(&plan, &rows, &applier, ReapplyVia::ManagementApi),
            Some(&mut prompter),
        );

        assert_eq!(result, Ok(Gated::Declined));
        assert_eq!(
            prompter.asked(),
            [Ask::Confirm {
                message: REAPPLY_QUESTION.to_owned(),
                default: false,
            }]
        );
        let (title, body) = &prompter.notes()[0];
        assert_eq!(title, "Pack changed");
        assert!(body.starts_with("! 0001_kizuna_init.sql: ledger md5 old, pack md5 new\n\n"));
        assert!(body.ends_with(&format!(
            "{} {REAPPLY_EFFECT}",
            ReapplyVia::ManagementApi.note()
        )));
        assert!(
            body.contains("grants for public, anon and authenticated"),
            "{body}"
        );
        assert!(capture.stderr().contains("nothing applied."));
        assert!(prompter.cancel_outros().is_empty());
        assert_eq!(*applier.executed.borrow(), [SYNCED_TABLES_READ]);
    }

    #[test]
    fn backspace_on_the_question_steps_back() {
        let applier = schedules();
        let plan = mismatched();
        let rows = ledger(crate::VERSION);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Back]);
        let (result, _) = run(
            &gate(&plan, &rows, &applier, ReapplyVia::Connection),
            Some(&mut prompter),
        );

        assert_eq!(result, Err(ApplyEnd::Exit(STEP_BACK)));
        assert_eq!(*applier.executed.borrow(), [SYNCED_TABLES_READ]);
    }

    /// Over a direct connection in `init`, a yes only answers the question:
    /// the migration is the caller's to write, so nothing but the synced-table
    /// read runs.
    #[test]
    fn a_yes_for_a_migration_runs_nothing_and_says_where_it_will_be_written() {
        let applier = schedules();
        let plan = mismatched();
        let rows = ledger(crate::VERSION);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = ask(
            &gate(&plan, &rows, &applier, ReapplyVia::Migration),
            &mut prompter,
        );

        assert_eq!(result, Ok(Gated::Reapply));
        assert_eq!(*applier.executed.borrow(), [SYNCED_TABLES_READ]);
        assert_eq!(capture.stderr(), "");
        let (_, body) = &prompter.notes()[0];
        assert!(body.ends_with(&format!(
            "{} {REAPPLY_EFFECT}",
            ReapplyVia::Migration.note()
        )));
        assert!(
            body.contains("written as a new migration in supabase/migrations"),
            "{body}"
        );
    }

    #[test]
    fn a_declined_migration_re_apply_says_nothing_was_written() {
        let applier = schedules();
        let plan = mismatched();
        let rows = ledger(crate::VERSION);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
        let (result, capture) = ask(
            &gate(&plan, &rows, &applier, ReapplyVia::Migration),
            &mut prompter,
        );

        assert_eq!(result, Ok(Gated::Declined));
        assert!(
            capture.stderr().contains(
                "  nothing written. `kizunasync upgrade --reapply --yes` re-applies it over the connection instead, with no migration file."
            ),
            "{}",
            capture.stderr()
        );
        assert_eq!(*applier.executed.borrow(), [SYNCED_TABLES_READ]);
    }

    /// A yes runs what `upgrade --reapply --yes` runs: one script carrying the
    /// whole transaction and the upserts, then the schedules read back from
    /// `kizunasync._settings`.
    #[test]
    fn a_confirmed_gate_runs_the_upgrade_reapply_then_the_schedules() {
        let applier = schedules();
        let plan = mismatched();
        let rows = ledger(crate::VERSION);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = run(
            &gate(&plan, &rows, &applier, ReapplyVia::Connection),
            Some(&mut prompter),
        );

        assert_eq!(result, Ok(Gated::Reapply));
        let executed = applier.executed.borrow().clone();
        assert_eq!(executed[0], SYNCED_TABLES_READ);
        assert_eq!(executed[1], render_reconcile(&plan));
        assert!(executed[2].contains("kizunasync._schedule_jobs()"));
        let stderr = capture.stderr();
        assert!(
            stderr.contains("re-applied 1 pack file(s) and recorded their hashes."),
            "{stderr}"
        );
        assert!(
            stderr.contains("kizunasync-reap-tombstones      16 3 * * *"),
            "{stderr}"
        );
    }

    /// A drift that only lacks a ledger row applies that file with its row,
    /// as `upgrade` applies a pending file.
    #[test]
    fn a_confirmed_pending_file_is_applied_with_its_ledger_row() {
        let applier = schedules();
        let plan = pending();
        let rows = ledger(crate::VERSION);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = run(
            &gate(&plan, &rows, &applier, ReapplyVia::Connection),
            Some(&mut prompter),
        );

        assert_eq!(result, Ok(Gated::Reapply), "{}", capture.stderr());
        let executed = applier.executed.borrow().clone();
        assert!(
            executed[1].contains("create or replace view w;"),
            "{executed:?}"
        );
        assert!(!executed[1].contains("select 1;"), "{executed:?}");
        assert!(capture.stderr().contains("applied 1 pack file(s)."));
    }

    #[test]
    fn a_failed_reapply_exits_one_and_names_the_rollback() {
        let applier = schedules().fail("create or replace view v", "permission denied");
        let plan = mismatched();
        let rows = ledger(crate::VERSION);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = run(
            &gate(&plan, &rows, &applier, ReapplyVia::Connection),
            Some(&mut prompter),
        );

        assert_eq!(result, Err(ApplyEnd::Exit(FAILURE)));
        let stderr = capture.stderr();
        assert!(!stderr.contains("earlier build"), "{stderr}");
        assert!(stderr.contains("permission denied"), "{stderr}");
        assert!(stderr.contains("the ledger is unchanged"), "{stderr}");
        assert!(
            !applier
                .executed
                .borrow()
                .iter()
                .any(|sql| sql.contains("_schedule_jobs()"))
        );
    }

    /// A yes whose re-apply the database refuses over a column the installed
    /// table lacks stops on [`ApplyEnd::EarlierBuild`], naming the fresh
    /// install over the gate's connection.
    #[test]
    fn a_re_apply_refused_over_a_missing_column_names_a_fresh_install() {
        let applier = schedules().fail_sql(
            "create or replace view v",
            "42703",
            "42703: column \"max_pull_scan\" of relation \"_settings\" does not exist",
        );
        let plan = mismatched();
        let rows = ledger(crate::VERSION);
        let mut refused = gate(&plan, &rows, &applier, ReapplyVia::Connection);
        refused.reach = Some(Reach::DbUrl(DB_URL));
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = run(&refused, Some(&mut prompter));
        let stderr = capture.stderr();

        assert_eq!(result, Err(ApplyEnd::EarlierBuild), "{stderr}");
        assert!(stderr.contains("the ledger is unchanged"), "{stderr}");
        assert!(
            stderr.contains(&format!(
                "the ledger is unchanged\n  {}",
                earlier_build_step(Some(Reach::DbUrl(DB_URL)))
            )),
            "{stderr}"
        );
        assert!(!stderr.contains("secret"), "{stderr}");
    }

    /// `deprovision` has no `--project-ref`, so over the Management API the
    /// step names both commands over a direct connection instead.
    #[test]
    fn the_fresh_install_over_the_management_api_names_a_direct_connection() {
        let project_ref = ProjectRef::parse("abcdefghijklmnopqrst").unwrap();

        assert_eq!(
            earlier_build_step(Some(Reach::ProjectRef(&project_ref))),
            "the database holds kizunasync tables from an earlier build of the pack, which a re-apply does not reshape. The Management API path cannot run `kizunasync deprovision`, so remove Kizuna over the project's direct connection with `PGPASSWORD=… kizunasync deprovision --purge --db-url <the project's connection string>` (your application tables and their data stay), then install it again with `PGPASSWORD=… kizunasync init --db-url <the project's connection string>`."
        );
    }

    #[test]
    fn the_fresh_install_names_both_commands_over_the_connection() {
        assert_eq!(
            earlier_build_step(Some(Reach::DbUrl(DB_URL))),
            "the database holds kizunasync tables from an earlier build of the pack, which a re-apply does not reshape. Remove Kizuna with `PGPASSWORD=… kizunasync deprovision --purge --db-url postgresql://postgres@127.0.0.1:55322/kz_drift` (your application tables and their data stay), then install it again with `PGPASSWORD=… kizunasync init --db-url postgresql://postgres@127.0.0.1:55322/kz_drift`."
        );
    }
}
