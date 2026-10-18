#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Process-termination recovery at the engine's Turso boundary.
//!
//! These tests spawn child processes, so they live in their own test binary:
//! a spawned child briefly holds copies of the parent's file descriptors,
//! which kept the migration lock of a parallel `persistence` test held.

use kizunasync_db::Connection;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    name.into()
}

#[test]
fn crash_worker() {
    use std::io::Write;
    let Ok(path) = std::env::var("KIZUNASYNC_DB_CRASH_PATH") else {
        return;
    };
    let conn = Connection::open(path).unwrap();
    conn.finish_migration().unwrap();
    conn.execute_batch("BEGIN IMMEDIATE;
      INSERT INTO _kizunasync_rows(table_name,pk,row_json) VALUES('todos','after-upgrade','{\"title\":\"pending\"}');
      INSERT INTO _kizunasync_outbox(mutation_id,table_name,pk,op,columns_json,created_at)
        VALUES('after-upgrade','todos','after-upgrade','insert','{\"title\":\"pending\"}','2026-10-16T00:00:00Z');").unwrap();
    if std::env::var("KIZUNASYNC_DB_CRASH_COMMITTED").is_ok() {
        conn.execute_batch("COMMIT").unwrap();
    }
    println!("READY");
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
fn process_termination_recovers_committed_writes_and_discards_partial_transactions() {
    use std::{
        io::BufRead,
        process::{Command, Stdio},
        time::Duration,
    };
    for committed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pending.db");
        fs::write(
            &path,
            include_bytes!("../../kizunasync-store/tests/fixtures/closed.fixture"),
        )
        .unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "crash_worker", "--nocapture"])
            .env("KIZUNASYNC_DB_CRASH_PATH", &path)
            .stdout(Stdio::piped());
        if committed {
            command.env("KIZUNASYNC_DB_CRASH_COMMITTED", "1");
        } else {
            command.env_remove("KIZUNASYNC_DB_CRASH_COMMITTED");
        }
        let mut child = command.spawn().unwrap();
        let output = child.stdout.take().unwrap();
        let (ready, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let found = std::io::BufReader::new(output)
                .lines()
                .any(|line| line.is_ok_and(|line| line == "READY"));
            let _ = ready.send(found);
        });
        let reached = receiver.recv_timeout(Duration::from_secs(30));
        let _ = child.kill();
        child.wait().unwrap();
        reader.join().unwrap();
        assert!(
            reached.unwrap(),
            "child failed to reach the requested commit boundary"
        );
        let recovered = Connection::open(&path).unwrap();
        let expected = if committed { 11 } else { 10 };
        for table in ["_kizunasync_rows", "_kizunasync_outbox"] {
            let count = recovered
                .query_row::<i64>(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(
                count, expected,
                "wrong recovery after committed={committed} in {table}"
            );
        }
        assert_eq!(
            fs::read(sidecar(&path, ".kizunasync-pre-turso").join("database")).unwrap(),
            include_bytes!("../../kizunasync-store/tests/fixtures/closed.fixture")
        );
    }
}
