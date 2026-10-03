use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use clap::CommandFactory;

use super::equivalent::render;
use super::fixtures::{
    FIXED_NOW, Ledger, NoDataApi, Synced, database, database_of_an_earlier_build,
    database_without_pg_cron, opener, pack_dir, pack_env,
};
use super::menu::{JOB_MESSAGE, JOBS_MESSAGE, NEEDS_DIRECT};
use super::state::{
    ClientsSummary, JobsSummary, LastRun, PackState, SyncedTable, When, describe_when,
    parse_instant,
};
use super::*;
use crate::applier::fake::FakeApplier;
use crate::catalog::SchemaSource;
use crate::commands::init::{DirectConnection, RemoteCredential};
use crate::commands::jobs::Job;
use crate::commands::sync::{SettingsOptions, TableOptions};
use crate::config::{KizunaSyncConfig, MaxBatchSize, ProjectSettings, load_config_from_db};
use crate::management::ProjectSummary;
use crate::migration_history::AppliedMigration;
use crate::project_ref::ProjectRef;
use crate::prompts::{Answer, Ask, RetentionJobs, ScriptedPrompter, SectionChoice};
use crate::proposals::{PolicyRow, SchemaCatalog};
use crate::provision::LedgerRow;
use crate::server_facts::ServerFacts;
use crate::supabase_cli::fake::RecordingCli;
use crate::ui::Capture;

const LOCAL_URL: &str = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PROJECT_REF: &str = "abcdefghijklmnopqrst";
/// Structurally valid, and nothing like a real token.
const TOKEN: &str = "sbp_0123456789abcdef0123456789abcdef01234567";

fn local() -> WizardConnection {
    WizardConnection::Direct(DirectConnection {
        url: LOCAL_URL.to_owned(),
        push: PushTarget::Local,
    })
}

fn remote() -> WizardConnection {
    WizardConnection::Remote {
        project_ref: ProjectRef::parse(PROJECT_REF).unwrap(),
        credential: RemoteCredential {
            token: TOKEN.to_owned(),
            origin: "entered".to_owned(),
        },
    }
}

// MARK: - the state and the menu

/// A terminal wide enough that no header line wraps.
const WIDE: usize = 200;

fn state(pack: PackState, transport: Transport, has_migrations: bool) -> PanelState {
    PanelState {
        title: "local stack".to_owned(),
        transport,
        pack,
        pack_version: Some("0.2.6-alpha.3".to_owned()),
        tables: vec![
            SyncedTable {
                name: "todos".to_owned(),
                mode: Some("read-write".to_owned()),
                key: vec!["id".to_owned()],
            },
            SyncedTable {
                name: "notes".to_owned(),
                mode: Some("pull-only".to_owned()),
                key: vec!["id".to_owned()],
            },
        ],
        jobs: Some(JobsSummary::Scheduled {
            count: 3,
            last_run: Some(LastRun {
                job: "compact".to_owned(),
                when: When::Ago(12 * 60),
            }),
        }),
        clients: Some(ClientsSummary {
            registered: 4,
            active: 1,
            at_least: false,
        }),
        has_migrations,
    }
}

const EVERY_PACK_STATE: [PackState; 7] = [
    PackState::NotInstalled,
    PackState::UpToDate,
    PackState::Pending(2),
    PackState::Changed,
    PackState::Unversioned,
    PackState::NoPackOnDisk,
    PackState::Newer,
];

fn labels(items: &[PanelItem]) -> Vec<&str> {
    items.iter().map(|item| item.label.as_str()).collect()
}

fn hint_of(items: &[PanelItem], action: PanelAction) -> Option<&str> {
    items
        .iter()
        .find(|item| item.action == action)
        .map(|item| item.hint.as_str())
}

/// Every pack state, over both transports, with and without a migrations
/// directory: the full menu in the designed order, or the three read-only
/// items when a newer kizunasync recorded the pack.
#[test]
fn every_state_offers_its_items_in_the_designed_order() {
    for pack in EVERY_PACK_STATE {
        for transport in [Transport::Direct, Transport::ManagementApi] {
            for has_migrations in [true, false] {
                let items = panel_menu(&state(pack, transport, has_migrations));
                let expected: Vec<&str> = if pack == PackState::Newer {
                    vec!["Status", "Health check", "Exit"]
                } else {
                    [
                        "Synced tables",
                        "Project settings",
                        "Update the pack",
                        "Health check",
                        "Status",
                        "Background jobs",
                    ]
                    .into_iter()
                    .chain(has_migrations.then_some("Pending migrations"))
                    .chain(["Remove Kizuna", "Exit"])
                    .collect()
                };

                assert_eq!(
                    labels(&items),
                    expected,
                    "{pack:?} {transport:?} {has_migrations}"
                );
            }
        }
    }
}

/// The labels and hints of the approved pseudo UI, word for word.
#[test]
fn a_direct_up_to_date_panel_reads_the_designed_hints() {
    let items = panel_menu(&state(PackState::UpToDate, Transport::Direct, true));
    let rows: Vec<(&str, &str)> = items
        .iter()
        .map(|item| (item.label.as_str(), item.hint.as_str()))
        .collect();

    assert_eq!(
        rows,
        [
            ("Synced tables", "add, remove or change what syncs"),
            ("Project settings", "batch size, retention, schedules"),
            (
                "Update the pack",
                "up to date · re-apply to restore dropped objects"
            ),
            ("Health check", "run every doctor check"),
            ("Status", "full report"),
            ("Background jobs", "list, run now, reschedule"),
            ("Pending migrations", "classify additive vs breaking"),
            ("Remove Kizuna", "deprovision, with a dry run first"),
            ("Exit", ""),
        ]
    );
}

/// `jobs` and `deprovision` take a direct connection, so over the Management
/// API their items stay, with the reason in place of the hint.
#[test]
fn the_management_api_marks_jobs_and_removal_unavailable_with_the_reason() {
    for pack in EVERY_PACK_STATE
        .into_iter()
        .filter(|pack| *pack != PackState::Newer)
    {
        let items = panel_menu(&state(pack, Transport::ManagementApi, true));

        assert_eq!(
            hint_of(&items, PanelAction::BackgroundJobs),
            Some(NEEDS_DIRECT)
        );
        assert_eq!(
            hint_of(&items, PanelAction::RemoveKizuna),
            Some(NEEDS_DIRECT)
        );
        assert_eq!(
            hint_of(&items, PanelAction::SyncedTables),
            Some("add, remove or change what syncs")
        );
    }
}

#[test]
fn the_update_item_says_what_it_would_do_for_every_pack_state() {
    let expected = [
        (
            PackState::NotInstalled,
            "nothing installed · Synced tables installs the pack",
        ),
        (
            PackState::UpToDate,
            "up to date · re-apply to restore dropped objects",
        ),
        (PackState::Pending(2), "2 pending pack file(s) to apply"),
        (
            PackState::Changed,
            "this CLI's pack differs · re-apply and record its hash",
        ),
        (
            PackState::Unversioned,
            "provisioned outside kizunasync init · upgrade refuses it",
        ),
        (PackState::NoPackOnDisk, "no pack on disk to compare"),
    ];
    for (pack, hint) in expected {
        let items = panel_menu(&state(pack, Transport::Direct, false));

        assert_eq!(
            hint_of(&items, PanelAction::UpdatePack),
            Some(hint),
            "{pack:?}"
        );
    }
}

#[test]
fn a_pack_a_newer_build_recorded_reads_only_and_says_to_update() {
    let mut newer = state(PackState::Newer, Transport::Direct, true);
    newer.pack_version = Some("999.0.0".to_owned());
    let (title, body) = header(&newer, WIDE);
    let items = panel_menu(&newer);

    assert_eq!(title, "Kizuna Sync · local stack");
    assert_eq!(
        body,
        format!(
            "This project runs pack 999.0.0; this CLI ships {}.\nUpdate kizunasync before changing anything.",
            crate::VERSION
        )
    );
    assert!(items.iter().all(|item| item.hint.is_empty()));
}

/// The header and the menu as a terminal reads them, in the pseudo UI's
/// order, committed byte for byte: rerun with `KSYNC_BLESS_GOLDEN=1` for an
/// intended change.
#[test]
fn the_header_and_menu_render_matches_the_committed_golden() {
    let mut lines = Vec::new();
    for (transport, title) in [
        (Transport::Direct, "local stack"),
        (
            Transport::ManagementApi,
            "project abcdefghijklmnopqrst · Management API",
        ),
    ] {
        let mut shown = state(PackState::UpToDate, transport, true);
        title.clone_into(&mut shown.title);
        let (heading, body) = header(&shown, 80);
        lines.push(format!("┌  {heading}"));
        lines.push("│".to_owned());
        lines.extend(body.lines().map(|line| format!("│  {line}")));
        lines.push("│".to_owned());
        lines.push(format!("◆  {MENU_MESSAGE}"));
        for (index, item) in panel_menu(&shown).iter().enumerate() {
            let radio = if index == 0 { "●" } else { "○" };
            let line = format!("│  {radio} {:<22} {}", item.label, item.hint);
            lines.push(line.trim_end().to_owned());
        }
        lines.push("└".to_owned());
        lines.push(String::new());
    }
    let rendered = lines.join("\n");
    let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/panel.txt");
    if std::env::var("KSYNC_BLESS_GOLDEN").is_ok_and(|value| value == "1") {
        std::fs::write(&golden, &rendered).unwrap();

        return;
    }
    let expected = std::fs::read_to_string(&golden).unwrap();

    assert_eq!(
        rendered, expected,
        "the panel drifted from tests/golden/panel.txt: rerun with KSYNC_BLESS_GOLDEN=1 if that was intended"
    );
}

#[test]
fn the_header_names_the_pack_tables_jobs_and_clients() {
    let (title, body) = header(&state(PackState::UpToDate, Transport::Direct, true), WIDE);

    assert_eq!(title, "Kizuna Sync · local stack");
    assert_eq!(
        body,
        "Pack        0.2.6-alpha.3 · matches this CLI\n\
         Tables      2 synced · todos (read-write, key id) · notes (pull-only, key id)\n\
         Jobs        3 scheduled · last compact 12 min ago\n\
         Clients     4 registered · 1 active in the last hour"
    );
}

/// An 80-column terminal: a long value breaks only at its separators, its
/// continuation sits under the value column, and every line fits the note's
/// frame.
#[test]
fn a_long_header_value_wraps_at_its_separators_under_the_value_column() {
    let mut shown = state(PackState::UpToDate, Transport::Direct, true);
    shown.tables = ["todos", "notes", "users", "user_favorite_places", "places"]
        .iter()
        .map(|name| SyncedTable {
            name: (*name).to_owned(),
            mode: Some("read-write".to_owned()),
            key: vec!["id".to_owned()],
        })
        .collect();
    let (_, body) = header(&shown, 80);
    let lines: Vec<&str> = body.lines().collect();

    assert_eq!(
        lines[1..5],
        [
            "Tables      5 synced · todos (read-write, key id) ·",
            "            notes (read-write, key id) · users (read-write, key id) ·",
            "            user_favorite_places (read-write, key id) ·",
            "            places (read-write, key id)",
        ]
    );
    for line in &lines {
        assert!(line.chars().count() <= 80 - 6, "{line:?}");
    }
}

/// The title breaks at its separator too, so a long connection string moves
/// to a line of its own instead of breaking inside itself.
#[test]
fn a_long_header_title_wraps_at_its_separator() {
    let mut shown = state(PackState::UpToDate, Transport::Direct, true);
    "postgresql://postgres@127.0.0.1:55322/kz_keys?sslmode=disable".clone_into(&mut shown.title);
    let (title, _) = header(&shown, 80);

    assert_eq!(
        title,
        "Kizuna Sync ·\npostgresql://postgres@127.0.0.1:55322/kz_keys?sslmode=disable"
    );
    assert_eq!(header(&shown, WIDE).0, title.replace(" ·\n", " · "));
}

#[test]
fn the_pack_line_names_every_state() {
    let line = |pack| {
        let (_, body) = header(&state(pack, Transport::Direct, false), WIDE);
        body.lines().next().unwrap().to_owned()
    };

    assert_eq!(line(PackState::NotInstalled), "Pack        not installed");
    assert_eq!(
        line(PackState::Pending(2)),
        "Pack        0.2.6-alpha.3 · this CLI ships 2 pack file(s) the ledger does not record"
    );
    assert_eq!(
        line(PackState::Changed),
        "Pack        0.2.6-alpha.3 · this CLI ships a different pack"
    );
    assert_eq!(
        line(PackState::Unversioned),
        "Pack        no pack-file row · provisioned outside kizunasync init"
    );
    assert_eq!(
        line(PackState::NoPackOnDisk),
        "Pack        0.2.6-alpha.3 · no pack on disk to compare"
    );
}

#[test]
fn an_empty_project_and_a_capped_client_list_say_so() {
    let mut empty = state(PackState::NotInstalled, Transport::Direct, false);
    empty.tables.clear();
    empty.jobs = Some(JobsSummary::NoPgCron);
    empty.clients = Some(ClientsSummary {
        registered: 80,
        active: 50,
        at_least: true,
    });
    let (_, body) = header(&empty, WIDE);

    assert!(body.contains("Tables      none synced"), "{body}");
    assert!(
        body.contains("Jobs        pg_cron is not installed · nothing scheduled"),
        "{body}"
    );
    assert!(
        body.contains("Clients     80 registered · 50+ active in the last hour"),
        "{body}"
    );
}

#[test]
fn an_age_reads_in_the_largest_whole_unit() {
    assert_eq!(describe_when(&When::Ago(20)), "just now");
    assert_eq!(describe_when(&When::Ago(12 * 60 + 59)), "12 min ago");
    assert_eq!(describe_when(&When::Ago(3 * 3600)), "3 h ago");
    assert_eq!(describe_when(&When::Ago(30 * 3600)), "1 day ago");
    assert_eq!(describe_when(&When::Ago(9 * 86400)), "9 days ago");
    assert_eq!(
        describe_when(&When::At("yesterday".to_owned())),
        "at yesterday"
    );
}

/// `timestamptz::text` is RFC 3339 with a space and an hour-only offset.
#[test]
fn a_postgres_timestamp_parses_to_its_epoch_second() {
    assert_eq!(
        parse_instant("2026-09-21 14:13:20.123456+00"),
        Some(FIXED_NOW)
    );
    assert_eq!(parse_instant("2026-09-21 16:13:20+02"), Some(FIXED_NOW));
    assert_eq!(parse_instant("not a time"), None);
}

// MARK: - the state, read from a database

fn ledger_row(hash: &str, version: &str) -> LedgerRow {
    LedgerRow {
        object_kind: "pack-file".to_owned(),
        object_name: "0001_kizuna_init.sql".to_owned(),
        content_hash: hash.to_owned(),
        pack_version: version.to_owned(),
    }
}

/// The state a fixture database answers, over this checkout's pack.
fn read_state(ledger: Ledger, synced: Synced) -> PanelState {
    let dir = tempfile::tempdir().unwrap();
    let applier = database(ledger, synced);
    let paths = ProjectPaths::rooted_at(dir.path().to_path_buf());
    let report = build_report(&applier, &paths, &pack_env()).unwrap();
    let rows = read_ledger_rows(&applier).unwrap();
    let plan = plan_provision(&read_pack_files(&pack_dir()).unwrap(), &rows);

    PanelState::from_reads(&PanelReads {
        title: "local stack".to_owned(),
        transport: Transport::Direct,
        report: &report,
        rows: &rows,
        plan: Some(&plan),
        has_migrations: false,
        now_unix: FIXED_NOW,
    })
}

#[test]
fn a_current_ledger_reads_up_to_date_with_the_newest_run_and_the_active_clients() {
    let current = read_state(Ledger::Current, Synced::TodosAndNotes);

    assert_eq!(current.pack, PackState::UpToDate);
    assert_eq!(current.pack_version.as_deref(), Some(crate::VERSION));
    assert_eq!(
        current.tables,
        [
            SyncedTable {
                name: "notes".to_owned(),
                mode: Some("pull-only".to_owned()),
                key: vec!["slug".to_owned()],
            },
            SyncedTable {
                name: "todos".to_owned(),
                mode: Some("read-write".to_owned()),
                key: vec!["id".to_owned()],
            },
        ]
    );
    assert_eq!(
        current.jobs,
        Some(JobsSummary::Scheduled {
            count: 3,
            last_run: Some(LastRun {
                job: "compact".to_owned(),
                when: When::Ago(12 * 60),
            }),
        })
    );
    assert_eq!(
        current.clients,
        Some(ClientsSummary {
            registered: 4,
            active: 1,
            at_least: false,
        })
    );
}

#[test]
fn the_ledger_decides_the_pack_state() {
    assert_eq!(
        read_state(Ledger::Changed, Synced::TodosAndNotes).pack,
        PackState::Changed
    );
    assert_eq!(
        read_state(Ledger::Newer, Synced::TodosAndNotes).pack,
        PackState::Newer
    );
    assert_eq!(
        read_state(Ledger::Empty, Synced::Nothing).pack,
        PackState::NotInstalled
    );
}

#[test]
fn the_newest_recorded_version_names_the_pack() {
    let rows = [
        ledger_row("a", "0.0.1"),
        ledger_row("b", "0.0.10"),
        ledger_row("c", "0.0.9"),
    ];
    let nothing_installed = FakeApplier::new().answer(
        "to_regclass('kizunasync._provisions')",
        vec![crate::applier::fake::text_row(&[("present", "f")])],
    );
    let report = build_report(
        &nothing_installed,
        &ProjectPaths::rooted_at(PathBuf::from("/nonexistent")),
        &Env::default(),
    )
    .unwrap();
    let read = PanelState::from_reads(&PanelReads {
        title: String::new(),
        transport: Transport::Direct,
        report: &report,
        rows: &rows,
        plan: None,
        has_migrations: false,
        now_unix: FIXED_NOW,
    });

    assert_eq!(read.pack_version.as_deref(), Some("0.0.10"));
    assert_eq!(read.pack, PackState::NoPackOnDisk);
}

// MARK: - equivalent commands

#[test]
fn a_direct_equivalent_leaves_the_password_to_pgpassword() {
    let rendered = render(
        &local(),
        &[
            "upgrade".to_owned(),
            "--reapply".to_owned(),
            "--yes".to_owned(),
        ],
    );

    assert_eq!(
        rendered,
        "PGPASSWORD=… kizunasync upgrade --reapply --yes --db-url postgresql://postgres@127.0.0.1:54322/postgres"
    );
}

#[test]
fn a_url_without_a_password_needs_no_pgpassword_and_odd_values_are_quoted() {
    let connection = WizardConnection::Direct(DirectConnection {
        url: "postgresql://postgres@db.example:5432/postgres?sslmode=require".to_owned(),
        push: PushTarget::DbUrl(String::new()),
    });
    let rendered = render(
        &connection,
        &[
            "sync".to_owned(),
            "--reap-schedule".to_owned(),
            "0 4 * * *".to_owned(),
        ],
    );

    assert_eq!(
        rendered,
        "kizunasync sync --reap-schedule '0 4 * * *' --db-url 'postgresql://postgres@db.example:5432/postgres?sslmode=require'"
    );
}

#[test]
fn a_project_equivalent_leaves_the_token_to_its_variable() {
    let rendered = render(&remote(), &["doctor".to_owned()]);

    assert_eq!(
        rendered,
        format!("SUPABASE_ACCESS_TOKEN=… kizunasync doctor --project-ref {PROJECT_REF}")
    );
    assert!(!rendered.contains(TOKEN));
}

#[test]
fn settings_round_trip_through_the_sync_flags() {
    let settings = ProjectSettings {
        max_batch_size: Some(MaxBatchSize::Unlimited),
        require_atomic: Some(false),
        reap_schedule: Some("0 4 * * *".to_owned()),
        client_ttl_days: Some(30),
        tombstone_ttl_days: Some(10),
        max_pull_scan: Some(2500),
        ..ProjectSettings::default()
    };
    let options = SettingsOptions::from_declared(&settings);

    assert_eq!(options.declared(), settings);
    assert_eq!(
        options.to_sync_args(),
        [
            "--no-max-batch-size",
            "--no-require-atomic",
            "--reap-schedule",
            "0 4 * * *",
            "--client-ttl-days",
            "30",
            "--max-pull-scan",
            "2500",
        ]
    );
    assert_eq!(
        SettingsOptions::from_declared(&ProjectSettings {
            max_batch_size: Some(MaxBatchSize::Mutations(200)),
            ..ProjectSettings::default()
        })
        .to_sync_args(),
        ["--max-batch-size", "200"]
    );
}

// MARK: - parity with the command surface

/// The commands the panel deliberately leaves out: `version` and `help` have
/// nothing to act on, `mock` is test tooling by the user's decision, and
/// `init` is the install flow that runs before the panel opens.
const NOT_IN_THE_PANEL: [&str; 4] = ["version", "help", "mock", "init"];

/// Every panel action, the submenus included.
const EVERY_ACTION: [PanelAction; 15] = [
    PanelAction::SyncedTables,
    PanelAction::ProjectSettings,
    PanelAction::UpdatePack,
    PanelAction::HealthCheck,
    PanelAction::Status,
    PanelAction::BackgroundJobs,
    PanelAction::PendingMigrations,
    PanelAction::RemoveKizuna,
    PanelAction::Exit,
    PanelAction::ListJobs,
    PanelAction::RunJobNow,
    PanelAction::RescheduleJobs,
    PanelAction::RunJob(Job::Reap),
    PanelAction::RunJob(Job::Compact),
    PanelAction::RunJob(Job::Prune),
];

/// A new subcommand fails here until it is a panel item or joins the
/// exclusions, and an exclusion that names no command fails too.
#[test]
fn every_subcommand_is_a_panel_item_or_an_explicit_exclusion() {
    let mut command = crate::cli::Cli::command();
    command.build();
    let subcommands: Vec<String> = command
        .get_subcommands()
        .map(|subcommand| subcommand.get_name().to_owned())
        .collect();
    let in_the_panel: Vec<&str> = EVERY_ACTION
        .iter()
        .filter_map(|action| action.command())
        .collect();

    for name in &subcommands {
        assert!(
            in_the_panel.contains(&name.as_str()) || NOT_IN_THE_PANEL.contains(&name.as_str()),
            "`kizunasync {name}` is neither a panel item nor in NOT_IN_THE_PANEL"
        );
    }
    for name in in_the_panel.iter().chain(&NOT_IN_THE_PANEL) {
        assert!(
            subcommands.iter().any(|subcommand| subcommand == name),
            "`{name}` is not a subcommand"
        );
    }
    for name in NOT_IN_THE_PANEL {
        assert!(!in_the_panel.contains(&name), "{name} is both");
    }
}

// MARK: - scripted runs

/// Reads over the fixture database, and a catalog with an RLS policy on
/// `todos`, so the hand-offs have something to propose.
struct Schemas {
    database: Rc<FakeApplier>,
}

fn facts() -> ServerFacts {
    ServerFacts {
        version: "17.4".to_owned(),
        database: "postgres".to_owned(),
        user: "postgres".to_owned(),
    }
}

impl SchemaSource for Schemas {
    fn probe(&self, _url: &str) -> crate::error::Result<ServerFacts> {
        Ok(facts())
    }

    fn introspect(&self, _url: &str, _schema: &str) -> crate::error::Result<SchemaCatalog> {
        Ok(SchemaCatalog {
            tables: vec!["todos".to_owned(), "notes".to_owned()],
            policies: vec![PolicyRow {
                table: "todos".to_owned(),
                qual: "(auth.uid() = user_id)".to_owned(),
            }],
            ..Default::default()
        }
        .keyed_by_uuid_id())
    }

    fn read_config(&self, _url: &str) -> crate::error::Result<KizunaSyncConfig> {
        load_config_from_db(self.database.as_ref())
    }

    fn pg_cron_present(&self, _url: &str) -> crate::error::Result<bool> {
        Ok(true)
    }

    fn applied_migrations(&self, _url: &str) -> crate::error::Result<Vec<AppliedMigration>> {
        Ok(Vec::new())
    }

    fn ledger_rows(&self, _url: &str) -> crate::error::Result<Vec<LedgerRow>> {
        read_ledger_rows(self.database.as_ref())
    }

    fn pack_applier(&self, _url: &str) -> Box<dyn Applier + '_> {
        Box::new(super::fixtures::Shared(Rc::clone(&self.database)))
    }

    fn provisioning_gaps(
        &self,
        _url: &str,
        _expected: &crate::verify::Expectation,
    ) -> crate::error::Result<Vec<String>> {
        Ok(Vec::new())
    }
}

fn unreachable_projects(_token: &str) -> crate::error::Result<Vec<ProjectSummary>> {
    Err(crate::error::Error::Transport(
        "no test lists projects".to_owned(),
    ))
}

fn no_linked(
    _project_ref: &ProjectRef,
    _token: Option<&str>,
) -> crate::error::Result<crate::login_role::LinkedConnection> {
    Err(crate::error::Error::Transport(
        "no Supabase access token".to_owned(),
    ))
}

fn no_browser() -> crate::error::Result<()> {
    Err(crate::error::Error::Cli("no browser in tests".to_owned()))
}

#[expect(clippy::unnecessary_wraps)] // Matches the fallible port signature.
fn remote_facts(_project_ref: &ProjectRef, _token: &str) -> crate::error::Result<ServerFacts> {
    Ok(facts())
}

/// The bare flow's own reads, which the panel never makes.
#[expect(clippy::unnecessary_wraps)] // Matches the fallible port signature.
fn installed(
    _connection: &WizardConnection,
) -> crate::error::Result<crate::provision::LedgerState> {
    Ok(crate::provision::LedgerState::Present(Vec::new()))
}

#[expect(clippy::unnecessary_wraps)] // Matches the fallible port signature.
fn nothing_declared(_connection: &WizardConnection) -> crate::error::Result<KizunaSyncConfig> {
    Ok(KizunaSyncConfig::default())
}

fn install_flags() -> InitFlags {
    InitFlags {
        dry_run: false,
        yes: false,
        local_only: false,
        schema: "public".to_owned(),
        project_ref: None,
        db_url: None,
        access_token: None,
        options: TableOptions::default(),
        settings: SettingsOptions::default(),
        allow_no_cron: false,
        allow_no_rls: false,
    }
}

/// One panel session, and everything a test reads back from it.
struct PanelRun {
    code: i32,
    capture: Capture,
    prompter: ScriptedPrompter,
    database: Rc<FakeApplier>,
    cli: RecordingCli,
    dir: tempfile::TempDir,
}

impl PanelRun {
    fn stderr(&self) -> String {
        self.capture.stderr()
    }

    /// Every statement the session sent.
    fn executed(&self) -> Vec<String> {
        self.database.executed.borrow().clone()
    }

    fn ran(&self, needle: &str) -> bool {
        self.executed().iter().any(|sql| sql.contains(needle))
    }

    /// Every header the session drew, as `(title, body)`.
    fn headers(&self) -> Vec<(String, String)> {
        self.prompter
            .notes()
            .iter()
            .filter(|(title, _)| title.starts_with("Kizuna Sync · "))
            .cloned()
            .collect()
    }

    /// The items of every select asked with `message`, in order.
    fn selects(&self, message: &str) -> Vec<Vec<PanelItem>> {
        self.prompter
            .asked()
            .iter()
            .filter_map(|ask| match ask {
                Ask::Action {
                    message: asked,
                    items,
                    ..
                } if asked == message => Some(items.clone()),
                _ => None,
            })
            .collect()
    }

    /// The item every select asked with `message` opened on, in order.
    fn opened_on(&self, message: &str) -> Vec<Option<PanelAction>> {
        self.prompter
            .asked()
            .iter()
            .filter_map(|ask| match ask {
                Ask::Action {
                    message: asked,
                    current,
                    ..
                } if asked == message => Some(*current),
                _ => None,
            })
            .collect()
    }

    /// What Backspace did on every select asked with `message`, in order.
    fn backs(&self, message: &str) -> Vec<BackKey> {
        self.prompter
            .asked()
            .iter()
            .filter_map(|ask| match ask {
                Ask::Action {
                    message: asked,
                    back,
                    ..
                } if asked == message => Some(*back),
                _ => None,
            })
            .collect()
    }

    fn confirms(&self) -> Vec<String> {
        self.prompter
            .asked()
            .iter()
            .filter_map(|ask| match ask {
                Ask::Confirm { message, .. } => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    fn migrations(&self) -> Vec<String> {
        let path = self.dir.path().join("supabase").join("migrations");
        let Ok(entries) = std::fs::read_dir(path) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();

        names
    }
}

/// Everything a scripted session can vary.
struct Session {
    connection: WizardConnection,
    database: FakeApplier,
    env: Env,
    migrations_dir: bool,
    /// Seconds each round's clock moves forward.
    tick: i64,
    /// What Backspace on the menu does before an item applies a change.
    menu_back: BackKey,
}

impl Session {
    fn local(database: FakeApplier) -> Self {
        Self {
            connection: local(),
            database,
            env: pack_env(),
            migrations_dir: false,
            tick: 0,
            menu_back: BackKey::Honoured,
        }
    }

    fn run(self, answers: Vec<Answer>) -> PanelRun {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        if self.migrations_dir {
            std::fs::create_dir_all(dir.path().join("supabase").join("migrations")).unwrap();
        }
        let paths = ProjectPaths::rooted_at(dir.path().to_path_buf());
        let env_files = crate::env_file::load(dir.path());
        let flags = install_flags();
        let database = Rc::new(self.database);
        let schemas = Schemas {
            database: Rc::clone(&database),
        };
        let open = opener(&database);
        let cli = RecordingCli::new();
        let rounds = Cell::new(0_i64);
        let clock = || {
            let now = FIXED_NOW + rounds.get() * self.tick;
            rounds.set(rounds.get() + 1);

            now
        };
        let (mut ui, capture) = Ui::capture();
        let mut scripted = ScriptedPrompter::new(answers);
        let code = {
            let mut ports = SmartPorts {
                init: InitPorts {
                    prompter: Some(&mut scripted as &mut dyn Prompter),
                    schemas: &schemas,
                    supabase: &cli,
                    now_unix: FIXED_NOW,
                    tokens: &crate::token::NoTokenStore,
                    list_projects: &unreachable_projects,
                    browser_login: &no_browser,
                    probe_remote: &remote_facts,
                },
                ledger: &installed,
                config: &nothing_declared,
                linked: &no_linked,
                panel: PanelPorts {
                    open: &open,
                    doctor: DoctorPorts {
                        env_files: &env_files,
                        data_api: &NoDataApi,
                        management: None,
                    },
                    clock: &clock,
                },
            };
            let context = PanelContext {
                cwd: dir.path(),
                paths: &paths,
                env: &self.env,
                env_files: &env_files,
                flags: &flags,
                menu_back: self.menu_back,
            };

            run(&self.connection, &context, &mut ports, &mut ui)
        };

        PanelRun {
            code,
            capture,
            prompter: scripted,
            database,
            cli,
            dir,
        }
    }
}

fn current() -> FakeApplier {
    database(Ledger::Current, Synced::TodosAndNotes)
}

fn equivalent_lines(run: &PanelRun) -> Vec<String> {
    let stderr = run.stderr();
    let lines: Vec<&str> = stderr.lines().collect();

    lines
        .windows(2)
        .filter(|pair| pair[0].trim() == "Equivalent command:")
        .map(|pair| pair[1].trim().to_owned())
        .collect()
}

// MARK: - the menu itself

#[test]
fn exit_closes_the_panel_after_one_header_and_one_menu() {
    let run = Session::local(current()).run(vec![Answer::Action(PanelAction::Exit)]);

    assert_eq!(run.code, OK);
    assert_eq!(run.headers().len(), 1);
    assert_eq!(
        run.headers()[0].1,
        "Pack        0.2.6-alpha.3 · matches this CLI".replace("0.2.6-alpha.3", crate::VERSION)
            + "\nTables      2 synced · notes (pull-only, key slug) ·\n\
               \x20           todos (read-write, key id)\n\
               Jobs        3 scheduled · last compact 12 min ago\n\
               Clients     4 registered · 1 active in the last hour"
    );
    assert_eq!(run.selects(MENU_MESSAGE).len(), 1);
    assert_eq!(equivalent_lines(&run), Vec::<String>::new());
    assert_eq!(run.prompter.unused(), 0);
}

#[test]
fn backspace_on_the_menu_asks_for_the_connection_again() {
    let run = Session::local(current()).run(vec![Answer::Back]);

    assert_eq!(run.code, STEP_BACK);
}

/// The menu reopens on the item chosen last, whatever that item did.
#[test]
fn the_menu_reopens_on_the_item_chosen_before() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::Status),
        Answer::Action(PanelAction::HealthCheck),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(
        run.opened_on(MENU_MESSAGE),
        [
            None,
            Some(PanelAction::Status),
            Some(PanelAction::HealthCheck)
        ]
    );
}

/// An item that only read leaves nothing applied, so Backspace on the menu
/// still reaches the connection before it.
#[test]
fn after_a_read_only_item_backspace_on_the_menu_asks_for_the_connection() {
    for item in [
        PanelAction::Status,
        PanelAction::HealthCheck,
        PanelAction::PendingMigrations,
    ] {
        let mut session = Session::local(current());
        session.migrations_dir = true;
        let run = session.run(vec![Answer::Action(item), Answer::Back]);

        assert_eq!(run.code, STEP_BACK, "{item:?}: {}", run.stderr());
    }
}

/// Once an item applied something, the panel is the first step left:
/// Backspace on the menu does nothing, reads nothing, and the key legend
/// leaves it out.
#[test]
fn after_an_applied_item_backspace_on_the_menu_does_nothing() {
    let scripts = [
        vec![
            Answer::Action(PanelAction::SyncedTables),
            Answer::Tables(vec!["todos".to_owned()]),
            Answer::Confirm(true),
        ],
        vec![
            Answer::Action(PanelAction::ProjectSettings),
            Answer::Section(SectionChoice::Custom),
            Answer::Maintenance(maintenance_with_reap("0 4 * * *")),
            Answer::Section(SectionChoice::Keep),
            Answer::CronPolicy(false),
            Answer::Confirm(true),
        ],
        vec![
            Answer::Action(PanelAction::UpdatePack),
            Answer::Confirm(true),
        ],
        vec![
            Answer::Action(PanelAction::BackgroundJobs),
            Answer::Action(PanelAction::RunJobNow),
            Answer::Action(PanelAction::RunJob(Job::Compact)),
            Answer::Confirm(true),
        ],
        vec![
            Answer::Action(PanelAction::BackgroundJobs),
            Answer::Action(PanelAction::RescheduleJobs),
            Answer::Confirm(true),
        ],
        vec![
            Answer::Action(PanelAction::RemoveKizuna),
            Answer::Typed("local".to_owned()),
            Answer::Confirm(false),
        ],
    ];
    for script in scripts {
        let item = script[0].clone();
        let answers = script
            .into_iter()
            .chain([Answer::Back, Answer::Action(PanelAction::Exit)])
            .collect();
        let run = Session::local(current()).run(answers);

        assert_eq!(run.code, OK, "{item:?}: {}", run.stderr());
        assert_eq!(run.prompter.unused(), 0, "{item:?}");
        assert_eq!(
            run.backs(MENU_MESSAGE),
            [BackKey::Honoured, BackKey::Ignored],
            "{item:?}"
        );
        assert_eq!(run.headers().len(), 2, "{item:?}");
    }
}

/// A connection the environment chose asked no question, so no step lies
/// behind the menu: Backspace there does nothing and reads nothing.
#[test]
fn with_no_connection_question_behind_it_backspace_on_the_menu_does_nothing() {
    let mut session = Session::local(current());
    session.menu_back = BackKey::Ignored;
    let run = session.run(vec![Answer::Back, Answer::Action(PanelAction::Exit)]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(run.prompter.unused(), 0);
    assert_eq!(run.backs(MENU_MESSAGE), [BackKey::Ignored]);
    assert_eq!(run.headers().len(), 1);
}

#[test]
fn ctrl_c_on_the_menu_closes_the_panel_on_zero() {
    let run = Session::local(current()).run(vec![Answer::Cancel]);

    assert_eq!(run.code, OK);
    assert!(!run.ran("begin;"));
    assert_eq!(run.prompter.cancel_outros(), [PANEL_CLOSED]);
}

/// Each round reads the project again: the second header is drawn from a
/// second read, one clock tick later.
#[test]
fn the_health_check_runs_doctor_prints_its_equivalent_and_refreshes_the_header() {
    let mut session = Session::local(current());
    session.tick = 60;
    let run = session.run(vec![
        Answer::Action(PanelAction::HealthCheck),
        Answer::Action(PanelAction::Exit),
    ]);
    let headers = run.headers();

    assert_eq!(run.code, OK);
    assert!(run.stderr().contains("kizunasync doctor: project checks"));
    assert_eq!(
        equivalent_lines(&run),
        ["PGPASSWORD=… kizunasync doctor --db-url postgresql://postgres@127.0.0.1:54322/postgres"]
    );
    assert_eq!(headers.len(), 2);
    assert!(headers[0].1.contains("last compact 12 min ago"));
    assert!(
        headers[1].1.contains("last compact 13 min ago"),
        "{}",
        headers[1].1
    );
    assert_eq!(run.selects(MENU_MESSAGE).len(), 2);
}

#[test]
fn status_draws_the_report_sections_inside_the_panel() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::Status),
        Answer::Action(PanelAction::Exit),
    ]);
    let titles: Vec<&str> = run
        .prompter
        .notes()
        .iter()
        .map(|(title, _)| title.as_str())
        .collect();

    assert_eq!(run.code, OK);
    for section in ["pack", "tables", "clients", "settings", "jobs"] {
        assert!(titles.contains(&section), "{titles:?}");
    }
    assert_eq!(
        equivalent_lines(&run),
        ["PGPASSWORD=… kizunasync status --db-url postgresql://postgres@127.0.0.1:54322/postgres"]
    );
}

#[test]
fn pending_migrations_runs_lint_over_the_migrations_directory() {
    let mut session = Session::local(current());
    session.migrations_dir = true;
    let run = session.run(vec![
        Answer::Action(PanelAction::PendingMigrations),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK);
    assert!(run.stderr().contains("kizunasync lint"), "{}", run.stderr());
    assert!(equivalent_lines(&run)[0].starts_with("PGPASSWORD=… kizunasync lint --db-url"));
}

#[test]
fn a_pack_a_newer_build_recorded_opens_read_only() {
    let run = Session::local(database(Ledger::Newer, Synced::TodosAndNotes))
        .run(vec![Answer::Action(PanelAction::Exit)]);

    assert_eq!(run.code, OK);
    assert!(
        run.headers()[0]
            .1
            .starts_with("This project runs pack 999.0.0")
    );
    assert_eq!(
        labels(&run.selects(MENU_MESSAGE)[0]),
        ["Status", "Health check", "Exit"]
    );
}

// MARK: - update the pack

#[test]
fn an_up_to_date_pack_is_re_applied_after_one_confirmation() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::UpdatePack),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(run.confirms(), ["Re-apply the pack now?"]);
    assert!(run.stderr().contains("re-applying 1 pack file(s):"));
    assert!(
        run.stderr()
            .contains("grants for public, anon and authenticated")
    );
    assert!(run.ran("-- Generated by `kizunasync upgrade --reapply`."));
    assert!(run.stderr().contains("re-applied 1 pack file(s)."));
    assert_eq!(
        equivalent_lines(&run),
        [
            "PGPASSWORD=… kizunasync upgrade --reapply --yes --db-url postgresql://postgres@127.0.0.1:54322/postgres"
        ]
    );
}

#[test]
fn declining_the_update_applies_nothing_and_prints_no_equivalent() {
    for answer in [Answer::Confirm(false), Answer::Back] {
        let run = Session::local(current()).run(vec![
            Answer::Action(PanelAction::UpdatePack),
            answer.clone(),
            Answer::Action(PanelAction::Exit),
        ]);

        assert_eq!(run.code, OK, "{answer:?}");
        assert!(!run.ran("begin;"), "{answer:?}");
        assert!(equivalent_lines(&run).is_empty(), "{answer:?}");
        assert_eq!(run.headers().len(), 2, "{answer:?}: back to the panel");
    }
}

#[test]
fn a_changed_pack_is_reconciled_and_its_hash_recorded() {
    let run = Session::local(database(Ledger::Changed, Synced::TodosAndNotes)).run(vec![
        Answer::Action(PanelAction::UpdatePack),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert!(
        run.stderr()
            .contains("this build's pack differs from the one the ledger records")
    );
    assert!(run.ran("do update set content_hash"));
    assert!(run.stderr().contains("and recorded their hashes."));
}

// MARK: - a differing pack

fn changed() -> FakeApplier {
    database(Ledger::Changed, Synced::TodosAndNotes)
}

/// [`changed`], reading as [`current`] once a re-apply recorded the hash.
fn changed_until_reapplied() -> FakeApplier {
    changed().then("do update set content_hash", current())
}

/// While the ledger records another pack, every menu opens on "Update the
/// pack", whatever was chosen before; a current pack opens on the first
/// item, then on the item chosen last.
#[test]
fn a_differing_pack_opens_every_menu_on_update_the_pack() {
    let run = Session::local(changed()).run(vec![
        Answer::Action(PanelAction::Status),
        Answer::Action(PanelAction::Exit),
    ]);
    let current_run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::Status),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(
        run.opened_on(MENU_MESSAGE),
        [Some(PanelAction::UpdatePack), Some(PanelAction::UpdatePack)]
    );
    assert!(
        run.headers()[0]
            .1
            .contains("· this CLI ships a different pack"),
        "{:?}",
        run.headers()
    );
    assert_eq!(
        current_run.opened_on(MENU_MESSAGE),
        [None, Some(PanelAction::Status)]
    );
}

/// The items that write `_config`, `_settings` or the jobs offer the re-apply
/// before anything else, and No returns to the panel with nothing written.
#[test]
fn an_item_that_writes_offers_the_reapply_first_and_no_returns_to_the_panel() {
    for (answers, item) in [
        (
            vec![Answer::Action(PanelAction::SyncedTables)],
            "Synced tables",
        ),
        (
            vec![Answer::Action(PanelAction::ProjectSettings)],
            "Project settings",
        ),
        (
            vec![
                Answer::Action(PanelAction::BackgroundJobs),
                Answer::Action(PanelAction::RescheduleJobs),
            ],
            "Reschedule from settings",
        ),
    ] {
        let mut script = answers;
        script.extend([Answer::Confirm(false), Answer::Action(PanelAction::Exit)]);
        let run = Session::local(changed()).run(script);

        assert_eq!(run.code, OK, "{item}: {}", run.stderr());
        assert_eq!(run.confirms(), ["Re-apply the pack now?"], "{item}");
        assert!(
            run.prompter
                .notes()
                .iter()
                .any(|(title, _)| title == "Pack changed"),
            "{item}"
        );
        assert!(run.stderr().contains("nothing applied."), "{item}");
        assert!(!run.ran("begin;"), "{item}");
        assert!(!run.ran("_schedule_jobs()"), "{item}");
        assert!(run.migrations().is_empty(), "{item}");
        assert!(equivalent_lines(&run).is_empty(), "{item}");
        assert_eq!(run.headers().len(), 2, "{item}: back to the panel");
        assert_eq!(run.backs(MENU_MESSAGE)[1], BackKey::Honoured, "{item}");
    }
}

/// Yes runs the re-apply `upgrade --reapply --yes` runs, prints that command,
/// and the item carries on: here the sync wizard, backed out of at once. The
/// re-apply is a change, so Backspace on the menu then stays in the panel.
#[test]
fn yes_reapplies_the_pack_then_the_item_carries_on() {
    let run = Session::local(changed_until_reapplied()).run(vec![
        Answer::Action(PanelAction::SyncedTables),
        Answer::Confirm(true),
        Answer::Back,
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert!(run.ran("do update set content_hash"));
    assert!(
        run.stderr()
            .contains("re-applied 1 pack file(s) and recorded their hashes."),
        "{}",
        run.stderr()
    );
    assert!(
        run.prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::Tables { .. })),
        "the sync wizard opens after the re-apply: {:?}",
        run.prompter.asked()
    );
    assert_eq!(
        equivalent_lines(&run),
        [
            "PGPASSWORD=… kizunasync upgrade --reapply --yes --db-url postgresql://postgres@127.0.0.1:54322/postgres"
        ]
    );
    assert_eq!(
        run.backs(MENU_MESSAGE),
        [BackKey::Honoured, BackKey::Ignored]
    );
    assert_eq!(
        run.opened_on(MENU_MESSAGE)[1],
        Some(PanelAction::SyncedTables)
    );
}

/// Over the Management API the re-apply runs through the API, the note says
/// no migration file records it, and the printed command names the project.
#[test]
fn over_the_management_api_the_reapply_runs_through_the_api() {
    let run = Session {
        connection: remote(),
        ..Session::local(changed_until_reapplied())
    }
    .run(vec![
        Answer::Action(PanelAction::ProjectSettings),
        Answer::Confirm(true),
        Answer::Back,
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    let (_, body) = run
        .prompter
        .notes()
        .iter()
        .find(|(title, _)| title == "Pack changed")
        .unwrap();
    assert!(
        body.contains("this run writes no local migration file for it"),
        "{body}"
    );
    assert!(run.ran("do update set content_hash"));
    assert_eq!(
        equivalent_lines(&run),
        [format!(
            "SUPABASE_ACCESS_TOKEN=… kizunasync upgrade --reapply --yes --project-ref {PROJECT_REF}"
        )]
    );
    assert!(!run.stderr().contains(TOKEN));
}

/// Once a re-apply fails over tables an earlier build of the pack created,
/// Update the pack or the gate before an item: the next step names a fresh
/// install over the panel's connection, nothing is applied or printed as an
/// equivalent, and every later menu opens on Remove Kizuna.
#[test]
fn a_re_apply_refused_over_an_earlier_build_opens_the_menu_on_remove_kizuna() {
    for opening in [
        vec![
            Answer::Action(PanelAction::UpdatePack),
            Answer::Confirm(true),
        ],
        vec![
            Answer::Action(PanelAction::SyncedTables),
            Answer::Confirm(true),
        ],
    ] {
        let item = opening[0].clone();
        let mut script = opening;
        script.extend([
            Answer::Action(PanelAction::Status),
            Answer::Action(PanelAction::Exit),
        ]);
        let run = Session::local(database_of_an_earlier_build(Synced::TodosAndNotes)).run(script);
        let stderr = run.stderr();

        assert_eq!(run.code, OK, "{item:?}: {stderr}");
        assert_eq!(run.prompter.unused(), 0, "{item:?}");
        assert!(
            stderr.contains("so nothing was applied and the ledger is unchanged"),
            "{item:?}: {stderr}"
        );
        assert!(
            stderr.contains(
                "Remove Kizuna with `PGPASSWORD=… kizunasync deprovision --purge --db-url postgresql://postgres@127.0.0.1:54322/postgres` (your application tables and their data stay), then install it again with `PGPASSWORD=… kizunasync init --db-url postgresql://postgres@127.0.0.1:54322/postgres`."
            ),
            "{item:?}: {stderr}"
        );
        assert_eq!(
            run.opened_on(MENU_MESSAGE),
            [
                Some(PanelAction::UpdatePack),
                Some(PanelAction::RemoveKizuna),
                Some(PanelAction::RemoveKizuna)
            ],
            "{item:?}"
        );
        assert_eq!(
            equivalent_lines(&run),
            [
                "PGPASSWORD=… kizunasync status --db-url postgresql://postgres@127.0.0.1:54322/postgres"
            ],
            "{item:?}"
        );
        assert!(!run.ran("_schedule_jobs()::text"), "{item:?}");
        assert!(
            !run.prompter
                .asked()
                .iter()
                .any(|ask| matches!(ask, Ask::Tables { .. })),
            "{item:?}: the item does not carry on"
        );
        assert_eq!(
            run.backs(MENU_MESSAGE)[1],
            BackKey::Honoured,
            "{item:?}: nothing was applied"
        );
    }
}

/// Remove Kizuna needs a direct connection, so a Management API panel keeps
/// opening on Update the pack after a re-apply fails over an earlier build,
/// and the step names the direct-connection commands.
#[test]
fn over_the_management_api_a_re_apply_refused_over_an_earlier_build_keeps_update_the_pack() {
    let run = Session {
        connection: remote(),
        ..Session::local(database_of_an_earlier_build(Synced::TodosAndNotes))
    }
    .run(vec![
        Answer::Action(PanelAction::UpdatePack),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);
    let stderr = run.stderr();

    assert_eq!(run.code, OK, "{stderr}");
    assert!(
        stderr.contains(
            "remove Kizuna over the project's direct connection with `PGPASSWORD=… kizunasync deprovision --purge --db-url <the project's connection string>`"
        ),
        "{stderr}"
    );
    assert_eq!(
        run.opened_on(MENU_MESSAGE),
        [Some(PanelAction::UpdatePack), Some(PanelAction::UpdatePack)]
    );
}

/// A pack directory holding this checkout's files plus one pending file.
fn pack_with(name: &str, sql: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let migrations = dir.path().join("supabase/migrations");
    std::fs::create_dir_all(&migrations).unwrap();
    let mut listed = Vec::new();
    for file in read_pack_files(&pack_dir()).unwrap() {
        std::fs::write(migrations.join(&file.name), &file.sql).unwrap();
        listed.push(format!("\"{}\"", file.name));
    }
    std::fs::write(migrations.join(name), sql).unwrap();
    listed.push(format!("\"{name}\""));
    std::fs::write(
        dir.path().join("pack.manifest.json"),
        format!("{{ \"pack\": [{}] }}\n", listed.join(", ")),
    )
    .unwrap();

    dir
}

#[test]
fn a_breaking_pending_file_refuses_before_anything_is_asked() {
    let pack = pack_with("0002_break.sql", "alter table todos drop column title;\n");
    let mut session = Session::local(current());
    session.env = Env::from_pairs(&[("KSYNC_PACK_DIR", pack.path().to_string_lossy().as_ref())]);
    let run = session.run(vec![
        Answer::Action(PanelAction::UpdatePack),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(run.confirms(), Vec::<String>::new());
    assert!(run.stderr().contains("BREAKING  0002_break.sql  [todos]"));
    assert!(!run.ran("drop column title"));
    assert_eq!(
        hint_of(&run.selects(MENU_MESSAGE)[0], PanelAction::UpdatePack),
        Some("1 pending pack file(s) to apply")
    );
}

#[test]
fn an_additive_pending_file_applies_with_its_ledger_row() {
    let pack = pack_with("0002_add.sql", "alter table todos add column note text;\n");
    let mut session = Session::local(current());
    session.env = Env::from_pairs(&[("KSYNC_PACK_DIR", pack.path().to_string_lossy().as_ref())]);
    let run = session.run(vec![
        Answer::Action(PanelAction::UpdatePack),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(run.confirms(), ["Apply the pending pack file(s) now?"]);
    assert!(run.ran("add column note text"));
    assert!(run.ran("insert into kizunasync._provisions"));
    assert!(equivalent_lines(&run)[0].contains("kizunasync upgrade --yes --db-url"));
}

// MARK: - background jobs

#[test]
fn the_jobs_submenu_lists_runs_and_reschedules_with_a_confirmation() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::BackgroundJobs),
        Answer::Action(PanelAction::ListJobs),
        Answer::Action(PanelAction::BackgroundJobs),
        Answer::Action(PanelAction::RunJobNow),
        Answer::Action(PanelAction::RunJob(Job::Reap)),
        Answer::Confirm(true),
        Answer::Action(PanelAction::BackgroundJobs),
        Answer::Action(PanelAction::RescheduleJobs),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);
    let url = "--db-url postgresql://postgres@127.0.0.1:54322/postgres";

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert!(
        run.stderr()
            .contains("kizunasync jobs: the pack's background jobs")
    );
    assert!(run.ran("select kizunasync.reap_tombstones() as count;"));
    assert!(run.ran("kizunasync._schedule_jobs()"));
    assert_eq!(
        run.confirms(),
        [
            "Run kizunasync.reap_tombstones() now?",
            "Reschedule the three jobs from kizunasync._settings now?",
        ]
    );
    assert_eq!(
        equivalent_lines(&run),
        [
            format!("PGPASSWORD=… kizunasync jobs list {url}"),
            format!("PGPASSWORD=… kizunasync jobs run reap {url}"),
            format!("PGPASSWORD=… kizunasync jobs schedule {url}"),
        ]
    );
    assert_eq!(run.selects(JOBS_MESSAGE).len(), 3);
    assert_eq!(
        labels(&run.selects(JOB_MESSAGE)[0]),
        ["reap", "compact", "prune"]
    );
}

#[test]
fn backspace_in_the_jobs_submenu_returns_to_the_panel() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::BackgroundJobs),
        Answer::Back,
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK);
    assert_eq!(equivalent_lines(&run), Vec::<String>::new());
    assert_eq!(run.selects(MENU_MESSAGE).len(), 2);
}

/// Backspace on the job picker reopens the jobs submenu on the item that led
/// to it, not the panel.
#[test]
fn backspace_on_the_job_picker_reopens_the_jobs_submenu_on_its_item() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::BackgroundJobs),
        Answer::Action(PanelAction::RunJobNow),
        Answer::Back,
        Answer::Action(PanelAction::ListJobs),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(run.prompter.unused(), 0);
    assert_eq!(
        run.opened_on(JOBS_MESSAGE),
        [None, Some(PanelAction::RunJobNow)]
    );
    assert!(
        run.stderr()
            .contains("kizunasync jobs: the pack's background jobs")
    );
}

/// Backspace on the run confirmation reopens the job picker on that job.
#[test]
fn backspace_on_the_run_confirmation_reopens_the_job_picker_on_that_job() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::BackgroundJobs),
        Answer::Action(PanelAction::RunJobNow),
        Answer::Action(PanelAction::RunJob(Job::Compact)),
        Answer::Back,
        Answer::Action(PanelAction::RunJob(Job::Compact)),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(run.prompter.unused(), 0);
    assert_eq!(
        run.opened_on(JOB_MESSAGE),
        [None, Some(PanelAction::RunJob(Job::Compact))]
    );
    assert!(run.ran("select kizunasync.compact_changelog() as count;"));
}

/// Backspace on the reschedule confirmation reopens the jobs submenu on
/// Reschedule from settings.
#[test]
fn backspace_on_the_reschedule_confirmation_reopens_the_jobs_submenu_on_it() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::BackgroundJobs),
        Answer::Action(PanelAction::RescheduleJobs),
        Answer::Back,
        Answer::Action(PanelAction::ListJobs),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(run.prompter.unused(), 0);
    assert_eq!(
        run.opened_on(JOBS_MESSAGE),
        [None, Some(PanelAction::RescheduleJobs)]
    );
    assert!(!run.ran("kizunasync._schedule_jobs()"));
}

#[test]
fn a_declined_job_runs_nothing() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::BackgroundJobs),
        Answer::Action(PanelAction::RunJobNow),
        Answer::Action(PanelAction::RunJob(Job::Reap)),
        Answer::Confirm(false),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK);
    assert!(!run.ran("reap_tombstones()"));
    assert_eq!(equivalent_lines(&run), Vec::<String>::new());
}

// MARK: - remove Kizuna

#[test]
fn a_wrong_target_removes_nothing() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::RemoveKizuna),
        Answer::Typed("production".to_owned()),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK);
    assert!(
        run.capture.stdout().contains("[function]"),
        "the dry run's plan"
    );
    assert!(
        run.stderr()
            .contains("--dry-run: plan shown; nothing applied.")
    );
    assert!(
        run.stderr()
            .contains("that is not \"local\": nothing was removed.")
    );
    assert!(!run.ran("begin;"));
    assert_eq!(
        run.prompter
            .asked()
            .iter()
            .filter(|ask| matches!(ask, Ask::TypedConfirmation { .. }))
            .count(),
        1
    );
    assert!(run.prompter.asked().contains(&Ask::TypedConfirmation {
        message: "Type \"local\" to remove Kizuna from this database".to_owned(),
        expected: "local".to_owned(),
        current: None,
    }));
    assert_eq!(equivalent_lines(&run), Vec::<String>::new());
}

#[test]
fn the_typed_target_removes_the_ledgered_objects_and_keeps_the_schema() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::RemoveKizuna),
        Answer::Typed(" local ".to_owned()),
        Answer::Confirm(false),
        Answer::Action(PanelAction::Exit),
    ]);
    let executed = run.executed();
    let script = executed
        .iter()
        .find(|sql| sql.starts_with("-- Generated by `kizunasync deprovision`."))
        .expect("the down-migration");

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert!(!script.contains("drop schema"));
    assert_eq!(
        run.confirms(),
        ["Also drop the kizunasync schema and every bookkeeping table (purge)?"]
    );
    let lines = equivalent_lines(&run);
    assert_eq!(
        lines.last().map(String::as_str),
        Some(
            "PGPASSWORD=… kizunasync deprovision --yes --db-url postgresql://postgres@127.0.0.1:54322/postgres"
        )
    );
}

#[test]
fn the_purge_prompt_drops_the_schema_with_the_typed_target() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::RemoveKizuna),
        Answer::Typed("local".to_owned()),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert!(run.ran("drop schema if exists kizunasync cascade;"));
    assert_eq!(
        equivalent_lines(&run).last().map(String::as_str),
        Some(
            "PGPASSWORD=… kizunasync deprovision --yes --purge --confirm local --db-url postgresql://postgres@127.0.0.1:54322/postgres"
        )
    );
}

/// A removal that leaves the ledger empty closes the panel, and the bare flow
/// goes on down the install path for that database: no header or menu after
/// the removal, the fresh install question, and its own closing line.
#[test]
fn a_removal_that_empties_the_ledger_closes_the_panel_on_the_install_path() {
    for purge in [false, true] {
        let removed = current().then(
            "-- Generated by `kizunasync deprovision",
            database(Ledger::Empty, Synced::Nothing),
        );
        let run = Session::local(removed).run(vec![
            Answer::Action(PanelAction::RemoveKizuna),
            Answer::Typed("local".to_owned()),
            Answer::Confirm(purge),
            Answer::Confirm(false),
        ]);

        assert_eq!(run.code, OK, "purge {purge}: {}", run.stderr());
        assert_eq!(run.prompter.unused(), 0, "purge {purge}");
        assert_eq!(run.headers().len(), 1, "purge {purge}");
        assert_eq!(run.selects(MENU_MESSAGE).len(), 1, "purge {purge}");
        assert_eq!(
            run.confirms(),
            [
                "Also drop the kizunasync schema and every bookkeeping table (purge)?",
                smart::FRESH_INSTALL,
            ],
            "purge {purge}"
        );
        assert_eq!(
            run.prompter.cancel_outros(),
            ["Nothing done: `kizunasync init` installs, `kizunasync --help` lists the rest."],
            "purge {purge}"
        );
        assert_eq!(equivalent_lines(&run).len(), 1, "purge {purge}");
    }
}

#[test]
fn backspace_at_the_typed_target_returns_to_the_panel() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::RemoveKizuna),
        Answer::Back,
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK);
    assert!(!run.ran("begin;"));
    assert_eq!(run.selects(MENU_MESSAGE).len(), 2);
}

/// Backspace on the purge question reopens the typed target on the text typed
/// there, which an empty answer keeps.
#[test]
fn backspace_on_the_purge_question_reopens_the_typed_target_on_what_was_typed() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::RemoveKizuna),
        Answer::Typed("local".to_owned()),
        Answer::Back,
        Answer::Typed(String::new()),
        Answer::Confirm(false),
        Answer::Action(PanelAction::Exit),
    ]);
    let typed: Vec<Option<String>> = run
        .prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::TypedConfirmation { current, .. } => Some(current.clone()),
            _ => None,
        })
        .collect();

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(run.prompter.unused(), 0);
    assert_eq!(typed, [None, Some("local".to_owned())]);
    assert_eq!(run.confirms().len(), 2);
    assert!(
        run.executed()
            .iter()
            .any(|sql| sql.starts_with("-- Generated by `kizunasync deprovision`."))
    );
}

#[test]
fn over_the_management_api_jobs_and_removal_say_why_and_run_nothing() {
    let mut session = Session::local(current());
    session.connection = remote();
    let run = session.run(vec![
        Answer::Action(PanelAction::BackgroundJobs),
        Answer::Action(PanelAction::RemoveKizuna),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK);
    assert!(run.stderr().contains(NEEDS_DIRECT));
    assert_eq!(run.selects(JOBS_MESSAGE), Vec::<Vec<PanelItem>>::new());
    assert!(
        !run.prompter
            .asked()
            .iter()
            .any(|ask| matches!(ask, Ask::TypedConfirmation { .. }))
    );
    assert!(!run.ran("object_args"));
    assert_eq!(
        run.headers()[0].0,
        format!("Kizuna Sync · project {PROJECT_REF} · Management API")
    );
}

// MARK: - project settings

fn maintenance_with_reap(schedule: &str) -> ProjectSettings {
    ProjectSettings {
        reap_schedule: Some(schedule.to_owned()),
        ..ProjectSettings::pack_defaults()
    }
}

#[test]
fn project_settings_write_the_sync_delta_and_push_it() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::ProjectSettings),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(maintenance_with_reap("0 4 * * *")),
        Answer::Section(SectionChoice::Keep),
        Answer::CronPolicy(false),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(
        run.confirms(),
        ["Write the settings migration and run supabase db push --local now?"]
    );
    assert!(run.prompter.notes().contains(&(
        "Project settings".to_owned(),
        "--reap-schedule 0 4 * * *".to_owned()
    )));
    let migration = run
        .migrations()
        .into_iter()
        .find(|name| name.ends_with("_kizunasync_sync.sql"))
        .expect("the settings delta");
    let sql = std::fs::read_to_string(run.dir.path().join("supabase/migrations").join(migration))
        .unwrap();
    assert!(sql.contains("reap_schedule = '0 4 * * *'"), "{sql}");
    assert_eq!(*run.cli.pushes.borrow(), [PushTarget::Local]);
    assert_eq!(
        equivalent_lines(&run),
        [
            "PGPASSWORD=… kizunasync sync --reap-schedule '0 4 * * *' --yes --db-url postgresql://postgres@127.0.0.1:54322/postgres"
        ]
    );
}

#[test]
fn keeping_every_setting_writes_nothing() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::ProjectSettings),
        Answer::Section(SectionChoice::Keep),
        Answer::Section(SectionChoice::Keep),
        Answer::CronPolicy(false),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK);
    assert!(run.stderr().contains("nothing to change"));
    assert_eq!(run.migrations(), Vec::<String>::new());
    assert_eq!(equivalent_lines(&run), Vec::<String>::new());
}

#[test]
fn backspace_on_the_first_settings_section_returns_to_the_panel() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::ProjectSettings),
        Answer::Back,
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK);
    assert_eq!(run.migrations(), Vec::<String>::new());
    assert_eq!(run.selects(MENU_MESSAGE).len(), 2);
}

/// Backspace on the pg_cron policy reopens the custom push value before it,
/// on the value it answered.
#[test]
fn backspace_on_the_cron_policy_reopens_the_custom_push_value() {
    let capped = |size: i64| ProjectSettings {
        max_batch_size: Some(MaxBatchSize::Mutations(size)),
        ..ProjectSettings::pack_defaults()
    };
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::ProjectSettings),
        Answer::Section(SectionChoice::Keep),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(capped(300)),
        Answer::Back,
        Answer::PushPolicy(capped(300)),
        Answer::CronPolicy(false),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);
    let pushes: Vec<Option<MaxBatchSize>> = run
        .prompter
        .asked()
        .iter()
        .filter_map(|ask| match ask {
            Ask::PushPolicy { current } => Some(current.max_batch_size),
            _ => None,
        })
        .collect();

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(run.prompter.unused(), 0);
    assert_eq!(pushes.len(), 2);
    assert_eq!(pushes[1], Some(MaxBatchSize::Mutations(300)));
    assert!(
        equivalent_lines(&run)[0].contains("kizunasync sync --max-batch-size 300 --yes"),
        "{:?}",
        equivalent_lines(&run)
    );
}

/// The pg_cron step of Project settings states the current schedule and opens
/// on it: keep the jobs scheduled while pg_cron holds them, run them by hand
/// while it does not. It never asks the install's question.
#[test]
fn project_settings_ask_how_retention_runs_opened_on_the_current_schedule() {
    for (database, jobs, by_hand) in [
        (current(), RetentionJobs::Scheduled(3), false),
        (
            database_without_pg_cron(Ledger::Current, Synced::TodosAndNotes),
            RetentionJobs::NoPgCron,
            true,
        ),
    ] {
        let run = Session::local(database).run(vec![
            Answer::Action(PanelAction::ProjectSettings),
            Answer::Section(SectionChoice::Keep),
            Answer::Section(SectionChoice::Keep),
            Answer::CronPolicy(by_hand),
            Answer::Action(PanelAction::Exit),
        ]);
        let asked = run.prompter.asked();

        assert_eq!(run.code, OK, "{jobs:?}: {}", run.stderr());
        assert_eq!(run.prompter.unused(), 0, "{jobs:?}");
        assert!(
            asked.contains(&Ask::RetentionPolicy {
                jobs,
                allow_no_cron: by_hand,
            }),
            "{asked:?}"
        );
        assert!(
            !asked
                .iter()
                .any(|ask| matches!(ask, Ask::CronPolicy { .. })),
            "{asked:?}"
        );
    }
}

/// Over the Management API the same delta applies in place, with no migration
/// file, the way `kizunasync sync --project-ref` applies it.
#[test]
fn project_settings_over_the_management_api_apply_in_place() {
    let mut session = Session::local(current());
    session.connection = remote();
    let run = session.run(vec![
        Answer::Action(PanelAction::ProjectSettings),
        Answer::Section(SectionChoice::Keep),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(ProjectSettings {
            max_batch_size: Some(MaxBatchSize::Mutations(200)),
            ..ProjectSettings::pack_defaults()
        }),
        Answer::CronPolicy(false),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert_eq!(
        run.confirms(),
        ["Apply these settings to the hosted project now?"]
    );
    assert!(run.ran("max_batch_size = 200"));
    assert_eq!(run.migrations(), Vec::<String>::new());
    assert_eq!(
        equivalent_lines(&run),
        [format!(
            "SUPABASE_ACCESS_TOKEN=… kizunasync sync --max-batch-size 200 --yes --project-ref {PROJECT_REF}"
        )]
    );
    assert!(!run.stderr().contains(TOKEN));
}

// MARK: - synced tables

#[test]
fn synced_tables_hand_off_to_the_sync_wizard_and_come_back() {
    let run = Session::local(current()).run(vec![
        Answer::Action(PanelAction::SyncedTables),
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Confirm(true),
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK, "{}", run.stderr());
    assert!(
        run.stderr()
            .contains("kizunasync sync: managing the synced tables")
    );
    assert!(
        run.migrations()
            .iter()
            .any(|name| name.ends_with("_kizunasync_sync.sql"))
    );
    assert_eq!(*run.cli.pushes.borrow(), [PushTarget::Local]);
    assert_eq!(run.selects(MENU_MESSAGE).len(), 2);
}

#[test]
fn with_no_synced_table_the_item_offers_the_install_proposal() {
    let run = Session::local(database(Ledger::Current, Synced::Nothing)).run(vec![
        Answer::Action(PanelAction::SyncedTables),
        Answer::Back,
        Answer::Action(PanelAction::Exit),
    ]);

    assert_eq!(run.code, OK);
    assert_eq!(run.confirms(), [smart::NOTHING_SYNCED]);
    assert_eq!(equivalent_lines(&run), Vec::<String>::new());
    assert_eq!(run.selects(MENU_MESSAGE).len(), 2);
}

/// Ctrl+C inside a hand-off ends that hand-off cleanly, and the panel closes
/// with it instead of drawing the menu again. A cancelled action ran nothing,
/// so no equivalent command is printed for it: not the `sync` wizard's, not
/// the install proposal's.
#[test]
fn ctrl_c_inside_a_hand_off_closes_the_panel() {
    for (database, answers) in [
        (
            current(),
            vec![Answer::Action(PanelAction::SyncedTables), Answer::Cancel],
        ),
        (
            database(Ledger::Current, Synced::Nothing),
            vec![
                Answer::Action(PanelAction::SyncedTables),
                Answer::Confirm(true),
                Answer::Cancel,
            ],
        ),
    ] {
        let run = Session::local(database).run(answers);

        assert_eq!(run.code, OK, "{}", run.stderr());
        assert_eq!(run.prompter.unused(), 0);
        assert_eq!(run.selects(MENU_MESSAGE).len(), 1);
        assert_eq!(run.migrations(), Vec::<String>::new());
        assert_eq!(run.prompter.cancel_outros(), [PANEL_CLOSED]);
        assert!(
            equivalent_lines(&run).is_empty(),
            "{:?}",
            equivalent_lines(&run)
        );
    }
}
