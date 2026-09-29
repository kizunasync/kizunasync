use crate::prompts::PromptError;
use crate::ui::Ui;

use super::{NOTHING_WRITTEN, SyncFlags, SyncPorts, TablePlan};

// MARK: - the plan report

pub(crate) fn describe_plan(plan: &TablePlan, migration_name: &str, ui: &mut Ui) {
    describe(plan, &format!("\n  migration:\n    + {migration_name}"), ui);
}

/// The same plan for a hosted project: there is no migration file, so the
/// delta is applied through the Management API's SQL endpoint instead.
pub(crate) fn describe_remote_plan(plan: &TablePlan, ui: &mut Ui) {
    describe(
        plan,
        "\n  applied over the Management API: no local migration is written.",
        ui,
    );
}

/// The plan body shared by the local and remote reports, ending on `outcome`:
/// where the delta went, then the removed-table retention note.
fn describe(plan: &TablePlan, outcome: &str, ui: &mut Ui) {
    ui.log("\n  plan:");
    for proposal in &plan.added {
        ui.log(&format!(
            "    + {}   {}",
            proposal.table, proposal.provenance
        ));
    }
    for line in updated_lines(plan) {
        ui.log(&line);
    }
    for table in &plan.removed {
        ui.log(&format!("    − {table}"));
    }
    ui.log(outcome);
    for table in &plan.removed {
        ui.log(&format!(
            "  note: the changelog and tombstone rows already recorded for {table} remain until retention reaps them."
        ));
    }
    ui.log("");
}

/// One line per already-synced table this run updates, naming the columns that
/// move: an update touches the `_config` row alone, so the report says which
/// options it writes and the reader can see the triggers are not in the plan.
fn updated_lines(plan: &TablePlan) -> Vec<String> {
    plan.updated
        .iter()
        .map(|update| {
            format!(
                "    ~ {}   updated: {}",
                update.table,
                update.declared.assignments().join(", ")
            )
        })
        .collect()
}

// MARK: - the confirmation gate

pub(crate) enum Gate {
    Proceed,
    Declined,
    Refuse,
    /// Backspace: the caller decides whether a step before it reopens.
    Back,
}

pub(crate) fn gate(
    flags: &SyncFlags,
    message: &str,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> Gate {
    if flags.yes {
        return Gate::Proceed;
    }

    let Some(prompter) = ports.prompter.as_deref_mut() else {
        return Gate::Refuse;
    };

    match prompter.confirm(message, false) {
        Ok(true) => Gate::Proceed,
        Ok(false) => Gate::Declined,
        Err(PromptError::Cancelled) => {
            let _ = prompter.outro_cancel(NOTHING_WRITTEN);

            Gate::Declined
        }
        Err(PromptError::Back) => Gate::Back,
        Err(error) => {
            ui.error(&format!("  the wizard could not ask: {error}"));

            Gate::Refuse
        }
    }
}
