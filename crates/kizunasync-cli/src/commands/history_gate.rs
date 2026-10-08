//! The migration-history gate every pushing path runs before it writes a file,
//! and again after a push that failed.
//!
//! `supabase db push` refuses to run while the database's migration history
//! and `supabase/migrations/` disagree ([`crate::migration_history`]). Writing
//! the new migrations first would leave them on disk behind a push that cannot
//! succeed, and a Retry would only repeat the refusal. So the two lists are
//! compared first: recorded versions with no local file can be marked
//! reverted, with the user's explicit yes, only when the history records each
//! of them under a name this CLI writes; any other version stops the run with
//! the commands that settle it by hand, and so does a local file older than
//! the newest record. A history that cannot be read stops the run as well,
//! unless the user explicitly continues. After a failed push the history is
//! read again: it says which of the written files it records as applied,
//! drift takes the same repair, and a Retry is offered only when both sides
//! agree, the one case where the failure can be transient.

use std::time::Duration;

use crate::catalog::SchemaSource;
use crate::commands::init::{DirectConnection, STEP_BACK, cancel_or_stop};
use crate::commands::{FAILURE, OK, UNUSABLE};
use crate::db::{shell_quote, strip_control_chars};
use crate::emit::is_emitted_name;
use crate::migration_history::{
    AppliedMigration, HistoryDrift, compare, local_versions, version_of,
};
use crate::prompts::{PromptError, Prompter};
use crate::supabase_cli::SupabaseCli;
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

const CONTINUE_UNREAD: &str = "Continue without checking the migration history?";

const UNREAD_STOP: &str = "  nothing written. Fix the history read, then rerun.";

/// Where in the run the history is compared, which decides what a stop says
/// and the exit it ends on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// Before any file is written: a stop leaves the project as it was.
    BeforeWrite,
    /// After `supabase db push` failed: the files are on disk, and a stop
    /// leaves the push failure standing.
    AfterFailedPush,
}

impl Stage {
    /// What a stop left undone.
    const fn nothing(self) -> &'static str {
        match self {
            Self::BeforeWrite => "nothing written",
            Self::AfterFailedPush => "nothing applied",
        }
    }

    /// The same, as the line that closes the wizard.
    const fn outro(self) -> &'static str {
        match self {
            Self::BeforeWrite => "Nothing written.",
            Self::AfterFailedPush => "Nothing applied.",
        }
    }

    /// The last step of a repair made by hand: rerun the command before a
    /// write, push the files already on disk after one.
    fn then(self, flags: &str) -> String {
        match self {
            Self::BeforeWrite => "then rerun".to_owned(),
            Self::AfterFailedPush => format!("then run `supabase db push {flags}`"),
        }
    }

    /// The exit for drift the run cannot settle on its own.
    const fn unsettled(self) -> i32 {
        match self {
            Self::BeforeWrite => UNUSABLE,
            Self::AfterFailedPush => FAILURE,
        }
    }

    /// The exit for a repair the user did not make.
    const fn declined(self) -> i32 {
        match self {
            Self::BeforeWrite => OK,
            Self::AfterFailedPush => FAILURE,
        }
    }
}

/// Compare the database's migration history with `supabase/migrations/` and
/// resolve the drift `supabase db push` would refuse, before anything is
/// written. Answers the versions the history recorded when it was read, none
/// when the user continued past a history that could not be read.
///
/// # Errors
/// Returns the exit code the run stops with: `2` for drift the run cannot
/// resolve on its own and for a history it cannot read with nobody to ask,
/// `1` when the repair failed, `0` when the user declined the repair or
/// declined to continue past an unreadable history, and [`STEP_BACK`] for
/// Backspace.
pub(crate) fn gate_migration_history(
    direct: &DirectConnection,
    paths: &ProjectPaths,
    schemas: &dyn SchemaSource,
    supabase: &dyn SupabaseCli,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> Result<Vec<String>, i32> {
    match read_history(direct, paths, schemas, prompter, ui) {
        Ok(read) if read.drift.is_clean() => Ok(versions_of(&read.applied)),
        Ok(read) => settle_drift(
            direct,
            paths,
            &read,
            supabase,
            prompter,
            ui,
            Stage::BeforeWrite,
        )
        .map(|()| versions_of(&read.applied)),
        Err(cause) => continue_unread(&cause, prompter, ui).map(|()| Vec::new()),
    }
}

/// One read of the history, compared with the directory.
struct HistoryRead {
    applied: Vec<AppliedMigration>,
    drift: HistoryDrift,
}

impl HistoryRead {
    /// The remote-only versions as the history records them, in the order the
    /// drift lists them.
    fn remote_only(&self) -> Vec<&AppliedMigration> {
        self.drift
            .remote_only
            .iter()
            .filter_map(|version| {
                self.applied
                    .iter()
                    .find(|migration| &migration.version == version)
            })
            .collect()
    }
}

/// Read the history and compare it with the directory, reporting whether
/// both sides agree.
fn read_history(
    direct: &DirectConnection,
    paths: &ProjectPaths,
    schemas: &dyn SchemaSource,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> crate::error::Result<HistoryRead> {
    if let Some(prompter) = prompter.as_deref_mut() {
        prompter.start_spin("Comparing the migration history…");
    }
    let applied = match schemas.applied_migrations(&direct.url) {
        Ok(applied) => applied,
        Err(cause) => {
            if let Some(prompter) = prompter.as_deref_mut() {
                prompter.stop_spin("Migration history unread");
            }

            return Err(cause);
        }
    };

    let drift = compare(
        &local_versions(&paths.migrations_dir),
        &versions_of(&applied),
    );
    match (drift.is_clean(), prompter.as_deref_mut()) {
        (true, Some(prompter)) => prompter.stop_spin(&format!(
            "Migration history matches ({} applied)",
            applied.len()
        )),
        (true, None) => ui.log(&format!(
            "  migration history: matches ({} applied)",
            applied.len()
        )),
        (false, Some(prompter)) => prompter.stop_spin("Migration history out of step"),
        (false, None) => {}
    }

    Ok(HistoryRead { applied, drift })
}

fn versions_of(applied: &[AppliedMigration]) -> Vec<String> {
    applied
        .iter()
        .map(|migration| migration.version.clone())
        .collect()
}

/// Whether `supabase db push` would accept the files is unknown, so nothing is
/// written unless the user explicitly continues.
fn continue_unread(
    cause: &crate::error::Error,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> Result<(), i32> {
    ui.error(&format!(
        "  could not read the migration history:\n    {cause}\n  supabase db push refuses to run while that history and supabase/migrations disagree, and this run cannot tell whether they do."
    ));
    let Some(prompter) = prompter.as_deref_mut() else {
        ui.log(UNREAD_STOP);

        return Err(UNUSABLE);
    };

    match prompter.confirm(CONTINUE_UNREAD, false) {
        Ok(true) => Ok(()),
        Ok(false) => {
            let _ = prompter.outro_cancel("Nothing written.");
            ui.log(UNREAD_STOP);

            Err(OK)
        }
        Err(error) => Err(cancel_or_stop(prompter, &error, ui)),
    }
}

/// The flags that name the push target, printed as runnable commands: a
/// `--db-url` already carries no password (PGPASSWORD carries it instead),
/// so each token is only shell-quoted, never masked.
fn target_flags(direct: &DirectConnection) -> String {
    direct
        .push
        .flag_args()
        .iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The history disagrees with the directory: a local file behind it stops the
/// run naming both ways out, versions this CLI wrote are offered the repair,
/// and any other version stops the run with the commands that settle it.
fn settle_drift(
    direct: &DirectConnection,
    paths: &ProjectPaths,
    read: &HistoryRead,
    supabase: &dyn SupabaseCli,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
    stage: Stage,
) -> Result<(), i32> {
    let flags = target_flags(direct);
    if !read.drift.local_behind.is_empty() {
        report_local_behind(&read.drift.local_behind, &flags, stage, ui);

        return Err(stage.unsettled());
    }

    let remote_only = read.remote_only();
    ui.log(&format!(
        "  the database's migration history records {} version(s) with no file in supabase/migrations:\n{}\n  supabase db push refuses to run until both sides agree.",
        remote_only.len(),
        recorded_lines(&remote_only)
    ));
    if !remote_only.iter().all(|migration| is_kizunasync(migration)) {
        report_unowned(&remote_only, &flags, stage, ui);

        return Err(stage.unsettled());
    }

    resolve_remote_only(
        direct,
        paths,
        &read.drift.remote_only,
        supabase,
        prompter,
        ui,
        stage,
    )
}

/// Whether the history records `migration` under a name this CLI writes.
fn is_kizunasync(migration: &AppliedMigration) -> bool {
    migration.name.as_deref().is_some_and(is_emitted_name)
}

fn report_local_behind(local_behind: &[String], flags: &str, stage: Stage, ui: &mut Ui) {
    ui.error(&format!(
        "  these local migrations are older than the newest version the database records and are not applied there:\n{}\n  supabase db push skips out-of-order files. Apply them with `supabase db push --include-all {flags}`, or record them with `supabase migration repair --status applied {} {flags}` if the database already carries their changes, {}.",
        version_lines(local_behind),
        local_behind.join(" "),
        stage.then(flags)
    ));
}

/// Some remote-only version was not written by this CLI, so the history is
/// left as it is: one command per version settles it by hand, and the ones
/// this CLI wrote are marked.
fn report_unowned(remote_only: &[&AppliedMigration], flags: &str, stage: Stage, ui: &mut Ui) {
    let commands = remote_only
        .iter()
        .map(|migration| {
            let mark = if is_kizunasync(migration) {
                "   (written by kizunasync)"
            } else {
                ""
            };
            format!(
                "    supabase migration repair --status reverted {} {flags}{mark}",
                migration.version
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    ui.error(&format!(
        "  kizunasync marks versions reverted only when it wrote every one of them, so the history is left as it is. Compare both sides with `supabase migration list {flags}`, then bring each file back (`supabase db pull`) or mark its version reverted:\n{commands}\n  Settle each one, {}. Marking a version reverted only deletes its row from supabase_migrations.schema_migrations: the SQL it applied stays applied.",
        stage.then(flags)
    ));
}

/// The history records versions with no local file, every one of them
/// written by this CLI: mark them reverted only on the user's explicit yes.
fn resolve_remote_only(
    direct: &DirectConnection,
    paths: &ProjectPaths,
    remote_only: &[String],
    supabase: &dyn SupabaseCli,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
    stage: Stage,
) -> Result<(), i32> {
    let flags = target_flags(direct);
    let repair = format!(
        "supabase migration repair --status reverted {} {flags}",
        remote_only.join(" ")
    );
    let Some(prompter) = prompter.as_deref_mut() else {
        ui.error(&format!(
            "  run `{repair}` or `supabase db pull`, {}.",
            stage.then(&flags)
        ));

        return Err(stage.unsettled());
    };

    let _ = prompter.note(
        "Migration history",
        "Marking them reverted only deletes their rows from supabase_migrations.schema_migrations; the SQL they applied stays applied. Stopping instead leaves everything as it is: run `supabase migration list` and `supabase db pull` to bring the files back.",
    );
    match prompter.confirm(
        "Mark them reverted in the history now (supabase migration repair --status reverted …)?",
        false,
    ) {
        Ok(true) => {}
        Err(PromptError::Back) if stage == Stage::BeforeWrite => return Err(STEP_BACK),
        Err(error) if stage == Stage::BeforeWrite => {
            return Err(cancel_or_stop(prompter, &error, ui));
        }
        // After a failed push the files are already on disk, so a question
        // that ended any way but yes leaves the failed push standing.
        Ok(false) | Err(_) => return Err(leave_unrepaired(prompter, &repair, &flags, stage, ui)),
    }

    let repaired = supabase.repair_reverted(&direct.push, &paths.root, remote_only);
    if !repaired.ok {
        ui.error(&format!(
            "  supabase migration repair failed:\n    {}",
            repaired.stderr.trim()
        ));

        return Err(FAILURE);
    }
    ui.log(&format!(
        "  repaired: {} marked reverted",
        remote_only.join(", ")
    ));

    Ok(())
}

/// The repair was not made: say what is left and the commands that finish it.
fn leave_unrepaired(
    prompter: &mut dyn Prompter,
    repair: &str,
    flags: &str,
    stage: Stage,
    ui: &mut Ui,
) -> i32 {
    let _ = prompter.outro_cancel(stage.outro());
    ui.log(&format!(
        "  {}. Run `{repair}` or `supabase db pull`, {}.",
        stage.nothing(),
        stage.then(flags)
    ));

    stage.declined()
}

fn version_lines(versions: &[String]) -> String {
    versions
        .iter()
        .map(|version| format!("    - {version}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One line per recorded version, with the name the history records it
/// under, stripped of the control characters a row could carry into the
/// terminal.
fn recorded_lines(migrations: &[&AppliedMigration]) -> String {
    migrations
        .iter()
        .map(|migration| {
            let name = migration
                .name
                .as_deref()
                .map_or_else(|| "(no name recorded)".to_owned(), strip_control_chars);
            format!("    - {} {name}", migration.version)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// MARK: - after a failed push

/// What the history says after a failed push.
enum Recheck {
    /// Both sides agree, so the failure can be transient.
    Clean,
    /// The drift was repaired on the user's yes.
    Repaired,
    /// Stop with this exit code; the reason is already on the [`Ui`].
    Stop(i32),
}

/// Push the migrations this run wrote until `supabase db push` succeeds or the
/// run has to stop. A failure reads the history again and says which of the
/// `written` files it records as applied: drift goes to the same repair the
/// gate offers, and a Retry is asked only over a history that agrees with
/// the directory. Ctrl+C during the push settles what it left
/// ([`settle_interrupted_push`]) over a history read given
/// [`INTERRUPTED_READ_WAIT`], and exits `130`.
///
/// # Errors
/// Returns the exit code the run stops with, the reason already on the
/// [`Ui`]: `1` for a push that failed and was neither repaired nor retried,
/// and for a repair that failed.
pub(crate) fn push_written(
    direct: &DirectConnection,
    paths: &ProjectPaths,
    written: &[String],
    schemas: &dyn SchemaSource,
    supabase: &dyn SupabaseCli,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> Result<(), i32> {
    loop {
        let pushed = supabase.push(&direct.push, &paths.root);
        if crate::interrupt::child_stopped() {
            let read = schemas.applied_migrations_owned(&direct.url);
            let applied = crate::interrupt::within(INTERRUPTED_READ_WAIT, read);
            settle_interrupted_push(direct, paths, written, applied, ui);
            crate::interrupt::exit_interrupted();
        }
        if pushed.ok {
            return Ok(());
        }

        ui.log(&format!(
            "\n  supabase db push failed:\n    {}",
            pushed.stderr.trim()
        ));
        match recheck_history(direct, paths, written, schemas, supabase, prompter, ui) {
            Recheck::Repaired => {}
            Recheck::Clean if crate::prompts::confirm_retry(prompter) => {}
            Recheck::Clean => {
                ui.log(&format!(
                    "  Fix the problem and run `supabase db push {}`.",
                    direct.push.describe()
                ));

                return Err(FAILURE);
            }
            Recheck::Stop(code) => return Err(code),
        }
    }
}

fn recheck_history(
    direct: &DirectConnection,
    paths: &ProjectPaths,
    written: &[String],
    schemas: &dyn SchemaSource,
    supabase: &dyn SupabaseCli,
    prompter: &mut Option<&mut dyn Prompter>,
    ui: &mut Ui,
) -> Recheck {
    let read = match read_history(direct, paths, schemas, prompter, ui) {
        Ok(read) => read,
        Err(cause) => {
            let flags = target_flags(direct);
            ui.error(&format!(
                "  could not read the migration history:\n    {cause}\n  {} Check with `supabase migration list {flags}`, then run `supabase db push {flags}`.",
                describe_maybe_applied(written)
            ));

            return Recheck::Stop(FAILURE);
        }
    };

    ui.log(&describe_written(written, &read.applied));
    if read.drift.is_clean() {
        return Recheck::Clean;
    }

    match settle_drift(
        direct,
        paths,
        &read,
        supabase,
        prompter,
        ui,
        Stage::AfterFailedPush,
    ) {
        Ok(()) => Recheck::Repaired,
        Err(code) => Recheck::Stop(code),
    }
}

/// Which of the files this run wrote the history, read again after a failed
/// push, records as applied, and which it does not.
fn describe_written(written: &[String], applied: &[AppliedMigration]) -> String {
    if written.is_empty() {
        return "  this run wrote no file to supabase/migrations.".to_owned();
    }

    let lines = written
        .iter()
        .map(|name| {
            let state = if is_recorded(name, applied) {
                "applied:    "
            } else {
                "not applied:"
            };
            format!("    {state} {name}")
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "  the migration history records, of the files this run wrote to supabase/migrations:\n{lines}"
    )
}

/// What a failed push leaves when the history cannot be read to say more.
fn describe_maybe_applied(written: &[String]) -> String {
    if written.is_empty() {
        return "supabase db push failed, and some migrations may have been applied.".to_owned();
    }

    format!(
        "supabase db push failed, and some of the files this run wrote may have been applied: {}.",
        written.join(", ")
    )
}

// MARK: - after Ctrl+C during a push

/// How long the history read after Ctrl+C during a push gets to answer, so the
/// report always ends.
const INTERRUPTED_READ_WAIT: Duration = Duration::from_secs(10);

/// What Ctrl+C during `supabase db push` left, once the push exited: the
/// history, read again, records some of the `written` files as applied, and
/// every other one was never applied, so it is removed and a later run never
/// meets it. Both lists are reported. `applied` is `None` when the read gave
/// no answer within [`INTERRUPTED_READ_WAIT`]. A history that cannot be read,
/// or did not answer, keeps every file and names the command that tells which
/// ones were applied.
pub(crate) fn settle_interrupted_push(
    direct: &DirectConnection,
    paths: &ProjectPaths,
    written: &[String],
    applied: Option<crate::error::Result<Vec<AppliedMigration>>>,
    ui: &mut Ui,
) {
    let unread = match applied {
        Some(Ok(applied)) => return remove_unrecorded(paths, written, &applied, ui),
        Some(Err(cause)) => cause.to_string(),
        None => format!("no answer within {} s", INTERRUPTED_READ_WAIT.as_secs()),
    };
    ui.log("");
    ui.error(&format!(
        "  interrupted: supabase db push stopped, and the migration history could not be read:\n    {unread}\n  some of the files this run wrote may have been applied, so they stay in supabase/migrations: {}. Check with `supabase migration list {}`, and delete each one the history does not record.",
        written.join(", "),
        target_flags(direct)
    ));
}

/// Remove each `written` file the history does not record, and report both
/// lists.
fn remove_unrecorded(
    paths: &ProjectPaths,
    written: &[String],
    applied: &[AppliedMigration],
    ui: &mut Ui,
) {
    let lines = written
        .iter()
        .map(|name| {
            if is_recorded(name, applied) {
                return format!("    applied: {name} (the migration history records it)");
            }

            match std::fs::remove_file(paths.migrations_dir.join(name)) {
                Ok(()) => format!(
                    "    removed: {name} (the migration history does not record it, so it was never applied)"
                ),
                Err(cause) => format!(
                    "    kept:    {name} (never applied, but it could not be removed: {cause}; delete it before the next run)"
                ),
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    ui.log(&format!(
        "\n  interrupted: supabase db push stopped. Of the files this run wrote to supabase/migrations:\n{lines}"
    ));
}

/// Whether the history records the version of the migration file `name`.
pub(crate) fn is_recorded(name: &str, applied: &[AppliedMigration]) -> bool {
    version_of(name)
        .is_some_and(|version| applied.iter().any(|migration| migration.version == version))
}

/// History fixtures for the drift tests of every command that runs the gate.
#[cfg(test)]
pub(crate) mod fake {
    /// The remote-only version `20260925201900` as the history records it
    /// after `kizunasync` wrote it.
    pub(crate) const KIZUNASYNC_WROTE: &str = "20260925201900_kizunasync_config";
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use crate::config::KizunaSyncConfig;
    use crate::migration_history::AppliedMigration;
    use crate::migration_history::fake::recorded;
    use crate::prompts::{Answer, Ask, ScriptedPrompter};
    use crate::proposals::SchemaCatalog;
    use crate::server_facts::ServerFacts;
    use crate::supabase_cli::fake::{RecordingCli, UnreachableCli};
    use crate::supabase_cli::{CliResult, PushTarget};

    use super::fake::KIZUNASYNC_WROTE;
    use super::*;

    const REMOTE_ONLY: &str = "20260925201900";

    /// [`REMOTE_ONLY`] as the history records it after another tool wrote it.
    const USER_WROTE: &str = "20260925201900_create_todos";

    /// A database whose only answer is its migration history.
    struct History(std::result::Result<Vec<AppliedMigration>, String>);

    impl History {
        /// A history holding `entries`, each written as [`recorded`] reads it.
        fn recording(entries: &[&str]) -> Self {
            Self(Ok(recorded(entries)))
        }
    }

    impl SchemaSource for History {
        fn probe(&self, _url: &str) -> crate::error::Result<ServerFacts> {
            panic!("the gate never tests the connection")
        }

        fn introspect(&self, _url: &str, _schema: &str) -> crate::error::Result<SchemaCatalog> {
            panic!("the gate never introspects")
        }

        fn read_config(&self, _url: &str) -> crate::error::Result<KizunaSyncConfig> {
            panic!("the gate never reads the synced set")
        }

        fn pg_cron_present(&self, _url: &str) -> crate::error::Result<bool> {
            panic!("the gate never reads pg_cron")
        }

        fn applied_migrations(&self, _url: &str) -> crate::error::Result<Vec<AppliedMigration>> {
            self.0.clone().map_err(crate::error::Error::Db)
        }

        fn ledger_rows(
            &self,
            _url: &str,
        ) -> crate::error::Result<Vec<crate::provision::LedgerRow>> {
            panic!("the gate never plans the pack")
        }

        fn pack_applier(&self, _url: &str) -> Box<dyn crate::applier::Applier + '_> {
            panic!("the gate never re-applies the pack")
        }

        fn provisioning_gaps(
            &self,
            _url: &str,
            _expected: &crate::verify::Expectation,
        ) -> crate::error::Result<Vec<String>> {
            Ok(Vec::new())
        }
    }

    fn local(push: PushTarget) -> DirectConnection {
        DirectConnection {
            url: "postgresql://postgres:postgres@127.0.0.1:54322/postgres".to_owned(),
            push,
        }
    }

    /// A project whose `supabase/migrations/` holds `files`.
    fn project(files: &[&str]) -> (tempfile::TempDir, ProjectPaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = ProjectPaths::rooted_at(dir.path().to_path_buf());
        std::fs::create_dir_all(&paths.migrations_dir).unwrap();
        for file in files {
            std::fs::write(paths.migrations_dir.join(file), "").unwrap();
        }

        (dir, paths)
    }

    fn gate(
        direct: &DirectConnection,
        paths: &ProjectPaths,
        schemas: &dyn SchemaSource,
        supabase: &dyn SupabaseCli,
        prompter: Option<&mut ScriptedPrompter>,
    ) -> (Result<Vec<String>, i32>, crate::ui::Capture) {
        let (mut ui, capture) = Ui::capture();
        let mut prompter = prompter.map(|prompter| prompter as &mut dyn Prompter);
        let result =
            gate_migration_history(direct, paths, schemas, supabase, &mut prompter, &mut ui);

        (result, capture)
    }

    #[test]
    fn a_matching_history_passes_and_says_so() {
        let (_dir, paths) = project(&["20260101000000_app.sql"]);
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History::recording(&["20260101000000"]),
            &UnreachableCli,
            None,
        );

        assert_eq!(result, Ok(vec!["20260101000000".to_owned()]));
        assert!(
            capture
                .stderr()
                .contains("migration history: matches (1 applied)")
        );
    }

    #[test]
    fn an_unreadable_history_stops_a_session_that_cannot_ask_before_anything_is_written() {
        let (_dir, paths) = project(&[]);
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History(Err("permission denied".to_owned())),
            &UnreachableCli,
            None,
        );

        assert_eq!(result, Err(UNUSABLE));
        let stderr = capture.stderr();
        assert!(
            stderr.contains("could not read the migration history:\n    permission denied"),
            "{stderr}"
        );
        assert!(stderr.contains(UNREAD_STOP), "{stderr}");
    }

    #[test]
    fn an_unreadable_history_continues_on_an_explicit_yes() {
        let (_dir, paths) = project(&[]);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, _) = gate(
            &local(PushTarget::Local),
            &paths,
            &History(Err("permission denied".to_owned())),
            &UnreachableCli,
            Some(&mut prompter),
        );

        assert_eq!(result, Ok(Vec::new()));
        assert_eq!(
            prompter.asked(),
            [Ask::Confirm {
                message: CONTINUE_UNREAD.to_owned(),
                default: false,
            }]
        );
    }

    #[test]
    fn declining_to_continue_past_an_unreadable_history_writes_nothing() {
        let (_dir, paths) = project(&[]);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History(Err("permission denied".to_owned())),
            &UnreachableCli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(OK));
        assert!(capture.stderr().contains(UNREAD_STOP));
    }

    #[test]
    fn backspace_at_the_unreadable_history_question_steps_back() {
        let (_dir, paths) = project(&[]);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Back]);
        let (result, _) = gate(
            &local(PushTarget::Local),
            &paths,
            &History(Err("permission denied".to_owned())),
            &UnreachableCli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(STEP_BACK));
    }

    #[test]
    fn a_local_file_behind_the_history_stops_naming_include_all() {
        let (_dir, paths) = project(&["0001_kizuna_init.sql", "20260101000000_app.sql"]);
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History::recording(&["20260101000000", REMOTE_ONLY]),
            &UnreachableCli,
            None,
        );

        assert_eq!(result, Err(UNUSABLE));
        let stderr = capture.stderr();
        assert!(stderr.contains("    - 0001"), "{stderr}");
        assert!(
            stderr.contains("supabase db push --include-all --local"),
            "{stderr}"
        );
        assert!(
            stderr.contains("supabase migration repair --status applied 0001 --local"),
            "{stderr}"
        );
    }

    #[test]
    fn a_recorded_version_without_a_file_stops_a_session_that_cannot_ask() {
        let (_dir, paths) = project(&[]);
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History::recording(&[KIZUNASYNC_WROTE]),
            &UnreachableCli,
            None,
        );

        assert_eq!(result, Err(UNUSABLE));
        let stderr = capture.stderr();
        assert!(stderr.contains(&format!("    - {REMOTE_ONLY}")), "{stderr}");
        assert!(
            stderr.contains(&format!(
                "supabase migration repair --status reverted {REMOTE_ONLY} --local"
            )),
            "{stderr}"
        );
        assert!(stderr.contains("supabase db pull"), "{stderr}");
    }

    #[test]
    fn a_db_url_target_is_named_with_the_password_left_to_pgpassword() {
        let (_dir, paths) = project(&[]);
        let (result, capture) = gate(
            &local(PushTarget::DbUrl(
                "postgresql://postgres:s3cr3t@db.example:5432/postgres".to_owned(),
            )),
            &paths,
            &History::recording(&[REMOTE_ONLY]),
            &UnreachableCli,
            None,
        );

        assert_eq!(result, Err(UNUSABLE));
        let stderr = capture.stderr();
        assert!(!stderr.contains("s3cr3t"), "{stderr}");
        assert!(
            stderr.contains("--db-url postgresql://postgres@db.example:5432/postgres"),
            "{stderr}"
        );
    }

    #[test]
    fn a_hint_shell_quotes_a_db_url_that_needs_it() {
        let (_dir, paths) = project(&[]);
        let (result, capture) = gate(
            &local(PushTarget::DbUrl(
                "postgresql://postgres@db.example/postgres?sslmode=require".to_owned(),
            )),
            &paths,
            &History::recording(&[REMOTE_ONLY]),
            &UnreachableCli,
            None,
        );

        assert_eq!(result, Err(UNUSABLE));
        assert!(
            capture
                .stderr()
                .contains("--db-url 'postgresql://postgres@db.example/postgres?sslmode=require'")
        );
    }

    #[test]
    fn a_yes_repairs_the_recorded_versions_on_the_same_target_and_workdir() {
        let (_dir, paths) = project(&[]);
        let cli = RecordingCli::new();
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = gate(
            &local(PushTarget::Linked),
            &paths,
            &History::recording(&[KIZUNASYNC_WROTE]),
            &cli,
            Some(&mut prompter),
        );

        assert_eq!(result, Ok(vec![REMOTE_ONLY.to_owned()]));
        assert_eq!(
            cli.repairs.borrow().as_slice(),
            [(PushTarget::Linked, vec![REMOTE_ONLY.to_owned()])]
        );
        assert_eq!(
            cli.repair_workdirs.borrow().as_slice(),
            std::slice::from_ref(&paths.root)
        );
        assert!(cli.pushes.borrow().is_empty());
        assert_eq!(prompter.notes().len(), 1);
        assert!(matches!(
            prompter.asked(),
            [Ask::Confirm { default: false, .. }]
        ));
        assert!(
            capture
                .stderr()
                .contains(&format!("repaired: {REMOTE_ONLY} marked reverted"))
        );
    }

    #[test]
    fn a_failed_repair_carries_its_stderr_and_fails() {
        let (_dir, paths) = project(&[]);
        let cli = RecordingCli::answering(
            CliResult {
                ok: true,
                stderr: String::new(),
            },
            CliResult {
                ok: false,
                stderr: "Cannot find project ref".to_owned(),
            },
        );
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = gate(
            &local(PushTarget::Linked),
            &paths,
            &History::recording(&[KIZUNASYNC_WROTE]),
            &cli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(FAILURE));
        assert!(
            capture
                .stderr()
                .contains("supabase migration repair failed:\n    Cannot find project ref")
        );
    }

    #[test]
    fn a_no_writes_nothing_and_names_both_ways_out() {
        let (_dir, paths) = project(&[]);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(false)]);
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History::recording(&[KIZUNASYNC_WROTE]),
            &UnreachableCli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(OK));
        assert!(capture.stderr().contains(&format!(
            "nothing written. Run `supabase migration repair --status reverted {REMOTE_ONLY} --local` or `supabase db pull`, then rerun."
        )));
    }

    // MARK: - versions another tool wrote

    #[test]
    fn a_version_another_tool_wrote_stops_without_asking_and_names_the_commands() {
        let (_dir, paths) = project(&[]);
        let mut prompter = ScriptedPrompter::default();
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History::recording(&[USER_WROTE]),
            &UnreachableCli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(UNUSABLE));
        assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
        let stderr = capture.stderr();
        assert!(
            stderr.contains(&format!("    - {REMOTE_ONLY} create_todos\n")),
            "{stderr}"
        );
        assert!(
            stderr.contains("so the history is left as it is"),
            "{stderr}"
        );
        assert!(
            stderr.contains("`supabase migration list --local`"),
            "{stderr}"
        );
        assert!(
            stderr.contains(&format!(
                "    supabase migration repair --status reverted {REMOTE_ONLY} --local\n"
            )),
            "{stderr}"
        );
        assert!(stderr.contains("Settle each one, then rerun."), "{stderr}");
        assert!(!stderr.contains("written by kizunasync"), "{stderr}");
    }

    /// The repair is offered only when every remote-only version is one
    /// `kizunasync` wrote; a mix stops, and each command says whose it is.
    #[test]
    fn a_mix_of_versions_stops_marking_the_ones_kizunasync_wrote() {
        let (_dir, paths) = project(&[]);
        let mut prompter = ScriptedPrompter::default();
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History::recording(&[
                KIZUNASYNC_WROTE,
                "20260925201901_create_todos",
                "20260925201902",
            ]),
            &UnreachableCli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(UNUSABLE));
        assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
        let stderr = capture.stderr();
        assert!(
            stderr.contains(&format!(
                "    - {REMOTE_ONLY} kizunasync_config\n    - 20260925201901 create_todos\n    - 20260925201902 (no name recorded)\n"
            )),
            "{stderr}"
        );
        assert!(
            stderr.contains(&format!(
                "    supabase migration repair --status reverted {REMOTE_ONLY} --local   (written by kizunasync)\n    supabase migration repair --status reverted 20260925201901 --local\n    supabase migration repair --status reverted 20260925201902 --local\n"
            )),
            "{stderr}"
        );
    }

    /// A history without a `name` column cannot say who wrote a version, so
    /// nothing is offered.
    #[test]
    fn a_history_that_records_no_names_is_never_offered_the_repair() {
        let (_dir, paths) = project(&[]);
        let mut prompter = ScriptedPrompter::default();
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History::recording(&[REMOTE_ONLY]),
            &UnreachableCli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(UNUSABLE));
        assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
        assert!(
            capture
                .stderr()
                .contains(&format!("    - {REMOTE_ONLY} (no name recorded)")),
            "{}",
            capture.stderr()
        );
    }

    /// A recorded name is printed without the control characters a row could
    /// carry into the terminal.
    #[test]
    fn a_recorded_name_is_printed_without_control_characters() {
        let (_dir, paths) = project(&[]);
        let (result, capture) = gate(
            &local(PushTarget::Local),
            &paths,
            &History::recording(&["20260925201900_evil\u{1b}[2J"]),
            &UnreachableCli,
            None,
        );

        assert_eq!(result, Err(UNUSABLE));
        let stderr = capture.stderr();
        assert!(!stderr.contains('\u{1b}'), "{stderr:?}");
        assert!(
            stderr.contains(&format!("    - {REMOTE_ONLY} evil[2J")),
            "{stderr}"
        );
    }

    // MARK: - after a failed push

    const WRITTEN: &str = "20260926120000_kizunasync_sync.sql";

    fn failed(stderr: &str) -> CliResult {
        CliResult {
            ok: false,
            stderr: stderr.to_owned(),
        }
    }

    fn pushed() -> CliResult {
        CliResult {
            ok: true,
            stderr: String::new(),
        }
    }

    fn push(
        paths: &ProjectPaths,
        schemas: &dyn SchemaSource,
        supabase: &dyn SupabaseCli,
        prompter: Option<&mut ScriptedPrompter>,
    ) -> (Result<(), i32>, crate::ui::Capture) {
        let (mut ui, capture) = Ui::capture();
        let mut prompter = prompter.map(|prompter| prompter as &mut dyn Prompter);
        let result = push_written(
            &local(PushTarget::Local),
            paths,
            &[WRITTEN.to_owned()],
            schemas,
            supabase,
            &mut prompter,
            &mut ui,
        );

        (result, capture)
    }

    #[test]
    fn a_push_that_succeeds_reads_nothing_and_asks_nothing() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::new();
        let mut prompter = ScriptedPrompter::default();
        let (result, _) = push(
            &paths,
            &History(Err("never read".to_owned())),
            &cli,
            Some(&mut prompter),
        );

        assert_eq!(result, Ok(()));
        assert_eq!(cli.pushes.borrow().len(), 1);
        assert_eq!(
            cli.push_workdirs.borrow().as_slice(),
            std::slice::from_ref(&paths.root)
        );
        assert_eq!(prompter.asked(), Vec::<Ask>::new());
    }

    #[test]
    fn a_failed_push_over_a_clean_history_is_retried_on_yes() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::pushing(vec![failed("connection reset"), pushed()]);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = push(&paths, &History::recording(&[]), &cli, Some(&mut prompter));

        assert_eq!(result, Ok(()));
        assert_eq!(cli.pushes.borrow().len(), 2);
        assert_eq!(
            prompter.asked(),
            [Ask::Confirm {
                message: "Retry?".to_owned(),
                default: true,
            }]
        );
        assert!(
            capture
                .stderr()
                .contains("supabase db push failed:\n    connection reset\n")
        );
        assert!(
            capture
                .stderr()
                .contains(&format!("    not applied: {WRITTEN}"))
        );
    }

    #[test]
    fn a_failed_push_over_a_clean_history_stops_when_nobody_can_retry() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::pushing(vec![failed("connection reset")]);
        let (result, capture) = push(&paths, &History::recording(&[]), &cli, None);

        assert_eq!(result, Err(FAILURE));
        assert_eq!(cli.pushes.borrow().len(), 1);
        assert!(
            capture
                .stderr()
                .contains("Fix the problem and run `supabase db push --local`.")
        );
    }

    #[test]
    fn a_push_refused_for_a_remote_only_version_is_repaired_on_yes_then_pushed_again() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::pushing(vec![
            failed("Remote migration versions not found"),
            pushed(),
        ]);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, _) = push(
            &paths,
            &History::recording(&[KIZUNASYNC_WROTE]),
            &cli,
            Some(&mut prompter),
        );

        assert_eq!(result, Ok(()));
        assert_eq!(
            cli.repairs.borrow().as_slice(),
            [(PushTarget::Local, vec![REMOTE_ONLY.to_owned()])]
        );
        assert_eq!(cli.pushes.borrow().len(), 2);
        assert!(
            !prompter
                .asked()
                .iter()
                .any(|ask| matches!(ask, Ask::Confirm { message, .. } if message == "Retry?")),
            "a refused push is repaired, never retried as it is"
        );
    }

    #[test]
    fn a_remote_only_version_after_a_failed_push_names_the_repair_when_nobody_can_answer() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::pushing(vec![failed("Remote migration versions not found")]);
        let (result, capture) = push(&paths, &History::recording(&[KIZUNASYNC_WROTE]), &cli, None);

        assert_eq!(result, Err(FAILURE));
        assert!(cli.repairs.borrow().is_empty());
        assert!(capture.stderr().contains(&format!(
            "run `supabase migration repair --status reverted {REMOTE_ONLY} --local` or `supabase db pull`, then run `supabase db push --local`."
        )));
    }

    #[test]
    fn backspace_at_the_repair_after_a_failed_push_ends_on_the_failure() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::pushing(vec![failed("Remote migration versions not found")]);
        let mut prompter = ScriptedPrompter::new(vec![Answer::Back]);
        let (result, capture) = push(
            &paths,
            &History::recording(&[KIZUNASYNC_WROTE]),
            &cli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(FAILURE));
        assert!(cli.repairs.borrow().is_empty());
        assert!(capture.stderr().contains(&format!(
            "nothing applied. Run `supabase migration repair --status reverted {REMOTE_ONLY} --local` or `supabase db pull`, then run `supabase db push --local`."
        )));
    }

    #[test]
    fn a_failed_repair_after_a_failed_push_fails_without_pushing_again() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::answering(
            failed("Remote migration versions not found"),
            failed("Cannot find project ref"),
        );
        let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
        let (result, capture) = push(
            &paths,
            &History::recording(&[KIZUNASYNC_WROTE]),
            &cli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(FAILURE));
        assert_eq!(cli.pushes.borrow().len(), 1);
        assert!(
            capture
                .stderr()
                .contains("supabase migration repair failed:\n    Cannot find project ref")
        );
    }

    #[test]
    fn a_local_file_behind_the_history_after_a_failed_push_stops_naming_include_all() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::pushing(vec![failed(
            "Found local migration files to be inserted before the last migration",
        )]);
        let mut prompter = ScriptedPrompter::default();
        let (result, capture) = push(
            &paths,
            &History::recording(&["20991231000000"]),
            &cli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(FAILURE));
        assert_eq!(prompter.asked(), Vec::<Ask>::new());
        let stderr = capture.stderr();
        assert!(
            stderr.contains("supabase db push --include-all --local"),
            "{stderr}"
        );
        assert!(
            stderr.contains("then run `supabase db push --local`."),
            "{stderr}"
        );
    }

    #[test]
    fn a_push_refused_for_a_version_another_tool_wrote_stops_without_asking() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::pushing(vec![failed("Remote migration versions not found")]);
        let mut prompter = ScriptedPrompter::default();
        let (result, capture) = push(
            &paths,
            &History::recording(&[USER_WROTE]),
            &cli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(FAILURE));
        assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
        assert!(cli.repairs.borrow().is_empty());
        assert_eq!(cli.pushes.borrow().len(), 1);
        let stderr = capture.stderr();
        assert!(
            stderr.contains(&format!(
                "    supabase migration repair --status reverted {REMOTE_ONLY} --local\n"
            )),
            "{stderr}"
        );
        assert!(
            stderr.contains("Settle each one, then run `supabase db push --local`."),
            "{stderr}"
        );
    }

    /// After a failed push the message comes from the history read again: the
    /// written files it records as applied, and the ones it does not.
    #[test]
    fn a_failed_push_names_the_written_files_the_history_records_as_applied_and_the_rest() {
        const FIRST: &str = "20260926120000_kizunasync_init.sql";
        const SECOND: &str = "20260926120001_kizunasync_config.sql";
        let (_dir, paths) = project(&[FIRST, SECOND]);
        let cli = RecordingCli::pushing(vec![failed("syntax error at or near \"cron\"")]);
        let (mut ui, capture) = Ui::capture();
        let result = push_written(
            &local(PushTarget::Local),
            &paths,
            &[FIRST.to_owned(), SECOND.to_owned()],
            &History::recording(&["20260926120000_kizunasync_init"]),
            &cli,
            &mut None,
            &mut ui,
        );

        assert_eq!(result, Err(FAILURE));
        let stderr = capture.stderr();
        assert!(
            stderr.contains(&format!(
                "the migration history records, of the files this run wrote to supabase/migrations:\n    applied:     {FIRST}\n    not applied: {SECOND}\n"
            )),
            "{stderr}"
        );
        assert!(!stderr.contains("nothing was applied"), "{stderr}");
    }

    #[test]
    fn an_unreadable_history_after_a_failed_push_stops_without_a_retry() {
        let (_dir, paths) = project(&[WRITTEN]);
        let cli = RecordingCli::pushing(vec![failed("Remote migration versions not found")]);
        let mut prompter = ScriptedPrompter::default();
        let (result, capture) = push(
            &paths,
            &History(Err("permission denied".to_owned())),
            &cli,
            Some(&mut prompter),
        );

        assert_eq!(result, Err(FAILURE));
        assert!(
            prompter.asked().is_empty(),
            "no Retry over an unknown history"
        );
        let stderr = capture.stderr();
        assert!(
            stderr.contains("could not read the migration history:\n    permission denied"),
            "{stderr}"
        );
        assert!(
            stderr.contains(&format!(
                "supabase db push failed, and some of the files this run wrote may have been applied: {WRITTEN}. Check with `supabase migration list --local`, then run `supabase db push --local`."
            )),
            "{stderr}"
        );
    }

    // MARK: - after Ctrl+C during a push

    /// Ctrl+C during `supabase db push`: a written file the history records
    /// stays, one it does not record was never applied and is removed, and
    /// the report names both.
    #[test]
    fn an_interrupted_push_removes_every_written_file_the_history_does_not_record() {
        const APPLIED: &str = "20260926120000_kizunasync_init.sql";
        const NEVER_APPLIED: &str = "20260926120001_kizunasync_config.sql";
        let (_dir, paths) = project(&[APPLIED, NEVER_APPLIED]);
        let (mut ui, capture) = Ui::capture();

        settle_interrupted_push(
            &local(PushTarget::Local),
            &paths,
            &[APPLIED.to_owned(), NEVER_APPLIED.to_owned()],
            Some(Ok(recorded(&["20260926120000"]))),
            &mut ui,
        );

        assert!(paths.migrations_dir.join(APPLIED).exists());
        assert!(!paths.migrations_dir.join(NEVER_APPLIED).exists());
        let stderr = capture.stderr();
        assert!(
            stderr.contains(&format!(
                "interrupted: supabase db push stopped. Of the files this run wrote to supabase/migrations:\n    applied: {APPLIED} (the migration history records it)\n    removed: {NEVER_APPLIED} (the migration history does not record it, so it was never applied)\n"
            )),
            "{stderr}"
        );
    }

    /// With no history to read, nothing says which files were applied, so
    /// every one of them stays and the report names the command that tells.
    #[test]
    fn an_interrupted_push_over_an_unreadable_history_keeps_every_written_file() {
        let (_dir, paths) = project(&[WRITTEN]);
        let (mut ui, capture) = Ui::capture();

        settle_interrupted_push(
            &local(PushTarget::Local),
            &paths,
            &[WRITTEN.to_owned()],
            Some(Err(crate::error::Error::Db("permission denied".to_owned()))),
            &mut ui,
        );

        assert!(paths.migrations_dir.join(WRITTEN).exists());
        let stderr = capture.stderr();
        assert!(
            stderr.contains(
                "interrupted: supabase db push stopped, and the migration history could not be read:\n    permission denied"
            ),
            "{stderr}"
        );
        assert!(
            stderr.contains(&format!(
                "some of the files this run wrote may have been applied, so they stay in supabase/migrations: {WRITTEN}. Check with `supabase migration list --local`, and delete each one the history does not record."
            )),
            "{stderr}"
        );
    }

    /// A history read that does not answer within the wait is a history that
    /// could not be read: every written file stays, named with the command
    /// that tells which ones were applied.
    #[test]
    fn an_interrupted_push_whose_history_read_does_not_answer_keeps_every_written_file() {
        const OTHER: &str = "20260926120001_kizunasync_config.sql";
        let (_dir, paths) = project(&[WRITTEN, OTHER]);
        let (mut ui, capture) = Ui::capture();

        settle_interrupted_push(
            &local(PushTarget::Local),
            &paths,
            &[WRITTEN.to_owned(), OTHER.to_owned()],
            None,
            &mut ui,
        );

        assert!(paths.migrations_dir.join(WRITTEN).exists());
        assert!(paths.migrations_dir.join(OTHER).exists());
        let stderr = capture.stderr();
        assert!(
            stderr.contains(
                "interrupted: supabase db push stopped, and the migration history could not be read:\n    no answer within 10 s\n"
            ),
            "{stderr}"
        );
        assert!(
            stderr.contains(&format!(
                "so they stay in supabase/migrations: {WRITTEN}, {OTHER}. Check with `supabase migration list --local`, and delete each one the history does not record."
            )),
            "{stderr}"
        );
    }
}
