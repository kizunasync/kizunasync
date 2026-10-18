#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Persistence and type contracts at the engine's Turso boundary.

use kizunasync_db::{Connection, OptionalExtension, params};
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
fn checks_types_and_integer_ranges_without_coercing_pending_payloads() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE pending(id INTEGER, text TEXT, bytes BLOB, flag INTEGER)")
        .unwrap();
    let bytes = vec![0, 255, 128, 1];
    conn.execute(
        "INSERT INTO pending VALUES(?,?,?,?)",
        params![i64::MAX, "絆 🧪", bytes, true],
    )
    .unwrap();
    let decoded: (i64, String, Vec<u8>, bool) = conn
        .query_row("SELECT * FROM pending", [], |row| row.try_into())
        .unwrap();
    assert_eq!(decoded, (i64::MAX, "絆 🧪".into(), bytes, true));
    assert!(
        conn.query_row::<u32>("SELECT id FROM pending", [], |row| row.get(0))
            .is_err()
    );
    assert!(
        conn.query_row::<String>("SELECT bytes FROM pending", [], |row| row.get(0))
            .is_err()
    );
    assert!(
        conn.execute("INSERT INTO pending(id) VALUES(?)", params![u64::MAX])
            .is_err()
    );
    assert_eq!(
        conn.query_row::<i64>("SELECT id FROM pending WHERE 0", [], |row| row.get(0))
            .optional()
            .unwrap(),
        None
    );
    assert!(
        conn.query_row::<i64>("SELECT missing FROM pending", [], |row| row.get(0))
            .optional()
            .is_err()
    );
}

#[test]
fn reused_statements_do_not_leak_bindings_and_rollback_discards_both_writes() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE pending(id INTEGER PRIMARY KEY, payload TEXT)")
        .unwrap();
    for id in 0..100 {
        conn.execute(
            "INSERT INTO pending VALUES(?, ?)",
            params![id, format!("pending-{id}")],
        )
        .unwrap();
    }
    conn.execute_batch("BEGIN IMMEDIATE; INSERT INTO pending VALUES(101, 'row'); INSERT INTO pending VALUES(102, 'outbox'); ROLLBACK;").unwrap();
    assert_eq!(
        conn.query_row::<i64>("SELECT count(*) FROM pending", [], |row| row.get(0))
            .unwrap(),
        100
    );
    assert_eq!(
        conn.query_row::<String>("SELECT payload FROM pending WHERE id=?", [99], |row| row
            .get(0))
            .unwrap(),
        "pending-99"
    );
}

#[test]
fn interrupted_first_open_keeps_immutable_snapshot_and_retries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pending.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE pending(id TEXT PRIMARY KEY); INSERT INTO pending VALUES('unsynced')",
        )
        .unwrap();
        conn.query_row::<i64>("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .unwrap();
        // No finish_migration: emulate termination before schema readiness.
    }
    let conn = Connection::open(&path).unwrap();
    let backup = sidecar(&path, ".kizunasync-pre-turso");
    let original = fs::read(backup.join("database")).unwrap();
    assert!(backup.join("manifest.json").exists());
    conn.finish_migration().unwrap();
    conn.execute("INSERT INTO pending VALUES(?)", ["after-upgrade"])
        .unwrap();
    drop(conn);
    let reopened = Connection::open(&path).unwrap();
    assert_eq!(
        reopened
            .query_row::<i64>("SELECT count(*) FROM pending", [], |row| row.get(0))
            .unwrap(),
        2
    );
    assert_eq!(fs::read(backup.join("database")).unwrap(), original);
    reopened.finish_migration().unwrap();
}

#[test]
fn first_open_is_exclusive_and_failed_integrity_never_marks_ready() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pending.db");
    let conn = Connection::open(&path).unwrap();
    assert!(Connection::open(&path).is_err());
    conn.finish_migration().unwrap();
    assert!(Connection::open(&path).is_ok());
    let corrupt = dir.path().join("corrupt.db");
    fs::write(&corrupt, b"not a SQLite database").unwrap();
    assert!(Connection::open(&corrupt).is_err());
    assert!(!sidecar(&corrupt, ".kizunasync-turso-v1").exists());
    assert_eq!(
        fs::read(sidecar(&corrupt, ".kizunasync-pre-turso").join("database")).unwrap(),
        b"not a SQLite database"
    );
}

#[test]
fn refuses_a_corrupt_backup_and_a_partial_readiness_marker() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pending.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE pending(id TEXT)").unwrap();
    }
    drop(Connection::open(&path).unwrap());
    fs::write(
        sidecar(&path, ".kizunasync-pre-turso").join("database"),
        b"corrupt snapshot",
    )
    .unwrap();
    assert!(Connection::open(&path).is_err());
    fs::write(sidecar(&path, ".kizunasync-turso-v1"), b"partial").unwrap();
    assert!(Connection::open(&path).is_err());
}

#[test]
fn preserves_and_refuses_an_unfinished_sqlite_rollback_journal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pending.db");
    fs::write(
        &path,
        include_bytes!("../../kizunasync-store/tests/fixtures/closed.fixture"),
    )
    .unwrap();
    let journal = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];
    fs::write(sidecar(&path, "-journal"), journal).unwrap();
    let before = fs::read(&path).unwrap();
    let error = Connection::open(&path).err().unwrap().to_string();
    assert!(error.contains("unfinished SQLite rollback journal"));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::read(sidecar(&path, "-journal")).unwrap(), journal);
    assert_eq!(
        fs::read(sidecar(&path, ".kizunasync-pre-turso").join("database-journal")).unwrap(),
        journal
    );
    assert!(!sidecar(&path, ".kizunasync-turso-v1").exists());
}
