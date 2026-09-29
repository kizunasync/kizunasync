use std::collections::VecDeque;

use crate::commands::panel::{PanelAction, PanelItem};
use crate::config::ProjectSettings;
use crate::discovery::ConnectionCandidate;
use crate::docs::DocsRef;
use crate::management::ProjectSummary;
use crate::proposals::ColumnInfo;
use crate::proposals::TableProposal;

use super::{
    ACCESS_TOKEN_MESSAGE, BackKey, CANDIDATE_MESSAGE, CRON_POLICY_MESSAGE, DB_URL_MESSAGE, Entry,
    MAINTENANCE_MESSAGE, MODE_MESSAGE, PROJECT_MESSAGE, PUSH_POLICY_MESSAGE, PromptError, Prompter,
    RETENTION_POLICY_MESSAGE, Result, RetentionJobs, SectionChoice, ServerSection, TABLES_MESSAGE,
    TableChoice, TableStep, WizardMode, sole_candidate,
};

/// An answer a [`ScriptedPrompter`] hands out, tagged with the question it
/// answers so a script that drifts out of step fails loudly instead of
/// silently answering the wrong prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// Answers [`Prompter::select_candidate`].
    Candidate(ConnectionCandidate),
    /// Answers [`Prompter::select_project`]: the chosen project ref.
    Project(String),
    /// Answers [`Prompter::ask_access_token`].
    AccessToken(String),
    /// Answers [`Prompter::select_tables`]: the full set to keep.
    Tables(Vec<String>),
    /// Answers [`Prompter::select_mode`].
    Mode(WizardMode),
    /// Answers [`Prompter::customize_table`] for `custom.table`.
    Customize(TableProposal),
    /// Answers [`Prompter::select_section`].
    Section(SectionChoice),
    /// Answers [`Prompter::ask_maintenance`].
    Maintenance(ProjectSettings),
    /// Answers [`Prompter::ask_push_policy`].
    PushPolicy(ProjectSettings),
    /// Answers [`Prompter::ask_cron_policy`], whether an install proceeds
    /// without pg_cron, and [`Prompter::ask_retention_policy`], whether
    /// retention runs by hand.
    CronPolicy(bool),
    /// Answers [`Prompter::confirm`].
    Confirm(bool),
    /// Answers [`Prompter::ask_db_url`].
    DbUrl(String),
    /// Answers [`Prompter::select_action`].
    Action(PanelAction),
    /// Answers [`Prompter::ask_typed_confirmation`] with the text typed.
    Typed(String),
    /// Backspace: whichever question comes next answers
    /// [`PromptError::Back`]. A select that ignores Backspace
    /// ([`BackKey::Ignored`]) skips it and takes the answer after it, the way
    /// the terminal keeps waiting.
    Back,
    /// Esc or Ctrl+C: whichever question comes next answers
    /// [`PromptError::Cancelled`].
    Cancel,
    /// A terminal that is gone: whichever question comes next answers
    /// [`PromptError::NotInteractive`].
    NotInteractive,
}

/// A question a [`ScriptedPrompter`] was asked, recorded so a test can assert
/// what the wizard offered: that the synced set arrived pre-checked, above all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ask {
    /// [`Prompter::select_candidate`], with every candidate as it was offered.
    Candidate {
        /// The candidates offered, in the order the picker listed them.
        candidates: Vec<ConnectionCandidate>,
        /// The candidate the picker opened on, `None` for the preselected one.
        current: Option<ConnectionCandidate>,
    },
    /// [`Prompter::select_project`], with the account's projects.
    Project {
        /// The projects offered.
        projects: Vec<ProjectSummary>,
        /// The ref the list opened on, `None` for the first.
        current: Option<String>,
    },
    /// [`Prompter::ask_access_token`].
    AccessToken,
    /// [`Prompter::select_tables`], with every choice as it was offered.
    Tables {
        /// The choices offered, pre-check state included.
        choices: Vec<TableChoice>,
    },
    /// [`Prompter::select_mode`], with the answer it opened on.
    Mode {
        /// The mode the question opened on.
        current: WizardMode,
    },
    /// [`Prompter::select_section`], with the values its first option keeps.
    Section {
        /// The section asked.
        section: ServerSection,
        /// The settings the section opened on.
        current: ProjectSettings,
        /// The option the select opened on.
        choice: SectionChoice,
    },
    /// [`Prompter::ask_maintenance`], with the values it started from.
    Maintenance {
        /// The settings the steps opened on.
        current: ProjectSettings,
        /// The input the walk opened on.
        entry: Entry,
    },
    /// [`Prompter::ask_push_policy`], with the policy it started from.
    PushPolicy {
        /// The policy the step opened on.
        current: ProjectSettings,
    },
    /// [`Prompter::ask_cron_policy`], with the answer the flags already gave.
    CronPolicy {
        /// What `--allow-no-cron` said before the question was asked.
        allow_no_cron: bool,
    },
    /// [`Prompter::ask_retention_policy`], with what `pg_cron` schedules and
    /// the answer it opened on.
    RetentionPolicy {
        /// The retention jobs the question stated.
        jobs: RetentionJobs,
        /// The answer the question opened on.
        allow_no_cron: bool,
    },
    /// [`Prompter::customize_table`], with the contract it opened on.
    Customize {
        /// The contract the ladder opened on.
        current: TableProposal,
        /// The question the ladder opened on.
        entry: Entry,
    },
    /// [`Prompter::confirm`], with its wording and default.
    Confirm {
        /// The question asked.
        message: String,
        /// What Enter alone would have meant.
        default: bool,
    },
    /// [`Prompter::ask_db_url`].
    DbUrl {
        /// The string an empty answer keeps, `None` the first time.
        current: Option<String>,
    },
    /// [`Prompter::select_action`], with its question and every item offered.
    Action {
        /// The question asked.
        message: String,
        /// The items offered, in order.
        items: Vec<PanelItem>,
        /// The item the select opened on, `None` for the first.
        current: Option<PanelAction>,
        /// What Backspace did there.
        back: BackKey,
    },
    /// [`Prompter::ask_typed_confirmation`], with the text it waits for.
    TypedConfirmation {
        /// The question asked.
        message: String,
        /// What the answer has to be.
        expected: String,
        /// The text an empty answer keeps, `None` the first time.
        current: Option<String>,
    },
    /// [`Prompter::phase`], with the step title and the docs URL it named.
    Phase {
        /// The title shown above the next question.
        title: String,
        /// The docs page this step points at.
        docs: String,
    },
}

/// A prompter that answers from a script and needs no terminal.
///
/// Tests drive a command's whole wizard through this: queue the answers in the
/// order the flow asks for them, run the command, then assert on [`Self::asked`].
/// An answer that is missing or of the wrong kind is a [`PromptError::Script`],
/// never a hang and never a panic.
#[derive(Debug, Default)]
pub struct ScriptedPrompter {
    answers: VecDeque<Answer>,
    asked: Vec<Ask>,
    notes: Vec<(String, String)>,
    cancel_outros: Vec<String>,
}

impl ScriptedPrompter {
    /// A prompter that hands out `answers` in order.
    #[must_use]
    pub fn new(answers: Vec<Answer>) -> Self {
        Self {
            answers: answers.into(),
            asked: Vec::new(),
            notes: Vec::new(),
            cancel_outros: Vec::new(),
        }
    }

    /// Every question asked so far, in order.
    #[must_use]
    pub fn asked(&self) -> &[Ask] {
        &self.asked
    }

    /// Every note shown so far, as `(title, body)`. A note is chrome rather
    /// than a question, so it stays out of [`Self::asked`], but a flow that
    /// must explain itself *before* it asks can still be held to it.
    #[must_use]
    pub fn notes(&self) -> &[(String, String)] {
        &self.notes
    }

    /// Every closing line a cancelled or declined flow drew, in order.
    #[must_use]
    pub fn cancel_outros(&self) -> &[String] {
        &self.cancel_outros
    }

    /// The answers the flow never got round to asking for.
    #[must_use]
    pub fn unused(&self) -> usize {
        self.answers.len()
    }

    fn take(&mut self, question: &str) -> Result<Answer> {
        match self.answers.pop_front() {
            Some(Answer::Back) => Err(PromptError::Back),
            Some(Answer::Cancel) => Err(PromptError::Cancelled),
            Some(Answer::NotInteractive) => Err(PromptError::NotInteractive),
            Some(answer) => Ok(answer),
            None => Err(PromptError::Script(format!(
                "{question}: the script has no answer left"
            ))),
        }
    }

    fn mismatch<T>(question: &str, answer: &Answer) -> Result<T> {
        Err(PromptError::Script(format!(
            "{question}: the script's next answer is {answer:?}"
        )))
    }

    fn customize(&mut self, proposal: &TableProposal, entry: Entry) -> Result<TableProposal> {
        self.asked.push(Ask::Customize {
            current: proposal.clone(),
            entry,
        });
        match self.take(&format!("customize {}", proposal.table))? {
            Answer::Customize(custom) if custom.table == proposal.table => Ok(custom),
            Answer::Customize(custom) => Err(PromptError::Script(format!(
                "customize {}: the script offered {}",
                proposal.table, custom.table
            ))),
            other => Self::mismatch(&format!("customize {}", proposal.table), &other),
        }
    }
}

/// An empty typed answer keeps `current`, the way Enter on an empty field
/// does in the terminal.
fn kept_or_typed<'a>(typed: &'a str, current: Option<&'a str>) -> &'a str {
    match current {
        Some(kept) if typed.is_empty() => kept,
        _ => typed,
    }
}

impl Prompter for ScriptedPrompter {
    fn select_candidate(
        &mut self,
        candidates: &[ConnectionCandidate],
        current: Option<&ConnectionCandidate>,
    ) -> Result<ConnectionCandidate> {
        self.asked.push(Ask::Candidate {
            candidates: candidates.to_vec(),
            current: current.cloned(),
        });
        if let Some(sole) = sole_candidate(candidates) {
            return Ok(sole);
        }
        match self.take(CANDIDATE_MESSAGE)? {
            Answer::Candidate(candidate) if candidates.contains(&candidate) => Ok(candidate),
            Answer::Candidate(candidate) => Err(PromptError::Script(format!(
                "{CANDIDATE_MESSAGE}: {candidate:?} was not offered"
            ))),
            other => Self::mismatch(CANDIDATE_MESSAGE, &other),
        }
    }

    fn select_project(
        &mut self,
        projects: &[ProjectSummary],
        current: Option<&str>,
    ) -> Result<String> {
        self.asked.push(Ask::Project {
            projects: projects.to_vec(),
            current: current.map(str::to_owned),
        });
        if projects.is_empty() {
            return Ok(String::new());
        }
        match self.take(PROJECT_MESSAGE)? {
            Answer::Project(project_ref)
                if projects
                    .iter()
                    .any(|project| project.project_ref == project_ref) =>
            {
                Ok(project_ref)
            }
            Answer::Project(project_ref) => Err(PromptError::Script(format!(
                "{PROJECT_MESSAGE}: {project_ref} was not offered"
            ))),
            other => Self::mismatch(PROJECT_MESSAGE, &other),
        }
    }

    fn ask_access_token(&mut self) -> Result<String> {
        self.asked.push(Ask::AccessToken);
        match self.take(ACCESS_TOKEN_MESSAGE)? {
            Answer::AccessToken(token) => Ok(token.trim().to_owned()),
            other => Self::mismatch(ACCESS_TOKEN_MESSAGE, &other),
        }
    }

    fn select_tables(&mut self, choices: &[TableChoice]) -> Result<Vec<String>> {
        self.asked.push(Ask::Tables {
            choices: choices.to_vec(),
        });
        if choices.is_empty() {
            return Ok(Vec::new());
        }
        match self.take(TABLES_MESSAGE)? {
            Answer::Tables(tables) => Ok(tables),
            other => Self::mismatch(TABLES_MESSAGE, &other),
        }
    }

    fn select_mode(&mut self, current: WizardMode) -> Result<WizardMode> {
        self.asked.push(Ask::Mode { current });
        match self.take(MODE_MESSAGE)? {
            Answer::Mode(mode) => Ok(mode),
            other => Self::mismatch(MODE_MESSAGE, &other),
        }
    }

    fn select_section(
        &mut self,
        section: ServerSection,
        current: &ProjectSettings,
        choice: SectionChoice,
    ) -> Result<SectionChoice> {
        self.asked.push(Ask::Section {
            section,
            current: current.clone(),
            choice,
        });
        let question = match section {
            ServerSection::Maintenance => MAINTENANCE_MESSAGE,
            ServerSection::PushPolicy => PUSH_POLICY_MESSAGE,
        };
        match self.take(question)? {
            Answer::Section(choice) => Ok(choice),
            other => Self::mismatch(question, &other),
        }
    }

    fn ask_maintenance(
        &mut self,
        current: &ProjectSettings,
        entry: Entry,
    ) -> Result<ProjectSettings> {
        self.asked.push(Ask::Maintenance {
            current: current.clone(),
            entry,
        });
        match self.take(MAINTENANCE_MESSAGE)? {
            Answer::Maintenance(settings) => Ok(settings),
            other => Self::mismatch(MAINTENANCE_MESSAGE, &other),
        }
    }

    fn ask_push_policy(&mut self, current: &ProjectSettings) -> Result<ProjectSettings> {
        self.asked.push(Ask::PushPolicy {
            current: current.clone(),
        });
        match self.take(PUSH_POLICY_MESSAGE)? {
            Answer::PushPolicy(policy) => Ok(policy),
            other => Self::mismatch(PUSH_POLICY_MESSAGE, &other),
        }
    }

    fn ask_cron_policy(&mut self, allow_no_cron: bool) -> Result<bool> {
        self.asked.push(Ask::CronPolicy { allow_no_cron });
        match self.take(CRON_POLICY_MESSAGE)? {
            Answer::CronPolicy(allow) => Ok(allow),
            other => Self::mismatch(CRON_POLICY_MESSAGE, &other),
        }
    }

    fn ask_retention_policy(&mut self, jobs: RetentionJobs, allow_no_cron: bool) -> Result<bool> {
        self.asked.push(Ask::RetentionPolicy {
            jobs,
            allow_no_cron,
        });
        match self.take(RETENTION_POLICY_MESSAGE)? {
            Answer::CronPolicy(by_hand) => Ok(by_hand),
            other => Self::mismatch(RETENTION_POLICY_MESSAGE, &other),
        }
    }

    fn customize_table(
        &mut self,
        proposal: &TableProposal,
        _columns: &[ColumnInfo],
    ) -> Result<TableProposal> {
        self.customize(proposal, Entry::First)
    }

    fn customize_table_step(
        &mut self,
        proposal: &TableProposal,
        _columns: &[ColumnInfo],
        entry: Entry,
    ) -> Result<TableStep> {
        Ok(TableStep::Done(self.customize(proposal, entry)?))
    }

    fn confirm(&mut self, message: &str, default: bool) -> Result<bool> {
        self.asked.push(Ask::Confirm {
            message: message.to_owned(),
            default,
        });
        match self.take(message)? {
            Answer::Confirm(answer) => Ok(answer),
            other => Self::mismatch(message, &other),
        }
    }

    fn ask_db_url(&mut self, current: Option<&str>) -> Result<String> {
        self.asked.push(Ask::DbUrl {
            current: current.map(str::to_owned),
        });
        match self.take(DB_URL_MESSAGE)? {
            Answer::DbUrl(url) => Ok(kept_or_typed(&url, current).trim().to_owned()),
            other => Self::mismatch(DB_URL_MESSAGE, &other),
        }
    }

    fn select_action(
        &mut self,
        message: &str,
        items: &[PanelItem],
        current: Option<PanelAction>,
        back: BackKey,
    ) -> Result<PanelAction> {
        self.asked.push(Ask::Action {
            message: message.to_owned(),
            items: items.to_vec(),
            current,
            back,
        });
        if back == BackKey::Ignored {
            while self.answers.front() == Some(&Answer::Back) {
                self.answers.pop_front();
            }
        }
        match self.take(message)? {
            Answer::Action(action) if items.iter().any(|item| item.action == action) => Ok(action),
            Answer::Action(action) => Err(PromptError::Script(format!(
                "{message}: {action:?} was not offered"
            ))),
            other => Self::mismatch(message, &other),
        }
    }

    fn ask_typed_confirmation(
        &mut self,
        message: &str,
        expected: &str,
        current: Option<&str>,
    ) -> Result<bool> {
        self.asked.push(Ask::TypedConfirmation {
            message: message.to_owned(),
            expected: expected.to_owned(),
            current: current.map(str::to_owned),
        });
        match self.take(message)? {
            Answer::Typed(typed) => Ok(kept_or_typed(&typed, current).trim() == expected),
            other => Self::mismatch(message, &other),
        }
    }

    fn phase(&mut self, step: DocsRef) -> Result<()> {
        self.asked.push(Ask::Phase {
            title: step.title.to_owned(),
            docs: step.url.to_owned(),
        });

        Ok(())
    }

    fn note(&mut self, title: &str, message: &str) -> Result<()> {
        self.notes.push((title.to_owned(), message.to_owned()));

        Ok(())
    }

    fn outro_cancel(&mut self, message: &str) -> Result<()> {
        self.cancel_outros.push(message.to_owned());

        Ok(())
    }
}
