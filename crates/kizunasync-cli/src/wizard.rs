//! Shared wizard ladder used by `init` and `sync`.
//!
//! After the user picks tables, both commands show the inferred settings and
//! ask recommended vs customize; only on customize does the per-table ladder
//! run, followed by the server maintenance and push policy sections, each a
//! select that keeps the values it opens on or asks for custom ones. `init`
//! adds the pg_cron policy, because an install is the run that decides what
//! happens without the extension; the control panel's settings walk asks
//! instead how the retention jobs of the installed project run. The questions
//! are steps of one [`Ladder`]: each remembers its last answer and reopens on
//! it, and Backspace moves exactly one step back. A step made of several
//! questions (a table, a customized section) reopens on its last question.
//! The flag path never calls this.

use std::collections::BTreeMap;

use crate::config::{MaxBatchSize, ProjectSettings};
use crate::prompts::{
    Entry, PromptError, Prompter, RetentionJobs, SectionChoice, ServerSection, TableChoice,
    TableStep, WizardMode,
};
use crate::proposals::{
    Bucket, ColumnInfo, ConflictMode, SchemaCatalog, TableProposal, build_table_config,
};
use crate::wizard_theme::{self, Mark};

/// One line of inferred settings, then why, for the note that precedes the
/// mode question.
#[must_use]
pub fn proposal_summary(proposal: &TableProposal) -> String {
    let draft = build_table_config(proposal);
    let bucket = match &draft.bucket {
        Some(Bucket::ByOwner(column)) => format!("byOwner({column})"),
        Some(Bucket::ByColumn(column)) => format!("byColumn({column})"),
        None => "no bucket".to_owned(),
    };
    let conflict = draft.conflict.unwrap_or(ConflictMode::Arrival).as_str();
    let extra = match &draft.soft_delete {
        Some(column) => format!("  ·  soft-delete {column}"),
        None => String::new(),
    };

    format!(
        "{}  ·  {}  ·  {bucket}  ·  {conflict}{extra}\n  {}",
        proposal.table,
        draft.sync.as_str(),
        proposal.provenance
    )
}

/// The tables being configured, with the current one marked.
///
/// `●` is the table whose questions are on screen. `◼` is one already
/// answered. `○` is one still ahead. Same order the ladder walks.
#[must_use]
pub fn table_tabs(proposals: &[TableProposal], current: usize) -> String {
    let width = proposals
        .iter()
        .map(|proposal| proposal.table.chars().count())
        .max()
        .unwrap_or(0);

    proposals
        .iter()
        .enumerate()
        .map(|(index, proposal)| {
            let mark = match index.cmp(&current) {
                std::cmp::Ordering::Equal => "●",
                std::cmp::Ordering::Less => "◼",
                std::cmp::Ordering::Greater => "○",
            };
            format!(
                "{mark}  {table:<width$}  {hint}",
                table = proposal.table,
                hint = table_hint(proposal)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The Clack hint on a table checkbox: owner (or lack of one) and the inferred
/// sync mode.
#[must_use]
pub fn table_hint(proposal: &TableProposal) -> String {
    let draft = build_table_config(proposal);
    match proposal.owner_column.as_deref() {
        Some(owner) => format!("owner {owner} · {}", draft.sync.as_str()),
        None => format!("no owner · {}", draft.sync.as_str()),
    }
}

/// A checkbox row for `proposal`.
#[must_use]
pub fn table_choice(proposal: &TableProposal, checked: bool) -> TableChoice {
    TableChoice::new(&proposal.table, checked).with_hint(&table_hint(proposal))
}

// MARK: - the step machine

/// One question of the wizard once the connection is settled, in the order
/// both commands walk them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Which tables to sync. The caller asks it.
    Tables,
    /// Recommended vs customize.
    Mode,
    /// The per-table ladder, on the chosen table at this index.
    Table(usize),
    /// The server maintenance section.
    Maintenance,
    /// The server push policy.
    PushPolicy,
    /// The pg_cron policy: what an install does without pg_cron, or how the
    /// retention jobs of an installed project run.
    CronPolicy,
    /// The plan confirmation. The walk stops here, and the caller asks it.
    Confirm,
}

/// Where [`Ladder::walk`] handed the wizard back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reached {
    /// Backspace reopened the table list.
    Tables,
    /// Every step before the plan confirmation is answered.
    Confirm,
}

/// What one step's question came back with.
enum Moved {
    Forward,
    Back,
}

/// The steps between the table list and the plan confirmation, and the answer
/// each one last gave, so a step Backspace reopens starts from it.
pub struct Ladder {
    /// Every step on the way to the current one, with the terminal row its
    /// output starts on, the current step last.
    trail: Vec<(Step, Mark)>,
    /// The table list's last answer, `None` until it has one.
    chosen: Option<Vec<String>>,
    mode: WizardMode,
    /// Each table's last customize answer, by table name.
    answered: BTreeMap<String, TableProposal>,
    /// Both server sections' answers, composed over the values they opened on.
    settings: ProjectSettings,
    /// The pg_cron policy's answer, `None` when the walk does not ask it.
    cron_policy: Option<bool>,
    /// The question the pg_cron step asks.
    cron_question: CronQuestion,
    /// Each server section's last answer to its select.
    maintenance_choice: SectionChoice,
    push_choice: SectionChoice,
    /// Whether Backspace reopened the current step from the one after it, so
    /// a step of several questions opens on its last.
    returning: bool,
}

impl Ladder {
    /// A walk that starts on the table list.
    ///
    /// `base` is what the run already knows (a flag, or on `sync` the value
    /// the project carries), so a knob it names opens on that value and one
    /// it does not opens on the value the pack seeds. `cron_policy` is the
    /// pg_cron policy's opening answer, `None` for a walk that does not ask
    /// it.
    #[must_use]
    pub fn new(base: &ProjectSettings, cron_policy: Option<bool>) -> Self {
        Self::opening_on(Step::Tables, WizardMode::Recommended, base, cron_policy)
    }

    /// A walk over the server sections alone, for a project whose tables stay
    /// as they are: it opens on the maintenance section, and Backspace there
    /// hands back [`Reached::Tables`], the step this walk never asks. Its
    /// pg_cron step asks how the retention jobs run, stating `jobs`, what
    /// pg_cron schedules, and opening on it.
    #[must_use]
    pub fn settings_only(base: &ProjectSettings, jobs: RetentionJobs) -> Self {
        let mut ladder = Self::opening_on(
            Step::Maintenance,
            WizardMode::Customize,
            base,
            Some(jobs.by_hand()),
        );
        ladder.cron_question = CronQuestion::Retention(jobs);

        ladder
    }

    fn opening_on(
        step: Step,
        mode: WizardMode,
        base: &ProjectSettings,
        cron_policy: Option<bool>,
    ) -> Self {
        Self {
            trail: vec![(step, wizard_theme::mark())],
            chosen: None,
            mode,
            answered: BTreeMap::new(),
            settings: base.merged_with(Some(&ProjectSettings::pack_defaults())),
            cron_policy,
            cron_question: CronQuestion::Install,
            maintenance_choice: SectionChoice::Keep,
            push_choice: SectionChoice::Keep,
            returning: false,
        }
    }

    /// The step the walk is on.
    #[must_use]
    pub fn step(&self) -> Step {
        self.trail.last().map_or(Step::Tables, |(step, _)| *step)
    }

    /// Whether the table list opens with `table` checked: as its last answer
    /// left it, else `unanswered`.
    #[must_use]
    pub fn is_checked(&self, table: &str, unanswered: bool) -> bool {
        self.chosen
            .as_ref()
            .map_or(unanswered, |chosen| chosen.iter().any(|name| name == table))
    }

    /// Record the table list's answer and move on to the mode question.
    pub fn choose_tables(&mut self, chosen: Vec<String>) {
        self.chosen = Some(chosen);
        self.advance(Step::Mode);
    }

    /// Reopen the step before the current one, erasing both from the screen.
    /// `false` on the table list, which has no step before it; its own output
    /// is erased all the same.
    pub fn back(&mut self) -> bool {
        let Some((current, mark)) = self.trail.pop() else {
            return false;
        };
        let Some((previous, previous_mark)) = self.trail.pop() else {
            wizard_theme::rewind(mark);
            self.trail.push((current, wizard_theme::mark()));

            return false;
        };

        wizard_theme::rewind(previous_mark);
        self.trail.push((previous, wizard_theme::mark()));
        self.returning = true;

        true
    }

    /// Ask the steps between the table list and the plan confirmation,
    /// starting from the current one. `chosen` holds the contracts the table
    /// list kept, with any per-table flag already applied, in the order the
    /// per-table ladder walks them.
    ///
    /// # Errors
    /// Returns the [`PromptError`] a question stopped on. Backspace is not
    /// one: it reopens the step before, and before the mode question that is
    /// the table list, which [`Reached::Tables`] hands back.
    pub fn walk(
        &mut self,
        prompter: &mut dyn Prompter,
        chosen: &[TableProposal],
        catalog: &SchemaCatalog,
    ) -> std::result::Result<Reached, PromptError> {
        loop {
            let step = self.step();
            let entry = if self.returning {
                Entry::Last
            } else {
                Entry::First
            };
            let moved = match step {
                Step::Tables => return Ok(Reached::Tables),
                Step::Confirm => return Ok(Reached::Confirm),
                Step::Mode => self.ask_mode(prompter, chosen)?,
                Step::Table(index) => self.ask_table(prompter, chosen, index, catalog, entry)?,
                Step::Maintenance => self.ask_maintenance(prompter, entry)?,
                Step::PushPolicy => self.ask_push_policy(prompter, entry)?,
                Step::CronPolicy => self.ask_cron_policy(prompter)?,
            };
            match moved {
                Moved::Forward => self.advance(self.next(step, chosen.len())),
                Moved::Back => {
                    if !self.back() {
                        return Ok(Reached::Tables);
                    }
                }
            }
        }
    }

    /// The contracts to provision: `chosen` as the table list kept them, each
    /// replaced by its per-table answer when the mode is customize.
    #[must_use]
    pub fn proposals(&self, chosen: &[TableProposal]) -> Vec<TableProposal> {
        if self.mode != WizardMode::Customize {
            return chosen.to_vec();
        }

        chosen
            .iter()
            .map(|proposal| {
                self.answered
                    .get(&proposal.table)
                    .cloned()
                    .unwrap_or_else(|| proposal.clone())
            })
            .collect()
    }

    /// Recommended or customize, as last answered.
    #[must_use]
    pub const fn mode(&self) -> WizardMode {
        self.mode
    }

    /// The server sections' answers, over the values they opened on.
    #[must_use]
    pub const fn settings(&self) -> &ProjectSettings {
        &self.settings
    }

    /// The pg_cron policy as last answered, `None` for a walk that does not
    /// ask it.
    #[must_use]
    pub const fn cron_policy(&self) -> Option<bool> {
        self.cron_policy
    }

    /// The step an answered `step` leads to, `tables` being how many the table
    /// list kept.
    fn next(&self, step: Step, tables: usize) -> Step {
        match step {
            Step::Tables => Step::Mode,
            Step::Mode if self.mode == WizardMode::Customize && tables > 0 => Step::Table(0),
            Step::Table(index) if index + 1 < tables => Step::Table(index + 1),
            Step::Table(_) => Step::Maintenance,
            Step::Maintenance => Step::PushPolicy,
            Step::PushPolicy if self.cron_policy.is_some() => Step::CronPolicy,
            Step::Mode | Step::PushPolicy | Step::CronPolicy | Step::Confirm => Step::Confirm,
        }
    }

    fn advance(&mut self, next: Step) {
        // A finished table leaves the screen, so the next step starts on a
        // clear one, the same way Backspace removes the step it leaves.
        if let Some((Step::Table(_), mark)) = self.trail.last_mut() {
            wizard_theme::rewind(*mark);
            *mark = wizard_theme::mark();
        }
        self.trail.push((next, wizard_theme::mark()));
        self.returning = false;
    }

    fn ask_mode(
        &mut self,
        prompter: &mut dyn Prompter,
        chosen: &[TableProposal],
    ) -> std::result::Result<Moved, PromptError> {
        let summary = chosen
            .iter()
            .map(proposal_summary)
            .collect::<Vec<_>>()
            .join("\n");
        prompter.note("Inferred settings", &summary)?;
        let Some(mode) = answer(prompter.select_mode(self.mode))? else {
            return Ok(Moved::Back);
        };

        self.mode = mode;

        Ok(Moved::Forward)
    }

    fn ask_table(
        &mut self,
        prompter: &mut dyn Prompter,
        chosen: &[TableProposal],
        index: usize,
        catalog: &SchemaCatalog,
        entry: Entry,
    ) -> std::result::Result<Moved, PromptError> {
        let proposals = self.proposals(chosen);
        let Some(opening) = proposals.get(index) else {
            return Ok(Moved::Forward);
        };

        prompter.note(
            &format!(
                "Configuring {} · {} of {}",
                opening.table,
                index + 1,
                proposals.len()
            ),
            &table_tabs(&proposals, index),
        )?;
        let columns: &[ColumnInfo] = catalog
            .columns
            .get(&opening.table)
            .map_or(&[], Vec::as_slice);
        match answer(prompter.customize_table_step(opening, columns, entry))? {
            Some(TableStep::Done(answered)) => {
                self.answered.insert(opening.table.clone(), answered);

                Ok(Moved::Forward)
            }
            Some(TableStep::Back) | None => Ok(Moved::Back),
        }
    }

    fn ask_maintenance(
        &mut self,
        prompter: &mut dyn Prompter,
        entry: Entry,
    ) -> std::result::Result<Moved, PromptError> {
        let Some(maintenance) = self.ask_section(prompter, ServerSection::Maintenance, entry)?
        else {
            return Ok(Moved::Back);
        };

        // Each section owns its own columns, named here rather than merged, so
        // a backend that echoes the other half cannot answer for it.
        self.settings = ProjectSettings {
            max_batch_size: self.settings.max_batch_size,
            require_atomic: self.settings.require_atomic,
            ..maintenance
        };

        Ok(Moved::Forward)
    }

    fn ask_push_policy(
        &mut self,
        prompter: &mut dyn Prompter,
        entry: Entry,
    ) -> std::result::Result<Moved, PromptError> {
        let Some(push) = self.ask_section(prompter, ServerSection::PushPolicy, entry)? else {
            return Ok(Moved::Back);
        };

        self.settings.max_batch_size = push.max_batch_size;
        self.settings.require_atomic = push.require_atomic;

        Ok(Moved::Forward)
    }

    /// A server section: its select keeps the values it opens on or asks for
    /// custom ones. `None` is Backspace on the select; Backspace on the custom
    /// values reopens the select on its custom answer. Reopened from the step
    /// after it, a section answered with custom values opens on the last of
    /// them rather than on its select.
    fn ask_section(
        &mut self,
        prompter: &mut dyn Prompter,
        section: ServerSection,
        entry: Entry,
    ) -> std::result::Result<Option<ProjectSettings>, PromptError> {
        let mut on_values = entry == Entry::Last && *self.choice(section) == SectionChoice::Custom;
        loop {
            let opened = wizard_theme::mark();
            if !on_values {
                let opening = *self.choice(section);
                let asked = prompter.select_section(section, &self.settings, opening);
                let Some(choice) = answer(asked)? else {
                    return Ok(None);
                };
                *self.choice(section) = choice;
                if choice == SectionChoice::Keep {
                    return Ok(Some(self.settings.clone()));
                }
            }
            let custom = match section {
                ServerSection::Maintenance => {
                    let entry = if on_values { Entry::Last } else { Entry::First };
                    prompter.ask_maintenance(&self.settings, entry)
                }
                ServerSection::PushPolicy => prompter.ask_push_policy(&self.settings),
            };
            if let Some(settings) = answer(custom)? {
                return Ok(Some(settings));
            }

            wizard_theme::rewind(opened);
            on_values = false;
        }
    }

    fn choice(&mut self, section: ServerSection) -> &mut SectionChoice {
        match section {
            ServerSection::Maintenance => &mut self.maintenance_choice,
            ServerSection::PushPolicy => &mut self.push_choice,
        }
    }

    fn ask_cron_policy(
        &mut self,
        prompter: &mut dyn Prompter,
    ) -> std::result::Result<Moved, PromptError> {
        let opening = self.cron_policy.unwrap_or_default();
        let asked = match self.cron_question {
            CronQuestion::Install => prompter.ask_cron_policy(opening),
            CronQuestion::Retention(jobs) => prompter.ask_retention_policy(jobs, opening),
        };
        let Some(allow_no_cron) = answer(asked)? else {
            return Ok(Moved::Back);
        };

        self.cron_policy = Some(allow_no_cron);

        Ok(Moved::Forward)
    }
}

/// The question a walk's pg_cron step asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CronQuestion {
    /// An install's: stop it, or install anyway and run retention by hand.
    Install,
    /// An installed project's: keep these retention jobs scheduled, or run
    /// retention by hand.
    Retention(RetentionJobs),
}

/// A question's answer, with Backspace as `None`: a move, not a failure.
fn answer<T>(
    asked: std::result::Result<T, PromptError>,
) -> std::result::Result<Option<T>, PromptError> {
    match asked {
        Ok(value) => Ok(Some(value)),
        Err(PromptError::Back) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The settings half of the plan note: every project knob with the value this
/// run leaves in force, and whether the migration writes it or the pack's own
/// default stands.
#[must_use]
pub fn settings_note(declared: &ProjectSettings, allow_no_cron: bool) -> String {
    let effective = declared.merged_with(Some(&ProjectSettings::pack_defaults()));
    let lines = [
        (
            "largest push",
            describe_batch_size(effective.max_batch_size),
            declared.max_batch_size.is_some(),
        ),
        (
            "atomic pushes",
            describe_bool(effective.require_atomic, "required", "not required"),
            declared.require_atomic.is_some(),
        ),
        (
            "reap tombstones",
            describe_text(effective.reap_schedule.as_deref()),
            declared.reap_schedule.is_some(),
        ),
        (
            "compact changelog",
            describe_text(effective.compact_schedule.as_deref()),
            declared.compact_schedule.is_some(),
        ),
        (
            "prune clients",
            describe_text(effective.client_prune_schedule.as_deref()),
            declared.client_prune_schedule.is_some(),
        ),
        (
            "client retention",
            describe_days(effective.client_ttl_days),
            declared.client_ttl_days.is_some(),
        ),
        (
            "HLC skew ceiling",
            describe_millis(effective.hlc_max_skew_ms),
            declared.hlc_max_skew_ms.is_some(),
        ),
        (
            "tombstone retention",
            describe_days(effective.tombstone_ttl_days),
            declared.tombstone_ttl_days.is_some(),
        ),
        (
            "pull scan cap",
            describe_candidates(effective.max_pull_scan),
            declared.max_pull_scan.is_some(),
        ),
    ];
    let mut note: Vec<String> = lines
        .into_iter()
        .map(|(label, value, written)| {
            let source = if written {
                ""
            } else {
                " (pack default, left alone)"
            };
            format!("{label:<21}{value}{source}")
        })
        .collect();
    note.push(format!(
        "{:<21}{}",
        "pg_cron absent",
        if allow_no_cron {
            "install anyway, retention by hand"
        } else {
            "stop the install"
        }
    ));
    note.push("Schedules are UTC.".to_owned());

    note.join("\n")
}

fn describe_batch_size(size: Option<MaxBatchSize>) -> String {
    match size {
        None | Some(MaxBatchSize::Unlimited) => "unlimited".to_owned(),
        Some(MaxBatchSize::Mutations(size)) => format!("{size} mutations"),
    }
}

fn describe_bool(value: Option<bool>, yes: &str, no: &str) -> String {
    if value == Some(true) {
        yes.to_owned()
    } else {
        no.to_owned()
    }
}

fn describe_text(value: Option<&str>) -> String {
    value.unwrap_or("unset").to_owned()
}

fn describe_days(value: Option<i64>) -> String {
    value.map_or_else(|| "unset".to_owned(), |days| format!("{days} days"))
}

fn describe_millis(value: Option<i64>) -> String {
    value.map_or_else(|| "unset".to_owned(), |millis| format!("{millis} ms"))
}

fn describe_candidates(value: Option<i64>) -> String {
    value.map_or_else(
        || "unset".to_owned(),
        |candidates| format!("{candidates} candidates"),
    )
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::prompts::{
        Answer, Ask, Entry, PromptError, Prompter, ScriptedPrompter, SectionChoice, ServerSection,
        TableStep,
    };
    use crate::proposals::{ColumnInfo, SchemaCatalog, SyncMode, TableProposal};

    #[test]
    fn a_recommended_run_shows_every_default_and_says_it_writes_none_of_them() {
        let note = settings_note(&ProjectSettings::default(), false);

        assert!(note.contains("largest push         500 mutations (pack default, left alone)"));
        assert!(note.contains("reap tombstones      16 3 * * * (pack default, left alone)"));
        assert!(note.contains("compact changelog    47 3 * * * (pack default, left alone)"));
        assert!(note.contains("prune clients        31 3 * * * (pack default, left alone)"));
        assert!(note.contains("client retention     90 days (pack default, left alone)"));
        assert!(note.contains("HLC skew ceiling     5000 ms (pack default, left alone)"));
        assert!(note.contains("tombstone retention  30 days (pack default, left alone)"));
        assert!(note.contains("pull scan cap        5000 candidates (pack default, left alone)"));
        assert!(note.contains("pg_cron absent       stop the install"));
        assert!(note.contains("Schedules are UTC."));
    }

    #[test]
    fn a_declared_knob_loses_the_left_alone_note_and_shows_what_is_written() {
        let note = settings_note(
            &ProjectSettings {
                max_batch_size: Some(MaxBatchSize::Mutations(50)),
                reap_schedule: Some("0 4 * * *".to_owned()),
                ..ProjectSettings::default()
            },
            true,
        );

        assert!(note.contains("largest push         50 mutations\n"));
        assert!(note.contains("reap tombstones      0 4 * * *\n"));
        assert!(note.contains("compact changelog    47 3 * * * (pack default, left alone)"));
        assert!(note.contains("pg_cron absent       install anyway, retention by hand"));
    }

    #[test]
    fn a_declared_scan_cap_is_shown_as_written() {
        let note = settings_note(
            &ProjectSettings {
                max_pull_scan: Some(2500),
                ..ProjectSettings::default()
            },
            false,
        );

        assert!(
            note.contains("pull scan cap        2500 candidates\n"),
            "{note}"
        );
    }

    #[test]
    fn the_current_table_is_marked_and_the_others_are_not() {
        let tabs = table_tabs(
            &[
                TableProposal::derived("places", None, "places"),
                TableProposal::derived("users", Some("auth_user_id"), "users"),
            ],
            1,
        );

        assert_eq!(
            tabs,
            "◼  places  no owner · pull-only\n●  users   owner auth_user_id · read-write"
        );
    }

    #[test]
    fn a_table_still_ahead_stays_an_empty_circle() {
        let tabs = table_tabs(
            &[
                TableProposal::derived("places", None, "places"),
                TableProposal::derived("user_favorite_places", None, "user_favorite_places"),
                TableProposal::derived("users", Some("auth_user_id"), "users"),
            ],
            1,
        );

        assert_eq!(
            tabs,
            "\
◼  places                no owner · pull-only
●  user_favorite_places  no owner · pull-only
○  users                 owner auth_user_id · read-write"
        );
    }

    // MARK: - the step machine

    fn places() -> TableProposal {
        TableProposal::derived("places", None, "places")
    }

    fn users() -> TableProposal {
        TableProposal::derived("users", Some("auth_user_id"), "users")
    }

    /// A walk whose table list kept `chosen`, the way both commands open it.
    fn walked(chosen: &[TableProposal], cron_policy: Option<bool>) -> Ladder {
        let mut ladder = Ladder::new(&ProjectSettings::default(), cron_policy);
        ladder.choose_tables(
            chosen
                .iter()
                .map(|proposal| proposal.table.clone())
                .collect(),
        );

        ladder
    }

    fn walk(ladder: &mut Ladder, prompter: &mut dyn Prompter, chosen: &[TableProposal]) -> Reached {
        ladder
            .walk(prompter, chosen, &SchemaCatalog::default())
            .unwrap()
    }

    #[test]
    fn backing_out_of_the_first_table_can_keep_the_inferred_contracts() {
        let original = vec![places(), users()];
        let mut prompter = Stepper::new(
            vec![StepScript::PullOnly, StepScript::Back, StepScript::Back],
            vec![WizardMode::Customize, WizardMode::Recommended],
        );
        let mut ladder = walked(&original, None);

        assert_eq!(
            walk(&mut ladder, &mut prompter, &original),
            Reached::Confirm
        );
        assert_eq!(ladder.mode(), WizardMode::Recommended);
        assert_eq!(ladder.proposals(&original), original);
        assert_eq!(
            prompter.opened_modes,
            [WizardMode::Recommended, WizardMode::Customize],
            "the mode reopens on its last answer"
        );
        assert!(
            prompter
                .titles
                .iter()
                .any(|title| title.contains("Configuring places · 1 of 2")
                    && title.contains("●  places"))
        );
    }

    #[test]
    fn backing_from_a_later_table_reopens_the_previous_one_on_its_answer() {
        let original = vec![places(), users()];
        let mut prompter = Stepper::new(
            vec![
                StepScript::PullOnly,
                StepScript::Back,
                StepScript::PullOnly,
                StepScript::PullOnly,
            ],
            vec![WizardMode::Customize],
        );
        let mut ladder = walked(&original, None);

        assert_eq!(
            walk(&mut ladder, &mut prompter, &original),
            Reached::Confirm
        );
        assert_eq!(ladder.mode(), WizardMode::Customize);
        assert!(
            ladder
                .proposals(&original)
                .iter()
                .all(|proposal| proposal.sync == Some(SyncMode::PullOnly))
        );
        let configuring: Vec<&str> = prompter
            .titles
            .iter()
            .filter_map(|title| title.lines().next())
            .filter(|line| line.starts_with("Configuring"))
            .collect();
        assert_eq!(
            configuring,
            [
                "Configuring places · 1 of 2",
                "Configuring users · 2 of 2",
                "Configuring places · 1 of 2",
                "Configuring users · 2 of 2",
            ]
        );
        assert_eq!(
            prompter.opened[2].sync,
            Some(SyncMode::PullOnly),
            "places reopens on the answer it gave"
        );
    }

    /// Two rounds of answers for a customize walk over `places` and `users`.
    struct Rounds {
        places_first: TableProposal,
        users_first: TableProposal,
        maintenance_first: ProjectSettings,
        places_second: TableProposal,
        users_second: TableProposal,
        maintenance_second: ProjectSettings,
    }

    fn rounds() -> Rounds {
        let places_first = TableProposal {
            sync: Some(SyncMode::PullOnly),
            ..places()
        };
        let users_first = TableProposal {
            soft_delete: Some("deleted_at".to_owned()),
            ..users()
        };
        let maintenance_first = ProjectSettings {
            reap_schedule: Some("0 4 * * *".to_owned()),
            ..ProjectSettings::pack_defaults()
        };

        Rounds {
            places_second: TableProposal {
                min_schema_version: Some(2),
                ..places_first.clone()
            },
            users_second: TableProposal {
                register_clients: true,
                ..users_first.clone()
            },
            maintenance_second: ProjectSettings {
                client_ttl_days: Some(30),
                ..maintenance_first.clone()
            },
            places_first,
            users_first,
            maintenance_first,
        }
    }

    fn push_answer(size: i64) -> ProjectSettings {
        ProjectSettings {
            max_batch_size: Some(MaxBatchSize::Mutations(size)),
            ..ProjectSettings::default()
        }
    }

    /// The composed settings once `maintenance` and a push cap of `size` are
    /// answered.
    fn composed(maintenance: &ProjectSettings, size: i64) -> ProjectSettings {
        ProjectSettings {
            max_batch_size: Some(MaxBatchSize::Mutations(size)),
            require_atomic: None,
            ..maintenance.clone()
        }
    }

    /// The first round answered to the plan confirmation, then Backspace from
    /// the confirmation through every step to the table list: each customized
    /// section on its last value, then its select, and each table on its last
    /// question.
    fn backed_out(rounds: &Rounds) -> (Ladder, ScriptedPrompter) {
        let chosen = vec![places(), users()];
        let mut prompter = ScriptedPrompter::new(
            [
                Answer::Mode(WizardMode::Customize),
                Answer::Customize(rounds.places_first.clone()),
                Answer::Customize(rounds.users_first.clone()),
                Answer::Section(SectionChoice::Custom),
                Answer::Maintenance(rounds.maintenance_first.clone()),
                Answer::Section(SectionChoice::Custom),
                Answer::PushPolicy(push_answer(50)),
                Answer::CronPolicy(true),
            ]
            .into_iter()
            .chain(std::iter::repeat_n(Answer::Back, 8))
            .collect(),
        );
        let mut ladder = walked(&chosen, Some(false));

        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert!(ladder.back(), "the confirmation reopens the step before it");
        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Tables);
        assert_eq!(prompter.unused(), 0);

        (ladder, prompter)
    }

    #[test]
    fn a_back_at_every_step_reopens_the_one_before_on_its_last_answer() {
        let rounds = rounds();
        let (ladder, prompter) = backed_out(&rounds);
        let answered = composed(&rounds.maintenance_first, 50);

        assert_eq!(ladder.step(), Step::Tables);
        assert!(ladder.is_checked("places", false));
        assert!(ladder.is_checked("users", false));
        assert_eq!(
            prompter.asked(),
            [
                Ask::Mode {
                    current: WizardMode::Recommended
                },
                Ask::Customize {
                    current: places(),
                    entry: Entry::First,
                },
                Ask::Customize {
                    current: users(),
                    entry: Entry::First,
                },
                section(
                    ServerSection::Maintenance,
                    &ProjectSettings::pack_defaults()
                ),
                Ask::Maintenance {
                    current: ProjectSettings::pack_defaults(),
                    entry: Entry::First,
                },
                section(ServerSection::PushPolicy, &rounds.maintenance_first),
                Ask::PushPolicy {
                    current: rounds.maintenance_first.clone()
                },
                Ask::CronPolicy {
                    allow_no_cron: false
                },
                Ask::CronPolicy {
                    allow_no_cron: true
                },
                Ask::PushPolicy {
                    current: answered.clone()
                },
                section_on(ServerSection::PushPolicy, &answered, SectionChoice::Custom),
                Ask::Maintenance {
                    current: answered.clone(),
                    entry: Entry::Last,
                },
                section_on(ServerSection::Maintenance, &answered, SectionChoice::Custom),
                Ask::Customize {
                    current: rounds.users_first.clone(),
                    entry: Entry::Last,
                },
                Ask::Customize {
                    current: rounds.places_first.clone(),
                    entry: Entry::Last,
                },
                Ask::Mode {
                    current: WizardMode::Customize
                },
            ]
        );
    }

    /// After backing out to the table list, the steps open on the first
    /// round's answers and the walk ends on the second round's.
    #[test]
    fn answering_again_after_backing_out_ends_on_the_new_answers() {
        let rounds = rounds();
        let chosen = vec![places(), users()];
        let (mut ladder, _) = backed_out(&rounds);
        let mut prompter = ScriptedPrompter::new(vec![
            Answer::Mode(WizardMode::Customize),
            Answer::Customize(rounds.places_second.clone()),
            Answer::Customize(rounds.users_second.clone()),
            Answer::Section(SectionChoice::Custom),
            Answer::Maintenance(rounds.maintenance_second.clone()),
            Answer::Section(SectionChoice::Custom),
            Answer::PushPolicy(push_answer(80)),
            Answer::CronPolicy(false),
        ]);
        ladder.choose_tables(vec!["places".to_owned(), "users".to_owned()]);

        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert_eq!(
            ladder.proposals(&chosen),
            [rounds.places_second, rounds.users_second]
        );
        assert_eq!(ladder.settings(), &composed(&rounds.maintenance_second, 80));
        assert_eq!(ladder.cron_policy(), Some(false));
        assert_eq!(
            prompter.asked(),
            [
                Ask::Mode {
                    current: WizardMode::Customize
                },
                Ask::Customize {
                    current: rounds.places_first,
                    entry: Entry::First,
                },
                Ask::Customize {
                    current: rounds.users_first,
                    entry: Entry::First,
                },
                section_on(
                    ServerSection::Maintenance,
                    &composed(&rounds.maintenance_first, 50),
                    SectionChoice::Custom
                ),
                Ask::Maintenance {
                    current: composed(&rounds.maintenance_first, 50),
                    entry: Entry::First,
                },
                section_on(
                    ServerSection::PushPolicy,
                    &composed(&rounds.maintenance_second, 50),
                    SectionChoice::Custom
                ),
                Ask::PushPolicy {
                    current: composed(&rounds.maintenance_second, 50)
                },
                Ask::CronPolicy {
                    allow_no_cron: true
                },
            ]
        );
    }

    /// Backspace on the first question of a later table reopens the table
    /// before it on its last question, with that table's answers kept.
    #[test]
    fn backspace_on_a_later_tables_first_question_reopens_the_one_before_on_its_last() {
        let chosen = vec![places(), users()];
        let places_answer = TableProposal {
            sync: Some(SyncMode::PullOnly),
            tombstone_ttl_days: Some(14),
            ..places()
        };
        let mut prompter = ScriptedPrompter::new(vec![
            Answer::Mode(WizardMode::Customize),
            Answer::Customize(places_answer.clone()),
            Answer::Back,
            Answer::Customize(places_answer.clone()),
            Answer::Customize(users()),
            Answer::Section(SectionChoice::Keep),
            Answer::Section(SectionChoice::Keep),
        ]);
        let mut ladder = walked(&chosen, None);

        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert_eq!(prompter.unused(), 0);
        let tables: Vec<(TableProposal, Entry)> = prompter
            .asked()
            .iter()
            .filter_map(|ask| match ask {
                Ask::Customize { current, entry } => Some((current.clone(), *entry)),
                _ => None,
            })
            .collect();
        assert_eq!(
            tables,
            [
                (places(), Entry::First),
                (users(), Entry::First),
                (places_answer.clone(), Entry::Last),
                (users(), Entry::First),
            ]
        );
        assert_eq!(ladder.proposals(&chosen), [places_answer, users()]);
    }

    #[test]
    fn a_recommended_walk_backs_from_the_confirmation_to_the_mode_then_the_table_list() {
        let chosen = vec![places()];
        let mut prompter =
            ScriptedPrompter::new(vec![Answer::Mode(WizardMode::Recommended), Answer::Back]);
        let mut ladder = walked(&chosen, Some(false));

        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert!(ladder.back());
        assert_eq!(ladder.step(), Step::Mode);
        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Tables);
        assert_eq!(
            prompter.asked(),
            [
                Ask::Mode {
                    current: WizardMode::Recommended
                },
                Ask::Mode {
                    current: WizardMode::Recommended
                },
            ]
        );
    }

    #[test]
    fn a_walk_without_the_cron_policy_confirms_after_the_push_policy() {
        let chosen = vec![places()];
        let mut prompter = ScriptedPrompter::new(vec![
            Answer::Mode(WizardMode::Customize),
            Answer::Customize(places()),
            Answer::Section(SectionChoice::Custom),
            Answer::Maintenance(ProjectSettings::pack_defaults()),
            Answer::Section(SectionChoice::Custom),
            Answer::PushPolicy(ProjectSettings::pack_defaults()),
            Answer::Back,
            Answer::Back,
            Answer::Maintenance(ProjectSettings::pack_defaults()),
            Answer::Section(SectionChoice::Custom),
            Answer::PushPolicy(ProjectSettings::pack_defaults()),
        ]);
        let mut ladder = walked(&chosen, None);

        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert!(ladder.back());
        assert_eq!(ladder.step(), Step::PushPolicy);
        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert_eq!(prompter.unused(), 0);
        let steps: Vec<&str> = prompter
            .asked()
            .iter()
            .map(|ask| match ask {
                Ask::Mode { .. } => "mode",
                Ask::Customize { .. } => "table",
                Ask::Section {
                    section: ServerSection::Maintenance,
                    ..
                } => "maintenance select",
                Ask::Maintenance { .. } => "maintenance",
                Ask::Section {
                    section: ServerSection::PushPolicy,
                    ..
                } => "push select",
                Ask::PushPolicy { .. } => "push",
                other => panic!("not a step of this walk: {other:?}"),
            })
            .collect();
        assert_eq!(
            steps,
            [
                "mode",
                "table",
                "maintenance select",
                "maintenance",
                "push select",
                "push",
                "push",
                "push select",
                "maintenance",
                "push select",
                "push"
            ]
        );
        assert_eq!(ladder.cron_policy(), None);
    }

    /// Backspace on the pg_cron policy reopens the custom push value it
    /// followed, not the push select before that value.
    #[test]
    fn backspace_on_the_cron_policy_reopens_the_custom_push_value() {
        let chosen = vec![places()];
        let defaults = ProjectSettings::pack_defaults();
        let mut prompter = ScriptedPrompter::new(vec![
            Answer::Mode(WizardMode::Customize),
            Answer::Customize(places()),
            Answer::Section(SectionChoice::Keep),
            Answer::Section(SectionChoice::Custom),
            Answer::PushPolicy(push_answer(400)),
            Answer::Back,
            Answer::PushPolicy(push_answer(300)),
            Answer::CronPolicy(true),
        ]);
        let mut ladder = walked(&chosen, Some(false));

        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert_eq!(prompter.unused(), 0);
        assert_eq!(ladder.settings(), &composed(&defaults, 300));
        assert_eq!(
            section_asks(&prompter)[2..],
            [
                section(ServerSection::PushPolicy, &defaults),
                Ask::PushPolicy {
                    current: defaults.clone()
                },
                Ask::CronPolicy {
                    allow_no_cron: false
                },
                Ask::PushPolicy {
                    current: composed(&defaults, 400)
                },
                Ask::CronPolicy {
                    allow_no_cron: false
                },
            ]
        );
    }

    /// A scripted backend answers only the columns its step owns, so the
    /// composed declaration has to carry both halves.
    #[test]
    fn the_push_half_is_composed_over_the_maintenance_half_not_instead_of_it() {
        let chosen = vec![places()];
        let mut prompter = ScriptedPrompter::new(vec![
            Answer::Mode(WizardMode::Customize),
            Answer::Customize(places()),
            Answer::Section(SectionChoice::Custom),
            Answer::Maintenance(ProjectSettings {
                reap_schedule: Some("0 4 * * *".to_owned()),
                max_batch_size: Some(MaxBatchSize::Mutations(999)),
                ..ProjectSettings::default()
            }),
            Answer::Section(SectionChoice::Custom),
            Answer::PushPolicy(ProjectSettings {
                max_batch_size: Some(MaxBatchSize::Mutations(25)),
                reap_schedule: Some("9 9 * * *".to_owned()),
                ..ProjectSettings::default()
            }),
            Answer::CronPolicy(false),
        ]);
        let mut ladder = walked(&chosen, Some(false));

        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert_eq!(
            ladder.settings().reap_schedule.as_deref(),
            Some("0 4 * * *")
        );
        assert_eq!(
            ladder.settings().max_batch_size,
            Some(MaxBatchSize::Mutations(25))
        );
    }

    // MARK: - the server sections' select

    fn section(section: ServerSection, current: &ProjectSettings) -> Ask {
        section_on(section, current, SectionChoice::Keep)
    }

    fn section_on(section: ServerSection, current: &ProjectSettings, choice: SectionChoice) -> Ask {
        Ask::Section {
            section,
            current: current.clone(),
            choice,
        }
    }

    /// A customize walk over `places`, answered from `answers` after the mode
    /// and the table, then handed back at the confirmation.
    fn walk_sections(answers: Vec<Answer>) -> (Ladder, ScriptedPrompter) {
        let chosen = vec![places()];
        let mut prompter = ScriptedPrompter::new(
            [
                Answer::Mode(WizardMode::Customize),
                Answer::Customize(places()),
            ]
            .into_iter()
            .chain(answers)
            .collect(),
        );
        let mut ladder = walked(&chosen, None);

        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert_eq!(prompter.unused(), 0);

        (ladder, prompter)
    }

    /// The questions asked after the mode and the table.
    fn section_asks(prompter: &ScriptedPrompter) -> Vec<Ask> {
        prompter
            .asked()
            .iter()
            .filter(|ask| !matches!(ask, Ask::Mode { .. }))
            .cloned()
            .collect()
    }

    #[test]
    fn keeping_both_sections_leaves_the_values_they_opened_on() {
        let (ladder, prompter) = walk_sections(vec![
            Answer::Section(SectionChoice::Keep),
            Answer::Section(SectionChoice::Keep),
        ]);
        let defaults = ProjectSettings::pack_defaults();

        assert_eq!(ladder.settings(), &defaults);
        assert_eq!(
            section_asks(&prompter),
            [
                Ask::Customize {
                    current: places(),
                    entry: Entry::First,
                },
                section(ServerSection::Maintenance, &defaults),
                section(ServerSection::PushPolicy, &defaults),
            ]
        );
    }

    #[test]
    fn the_custom_branch_asks_each_value_and_keeps_what_it_answered() {
        let maintenance = ProjectSettings {
            reap_schedule: Some("0 4 * * *".to_owned()),
            ..ProjectSettings::pack_defaults()
        };
        let (ladder, prompter) = walk_sections(vec![
            Answer::Section(SectionChoice::Custom),
            Answer::Maintenance(maintenance.clone()),
            Answer::Section(SectionChoice::Custom),
            Answer::PushPolicy(push_answer(25)),
        ]);

        assert_eq!(ladder.settings(), &composed(&maintenance, 25));
        assert_eq!(
            section_asks(&prompter),
            [
                Ask::Customize {
                    current: places(),
                    entry: Entry::First,
                },
                section(
                    ServerSection::Maintenance,
                    &ProjectSettings::pack_defaults()
                ),
                Ask::Maintenance {
                    current: ProjectSettings::pack_defaults(),
                    entry: Entry::First,
                },
                section(ServerSection::PushPolicy, &maintenance),
                Ask::PushPolicy {
                    current: maintenance.clone()
                },
            ]
        );
    }

    #[test]
    fn backspace_on_the_maintenance_select_reopens_the_last_table_on_its_last_question() {
        let (_, prompter) = walk_sections(vec![
            Answer::Back,
            Answer::Customize(places()),
            Answer::Section(SectionChoice::Keep),
            Answer::Section(SectionChoice::Keep),
        ]);
        let defaults = ProjectSettings::pack_defaults();

        assert_eq!(
            section_asks(&prompter),
            [
                Ask::Customize {
                    current: places(),
                    entry: Entry::First,
                },
                section(ServerSection::Maintenance, &defaults),
                Ask::Customize {
                    current: places(),
                    entry: Entry::Last,
                },
                section(ServerSection::Maintenance, &defaults),
                section(ServerSection::PushPolicy, &defaults),
            ]
        );
    }

    /// Backspace on the push policy's select after custom maintenance values
    /// reopens the last of those values, then the maintenance select on its
    /// custom answer.
    #[test]
    fn backspace_on_the_push_select_reopens_the_last_custom_maintenance_value() {
        let maintenance = ProjectSettings {
            reap_schedule: Some("0 4 * * *".to_owned()),
            ..ProjectSettings::pack_defaults()
        };
        let (ladder, prompter) = walk_sections(vec![
            Answer::Section(SectionChoice::Custom),
            Answer::Maintenance(maintenance.clone()),
            Answer::Back,
            Answer::Back,
            Answer::Section(SectionChoice::Keep),
            Answer::Section(SectionChoice::Keep),
        ]);

        assert_eq!(ladder.settings(), &maintenance);
        assert_eq!(
            section_asks(&prompter)[3..],
            [
                section(ServerSection::PushPolicy, &maintenance),
                Ask::Maintenance {
                    current: maintenance.clone(),
                    entry: Entry::Last,
                },
                section_on(
                    ServerSection::Maintenance,
                    &maintenance,
                    SectionChoice::Custom
                ),
                section(ServerSection::PushPolicy, &maintenance),
            ]
        );
    }

    /// Kept maintenance values have no input to return to: Backspace on the
    /// push select reopens the maintenance select on Keep.
    #[test]
    fn backspace_on_the_push_select_after_kept_values_reopens_the_maintenance_select() {
        let (_, prompter) = walk_sections(vec![
            Answer::Section(SectionChoice::Keep),
            Answer::Back,
            Answer::Section(SectionChoice::Keep),
            Answer::Section(SectionChoice::Keep),
        ]);
        let defaults = ProjectSettings::pack_defaults();

        assert_eq!(
            section_asks(&prompter)[1..],
            [
                section(ServerSection::Maintenance, &defaults),
                section(ServerSection::PushPolicy, &defaults),
                section(ServerSection::Maintenance, &defaults),
                section(ServerSection::PushPolicy, &defaults),
            ]
        );
    }

    /// Backing out of both sections from the confirmation and keeping them
    /// both on the way back ends on the values answered the first time.
    #[test]
    fn a_revisited_section_keeps_its_remembered_values_on_the_first_option() {
        let maintenance = ProjectSettings {
            client_ttl_days: Some(30),
            ..ProjectSettings::pack_defaults()
        };
        let (mut ladder, _) = walk_sections(vec![
            Answer::Section(SectionChoice::Custom),
            Answer::Maintenance(maintenance.clone()),
            Answer::Section(SectionChoice::Custom),
            Answer::PushPolicy(push_answer(25)),
        ]);
        let remembered = composed(&maintenance, 25);
        let chosen = vec![places()];
        let mut prompter = ScriptedPrompter::new(vec![
            Answer::Back,
            Answer::Back,
            Answer::Back,
            Answer::Section(SectionChoice::Keep),
            Answer::Section(SectionChoice::Keep),
        ]);

        assert!(ladder.back());
        assert_eq!(walk(&mut ladder, &mut prompter, &chosen), Reached::Confirm);
        assert_eq!(ladder.settings(), &remembered);
        assert_eq!(
            prompter.asked(),
            [
                Ask::PushPolicy {
                    current: remembered.clone()
                },
                section_on(
                    ServerSection::PushPolicy,
                    &remembered,
                    SectionChoice::Custom
                ),
                Ask::Maintenance {
                    current: remembered.clone(),
                    entry: Entry::Last,
                },
                section_on(
                    ServerSection::Maintenance,
                    &remembered,
                    SectionChoice::Custom
                ),
                section_on(
                    ServerSection::PushPolicy,
                    &remembered,
                    SectionChoice::Custom
                ),
            ]
        );
    }

    /// Backspace on the first custom value reopens the section's select on
    /// the custom option it answered.
    #[test]
    fn backspace_on_the_custom_values_reopens_the_sections_select() {
        let (ladder, prompter) = walk_sections(vec![
            Answer::Section(SectionChoice::Custom),
            Answer::Back,
            Answer::Section(SectionChoice::Keep),
            Answer::Section(SectionChoice::Keep),
        ]);
        let defaults = ProjectSettings::pack_defaults();

        assert_eq!(ladder.settings(), &defaults);
        assert_eq!(
            section_asks(&prompter),
            [
                Ask::Customize {
                    current: places(),
                    entry: Entry::First,
                },
                section(ServerSection::Maintenance, &defaults),
                Ask::Maintenance {
                    current: defaults.clone(),
                    entry: Entry::First,
                },
                section_on(ServerSection::Maintenance, &defaults, SectionChoice::Custom),
                section(ServerSection::PushPolicy, &defaults),
            ]
        );
    }

    #[test]
    fn a_back_on_the_table_list_has_no_step_before_it() {
        let mut ladder = Ladder::new(&ProjectSettings::default(), None);

        assert!(!ladder.back());
        assert_eq!(ladder.step(), Step::Tables);
        assert!(
            ladder.is_checked("places", true),
            "unanswered, the caller decides"
        );
        assert!(!ladder.is_checked("places", false));
    }

    /// A prompter whose per-table ladder answers the way the terminal does:
    /// `TableStep::Back` when the first question is left, not an error.
    struct Stepper {
        steps: Vec<StepScript>,
        modes: Vec<WizardMode>,
        titles: Vec<String>,
        opened: Vec<TableProposal>,
        opened_modes: Vec<WizardMode>,
    }

    impl Stepper {
        fn new(steps: Vec<StepScript>, modes: Vec<WizardMode>) -> Self {
            Self {
                steps,
                modes,
                titles: Vec::new(),
                opened: Vec::new(),
                opened_modes: Vec::new(),
            }
        }
    }

    enum StepScript {
        Back,
        PullOnly,
    }

    impl Prompter for Stepper {
        fn select_candidate(
            &mut self,
            _candidates: &[crate::discovery::ConnectionCandidate],
            _current: Option<&crate::discovery::ConnectionCandidate>,
        ) -> crate::prompts::Result<crate::discovery::ConnectionCandidate> {
            unused("candidate")
        }

        fn select_project(
            &mut self,
            _projects: &[crate::management::ProjectSummary],
            _current: Option<&str>,
        ) -> crate::prompts::Result<String> {
            unused("project")
        }

        fn ask_access_token(&mut self) -> crate::prompts::Result<String> {
            unused("token")
        }

        fn select_tables(
            &mut self,
            _choices: &[TableChoice],
        ) -> crate::prompts::Result<Vec<String>> {
            unused("tables")
        }

        fn select_mode(&mut self, current: WizardMode) -> crate::prompts::Result<WizardMode> {
            self.opened_modes.push(current);
            Ok(self.modes.remove(0))
        }

        fn select_section(
            &mut self,
            _section: ServerSection,
            _current: &ProjectSettings,
            _choice: SectionChoice,
        ) -> crate::prompts::Result<SectionChoice> {
            Ok(SectionChoice::Keep)
        }

        fn ask_maintenance(
            &mut self,
            current: &ProjectSettings,
            _entry: Entry,
        ) -> crate::prompts::Result<ProjectSettings> {
            Ok(current.clone())
        }

        fn ask_push_policy(
            &mut self,
            current: &ProjectSettings,
        ) -> crate::prompts::Result<ProjectSettings> {
            Ok(current.clone())
        }

        fn ask_cron_policy(&mut self, _allow_no_cron: bool) -> crate::prompts::Result<bool> {
            unused("cron")
        }

        fn ask_retention_policy(
            &mut self,
            _jobs: crate::prompts::RetentionJobs,
            _allow_no_cron: bool,
        ) -> crate::prompts::Result<bool> {
            unused("retention")
        }

        fn customize_table(
            &mut self,
            proposal: &TableProposal,
            _columns: &[ColumnInfo],
        ) -> crate::prompts::Result<TableProposal> {
            Ok(proposal.clone())
        }

        fn customize_table_step(
            &mut self,
            proposal: &TableProposal,
            _columns: &[ColumnInfo],
            _entry: Entry,
        ) -> crate::prompts::Result<TableStep> {
            self.opened.push(proposal.clone());
            match self.steps.remove(0) {
                StepScript::Back => Ok(TableStep::Back),
                StepScript::PullOnly => {
                    let mut answered = proposal.clone();
                    answered.sync = Some(SyncMode::PullOnly);
                    Ok(TableStep::Done(answered))
                }
            }
        }

        fn confirm(&mut self, _message: &str, _default: bool) -> crate::prompts::Result<bool> {
            unused("confirm")
        }

        fn ask_db_url(&mut self, _current: Option<&str>) -> crate::prompts::Result<String> {
            unused("db")
        }

        fn select_action(
            &mut self,
            _message: &str,
            _items: &[crate::commands::panel::PanelItem],
            _current: Option<crate::commands::panel::PanelAction>,
            _back: crate::prompts::BackKey,
        ) -> crate::prompts::Result<crate::commands::panel::PanelAction> {
            unused("action")
        }

        fn ask_typed_confirmation(
            &mut self,
            _message: &str,
            _expected: &str,
            _current: Option<&str>,
        ) -> crate::prompts::Result<bool> {
            unused("typed")
        }

        fn note(&mut self, title: &str, message: &str) -> crate::prompts::Result<()> {
            self.titles.push(format!("{title}\n{message}"));
            Ok(())
        }
    }

    fn unused<T>(what: &str) -> crate::prompts::Result<T> {
        Err(PromptError::Script(what.to_owned()))
    }
}
