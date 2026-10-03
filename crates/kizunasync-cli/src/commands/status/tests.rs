use std::path::Path;

use serde_json::Value;

use super::build::{
    API_SCHEMAS_EXPOSED, API_SCHEMAS_NO_FILE, API_SCHEMAS_UNPARSEABLE, api_schemas_not_exposed,
    attach_columns, columns_for_tables_query, describe_api_schemas, describe_ledger, read_clients,
    read_config_tables, read_settings, read_table_columns, with_ledger_ahead,
};
use super::render::{describe_settings, pretty_sections, settings_lines};
use super::*;
use crate::applier::fake::{FakeApplier, text_row};
use crate::commands::OK;
use crate::commands::jobs::JobStatus;
use crate::provision::{Drift, DriftReason, LedgerRow, Plan, PlanFile};
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

/// The whole-row `_settings` read.
const SETTINGS_READ: &str = "select * from kizunasync._settings;";

fn plan_file(name: &str) -> PlanFile {
    PlanFile {
        name: name.to_owned(),
        sql: "select 1;".to_owned(),
        content_hash: "hash".to_owned(),
    }
}

#[test]
fn a_fresh_project_reads_as_not_provisioned() {
    let applier = FakeApplier::new();
    let pack = describe_pack(&Plan::Apply { files: Vec::new() }, &applier).unwrap();

    assert_eq!(pack.state, NOT_PROVISIONED);
}

#[test]
fn an_unversioned_ledger_with_the_core_rpcs_present_names_the_missing_pack_file_row() {
    let applier = FakeApplier::new().answer(
        "pg_proc",
        vec![
            text_row(&[("proname", "pull")]),
            text_row(&[("proname", "push")]),
        ],
    );
    let plan = Plan::ProvisionedUnversioned {
        files: vec![plan_file("0001.sql")],
        recorded_objects: 3,
    };

    assert_eq!(
        describe_pack(&plan, &applier).unwrap().state,
        "provisioned (no pack-file row: not installed by kizunasync init)"
    );
}

#[test]
fn an_unversioned_ledger_missing_an_rpc_is_drift_that_names_it() {
    let applier = FakeApplier::new().answer("pg_proc", vec![text_row(&[("proname", "pull")])]);
    let plan = Plan::ProvisionedUnversioned {
        files: vec![plan_file("0001.sql")],
        recorded_objects: 3,
    };
    let pack = describe_pack(&plan, &applier).unwrap();

    assert_eq!(pack.state, "drift (missing core RPCs: kizunasync.push)");
    assert_eq!(
        pack.offenders.as_deref(),
        Some(["kizunasync.push".to_owned()].as_slice())
    );
}

#[test]
fn an_all_pending_drift_is_an_available_upgrade_not_a_fault() {
    let plan = Plan::Drift {
        files: vec![plan_file("0002.sql")],
        offending: vec![Drift {
            name: "0002.sql".to_owned(),
            reason: DriftReason::NotRecorded,
            recorded_hash: None,
        }],
    };
    let pack = describe_pack(&plan, &FakeApplier::new()).unwrap();

    assert_eq!(pack.state, "upgrade available (1 pending pack file(s))");
    assert_eq!(
        pack.pending_files.as_deref(),
        Some(["0002.sql".to_owned()].as_slice())
    );
}

#[test]
fn a_mixed_drift_is_reported_with_every_offender_and_its_reason() {
    let plan = Plan::Drift {
        files: vec![plan_file("0001.sql"), plan_file("0002.sql")],
        offending: vec![
            Drift {
                name: "0001.sql".to_owned(),
                reason: DriftReason::HashMismatch,
                recorded_hash: Some("deadbeef".to_owned()),
            },
            Drift {
                name: "0002.sql".to_owned(),
                reason: DriftReason::NotRecorded,
                recorded_hash: None,
            },
        ],
    };
    let pack = describe_pack(&plan, &FakeApplier::new()).unwrap();

    assert_eq!(pack.state, "drift");
    assert_eq!(
        pack.offenders.unwrap(),
        ["0001.sql: hash-mismatch", "0002.sql: not-recorded"]
    );
}

fn table(name: &str, state: TableState) -> TableStatus {
    TableStatus {
        table: name.to_owned(),
        state,
        key: vec!["id".to_owned()],
        sync_mode: None,
        bucket_column: None,
        conflict_mode: None,
        conflict_journal: None,
        soft_delete_column: None,
        tombstone_ttl_days: None,
        tombstone_ttl_inherited: true,
        min_schema_version: None,
        register_clients: None,
        created_at: None,
        columns: Vec::new(),
    }
}

/// The settings row a provisioned project carries, as `_settings` seeds it.
fn pack_settings() -> SettingsStatus {
    SettingsStatus {
        max_batch_size: None,
        require_atomic: true,
        reap_schedule: Some("16 3 * * *".to_owned()),
        compact_schedule: Some("47 3 * * *".to_owned()),
        client_prune_schedule: Some("31 3 * * *".to_owned()),
        client_ttl_days: Some(90),
        hlc_max_skew_ms: Some(5000),
        tombstone_ttl_days: Some(30),
        max_pull_scan: Some(5000),
    }
}

/// `kizunasync._config` IS the declaration, so every row it carries is a synced
/// table, and there is no second declaration left to disagree with it.
#[test]
fn every_config_row_reads_as_synced() {
    let applier = FakeApplier::new().answer(
        "from kizunasync._config",
        vec![
            text_row(&[("table_name", "todos"), ("sync_mode", "read-write")]),
            text_row(&[("table_name", "notes"), ("sync_mode", "pull-only")]),
        ],
    );
    let tables = read_config_tables(&applier, None).unwrap();

    assert_eq!(
        tables
            .iter()
            .map(|table| (table.table.as_str(), table.state))
            .collect::<Vec<_>>(),
        [("todos", TableState::Synced), ("notes", TableState::Synced)]
    );
}

#[test]
fn the_clients_and_settings_reads_accept_text_rows_from_the_simple_protocol() {
    let applier = FakeApplier::new()
        .answer(
            "count(distinct user_id)",
            vec![text_row(&[
                ("clients", "3"),
                ("users", "2"),
                ("last_seen", "2024-01-01"),
                ("stale", "1"),
                ("ttl_days", "90"),
            ])],
        )
        .answer(
            SETTINGS_READ,
            vec![text_row(&[
                ("max_batch_size", "500"),
                ("require_atomic", "t"),
                ("reap_schedule", "16 3 * * *"),
                ("compact_schedule", "47 3 * * *"),
                ("client_prune_schedule", "31 3 * * *"),
                ("client_ttl_days", "90"),
                ("hlc_max_skew_ms", "5000"),
                ("tombstone_ttl_days", "30"),
                ("max_pull_scan", "5000"),
            ])],
        );

    assert_eq!(
        read_clients(&applier).unwrap(),
        Some(ClientsStatus {
            clients: 3,
            users: 2,
            last_seen: Some("2024-01-01".to_owned()),
            stale: 1,
            ttl_days: Some(90),
            per_client: Vec::new(),
        })
    );
    assert_eq!(
        read_settings(&applier).unwrap(),
        Some(SettingsStatus {
            max_batch_size: Some(500),
            ..pack_settings()
        })
    );
}

/// The report reads `_settings` and `_config` whole, so a column an older
/// pack lacks reads as absent rather than failing the report.
#[test]
fn the_settings_and_config_reads_select_the_whole_row() {
    let applier = FakeApplier::new();
    read_settings(&applier).unwrap();
    read_config_tables(&applier, None).unwrap();

    assert_eq!(
        *applier.executed.borrow(),
        [
            "select * from kizunasync._settings;",
            "select * from kizunasync._config order by table_name;"
        ]
    );
}

/// The clients reads take `client_ttl_days` from the whole settings row, so a
/// pack without that column counts no device as stale instead of failing the
/// report.
#[test]
fn the_clients_reads_take_the_client_ttl_from_the_whole_settings_row() {
    let applier = FakeApplier::new().answer(
        "count(distinct user_id)",
        vec![text_row(&[
            ("clients", "0"),
            ("users", "0"),
            ("stale", "0"),
        ])],
    );
    read_clients(&applier).unwrap();
    let executed = applier.executed.borrow();

    assert_eq!(executed.len(), 2, "{executed:?}");
    for sql in executed.iter() {
        assert!(
            sql.contains("(to_jsonb(s) ->> 'client_ttl_days')::int"),
            "{sql}"
        );
        assert!(!sql.contains("s.client_ttl_days"), "{sql}");
        assert!(!sql.contains("select client_ttl_days"), "{sql}");
    }
}

/// A settings row without `max_pull_scan`, as an older pack wrote it, reports
/// every other knob and no scan cap.
#[test]
fn a_settings_row_without_the_scan_cap_reports_the_rest() {
    let applier = FakeApplier::new().answer(
        SETTINGS_READ,
        vec![text_row(&[
            ("max_batch_size", "500"),
            ("require_atomic", "t"),
            ("reap_schedule", "16 3 * * *"),
            ("compact_schedule", "47 3 * * *"),
            ("client_prune_schedule", "31 3 * * *"),
            ("client_ttl_days", "90"),
            ("hlc_max_skew_ms", "5000"),
            ("tombstone_ttl_days", "30"),
        ])],
    );

    assert_eq!(
        read_settings(&applier).unwrap(),
        Some(SettingsStatus {
            max_batch_size: Some(500),
            max_pull_scan: None,
            ..pack_settings()
        })
    );
}

/// Every column of the single-row settings table reaches the report, because
/// every one of them has a flag that writes it.
#[test]
fn the_settings_read_carries_all_nine_columns() {
    let settings = read_settings(&settings_applier()).unwrap().unwrap();

    assert_eq!(settings, pack_settings());
    assert_eq!(
        describe_settings(Some(&settings)),
        "max batch unlimited, require atomic true"
    );
    assert_eq!(
        settings_lines(Some(&settings)),
        [
            "reap schedule           16 3 * * *",
            "compact schedule        47 3 * * *",
            "client prune schedule   31 3 * * *",
            "client ttl              90 day(s)",
            "hlc max skew            5000 ms",
            "tombstone ttl           30 day(s)",
            "max pull scan           5000 candidate(s)",
        ]
    );
}

/// Answers only a settings read that selects `max_pull_scan`, so the column
/// reaching the report proves the query asks for it.
fn settings_applier() -> FakeApplier {
    FakeApplier::new().answer(
        SETTINGS_READ,
        vec![crate::applier::fake::row(&[
            ("max_batch_size", Value::Null),
            ("require_atomic", Value::Bool(true)),
            ("reap_schedule", Value::from("16 3 * * *")),
            ("compact_schedule", Value::from("47 3 * * *")),
            ("client_prune_schedule", Value::from("31 3 * * *")),
            ("client_ttl_days", Value::from(90)),
            ("hlc_max_skew_ms", Value::from(5000)),
            ("tombstone_ttl_days", Value::from(30)),
            ("max_pull_scan", Value::from(5000)),
        ])],
    )
}

/// The per-client list is what makes `_clients.last_mutation_id` and the
/// compaction floor readable at all: the aggregate counts above it say how
/// many devices there are, never which one is holding the floor down.
#[test]
fn a_registry_of_two_devices_reads_back_each_one_with_its_watermarks() {
    let applier = FakeApplier::new()
        .answer(
            "count(distinct user_id)",
            vec![text_row(&[
                ("clients", "2"),
                ("users", "1"),
                ("last_seen", "2026-09-11 03:16:00+00"),
                ("stale", "1"),
                ("ttl_days", "90"),
            ])],
        )
        .answer(
            "_cursor_high_water",
            vec![
                text_row(&[
                    ("client_id", "2f6c1f1e-0000-4000-8000-000000000001"),
                    ("user_id", "8e1bd1f8-0000-4000-8000-0000000000aa"),
                    ("last_seen", "2026-09-11 03:16:00+00"),
                    ("last_mutation_id", "1a2b3c4d-0000-4000-8000-00000000000f"),
                    ("cursor_high_water", "88"),
                    ("stale", "f"),
                ]),
                text_row(&[
                    ("client_id", "2f6c1f1e-0000-4000-8000-000000000002"),
                    ("user_id", "8e1bd1f8-0000-4000-8000-0000000000aa"),
                    ("last_seen", "2025-01-01 00:00:00+00"),
                    ("cursor_high_water", "0"),
                    ("stale", "t"),
                ]),
            ],
        );
    let clients = read_clients(&applier).unwrap().unwrap();

    assert_eq!(clients.per_client.len(), 2);
    assert_eq!(
        clients.per_client[0],
        ClientStatus {
            client_id: "2f6c1f1e-0000-4000-8000-000000000001".to_owned(),
            user_id: "8e1bd1f8-0000-4000-8000-0000000000aa".to_owned(),
            last_seen: "2026-09-11 03:16:00+00".to_owned(),
            last_mutation_id: Some("1a2b3c4d-0000-4000-8000-00000000000f".to_owned()),
            cursor_high_water: Some(88),
            stale: false,
        }
    );
    assert_eq!(clients.per_client[1].last_mutation_id, None);
    assert!(clients.per_client[1].stale);
}

#[test]
fn an_empty_settings_table_reads_as_absent_not_as_a_failure() {
    let applier = FakeApplier::new();

    assert_eq!(read_settings(&applier).unwrap(), None);
    assert_eq!(read_clients(&applier).unwrap(), None);
}

#[test]
fn a_null_max_batch_size_is_unlimited() {
    let applier = FakeApplier::new().answer(
        SETTINGS_READ,
        vec![crate::applier::fake::row(&[
            ("max_batch_size", Value::Null),
            ("require_atomic", Value::Bool(false)),
        ])],
    );
    let settings = read_settings(&applier).unwrap();

    assert_eq!(settings.as_ref().unwrap().max_batch_size, None);
    assert_eq!(
        describe_settings(settings.as_ref()),
        "max batch unlimited, require atomic false"
    );
}

fn config_toml(body: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths_for(dir.path());
    std::fs::create_dir_all(&paths.supabase_dir).unwrap();
    std::fs::write(&paths.config_toml, body).unwrap();

    dir
}

fn paths_for(root: &Path) -> ProjectPaths {
    ProjectPaths::rooted_at(root.to_path_buf())
}

#[test]
fn the_api_schema_section_tells_absent_unexposed_and_unparseable_apart() {
    let missing = tempfile::tempdir().unwrap();
    assert_eq!(
        describe_api_schemas(&paths_for(missing.path())),
        API_SCHEMAS_NO_FILE
    );

    let exposed = config_toml("[api]\nschemas = [\"public\", \"kizunasync\"]\n");
    assert_eq!(
        describe_api_schemas(&paths_for(exposed.path())),
        API_SCHEMAS_EXPOSED
    );

    let plain = config_toml("[api]\nschemas = [\"public\"]\n");
    assert_eq!(
        describe_api_schemas(&paths_for(plain.path())),
        api_schemas_not_exposed()
    );

    let multiline = config_toml("[api]\nschemas = [\n  \"public\",\n]\n");
    assert_eq!(
        describe_api_schemas(&paths_for(multiline.path())),
        api_schemas_not_exposed()
    );

    let multiline_exposed =
        config_toml("[api]\nschemas = [\n  \"public\",\n  \"kizunasync\",\n]\n");
    assert_eq!(
        describe_api_schemas(&paths_for(multiline_exposed.path())),
        API_SCHEMAS_EXPOSED
    );

    let unparseable = config_toml("[api]\nschemas = [\n  \"public\",\n");
    assert_eq!(
        describe_api_schemas(&paths_for(unparseable.path())),
        API_SCHEMAS_UNPARSEABLE
    );

    let no_key = config_toml("[api]\nport = 1\n");
    assert_eq!(
        describe_api_schemas(&paths_for(no_key.path())),
        api_schemas_not_exposed()
    );
}

fn sample_report() -> StatusReport {
    StatusReport {
        pack: PackStatus {
            state: "up to date".to_owned(),
            file_count: 1,
            offenders: None,
            pending_files: None,
        },
        tables: vec![TableStatus {
            table: "todos".to_owned(),
            state: TableState::Synced,
            key: vec!["owner_id".to_owned(), "slug".to_owned()],
            sync_mode: Some("read-write".to_owned()),
            bucket_column: Some("user_id".to_owned()),
            conflict_mode: None,
            conflict_journal: None,
            soft_delete_column: Some("deleted_at".to_owned()),
            tombstone_ttl_days: Some(30),
            tombstone_ttl_inherited: true,
            min_schema_version: Some(1),
            register_clients: Some(false),
            created_at: Some("2024-01-01".to_owned()),
            columns: vec![
                ColumnStatus {
                    schema: "public".to_owned(),
                    name: "id".to_owned(),
                    data_type: "uuid".to_owned(),
                },
                ColumnStatus {
                    schema: "public".to_owned(),
                    name: "title".to_owned(),
                    data_type: "text".to_owned(),
                },
            ],
        }],
        clients: Some(ClientsStatus {
            clients: 2,
            users: 1,
            last_seen: None,
            stale: 1,
            ttl_days: Some(90),
            per_client: vec![ClientStatus {
                client_id: "2f6c1f1e-0000-4000-8000-000000000001".to_owned(),
                user_id: "8e1bd1f8-0000-4000-8000-0000000000aa".to_owned(),
                last_seen: "2026-09-11 03:16:00+00".to_owned(),
                last_mutation_id: Some("1a2b3c4d-0000-4000-8000-00000000000f".to_owned()),
                cursor_high_water: Some(88),
                stale: false,
            }],
        }),
        settings: Some(pack_settings()),
        jobs: Some(JobsReport {
            pg_cron: true,
            jobs: vec![
                JobStatus {
                    name: "kizunasync-reap-tombstones".to_owned(),
                    schedule: Some("16 3 * * *".to_owned()),
                    active: Some(true),
                    settings_schedule: Some("16 3 * * *".to_owned()),
                    drift: false,
                    last_start: Some("2026-09-11 03:16:00+00".to_owned()),
                    last_status: Some("succeeded".to_owned()),
                    last_message: None,
                },
                JobStatus {
                    name: "kizunasync-compact-changelog".to_owned(),
                    schedule: Some("0 4 * * *".to_owned()),
                    active: Some(true),
                    settings_schedule: Some("47 3 * * *".to_owned()),
                    drift: true,
                    last_start: None,
                    last_status: None,
                    last_message: None,
                },
            ],
        }),
        retention: Some(RetentionStatus {
            tombstones: vec![TableCount {
                table: "todos".to_owned(),
                rows: 12,
            }],
            tombstone_rows: 12,
            changelog_rows: 340,
            reaped_seq: Some(88),
            reaped_at: Some("2026-09-11 03:16:00+00".to_owned()),
        }),
        journal: Some(JournalStatus { rows: 4 }),
        attachments: Some(AttachmentsStatus {
            rows: 7,
            with_sha: 6,
            without_sha: 1,
            buckets: vec![BucketCount {
                bucket: "todo-images".to_owned(),
                rows: 7,
            }],
        }),
        api_schemas: API_SCHEMAS_EXPOSED.to_owned(),
    }
}

#[test]
fn json_mode_writes_one_object_with_the_documented_key_names() {
    let (mut ui, capture) = Ui::capture();

    assert_eq!(report(&mut ui, &sample_report(), StatusView::Json), OK);
    assert_eq!(capture.stderr(), "");
    let payload: Value = serde_json::from_str(capture.stdout().trim()).unwrap();
    assert_eq!(payload["pack"]["state"], "up to date");
    assert_eq!(payload["pack"]["fileCount"], 1);
    assert_eq!(payload["tables"][0]["syncMode"], "read-write");
    assert_eq!(
        payload["tables"][0]["key"],
        serde_json::json!(["owner_id", "slug"])
    );
    assert_eq!(payload["tables"][0]["state"], "synced");
    assert_eq!(payload["tables"][0]["softDeleteColumn"], "deleted_at");
    assert_eq!(payload["tables"][0]["tombstoneTtlDays"], 30);
    assert_eq!(payload["tables"][0]["minSchemaVersion"], 1);
    assert_eq!(payload["tables"][0]["registerClients"], false);
    assert_eq!(payload["tables"][0]["createdAt"], "2024-01-01");
    assert_eq!(payload["tables"][0]["columns"][0]["name"], "id");
    assert_eq!(payload["tables"][0]["columns"][0]["dataType"], "uuid");
    assert_eq!(payload["tables"][0]["columns"][0]["schema"], "public");
    assert_eq!(payload["clients"]["lastSeen"], Value::Null);
    assert_eq!(payload["settings"]["maxBatchSize"], Value::Null);
    assert_eq!(payload["apiSchemas"], "exposed");
    assert!(payload["pack"].get("offenders").is_none());
}

#[test]
fn quiet_mode_prints_only_the_pack_state_on_stdout() {
    let (mut ui, capture) = Ui::capture();

    assert_eq!(report(&mut ui, &sample_report(), StatusView::Quiet), OK);
    assert_eq!(capture.stdout(), "up to date\n");
    assert_eq!(capture.stderr(), "");
}

#[test]
fn the_human_view_labels_every_section_on_stderr() {
    let (mut ui, capture) = Ui::capture();
    report(&mut ui, &sample_report(), StatusView::Text);
    let text = capture.stderr();

    assert_eq!(capture.stdout(), "");
    assert!(text.contains("  pack:             up to date (1 pack file(s))"));
    assert!(text.contains(
        "todos                   synced   read-write  key (owner_id, slug)  bucket user_id"
    ));
    assert!(text.contains("columns: id uuid, title text"));
    assert!(text.contains(
        "soft-delete deleted_at  ttl 30d (project default)  schema v1  created 2024-01-01"
    ));
    assert!(text.contains("2 client(s), 1 user(s), 1 stale (silent over 90d), last seen never"));
    assert!(text.contains(
        "    2f6c1f1e-0000-4000-8000-000000000001  user 8e1bd1f8-0000-4000-8000-0000000000aa  last seen 2026-09-11 03:16:00+00  cursor 88  mutation 1a2b3c4d-0000-4000-8000-00000000000f"
    ));
    assert!(text.contains("max batch unlimited, require atomic true"));
    assert!(text.contains("    reap schedule           16 3 * * *"));
    assert!(text.contains("    client ttl              90 day(s)"));
    assert!(text.contains("    hlc max skew            5000 ms"));
    assert!(text.contains("    tombstone ttl           30 day(s)"));
    assert!(text.contains("    max pull scan           5000 candidate(s)"));
    assert!(text.contains(
        "  jobs:             2/2 scheduled, pg_cron present, 1 off the declared schedule"
    ));
    assert!(text.contains(
        "    kizunasync-reap-tombstones    16 3 * * *    last run 2026-09-11 03:16:00+00 succeeded"
    ));
    assert!(text.contains("    kizunasync-compact-changelog  0 4 * * *     never ran"));
    assert!(text.contains(
        "  retention:        12 tombstone(s), 340 changelog row(s), reaped to seq 88 at 2026-09-11 03:16:00+00"
    ));
    assert!(text.contains("    todos                   12 tombstone(s)"));
    assert!(text.contains("  journal:          4 overwritten value(s) recorded"));
    assert!(text.contains("  attachments:      7 row(s), 6 with sha256, 1 without"));
    assert!(text.contains("    todo-images             7 row(s)"));
    assert!(text.contains("api schemas:      exposed"));
}

/// The sections a consumer keys on, and the fact that every one of them is
/// always present: a null section is "nothing is provisioned", a missing key
/// would be a shape change.
#[test]
fn json_mode_carries_every_operational_section() {
    let (mut ui, capture) = Ui::capture();
    report(&mut ui, &sample_report(), StatusView::Json);
    let payload: Value = serde_json::from_str(capture.stdout().trim()).unwrap();

    assert_eq!(payload["clients"]["stale"], 1);
    assert_eq!(payload["clients"]["ttlDays"], 90);
    assert_eq!(
        payload["clients"]["perClient"][0]["clientId"],
        "2f6c1f1e-0000-4000-8000-000000000001"
    );
    assert_eq!(
        payload["clients"]["perClient"][0]["userId"],
        "8e1bd1f8-0000-4000-8000-0000000000aa"
    );
    assert_eq!(
        payload["clients"]["perClient"][0]["lastSeen"],
        "2026-09-11 03:16:00+00"
    );
    assert_eq!(
        payload["clients"]["perClient"][0]["lastMutationId"],
        "1a2b3c4d-0000-4000-8000-00000000000f"
    );
    assert_eq!(payload["clients"]["perClient"][0]["cursorHighWater"], 88);
    assert_eq!(payload["clients"]["perClient"][0]["stale"], false);
    assert_eq!(payload["settings"]["reapSchedule"], "16 3 * * *");
    assert_eq!(payload["settings"]["compactSchedule"], "47 3 * * *");
    assert_eq!(payload["settings"]["clientPruneSchedule"], "31 3 * * *");
    assert_eq!(payload["settings"]["clientTtlDays"], 90);
    assert_eq!(payload["settings"]["hlcMaxSkewMs"], 5000);
    assert_eq!(payload["settings"]["tombstoneTtlDays"], 30);
    assert_eq!(payload["settings"]["maxPullScan"], 5000);
    assert_eq!(payload["tables"][0]["tombstoneTtlDays"], 30);
    assert_eq!(payload["tables"][0]["tombstoneTtlInherited"], true);
    assert_eq!(payload["jobs"]["pgCron"], true);
    assert_eq!(
        payload["jobs"]["jobs"][0]["name"],
        "kizunasync-reap-tombstones"
    );
    assert_eq!(payload["jobs"]["jobs"][0]["settingsSchedule"], "16 3 * * *");
    assert_eq!(payload["jobs"]["jobs"][1]["drift"], true);
    assert_eq!(payload["retention"]["tombstoneRows"], 12);
    assert_eq!(payload["retention"]["changelogRows"], 340);
    assert_eq!(payload["retention"]["reapedSeq"], 88);
    assert_eq!(payload["retention"]["reapedAt"], "2026-09-11 03:16:00+00");
    assert_eq!(payload["retention"]["tombstones"][0]["table"], "todos");
    assert_eq!(payload["retention"]["tombstones"][0]["rows"], 12);
    assert_eq!(payload["journal"]["rows"], 4);
    assert_eq!(payload["attachments"]["rows"], 7);
    assert_eq!(payload["attachments"]["withSha"], 6);
    assert_eq!(payload["attachments"]["withoutSha"], 1);
    assert_eq!(
        payload["attachments"]["buckets"][0]["bucket"],
        "todo-images"
    );
}

#[test]
fn pretty_report_is_chrome_only_and_never_prompts() {
    let mut prompter = crate::prompts::ScriptedPrompter::new(vec![]);

    assert_eq!(report_pretty(&mut prompter, &sample_report()), OK);
    assert_eq!(prompter.asked(), Vec::<crate::prompts::Ask>::new());
    assert_eq!(prompter.unused(), 0);
}

#[test]
fn the_pretty_report_lists_every_section_in_order_with_its_own_numbers() {
    let sections = pretty_sections(&sample_report());
    let titles: Vec<&str> = sections.iter().map(|(title, _)| title.as_str()).collect();

    assert_eq!(
        titles,
        [
            "pack",
            "tables",
            "clients",
            "settings",
            "jobs",
            "retention",
            "journal",
            "attachments",
            "api schemas"
        ]
    );
    assert!(sections[0].1.contains("up to date"));
    assert!(sections[0].1.contains("1 pack file(s)"));
    assert!(sections[1].1.contains("todos"));
    assert!(sections[1].1.contains("id uuid, title text"));
    assert!(sections[1].1.contains("soft-delete deleted_at"));
    assert!(sections[4].1.contains("kizunasync-reap-tombstones"));
    assert!(sections[5].1.contains("12 tombstone(s)"));
    assert!(sections[6].1.contains("4 overwritten value(s)"));
    assert!(sections[7].1.contains("todo-images"));
    assert_eq!(sections[8].1, API_SCHEMAS_EXPOSED);
}

#[test]
fn an_unprovisioned_report_says_so_in_every_db_backed_section() {
    let (mut ui, capture) = Ui::capture();
    let status = StatusReport {
        pack: PackStatus {
            state: NOT_PROVISIONED.to_owned(),
            file_count: 1,
            offenders: None,
            pending_files: None,
        },
        tables: Vec::new(),
        clients: None,
        settings: None,
        jobs: None,
        retention: None,
        journal: None,
        attachments: None,
        api_schemas: API_SCHEMAS_NO_FILE.to_owned(),
    };
    report(&mut ui, &status, StatusView::Text);

    assert!(capture.stderr().contains("tables:           none"));
    // The pack state plus the six sections that need a provisioned database.
    assert_eq!(capture.stderr().matches(NOT_PROVISIONED).count(), 7);
}

fn ledger_row(kind: &str, name: &str) -> LedgerRow {
    LedgerRow {
        object_kind: kind.to_owned(),
        object_name: name.to_owned(),
        content_hash: "abc".to_owned(),
        pack_version: crate::VERSION.to_owned(),
    }
}

/// Without the shipped pack on disk there is nothing to compare the recorded
/// files against, which is a state the report names rather than a command that
/// cannot run. The pack directory is resolved by a walk that reaches this
/// checkout from the test binary, so the fallback is driven directly rather
/// than by hiding the real pack.
#[test]
fn the_pack_section_falls_back_to_the_ledger_when_no_pack_is_on_disk() {
    let rows = [
        ledger_row("pack-file", "0001_kizuna_init.sql"),
        ledger_row("function", "kizunasync.pull"),
    ];
    let pack = describe_ledger(&rows, &FakeApplier::new()).unwrap();

    assert_eq!(
        pack.state,
        "provisioned (1 pack file(s) recorded, no pack on disk to compare)"
    );
    assert_eq!(pack.file_count, 0);
    assert_eq!(pack.offenders, None);
    assert_eq!(pack.pending_files, None);
}

#[test]
fn an_empty_ledger_with_no_pack_on_disk_is_still_not_provisioned() {
    let pack = describe_ledger(&[], &FakeApplier::new()).unwrap();

    assert_eq!(pack.state, NOT_PROVISIONED);
    assert_eq!(pack.file_count, 0);
}

/// An object-keyed ledger with no pack on disk takes the same core-RPC probe
/// the on-disk path takes: the RPCs a client calls are what decide that state.
#[test]
fn an_object_keyed_ledger_with_no_pack_on_disk_probes_the_core_rpcs() {
    let rows = [ledger_row("function", "kizunasync.pull")];
    let applier = FakeApplier::new().answer("pg_proc", vec![text_row(&[("proname", "pull")])]);

    assert_eq!(
        describe_ledger(&rows, &applier).unwrap().state,
        "drift (missing core RPCs: kizunasync.push)"
    );
}

#[test]
fn live_columns_attach_only_to_the_table_they_belong_to() {
    let applier = FakeApplier::new().answer(
        "information_schema.columns",
        vec![
            text_row(&[
                ("table_schema", "public"),
                ("table_name", "todos"),
                ("column_name", "id"),
                ("data_type", "uuid"),
            ]),
            text_row(&[
                ("table_schema", "public"),
                ("table_name", "todos"),
                ("column_name", "title"),
                ("data_type", "text"),
            ]),
        ],
    );
    let columns = read_table_columns(&applier, &["todos".to_owned()]).unwrap();
    let mut tables = vec![
        table("notes", TableState::Synced),
        table("todos", TableState::Synced),
    ];
    attach_columns(&mut tables, columns);

    assert_eq!(tables[0].table, "notes");
    assert_eq!(tables[0].columns, Vec::<ColumnStatus>::new());
    assert_eq!(tables[1].table, "todos");
    assert_eq!(
        tables[1]
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<Vec<_>>(),
        ["id", "title"]
    );
}

#[test]
fn every_column_of_a_config_row_reaches_its_own_status_field() {
    let applier = FakeApplier::new().answer(
        "from kizunasync._config",
        vec![text_row(&[
            ("table_name", "todos"),
            ("sync_mode", "read-write"),
            ("bucket_column", "user_id"),
            ("conflict_mode", "arrival"),
            ("conflict_journal", "f"),
            ("soft_delete_column", "deleted_at"),
            ("tombstone_ttl_days", "30"),
            ("min_schema_version", "1"),
            ("register_clients", "t"),
            ("created_at", "2024-01-01"),
            ("key_columns", "{owner_id,slug}"),
        ])],
    );
    let tables = read_config_tables(&applier, None).unwrap();

    assert_eq!(tables[0].key, ["owner_id", "slug"]);
    assert_eq!(tables[0].soft_delete_column.as_deref(), Some("deleted_at"));
    assert_eq!(tables[0].tombstone_ttl_days, Some(30));
    assert_eq!(tables[0].min_schema_version, Some(1));
    assert_eq!(tables[0].register_clients, Some(true));
    assert!(!tables[0].conflict_journal.unwrap_or(true));
    assert_eq!(tables[0].created_at.as_deref(), Some("2024-01-01"));
    assert!(!tables[0].tombstone_ttl_inherited);
}

/// A null `_config.tombstone_ttl_days` is how a table says "the project
/// default", which is what the reaper coalesces to, so the report shows that
/// value rather than no retention at all.
#[test]
fn a_table_with_no_retention_of_its_own_reports_the_project_default() {
    let applier = FakeApplier::new().answer(
        "from kizunasync._config",
        vec![
            text_row(&[("table_name", "notes"), ("sync_mode", "pull-only")]),
            text_row(&[
                ("table_name", "todos"),
                ("sync_mode", "read-write"),
                ("tombstone_ttl_days", "7"),
            ]),
        ],
    );
    let tables = read_config_tables(&applier, Some(30)).unwrap();

    assert_eq!(
        tables[0].key,
        ["id"],
        "a row without key_columns records id"
    );
    assert_eq!(tables[0].tombstone_ttl_days, Some(30));
    assert!(tables[0].tombstone_ttl_inherited);
    assert_eq!(tables[1].tombstone_ttl_days, Some(7));
    assert!(!tables[1].tombstone_ttl_inherited);
}

#[test]
fn columns_query_skips_an_empty_table_list() {
    assert!(columns_for_tables_query(&[]).is_none());
    assert!(
        columns_for_tables_query(&["todos".to_owned()])
            .unwrap()
            .contains("information_schema.columns")
    );
}

fn pack_file_row(version: &str) -> LedgerRow {
    LedgerRow {
        object_kind: "pack-file".to_owned(),
        object_name: "0001_kizuna_init.sql".to_owned(),
        content_hash: "recorded".to_owned(),
        pack_version: version.to_owned(),
    }
}

fn up_to_date() -> PackStatus {
    PackStatus {
        state: "up to date".to_owned(),
        file_count: 1,
        offenders: None,
        pending_files: None,
    }
}

/// A ledger a newer build wrote is reported, never refused: the state names
/// the update every writing command asks for, and each row it comes from.
#[test]
fn a_ledger_a_newer_build_wrote_is_reported_with_the_update_it_needs() {
    let pack = with_ledger_ahead(up_to_date(), &[pack_file_row("99.0.0")]);

    assert_eq!(
        pack.state,
        format!(
            "recorded by a newer kizunasync than this build ({}): update kizunasync",
            crate::VERSION
        )
    );
    assert_eq!(
        pack.offenders.unwrap(),
        ["0001_kizuna_init.sql: recorded by kizunasync 99.0.0, newer than this build"]
    );
    assert_eq!(pack.file_count, 1);
}

#[test]
fn a_ledger_this_build_or_an_older_one_wrote_leaves_the_pack_section_as_it_is() {
    for version in [crate::VERSION, "0.0.1"] {
        assert_eq!(
            with_ledger_ahead(up_to_date(), &[pack_file_row(version)]),
            up_to_date(),
            "{version}"
        );
    }
}
