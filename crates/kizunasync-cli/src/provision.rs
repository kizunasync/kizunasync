//! The transport-independent provisioning core.
//!
//! Plan what the pack would install, apply a fresh install in one transaction,
//! and read back what the ledger records. Everything here talks to one narrow
//! port ([`Applier`]), so the Management API caller and the direct-Postgres
//! caller drive identical logic.
//!
//! Idempotency is decided against `kizunasync._provisions`, never against local
//! files: an empty ledger is a fresh install, a fully-matching ledger is a
//! no-op, and anything in between is drift, which this core never applies over.
//! A file the ledger does not record yet is `upgrade`'s to apply. A file whose
//! recorded hash differs is this build's pack differing from the installed
//! one: the caller offers to run the whole pack again and record its hash (the
//! `init` wizard, `upgrade --reapply`) or refuses. No path applies part of a
//! pack.
//!
//! Content-hash divergence, deliberate: the pack's own ledger seed hashes each
//! provisioned OBJECT name, not the file, and records no per-file row. That
//! input is not reproducible from a pack file's content, so the planner hashes
//! the full file SQL instead.

use md5::{Digest, Md5};

use crate::applier::Applier;
use crate::constants::{INTERNAL_PROVISIONS, SCHEMA};
use crate::error::{Error, Result};
use crate::pack::PackFile;
use crate::row::{Row, require_bool, require_number, require_string};
use crate::version::Version;

/// The ledger's `object_kind` for a per-file accounting row.
pub const PACK_FILE_KIND: &str = "pack-file";

/// Semver token written into a pack-file row's `pack_version` column: this
/// CLI's version.
pub const PACK_FILE_VERSION: &str = crate::VERSION;

/// The RPCs a client actually calls: what `ProvisionedUnversioned` is allowed
/// to claim.
pub const CORE_RPCS: [&str; 2] = ["pull", "push"];

/// A ledger row as read back through the port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerRow {
    /// `object_kind`.
    pub object_kind: String,
    /// `object_name`.
    pub object_name: String,
    /// `content_hash`.
    pub content_hash: String,
    /// `pack_version`: the build that wrote the row.
    pub pack_version: String,
}

/// One planned pack file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanFile {
    /// Pack filename.
    pub name: String,
    /// The file's full SQL.
    pub sql: String,
    /// md5 of the full file SQL.
    pub content_hash: String,
}

/// Why a file offends the plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriftReason {
    /// The ledger holds no row for this file.
    NotRecorded,
    /// The ledger's recorded hash differs from the file's.
    HashMismatch,
}

impl std::fmt::Display for DriftReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotRecorded => "not-recorded",
            Self::HashMismatch => "hash-mismatch",
        })
    }
}

/// A file the plan refuses to move past.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Drift {
    /// The offending pack file.
    pub name: String,
    /// Why it offends.
    pub reason: DriftReason,
    /// What the ledger holds for it; absent when nothing is recorded.
    pub recorded_hash: Option<String>,
}

/// What the pack and the ledger, together, say should happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Empty ledger: a fresh install.
    Apply {
        /// Every pack file, in name order.
        files: Vec<PlanFile>,
    },
    /// Every pack file is recorded with a matching hash.
    UpToDate {
        /// Every pack file, in name order.
        files: Vec<PlanFile>,
    },
    /// The project is provisioned, but by a pack that ledgered objects rather
    /// than files, so there is nothing to compare a hash against.
    ProvisionedUnversioned {
        /// Every pack file, in name order.
        files: Vec<PlanFile>,
        /// How many rows the ledger holds.
        recorded_objects: usize,
    },
    /// A partial or mismatched ledger, naming its offending files.
    Drift {
        /// Every pack file, in name order.
        files: Vec<PlanFile>,
        /// The files that offend.
        offending: Vec<Drift>,
    },
}

impl Plan {
    /// The hash-mismatch offenders of a `Drift` plan, in name order; empty for
    /// every other plan and for a drift that only lacks rows.
    #[must_use]
    pub fn hash_mismatches(&self) -> Vec<&Drift> {
        match self {
            Self::Drift { offending, .. } => offending
                .iter()
                .filter(|offender| offender.reason == DriftReason::HashMismatch)
                .collect(),
            Self::Apply { .. } | Self::UpToDate { .. } | Self::ProvisionedUnversioned { .. } => {
                Vec::new()
            }
        }
    }

    /// Every pack file, in name order, whatever the state.
    #[must_use]
    pub fn files(&self) -> &[PlanFile] {
        match self {
            Self::Apply { files }
            | Self::UpToDate { files }
            | Self::ProvisionedUnversioned { files, .. }
            | Self::Drift { files, .. } => files,
        }
    }

    /// What the ledger recorded for each pack file when this plan was read, in
    /// name order: the hash its `pack-file` row carried, or `None` when it had
    /// no row.
    #[must_use]
    pub fn recorded_hashes(&self) -> Vec<(&str, Option<&str>)> {
        match self {
            Self::Apply { files } | Self::ProvisionedUnversioned { files, .. } => files
                .iter()
                .map(|file| (file.name.as_str(), None))
                .collect(),
            Self::UpToDate { files } => files
                .iter()
                .map(|file| (file.name.as_str(), Some(file.content_hash.as_str())))
                .collect(),
            Self::Drift { files, offending } => files
                .iter()
                .map(|file| {
                    let recorded = offending
                        .iter()
                        .find(|offender| offender.name == file.name)
                        .map_or(Some(file.content_hash.as_str()), |offender| {
                            offender.recorded_hash.as_deref()
                        });

                    (file.name.as_str(), recorded)
                })
                .collect(),
        }
    }
}

/// Pure: pack files + ledger rows in, plan out.
#[must_use]
pub fn plan_provision(pack_files: &[PackFile], ledger_rows: &[LedgerRow]) -> Plan {
    let mut files: Vec<PlanFile> = pack_files
        .iter()
        .map(|file| PlanFile {
            name: file.name.clone(),
            sql: file.sql.clone(),
            content_hash: hash_pack_file(&file.sql),
        })
        .collect();
    files.sort_by(|a, b| a.name.cmp(&b.name));

    if ledger_rows.is_empty() {
        return Plan::Apply { files };
    }

    // `object_kind` is the load-bearing discriminator: an object row can carry
    // a name that happens to look like a pack file name, so only rows recorded
    // as `pack-file` are eligible to match.
    let recorded: std::collections::BTreeMap<&str, &str> = ledger_rows
        .iter()
        .filter(|row| row.object_kind == PACK_FILE_KIND)
        .map(|row| (row.object_name.as_str(), row.content_hash.as_str()))
        .collect();

    if !files
        .iter()
        .any(|file| recorded.contains_key(file.name.as_str()))
    {
        return Plan::ProvisionedUnversioned {
            files,
            recorded_objects: ledger_rows.len(),
        };
    }

    let mut offending = Vec::new();
    for file in &files {
        match recorded.get(file.name.as_str()) {
            None => offending.push(Drift {
                name: file.name.clone(),
                reason: DriftReason::NotRecorded,
                recorded_hash: None,
            }),
            Some(hash) if *hash != file.content_hash => offending.push(Drift {
                name: file.name.clone(),
                reason: DriftReason::HashMismatch,
                recorded_hash: Some((*hash).to_owned()),
            }),
            Some(_) => {}
        }
    }
    if offending.is_empty() {
        return Plan::UpToDate { files };
    }

    Plan::Drift { files, offending }
}

/// Why a recorded pack file stops this build from reconciling the ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AheadReason {
    /// A newer build recorded it.
    Newer,
    /// This build's pack does not ship it.
    NotShipped,
    /// Its `pack_version` is not a version this build can order.
    Unreadable,
}

/// A `pack-file` row that belongs to a pack this build cannot reconcile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerAhead {
    /// The recorded pack file.
    pub name: String,
    /// The `pack_version` its row carries.
    pub pack_version: String,
    /// Why it stops the run.
    pub reason: AheadReason,
}

/// The `pack-file` rows a newer pack left: recorded by a build newer than
/// `binary_version`, naming a file `files` does not ship, or carrying a version
/// that cannot be ordered. Reconciling over any of them would put this build's
/// pack over one it does not know.
#[must_use]
pub fn ledger_ahead(
    files: &[PlanFile],
    rows: &[LedgerRow],
    binary_version: &str,
) -> Vec<LedgerAhead> {
    let binary = Version::parse(binary_version);

    rows.iter()
        .filter(|row| row.object_kind == PACK_FILE_KIND)
        .filter_map(|row| {
            let reason = if !files.iter().any(|file| file.name == row.object_name) {
                AheadReason::NotShipped
            } else if row.pack_version == binary_version {
                return None;
            } else {
                match (Version::parse(&row.pack_version), &binary) {
                    (Some(recorded), Some(binary)) if recorded > *binary => AheadReason::Newer,
                    (Some(_), Some(_)) => return None,
                    _ => AheadReason::Unreadable,
                }
            };

            Some(LedgerAhead {
                name: row.object_name.clone(),
                pack_version: row.pack_version.clone(),
                reason,
            })
        })
        .collect()
}

/// The `pack-file` rows a build newer than `binary_version` recorded. Unlike
/// [`ledger_ahead`], which `upgrade` and the re-apply offer run, this needs no
/// pack on disk, so `init`, `sync`, and `deprovision` check it before they
/// write, and `status` and `doctor` report it.
#[must_use]
pub fn ledger_newer(rows: &[LedgerRow], binary_version: &str) -> Vec<LedgerAhead> {
    let Some(binary) = Version::parse(binary_version) else {
        return Vec::new();
    };

    rows.iter()
        .filter(|row| row.object_kind == PACK_FILE_KIND)
        .filter(|row| Version::parse(&row.pack_version).is_some_and(|recorded| recorded > binary))
        .map(|row| LedgerAhead {
            name: row.object_name.clone(),
            pack_version: row.pack_version.clone(),
            reason: AheadReason::Newer,
        })
        .collect()
}

/// The refusal `upgrade` and the wizard's re-apply print over
/// [`ledger_ahead`]'s rows: which rows, why, and that nothing ran.
#[must_use]
pub fn describe_ledger_ahead(ahead: &[LedgerAhead], binary_version: &str) -> String {
    let lines: Vec<String> = ahead
        .iter()
        .map(|row| {
            let why = match row.reason {
                AheadReason::Newer => format!(
                    "recorded by kizunasync {}, newer than this build",
                    row.pack_version
                ),
                AheadReason::NotShipped => format!(
                    "recorded by kizunasync {}, not in this build's pack",
                    row.pack_version
                ),
                AheadReason::Unreadable => format!(
                    "recorded pack_version {:?} is not a version this build can compare",
                    row.pack_version
                ),
            };

            format!("    ! {}: {why}", row.name)
        })
        .collect();

    format!(
        "  refusing: the ledger records a pack this kizunasync ({binary_version}) cannot reconcile:\n{}\n  nothing was applied: update kizunasync to the build that provisioned this project or a newer one, then run this again.",
        lines.join("\n")
    )
}

/// md5 of a pack file's full SQL: the ledger's `content_hash` algorithm, fixed
/// by the shipped pack.
#[must_use]
pub fn hash_pack_file(sql: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(sql.as_bytes());

    hex::encode(hasher.finalize())
}

/// The per-file ledger row insert for one pack file. `on conflict … do nothing`
/// makes it safe to re-emit (a concurrent adopt/apply of the same file is a
/// no-op, never a duplicate row).
#[must_use]
pub fn render_pack_file_ledger_sql(name: &str, content_hash: &str) -> String {
    let name = escape_literal(name);
    let hash = escape_literal(content_hash);

    format!(
        "insert into {SCHEMA}.{INTERNAL_PROVISIONS} (object_kind, object_name, content_hash, pack_version) \
         values ('{PACK_FILE_KIND}', '{name}', '{hash}', '{PACK_FILE_VERSION}') \
         on conflict (object_kind, object_name) do nothing;"
    )
}

/// Records the hash of a pack file that was just re-applied, replacing the one
/// a previous build left: the same insert as [`render_pack_file_ledger_sql`],
/// but a conflict updates the row instead of keeping it.
#[must_use]
pub fn render_pack_file_ledger_upsert_sql(name: &str, content_hash: &str) -> String {
    let name = escape_literal(name);
    let hash = escape_literal(content_hash);

    format!(
        "insert into {SCHEMA}.{INTERNAL_PROVISIONS} (object_kind, object_name, content_hash, pack_version) \
         values ('{PACK_FILE_KIND}', '{name}', '{hash}', '{PACK_FILE_VERSION}') \
         on conflict (object_kind, object_name) do update set content_hash = excluded.content_hash, pack_version = excluded.pack_version;"
    )
}

/// Every pack file re-applied, each followed by the upsert that records its
/// hash, inside one `begin` … `commit` that opens with
/// [`render_ledger_guard`].
///
/// The transport opens a connection per call, so the batch has to be one
/// script: a `begin` and a `commit` sent as separate statements would run on
/// two different connections, and so would a lock taken by its own call.
#[must_use]
pub fn render_reconcile(plan: &Plan) -> String {
    let blocks: Vec<String> = plan
        .files()
        .iter()
        .map(|file| {
            format!(
                "\n-- {}\n{}\n{}\n",
                file.name,
                file.sql.trim_end(),
                render_pack_file_ledger_upsert_sql(&file.name, &file.content_hash)
            )
        })
        .collect();

    format!(
        "{RECONCILE_HEADER}begin;\n{}{}\ncommit;\n",
        render_ledger_guard(plan),
        blocks.concat()
    )
}

const RECONCILE_HEADER: &str = "-- Generated by kizunasync: every pack file re-applied and its ledger hash recorded,\n\
     -- in one transaction: a failure rolls the whole batch back.\n";

/// The transaction-scoped advisory lock every provisioning script takes first,
/// so two runs against one database apply one after the other. The key is the
/// two-integer form the pack's change stamp uses (`1264210777` is ASCII
/// `KZSY`), with its own second half so provisioning never waits on a stamp.
pub const PROVISION_LOCK_SQL: &str = "select pg_advisory_xact_lock(1264210777, 2);";

/// The statements a provisioning script opens with, right after `begin`: the
/// provisioning lock, then a check that the ledger still records, for every
/// pack file, the hash `plan` read (or still has no row where it had none).
/// Another run that changed the ledger in between makes it raise, and the
/// whole transaction rolls back.
#[must_use]
pub fn render_ledger_guard(plan: &Plan) -> String {
    let recorded = plan.recorded_hashes();
    if recorded.is_empty() {
        return format!("{PROVISION_LOCK_SQL}\n");
    }

    let conditions: Vec<String> = recorded
        .iter()
        .map(|(name, hash)| {
            format!(
                "(select content_hash from {SCHEMA}.{INTERNAL_PROVISIONS} where object_kind = '{PACK_FILE_KIND}' and object_name = {}) is distinct from {}",
                sql_text(name),
                hash.map_or_else(|| "null".to_owned(), sql_text)
            )
        })
        .collect();

    format!(
        "{PROVISION_LOCK_SQL}\n\
         do $$\n\
         begin\n\
         \x20 if {}\n\
         \x20 then\n\
         \x20   raise exception 'kizunasync: the provision ledger changed after this run read it'\n\
         \x20     using hint = 'Nothing was applied. Run the command again to plan against the ledger as it is now.';\n\
         \x20 end if;\n\
         end $$;\n",
        conditions.join("\n    or ")
    )
}

/// A text literal that stays inert inside `do $$ … $$`: quotes are doubled,
/// and a `$`, which could close the dollar quoting around it, is spelled
/// `chr(36)` outside the literal.
fn sql_text(value: &str) -> String {
    let quoted = format!("'{}'", escape_literal(value));
    if !value.contains('$') {
        return quoted;
    }

    format!("({})", quoted.replace('$', "' || chr(36) || '"))
}

/// Run [`render_reconcile`] as one script.
///
/// # Errors
/// Returns [`Error::Sql`] with the SQLSTATE when the database refused a
/// statement of the batch, and [`Error::Provision`] for any other failure of
/// the transport. Either message says the batch ran inside one transaction, so
/// nothing was applied and the ledger is unchanged.
pub fn reconcile_pack(plan: &Plan, applier: &dyn Applier) -> Result<()> {
    applier
        .run_script(&render_reconcile(plan))
        .map_err(|cause| {
            let text = format!(
                "re-applying the pack failed: {cause}; the batch ran inside one transaction, so nothing was applied and the ledger is unchanged"
            );
            let Error::Sql { sqlstate, .. } = cause else {
                return Error::Provision(text);
            };

            Error::Sql { sqlstate, text }
        })
}

fn escape_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// A fresh install as one script: the provisioning lock and a check that the
/// ledger is still empty, every pack file followed by its ledger row, then
/// `config_sql`, all inside one `begin` … `commit`. A failure anywhere leaves
/// the project exactly as it was: no pack object, no ledger row, no config
/// row. Sent as one script for the reason [`render_reconcile`] gives.
#[must_use]
pub fn render_install(plan: &Plan, config_sql: &str) -> String {
    let blocks: Vec<String> = plan
        .files()
        .iter()
        .map(|file| {
            format!(
                "\n-- {}\n{}\n{}\n",
                file.name,
                file.sql.trim_end(),
                render_pack_file_ledger_sql(&file.name, &file.content_hash)
            )
        })
        .collect();

    format!(
        "{INSTALL_HEADER}begin;\n{}{}\n{}\ncommit;\n",
        render_empty_ledger_guard(),
        blocks.concat(),
        config_sql.trim_end()
    )
}

const INSTALL_HEADER: &str = "-- Generated by kizunasync: a fresh install, every pack file with its ledger row and\n\
     -- then the project config, in one transaction: a failure rolls the whole install back.\n";

/// [`render_ledger_guard`] for a plan that read an empty ledger, which on a
/// fresh project does not exist yet: the check reads it only once
/// `to_regclass` finds it, since PL/pgSQL resolves a table when the statement
/// that names it first runs. Another run that installed in between makes it
/// raise.
fn render_empty_ledger_guard() -> String {
    format!(
        "{PROVISION_LOCK_SQL}\n\
         do $$\n\
         begin\n\
         \x20 if to_regclass('{SCHEMA}.{INTERNAL_PROVISIONS}') is not null then\n\
         \x20   if exists (select 1 from {SCHEMA}.{INTERNAL_PROVISIONS}) then\n\
         \x20     raise exception 'kizunasync: the provision ledger changed after this run read it'\n\
         \x20       using hint = 'Nothing was applied. Run the command again to plan against the ledger as it is now.';\n\
         \x20   end if;\n\
         \x20 end if;\n\
         end $$;\n"
    )
}

/// Apply `plan` and the project config `config_sql`. A fresh install
/// ([`Plan::Apply`]) runs as the one transaction [`render_install`] renders;
/// every other plan already has its pack, so only the config runs. Returns
/// the pack files applied.
///
/// # Errors
/// Returns [`Error::Provision`] when a fresh install fails, which rolled the
/// whole install back, and the transport's own failure when a config-only
/// apply fails.
pub fn apply_provision(
    plan: &Plan,
    config_sql: &str,
    applier: &dyn Applier,
) -> Result<Vec<String>> {
    let Plan::Apply { files } = plan else {
        applier.run_script(config_sql)?;

        return Ok(Vec::new());
    };

    applier
        .run_script(&render_install(plan, config_sql))
        .map_err(|cause| {
            Error::Provision(format!(
                "installing the pack failed: {cause}; the install ran inside one transaction, so nothing was applied and the ledger is unchanged"
            ))
        })?;

    Ok(files.iter().map(|file| file.name.clone()).collect())
}

/// Does the ledger table exist at all? `to_regclass` answers null instead of
/// raising for an absent relation, so this probe is valid against a project
/// that has never been provisioned.
#[must_use]
pub fn ledger_present_query() -> String {
    format!("select to_regclass('{SCHEMA}.{INTERNAL_PROVISIONS}') is not null as present;")
}

/// Every recorded row, for the planner.
#[must_use]
pub fn ledger_rows_query() -> String {
    format!(
        "select object_kind, object_name, content_hash, pack_version\nfrom {SCHEMA}.{INTERNAL_PROVISIONS}\norder by id;"
    )
}

/// The ledger summarized by kind, for the run report.
#[must_use]
pub fn ledger_state_query() -> String {
    format!(
        "select object_kind, count(*)::int as count\nfrom {SCHEMA}.{INTERNAL_PROVISIONS}\ngroup by 1\norder by 1;"
    )
}

/// Which of [`CORE_RPCS`] the catalog holds.
#[must_use]
pub fn core_rpcs_query() -> String {
    let names = CORE_RPCS
        .iter()
        .map(|name| format!("'{name}'"))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "select p.proname\nfrom pg_proc p\njoin pg_namespace ns on ns.oid = p.pronamespace\nwhere ns.nspname = '{SCHEMA}'\n  and p.proname in ({names});"
    )
}

/// One `object_kind → count` entry of the ledger summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerStateEntry {
    /// The kind.
    pub object_kind: String,
    /// How many rows carry it.
    pub count: i64,
}

/// The ledger summarized for the run report. An absent table is the fresh
/// state, not a failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerState {
    /// `kizunasync._provisions` does not exist yet.
    Absent,
    /// It exists; here is what it holds.
    Present(Vec<LedgerStateEntry>),
}

/// Read the ledger summary.
///
/// # Errors
/// Returns [`Error::Provision`] when the presence probe or the summary read
/// returns a shape we did not ask for.
pub fn read_ledger_state(applier: &dyn Applier) -> Result<LedgerState> {
    if !is_ledger_present(applier)? {
        return Ok(LedgerState::Absent);
    }

    let rows = applier.run_query(&ledger_state_query())?;
    let mut entries = Vec::with_capacity(rows.len());
    for row in &rows {
        entries.push(LedgerStateEntry {
            object_kind: require_string(row, "object_kind")?,
            count: require_number(row, "count")?,
        });
    }

    Ok(LedgerState::Present(entries))
}

/// Every recorded row, for the planner. An absent table reads as an empty
/// ledger.
///
/// # Errors
/// Returns [`Error::Provision`] when a row is missing one of its four columns.
pub fn read_ledger_rows(applier: &dyn Applier) -> Result<Vec<LedgerRow>> {
    if !is_ledger_present(applier)? {
        return Ok(Vec::new());
    }

    let rows = applier.run_query(&ledger_rows_query())?;
    let mut ledger = Vec::with_capacity(rows.len());
    for row in &rows {
        ledger.push(LedgerRow {
            object_kind: require_string(row, "object_kind")?,
            object_name: require_string(row, "object_name")?,
            content_hash: require_string(row, "content_hash")?,
            pack_version: require_string(row, "pack_version")?,
        });
    }

    Ok(ledger)
}

/// Which core RPCs the project does NOT have, schema-qualified and in declared
/// order. An object-keyed ledger proves only that a pack once ran, so the state
/// it reports is checked against the catalog rather than trusted.
///
/// # Errors
/// Returns [`Error::Provision`] when a catalog row is unreadable.
pub fn read_missing_core_rpcs(applier: &dyn Applier) -> Result<Vec<String>> {
    let rows = applier.run_query(&core_rpcs_query())?;
    let mut present = Vec::with_capacity(rows.len());
    for row in &rows {
        present.push(require_string(row, "proname")?);
    }

    Ok(CORE_RPCS
        .iter()
        .filter(|name| !present.iter().any(|found| found == *name))
        .map(|name| format!("{SCHEMA}.{name}"))
        .collect())
}

/// Whether `pg_cron` is installed, which is what decides whether the pack's
/// `_schedule_jobs()` has anything to write the three retention jobs into.
///
/// # Errors
/// Returns the transport's own failure. An unreadable catalog is never read as
/// "absent": "no pg_cron" and "we could not ask" must not look alike.
pub fn read_pg_cron_present(applier: &dyn Applier) -> Result<bool> {
    let rows = applier.run_query(PG_CRON_QUERY)?;
    let Some(row) = rows.first() else {
        return Err(Error::Boundary(
            "the pg_cron probe returned no row, expected exactly 1".to_owned(),
        ));
    };

    require_bool(row, "present")
}

/// The one read behind [`read_pg_cron_present`].
pub const PG_CRON_QUERY: &str =
    "select exists (select 1 from pg_extension where extname = 'pg_cron') as present;";

/// `to_regclass(…) is not null` always yields exactly one boolean row, so
/// anything else came from a transport that did not run the query we asked for.
/// Reading that as "fresh" would plan a blind re-apply over a live project, so
/// the shape is checked and named: its shape only, never the payload.
///
/// # Errors
/// Returns the transport's own failure, or a provision error when the probe
/// does not answer exactly one boolean row.
pub fn is_ledger_present(applier: &dyn Applier) -> Result<bool> {
    let rows = applier.run_query(&ledger_present_query())?;
    if rows.len() != 1 {
        return Err(Error::Provision(format!(
            "the ledger-presence probe returned {} rows, expected exactly 1",
            rows.len()
        )));
    }

    let Some(row) = rows.first() else {
        return Err(Error::Provision(
            "the ledger-presence probe returned no row, expected exactly 1".to_owned(),
        ));
    };

    parse_present(row)
}

fn parse_present(row: &Row) -> Result<bool> {
    crate::row::require_bool(row, "present").map_err(|_| {
        Error::Provision(
            "the ledger-presence probe returned a \"present\" that is not a boolean".to_owned(),
        )
    })
}

/// Plan fixtures for the tests of every module that reads a [`Plan`].
#[cfg(test)]
pub(crate) mod fake {
    use super::{Drift, DriftReason, Plan, PlanFile};

    /// A drift whose first file changed, with the ledger holding `old` for it,
    /// and whose second file the ledger does not record yet.
    pub(crate) fn changed_and_unrecorded(changed: PlanFile, unrecorded: PlanFile) -> Plan {
        let offending = vec![
            Drift {
                name: changed.name.clone(),
                reason: DriftReason::HashMismatch,
                recorded_hash: Some("old".to_owned()),
            },
            Drift {
                name: unrecorded.name.clone(),
                reason: DriftReason::NotRecorded,
                recorded_hash: None,
            },
        ];

        Plan::Drift {
            files: vec![changed, unrecorded],
            offending,
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use serde_json::Value;

    use super::fake::changed_and_unrecorded;
    use super::*;
    use crate::applier::fake::{FakeApplier, row, text_row};

    fn pack(files: &[(&str, &str)]) -> Vec<PackFile> {
        files
            .iter()
            .map(|(name, sql)| PackFile {
                name: (*name).to_owned(),
                sql: (*sql).to_owned(),
            })
            .collect()
    }

    fn ledger(rows: &[(&str, &str, &str)]) -> Vec<LedgerRow> {
        rows.iter()
            .map(|(kind, name, hash)| LedgerRow {
                object_kind: (*kind).to_owned(),
                object_name: (*name).to_owned(),
                content_hash: (*hash).to_owned(),
                pack_version: crate::VERSION.to_owned(),
            })
            .collect()
    }

    fn versioned(kind: &str, name: &str, version: &str) -> LedgerRow {
        LedgerRow {
            object_kind: kind.to_owned(),
            object_name: name.to_owned(),
            content_hash: "abc".to_owned(),
            pack_version: version.to_owned(),
        }
    }

    #[test]
    fn a_ledger_written_by_this_build_or_an_older_one_is_not_ahead() {
        let files = [plan_file("0001_a.sql", "a"), plan_file("0002_b.sql", "b")];
        let rows = [
            versioned("pack-file", "0001_a.sql", env!("CARGO_PKG_VERSION")),
            versioned("pack-file", "0002_b.sql", "0.2.5"),
            versioned("function", "kizunasync.pull", "9.9.9"),
        ];

        assert_eq!(
            ledger_ahead(&files, &rows, env!("CARGO_PKG_VERSION")),
            Vec::<LedgerAhead>::new()
        );
    }

    /// Only `pack-file` rows speak for the pack: an object row a newer build
    /// wrote is not a newer pack.
    #[test]
    fn a_newer_unshipped_or_unreadable_pack_file_row_is_ahead() {
        let files = [plan_file("0001_a.sql", "a"), plan_file("0002_b.sql", "b")];
        let rows = [
            versioned("pack-file", "0001_a.sql", "99.0.0"),
            versioned("pack-file", "0002_b.sql", "latest"),
            versioned("pack-file", "0003_c.sql", "0.2.6-alpha.1"),
            versioned("config", "public.todos", "1.0.0"),
        ];

        assert_eq!(
            ledger_ahead(&files, &rows, env!("CARGO_PKG_VERSION")),
            [
                LedgerAhead {
                    name: "0001_a.sql".to_owned(),
                    pack_version: "99.0.0".to_owned(),
                    reason: AheadReason::Newer,
                },
                LedgerAhead {
                    name: "0002_b.sql".to_owned(),
                    pack_version: "latest".to_owned(),
                    reason: AheadReason::Unreadable,
                },
                LedgerAhead {
                    name: "0003_c.sql".to_owned(),
                    pack_version: "0.2.6-alpha.1".to_owned(),
                    reason: AheadReason::NotShipped,
                },
            ]
        );
    }

    /// With no pack on disk only the version speaks: a `pack-file` row a
    /// newer build recorded, never an object row, an older build's row, or a
    /// version that cannot be ordered.
    #[test]
    fn only_a_pack_file_row_a_newer_build_recorded_is_newer_without_the_pack() {
        let rows = [
            versioned("pack-file", "0001_a.sql", "99.0.0"),
            versioned("pack-file", "0002_b.sql", "latest"),
            versioned("pack-file", "0003_c.sql", env!("CARGO_PKG_VERSION")),
            versioned("pack-file", "0004_d.sql", "0.2.5"),
            versioned("config", "public.todos", "1.0.0"),
        ];

        assert_eq!(
            ledger_newer(&rows, env!("CARGO_PKG_VERSION")),
            [LedgerAhead {
                name: "0001_a.sql".to_owned(),
                pack_version: "99.0.0".to_owned(),
                reason: AheadReason::Newer,
            }]
        );
        assert_eq!(ledger_newer(&rows, "100.0.0"), Vec::<LedgerAhead>::new());
    }

    #[test]
    fn the_ahead_refusal_names_each_row_and_says_to_update_kizunasync() {
        let files = [plan_file("0001_a.sql", "a")];
        let rows = [
            versioned("pack-file", "0001_a.sql", "0.3.0"),
            versioned("pack-file", "0002_b.sql", "0.3.0"),
        ];
        let message = describe_ledger_ahead(&ledger_ahead(&files, &rows, "0.2.6"), "0.2.6");

        assert_eq!(
            message,
            "  refusing: the ledger records a pack this kizunasync (0.2.6) cannot reconcile:\n\
             \x20   ! 0001_a.sql: recorded by kizunasync 0.3.0, newer than this build\n\
             \x20   ! 0002_b.sql: recorded by kizunasync 0.3.0, not in this build's pack\n\
             \x20 nothing was applied: update kizunasync to the build that provisioned this project or a newer one, then run this again."
        );
    }

    #[test]
    fn md5_matches_the_shipped_algorithm() {
        assert_eq!(hash_pack_file(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(hash_pack_file("select 1;\n"), hash_pack_file("select 1;\n"));
        assert_ne!(hash_pack_file("a"), hash_pack_file("b"));
    }

    #[test]
    fn an_empty_ledger_plans_a_fresh_install_in_name_order() {
        let plan = plan_provision(&pack(&[("0002_b.sql", "b"), ("0001_a.sql", "a")]), &[]);

        match plan {
            Plan::Apply { files } => {
                assert_eq!(
                    files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
                    ["0001_a.sql", "0002_b.sql"]
                );
            }
            other => panic!("expected Apply, got {other:?}"),
        }
    }

    #[test]
    fn a_matching_per_file_ledger_is_up_to_date() {
        let files = pack(&[("0001_a.sql", "a")]);
        let rows = ledger(&[("pack-file", "0001_a.sql", &hash_pack_file("a"))]);

        assert!(matches!(
            plan_provision(&files, &rows),
            Plan::UpToDate { .. }
        ));
    }

    #[test]
    fn an_object_keyed_ledger_is_provisioned_unversioned_not_drift() {
        let files = pack(&[("0001_a.sql", "a")]);
        let rows = ledger(&[
            ("function", "kizunasync.pull", "abc"),
            ("config", "kizunasync.todos", "def"),
        ]);

        match plan_provision(&files, &rows) {
            Plan::ProvisionedUnversioned {
                recorded_objects, ..
            } => assert_eq!(recorded_objects, 2),
            other => panic!("expected ProvisionedUnversioned, got {other:?}"),
        }
    }

    #[test]
    fn an_object_row_named_like_a_pack_file_does_not_count_as_recorded() {
        let files = pack(&[("0001_a.sql", "a")]);
        let rows = ledger(&[("config", "0001_a.sql", &hash_pack_file("a"))]);

        assert!(matches!(
            plan_provision(&files, &rows),
            Plan::ProvisionedUnversioned { .. }
        ));
    }

    #[test]
    fn a_new_pack_file_beside_a_recorded_one_is_not_recorded_drift() {
        let files = pack(&[("0001_a.sql", "a"), ("0002_b.sql", "b")]);
        let rows = ledger(&[("pack-file", "0001_a.sql", &hash_pack_file("a"))]);

        match plan_provision(&files, &rows) {
            Plan::Drift { offending, .. } => {
                assert_eq!(offending.len(), 1);
                assert_eq!(offending[0].name, "0002_b.sql");
                assert_eq!(offending[0].reason, DriftReason::NotRecorded);
            }
            other => panic!("expected Drift, got {other:?}"),
        }
    }

    #[test]
    fn a_changed_pack_file_is_hash_mismatch_drift_carrying_the_recorded_hash() {
        let files = pack(&[("0001_a.sql", "changed")]);
        let rows = ledger(&[("pack-file", "0001_a.sql", "deadbeef")]);

        match plan_provision(&files, &rows) {
            Plan::Drift { offending, .. } => {
                assert_eq!(offending[0].reason, DriftReason::HashMismatch);
                assert_eq!(offending[0].recorded_hash.as_deref(), Some("deadbeef"));
            }
            other => panic!("expected Drift, got {other:?}"),
        }
    }

    #[test]
    fn the_pack_file_ledger_insert_escapes_its_literals() {
        let sql = render_pack_file_ledger_sql("o'clock.sql", "abc");

        assert!(sql.contains("'o''clock.sql'"));
        assert!(sql.contains("on conflict (object_kind, object_name) do nothing;"));
    }

    #[test]
    fn the_ledger_upsert_escapes_its_literals_and_replaces_the_recorded_hash() {
        let sql = render_pack_file_ledger_upsert_sql("o'clock.sql", "abc");

        assert!(sql.starts_with("insert into kizunasync._provisions (object_kind, object_name, content_hash, pack_version) "));
        assert!(sql.contains("values ('pack-file', 'o''clock.sql', 'abc', "));
        assert!(sql.ends_with(
            "on conflict (object_kind, object_name) do update set content_hash = excluded.content_hash, pack_version = excluded.pack_version;"
        ));
    }

    fn plan_file(name: &str, sql: &str) -> PlanFile {
        PlanFile {
            name: name.to_owned(),
            sql: sql.to_owned(),
            content_hash: hash_pack_file(sql),
        }
    }

    /// The first file changed, the second is not recorded yet.
    fn changed_a_unrecorded_b() -> Plan {
        changed_and_unrecorded(
            plan_file("0001_a.sql", "select 1;\n"),
            plan_file("0002_b.sql", "select 2;\n"),
        )
    }

    const GUARD_RAISE: &str = "  then\n\
         \x20   raise exception 'kizunasync: the provision ledger changed after this run read it'\n\
         \x20     using hint = 'Nothing was applied. Run the command again to plan against the ledger as it is now.';\n\
         \x20 end if;\n\
         end $$;\n";

    /// One `begin` … `commit` that takes the provisioning lock, re-checks the
    /// ledger as the plan read it, then runs every file in name order, each
    /// followed by the upsert that records its own hash.
    #[test]
    fn the_reconcile_script_locks_rechecks_then_upserts_each_files_hash() {
        let plan = changed_a_unrecorded_b();
        let [first, second] = plan.files() else {
            panic!("two files");
        };

        assert_eq!(
            render_reconcile(&plan),
            format!(
                "-- Generated by kizunasync: every pack file re-applied and its ledger hash recorded,\n\
                 -- in one transaction: a failure rolls the whole batch back.\n\
                 begin;\n\
                 select pg_advisory_xact_lock(1264210777, 2);\n\
                 do $$\n\
                 begin\n\
                 \x20 if (select content_hash from kizunasync._provisions where object_kind = 'pack-file' and object_name = '0001_a.sql') is distinct from 'old'\n\
                 \x20   or (select content_hash from kizunasync._provisions where object_kind = 'pack-file' and object_name = '0002_b.sql') is distinct from null\n\
                 {GUARD_RAISE}\n\
                 -- 0001_a.sql\n\
                 select 1;\n\
                 {}\n\n\
                 -- 0002_b.sql\n\
                 select 2;\n\
                 {}\n\n\
                 commit;\n",
                render_pack_file_ledger_upsert_sql(&first.name, &first.content_hash),
                render_pack_file_ledger_upsert_sql(&second.name, &second.content_hash),
            )
        );
    }

    /// What each file's row held when the plan was read: its own hash when it
    /// matched, the ledger's when it differed, and no row when it had none.
    #[test]
    fn the_recorded_hashes_are_the_ledger_as_each_plan_read_it() {
        let files = vec![plan_file("0001_a.sql", "select 1;\n")];
        let hash = files[0].content_hash.clone();

        assert_eq!(
            changed_a_unrecorded_b().recorded_hashes(),
            [("0001_a.sql", Some("old")), ("0002_b.sql", None)]
        );
        assert_eq!(
            Plan::UpToDate {
                files: files.clone()
            }
            .recorded_hashes(),
            [("0001_a.sql", Some(hash.as_str()))]
        );
        for plan in [
            Plan::Apply {
                files: files.clone(),
            },
            Plan::ProvisionedUnversioned {
                files,
                recorded_objects: 3,
            },
        ] {
            assert_eq!(plan.recorded_hashes(), [("0001_a.sql", None)], "{plan:?}");
        }
    }

    /// A value spliced into the guard's `do $$ … $$` body cannot close the
    /// dollar quoting: a `$` is spelled `chr(36)` outside the literal.
    #[test]
    fn a_dollar_in_a_rechecked_value_stays_inside_the_do_block() {
        let plan = Plan::Drift {
            files: vec![plan_file("0001_a.sql", "select 1;\n")],
            offending: vec![Drift {
                name: "0001_a.sql".to_owned(),
                reason: DriftReason::HashMismatch,
                recorded_hash: Some("x$$; drop schema public; --'".to_owned()),
            }],
        };
        let guard = render_ledger_guard(&plan);

        assert!(
            guard.contains(
                "is distinct from ('x' || chr(36) || '' || chr(36) || '; drop schema public; --''')\n"
            ),
            "{guard}"
        );
        assert_eq!(
            guard.matches('$').count(),
            4,
            "only do $$ and end $$: {guard}"
        );
    }

    #[test]
    fn a_plan_with_no_file_still_takes_the_lock() {
        assert_eq!(
            render_ledger_guard(&Plan::Apply { files: Vec::new() }),
            "select pg_advisory_xact_lock(1264210777, 2);\n"
        );
    }

    #[test]
    fn reconcile_sends_one_script_and_names_the_rollback_on_failure() {
        let plan = Plan::UpToDate {
            files: vec![plan_file("0001_a.sql", "select 1;")],
        };
        let applier = FakeApplier::new();
        reconcile_pack(&plan, &applier).unwrap();

        assert_eq!(*applier.executed.borrow(), [render_reconcile(&plan)]);

        let failing = FakeApplier::new().fail("select 1;", "boom");
        let Error::Provision(message) = reconcile_pack(&plan, &failing).unwrap_err() else {
            panic!("a failed re-apply is a provisioning failure");
        };
        assert_eq!(
            message,
            "re-applying the pack failed: boom; the batch ran inside one transaction, so nothing was applied and the ledger is unchanged"
        );
    }

    #[test]
    fn hash_mismatches_are_the_mismatch_offenders_of_a_drift_plan_only() {
        let files = vec![plan_file("0001_a.sql", "a"), plan_file("0002_b.sql", "b")];
        let mismatch = Drift {
            name: "0001_a.sql".to_owned(),
            reason: DriftReason::HashMismatch,
            recorded_hash: Some("old".to_owned()),
        };
        let missing = Drift {
            name: "0002_b.sql".to_owned(),
            reason: DriftReason::NotRecorded,
            recorded_hash: None,
        };
        let mixed = Plan::Drift {
            files: files.clone(),
            offending: vec![mismatch.clone(), missing.clone()],
        };
        let only_missing = Plan::Drift {
            files: files.clone(),
            offending: vec![missing],
        };

        assert_eq!(mixed.hash_mismatches(), [&mismatch]);
        assert_eq!(only_missing.hash_mismatches(), Vec::<&Drift>::new());
        for plan in [
            Plan::Apply {
                files: files.clone(),
            },
            Plan::UpToDate {
                files: files.clone(),
            },
            Plan::ProvisionedUnversioned {
                files: files.clone(),
                recorded_objects: 3,
            },
        ] {
            assert!(plan.hash_mismatches().is_empty(), "{plan:?}");
            assert_eq!(plan.files(), files.as_slice());
        }
        assert_eq!(mixed.files(), files.as_slice());
    }

    const CONFIG_SQL: &str =
        "-- project config\ninsert into kizunasync._config (table_name) values ('todos');\n";

    fn fresh_plan() -> Plan {
        Plan::Apply {
            files: vec![
                plan_file("0001_a.sql", "select 1;\n"),
                plan_file("0002_b.sql", "select 2;"),
            ],
        }
    }

    /// The whole fresh install is one script: the lock and the empty-ledger
    /// check first, each file followed by its ledger row, the project config
    /// last, all between one `begin` and one `commit`.
    #[test]
    fn a_fresh_install_is_one_transaction_ending_with_the_project_config() {
        let plan = fresh_plan();
        let first = hash_pack_file("select 1;\n");
        let second = hash_pack_file("select 2;");

        assert_eq!(
            render_install(&plan, CONFIG_SQL),
            format!(
                "-- Generated by kizunasync: a fresh install, every pack file with its ledger row and\n\
                 -- then the project config, in one transaction: a failure rolls the whole install back.\n\
                 begin;\n\
                 select pg_advisory_xact_lock(1264210777, 2);\n\
                 do $$\n\
                 begin\n\
                 \x20 if to_regclass('kizunasync._provisions') is not null then\n\
                 \x20   if exists (select 1 from kizunasync._provisions) then\n\
                 \x20     raise exception 'kizunasync: the provision ledger changed after this run read it'\n\
                 \x20       using hint = 'Nothing was applied. Run the command again to plan against the ledger as it is now.';\n\
                 \x20   end if;\n\
                 \x20 end if;\n\
                 end $$;\n\
                 \n-- 0001_a.sql\nselect 1;\n{}\n\
                 \n-- 0002_b.sql\nselect 2;\n{}\n\
                 \n-- project config\ninsert into kizunasync._config (table_name) values ('todos');\n\
                 commit;\n",
                render_pack_file_ledger_sql("0001_a.sql", &first),
                render_pack_file_ledger_sql("0002_b.sql", &second),
            )
        );
    }

    #[test]
    fn a_fresh_install_is_sent_once_and_names_every_applied_file() {
        let applier = FakeApplier::new();
        let plan = fresh_plan();
        let names = apply_provision(&plan, CONFIG_SQL, &applier).unwrap();

        assert_eq!(names, ["0001_a.sql", "0002_b.sql"]);
        assert_eq!(
            *applier.executed.borrow(),
            [render_install(&plan, CONFIG_SQL)]
        );
    }

    /// A project that already carries the pack gets the project config alone.
    #[test]
    fn a_plan_that_is_not_fresh_applies_the_config_alone() {
        for plan in [
            Plan::UpToDate {
                files: vec![plan_file("0001_a.sql", "select 1;")],
            },
            Plan::ProvisionedUnversioned {
                files: vec![plan_file("0001_a.sql", "select 1;")],
                recorded_objects: 3,
            },
        ] {
            let applier = FakeApplier::new();
            let names = apply_provision(&plan, CONFIG_SQL, &applier).unwrap();

            assert_eq!(names, Vec::<String>::new());
            assert_eq!(*applier.executed.borrow(), [CONFIG_SQL]);
        }
    }

    #[test]
    fn a_failed_install_says_the_whole_transaction_rolled_back() {
        let applier = FakeApplier::new().fail("select 2;", "boom");
        let Error::Provision(message) =
            apply_provision(&fresh_plan(), CONFIG_SQL, &applier).unwrap_err()
        else {
            panic!("a failed install is a provisioning failure");
        };

        assert!(
            message.starts_with("installing the pack failed: "),
            "{message}"
        );
        assert!(message.contains("boom"), "{message}");
        assert!(
            message.ends_with(
                "the install ran inside one transaction, so nothing was applied and the ledger is unchanged"
            ),
            "{message}"
        );
    }

    #[test]
    fn an_absent_ledger_reads_as_empty_not_as_a_failure() {
        let applier = FakeApplier::new().answer("to_regclass", vec![text_row(&[("present", "f")])]);

        assert_eq!(read_ledger_rows(&applier).unwrap(), Vec::<LedgerRow>::new());
        assert_eq!(read_ledger_state(&applier).unwrap(), LedgerState::Absent);
    }

    #[test]
    fn a_present_ledger_is_read_row_by_row() {
        let applier = FakeApplier::new()
            .answer("to_regclass", vec![text_row(&[("present", "t")])])
            .answer(
                "select object_kind, object_name, content_hash",
                vec![text_row(&[
                    ("object_kind", "pack-file"),
                    ("object_name", "0001_a.sql"),
                    ("content_hash", "abc"),
                    ("pack_version", crate::VERSION),
                ])],
            );
        let rows = read_ledger_rows(&applier).unwrap();

        assert_eq!(rows, ledger(&[("pack-file", "0001_a.sql", "abc")]));
        assert!(applier.executed.borrow().iter().any(|sql| {
            sql.starts_with("select object_kind, object_name, content_hash, pack_version\n")
        }));
    }

    #[test]
    fn the_presence_probe_refuses_a_shape_it_did_not_ask_for() {
        let applier = FakeApplier::new().answer("to_regclass", Vec::new());
        let Error::Provision(message) = read_ledger_rows(&applier).unwrap_err() else {
            panic!("an unexpected probe shape is a provisioning failure");
        };

        assert!(
            message.contains("returned 0 rows, expected exactly 1"),
            "{message}"
        );
    }

    #[test]
    fn parse_present_rejects_a_non_boolean_present_value() {
        let applier =
            FakeApplier::new().answer("to_regclass", vec![text_row(&[("present", "maybe")])]);
        let Error::Provision(message) = read_ledger_rows(&applier).unwrap_err() else {
            panic!("a non-boolean present column is a provisioning failure");
        };

        assert!(message.contains("is not a boolean"), "{message}");
    }

    #[test]
    fn an_empty_pg_cron_probe_is_a_boundary_not_absent() {
        let applier = FakeApplier::new().answer("pg_extension", Vec::new());
        let Error::Boundary(message) = read_pg_cron_present(&applier).unwrap_err() else {
            panic!("no row is not \"pg_cron absent\"");
        };

        assert!(
            message.contains("returned no row, expected exactly 1"),
            "{message}"
        );
    }

    #[test]
    fn a_boolean_pg_cron_probe_is_the_extension_presence() {
        let present =
            FakeApplier::new().answer("pg_extension", vec![text_row(&[("present", "t")])]);
        let absent = FakeApplier::new().answer("pg_extension", vec![text_row(&[("present", "f")])]);

        assert!(read_pg_cron_present(&present).unwrap());
        assert!(!read_pg_cron_present(&absent).unwrap());
    }

    #[test]
    fn missing_core_rpcs_are_reported_schema_qualified_in_declared_order() {
        let none = FakeApplier::new().answer("pg_proc", Vec::new());
        assert_eq!(
            read_missing_core_rpcs(&none).unwrap(),
            ["kizunasync.pull", "kizunasync.push"]
        );

        let half = FakeApplier::new().answer("pg_proc", vec![text_row(&[("proname", "pull")])]);
        assert_eq!(read_missing_core_rpcs(&half).unwrap(), ["kizunasync.push"]);

        let all = FakeApplier::new().answer(
            "pg_proc",
            vec![
                text_row(&[("proname", "pull")]),
                text_row(&[("proname", "push")]),
            ],
        );
        assert_eq!(read_missing_core_rpcs(&all).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn the_ledger_summary_accepts_a_json_count_as_well_as_a_text_one() {
        let applier = FakeApplier::new()
            .answer("to_regclass", vec![row(&[("present", Value::Bool(true))])])
            .answer(
                "count(*)::int",
                vec![row(&[
                    ("object_kind", Value::String("function".into())),
                    ("count", Value::from(4)),
                ])],
            );

        assert_eq!(
            read_ledger_state(&applier).unwrap(),
            LedgerState::Present(vec![LedgerStateEntry {
                object_kind: "function".to_owned(),
                count: 4,
            }])
        );
    }
}
