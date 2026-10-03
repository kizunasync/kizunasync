use crate::commands::panel::{PanelAction, PanelItem};
use crate::config::{
    DEFAULT_CLIENT_PRUNE_SCHEDULE, DEFAULT_CLIENT_TTL_DAYS, DEFAULT_COMPACT_SCHEDULE,
    DEFAULT_HLC_MAX_SKEW_MS, DEFAULT_MAX_PULL_SCAN, DEFAULT_MIN_SCHEMA_VERSION,
    DEFAULT_REAP_SCHEDULE, DEFAULT_TOMBSTONE_TTL_DAYS, MaxBatchSize, ProjectSettings,
};
use crate::cron;
use crate::db::redact_db_url;
use crate::discovery::{ConnectionCandidate, preselected};
use crate::docs::{DocsRef, link_or_url};
use crate::management::ProjectSummary;
use crate::proposals::ColumnInfo;
use crate::proposals::{
    Bucket, BucketAnswer, ConflictMode, SyncMode, TableProposal, build_table_config,
};
use crate::wizard_theme;

use super::keys::{self, Stroke};
use super::{
    ACCESS_TOKEN_MESSAGE, BackKey, CANDIDATE_MESSAGE, CRON_POLICY_MESSAGE, DB_URL_MESSAGE, Entry,
    MAINTENANCE_MESSAGE, MAX_BATCH_MESSAGE, MODE_MESSAGE, PROJECT_MESSAGE, PUSH_POLICY_MESSAGE,
    PromptError, Prompter, RETENTION_POLICY_MESSAGE, Result, RetentionJobs, SectionChoice,
    ServerSection, TABLES_MESSAGE, TableChoice, TableStep, WizardMode, is_interactive,
    sole_candidate,
};

/// Above this many items a select gets Clack's type-to-filter mode.
const FILTER_THRESHOLD: usize = 6;

/// The real terminal wizard.
pub struct CliclackPrompter {
    spinner: Option<cliclack::ProgressBar>,
}

impl CliclackPrompter {
    /// A prompter for a real terminal.
    ///
    /// # Errors
    ///
    /// [`PromptError::NotInteractive`] when stdin is not a TTY. Refusing here
    /// rather than at the first question is what keeps a piped run from
    /// blocking on input that will never arrive.
    pub fn new() -> Result<Self> {
        if is_interactive() {
            wizard_theme::apply();

            return Ok(Self { spinner: None });
        }

        Err(PromptError::NotInteractive)
    }

    /// Chrome only: intro, notes, outro. Never asks, so a piped stdin is fine
    /// as long as the caller already decided a terminal is there to draw on.
    #[must_use]
    pub fn for_display() -> Self {
        wizard_theme::apply();

        Self { spinner: None }
    }
}

impl Prompter for CliclackPrompter {
    fn select_candidate(
        &mut self,
        candidates: &[ConnectionCandidate],
        current: Option<&ConnectionCandidate>,
    ) -> Result<ConnectionCandidate> {
        if let Some(sole) = sole_candidate(candidates) {
            return Ok(sole);
        }

        let rows: Vec<_> = candidates
            .iter()
            .map(|candidate| (candidate.clone(), candidate.label(), candidate.hint()))
            .collect();
        let initial = current
            .filter(|kept| candidates.contains(kept))
            .or_else(|| preselected(candidates).and_then(|index| candidates.get(index)))
            .unwrap_or(&candidates[0]);
        answered(keys::choose(
            CANDIDATE_MESSAGE,
            &rows,
            initial,
            candidates.len() > FILTER_THRESHOLD,
            BackKey::Honoured,
        )?)
    }

    fn select_project(
        &mut self,
        projects: &[ProjectSummary],
        current: Option<&str>,
    ) -> Result<String> {
        let Some(first) = projects.first() else {
            return Ok(String::new());
        };
        let initial = current
            .and_then(|kept| projects.iter().find(|project| project.project_ref == kept))
            .unwrap_or(first);

        let rows: Vec<_> = projects
            .iter()
            .map(|project| {
                (
                    project.project_ref.clone(),
                    project.name.clone(),
                    project_hint(project),
                )
            })
            .collect();
        answered(keys::choose(
            PROJECT_MESSAGE,
            &rows,
            &initial.project_ref,
            projects.len() > FILTER_THRESHOLD,
            BackKey::Honoured,
        )?)
    }

    fn ask_access_token(&mut self) -> Result<String> {
        let entered = answered(keys::read_line(
            ACCESS_TOKEN_MESSAGE,
            "sbp_…",
            None,
            true,
            |_| Ok(()),
        )?)?;
        Ok(entered.trim().to_owned())
    }

    fn select_tables(&mut self, choices: &[TableChoice]) -> Result<Vec<String>> {
        if choices.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Vec<_> = choices
            .iter()
            .map(|choice| {
                (
                    choice.table.clone(),
                    choice.label.clone(),
                    choice.hint.clone(),
                )
            })
            .collect();
        let checked: Vec<String> = choices
            .iter()
            .filter(|choice| choice.checked)
            .map(|choice| choice.table.clone())
            .collect();
        let locked: Vec<String> = choices
            .iter()
            .filter(|choice| choice.unavailable)
            .map(|choice| choice.table.clone())
            .collect();
        answered(keys::choose_multi(
            TABLES_MESSAGE,
            &rows,
            &checked,
            &locked,
        )?)
    }

    fn select_mode(&mut self, current: WizardMode) -> Result<WizardMode> {
        let rows = vec![
            (
                WizardMode::Recommended,
                "Recommended".to_owned(),
                "the inferred contract and the server defaults: Enter to accept".to_owned(),
            ),
            (
                WizardMode::Customize,
                "Customize".to_owned(),
                "every table, then the server maintenance, push and pg_cron policy".to_owned(),
            ),
        ];
        answered(keys::choose(
            MODE_MESSAGE,
            &rows,
            &current,
            false,
            BackKey::Honoured,
        )?)
    }

    fn select_section(
        &mut self,
        section: ServerSection,
        current: &ProjectSettings,
        choice: SectionChoice,
    ) -> Result<SectionChoice> {
        let message = match section {
            ServerSection::Maintenance => {
                self.phase(crate::docs::MAINTENANCE_PHASE)?;
                explain(&describe_maintenance(current))?;
                MAINTENANCE_MESSAGE
            }
            ServerSection::PushPolicy => {
                explain(&format!(
                    "Largest push: {}. A push over the cap is rejected whole, with the code KZP02.",
                    describe_batch_size(current.max_batch_size)
                ))?;
                PUSH_POLICY_MESSAGE
            }
        };
        let rows = vec![
            (
                SectionChoice::Keep,
                "Keep these values".to_owned(),
                "Enter to accept".to_owned(),
            ),
            (
                SectionChoice::Custom,
                "Set custom values".to_owned(),
                "ask for each one".to_owned(),
            ),
        ];
        answered(keys::choose(
            message,
            &rows,
            &choice,
            false,
            BackKey::Honoured,
        )?)
    }

    fn ask_maintenance(
        &mut self,
        current: &ProjectSettings,
        entry: Entry,
    ) -> Result<ProjectSettings> {
        explain(
            "Every schedule is five UTC crontab fields: minute hour day-of-month month day-of-week.",
        )?;
        let mut inputs = MaintenanceInputs {
            values: current.clone(),
        };
        let start = match entry {
            Entry::First => MaintenanceInput::ALL[0],
            Entry::Last => MaintenanceInput::ALL[MaintenanceInput::ALL.len() - 1],
        };
        if !walk_questions(&mut inputs, start)? {
            return Err(PromptError::Back);
        }

        Ok(inputs.values)
    }

    fn ask_push_policy(&mut self, current: &ProjectSettings) -> Result<ProjectSettings> {
        let answer = answered(keys::edit_line(
            MAX_BATCH_MESSAGE,
            "empty = unlimited",
            &batch_size_text(current),
            |value| validate_batch_size_or_back(value).map_err(str::to_owned),
        )?)?;
        explain(
            "require_atomic is not supported: the current client sends non-atomic pushes for ordinary writes, and enabling it would dead-letter them.",
        )?;

        Ok(push_policy_from(&answer, current))
    }

    fn ask_cron_policy(&mut self, allow_no_cron: bool) -> Result<bool> {
        explain("pg_cron runs the three retention jobs. Without it nothing is scheduled.")?;

        let rows = vec![
            (
                false,
                "Stop the install".to_owned(),
                "say how to enable it, then rerun (recommended)".to_owned(),
            ),
            (
                true,
                "Install anyway".to_owned(),
                "retention runs only when you run `kizunasync jobs run`".to_owned(),
            ),
        ];
        answered(keys::choose(
            CRON_POLICY_MESSAGE,
            &rows,
            &allow_no_cron,
            false,
            BackKey::Honoured,
        )?)
    }

    fn ask_retention_policy(&mut self, jobs: RetentionJobs, allow_no_cron: bool) -> Result<bool> {
        explain(&describe_retention_jobs(jobs))?;

        answered(keys::choose(
            RETENTION_POLICY_MESSAGE,
            &retention_rows(),
            &allow_no_cron,
            false,
            BackKey::Honoured,
        )?)
    }

    fn customize_table(
        &mut self,
        proposal: &TableProposal,
        columns: &[ColumnInfo],
    ) -> Result<TableProposal> {
        match customize_interactive(proposal, columns, Entry::First)? {
            TableStep::Done(done) => Ok(done),
            // Nothing earlier than this table was offered to a direct call.
            TableStep::Back => Ok(proposal.clone()),
        }
    }

    fn customize_table_step(
        &mut self,
        proposal: &TableProposal,
        columns: &[ColumnInfo],
        entry: Entry,
    ) -> Result<TableStep> {
        customize_interactive(proposal, columns, entry)
    }

    fn confirm(&mut self, message: &str, default: bool) -> Result<bool> {
        answered(keys::confirm(message, default)?)
    }

    fn ask_db_url(&mut self, current: Option<&str>) -> Result<String> {
        // The kept string is shown redacted, and Enter on the empty field reuses it.
        let placeholder = current.map_or_else(|| "postgres://".to_owned(), redact_db_url);
        let entered = answered(keys::read_line(
            DB_URL_MESSAGE,
            &placeholder,
            current,
            true,
            |_| Ok(()),
        )?)?;
        Ok(entered.trim().to_owned())
    }

    fn select_action(
        &mut self,
        message: &str,
        items: &[PanelItem],
        current: Option<PanelAction>,
        back: BackKey,
    ) -> Result<PanelAction> {
        let rows: Vec<_> = items
            .iter()
            .map(|item| (item.action, item.label.clone(), item.hint.clone()))
            .collect();
        let initial = current
            .filter(|kept| items.iter().any(|item| item.action == *kept))
            .or_else(|| items.first().map(|item| item.action))
            .unwrap_or(PanelAction::Exit);

        answered(keys::choose(message, &rows, &initial, false, back)?)
    }

    fn ask_typed_confirmation(
        &mut self,
        message: &str,
        expected: &str,
        current: Option<&str>,
    ) -> Result<bool> {
        let typed = answered(keys::read_line(
            message,
            expected,
            current,
            false,
            |value| {
                if value.trim() == expected {
                    return Ok(());
                }

                Err(format!(
                    "type {expected} exactly, or press Backspace to go back"
                ))
            },
        )?)?;

        Ok(typed.trim() == expected)
    }

    fn intro(&mut self, step: DocsRef) -> Result<()> {
        wizard_theme::session_begin();
        wizard_theme::print_banner();
        let title = wizard_theme::vermilion().apply_to(step.title).to_string();
        paint_theme(&wizard_theme::intro_line(&crate::docs::hyperlink(
            &title, step.url,
        )))
    }

    fn phase(&mut self, step: DocsRef) -> Result<()> {
        paint_theme(&wizard_theme::info_log(&step.linked_title()))
    }

    fn select_solution(&mut self) -> Result<crate::solution::Solution> {
        self.phase(crate::docs::SOLUTION_PHASE)?;
        let rows: Vec<_> = crate::solution::Solution::ALL
            .iter()
            .map(|solution| {
                (
                    *solution,
                    solution.label().to_owned(),
                    solution.hint().to_owned(),
                )
            })
            .collect();
        let initial = rows[0].0;
        loop {
            match keys::choose("Which solution?", &rows, &initial, false, BackKey::Ignored)? {
                Stroke::Value(solution) => return Ok(solution),
                Stroke::Back => {}
            }
        }
    }

    fn outro(&mut self, message: &str) -> Result<()> {
        let drawn = paint_theme(&wizard_theme::outro_line(message));
        wizard_theme::session_end();
        drawn
    }

    fn outro_cancel(&mut self, message: &str) -> Result<()> {
        let drawn = paint_theme(&wizard_theme::outro_cancel_line(message));
        wizard_theme::session_end();
        drawn
    }

    fn note(&mut self, title: &str, message: &str) -> Result<()> {
        paint_theme(&wizard_theme::note_block(title, message))
    }

    fn start_spin(&mut self, message: &str) {
        if let Some(previous) = self.spinner.take() {
            previous.clear();
        }
        let spinner = cliclack::spinner();
        spinner.start(message);
        self.spinner = Some(spinner);
    }

    fn stop_spin(&mut self, message: &str) {
        if let Some(spinner) = self.spinner.take() {
            spinner.clear();
            // indicatif pads its own printed lines to the terminal width with no newline; write the finished frame ourselves instead.
            let _ = wizard_theme::write_committed(&wizard_theme::finished_spin(message));
        }
    }
}

fn paint_theme(rendered: &str) -> Result<()> {
    wizard_theme::write_committed(rendered).map_err(|error| PromptError::Backend(error.to_string()))
}

/// The per-table ladder. `back` is the last row of every list, and the word
/// `back` on a typed number. Leaving the first question returns
/// [`TableStep::Back`] so the caller can reopen the previous table. Esc still
/// cancels the wizard. [`Entry::Last`] opens on the tombstone retention, the
/// question every table asks last.
fn customize_interactive(
    proposal: &TableProposal,
    columns: &[ColumnInfo],
    entry: Entry,
) -> Result<TableStep> {
    let mut ladder = TableLadder {
        table: &proposal.table,
        names: columns.iter().map(|column| column.name.clone()).collect(),
        columns,
        has_soft: has_soft_delete_column(columns),
        draft: draft_from(proposal),
    };
    let start = match entry {
        Entry::First => LadderStep::Sync,
        Entry::Last => LadderStep::Tombstone,
    };
    if walk_questions(&mut ladder, start)? {
        return Ok(TableStep::Done(finished(&ladder.draft, proposal)));
    }

    Ok(TableStep::Back)
}

/// A run of questions inside one wizard step, walked by [`walk_questions`].
trait Questions {
    type Question: Copy;

    /// Ask `question`, keeping its answer.
    fn ask(&mut self, question: Self::Question) -> Result<Outcome>;

    /// The question after `question`, `None` after the last.
    fn next(&self, question: Self::Question) -> Option<Self::Question>;

    /// The question before `question`, `None` before the first.
    fn previous(&self, question: Self::Question) -> Option<Self::Question>;
}

/// Ask from `start` until the last question is answered (`true`) or
/// Backspace leaves the first (`false`). One mark per question on screen:
/// Backspace wipes that question's answer before the previous one is asked
/// again, on the answer it kept.
fn walk_questions<Q: Questions>(questions: &mut Q, start: Q::Question) -> Result<bool> {
    let mut question = start;
    let mut anchors = vec![wizard_theme::mark()];

    loop {
        match questions.ask(question)? {
            Outcome::Back => {
                if let Some(current) = anchors.pop() {
                    wizard_theme::rewind(current);
                }
                let Some(previous) = questions.previous(question) else {
                    return Ok(false);
                };
                if let Some(previous_mark) = anchors.pop() {
                    wizard_theme::rewind(previous_mark);
                }
                question = previous;
                anchors.push(wizard_theme::mark());
            }
            Outcome::Forward => {
                let Some(next) = questions.next(question) else {
                    return Ok(true);
                };
                question = next;
                anchors.push(wizard_theme::mark());
            }
        }
    }
}

/// One table's questions, over the draft its answers fill in.
struct TableLadder<'a> {
    table: &'a str,
    names: Vec<String>,
    columns: &'a [ColumnInfo],
    has_soft: bool,
    draft: Draft,
}

impl Questions for TableLadder<'_> {
    type Question = LadderStep;

    fn ask(&mut self, step: LadderStep) -> Result<Outcome> {
        let (table, draft) = (self.table, &mut self.draft);
        match step {
            LadderStep::Sync => ask_sync(table, draft),
            LadderStep::BucketKind => ask_bucket_kind(table, draft),
            LadderStep::OwnerColumn => ask_owner_column(table, &self.names, draft),
            LadderStep::TenantColumn => ask_tenant_column(table, &self.names, draft),
            LadderStep::SoftDelete => ask_soft(table, self.columns, draft),
            LadderStep::Conflict => ask_conflict(table, draft),
            LadderStep::Journal => ask_journal(table, draft),
            LadderStep::Register => ask_register(table, draft),
            LadderStep::MinSchema => ask_min_schema(table, draft),
            LadderStep::Tombstone => ask_tombstone(table, draft),
        }
    }

    fn next(&self, step: LadderStep) -> Option<LadderStep> {
        next_step(step, self.draft.kind, self.has_soft, self.draft.sync)
    }

    fn previous(&self, step: LadderStep) -> Option<LadderStep> {
        previous_step(step, self.draft.kind, self.has_soft, self.draft.sync)
    }
}

const BACK_LABEL: &str = "back";
const BACK_HINT: &str = "previous step";

#[derive(Clone, PartialEq, Eq)]
enum Pick<T> {
    Back,
    Value(T),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Back,
    Forward,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BucketKind {
    Owner,
    Column,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LadderStep {
    Sync,
    BucketKind,
    OwnerColumn,
    TenantColumn,
    SoftDelete,
    Conflict,
    Journal,
    Register,
    MinSchema,
    Tombstone,
}

struct Draft {
    sync: SyncMode,
    kind: BucketKind,
    owner_column: String,
    tenant_column: String,
    soft_delete: Option<String>,
    conflict: ConflictMode,
    conflict_journal: bool,
    register_clients: bool,
    min_schema_version: i64,
    tombstone_ttl_days: Option<i64>,
}

fn draft_from(proposal: &TableProposal) -> Draft {
    let inferred = build_table_config(proposal);
    let (kind, owner_column, tenant_column) = bucket_opening(proposal);

    Draft {
        sync: inferred.sync,
        kind,
        owner_column,
        tenant_column,
        soft_delete: inferred.soft_delete,
        conflict: inferred.conflict.unwrap_or(ConflictMode::Arrival),
        conflict_journal: inferred.conflict_journal,
        register_clients: inferred.register_clients,
        min_schema_version: inferred
            .min_schema_version
            .unwrap_or(DEFAULT_MIN_SCHEMA_VERSION),
        tombstone_ttl_days: inferred.tombstone_ttl_days,
    }
}

/// An answered bucket reopens on that answer. An inferred owner reopens on
/// by-owner. Anything else reopens on no bucket.
fn bucket_opening(proposal: &TableProposal) -> (BucketKind, String, String) {
    let owner = match &proposal.bucket {
        BucketAnswer::Answered(Bucket::ByOwner(column)) => column.clone(),
        BucketAnswer::Inferred
        | BucketAnswer::Omitted
        | BucketAnswer::Answered(Bucket::ByColumn(_)) => {
            proposal.owner_column.clone().unwrap_or_default()
        }
    };
    let tenant = match &proposal.bucket {
        BucketAnswer::Answered(Bucket::ByColumn(column)) => column.clone(),
        BucketAnswer::Inferred
        | BucketAnswer::Omitted
        | BucketAnswer::Answered(Bucket::ByOwner(_)) => String::new(),
    };
    let kind = match &proposal.bucket {
        BucketAnswer::Answered(Bucket::ByColumn(_)) => BucketKind::Column,
        BucketAnswer::Answered(Bucket::ByOwner(_)) => BucketKind::Owner,
        BucketAnswer::Omitted => BucketKind::None,
        BucketAnswer::Inferred => {
            if proposal.owner_column.is_some() {
                BucketKind::Owner
            } else {
                BucketKind::None
            }
        }
    };

    (kind, owner, tenant)
}

fn finished(draft: &Draft, base: &TableProposal) -> TableProposal {
    let bucket = match draft.kind {
        BucketKind::None => BucketAnswer::Omitted,
        BucketKind::Owner => BucketAnswer::Answered(Bucket::ByOwner(draft.owner_column.clone())),
        BucketKind::Column => BucketAnswer::Answered(Bucket::ByColumn(draft.tenant_column.clone())),
    };

    TableProposal {
        table: base.table.clone(),
        owner_column: base.owner_column.clone(),
        provenance: base.provenance.clone(),
        sync: Some(draft.sync),
        bucket,
        conflict: match draft.conflict {
            ConflictMode::Arrival => None,
            ConflictMode::Hlc => Some(ConflictMode::Hlc),
        },
        conflict_journal: draft.conflict_journal,
        register_clients: draft.register_clients,
        min_schema_version: Some(draft.min_schema_version),
        tombstone_ttl_days: draft.tombstone_ttl_days,
        soft_delete: draft.soft_delete.clone(),
        key: base.key.clone(),
    }
}

fn next_step(
    step: LadderStep,
    kind: BucketKind,
    has_soft: bool,
    sync: SyncMode,
) -> Option<LadderStep> {
    Some(match step {
        LadderStep::Sync => LadderStep::BucketKind,
        LadderStep::BucketKind => match kind {
            BucketKind::Owner => LadderStep::OwnerColumn,
            BucketKind::Column => LadderStep::TenantColumn,
            BucketKind::None => after_columns(has_soft, sync),
        },
        LadderStep::OwnerColumn | LadderStep::TenantColumn => after_columns(has_soft, sync),
        LadderStep::SoftDelete => LadderStep::Conflict,
        LadderStep::Conflict => LadderStep::Journal,
        LadderStep::Journal => LadderStep::Register,
        LadderStep::Register => LadderStep::MinSchema,
        LadderStep::MinSchema => LadderStep::Tombstone,
        LadderStep::Tombstone => return None,
    })
}

fn previous_step(
    step: LadderStep,
    kind: BucketKind,
    has_soft: bool,
    sync: SyncMode,
) -> Option<LadderStep> {
    Some(match step {
        LadderStep::Sync => return None,
        LadderStep::BucketKind => LadderStep::Sync,
        LadderStep::OwnerColumn | LadderStep::TenantColumn => LadderStep::BucketKind,
        LadderStep::SoftDelete => before_columns(kind),
        LadderStep::Conflict => {
            if has_soft {
                LadderStep::SoftDelete
            } else {
                before_columns(kind)
            }
        }
        LadderStep::Journal => LadderStep::Conflict,
        // A pull-only table never reached the write questions, so back steps
        // over them to the bucket that was actually asked.
        LadderStep::Register if sync == SyncMode::PullOnly => before_columns(kind),
        LadderStep::Register => LadderStep::Journal,
        LadderStep::MinSchema => LadderStep::Register,
        LadderStep::Tombstone => LadderStep::MinSchema,
    })
}

/// Soft-delete, conflict, and the journal describe a client write. A pull-only
/// table refuses every write, so those three stay at their defaults.
fn after_columns(has_soft: bool, sync: SyncMode) -> LadderStep {
    if sync == SyncMode::PullOnly {
        return LadderStep::Register;
    }
    if has_soft {
        LadderStep::SoftDelete
    } else {
        LadderStep::Conflict
    }
}

fn before_columns(kind: BucketKind) -> LadderStep {
    match kind {
        BucketKind::Owner => LadderStep::OwnerColumn,
        BucketKind::Column => LadderStep::TenantColumn,
        BucketKind::None => LadderStep::BucketKind,
    }
}

fn has_soft_delete_column(columns: &[ColumnInfo]) -> bool {
    columns
        .iter()
        .any(|column| is_soft_delete_type(&column.data_type))
}

fn answered<T>(stroke: Stroke<T>) -> Result<T> {
    match stroke {
        Stroke::Value(value) => Ok(value),
        Stroke::Back => Err(PromptError::Back),
    }
}

fn is_back_word(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case(BACK_LABEL)
}

fn pick_one<T>(
    message: &str,
    choices: Vec<(T, String, String)>,
    initial: T,
    filter: bool,
) -> Result<Pick<T>>
where
    T: Clone + Eq,
{
    let mut rows = Vec::with_capacity(choices.len() + 1);
    for (value, label, hint) in choices {
        rows.push((Pick::Value(value), label, hint));
    }
    rows.push((Pick::Back, BACK_LABEL.to_owned(), BACK_HINT.to_owned()));
    match keys::choose(
        message,
        &rows,
        &Pick::Value(initial),
        filter,
        BackKey::Honoured,
    )? {
        Stroke::Back => Ok(Pick::Back),
        Stroke::Value(picked) => Ok(picked),
    }
}

fn ask_sync(table: &str, draft: &mut Draft) -> Result<Outcome> {
    explain_rule(
        crate::docs::SYNC_MODE_RULE,
        "Pull-only copies the table down and rejects a local insert, update, or delete.\nRead-write keeps those edits on the device and pushes them when it can.",
    )?;
    let picked = pick_one(
        &format!("{table}: sync mode"),
        vec![
            (
                SyncMode::ReadWrite,
                "read-write".to_owned(),
                "edits stay on the device, then push".to_owned(),
            ),
            (
                SyncMode::PullOnly,
                "pull-only".to_owned(),
                "copy down only; a local write is rejected".to_owned(),
            ),
        ],
        draft.sync,
        false,
    )?;

    match picked {
        Pick::Back => Ok(Outcome::Back),
        Pick::Value(sync) => {
            draft.sync = sync;
            if sync == SyncMode::PullOnly {
                draft.soft_delete = None;
                draft.conflict = ConflictMode::Arrival;
                draft.conflict_journal = false;
            }
            Ok(Outcome::Forward)
        }
    }
}

fn ask_bucket_kind(table: &str, draft: &mut Draft) -> Result<Outcome> {
    explain_rule(
        crate::docs::BUCKET_RULE,
        "This picks which rows are copied onto the device.\nA policy may allow more; those stay on the server.",
    )?;
    let owner_hint = if draft.owner_column.is_empty() {
        "column compared with auth.uid()".to_owned()
    } else {
        format!("column {}", draft.owner_column)
    };
    let picked = pick_one(
        &format!("{table}: who can see a row?"),
        vec![
            (BucketKind::Owner, "by owner".to_owned(), owner_hint),
            (
                BucketKind::Column,
                "by column".to_owned(),
                "tenant or workspace, set in the app with setBucket".to_owned(),
            ),
            (
                BucketKind::None,
                "everyone".to_owned(),
                "every row the policy allows".to_owned(),
            ),
        ],
        draft.kind,
        false,
    )?;

    match picked {
        Pick::Back => Ok(Outcome::Back),
        Pick::Value(kind) => {
            draft.kind = kind;
            Ok(Outcome::Forward)
        }
    }
}

fn ask_owner_column(table: &str, columns: &[String], draft: &mut Draft) -> Result<Outcome> {
    let picked = ask_column_name(
        &format!("{table}: owner column"),
        columns,
        &draft.owner_column,
    )?;

    Ok(apply_pick(picked, |column| draft.owner_column = column))
}

fn ask_tenant_column(table: &str, columns: &[String], draft: &mut Draft) -> Result<Outcome> {
    let picked = ask_column_name(
        &format!("{table}: tenant column"),
        columns,
        &draft.tenant_column,
    )?;

    Ok(apply_pick(picked, |column| {
        draft.tenant_column = column;
    }))
}

fn apply_pick<T>(picked: Pick<T>, store: impl FnOnce(T)) -> Outcome {
    match picked {
        Pick::Back => Outcome::Back,
        Pick::Value(value) => {
            store(value);
            Outcome::Forward
        }
    }
}

fn ask_column_name(message: &str, columns: &[String], current: &str) -> Result<Pick<String>> {
    if columns.is_empty() {
        let (placeholder, kept) = column_opening(current);
        return match keys::read_line(message, &placeholder, kept.as_deref(), false, |_| Ok(()))? {
            Stroke::Back => Ok(Pick::Back),
            Stroke::Value(answer) if is_back_word(&answer) => Ok(Pick::Back),
            Stroke::Value(answer) => Ok(Pick::Value(answer.trim().to_owned())),
        };
    }

    let choices = columns
        .iter()
        .map(|column| (column.clone(), column.clone(), String::new()))
        .collect::<Vec<_>>();
    let initial = if columns.iter().any(|column| column == current) {
        current.to_owned()
    } else {
        columns[0].clone()
    };

    pick_one(message, choices, initial, columns.len() > FILTER_THRESHOLD)
}

fn ask_soft(table: &str, columns: &[ColumnInfo], draft: &mut Draft) -> Result<Outcome> {
    let mut choices = vec![(
        String::new(),
        "none".to_owned(),
        "delete() removes the row and leaves a tombstone".to_owned(),
    )];
    for column in columns
        .iter()
        .filter(|column| is_soft_delete_type(&column.data_type))
    {
        let hint = if column.name == "deleted_at" {
            "the usual column for this".to_owned()
        } else {
            column.data_type.clone()
        };
        choices.push((column.name.clone(), column.name.clone(), hint));
    }
    explain_rule(
        crate::docs::SOFT_DELETE_RULE,
        "delete() writes the current time into this column and leaves the row.\nOrdinary reads skip it until includeDeleted(). No tombstone is written.",
    )?;
    let initial = draft.soft_delete.clone().unwrap_or_default();

    match pick_one(
        &format!("{table}: soft-delete column"),
        choices,
        initial,
        false,
    )? {
        Pick::Back => Ok(Outcome::Back),
        Pick::Value(picked) => {
            draft.soft_delete = if picked.is_empty() {
                None
            } else {
                Some(picked)
            };
            Ok(Outcome::Forward)
        }
    }
}

fn ask_conflict(table: &str, draft: &mut Draft) -> Result<Outcome> {
    explain_rule(
        crate::docs::CONFLICT_RULE,
        "Two edits to the same column cannot both stay. One value is kept.\nArrival uses whichever push reaches Postgres last, and ignores the device clock.\nHLC can still prefer the edit that was made first, after the device reconnects.",
    )?;
    let picked = pick_one(
        &format!("{table}: conflict resolution"),
        vec![
            (
                ConflictMode::Arrival,
                "arrival".to_owned(),
                "the later push keeps the column".to_owned(),
            ),
            (
                ConflictMode::Hlc,
                "hlc".to_owned(),
                "an earlier edit can still win; a clock more than 5s fast is clamped".to_owned(),
            ),
        ],
        draft.conflict,
        false,
    )?;

    match picked {
        Pick::Back => Ok(Outcome::Back),
        Pick::Value(conflict) => {
            draft.conflict = conflict;
            Ok(Outcome::Forward)
        }
    }
}

fn ask_journal(table: &str, draft: &mut Draft) -> Result<Outcome> {
    explain_rule(
        crate::docs::JOURNAL_RULE,
        "The replaced value is stored in kizunasync._conflict_journal.\nA later pull can return it with the row, and the app receives COLUMN_OVERWRITTEN.\nIncrements are not stored. Off unless you turn it on.",
    )?;
    match ask_yes_no(
        &format!("{table}: record overwritten values server-side?"),
        draft.conflict_journal,
        "keep the value that was replaced",
        "drop it",
    )? {
        Pick::Back => Ok(Outcome::Back),
        Pick::Value(value) => {
            draft.conflict_journal = value;
            Ok(Outcome::Forward)
        }
    }
}

fn ask_register(table: &str, draft: &mut Draft) -> Result<Outcome> {
    explain_rule(
        crate::docs::CLIENTS_RULE,
        "On pull, the device can be written into kizunasync._clients.\nRetention, and the list of devices that have gone quiet, are counted from that row.",
    )?;
    match ask_yes_no(
        &format!("{table}: register the clients that sync it?"),
        draft.register_clients,
        "write the device into _clients on pull",
        "do not register devices for this table",
    )? {
        Pick::Back => Ok(Outcome::Back),
        Pick::Value(value) => {
            draft.register_clients = value;
            Ok(Outcome::Forward)
        }
    }
}

fn ask_yes_no(message: &str, current: bool, yes_hint: &str, no_hint: &str) -> Result<Pick<bool>> {
    pick_one(
        message,
        vec![
            (true, "yes".to_owned(), yes_hint.to_owned()),
            (false, "no".to_owned(), no_hint.to_owned()),
        ],
        current,
        false,
    )
}

fn ask_min_schema(table: &str, draft: &mut Draft) -> Result<Outcome> {
    explain_rule(
        crate::docs::SCHEMA_VERSION_RULE,
        "A client built for an older schema is stopped with RESET_REQUIRED and has to download the table again.\nStart at 1 unless you have already shipped a later contract.",
    )?;
    match ask_count_or_back(
        &format!("{table}: lowest client schema version"),
        draft.min_schema_version,
        DEFAULT_MIN_SCHEMA_VERSION,
    )? {
        Pick::Back => Ok(Outcome::Back),
        Pick::Value(version) => {
            draft.min_schema_version = version;
            Ok(Outcome::Forward)
        }
    }
}

fn ask_tombstone(table: &str, draft: &mut Draft) -> Result<Outcome> {
    explain_rule(
        crate::docs::TOMBSTONE_RULE,
        "A hard delete leaves a tombstone so other devices can drop the row.\nEmpty keeps it for the project setting, 30 days unless you changed that.",
    )?;
    let (placeholder, kept) = tombstone_opening(draft);
    let answer = keys::read_line(
        &format!("{table}: tombstone retention in days"),
        &placeholder,
        kept.as_deref(),
        false,
        |value| validate_ttl_or_back(value).map_err(str::to_owned),
    )?;
    let Stroke::Value(answer) = answer else {
        return Ok(Outcome::Back);
    };
    draft.tombstone_ttl_days = answer.trim().parse::<i64>().ok();

    Ok(Outcome::Forward)
}

/// What a typed field shows while it is empty, and what Enter alone submits.
type Opening = (String, Option<String>);

/// The kept answer, shown in the empty field and submitted by Enter alone,
/// else `hint` and no default.
fn kept_or_hint(kept: Option<String>, hint: &str) -> Opening {
    match kept {
        Some(kept) => (kept.clone(), Some(kept)),
        None => (hint.to_owned(), None),
    }
}

fn tombstone_opening(draft: &Draft) -> Opening {
    kept_or_hint(
        draft.tombstone_ttl_days.map(|days| days.to_string()),
        "empty = the project default",
    )
}

/// The push policy the custom field's `answer` sets over `current`: a count
/// caps a push, and an empty field saves no cap.
pub(super) fn push_policy_from(answer: &str, current: &ProjectSettings) -> ProjectSettings {
    ProjectSettings {
        max_batch_size: Some(
            answer
                .trim()
                .parse::<i64>()
                .map_or(MaxBatchSize::Unlimited, MaxBatchSize::Mutations),
        ),
        require_atomic: None,
        ..current.clone()
    }
}

/// The current push cap as text to edit, empty when no cap is set.
fn batch_size_text(current: &ProjectSettings) -> String {
    current
        .max_batch_size
        .and_then(MaxBatchSize::mutations)
        .map(|size| size.to_string())
        .unwrap_or_default()
}

fn column_opening(current: &str) -> Opening {
    kept_or_hint(
        (!current.is_empty()).then(|| current.to_owned()),
        "column name",
    )
}

fn ask_count_or_back(message: &str, current: i64, minimum: i64) -> Result<Pick<i64>> {
    let starting = current.to_string();
    let answer = keys::read_line(message, &starting, Some(&starting), false, |value| {
        validate_count_or_back(value, minimum)
    })?;
    let Stroke::Value(answer) = answer else {
        return Ok(Pick::Back);
    };

    // `validate` already rejects anything other than `back` or an i64 at least
    // `minimum`. The fallback only covers a cliclack contract change.
    Ok(Pick::Value(answer.trim().parse::<i64>().unwrap_or(current)))
}

fn validate_count_or_back(value: &str, minimum: i64) -> std::result::Result<(), String> {
    if is_back_word(value) {
        return Ok(());
    }

    validate_at_least(value, minimum)
}

fn validate_ttl_or_back(value: &str) -> std::result::Result<(), &'static str> {
    if is_back_word(value) {
        return Ok(());
    }

    validate_ttl(value)
}

fn validate_schedule_or_back(value: &str) -> std::result::Result<(), &'static str> {
    if is_back_word(value) {
        return Ok(());
    }

    validate_schedule(value)
}

fn validate_batch_size_or_back(value: &str) -> std::result::Result<(), &'static str> {
    if is_back_word(value) {
        return Ok(());
    }

    validate_batch_size(value)
}

/// The rule's name, linked, then its one sentence. Counted with the question
/// under it, so Backspace erases the pair together.
fn explain_rule(rule: crate::docs::DocsRef, body: &str) -> Result<()> {
    paint_theme(&wizard_theme::rule_card(rule.title, rule.url, body))
}

/// A one-line explanation above a prompt that has no rule page of its own.
fn explain(line: &str) -> Result<()> {
    paint_theme(&wizard_theme::remark_log(line))
}

/// The values the maintenance section keeps on its first option, one line
/// above its question.
fn describe_maintenance(current: &ProjectSettings) -> String {
    format!(
        "Schedules (UTC): reap {}, compact {}, prune {}. Client retention {} days, HLC skew ceiling {} ms, tombstone retention {} days, pull scan cap {} candidates.",
        current
            .reap_schedule
            .as_deref()
            .unwrap_or(DEFAULT_REAP_SCHEDULE),
        current
            .compact_schedule
            .as_deref()
            .unwrap_or(DEFAULT_COMPACT_SCHEDULE),
        current
            .client_prune_schedule
            .as_deref()
            .unwrap_or(DEFAULT_CLIENT_PRUNE_SCHEDULE),
        current.client_ttl_days.unwrap_or(DEFAULT_CLIENT_TTL_DAYS),
        current.hlc_max_skew_ms.unwrap_or(DEFAULT_HLC_MAX_SKEW_MS),
        current
            .tombstone_ttl_days
            .unwrap_or(DEFAULT_TOMBSTONE_TTL_DAYS),
        current.max_pull_scan.unwrap_or(DEFAULT_MAX_PULL_SCAN),
    )
}

/// What `pg_cron` schedules, the line above the control panel's question.
fn describe_retention_jobs(jobs: RetentionJobs) -> String {
    match jobs {
        RetentionJobs::NoPgCron => {
            "pg_cron is not installed, so nothing schedules the three retention jobs.".to_owned()
        }
        RetentionJobs::Scheduled(0) => {
            "pg_cron is installed but schedules none of the three retention jobs.".to_owned()
        }
        RetentionJobs::Scheduled(3) => "pg_cron schedules all three retention jobs.".to_owned(),
        RetentionJobs::Scheduled(count) => {
            format!("pg_cron schedules {count} of the three retention jobs.")
        }
    }
}

/// The control panel's two answers: `false` keeps the jobs scheduled, `true`
/// runs retention by hand.
fn retention_rows() -> Vec<(bool, String, String)> {
    vec![
        (
            false,
            "Keep the retention jobs scheduled".to_owned(),
            "pg_cron runs reap, compact and prune on their schedules".to_owned(),
        ),
        (
            true,
            "Run retention myself (the allow-no-cron path)".to_owned(),
            "retention runs only when you run `kizunasync jobs run`".to_owned(),
        ),
    ]
}

fn describe_batch_size(size: Option<MaxBatchSize>) -> String {
    size.and_then(MaxBatchSize::mutations).map_or_else(
        || "unlimited".to_owned(),
        |size| format!("{size} mutations"),
    )
}

/// The seven custom maintenance values, in the order they are asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MaintenanceInput {
    Reap,
    Compact,
    Prune,
    ClientTtl,
    HlcSkew,
    TombstoneTtl,
    PullScan,
}

impl MaintenanceInput {
    const ALL: [Self; 7] = [
        Self::Reap,
        Self::Compact,
        Self::Prune,
        Self::ClientTtl,
        Self::HlcSkew,
        Self::TombstoneTtl,
        Self::PullScan,
    ];

    fn offset(self, by: isize) -> Option<Self> {
        let index = Self::ALL.iter().position(|input| *input == self)?;

        Self::ALL.get(index.checked_add_signed(by)?).copied()
    }
}

/// The maintenance inputs, over the settings their answers fill in.
struct MaintenanceInputs {
    values: ProjectSettings,
}

impl Questions for MaintenanceInputs {
    type Question = MaintenanceInput;

    fn ask(&mut self, input: MaintenanceInput) -> Result<Outcome> {
        let values = &mut self.values;
        Ok(match input {
            MaintenanceInput::Reap => apply_pick(
                ask_schedule(
                    "Tombstone reaper",
                    "Deletes tombstones and changelog rows past their retention.",
                    values
                        .reap_schedule
                        .as_deref()
                        .unwrap_or(DEFAULT_REAP_SCHEDULE),
                )?,
                |schedule| values.reap_schedule = Some(schedule),
            ),
            MaintenanceInput::Compact => apply_pick(
                ask_schedule(
                    "Changelog compactor",
                    "Drops changelog rows every registered client has already pulled.",
                    values
                        .compact_schedule
                        .as_deref()
                        .unwrap_or(DEFAULT_COMPACT_SCHEDULE),
                )?,
                |schedule| values.compact_schedule = Some(schedule),
            ),
            MaintenanceInput::Prune => apply_pick(
                ask_schedule(
                    "Client pruner",
                    "Deletes client rows silent past the TTL, so one dead device cannot hold the compaction floor.",
                    values
                        .client_prune_schedule
                        .as_deref()
                        .unwrap_or(DEFAULT_CLIENT_PRUNE_SCHEDULE),
                )?,
                |schedule| values.client_prune_schedule = Some(schedule),
            ),
            MaintenanceInput::ClientTtl => apply_pick(
                ask_count(
                    "Client retention in days",
                    "How long a silent client keeps its row and its place in the compaction floor.",
                    values.client_ttl_days.unwrap_or(DEFAULT_CLIENT_TTL_DAYS),
                    1,
                )?,
                |days| values.client_ttl_days = Some(days),
            ),
            MaintenanceInput::HlcSkew => apply_pick(
                ask_count(
                    "HLC skew ceiling in milliseconds",
                    "How far ahead of the server an origin clock may run before a write is clamped.",
                    values.hlc_max_skew_ms.unwrap_or(DEFAULT_HLC_MAX_SKEW_MS),
                    0,
                )?,
                |millis| values.hlc_max_skew_ms = Some(millis),
            ),
            MaintenanceInput::TombstoneTtl => apply_pick(
                ask_count(
                    "Project tombstone retention in days",
                    "How long a deleted row stays visible to a client that is still catching up.",
                    values
                        .tombstone_ttl_days
                        .unwrap_or(DEFAULT_TOMBSTONE_TTL_DAYS),
                    1,
                )?,
                |days| values.tombstone_ttl_days = Some(days),
            ),
            MaintenanceInput::PullScan => apply_pick(
                ask_count(
                    "Pull scan cap in candidates",
                    "How many changes one pull page examines, withheld ones included, before it stops and continues on the next page.",
                    values.max_pull_scan.unwrap_or(DEFAULT_MAX_PULL_SCAN),
                    1,
                )?,
                |candidates| values.max_pull_scan = Some(candidates),
            ),
        })
    }

    fn next(&self, input: MaintenanceInput) -> Option<MaintenanceInput> {
        input.offset(1)
    }

    fn previous(&self, input: MaintenanceInput) -> Option<MaintenanceInput> {
        input.offset(-1)
    }
}

/// One schedule: explained, linked to where it can be read back in words, and
/// refused by the same grammar the pack's check constraint applies. The
/// field opens empty on `current`, which Enter keeps.
fn ask_schedule(label: &str, explanation: &str, current: &str) -> Result<Pick<String>> {
    explain(&format!(
        "{explanation} {}",
        link_or_url("crontab.guru", &cron::guru_link(current))
    ))?;
    let answer = keys::read_line(
        &format!("{label} schedule (UTC)"),
        current,
        Some(current),
        false,
        |value| validate_schedule_or_back(value).map_err(str::to_owned),
    )?;

    Ok(match answer {
        Stroke::Back => Pick::Back,
        Stroke::Value(schedule) => Pick::Value(schedule.trim().to_owned()),
    })
}

/// One whole-number knob, explained, refused below `minimum`.
fn ask_count(label: &str, explanation: &str, current: i64, minimum: i64) -> Result<Pick<i64>> {
    explain(explanation)?;

    ask_count_or_back(label, current, minimum)
}

/// A schedule the pack's check constraint will accept.
fn validate_schedule(value: &str) -> std::result::Result<(), &'static str> {
    if cron::is_cron_schedule(value.trim()) {
        return Ok(());
    }

    Err("five UTC crontab fields: minute hour day-of-month month day-of-week")
}

/// A whole number the pack's own bound accepts.
fn validate_at_least(value: &str, minimum: i64) -> std::result::Result<(), String> {
    match value.trim().parse::<i64>() {
        Ok(parsed) if parsed >= minimum => Ok(()),
        _ => Err(format!("a whole number, at least {minimum}")),
    }
}

/// A batch size the pack will accept: at least one, or nothing at all.
fn validate_batch_size(value: &str) -> std::result::Result<(), &'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    match trimmed.parse::<i64>() {
        Ok(size) if size >= 1 => Ok(()),
        _ => Err("a whole number of mutations, at least 1, or empty for unlimited"),
    }
}

/// A retention the pack will accept: a positive whole number of days, or
/// nothing at all.
fn validate_ttl(value: &str) -> std::result::Result<(), &'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    match trimmed.parse::<i64>() {
        Ok(days) if days > 0 => Ok(()),
        _ => Err("whole days, greater than zero, or empty to inherit"),
    }
}

fn is_soft_delete_type(data_type: &str) -> bool {
    data_type.contains("timestamp") || data_type == "date" || data_type == "boolean"
}

/// The project list's muted column: the ref, plus the region when the API gave
/// one. The ref is what disambiguates two projects with the same name.
pub(crate) fn project_hint(project: &ProjectSummary) -> String {
    if project.region.is_empty() {
        return project.project_ref.clone();
    }

    format!("{} · {}", project.project_ref, project.region)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_only_skips_the_write_questions_and_back_returns_to_the_bucket() {
        assert_eq!(
            next_step(
                LadderStep::BucketKind,
                BucketKind::None,
                true,
                SyncMode::PullOnly
            ),
            Some(LadderStep::Register)
        );
        assert_eq!(
            previous_step(
                LadderStep::Register,
                BucketKind::None,
                true,
                SyncMode::PullOnly
            ),
            Some(LadderStep::BucketKind)
        );
        assert_eq!(
            next_step(
                LadderStep::OwnerColumn,
                BucketKind::Owner,
                true,
                SyncMode::PullOnly
            ),
            Some(LadderStep::Register)
        );
        assert_eq!(
            next_step(
                LadderStep::BucketKind,
                BucketKind::None,
                true,
                SyncMode::ReadWrite
            ),
            Some(LadderStep::SoftDelete)
        );
    }

    /// Questions answered from a script: `true` answers and moves on, `false`
    /// is Backspace.
    struct Answering {
        answers: Vec<bool>,
        asked: Vec<usize>,
        count: usize,
    }

    impl Answering {
        fn new(count: usize, answers: &[bool]) -> Self {
            Self {
                answers: answers.to_vec(),
                asked: Vec::new(),
                count,
            }
        }
    }

    impl Questions for Answering {
        type Question = usize;

        fn ask(&mut self, question: usize) -> Result<Outcome> {
            self.asked.push(question);
            if self.answers.remove(0) {
                Ok(Outcome::Forward)
            } else {
                Ok(Outcome::Back)
            }
        }

        fn next(&self, question: usize) -> Option<usize> {
            (question + 1 < self.count).then_some(question + 1)
        }

        fn previous(&self, question: usize) -> Option<usize> {
            question.checked_sub(1)
        }
    }

    #[test]
    fn backspace_on_a_value_reopens_the_one_before_and_on_the_first_leaves_the_step() {
        let mut answered = Answering::new(3, &[true, true, false, true, true]);
        let mut left = Answering::new(3, &[true, false, false]);

        assert!(matches!(walk_questions(&mut answered, 0), Ok(true)));
        assert_eq!(answered.asked, [0, 1, 2, 1, 2]);
        assert!(matches!(walk_questions(&mut left, 0), Ok(false)));
        assert_eq!(left.asked, [0, 1, 0]);
    }

    #[test]
    fn a_walk_opened_on_its_last_question_steps_back_one_question_at_a_time() {
        let mut questions = Answering::new(3, &[false, false, true, true, true]);

        assert!(matches!(walk_questions(&mut questions, 2), Ok(true)));
        assert_eq!(questions.asked, [2, 1, 0, 1, 2]);
    }

    #[test]
    fn the_maintenance_values_follow_each_other_one_step_at_a_time() {
        let inputs = MaintenanceInputs {
            values: ProjectSettings::default(),
        };
        let mut forward = vec![MaintenanceInput::ALL[0]];
        while let Some(next) = inputs.next(forward[forward.len() - 1]) {
            forward.push(next);
        }
        let mut backward = vec![MaintenanceInput::PullScan];
        while let Some(previous) = inputs.previous(backward[backward.len() - 1]) {
            backward.push(previous);
        }
        backward.reverse();

        assert_eq!(forward, MaintenanceInput::ALL);
        assert_eq!(backward, MaintenanceInput::ALL);
    }

    /// A table's ladder opened on its last question walks back through every
    /// question it asked, the write questions of a read-write table included.
    #[test]
    fn a_table_reopened_on_its_last_question_steps_back_through_every_asked_one() {
        let mut step = LadderStep::Tombstone;
        let mut walked = vec![step];
        while let Some(previous) = previous_step(step, BucketKind::Owner, true, SyncMode::ReadWrite)
        {
            walked.push(previous);
            step = previous;
        }

        assert_eq!(
            walked,
            [
                LadderStep::Tombstone,
                LadderStep::MinSchema,
                LadderStep::Register,
                LadderStep::Journal,
                LadderStep::Conflict,
                LadderStep::SoftDelete,
                LadderStep::OwnerColumn,
                LadderStep::BucketKind,
                LadderStep::Sync,
            ]
        );
    }

    /// The word `back` is accepted by every custom value, so typing it steps
    /// back the way Backspace on the empty field does.
    #[test]
    fn the_word_back_passes_every_custom_value_validator() {
        assert_eq!(validate_schedule_or_back("back"), Ok(()));
        assert_eq!(validate_batch_size_or_back(" Back "), Ok(()));
        assert_eq!(validate_count_or_back("back", 1), Ok(()));
        assert!(validate_schedule_or_back("never").is_err());
        assert!(validate_batch_size_or_back("0").is_err());
    }

    /// A typed value reopened on an earlier answer shows that answer, and an
    /// empty Enter keeps it; an unanswered one shows what empty means.
    #[test]
    fn a_typed_value_opens_on_its_earlier_answer() {
        let mut draft = draft_from(&TableProposal::derived("notes", None, "notes"));
        draft.tombstone_ttl_days = Some(14);

        assert_eq!(
            tombstone_opening(&draft),
            ("14".to_owned(), Some("14".to_owned()))
        );
        assert_eq!(
            column_opening("user_id"),
            ("user_id".to_owned(), Some("user_id".to_owned()))
        );
        draft.tombstone_ttl_days = None;
        assert_eq!(
            tombstone_opening(&draft),
            ("empty = the project default".to_owned(), None)
        );
        assert_eq!(column_opening(""), ("column name".to_owned(), None));
    }

    /// The custom push field opens holding the current cap as text to edit,
    /// and empty when no cap is set.
    #[test]
    fn the_custom_push_field_opens_holding_the_current_cap() {
        let capped = ProjectSettings {
            max_batch_size: Some(MaxBatchSize::Mutations(500)),
            ..ProjectSettings::default()
        };
        let uncapped = ProjectSettings {
            max_batch_size: Some(MaxBatchSize::Unlimited),
            ..ProjectSettings::default()
        };

        assert_eq!(batch_size_text(&capped), "500");
        assert_eq!(batch_size_text(&uncapped), "");
        assert_eq!(batch_size_text(&ProjectSettings::default()), "");
    }

    /// The control panel's pg_cron question says what pg_cron schedules, then
    /// offers to keep the jobs scheduled or run retention by hand. Stopping an
    /// install is the install's own question.
    #[test]
    fn the_retention_question_states_the_schedule_and_offers_keep_or_by_hand() {
        assert_eq!(
            describe_retention_jobs(RetentionJobs::Scheduled(3)),
            "pg_cron schedules all three retention jobs."
        );
        assert_eq!(
            describe_retention_jobs(RetentionJobs::Scheduled(2)),
            "pg_cron schedules 2 of the three retention jobs."
        );
        assert_eq!(
            describe_retention_jobs(RetentionJobs::Scheduled(0)),
            "pg_cron is installed but schedules none of the three retention jobs."
        );
        assert_eq!(
            describe_retention_jobs(RetentionJobs::NoPgCron),
            "pg_cron is not installed, so nothing schedules the three retention jobs."
        );
        let options: Vec<(bool, String)> = retention_rows()
            .into_iter()
            .map(|(by_hand, label, _)| (by_hand, label))
            .collect();
        assert_eq!(
            options,
            [
                (false, "Keep the retention jobs scheduled".to_owned()),
                (
                    true,
                    "Run retention myself (the allow-no-cron path)".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn the_custom_push_input_says_that_an_emptied_field_saves_no_cap() {
        assert_eq!(
            MAX_BATCH_MESSAGE,
            "Largest push the server accepts (an emptied field saves no cap)"
        );
    }

    #[test]
    fn the_maintenance_summary_names_the_pull_scan_cap_it_keeps() {
        let summary = describe_maintenance(&ProjectSettings {
            max_pull_scan: Some(2500),
            ..ProjectSettings::default()
        });

        assert!(
            summary.ends_with("tombstone retention 30 days, pull scan cap 2500 candidates."),
            "{summary}"
        );
        assert!(
            describe_maintenance(&ProjectSettings::default())
                .ends_with("pull scan cap 5000 candidates.")
        );
    }
}
