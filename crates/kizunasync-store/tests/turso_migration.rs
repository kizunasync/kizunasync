#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Original SQLite fixtures verify every persisted table, including dirty WAL.

use kizunasync_db::Connection;
use kizunasync_store::LocalStore;
use serde_json::Value;
use std::{fs, path::Path};

fn verify_snapshot(path: &Path, snapshot: &str, old_schema: bool) {
    let expected: Value = serde_json::from_str(snapshot).unwrap();
    let conn = Connection::open(path).unwrap();
    for (table, fixture) in expected.as_object().unwrap() {
        let columns = fixture["columns"].as_array().unwrap();
        let names = columns
            .iter()
            .map(|column| format!("\"{}\"", column.as_str().unwrap()))
            .collect::<Vec<_>>()
            .join(",");
        let mut statement = conn
            .prepare(&format!("SELECT json_array({names}) FROM \"{table}\""))
            .unwrap();
        let mut actual = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| serde_json::from_str::<Value>(&row.unwrap()).unwrap())
            .collect::<Vec<_>>();
        let mut expected_rows = fixture["rows"].as_array().unwrap().clone();
        actual.sort_by_cached_key(Value::to_string);
        expected_rows.sort_by_cached_key(Value::to_string);
        assert_eq!(actual, expected_rows, "changed persisted table {table}");
    }
    if old_schema {
        assert_eq!(
            conn.query_row::<Option<String>>(
                "SELECT error_code FROM _kizunasync_attachments",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            None
        );
    }
}

fn migrate(database: &[u8], wal: Option<&[u8]>, snapshot: &str, old_schema: bool) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("offline.db");
    fs::write(&path, database).unwrap();
    if let Some(wal) = wal {
        fs::write(dir.path().join("offline.db-wal"), wal).unwrap();
    }
    let store = LocalStore::open_path(&path).unwrap();
    assert_eq!(store.outbox_depth().unwrap(), 9); // One entry is already in flight.
    assert_eq!(store.list_outbox(100).unwrap().len(), 9);
    assert_eq!(store.get_cursor().unwrap(), "900719925474099312345");
    assert_eq!(
        store.meta_get("client_id").unwrap(),
        "00000000-0000-4000-8000-000000000001"
    );
    let attachment = store.get_attachment("attachment-1").unwrap().unwrap();
    assert_eq!(attachment.chunk_offset, 6_291_456);
    assert_eq!(
        attachment.tus_url.as_deref(),
        Some("https://example.invalid/synthetic-upload")
    );
    drop(store);
    let backup = dir.path().join("offline.db.kizunasync-pre-turso");
    assert_eq!(fs::read(backup.join("database")).unwrap(), database);
    if let Some(wal) = wal {
        assert_eq!(fs::read(backup.join("database-wal")).unwrap(), wal);
    }
    verify_snapshot(&path, snapshot, old_schema);
    // An ordinary reopen preserves the same state and never replaces the backup.
    drop(LocalStore::open_path(&path).unwrap());
    verify_snapshot(&path, snapshot, old_schema);
    assert_eq!(fs::read(backup.join("database")).unwrap(), database);
}

#[test]
fn all_offline_state_survives_closed_sqlite_upgrade() {
    migrate(
        include_bytes!("fixtures/closed.fixture"),
        None,
        include_str!("fixtures/closed.json"),
        false,
    );
}

#[test]
fn committed_sqlite_wal_is_replayed_without_checkpointing_it_with_sqlite() {
    migrate(
        include_bytes!("fixtures/dirty-wal.fixture"),
        Some(include_bytes!("fixtures/dirty-wal.fixture-wal")),
        include_str!("fixtures/dirty-wal.json"),
        false,
    );
}

#[test]
fn older_attachment_schema_is_upgraded_without_losing_upload_progress() {
    migrate(
        include_bytes!("fixtures/old-schema.fixture"),
        None,
        include_str!("fixtures/old-schema.json"),
        true,
    );
}
