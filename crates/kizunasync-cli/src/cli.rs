use std::fmt;
use std::path::PathBuf;

use clap::{ArgAction, Args, Parser, Subcommand, ValueEnum};

use crate::db::redact_db_url;
use crate::project_ref::ProjectRef;

/// `value`'s connection string with its password segment masked; `None`
/// stays `None`. Every manual `Debug` below uses this so a `--db-url` flag
/// never prints its password.
fn redacted_db_url(value: Option<&String>) -> Option<String> {
    value.map(|url| redact_db_url(url))
}

/// `value` replaced by a fixed placeholder so a manual `Debug` below never
/// prints an access token, while still showing whether one was given.
fn redacted_secret(value: Option<&String>) -> Option<&'static str> {
    value.map(|_| "***")
}

/// Offline-first sync for Supabase.
#[derive(Debug, Parser)]
#[command(
    name = "kizunasync",
    about = "絆 Kizuna Sync: offline-first sync for Supabase",
    long_about = None,
    disable_version_flag = true,
    subcommand_required = false,
    arg_required_else_help = false,
    after_help = "Docs: https://kizunasync.com/docs/cli\n\ninit/sync prompt on a TTY; status is a Clack report on a TTY, or --json/--quiet for CI.\nRun kizunasync with no command in a terminal for the setup flow, or the control panel once Kizuna is installed; anywhere else it prints this help.",
)]
pub(crate) struct Cli {
    /// Print the version and exit
    #[arg(short = 'v', long = "version", action = ArgAction::SetTrue, global = true)]
    pub(crate) version: bool,
    /// Never emit ANSI colour (also honoured: NO_COLOR).
    #[arg(long, global = true)]
    pub(crate) no_color: bool,
    /// Project root (else SUPABASE_WORKDIR, else the nearest supabase/config.toml above the cwd)
    #[arg(long, global = true, value_name = "PATH")]
    pub(crate) workdir: Option<PathBuf>,
    #[command(subcommand)]
    pub(crate) command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub(crate) enum Command {
    /// Provision Kizuna into your Supabase project
    Init(InitArgs),
    /// Add and remove synced tables
    Sync(SyncArgs),
    /// Report pack state, synced tables, columns, clients, and exposed-schema config
    Status(StatusArgs),
    /// Verify the project: synced tables, supabase dir, provisioned state
    Doctor(DoctorArgs),
    /// Classify pending migrations as additive vs breaking
    Lint(LintArgs),
    /// Apply the pack files the ledger does not record yet when all are additive, or re-apply the pack with --reapply
    Upgrade(UpgradeArgs),
    /// Remove every ledgered Kizuna object from the project
    Deprovision(DeprovisionArgs),
    /// List, run, and reschedule the pack's background jobs
    Jobs(JobsArgs),
    /// Test tooling: deterministic datasets and marker-scoped write churn
    Mock(MockArgs),
    /// Print the version
    Version,
}

/// The connection a DB-backed command uses. `--project-ref` picks the
/// Management API; everything else resolves a direct Postgres connection.
#[derive(Args)]
pub(crate) struct TransportArgs {
    /// Postgres connection string (else KSYNC_DB_URL, DIRECT_URL, POSTGRES_URL_NON_POOLING, DATABASE_URL, POSTGRES_URL, supabase/config.toml)
    #[arg(long, value_name = "URL")]
    pub(crate) db_url: Option<String>,
    /// Drive the Supabase Management API against this project instead
    #[arg(long, value_name = "REF", conflicts_with = "db_url", value_parser = ProjectRef::parse)]
    pub(crate) project_ref: Option<ProjectRef>,
    /// Personal Access Token for --project-ref (else SUPABASE_ACCESS_TOKEN)
    #[arg(long, value_name = "TOKEN")]
    pub(crate) access_token: Option<String>,
}

impl fmt::Debug for TransportArgs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TransportArgs")
            .field("db_url", &redacted_db_url(self.db_url.as_ref()))
            .field("project_ref", &self.project_ref)
            .field("access_token", &redacted_secret(self.access_token.as_ref()))
            .finish()
    }
}

// A clap flag surface is a bag of switches; a state machine would only hide which flag the user typed.
#[expect(clippy::struct_excessive_bools)]
#[derive(Args)]
pub(crate) struct InitArgs {
    /// Show the plan and change nothing
    #[arg(long)]
    pub(crate) dry_run: bool,
    /// Write without asking
    #[arg(long)]
    pub(crate) yes: bool,
    /// Write migrations but do not apply
    #[arg(long)]
    pub(crate) local_only: bool,
    /// Schema the synced tables live in (the pack supports public only)
    #[arg(long, default_value = "public")]
    pub(crate) schema: String,
    /// Provision the hosted project over the Management API
    #[arg(long, value_name = "REF", conflicts_with_all = ["local_only", "db_url"], value_parser = ProjectRef::parse)]
    pub(crate) project_ref: Option<ProjectRef>,
    /// Postgres connection string for introspection
    #[arg(long, value_name = "URL")]
    pub(crate) db_url: Option<String>,
    /// Personal Access Token for --project-ref
    #[arg(long, value_name = "TOKEN")]
    pub(crate) access_token: Option<String>,
    /// Largest push the server accepts (default: 500)
    #[arg(long, value_name = "N", conflicts_with = "no_max_batch_size")]
    pub(crate) max_batch_size: Option<i64>,
    /// Accept a push of any size (default: 500)
    #[arg(long)]
    pub(crate) no_max_batch_size: bool,
    /// Reject a non-atomic push (default: off)
    #[arg(long, conflicts_with = "no_require_atomic")]
    pub(crate) require_atomic: bool,
    /// Accept a non-atomic push (default: off)
    #[arg(long)]
    pub(crate) no_require_atomic: bool,
    #[command(flatten)]
    pub(crate) table_defaults: TableDefaultsArgs,
    /// Record one client row per device that syncs a table (default: off)
    #[arg(long, conflicts_with = "no_register_clients")]
    pub(crate) register_clients: bool,
    /// Do not record client rows (default: off)
    #[arg(long)]
    pub(crate) no_register_clients: bool,
    /// Lowest client schema version every table accepts (default: 1)
    #[arg(long, value_name = "N")]
    pub(crate) min_schema_version: Option<i64>,
    /// Project-wide tombstone retention in days (default: 30)
    #[arg(long, value_name = "DAYS")]
    pub(crate) tombstone_ttl_days: Option<i64>,
    /// UTC crontab for the tombstone reaper (default: 16 3 * * *)
    #[arg(long, value_name = "CRON")]
    pub(crate) reap_schedule: Option<String>,
    /// UTC crontab for the changelog compactor (default: 47 3 * * *)
    #[arg(long, value_name = "CRON")]
    pub(crate) compact_schedule: Option<String>,
    /// UTC crontab for the client pruner (default: 31 3 * * *)
    #[arg(long, value_name = "CRON")]
    pub(crate) client_prune_schedule: Option<String>,
    /// Days of silence after which a client row is pruned (default: 90)
    #[arg(long, value_name = "DAYS")]
    pub(crate) client_ttl_days: Option<i64>,
    /// Forward-drift tolerance for an origin HLC (default: 5000)
    #[arg(long, value_name = "MS")]
    pub(crate) hlc_max_skew_ms: Option<i64>,
    /// Candidates one pull page examines at most (default: 5000)
    #[arg(long, value_name = "N")]
    pub(crate) max_pull_scan: Option<i64>,
    /// Install without scheduled retention when pg_cron is absent
    #[arg(long)]
    pub(crate) allow_no_cron: bool,
    /// Sync a table even when its row level security is disabled
    #[arg(long)]
    pub(crate) allow_no_rls: bool,
}

impl fmt::Debug for InitArgs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InitArgs")
            .field("dry_run", &self.dry_run)
            .field("yes", &self.yes)
            .field("local_only", &self.local_only)
            .field("schema", &self.schema)
            .field("project_ref", &self.project_ref)
            .field("db_url", &redacted_db_url(self.db_url.as_ref()))
            .field("access_token", &redacted_secret(self.access_token.as_ref()))
            .field("max_batch_size", &self.max_batch_size)
            .field("no_max_batch_size", &self.no_max_batch_size)
            .field("require_atomic", &self.require_atomic)
            .field("no_require_atomic", &self.no_require_atomic)
            .field("table_defaults", &self.table_defaults)
            .field("register_clients", &self.register_clients)
            .field("no_register_clients", &self.no_register_clients)
            .field("min_schema_version", &self.min_schema_version)
            .field("tombstone_ttl_days", &self.tombstone_ttl_days)
            .field("reap_schedule", &self.reap_schedule)
            .field("compact_schedule", &self.compact_schedule)
            .field("client_prune_schedule", &self.client_prune_schedule)
            .field("client_ttl_days", &self.client_ttl_days)
            .field("hlc_max_skew_ms", &self.hlc_max_skew_ms)
            .field("max_pull_scan", &self.max_pull_scan)
            .field("allow_no_cron", &self.allow_no_cron)
            .field("allow_no_rls", &self.allow_no_rls)
            .finish()
    }
}

/// `sync_mode` as `kizunasync._config` records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum SyncModeArg {
    /// Pulled, but a push targeting it is rejected server-side
    PullOnly,
    /// Bidirectional
    ReadWrite,
}

/// `conflict_mode` as `kizunasync._config` records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum ConflictArg {
    /// Column-LWW by server arrival order
    Arrival,
    /// Column-LWW keyed on the origin HLC
    Hlc,
}

/// The table-level sync and conflict defaults `init` and `sync` apply
/// identically, flattened so the flag declarations exist once.
#[derive(Debug, Args)]
pub(crate) struct TableDefaultsArgs {
    /// Sync mode for every added table (default: pull-only)
    #[arg(long, value_enum, value_name = "MODE")]
    pub(crate) sync: Option<SyncModeArg>,
    /// Column every added table's rows are scoped by (default: none)
    #[arg(long, value_name = "COL")]
    pub(crate) bucket_column: Option<String>,
    /// Soft-delete column for every added table (default: none)
    #[arg(long, value_name = "COL")]
    pub(crate) soft_delete: Option<String>,
    /// Conflict mode for every added table (default: arrival)
    #[arg(long, value_enum, value_name = "MODE")]
    pub(crate) conflict: Option<ConflictArg>,
    /// Record overwritten same-column values server-side (default: off)
    #[arg(long)]
    pub(crate) conflict_journal: bool,
}

// A clap flag surface is a bag of switches; a state machine would only hide which flag the user typed.
#[expect(clippy::struct_excessive_bools)]
#[derive(Args)]
pub(crate) struct SyncArgs {
    /// Tables to start syncing (repeatable)
    #[arg(long, action = ArgAction::Append, value_name = "TABLE")]
    pub(crate) add: Vec<String>,
    /// Tables to stop syncing (repeatable)
    #[arg(long, action = ArgAction::Append, value_name = "TABLE")]
    pub(crate) remove: Vec<String>,
    #[command(flatten)]
    pub(crate) table_defaults: TableDefaultsArgs,
    /// Record one client row per device that syncs an added table (default: off)
    #[arg(long, conflicts_with = "no_register_clients")]
    pub(crate) register_clients: bool,
    /// Do not record client rows for an added table (default: off)
    #[arg(long)]
    pub(crate) no_register_clients: bool,
    /// Lowest client schema version every added table accepts (default: 1)
    #[arg(long, value_name = "N")]
    pub(crate) min_schema_version: Option<i64>,
    /// Tombstone retention for every added table (default: the project's own)
    #[arg(long, value_name = "DAYS")]
    pub(crate) tombstone_ttl_days: Option<i64>,
    /// Largest push the server accepts (unnamed: unchanged)
    #[arg(long, value_name = "N", conflicts_with = "no_max_batch_size")]
    pub(crate) max_batch_size: Option<i64>,
    /// Accept a push of any size (unnamed: unchanged)
    #[arg(long)]
    pub(crate) no_max_batch_size: bool,
    /// Reject a non-atomic push (unnamed: unchanged)
    #[arg(long, conflicts_with = "no_require_atomic")]
    pub(crate) require_atomic: bool,
    /// Accept a non-atomic push (unnamed: unchanged)
    #[arg(long)]
    pub(crate) no_require_atomic: bool,
    /// UTC crontab for the tombstone reaper (unnamed: unchanged)
    #[arg(long, value_name = "CRON")]
    pub(crate) reap_schedule: Option<String>,
    /// UTC crontab for the changelog compactor (unnamed: unchanged)
    #[arg(long, value_name = "CRON")]
    pub(crate) compact_schedule: Option<String>,
    /// UTC crontab for the client pruner (unnamed: unchanged)
    #[arg(long, value_name = "CRON")]
    pub(crate) client_prune_schedule: Option<String>,
    /// Days of silence after which a client row is pruned (unnamed: unchanged)
    #[arg(long, value_name = "DAYS")]
    pub(crate) client_ttl_days: Option<i64>,
    /// Forward-drift tolerance for an origin HLC (unnamed: unchanged)
    #[arg(long, value_name = "MS")]
    pub(crate) hlc_max_skew_ms: Option<i64>,
    /// Candidates one pull page examines at most (unnamed: unchanged)
    #[arg(long, value_name = "N")]
    pub(crate) max_pull_scan: Option<i64>,
    /// Write a schedule even when pg_cron is absent to run it
    #[arg(long)]
    pub(crate) allow_no_cron: bool,
    /// Sync an added table even when its row level security is disabled
    #[arg(long)]
    pub(crate) allow_no_rls: bool,
    /// Schema the synced tables live in (the pack supports public only)
    #[arg(long, default_value = "public")]
    pub(crate) schema: String,
    /// Postgres connection string (else KSYNC_DB_URL, DIRECT_URL, POSTGRES_URL_NON_POOLING, DATABASE_URL, POSTGRES_URL, supabase/config.toml)
    #[arg(long, value_name = "URL")]
    pub(crate) db_url: Option<String>,
    /// Configure the hosted project over the Management API
    #[arg(long, value_name = "REF", conflicts_with_all = ["db_url", "local_only"], value_parser = ProjectRef::parse)]
    pub(crate) project_ref: Option<ProjectRef>,
    /// Personal Access Token for --project-ref
    #[arg(long, value_name = "TOKEN")]
    pub(crate) access_token: Option<String>,
    /// Show the plan and the SQL; write nothing
    #[arg(long)]
    pub(crate) dry_run: bool,
    /// Write without asking
    #[arg(long)]
    pub(crate) yes: bool,
    /// Write the migration but do not apply it
    #[arg(long)]
    pub(crate) local_only: bool,
}

impl fmt::Debug for SyncArgs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SyncArgs")
            .field("add", &self.add)
            .field("remove", &self.remove)
            .field("table_defaults", &self.table_defaults)
            .field("register_clients", &self.register_clients)
            .field("no_register_clients", &self.no_register_clients)
            .field("min_schema_version", &self.min_schema_version)
            .field("tombstone_ttl_days", &self.tombstone_ttl_days)
            .field("max_batch_size", &self.max_batch_size)
            .field("no_max_batch_size", &self.no_max_batch_size)
            .field("require_atomic", &self.require_atomic)
            .field("no_require_atomic", &self.no_require_atomic)
            .field("reap_schedule", &self.reap_schedule)
            .field("compact_schedule", &self.compact_schedule)
            .field("client_prune_schedule", &self.client_prune_schedule)
            .field("client_ttl_days", &self.client_ttl_days)
            .field("hlc_max_skew_ms", &self.hlc_max_skew_ms)
            .field("max_pull_scan", &self.max_pull_scan)
            .field("allow_no_cron", &self.allow_no_cron)
            .field("allow_no_rls", &self.allow_no_rls)
            .field("schema", &self.schema)
            .field("db_url", &redacted_db_url(self.db_url.as_ref()))
            .field("project_ref", &self.project_ref)
            .field("access_token", &redacted_secret(self.access_token.as_ref()))
            .field("dry_run", &self.dry_run)
            .field("yes", &self.yes)
            .field("local_only", &self.local_only)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum StatusFormat {
    /// One JSON object on stdout (same payload as --json)
    Json,
    /// Compact labelled lines on stderr, even on a TTY
    Text,
}

#[derive(Debug, Args)]
pub(crate) struct StatusArgs {
    /// Print one JSON object on stdout instead of the human report
    #[arg(long, conflicts_with = "quiet")]
    pub(crate) json: bool,
    /// Output shape: json (stdout, same as --json) or text (stderr, no Clack)
    #[arg(long, value_enum, value_name = "FORMAT", conflicts_with = "quiet")]
    pub(crate) format: Option<StatusFormat>,
    /// Print only the pack state on stdout (docker-cli -q)
    #[arg(short = 'q', long)]
    pub(crate) quiet: bool,
    #[command(flatten)]
    pub(crate) transport: TransportArgs,
}

#[derive(Debug, Args)]
pub(crate) struct DoctorArgs {
    /// Emit one JSON line per check and exit non-zero on any failure
    #[arg(long)]
    pub(crate) ci: bool,
    /// Project URL for the live Data API probe (else SUPABASE_URL and its NEXT_PUBLIC_/VITE_/EXPO_PUBLIC_/PUBLIC_ forms, the .env files, then the linked project)
    #[arg(long, value_name = "URL")]
    pub(crate) url: Option<String>,
    /// Publishable key for the live probe (else SUPABASE_PUBLISHABLE_KEY and its aliases, the .env files, then the linked project's Management API keys)
    #[arg(
        long = "publishable-key",
        visible_alias = "anon-key",
        value_name = "KEY"
    )]
    pub(crate) publishable_key: Option<String>,
    #[command(flatten)]
    pub(crate) transport: TransportArgs,
}

#[derive(Debug, Args)]
pub(crate) struct LintArgs {
    #[command(flatten)]
    pub(crate) transport: TransportArgs,
}

// A clap flag surface is a bag of switches; a state machine would only hide which flag the user typed.
#[expect(clippy::struct_excessive_bools)]
#[derive(Debug, Args)]
pub(crate) struct UpgradeArgs {
    /// Show the plan and change nothing
    #[arg(long)]
    pub(crate) dry_run: bool,
    /// Apply without asking (upgrade never prompts)
    #[arg(long)]
    pub(crate) yes: bool,
    /// Re-apply every pack file: restores dropped pack objects on an up-to-date project, and records this build's hash when the ledger records another one
    #[arg(long)]
    pub(crate) reapply: bool,
    /// Exit 0 when the job schedules cannot be applied after the upgrade, and run retention yourself
    #[arg(long)]
    pub(crate) allow_no_cron: bool,
    #[command(flatten)]
    pub(crate) transport: TransportArgs,
}

// A clap flag surface is a bag of switches; a state machine would only hide which flag the user typed.
#[expect(clippy::struct_excessive_bools)]
#[derive(Args)]
pub(crate) struct DeprovisionArgs {
    /// Show the plan and change nothing
    #[arg(long)]
    pub(crate) dry_run: bool,
    /// Apply the destructive plan (else KSYNC_ALLOW_DEPROVISION=1)
    #[arg(long)]
    pub(crate) yes: bool,
    /// Also drop the schema: every table, sequence, index, policy, and grant
    #[arg(long)]
    pub(crate) purge: bool,
    /// Type the project ref, or "local", to confirm --purge (--yes is not enough)
    #[arg(long, value_name = "TARGET")]
    pub(crate) confirm: Option<String>,
    /// Refused: the ledger lives in your project database
    #[arg(long)]
    pub(crate) local_only: bool,
    /// Postgres connection string (else KSYNC_DB_URL, DIRECT_URL, POSTGRES_URL_NON_POOLING, DATABASE_URL, POSTGRES_URL, supabase/config.toml)
    #[arg(long, value_name = "URL")]
    pub(crate) db_url: Option<String>,
}

impl fmt::Debug for DeprovisionArgs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeprovisionArgs")
            .field("dry_run", &self.dry_run)
            .field("yes", &self.yes)
            .field("purge", &self.purge)
            .field("confirm", &self.confirm)
            .field("local_only", &self.local_only)
            .field("db_url", &redacted_db_url(self.db_url.as_ref()))
            .finish()
    }
}

/// `jobs` reads and writes `cron.job` on a service connection, so it takes the
/// direct-Postgres transport only: the Management API's SQL endpoint is a
/// different privilege ladder, and the three jobs are an operator surface.
#[derive(Args)]
pub(crate) struct JobsArgs {
    /// Print one JSON object on stdout instead of the human report
    #[arg(long, global = true)]
    pub(crate) json: bool,
    /// Postgres connection string (else KSYNC_DB_URL, DIRECT_URL, POSTGRES_URL_NON_POOLING, DATABASE_URL, POSTGRES_URL, supabase/config.toml)
    #[arg(long, global = true, value_name = "URL")]
    pub(crate) db_url: Option<String>,
    #[command(subcommand)]
    pub(crate) command: JobsCommand,
}

impl fmt::Debug for JobsArgs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JobsArgs")
            .field("json", &self.json)
            .field("db_url", &redacted_db_url(self.db_url.as_ref()))
            .field("command", &self.command)
            .finish()
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum JobsCommand {
    /// Schedule, last run, and drift against kizunasync._settings
    List,
    /// Run a retention job now, over this connection
    Run(JobsRunArgs),
    /// Reschedule the three jobs from kizunasync._settings
    Schedule,
}

#[derive(Debug, Args)]
pub(crate) struct JobsRunArgs {
    /// Which job to run now
    #[arg(value_enum, value_name = "JOB")]
    pub(crate) job: JobArg,
}

/// The jobs `kizunasync jobs run` can call by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum JobArg {
    /// kizunasync.reap_tombstones()
    Reap,
    /// kizunasync.compact_changelog()
    Compact,
    /// kizunasync.prune_clients()
    Prune,
    /// All three, in that order
    All,
}

#[derive(Debug, Args)]
pub(crate) struct MockArgs {
    #[command(subcommand)]
    pub(crate) command: MockCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum MockCommand {
    /// Deterministic server-side datasets
    Seed(SeedArgs),
    /// Marker-scoped write churn for fencing and load testing
    Churn(ChurnArgs),
}

#[derive(Args)]
pub(crate) struct SeedArgs {
    /// Target table (else the lone table in kizunasync._config)
    #[arg(long, value_name = "NAME")]
    pub(crate) table: Option<String>,
    /// Rows to create across all users
    #[arg(long, default_value_t = 20)]
    pub(crate) rows: u64,
    /// Distinct owner ids to spread them across
    #[arg(long, default_value_t = 3)]
    pub(crate) users: u64,
    /// How many of those rows get an image_path
    #[arg(long, default_value_t = 0)]
    pub(crate) images: u64,
    /// PRNG seed, the same seed reproduces the same dataset
    #[arg(long, default_value_t = 1)]
    pub(crate) seed: u64,
    /// Delete every row this tool seeded, instead of writing more
    #[arg(long, conflicts_with_all = ["rows", "users", "images", "seed"])]
    pub(crate) clean: bool,
    /// Print the SQL and change nothing (needs no database when --table is given)
    #[arg(long)]
    pub(crate) dry_run: bool,
    /// Apply without asking (else KSYNC_ALLOW_MOCK_SEED=1)
    #[arg(long)]
    pub(crate) yes: bool,
    /// Postgres connection string (else KSYNC_DB_URL, DIRECT_URL, POSTGRES_URL_NON_POOLING, DATABASE_URL, POSTGRES_URL, supabase/config.toml)
    #[arg(long, value_name = "URL")]
    pub(crate) db_url: Option<String>,
}

impl fmt::Debug for SeedArgs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SeedArgs")
            .field("table", &self.table)
            .field("rows", &self.rows)
            .field("users", &self.users)
            .field("images", &self.images)
            .field("seed", &self.seed)
            .field("clean", &self.clean)
            .field("dry_run", &self.dry_run)
            .field("yes", &self.yes)
            .field("db_url", &redacted_db_url(self.db_url.as_ref()))
            .finish()
    }
}

#[derive(Args)]
pub(crate) struct ChurnArgs {
    /// Target table (else the lone table in kizunasync._config)
    #[arg(long, value_name = "NAME")]
    pub(crate) table: Option<String>,
    /// How many write statements to run
    #[arg(long, default_value_t = 25)]
    pub(crate) iterations: u64,
    /// Milliseconds between writes; 0 disables pacing
    #[arg(long, default_value_t = 200)]
    pub(crate) interval_ms: u64,
    /// PRNG seed, the same seed reproduces the same plan
    #[arg(long, default_value_t = 1)]
    pub(crate) seed: u64,
    /// Print the statements and change nothing (needs no database when --table is given)
    #[arg(long)]
    pub(crate) dry_run: bool,
    /// Apply without asking (else KSYNC_ALLOW_MOCK_SEED=1)
    #[arg(long)]
    pub(crate) yes: bool,
    /// Postgres connection string (else KSYNC_DB_URL, DIRECT_URL, POSTGRES_URL_NON_POOLING, DATABASE_URL, POSTGRES_URL, supabase/config.toml)
    #[arg(long, value_name = "URL")]
    pub(crate) db_url: Option<String>,
}

impl fmt::Debug for ChurnArgs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChurnArgs")
            .field("table", &self.table)
            .field("iterations", &self.iterations)
            .field("interval_ms", &self.interval_ms)
            .field("seed", &self.seed)
            .field("dry_run", &self.dry_run)
            .field("yes", &self.yes)
            .field("db_url", &redacted_db_url(self.db_url.as_ref()))
            .finish()
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn manual_debug_impls_never_print_a_db_url_password_or_an_access_token() {
        let transport = TransportArgs {
            db_url: Some("postgresql://postgres:hunter2@127.0.0.1:54322/postgres".to_owned()),
            project_ref: None,
            access_token: Some("sbp_0123456789abcdef0123456789abcdef01234567".to_owned()),
        };
        let rendered = format!("{transport:?}");

        assert!(!rendered.contains("hunter2"), "{rendered}");
        assert!(!rendered.contains("sbp_0123456789abcdef"), "{rendered}");
        assert!(rendered.contains("127.0.0.1:54322"), "{rendered}");
        assert!(
            rendered.contains("access_token: Some(\"***\")"),
            "{rendered}"
        );
    }

    #[test]
    fn a_db_url_only_struct_redacts_it_too() {
        let deprovision = DeprovisionArgs {
            dry_run: false,
            yes: false,
            purge: false,
            confirm: None,
            local_only: false,
            db_url: Some("postgresql://postgres:hunter2@127.0.0.1:54322/postgres".to_owned()),
        };

        assert!(!format!("{deprovision:?}").contains("hunter2"));
    }
}
