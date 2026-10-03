//! The Supabase CLI verbs this binary spawns: `db push`, `migration repair`,
//! and `login`.
//!
//! Applying migrations stays CLI-mediated: that is what keeps the project's
//! migration history and its linked-project auth working the way the Supabase CLI
//! expects, and it means no service-role key is ever needed. Every READ path goes
//! over a direct Postgres connection instead ([`crate::pg`]): the Supabase CLI
//! has no read verb to wrap.
//!
//! [`build_push_args`] and [`build_repair_args`] are pure so the argv is
//! asserted without spawning anything; [`ProcessCli`] and [`run_login`] are live
//! calls and are never on a unit test's path. Login is the official browser flow
//! that writes a PAT to the keychain; we re-read it afterwards rather than
//! parsing their stdout.

use std::fmt;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use crate::db::{redact_db_url, split_db_url_password};
use crate::error::{Error, Result};

/// What a spawned Supabase CLI call returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliResult {
    /// Whether the process exited zero.
    pub ok: bool,
    /// stderr when it failed; empty on success.
    pub stderr: String,
}

/// The binary resolved from `PATH`.
const BINARY: &str = "supabase";

/// Which database `supabase db push` and `supabase migration repair` address.
///
/// `Debug` is written by hand: a `DbUrl` carries the password, so it renders
/// redacted.
#[derive(Clone, PartialEq, Eq)]
pub enum PushTarget {
    /// `--linked`: the project `supabase link` recorded.
    Linked,
    /// `--local`: the local Supabase stack.
    Local,
    /// `--db-url <url>`: the database this connection string names.
    DbUrl(String),
}

impl fmt::Debug for PushTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Linked => formatter.write_str("Linked"),
            Self::Local => formatter.write_str("Local"),
            Self::DbUrl(url) => formatter
                .debug_tuple("DbUrl")
                .field(&redact_db_url(url))
                .finish(),
        }
    }
}

impl PushTarget {
    /// The Supabase CLI flags that select this database. A `DbUrl` target's
    /// password never appears here: [`Self::pgpassword`] carries it instead,
    /// so it reaches the child through `PGPASSWORD`, never its argv.
    #[must_use]
    pub fn flag_args(&self) -> Vec<String> {
        match self {
            Self::Linked => vec!["--linked".to_owned()],
            Self::Local => vec!["--local".to_owned()],
            Self::DbUrl(url) => vec!["--db-url".to_owned(), split_db_url_password(url).0],
        }
    }

    /// A `DbUrl` target's password, as [`split_db_url_password`] reads it,
    /// for `PGPASSWORD`; `None` for `Linked`/`Local`, or a `DbUrl` with no
    /// password (the linked project's session pooler needs neither:
    /// `supabase` connects with its own login role).
    #[must_use]
    pub fn pgpassword(&self) -> Option<String> {
        match self {
            Self::Linked | Self::Local => None,
            Self::DbUrl(url) => split_db_url_password(url).1,
        }
    }

    /// The flag alone, for status lines and prompts: never the URL.
    #[must_use]
    pub const fn describe(&self) -> &'static str {
        match self {
            Self::Linked => "--linked",
            Self::Local => "--local",
            Self::DbUrl(_) => "--db-url",
        }
    }
}

/// `supabase db push <target>` applies pending migrations to `target`,
/// resolved against `workdir` so the child agrees with this run's own
/// `--workdir`/`SUPABASE_WORKDIR` resolution instead of re-walking from its
/// own cwd.
#[must_use]
pub fn build_push_args(target: &PushTarget, workdir: &Path, dry_run: bool) -> Vec<String> {
    let mut args = vec![
        "db".to_owned(),
        "push".to_owned(),
        "--workdir".to_owned(),
        workdir.display().to_string(),
    ];
    args.extend(target.flag_args());
    if dry_run {
        args.push("--dry-run".to_owned());
    }

    args
}

/// `supabase migration repair --status reverted <target> <versions>` deletes
/// the history rows of `versions` on `target`, resolved against `workdir` as
/// [`build_push_args`] is.
#[must_use]
pub fn build_repair_args(target: &PushTarget, workdir: &Path, versions: &[String]) -> Vec<String> {
    let mut args = vec![
        "migration".to_owned(),
        "repair".to_owned(),
        "--workdir".to_owned(),
        workdir.display().to_string(),
        "--status".to_owned(),
        "reverted".to_owned(),
    ];
    args.extend(target.flag_args());
    args.extend(versions.iter().cloned());

    args
}

/// The Supabase CLI calls that change a database: injected so no test spawns
/// the binary. `workdir` is the project root this run already resolved
/// (`--workdir`/`SUPABASE_WORKDIR`/the `supabase/config.toml` walk), passed
/// on so the child never re-walks from its own cwd and disagrees.
pub trait SupabaseCli {
    /// Apply the pending migrations to `target`.
    fn push(&self, target: &PushTarget, workdir: &Path) -> CliResult;

    /// Mark `versions` reverted in `target`'s migration history.
    fn repair_reverted(
        &self,
        target: &PushTarget,
        workdir: &Path,
        versions: &[String],
    ) -> CliResult;
}

/// The production [`SupabaseCli`]: spawns `supabase` from `PATH`.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessCli;

impl SupabaseCli for ProcessCli {
    /// The push runs supervised: Ctrl+C stops the child and leaves the run
    /// to report what it wrote ([`crate::interrupt`]).
    fn push(&self, target: &PushTarget, workdir: &Path) -> CliResult {
        let args = build_push_args(target, workdir, false);
        let mut command = command_for(&args, target.pgpassword().as_deref());

        captured(&args, output_supervised(&mut command))
    }

    fn repair_reverted(
        &self,
        target: &PushTarget,
        workdir: &Path,
        versions: &[String],
    ) -> CliResult {
        let args = build_repair_args(target, workdir, versions);

        captured(
            &args,
            command_for(&args, target.pgpassword().as_deref()).output(),
        )
    }
}

/// The binary with `args`. `pgpassword`, when given, reaches the child
/// through `PGPASSWORD` rather than `args`.
fn command_for(args: &[String], pgpassword: Option<&str>) -> Command {
    let mut command = Command::new(BINARY);
    command.args(args);
    if let Some(password) = pgpassword {
        command.env("PGPASSWORD", password);
    }

    command
}

/// `command`'s output, captured the way [`Command::output`] captures it, with
/// the child registered so Ctrl+C stops it rather than the run.
fn output_supervised(command: &mut Command) -> std::io::Result<Output> {
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    crate::interrupt::supervised(child.id(), || child.wait_with_output())
}

/// Success, or stderr, from a spawn that ran `args`.
fn captured(args: &[String], output: std::io::Result<Output>) -> CliResult {
    match finished(args, output) {
        Ok(()) => CliResult {
            ok: true,
            stderr: String::new(),
        },
        Err(cause) => CliResult {
            ok: false,
            stderr: cause.to_string(),
        },
    }
}

/// What a spawn that ran `args` came back with.
///
/// # Errors
/// Returns [`Error::Cli`] when the binary could not be spawned: naming the
/// install as the likely cause, or when it exited non-zero, carrying its own
/// stderr rather than a rewording of it. Both the echoed argv and the child's
/// own stderr are redacted: a database password never appears in either. A
/// `--db-url` already carries none (its password travels through
/// `PGPASSWORD` instead), but the child's own messages can still quote a
/// conninfo string or a URL of their own.
fn finished(args: &[String], output: std::io::Result<Output>) -> Result<()> {
    let output = output.map_err(|cause| {
        Error::Cli(format!(
            "failed to spawn the supabase CLI: is it installed and on PATH? ({cause})"
        ))
    })?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stderr.is_empty() {
        let shown = args
            .iter()
            .map(|arg| redact_db_url(arg))
            .collect::<Vec<_>>()
            .join(" ");
        return Err(Error::Cli(format!(
            "{BINARY} {shown} exited with {}",
            output.status
        )));
    }

    Err(Error::Cli(redact_db_url(&stderr)))
}

/// Open the official browser login and wait until it stores a token.
///
/// This is Supabase's own flow (`supabase login`): ECDH session, dashboard
/// page, token written to the OS keychain. We do not reimplement that
/// protocol: the dashboard page is branded for their CLI, and the poll
/// endpoint is not a public contract. After this returns Ok, the token
/// ladder's keyring / file rungs can see it.
///
/// stdin/stdout/stderr are inherited so a device-code prompt still works.
/// `workdir` is passed through like every other spawn ([`SupabaseCli`]),
/// though login writes to the OS keychain rather than a project.
/// Never called from a unit test; production wires it through
/// [`crate::commands::init::InitPorts::browser_login`].
///
/// # Errors
/// Returns [`Error::Cli`] when the binary could not be spawned or exited
/// non-zero.
pub fn run_login(workdir: &Path) -> Result<()> {
    let status = Command::new(BINARY)
        .arg("login")
        .arg("--workdir")
        .arg(workdir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|cause| {
            Error::Cli(format!(
                "failed to spawn `supabase login`: is the Supabase CLI installed and on PATH? ({cause})"
            ))
        })?;
    if status.success() {
        return Ok(());
    }

    Err(Error::Cli(format!("`supabase login` exited with {status}")))
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
pub(crate) mod fake {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    use super::{CliResult, PushTarget, SupabaseCli};

    fn ok() -> CliResult {
        CliResult {
            ok: true,
            stderr: String::new(),
        }
    }

    /// Every call succeeds and nothing is recorded.
    pub(crate) struct NoopCli;

    impl SupabaseCli for NoopCli {
        fn push(&self, _target: &PushTarget, _workdir: &Path) -> CliResult {
            ok()
        }

        fn repair_reverted(
            &self,
            _target: &PushTarget,
            _workdir: &Path,
            _versions: &[String],
        ) -> CliResult {
            ok()
        }
    }

    /// For every path that must never spawn the Supabase CLI: reaching it
    /// fails loudly instead of silently applying anything.
    pub(crate) struct UnreachableCli;

    impl SupabaseCli for UnreachableCli {
        fn push(&self, _target: &PushTarget, _workdir: &Path) -> CliResult {
            panic!("supabase db push must not be reached on this path")
        }

        fn repair_reverted(
            &self,
            _target: &PushTarget,
            _workdir: &Path,
            _versions: &[String],
        ) -> CliResult {
            panic!("supabase migration repair must not be reached on this path")
        }
    }

    /// Records every call and answers with the scripted results.
    pub(crate) struct RecordingCli {
        pub(crate) pushes: RefCell<Vec<PushTarget>>,
        /// The `workdir` each push in [`Self::pushes`] was given, same index.
        pub(crate) push_workdirs: RefCell<Vec<PathBuf>>,
        pub(crate) repairs: RefCell<Vec<(PushTarget, Vec<String>)>>,
        /// The `workdir` each repair in [`Self::repairs`] was given, same index.
        pub(crate) repair_workdirs: RefCell<Vec<PathBuf>>,
        /// One answer per push, in order; the last one answers every later push.
        push_results: RefCell<Vec<CliResult>>,
        pub(crate) repair_result: CliResult,
    }

    impl RecordingCli {
        /// Both calls succeed.
        pub(crate) fn new() -> Self {
            Self::answering(ok(), ok())
        }

        /// Both calls answer with the given results.
        pub(crate) fn answering(push_result: CliResult, repair_result: CliResult) -> Self {
            Self {
                pushes: RefCell::new(Vec::new()),
                push_workdirs: RefCell::new(Vec::new()),
                repairs: RefCell::new(Vec::new()),
                repair_workdirs: RefCell::new(Vec::new()),
                push_results: RefCell::new(vec![push_result]),
                repair_result,
            }
        }

        /// Pushes answer `results` in order, the last one repeating; every
        /// repair succeeds.
        pub(crate) fn pushing(results: Vec<CliResult>) -> Self {
            Self {
                push_results: RefCell::new(results),
                ..Self::new()
            }
        }
    }

    impl SupabaseCli for RecordingCli {
        fn push(&self, target: &PushTarget, workdir: &Path) -> CliResult {
            self.pushes.borrow_mut().push(target.clone());
            self.push_workdirs.borrow_mut().push(workdir.to_path_buf());
            let mut results = self.push_results.borrow_mut();
            if results.len() > 1 {
                return results.remove(0);
            }

            results.first().cloned().unwrap_or_else(ok)
        }

        fn repair_reverted(
            &self,
            target: &PushTarget,
            workdir: &Path,
            versions: &[String],
        ) -> CliResult {
            self.repairs
                .borrow_mut()
                .push((target.clone(), versions.to_vec()));
            self.repair_workdirs
                .borrow_mut()
                .push(workdir.to_path_buf());

            self.repair_result.clone()
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::path::Path;

    use super::*;

    const URL: &str = "postgresql://postgres:s3cr3t@db.example:5432/postgres";
    const STRIPPED_URL: &str = "postgresql://postgres@db.example:5432/postgres";
    const WORKDIR: &str = "/srv/app";

    #[test]
    fn a_push_names_its_target_and_workdir() {
        assert_eq!(
            build_push_args(&PushTarget::Linked, Path::new(WORKDIR), false),
            ["db", "push", "--workdir", WORKDIR, "--linked"]
        );
        assert_eq!(
            build_push_args(&PushTarget::Local, Path::new(WORKDIR), false),
            ["db", "push", "--workdir", WORKDIR, "--local"]
        );
        assert_eq!(
            build_push_args(
                &PushTarget::DbUrl(URL.to_owned()),
                Path::new(WORKDIR),
                false
            ),
            ["db", "push", "--workdir", WORKDIR, "--db-url", STRIPPED_URL]
        );
    }

    #[test]
    fn a_dry_run_push_adds_the_flag_and_nothing_else() {
        assert_eq!(
            build_push_args(&PushTarget::Linked, Path::new(WORKDIR), true),
            ["db", "push", "--workdir", WORKDIR, "--linked", "--dry-run"]
        );
        assert_eq!(
            build_push_args(&PushTarget::DbUrl(URL.to_owned()), Path::new(WORKDIR), true),
            [
                "db",
                "push",
                "--workdir",
                WORKDIR,
                "--db-url",
                STRIPPED_URL,
                "--dry-run"
            ]
        );
    }

    #[test]
    fn a_push_argv_never_carries_the_password() {
        let args = build_push_args(
            &PushTarget::DbUrl(URL.to_owned()),
            Path::new(WORKDIR),
            false,
        );

        assert!(!args.iter().any(|arg| arg.contains("s3cr3t")), "{args:?}");
    }

    #[test]
    fn a_push_argv_built_from_a_query_string_password_never_carries_it() {
        let target = PushTarget::DbUrl(
            "postgresql://postgres@db.example:5432/postgres?sslmode=require&password=s3cr3t"
                .to_owned(),
        );
        let args = build_push_args(&target, Path::new(WORKDIR), false);

        assert_eq!(
            args,
            [
                "db",
                "push",
                "--workdir",
                WORKDIR,
                "--db-url",
                "postgresql://postgres@db.example:5432/postgres?sslmode=require"
            ]
        );
        assert_eq!(target.pgpassword().as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn a_repair_marks_every_version_reverted_on_the_target_and_workdir() {
        let versions = ["20260925201900".to_owned(), "20260925201901".to_owned()];

        assert_eq!(
            build_repair_args(&PushTarget::Local, Path::new(WORKDIR), &versions),
            [
                "migration",
                "repair",
                "--workdir",
                WORKDIR,
                "--status",
                "reverted",
                "--local",
                "20260925201900",
                "20260925201901"
            ]
        );
        assert_eq!(
            build_repair_args(
                &PushTarget::DbUrl(URL.to_owned()),
                Path::new(WORKDIR),
                &versions[..1]
            ),
            [
                "migration",
                "repair",
                "--workdir",
                WORKDIR,
                "--status",
                "reverted",
                "--db-url",
                STRIPPED_URL,
                "20260925201900"
            ]
        );
    }

    #[test]
    fn describe_names_the_flag_never_the_url() {
        assert_eq!(PushTarget::Linked.describe(), "--linked");
        assert_eq!(PushTarget::Local.describe(), "--local");
        assert_eq!(PushTarget::DbUrl(URL.to_owned()).describe(), "--db-url");
    }

    #[test]
    fn a_db_url_target_never_debug_prints_its_password() {
        let rendered = format!("{:?}", PushTarget::DbUrl(URL.to_owned()));

        assert!(!rendered.contains("s3cr3t"), "{rendered}");
        assert!(rendered.contains("db.example"), "{rendered}");
        assert_eq!(format!("{:?}", PushTarget::Local), "Local");
    }

    #[test]
    fn pgpassword_carries_the_decoded_password_for_a_db_url_target_only() {
        assert_eq!(
            PushTarget::DbUrl(URL.to_owned()).pgpassword().as_deref(),
            Some("s3cr3t")
        );
        assert_eq!(PushTarget::Linked.pgpassword(), None);
        assert_eq!(PushTarget::Local.pgpassword(), None);
        assert_eq!(
            PushTarget::DbUrl("postgresql://user@host/db".to_owned()).pgpassword(),
            None
        );
    }
}
