//! What one `init` run provisions, decided once for both transports.
//!
//! The local path introspects over a Postgres connection and the
//! `--project-ref` path over the Management API's SQL endpoint, but the
//! questions, the inference, and the resulting contracts are the same, so they
//! are asked here and nowhere else.

use std::collections::HashSet;

use crate::catalog::proposals_from_catalog;
use crate::commands::table_checks::{
    keyed_choice, note_unavailable, refuse_rls_disabled, refuse_unkeyed, warn_unscoped_proposals,
};
use crate::commands::{OK, UNUSABLE};
use crate::config::ProjectSettings;
use crate::docs;
use crate::prompts::{PromptError, Prompter, WizardMode};
use crate::proposals::{PolicyRow, SchemaCatalog, TableProposal, proposals_from_rows};
use crate::ui::Ui;
use crate::wizard::{Ladder, Reached, Step, table_choice};

use super::{InitFlags, STEP_BACK, Written, cancel_or_stop_after};

/// Everything a run decided: the tables to provision, the settings to write,
/// and what to do when pg_cron turns out to be absent.
pub(crate) struct Decided {
    pub(crate) proposals: Vec<TableProposal>,
    pub(crate) settings: Option<ProjectSettings>,
    pub(crate) allow_no_cron: bool,
}

/// The one live read the wizard needs, whichever transport answers it.
pub(crate) struct Introspection<'a> {
    pub(crate) introspect: &'a dyn Fn(&str) -> crate::error::Result<SchemaCatalog>,
}

/// The flag path: RLS policies propose the tables, the per-table flags answer
/// their contract, and the settings flags declare whatever they name.
pub(crate) fn decide_from_flags(flags: &InitFlags, policies: &[PolicyRow]) -> Decided {
    let proposals = proposals_from_rows(policies)
        .into_iter()
        .map(|proposal| flags.options.apply(proposal))
        .collect();

    Decided {
        proposals,
        settings: declared_settings(flags),
        allow_no_cron: flags.allow_no_cron,
    }
}

/// The settings a run declared through flags alone. `None` keeps the
/// `_settings` statement out of the migration entirely.
pub(crate) fn declared_settings(flags: &InitFlags) -> Option<ProjectSettings> {
    let declared = flags.settings.declared();

    declared.is_any_set().then_some(declared)
}

/// The wizard over one catalog: the table list, then the [`Ladder`] steps up
/// to the plan confirmation. It outlives that question, so Backspace on it
/// reopens the step before with every answer kept.
pub(crate) struct InteractiveDecision<'a> {
    flags: &'a InitFlags,
    catalog: SchemaCatalog,
    /// Every table the schema offers, as the catalog proposes it.
    offered: Vec<TableProposal>,
    /// The tables the list kept, with the per-table flags applied.
    chosen: Vec<TableProposal>,
    ladder: Ladder,
    /// What the run applied before the walk opened, which a stop names.
    written: Written,
}

impl<'a> InteractiveDecision<'a> {
    /// Read the catalog and open the walk on the table list.
    ///
    /// There is no schema question: the pack addresses `public.<table>` in
    /// every trigger and RPC, so `--schema` is the only way to name one and it
    /// accepts nothing else.
    ///
    /// `written` is what the run applied before this walk, which every stop
    /// in it names.
    ///
    /// # Errors
    /// Returns the exit code the command should stop with: `0` when the schema
    /// holds no table, `2` when the catalog cannot be read or the step cannot
    /// be drawn.
    pub(crate) fn open(
        flags: &'a InitFlags,
        introspection: &Introspection<'_>,
        written: Written,
        prompter: &mut dyn Prompter,
        ui: &mut Ui,
    ) -> Result<Self, i32> {
        let catalog = read_catalog(&flags.schema, introspection, prompter, ui)?;
        let offered = proposals_from_catalog(&catalog);
        if offered.is_empty() {
            ui.warn(&format!(
                "  no tables found in schema \"{}\", nothing to configure.",
                flags.schema
            ));

            return Err(OK);
        }

        if let Err(error) = prompter.phase(docs::TABLES_PHASE) {
            return Err(cancel_or_stop_after(prompter, &error, written, ui));
        }

        Ok(Self {
            flags,
            catalog,
            offered,
            chosen: Vec::new(),
            ladder: Ladder::new(&flags.settings.declared(), Some(flags.allow_no_cron)),
            written,
        })
    }

    /// Walk from the current step to the plan confirmation: the table list,
    /// recommended vs customize, and on customize the per-table ladder, the
    /// server sections, and the pg_cron policy.
    ///
    /// # Errors
    /// Returns the exit code the command should stop with: `0` when the user
    /// cancelled or selected nothing, `2` when a question could not be asked,
    /// and [`STEP_BACK`] for Backspace on the table list.
    pub(crate) fn decide(
        &mut self,
        prompter: &mut dyn Prompter,
        ui: &mut Ui,
    ) -> Result<Decided, i32> {
        loop {
            if self.ladder.step() == Step::Tables {
                self.choose_tables(prompter, ui)?;
            }
            match self.ladder.walk(prompter, &self.chosen, &self.catalog) {
                Ok(Reached::Tables) => {}
                Ok(Reached::Confirm) => {
                    let decided = self.decided();
                    warn_unscoped_proposals(&decided.proposals, ui);

                    return Ok(decided);
                }
                Err(error) => return Err(cancel_or_stop_after(prompter, &error, self.written, ui)),
            }
        }
    }

    /// Backspace on the plan confirmation: the step before it reopens on its
    /// last answer at the next [`Self::decide`].
    pub(crate) fn reopen_before_confirm(&mut self) {
        self.ladder.back();
    }

    fn choose_tables(&mut self, prompter: &mut dyn Prompter, ui: &mut Ui) -> Result<(), i32> {
        let choices: Vec<_> = self
            .offered
            .iter()
            .map(|proposal| {
                let checked = self.ladder.is_checked(&proposal.table, true);

                keyed_choice(table_choice(proposal, checked), &self.catalog)
            })
            .collect();
        note_unavailable(&choices, &self.catalog, prompter);
        let chosen = match prompter.select_tables(&choices) {
            Ok(chosen) => chosen,
            Err(PromptError::Back) => {
                self.ladder.back();

                return Err(STEP_BACK);
            }
            Err(error) => return Err(cancel_or_stop_after(prompter, &error, self.written, ui)),
        };
        let keep: HashSet<&str> = chosen.iter().map(String::as_str).collect();
        let proposals: Vec<TableProposal> = self
            .offered
            .iter()
            .filter(|proposal| keep.contains(proposal.table.as_str()))
            .cloned()
            .map(|proposal| self.flags.options.apply(proposal))
            .collect();
        if proposals.is_empty() {
            let _ = prompter.outro_cancel("No tables selected.");
            ui.log(self.written.no_tables());

            return Err(OK);
        }

        let tables = || proposals.iter().map(|proposal| proposal.table.as_str());
        if let Some(code) = refuse_unkeyed(tables(), &self.catalog, ui).or_else(|| {
            refuse_rls_disabled(
                tables(),
                &self.catalog.rls_disabled,
                self.flags.allow_no_rls,
                ui,
            )
        }) {
            let _ = prompter.outro_cancel(self.written.outro());

            return Err(code);
        }

        self.chosen = proposals;
        self.ladder.choose_tables(chosen);

        Ok(())
    }

    /// Recommended leaves every server knob to the flags; customize answered
    /// them, the pg_cron policy included.
    fn decided(&self) -> Decided {
        let (settings, allow_no_cron) = if self.ladder.mode() == WizardMode::Customize {
            (
                Some(self.ladder.settings().clone()),
                self.ladder
                    .cron_policy()
                    .unwrap_or(self.flags.allow_no_cron),
            )
        } else {
            (declared_settings(self.flags), self.flags.allow_no_cron)
        };

        Decided {
            proposals: self.ladder.proposals(&self.chosen),
            settings,
            allow_no_cron,
        }
    }
}

/// The schema's tables, columns, and policies, read behind the spinner the
/// wizard shows for the one step that is not instant.
fn read_catalog(
    schema: &str,
    introspection: &Introspection<'_>,
    prompter: &mut dyn Prompter,
    ui: &mut Ui,
) -> Result<SchemaCatalog, i32> {
    prompter.start_spin("Reading tables and RLS…");
    match (introspection.introspect)(schema) {
        Ok(catalog) => {
            prompter.stop_spin("Catalog ready");

            Ok(catalog)
        }
        Err(cause) => {
            prompter.stop_spin("Introspection failed");
            ui.error(&format!("  introspection failed:\n    {cause}"));

            Err(UNUSABLE)
        }
    }
}
