//! The prompter every panel question and every hand-off asks through while the
//! panel is open.
//!
//! The panel owns the session: a hand-off's intro and outro would repaint the
//! banner or close the chrome the menu still draws on, so they are not
//! forwarded. A cancel a hand-off turns into its own clean exit is remembered,
//! so Ctrl+C anywhere closes the panel too.

use std::cell::Cell;

use crate::config::ProjectSettings;
use crate::discovery::ConnectionCandidate;
use crate::docs::DocsRef;
use crate::management::ProjectSummary;
use crate::prompts::{
    BackKey, Entry, PromptError, Prompter, Result, RetentionJobs, SectionChoice, ServerSection,
    TableChoice, TableStep, WizardMode,
};
use crate::proposals::{ColumnInfo, TableProposal};
use crate::solution::Solution;

use super::menu::{PanelAction, PanelItem};

/// The panel's session prompter, wrapping the one the bare flow opened.
pub(crate) struct Lent<'p, 'c> {
    inner: &'p mut (dyn Prompter + 'p),
    cancelled: &'c Cell<bool>,
}

impl<'p, 'c> Lent<'p, 'c> {
    /// Wrap `inner`; `cancelled` turns true at the first cancelled question.
    pub(crate) fn new(inner: &'p mut (dyn Prompter + 'p), cancelled: &'c Cell<bool>) -> Self {
        Self { inner, cancelled }
    }

    /// The prompter the session opened with, to close it or hand it back.
    pub(crate) fn into_inner(self) -> &'p mut (dyn Prompter + 'p) {
        self.inner
    }

    fn watch<T>(&self, asked: Result<T>) -> Result<T> {
        if matches!(asked, Err(PromptError::Cancelled)) {
            self.cancelled.set(true);
        }

        asked
    }
}

impl Prompter for Lent<'_, '_> {
    fn select_candidate(
        &mut self,
        candidates: &[ConnectionCandidate],
        current: Option<&ConnectionCandidate>,
    ) -> Result<ConnectionCandidate> {
        let asked = self.inner.select_candidate(candidates, current);
        self.watch(asked)
    }

    fn select_project(
        &mut self,
        projects: &[ProjectSummary],
        current: Option<&str>,
    ) -> Result<String> {
        let asked = self.inner.select_project(projects, current);
        self.watch(asked)
    }

    fn ask_access_token(&mut self) -> Result<String> {
        let asked = self.inner.ask_access_token();
        self.watch(asked)
    }

    fn select_tables(&mut self, choices: &[TableChoice]) -> Result<Vec<String>> {
        let asked = self.inner.select_tables(choices);
        self.watch(asked)
    }

    fn select_mode(&mut self, current: WizardMode) -> Result<WizardMode> {
        let asked = self.inner.select_mode(current);
        self.watch(asked)
    }

    fn select_section(
        &mut self,
        section: ServerSection,
        current: &ProjectSettings,
        choice: SectionChoice,
    ) -> Result<SectionChoice> {
        let asked = self.inner.select_section(section, current, choice);
        self.watch(asked)
    }

    fn ask_maintenance(
        &mut self,
        current: &ProjectSettings,
        entry: Entry,
    ) -> Result<ProjectSettings> {
        let asked = self.inner.ask_maintenance(current, entry);
        self.watch(asked)
    }

    fn ask_push_policy(&mut self, current: &ProjectSettings) -> Result<ProjectSettings> {
        let asked = self.inner.ask_push_policy(current);
        self.watch(asked)
    }

    fn ask_cron_policy(&mut self, allow_no_cron: bool) -> Result<bool> {
        let asked = self.inner.ask_cron_policy(allow_no_cron);
        self.watch(asked)
    }

    fn ask_retention_policy(&mut self, jobs: RetentionJobs, allow_no_cron: bool) -> Result<bool> {
        let asked = self.inner.ask_retention_policy(jobs, allow_no_cron);
        self.watch(asked)
    }

    fn customize_table(
        &mut self,
        proposal: &TableProposal,
        columns: &[ColumnInfo],
    ) -> Result<TableProposal> {
        let asked = self.inner.customize_table(proposal, columns);
        self.watch(asked)
    }

    fn customize_table_step(
        &mut self,
        proposal: &TableProposal,
        columns: &[ColumnInfo],
        entry: Entry,
    ) -> Result<TableStep> {
        let asked = self.inner.customize_table_step(proposal, columns, entry);
        self.watch(asked)
    }

    fn confirm(&mut self, message: &str, default: bool) -> Result<bool> {
        let asked = self.inner.confirm(message, default);
        self.watch(asked)
    }

    fn ask_db_url(&mut self, current: Option<&str>) -> Result<String> {
        let asked = self.inner.ask_db_url(current);
        self.watch(asked)
    }

    fn select_action(
        &mut self,
        message: &str,
        items: &[PanelItem],
        current: Option<PanelAction>,
        back: BackKey,
    ) -> Result<PanelAction> {
        let asked = self.inner.select_action(message, items, current, back);
        self.watch(asked)
    }

    fn ask_typed_confirmation(
        &mut self,
        message: &str,
        expected: &str,
        current: Option<&str>,
    ) -> Result<bool> {
        let asked = self
            .inner
            .ask_typed_confirmation(message, expected, current);
        self.watch(asked)
    }

    fn intro(&mut self, _step: DocsRef) -> Result<()> {
        Ok(())
    }

    fn phase(&mut self, step: DocsRef) -> Result<()> {
        self.inner.phase(step)
    }

    fn select_solution(&mut self) -> Result<Solution> {
        let asked = self.inner.select_solution();
        self.watch(asked)
    }

    fn outro(&mut self, _message: &str) -> Result<()> {
        Ok(())
    }

    fn outro_cancel(&mut self, _message: &str) -> Result<()> {
        Ok(())
    }

    fn note(&mut self, title: &str, message: &str) -> Result<()> {
        self.inner.note(title, message)
    }

    fn start_spin(&mut self, message: &str) {
        self.inner.start_spin(message);
    }

    fn stop_spin(&mut self, message: &str) {
        self.inner.stop_spin(message);
    }
}
