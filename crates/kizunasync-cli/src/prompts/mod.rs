//! Interactive prompts for the setup and sync wizards.
//!
//! Both `init` and `sync` use the [`Prompter`] interface to walk through
//! setup: choosing a discovered connection (and, if needed, selecting a
//! project or pasting a token), picking tables, choosing between recommended
//! settings or customization, and, when customizing, configuring settings for
//! each table, then maintenance options, push policy, pg_cron policy, and a
//! confirmation step. A missing connection prompts for a connection string.
//! The control panel of bare `kizunasync` adds its menu and the typed target
//! a removal asks for.
//!
//! Production uses [`CliclackPrompter`] for themed, Clack-style prompts; tests
//! use [`ScriptedPrompter`]. Prompts are all managed here, so command logic
//! never talks to `cliclack` directly, and the full flow runs without a
//! terminal.
//!
//! A prompt only appears on an interactive run. When the process is not
//! connected to a TTY (a CI job, a piped invocation), [`CliclackPrompter::new`]
//! errors with [`PromptError::NotInteractive`], which tells the caller to pass
//! the flags instead.
//!
//! A connection string given to [`Prompter::ask_db_url`] is masked while
//! typed, stays in memory only, and is never written to disk or a config
//! file.

use std::io::IsTerminal;

use crate::commands::panel::{PanelAction, PanelItem};
use crate::config::ProjectSettings;
use crate::discovery::ConnectionCandidate;
use crate::docs::DocsRef;
use crate::management::ProjectSummary;
use crate::proposals::ColumnInfo;
use crate::proposals::TableProposal;

mod cliclack;
mod keys;
mod scripted;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

pub use cliclack::CliclackPrompter;
pub use scripted::{Answer, Ask, ScriptedPrompter};

const TABLES_MESSAGE: &str = "Which tables should Kizuna sync?";
const MODE_MESSAGE: &str = "How should Kizuna configure these tables?";
pub(crate) const PUSH_POLICY_MESSAGE: &str = "Server push policy";
pub(crate) const MAINTENANCE_MESSAGE: &str = "Server maintenance";
pub(crate) const CRON_POLICY_MESSAGE: &str = "If pg_cron is not enabled";
pub(crate) const RETENTION_POLICY_MESSAGE: &str = "How should the retention jobs run?";
pub(crate) const MAX_BATCH_MESSAGE: &str =
    "Largest push the server accepts (an emptied field saves no cap)";
const DB_URL_MESSAGE: &str =
    "Postgres connection string (session pooler URL, kept in memory only):";
const CANDIDATE_MESSAGE: &str = "How should Kizuna reach your database?";
const PROJECT_MESSAGE: &str = "Which Supabase project?";
const ACCESS_TOKEN_MESSAGE: &str = "Supabase Personal Access Token (sbp_…, kept in memory only):";

/// Why a question produced no answer.
///
/// The three cases are different exits, not shades of one failure:
/// [`Self::NotInteractive`] is a usage error (exit 2: pass the flags),
/// [`Self::Cancelled`] is the user declining (nothing written, exit 0), and the
/// rest are real failures.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PromptError {
    /// There is no terminal to ask on. Callers must take the flag path.
    #[error("no terminal to prompt on: pass the flags instead")]
    NotInteractive,
    /// The user pressed Esc or Ctrl+C.
    #[error("cancelled at the prompt")]
    Cancelled,
    /// The user pressed Backspace to reopen the previous question.
    #[error("back to the previous question")]
    Back,
    /// The prompt backend failed (terminal I/O, invalid configuration).
    #[error("{0}")]
    Backend(String),
    /// A [`ScriptedPrompter`] was asked something its script does not answer.
    #[error("{0}")]
    Script(String),
}

/// Result alias for the wizard's questions.
pub type Result<T> = std::result::Result<T, PromptError>;

/// What Backspace does on a select.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackKey {
    /// It answers [`PromptError::Back`], and the key legend lists it.
    Honoured,
    /// No step lies behind the select: the key does nothing, and the legend
    /// leaves it out.
    Ignored,
}

/// Where a step made of several questions opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// On its first question: the walk moved forward into the step.
    First,
    /// On its last question: Backspace returned to the step from the one
    /// after it.
    Last,
}

/// One visit to a table's ladder.
#[expect(
    clippy::large_enum_variant,
    reason = "One is built per table the walk visits and consumed at once, so boxing the answer would buy an allocation for nothing."
)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TableStep {
    /// The user finished this table.
    Done(TableProposal),
    /// The user left the first question. The caller reopens the previous table
    /// on its last question, or the recommended-vs-customize question when this
    /// was the first table.
    Back,
}

/// Recommended (inferred) vs the full ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WizardMode {
    /// Keep what catalog + RLS inference already filled in, and leave every
    /// server knob at the value the pack seeds.
    Recommended,
    /// Walk every table's contract, then the server maintenance knobs, the push
    /// policy, and the pg_cron policy.
    Customize,
}

/// One of the two server sections a customize walk asks after the tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerSection {
    /// The three job schedules, the client TTL, the HLC skew ceiling, the
    /// project-wide tombstone retention, and the pull scan cap.
    Maintenance,
    /// The largest accepted push and the atomic guard.
    PushPolicy,
}

/// The retention jobs `pg_cron` schedules, as the control panel read them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetentionJobs {
    /// `pg_cron` is not installed, so nothing schedules them.
    NoPgCron,
    /// `pg_cron` holds this many of the three jobs.
    Scheduled(usize),
}

impl RetentionJobs {
    /// Whether nothing schedules retention, so it runs by hand: the answer
    /// the control panel's question opens on.
    #[must_use]
    pub const fn by_hand(self) -> bool {
        matches!(self, Self::NoPgCron | Self::Scheduled(0))
    }
}

/// What a server section's first question answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionChoice {
    /// Keep the values the section opened on.
    Keep,
    /// Ask for each value.
    Custom,
}

/// One table offered by [`Prompter::select_tables`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableChoice {
    /// The table name: what a selection resolves back to.
    pub table: String,
    /// The line the user reads.
    pub label: String,
    /// Clack hint column (owner, inferred sync mode, "not in schema", ...).
    pub hint: String,
    /// Pre-checked, because the config already syncs this table. Unchecking it
    /// is how a table is removed; nothing is ever removed that the user did not
    /// uncheck.
    pub checked: bool,
    /// Listed but never checked: the pack cannot sync the table, and the hint
    /// says why.
    pub unavailable: bool,
}

impl TableChoice {
    /// A choice whose label is the table name itself and whose hint is empty.
    #[must_use]
    pub fn new(table: &str, checked: bool) -> Self {
        Self {
            table: table.to_owned(),
            label: table.to_owned(),
            hint: String::new(),
            checked,
            unavailable: false,
        }
    }

    /// The same choice, listed as unavailable for `reason`: unchecked, and
    /// never checked by a key.
    #[must_use]
    pub fn unavailable(mut self, reason: &str) -> Self {
        self.checked = false;
        self.unavailable = true;
        self.label = format!("{} (unavailable)", self.table);
        reason.clone_into(&mut self.hint);

        self
    }

    /// The same choice with the annotated line the user reads.
    #[must_use]
    pub fn labelled(mut self, label: &str) -> Self {
        label.clone_into(&mut self.label);

        self
    }

    /// The same choice with a Clack hint (right-hand muted column).
    #[must_use]
    pub fn with_hint(mut self, hint: &str) -> Self {
        hint.clone_into(&mut self.hint);

        self
    }
}

/// Handles all steps and extras of the wizard, including prompts, intro,
/// helpful notes, spinner, and finishing message.
///
/// If a question requires no input—such as when there are no tables to offer—
/// the implementation skips the prompt and returns an empty selection.
/// This way, callers never need to handle the empty-list case themselves.
pub trait Prompter {
    /// Which of the connections this machine already has to use. The list is
    /// [`discover`](crate::discovery::discover)'s output plus
    /// [`ConnectionCandidate::Manual`], and a list with only one entry resolves
    /// to it without asking: there is nothing to choose between. `current` is
    /// the candidate the list opens on, the last pick when the step is
    /// reopened; `None` opens on the preselected one.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn select_candidate(
        &mut self,
        candidates: &[ConnectionCandidate],
        current: Option<&ConnectionCandidate>,
    ) -> Result<ConnectionCandidate>;

    /// Which project of the account the token reaches. Answers with the chosen
    /// project ref; an empty list resolves to an empty ref, which the caller
    /// reads as "this account has no projects". `current` is the ref the list
    /// opens on, the last pick when the step is reopened.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn select_project(
        &mut self,
        projects: &[ProjectSummary],
        current: Option<&str>,
    ) -> Result<String>;

    /// A Personal Access Token, masked as it is typed, for a run that found
    /// none. Trimmed; an empty answer is the caller's cue to abort.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn ask_access_token(&mut self) -> Result<String>;

    /// Which tables to sync. The answer is the full set to keep: the tables
    /// left checked, not a delta.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn select_tables(&mut self, choices: &[TableChoice]) -> Result<Vec<String>>;

    /// Recommended vs customize, after the inferred summary has been shown.
    /// `current` is the answer the question opens on: the last one when the
    /// step is reopened.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn select_mode(&mut self, current: WizardMode) -> Result<WizardMode>;

    /// A server section's first question: keep the values it opens on, or
    /// set custom ones through [`Self::ask_maintenance`] or
    /// [`Self::ask_push_policy`]. `current` carries those values, the
    /// recommended ones or the last answer when the step is reopened, and
    /// `choice` is the option the select opens on.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn select_section(
        &mut self,
        section: ServerSection,
        current: &ProjectSettings,
        choice: SectionChoice,
    ) -> Result<SectionChoice>;

    /// The custom values of the server maintenance half of
    /// `kizunasync._settings`: the three job schedules, the client TTL, the
    /// HLC skew ceiling, the project-wide tombstone retention, and the pull
    /// scan cap. `current` carries the values every input opens on; the
    /// answer carries them back with the other half untouched. `entry` is the
    /// input the walk opens on.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn ask_maintenance(
        &mut self,
        current: &ProjectSettings,
        entry: Entry,
    ) -> Result<ProjectSettings>;

    /// The custom values of the push half of `kizunasync._settings`: the
    /// largest accepted push and whether a non-atomic one is refused.
    /// `current` carries the values the input opens on.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn ask_push_policy(&mut self, current: &ProjectSettings) -> Result<ProjectSettings>;

    /// What an install does when `pg_cron` is not enabled: stop and say how to
    /// enable it (`false`), or install anyway and leave retention to be run by
    /// hand (`true`).
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn ask_cron_policy(&mut self, allow_no_cron: bool) -> Result<bool>;

    /// The control panel's `pg_cron` question: keep the retention jobs
    /// scheduled (`false`), or run retention by hand, the `--allow-no-cron`
    /// path (`true`). It states `jobs`, what `pg_cron` schedules, and opens on
    /// `allow_no_cron`.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn ask_retention_policy(&mut self, jobs: RetentionJobs, allow_no_cron: bool) -> Result<bool>;

    /// Per-table ladder: sync mode, bucket, soft delete, conflict mode,
    /// conflict journal, client registry, minimum schema version, and tombstone
    /// retention. `columns` may be empty when introspection did not
    /// return them; the backend then asks for names instead of offering a list.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn customize_table(
        &mut self,
        proposal: &TableProposal,
        columns: &[ColumnInfo],
    ) -> Result<TableProposal>;

    /// One visit to [`Self::customize_table`], opening on the question
    /// `entry` names.
    ///
    /// The default finishes the table in a single answer, which is what a
    /// scripted run already queued. The terminal wizard returns
    /// [`TableStep::Back`] when the user leaves the first question, so the
    /// caller can reopen the previous table.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn customize_table_step(
        &mut self,
        proposal: &TableProposal,
        columns: &[ColumnInfo],
        _entry: Entry,
    ) -> Result<TableStep> {
        Ok(TableStep::Done(self.customize_table(proposal, columns)?))
    }

    /// A go/no-go. `default` is what Enter alone means, and destructive
    /// questions pass `false`.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn confirm(&mut self, message: &str, default: bool) -> Result<bool>;

    /// The connection string, masked as it is typed, for a run where no flag,
    /// environment variable, or local config produced one. Trimmed; an empty
    /// answer is the caller's cue to abort. `current` is the string typed the
    /// last time the step was answered, which an empty answer keeps.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn ask_db_url(&mut self, current: Option<&str>) -> Result<String>;

    /// One item of the control panel's menu or of one of its submenus, each
    /// with its hint beside it. `back` says whether Backspace answers
    /// [`PromptError::Back`] or does nothing. `current` is the item the
    /// select opens on, the last one chosen there; `None` opens on the first.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn select_action(
        &mut self,
        message: &str,
        items: &[PanelItem],
        current: Option<PanelAction>,
        back: BackKey,
    ) -> Result<PanelAction>;

    /// The target typed out before a destructive run. `Ok(true)` when the
    /// answer, trimmed, is `expected`; the terminal refuses any other text as
    /// it is typed, so only a script can answer `Ok(false)`. `current` is the
    /// text typed the last time the step was answered, which an empty answer
    /// keeps.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn ask_typed_confirmation(
        &mut self,
        message: &str,
        expected: &str,
        current: Option<&str>,
    ) -> Result<bool>;

    /// Session header. Scripted backends no-op. The production backend paints
    /// the 絆 / Kizuna Sync lockup first, then the Clack intro bar: the title itself is
    /// the docs hyperlink.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the terminal could not be drawn to.
    fn intro(&mut self, _step: DocsRef) -> Result<()> {
        Ok(())
    }

    /// A named step (connection discovery, schema, tables, …). The title is
    /// the docs hyperlink. Scripted backends record title and URL and do not
    /// draw.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the terminal could not be drawn to.
    fn phase(&mut self, _step: DocsRef) -> Result<()> {
        Ok(())
    }

    /// Which backend this run provisions. The default accepts the first
    /// offered solution without drawing, so a scripted run does not grow a
    /// question. The terminal backend asks.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the question could not be asked.
    fn select_solution(&mut self) -> Result<crate::solution::Solution> {
        Ok(crate::solution::Solution::ALL[0])
    }

    /// Session footer on success. Scripted backends no-op.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the terminal could not be drawn to.
    fn outro(&mut self, _message: &str) -> Result<()> {
        Ok(())
    }

    /// Session footer when the user declined. Scripted backends no-op.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the terminal could not be drawn to.
    fn outro_cancel(&mut self, _message: &str) -> Result<()> {
        Ok(())
    }

    /// A boxed note (plan, inferred settings). Scripted backends no-op.
    ///
    /// # Errors
    /// Returns [`PromptError`] when the terminal could not be drawn to.
    fn note(&mut self, _title: &str, _message: &str) -> Result<()> {
        Ok(())
    }

    /// Start an animated spinner. Scripted backends no-op.
    fn start_spin(&mut self, _message: &str) {}

    /// Stop the spinner, replacing it with `message`. Scripted backends no-op.
    fn stop_spin(&mut self, _message: &str) {}
}

/// Asks if the user wants to retry a failed step.
///
/// Pressing Enter means "yes"; pressing No, Backspace, cancel, or having no
/// terminal means "stop". The borrow only lasts for this call, letting the
/// caller try again after.
pub(crate) fn confirm_retry(prompter: &mut Option<&mut dyn Prompter>) -> bool {
    let Some(prompter) = prompter.as_deref_mut() else {
        return false;
    };
    matches!(prompter.confirm("Retry?", true), Ok(true))
}

/// Checks if this process is able to prompt the user. Every command uses this
/// flag to decide between interactive wizards or command-line flags.
///
/// For testing, library tests always take the non-interactive path. Note that
/// running `cargo test` in Turbo's TUI environment gives a PTY, so
/// `stdin().is_terminal()` would return true, and tools like cliclack could
/// hang the test suite. The child `kizunasync` binary does not use `cfg(test)`.
#[must_use]
pub fn is_interactive() -> bool {
    if cfg!(test) {
        return false;
    }
    std::io::stdin().is_terminal()
}

/// Whether a Clack-style *report* (no questions) can draw on this process.
///
/// Status never reads stdin, but it still needs a real stderr to box notes
/// onto, and a real stdin so a piped CI job is not mistaken for a terminal.
/// Both sides must be TTYs; either side redirected is compact text instead.
#[must_use]
pub fn is_pretty_tty() -> bool {
    if cfg!(test) {
        return false;
    }
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

/// The candidate a list of one settles without a question, else
/// [`ConnectionCandidate::Manual`] for an empty list, since a run with nothing
/// discovered has exactly one way left to connect. `None` means there is a real
/// choice to put to the user.
pub(crate) fn sole_candidate(candidates: &[ConnectionCandidate]) -> Option<ConnectionCandidate> {
    match candidates {
        [] => Some(ConnectionCandidate::Manual),
        [only] => Some(only.clone()),
        _ => None,
    }
}
