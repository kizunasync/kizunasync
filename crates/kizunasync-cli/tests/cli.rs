//! Integration tests: the real `kizunasync` binary, spawned as a process.
//!
//! The library tests already drive every decision through a captured UI. What a
//! process adds, and the only reason these exist, is the part a captured UI
//! cannot prove: that argv reaches the parser, that stdout and stderr really are
//! separate file descriptors, and that the exit code the shell sees is the one
//! the command chose.
//!
//! Every run is hermetic: `env_clear` plus a minimal PATH, so a developer's
//! `KSYNC_DB_URL` or `SUPABASE_ACCESS_TOKEN` can never change an outcome, and a
//! command that would otherwise reach a database stops at resolution instead.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::process::{Command, Output, Stdio};

/// One `kizunasync` run in `cwd`, with a cleared environment plus `env`.
fn kizunasync_in(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kizunasync"));
    command.current_dir(cwd).args(args).env_clear();
    // PATH survives the clear so the binary can still find what it shells out to.
    command.env("PATH", std::env::var("PATH").unwrap_or_default());
    for (key, value) in env {
        command.env(key, value);
    }
    // Turbo's TUI (and any other PTY parent) makes inherited stdin a TTY, and
    // `kizunasync init` then opens the wizard and waits. Tests never prompt.
    command.stdin(Stdio::null());

    command.output().expect("kizunasync should be spawnable")
}

/// One `kizunasync` run in a fresh empty directory.
fn kizunasync(args: &[&str]) -> (tempfile::TempDir, Output) {
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync_in(dir.path(), args, &[]);

    (dir, output)
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn code(output: &Output) -> i32 {
    output
        .status
        .code()
        .expect("kizunasync should exit, not signal")
}

#[test]
fn help_is_a_stdout_payload_and_exits_zero() {
    let (_guard, output) = kizunasync(&["--help"]);

    assert_eq!(code(&output), 0);
    assert_eq!(stderr(&output), "");
    assert!(stdout(&output).contains("Usage: kizunasync"));
}

/// One committed help surface, byte for byte. A deliberate change to a command,
/// flag, or its one-line description is a one-word fix: rerun with
/// `KSYNC_BLESS_GOLDEN=1`.
fn assert_golden_help(args: &[&str], golden_name: &str) {
    let (_guard, output) = kizunasync(args);
    let actual = stdout(&output);
    let golden = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(golden_name);

    assert_eq!(
        code(&output),
        0,
        "kizunasync {} should exit 0",
        args.join(" ")
    );
    assert_eq!(
        stderr(&output),
        "",
        "help is a stdout payload, kizunasync {}",
        args.join(" ")
    );
    if std::env::var("KSYNC_BLESS_GOLDEN").is_ok_and(|value| value == "1") {
        std::fs::write(&golden, &actual).unwrap();

        return;
    }
    let expected = std::fs::read_to_string(&golden).unwrap();

    assert_eq!(
        actual, expected,
        "the CLI surface drifted from tests/golden/{golden_name}: rerun with KSYNC_BLESS_GOLDEN=1 if that was intended"
    );
}

#[test]
fn the_help_output_matches_the_committed_golden() {
    assert_golden_help(&["--help"], "help.txt");
}

#[test]
fn every_subcommand_help_matches_its_committed_golden() {
    for (args, golden_name) in [
        (&["init", "--help"][..], "help-init.txt"),
        (&["sync", "--help"][..], "help-sync.txt"),
        (&["status", "--help"][..], "help-status.txt"),
        (&["doctor", "--help"][..], "help-doctor.txt"),
        (&["lint", "--help"][..], "help-lint.txt"),
        (&["upgrade", "--help"][..], "help-upgrade.txt"),
        (&["deprovision", "--help"][..], "help-deprovision.txt"),
        (&["jobs", "--help"][..], "help-jobs.txt"),
        (&["jobs", "list", "--help"][..], "help-jobs-list.txt"),
        (&["jobs", "run", "--help"][..], "help-jobs-run.txt"),
        (
            &["jobs", "schedule", "--help"][..],
            "help-jobs-schedule.txt",
        ),
        (&["mock", "--help"][..], "help-mock.txt"),
        (&["mock", "seed", "--help"][..], "help-mock-seed.txt"),
        (&["mock", "churn", "--help"][..], "help-mock-churn.txt"),
        (&["version", "--help"][..], "help-version.txt"),
    ] {
        assert_golden_help(args, golden_name);
    }
}

#[test]
fn the_version_is_the_same_bare_payload_in_all_three_spellings() {
    for argv in [["version"], ["--version"], ["-v"]] {
        let (_guard, output) = kizunasync(&argv);

        assert_eq!(code(&output), 0);
        assert_eq!(stdout(&output), format!("{}\n", kizunasync_cli::VERSION));
        assert_eq!(stderr(&output), "");
    }
}

#[test]
fn no_arguments_prints_the_surface_to_stderr_and_exits_clean() {
    let (_guard, output) = kizunasync(&[]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "");
    assert!(stderr(&output).contains("Usage: kizunasync"));
}

#[test]
fn an_unknown_command_exits_two_without_writing_stdout() {
    let (_guard, output) = kizunasync(&["gremlin"]);

    assert_eq!(code(&output), 2);
    assert_eq!(stdout(&output), "");
    assert!(stderr(&output).contains("gremlin"));
}

/// The pack this checkout ships. The spawned binary lives wherever Cargo's
/// build directory is, possibly outside the repository, so the pack is named
/// explicitly rather than left to production's executable-walk rung.
fn pack_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/supabase-pack")
}

#[test]
fn init_without_yes_refuses_in_a_non_tty() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
    let pack = pack_dir();
    let output = kizunasync_in(
        dir.path(),
        &["init", "--local-only"],
        &[("KSYNC_PACK_DIR", pack.to_string_lossy().as_ref())],
    );

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("refusing to write without confirmation"));
}

/// The hosted path introspects and applies over the Management API, so a
/// connection string on that run would reach nothing. It is refused rather
/// than accepted and ignored.
#[test]
fn init_refuses_a_connection_string_alongside_a_project_ref() {
    let (_guard, output) = kizunasync(&[
        "init",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--db-url",
        "postgresql://postgres:x@127.0.0.1:1/postgres",
    ]);

    assert_eq!(code(&output), 2);
    assert!(stdout(&output).is_empty());
    assert!(stderr(&output).contains("--db-url"));
}

/// `sync` gained the same hosted path, with the same refusal.
#[test]
fn sync_refuses_a_connection_string_alongside_a_project_ref() {
    let (_guard, output) = kizunasync(&[
        "sync",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--db-url",
        "postgresql://postgres:x@127.0.0.1:1/postgres",
    ]);

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("--db-url"));
}

/// Every `sync` run reads `kizunasync._config`, so one with no resolvable
/// database stops at resolution.
#[test]
fn sync_without_a_database_stops_at_resolution_with_exit_two() {
    let (_guard, output) = kizunasync(&["sync", "--add", "todos", "--yes"]);

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("could not resolve a database connection"));
}

/// Off a terminal and with nothing to script, the usage line is what a run
/// gets, before any connection is asked for.
#[test]
fn sync_without_flags_off_a_terminal_prints_the_usage() {
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync_in(
        dir.path(),
        &["sync"],
        &[(
            "KSYNC_DB_URL",
            "postgresql://postgres:x@127.0.0.1:1/postgres",
        )],
    );

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("--add"));
}

#[test]
fn a_command_that_needs_a_database_stops_at_resolution_with_exit_two() {
    let (_guard, output) = kizunasync(&["status"]);

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("could not resolve a database connection"));
}

#[test]
fn doctor_ci_writes_parsable_jsonl_on_stdout_and_fails_an_empty_directory() {
    let (_guard, output) = kizunasync(&["doctor", "--ci"]);
    let body = stdout(&output);
    let lines: Vec<&str> = body.lines().collect();

    // An empty directory fails its checks: that is a real failure, exit 1.
    assert_eq!(code(&output), 1);
    assert!(!lines.is_empty());
    for line in lines {
        let value: serde_json::Value =
            serde_json::from_str(line).expect("each --ci line should be one JSON object");
        assert!(value.get("check").is_some());
        assert!(value.get("level").is_some());
        assert!(value.get("message").is_some());
    }
}

/// `lint` answers the one thing it can without a database first: a run from
/// the wrong directory is told that, not asked for credentials.
#[test]
fn lint_without_a_migrations_directory_is_exit_two_before_any_connection() {
    let (_guard, output) = kizunasync(&["lint"]);

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("no supabase/migrations directory"));
    assert_eq!(stdout(&output), "");
}

/// With a migrations directory but no database, the synced set is unreadable
/// and the run cannot classify anything.
#[test]
fn lint_without_a_database_stops_at_resolution_with_exit_two() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("supabase/migrations")).unwrap();
    std::fs::write(
        root.join("supabase/migrations/0001.sql"),
        "alter table todos drop column a;",
    )
    .unwrap();
    let output = kizunasync_in(root, &["lint"], &[]);

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("could not resolve a database connection"));
    assert_eq!(
        stdout(&output),
        "",
        "lint's report is human status, never stdout"
    );
}

#[test]
fn a_dry_run_seed_needs_no_database_and_is_reproducible() {
    let dir = tempfile::tempdir().unwrap();
    let args = [
        "mock",
        "seed",
        "--table",
        "todos",
        "--rows",
        "4",
        "--seed",
        "7",
        "--dry-run",
    ];
    let first = kizunasync_in(dir.path(), &args, &[]);
    let second = kizunasync_in(dir.path(), &args, &[]);

    assert_eq!(code(&first), 0);
    assert!(stdout(&first).contains("insert into public.\"todos\""));
    assert_eq!(
        stdout(&first),
        stdout(&second),
        "the same seed must render the same SQL"
    );
}

/// The four dataset flags describe rows to write and `--clean` deletes the ones
/// already there, so a run naming both is a contradiction. It is refused, not
/// silently resolved in favour of one of them.
#[test]
fn a_clean_seed_refuses_the_dataset_flags_instead_of_ignoring_them() {
    for (flag, value) in [
        ("--rows", "4"),
        ("--users", "2"),
        ("--images", "1"),
        ("--seed", "7"),
    ] {
        let (_guard, output) =
            kizunasync(&["mock", "seed", "--table", "todos", "--clean", flag, value]);

        assert_eq!(
            code(&output),
            2,
            "kizunasync mock seed --clean {flag} {value}"
        );
        assert!(stdout(&output).is_empty());
        assert!(
            stderr(&output).contains("--clean"),
            "the refusal should name the flag it conflicts with, said:\n{}",
            stderr(&output)
        );
    }
}

/// The same run without a dataset flag is exactly what it always was.
#[test]
fn a_clean_seed_on_its_own_still_prints_its_one_delete() {
    let (_guard, output) =
        kizunasync(&["mock", "seed", "--table", "todos", "--clean", "--dry-run"]);

    assert_eq!(code(&output), 0);
    assert!(stdout(&output).contains("delete from public.\"todos\""));
}

/// The guard is checked before a connection is opened, so an unconfirmed seed
/// refuses on its own terms even when the `--db-url` it was given is dead.
#[test]
fn a_seed_without_a_guard_refuses_before_touching_a_database() {
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync_in(
        dir.path(),
        &[
            "mock",
            "seed",
            "--table",
            "todos",
            "--db-url",
            "postgres://127.0.0.1:1/x",
        ],
        &[],
    );

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("Re-run with --yes"));
}

#[test]
fn deprovision_without_a_guard_never_reaches_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync_in(dir.path(), &["deprovision", "--local-only"], &[]);

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("--local-only"));
}

/// `--purge` is refused before a connection is even resolved when the ledger
/// cannot be read, so the flag never reaches a database it was not confirmed
/// for.
#[test]
fn purge_without_a_database_stops_at_resolution_with_exit_two() {
    let (_guard, output) = kizunasync(&["deprovision", "--purge", "--yes"]);

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("could not resolve a database connection"));
    assert_eq!(stdout(&output), "");
}

/// Every `jobs` subcommand reads `cron.job` and `kizunasync._settings`, so one
/// with no resolvable database stops at resolution.
#[test]
fn jobs_without_a_database_stops_at_resolution_with_exit_two() {
    for argv in [
        &["jobs", "list"][..],
        &["jobs", "run", "all"][..],
        &["jobs", "schedule"][..],
    ] {
        let (_guard, output) = kizunasync(argv);

        assert_eq!(code(&output), 2, "kizunasync {}", argv.join(" "));
        assert!(stderr(&output).contains("could not resolve a database connection"));
        assert_eq!(
            stdout(&output),
            "",
            "the report is a stdout payload only when it ran"
        );
    }
}

#[test]
fn jobs_run_refuses_a_job_name_it_does_not_have() {
    let (_guard, output) = kizunasync(&["jobs", "run", "vacuum"]);

    assert_eq!(code(&output), 2);
    assert!(stderr(&output).contains("vacuum"));
    assert!(stderr(&output).contains("reap"));
}

/// The flag is global on the `jobs` group, so it is accepted on either side of
/// the subcommand: a user who types the shape they expect gets it.
#[test]
fn the_jobs_json_flag_is_accepted_before_and_after_the_subcommand() {
    for argv in [
        &["jobs", "--json", "list"][..],
        &["jobs", "list", "--json"][..],
    ] {
        let (_guard, output) = kizunasync(argv);

        assert_eq!(code(&output), 2, "kizunasync {}", argv.join(" "));
        assert!(!stderr(&output).contains("unexpected argument"));
    }
}

#[test]
fn no_color_leaves_no_escape_sequences_anywhere() {
    let (_guard, output) = kizunasync(&["--no-color", "init"]);

    assert!(!stderr(&output).contains('\u{1b}'));
}

#[test]
fn the_no_color_environment_variable_is_honoured_by_the_process_too() {
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync_in(dir.path(), &["init"], &[("NO_COLOR", "1")]);

    assert!(!stderr(&output).contains('\u{1b}'));
}

#[test]
fn the_database_url_environment_variable_is_read_by_the_process() {
    let dir = tempfile::tempdir().unwrap();
    let output = kizunasync_in(
        dir.path(),
        &["status"],
        &[(
            "KSYNC_DB_URL",
            "postgresql://postgres:hunter2@127.0.0.1:1/postgres",
        )],
    );

    assert_eq!(code(&output), 2);
    let text = stderr(&output);
    assert!(text.contains("env:KSYNC_DB_URL"));
    assert!(
        text.contains("postgres:***@"),
        "the password must never be echoed"
    );
}

/// Ctrl+C while a network call waits on the server: the process states that
/// the transaction was not applied and exits `130`, the shell's code for an
/// interrupt, instead of dying on the signal. The server here accepts the
/// connection and never answers, so the run is certain to be mid-call.
#[cfg(unix)]
#[test]
fn ctrl_c_during_a_network_call_exits_130_and_says_nothing_was_applied() {
    use std::io::Read;
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let dir = tempfile::tempdir().unwrap();
    let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
    let mut child = Command::new(env!("CARGO_BIN_EXE_kizunasync"))
        .current_dir(dir.path())
        .args(["status", "--db-url", &url])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (_held, _) = listener.accept().unwrap();

    let interrupted = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(interrupted.success());
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(10) {
            child.kill().unwrap();
            panic!("kizunasync kept running after Ctrl+C");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();

    assert_eq!(status.code(), Some(130), "{status:?}\n{stderr}");
    assert!(
        stderr.contains("interrupted: the transaction in progress was not applied"),
        "{stderr}"
    );
}

/// Ctrl+C typed while a question is still being drawn reaches that question
/// as a key. This terminal reads a few bytes at a time and stops once the
/// solution question's title appears, so the rest of the question is still
/// waiting to be drawn when the key arrives: the wizard cancels, exits `0`,
/// and leaves the terminal in the mode it found.
#[cfg(unix)]
#[test]
fn ctrl_c_while_a_question_is_drawn_cancels_it_and_exits_zero() {
    use std::io::{Read, Write};
    use std::os::fd::AsFd;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use nix::pty::{Winsize, openpty};
    use nix::sys::termios::{LocalFlags, tcgetattr};

    let size = Winsize {
        ws_row: 48,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pty = openpty(&size, None).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kizunasync"))
        .current_dir(dir.path())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("TERM", "xterm-256color")
        .stdin(Stdio::from(pty.slave.try_clone().unwrap()))
        .stdout(Stdio::from(pty.slave.try_clone().unwrap()))
        .stderr(Stdio::from(pty.slave.try_clone().unwrap()))
        .spawn()
        .unwrap();
    let mut reader = std::fs::File::from(pty.master.try_clone().unwrap());
    let mut keyboard = std::fs::File::from(pty.master);
    let (shown, question) = mpsc::channel();
    let (resume, resumed) = mpsc::channel::<()>();
    let (drawn, screen) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut seen = Vec::new();
        let mut sip = [0_u8; 16];
        let asked = |seen: &[u8]| String::from_utf8_lossy(seen).contains("Which solution?");
        while !asked(&seen) {
            let Ok(read @ 1..) = reader.read(&mut sip) else {
                return;
            };
            seen.extend_from_slice(&sip[..read]);
        }
        let mut chunk = [0_u8; 4096];
        let _ = shown.send(());
        let _ = resumed.recv();
        while let Ok(read @ 1..) = reader.read(&mut chunk) {
            let _ = drawn.send(chunk[..read].to_vec());
        }
    });

    question
        .recv_timeout(Duration::from_secs(20))
        .expect("the solution question should appear");
    std::thread::sleep(Duration::from_millis(600));
    keyboard.write_all(&[0x03]).unwrap();
    resume.send(()).unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(10) {
            child.kill().unwrap();
            panic!("Ctrl+C at the question did not end the run");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut after = Vec::new();
    while let Ok(chunk) = screen.recv_timeout(Duration::from_millis(500)) {
        after.extend_from_slice(&chunk);
    }
    let after = String::from_utf8_lossy(&after);
    let modes = tcgetattr(pty.slave.as_fd()).unwrap().local_flags;

    assert_eq!(status.code(), Some(0), "{status:?}\n{after}");
    assert!(after.contains("Nothing written."), "{after}");
    assert!(
        !after.contains("interrupted: the transaction in progress"),
        "{after}"
    );
    assert!(
        modes.contains(LocalFlags::ICANON | LocalFlags::ECHO | LocalFlags::ISIG),
        "{modes:?}"
    );
}
