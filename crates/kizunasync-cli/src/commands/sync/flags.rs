use crate::catalog::SchemaSource;
use crate::commands::init::DirectConnection;
use crate::config::{DEFAULT_MIN_SCHEMA_VERSION, MaxBatchSize, ProjectSettings};
use crate::config_sql::DeclaredTableConfig;
use crate::cron;
use crate::db::is_valid_schema_name;
use crate::project_ref::ProjectRef;
use crate::prompts::Prompter;
use crate::proposals::{Bucket, BucketAnswer, ConflictMode, SyncMode, TableProposal};
use crate::supabase_cli::SupabaseCli;
use crate::token::TokenStore;

// MARK: - flags and ports

/// The contract an added table is provisioned with. Every field is what the
/// wizard would have asked for; an unset one keeps the inference a bare
/// proposal carries (`pull-only`, no bucket, arrival conflict, no journal, no
/// client registry, no soft-delete column, the documented schema version, and
/// the project's own retention).
#[derive(Debug, Clone, Default)]
pub struct TableOptions {
    /// `--sync`: the sync mode.
    pub sync: Option<SyncMode>,
    /// `--bucket-column`: the column rows are scoped by.
    pub bucket_column: Option<String>,
    /// `--soft-delete`: the soft-delete column.
    pub soft_delete: Option<String>,
    /// `--conflict`: the conflict resolution mode.
    pub conflict: Option<ConflictMode>,
    /// `--conflict-journal`: record overwritten same-column values server-side.
    pub conflict_journal: bool,
    /// `--register-clients` / `--no-register-clients`: whether the pack records
    /// one `kizunasync._clients` row per client that syncs this table.
    pub register_clients: Option<bool>,
    /// `--min-schema-version`: the lowest client schema version the contract is
    /// valid for.
    pub min_schema_version: Option<i64>,
    /// `--tombstone-ttl-days`: retention in days; absent inherits the project's.
    pub tombstone_ttl_days: Option<i64>,
}

impl TableOptions {
    /// Apply the answers to a bare proposal. A named bucket column is an
    /// answered `byColumn` bucket: a flag-driven add has no RLS read behind it,
    /// so there is no owner to infer one from.
    #[must_use]
    pub fn apply(&self, proposal: TableProposal) -> TableProposal {
        TableProposal {
            sync: self.sync.or(proposal.sync),
            bucket: match &self.bucket_column {
                Some(column) => BucketAnswer::Answered(Bucket::ByColumn(column.clone())),
                None => proposal.bucket,
            },
            conflict: self.conflict.or(proposal.conflict),
            conflict_journal: self.conflict_journal || proposal.conflict_journal,
            register_clients: self.register_clients.unwrap_or(proposal.register_clients),
            min_schema_version: self.min_schema_version.or(proposal.min_schema_version),
            tombstone_ttl_days: self.tombstone_ttl_days.or(proposal.tombstone_ttl_days),
            soft_delete: self.soft_delete.clone().or(proposal.soft_delete),
            ..proposal
        }
    }

    /// The `kizunasync._config` columns these flags name, and no others: what
    /// an already-synced table's row is updated with.
    #[must_use]
    pub fn declared(&self) -> DeclaredTableConfig {
        DeclaredTableConfig {
            sync: self.sync,
            bucket_column: self.bucket_column.clone(),
            soft_delete_column: self.soft_delete.clone(),
            conflict: self.conflict,
            // A switch is named only by being passed, so leaving the journal
            // off needs no flag and writes no column.
            conflict_journal: self.conflict_journal.then_some(true),
            register_clients: self.register_clients,
            min_schema_version: self.min_schema_version,
            tombstone_ttl_days: self.tombstone_ttl_days,
            // No flag names a key: a run re-records one only when the table's
            // primary key moved.
            key_columns: None,
        }
    }

    /// Whether any per-table answer was given, which tells "add it as it comes"
    /// from "add it like this".
    #[must_use]
    pub fn is_any_set(&self) -> bool {
        self.sync.is_some()
            || self.bucket_column.is_some()
            || self.soft_delete.is_some()
            || self.conflict.is_some()
            || self.conflict_journal
            || self.register_clients.is_some()
            || self.min_schema_version.is_some()
            || self.tombstone_ttl_days.is_some()
    }

    /// A retention below a day reaps a tombstone before any client can pull it,
    /// and a schema version below the first one no client can ever satisfy.
    #[must_use]
    pub fn refuse_out_of_range(&self) -> Option<String> {
        if let Some(days) = self
            .tombstone_ttl_days
            .filter(|days| *days < MIN_TOMBSTONE_TTL_DAYS)
        {
            return Some(format!(
                "--tombstone-ttl-days {days} is out of range: at least {MIN_TOMBSTONE_TTL_DAYS} day."
            ));
        }
        let version = self
            .min_schema_version
            .filter(|version| *version < DEFAULT_MIN_SCHEMA_VERSION)?;

        Some(format!(
            "--min-schema-version {version} is out of range: at least {DEFAULT_MIN_SCHEMA_VERSION}."
        ))
    }

    /// `--bucket-column`/`--soft-delete` name a column of the synced table, so
    /// each must be a valid Postgres identifier like every other name this CLI
    /// writes into generated SQL; a flag-driven `sync --add` never introspects
    /// the table to catch a bad one some other way.
    #[must_use]
    pub fn refuse_invalid_identifiers(&self) -> Option<String> {
        for (flag, value) in [
            ("--bucket-column", &self.bucket_column),
            ("--soft-delete", &self.soft_delete),
        ] {
            if let Some(name) = value.as_deref()
                && !is_valid_schema_name(name)
            {
                return Some(format!(
                    "{flag} {name:?} is not a valid Postgres identifier."
                ));
            }
        }

        None
    }

    /// Whether every per-table answer was given, which leaves the wizard with
    /// nothing left to ask about an added table. `--conflict-journal` is a
    /// switch, so "answered" means it was passed: leaving the journal off is
    /// the default and needs no flag, and a run that wants to be asked omits
    /// one of the other seven.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.sync.is_some()
            && self.bucket_column.is_some()
            && self.soft_delete.is_some()
            && self.conflict.is_some()
            && self.conflict_journal
            && self.register_clients.is_some()
            && self.min_schema_version.is_some()
            && self.tombstone_ttl_days.is_some()
    }
}

/// The project settings a run asks for, one column at a time. A flag that was
/// not named leaves that column exactly as the project already has it, so
/// tightening one guard never quietly relaxes the other; `--no-max-batch-size`
/// and `--no-require-atomic` are how a run says permissive on purpose.
#[derive(Debug, Clone, Default)]
pub struct SettingsOptions {
    /// `--max-batch-size`: the largest push accepted.
    pub max_batch_size: Option<i64>,
    /// `--no-max-batch-size`: accept a push of any size.
    pub no_max_batch_size: bool,
    /// `--require-atomic`: reject a non-atomic push.
    pub require_atomic: bool,
    /// `--no-require-atomic`: accept a non-atomic push.
    pub no_require_atomic: bool,
    /// `--reap-schedule`: when `kizunasync.reap_tombstones()` runs (UTC).
    pub reap_schedule: Option<String>,
    /// `--compact-schedule`: when `kizunasync.compact_changelog()` runs (UTC).
    pub compact_schedule: Option<String>,
    /// `--client-prune-schedule`: when `kizunasync.prune_clients()` runs (UTC).
    pub client_prune_schedule: Option<String>,
    /// `--client-ttl-days`: days of silence after which a client row is stale.
    pub client_ttl_days: Option<i64>,
    /// `--hlc-max-skew-ms`: forward-drift tolerance for an origin HLC.
    pub hlc_max_skew_ms: Option<i64>,
    /// `--tombstone-ttl-days` on `init`: the project-wide retention a table
    /// with no value of its own inherits.
    pub tombstone_ttl_days: Option<i64>,
    /// `--max-pull-scan`: candidates one pull page examines at most.
    pub max_pull_scan: Option<i64>,
}

impl SettingsOptions {
    /// The columns this run declares. An undeclared column is absent, which is
    /// what keeps the emitted `update` from naming it at all.
    #[must_use]
    pub fn declared(&self) -> ProjectSettings {
        ProjectSettings {
            max_batch_size: self.declared_max_batch_size(),
            require_atomic: self.declared_require_atomic(),
            reap_schedule: self.reap_schedule.clone(),
            compact_schedule: self.compact_schedule.clone(),
            client_prune_schedule: self.client_prune_schedule.clone(),
            client_ttl_days: self.client_ttl_days,
            hlc_max_skew_ms: self.hlc_max_skew_ms,
            tombstone_ttl_days: self.tombstone_ttl_days,
            max_pull_scan: self.max_pull_scan,
        }
    }

    /// The flags that declare exactly `settings`: the inverse of
    /// [`Self::declared`], so a wizard's answer runs through the same path a
    /// scripted `kizunasync sync` takes.
    #[must_use]
    pub fn from_declared(settings: &ProjectSettings) -> Self {
        Self {
            max_batch_size: settings.max_batch_size.and_then(MaxBatchSize::mutations),
            no_max_batch_size: settings.max_batch_size == Some(MaxBatchSize::Unlimited),
            require_atomic: settings.require_atomic == Some(true),
            no_require_atomic: settings.require_atomic == Some(false),
            reap_schedule: settings.reap_schedule.clone(),
            compact_schedule: settings.compact_schedule.clone(),
            client_prune_schedule: settings.client_prune_schedule.clone(),
            client_ttl_days: settings.client_ttl_days,
            hlc_max_skew_ms: settings.hlc_max_skew_ms,
            tombstone_ttl_days: settings.tombstone_ttl_days,
            max_pull_scan: settings.max_pull_scan,
        }
    }

    /// The `kizunasync sync` flags that declare these settings, one argument
    /// per element. The project tombstone retention has no `sync` flag, so it
    /// is left out.
    #[must_use]
    pub fn to_sync_args(&self) -> Vec<String> {
        let valued = [
            (
                "--max-batch-size",
                self.max_batch_size.map(|size| size.to_string()),
            ),
            ("--reap-schedule", self.reap_schedule.clone()),
            ("--compact-schedule", self.compact_schedule.clone()),
            (
                "--client-prune-schedule",
                self.client_prune_schedule.clone(),
            ),
            (
                "--client-ttl-days",
                self.client_ttl_days.map(|days| days.to_string()),
            ),
            (
                "--hlc-max-skew-ms",
                self.hlc_max_skew_ms.map(|millis| millis.to_string()),
            ),
            (
                "--max-pull-scan",
                self.max_pull_scan.map(|scan| scan.to_string()),
            ),
        ];
        let switches = [
            ("--no-max-batch-size", self.no_max_batch_size),
            ("--require-atomic", self.require_atomic),
            ("--no-require-atomic", self.no_require_atomic),
        ];

        switches
            .into_iter()
            .filter(|(_, on)| *on)
            .map(|(flag, _)| vec![flag.to_owned()])
            .chain(
                valued
                    .into_iter()
                    .filter_map(|(flag, value)| Some(vec![flag.to_owned(), value?])),
            )
            .flatten()
            .collect()
    }

    fn declared_max_batch_size(&self) -> Option<MaxBatchSize> {
        if self.no_max_batch_size {
            return Some(MaxBatchSize::Unlimited);
        }

        self.max_batch_size.map(MaxBatchSize::Mutations)
    }

    const fn declared_require_atomic(&self) -> Option<bool> {
        if self.require_atomic {
            return Some(true);
        }
        if self.no_require_atomic {
            return Some(false);
        }

        None
    }

    /// Whether any settings flag was given.
    #[must_use]
    pub fn is_any_set(&self) -> bool {
        self.declared().is_any_set()
    }

    /// The bound on `--max-batch-size` alone: how to ask for unlimited differs
    /// by command, so each caller appends its own way out.
    #[must_use]
    pub fn refuse_max_batch_size(&self) -> Option<String> {
        let size = self.max_batch_size.filter(|size| *size < MIN_BATCH_SIZE)?;

        Some(format!(
            "--max-batch-size {size} is out of range: at least {MIN_BATCH_SIZE} mutation per push."
        ))
    }

    /// `--require-atomic` is refused: ordinary un-batched writes send
    /// `atomic: false`, and `KZP03` would dead-letter them.
    #[must_use]
    pub fn refuse_require_atomic(&self) -> Option<String> {
        self.require_atomic.then(|| {
            "the current client sends non-atomic pushes for un-batched mutations; enabling require_atomic would dead-letter every ordinary write. Not supported in this release."
                .to_owned()
        })
    }

    /// Every other knob, judged the way the pack's own constraints judge it: a
    /// value the server would refuse is answered here rather than at
    /// `supabase db push` with a file already written.
    #[must_use]
    pub fn refuse_out_of_range(&self) -> Option<String> {
        for (flag, schedule) in [
            ("--reap-schedule", self.reap_schedule.as_deref()),
            ("--compact-schedule", self.compact_schedule.as_deref()),
            (
                "--client-prune-schedule",
                self.client_prune_schedule.as_deref(),
            ),
        ] {
            if let Some(schedule) = schedule.filter(|value| !cron::is_cron_schedule(value)) {
                return Some(cron::refusal(flag, schedule));
            }
        }
        if let Some(days) = self
            .client_ttl_days
            .filter(|days| *days < MIN_CLIENT_TTL_DAYS)
        {
            return Some(format!(
                "--client-ttl-days {days} is out of range: at least {MIN_CLIENT_TTL_DAYS} day."
            ));
        }
        if let Some(skew) = self.hlc_max_skew_ms.filter(|skew| *skew < 0) {
            return Some(format!(
                "--hlc-max-skew-ms {skew} is out of range: milliseconds cannot be negative."
            ));
        }
        if let Some(scan) = self.max_pull_scan.filter(|scan| *scan < MIN_PULL_SCAN) {
            return Some(format!(
                "--max-pull-scan {scan} is out of range: at least {MIN_PULL_SCAN} candidate."
            ));
        }
        let days = self
            .tombstone_ttl_days
            .filter(|days| *days < MIN_TOMBSTONE_TTL_DAYS)?;

        Some(format!(
            "--tombstone-ttl-days {days} is out of range: at least {MIN_TOMBSTONE_TTL_DAYS} day."
        ))
    }
}

/// The smallest push the pack's own check constraint accepts.
const MIN_BATCH_SIZE: i64 = 1;

/// The shortest retention worth writing: zero would reap a tombstone the moment
/// it is written, which resurrects rows on the next pull.
const MIN_TOMBSTONE_TTL_DAYS: i64 = 1;

/// The pack's own bound: a client cannot be stale before the day it registered.
const MIN_CLIENT_TTL_DAYS: i64 = 1;

/// The pack's own bound: a pull page examines at least one candidate.
const MIN_PULL_SCAN: i64 = 1;

/// What `kizunasync sync` was asked to do. Not `Debug`: a settled
/// [`DirectConnection`] carries the password.
// A flag surface is a bag of switches; a state machine would only hide which
// flag the user typed.
#[expect(clippy::struct_excessive_bools)]
#[derive(Clone, Default)]
pub struct SyncFlags {
    /// Tables to start syncing (repeatable).
    pub add: Vec<String>,
    /// Tables to stop syncing (repeatable).
    pub remove: Vec<String>,
    /// The contract every added table is provisioned with.
    pub options: TableOptions,
    /// The project settings the run asks for.
    pub settings: SettingsOptions,
    /// The schema the interactive surface introspects.
    pub schema: String,
    /// An explicit connection string.
    pub db_url: Option<String>,
    /// A direct connection another flow already settled, the bare `kizunasync`
    /// hand-off; consulted before any flag or discovery; never a CLI flag.
    pub connection: Option<DirectConnection>,
    /// Drive the Supabase Management API against this project instead.
    pub project_ref: Option<ProjectRef>,
    /// PAT for `--project-ref`.
    pub access_token: Option<String>,
    /// Write a declared schedule even when pg_cron is absent to run it.
    pub allow_no_cron: bool,
    /// Sync an added table whose row level security is disabled.
    pub allow_no_rls: bool,
    /// Print the plan and the SQL; write nothing.
    pub dry_run: bool,
    /// Write without asking.
    pub yes: bool,
    /// Write the migration but do not apply it.
    pub local_only: bool,
}

/// Everything `sync` reaches the outside world through, so every path is
/// reachable from a test with neither a terminal nor a database.
pub struct SyncPorts<'a> {
    /// The wizard. `None` when this session has no terminal, which makes the
    /// flag path the only path.
    pub prompter: Option<&'a mut dyn Prompter>,
    /// The live reads: the synced set this project already carries, and the
    /// catalog the wizard proposes from.
    pub schemas: &'a dyn SchemaSource,
    /// The Supabase CLI: `supabase db push` applies the emitted migration and
    /// `supabase migration repair` settles the history before it is written.
    /// Spawns the real binary in production.
    pub supabase: &'a dyn SupabaseCli,
    /// The instant the migration is named after, in UTC epoch seconds.
    pub now_unix: i64,
    /// The OS credential store a linked project's token is read from, only
    /// once the user has picked that candidate.
    pub tokens: &'a dyn TokenStore,
    /// Opens a direct connection to the linked project, given its ref and the
    /// token when one resolved.
    pub linked: &'a LinkedConnector<'a>,
}

/// The shape of [`SyncPorts::linked`]: production mints a login over the
/// Management API ([`linked_connection`](crate::login_role::linked_connection)),
/// a test answers without a socket.
pub type LinkedConnector<'a> = dyn Fn(&ProjectRef, Option<&str>) -> crate::error::Result<crate::login_role::LinkedConnection>
    + 'a;

/// What an empty masked entry prints here.
pub const NO_CONNECTION_ENTERED: &str =
    "  no connection string provided: cannot read the synced tables. Aborting.";
