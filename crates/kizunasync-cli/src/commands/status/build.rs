use std::collections::BTreeMap;

use crate::applier::Applier;
use crate::commands::jobs::read_jobs;
use crate::config::{config_query, settings_query};
use crate::constants::{INTERNAL_CLIENTS, INTERNAL_SETTINGS, SCHEMA};
use crate::env::Env;
use crate::error::Result;
use crate::pack::{read_pack_files, resolve_pack_dir};
use crate::provision::{
    LedgerRow, PACK_FILE_KIND, Plan, ledger_newer, plan_provision, read_ledger_rows,
    read_missing_core_rpcs,
};
use crate::row::{optional_bool, optional_number, optional_string, require_number, require_string};
use crate::workdir::ProjectPaths;

use super::sections::{read_attachments, read_journal, read_retention};
use super::{
    ClientStatus, ClientsStatus, ColumnStatus, NOT_PROVISIONED, PER_CLIENT_LIMIT, PackStatus,
    SettingsStatus, StatusReport, TableState, TableStatus,
};

/// The catalog query for every column of `tables`, or `None` when the list is
/// empty and there is nothing to ask for.
pub(crate) fn columns_for_tables_query(tables: &[String]) -> Option<String> {
    if tables.is_empty() {
        return None;
    }

    let list = tables
        .iter()
        .map(|name| format!("'{}'", name.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");

    Some(format!(
        "select table_schema, table_name, column_name, data_type from information_schema.columns where table_name in ({list}) and table_schema not in ('pg_catalog', 'information_schema', '{SCHEMA}') order by table_schema, table_name, ordinal_position;"
    ))
}

/// One row, always: scalar subqueries answer for an empty registry too, where
/// a grouped read would return nothing and the section would go missing.
/// `stale` is counted against the same `client_ttl_days` the pruner and the
/// compaction floor read.
fn clients_query() -> String {
    format!(
        "select\n  (select count(*) from {SCHEMA}.{INTERNAL_CLIENTS})::int as clients,\n  (select count(distinct user_id) from {SCHEMA}.{INTERNAL_CLIENTS})::int as users,\n  (select max(last_seen)::text from {SCHEMA}.{INTERNAL_CLIENTS}) as last_seen,\n  (select count(*) from {SCHEMA}.{INTERNAL_CLIENTS} c, {SCHEMA}.{INTERNAL_SETTINGS} s where c.last_seen < now() - make_interval(days => {CLIENT_TTL_DAYS}))::int as stale,\n  (select {CLIENT_TTL_DAYS} from {SCHEMA}.{INTERNAL_SETTINGS} s) as ttl_days;"
    )
}

/// The newest devices, one row each. Cross-joined to the single-row settings
/// so `stale` is decided by the same `client_ttl_days` the pruner reads, and
/// the cursor is reduced by the pack's own codec rather than re-parsed here.
fn per_client_query() -> String {
    format!(
        "select\n  c.client_id::text as client_id,\n  c.user_id::text as user_id,\n  c.last_seen::text as last_seen,\n  c.last_mutation_id::text as last_mutation_id,\n  {SCHEMA}._cursor_high_water(c.cursor) as cursor_high_water,\n  (c.last_seen < now() - make_interval(days => {CLIENT_TTL_DAYS})) as stale\nfrom {SCHEMA}.{INTERNAL_CLIENTS} c, {SCHEMA}.{INTERNAL_SETTINGS} s\norder by c.last_seen desc\nlimit {PER_CLIENT_LIMIT};"
    )
}

/// `client_ttl_days` from the settings row aliased `s`, read out of the whole
/// row for the reason [`config_query`] gives. On a pack without the column it
/// is null, and no device counts as stale.
const CLIENT_TTL_DAYS: &str = "(to_jsonb(s) ->> 'client_ttl_days')::int";

/// Everything the report needs, in one pass. The DB-backed sections are read
/// only once the pack section proves there is something to read: querying
/// `kizunasync._config` on an unprovisioned project would fail as a missing
/// relation, which is not the same news as "nothing is installed".
///
/// # Errors
/// Returns the transport's own failure, or [`Error::Pack`](crate::error::Error::Pack)
/// when the shipped pack cannot be located.
pub fn build_report(
    applier: &dyn Applier,
    paths: &ProjectPaths,
    env: &Env,
) -> Result<StatusReport> {
    let rows = read_ledger_rows(applier)?;
    let pack = match resolve_pack_dir(env) {
        Some(pack_dir) => describe_pack(
            &plan_provision(&read_pack_files(&pack_dir)?, &rows),
            applier,
        )?,
        None => describe_ledger(&rows, applier)?,
    };
    let pack = with_ledger_ahead(pack, &rows);
    let api_schemas = describe_api_schemas(paths);
    if pack.state == NOT_PROVISIONED {
        return Ok(StatusReport {
            pack,
            tables: Vec::new(),
            clients: None,
            settings: None,
            jobs: None,
            retention: None,
            journal: None,
            attachments: None,
            api_schemas,
        });
    }

    let clients = read_clients(applier)?;
    let settings = read_settings(applier)?;
    // The reaper coalesces a null per-table retention to this one, so the
    // report resolves it the same way rather than showing no TTL at all.
    let mut tables = read_config_tables(
        applier,
        settings
            .as_ref()
            .and_then(|settings| settings.tombstone_ttl_days),
    )?;
    let names: Vec<String> = tables.iter().map(|table| table.table.clone()).collect();
    let columns = read_table_columns(applier, &names)?;
    attach_columns(&mut tables, columns);

    Ok(StatusReport {
        pack,
        tables,
        clients,
        settings,
        jobs: Some(read_jobs(applier)?),
        retention: read_retention(applier)?,
        journal: read_journal(applier)?,
        attachments: read_attachments(applier)?,
        api_schemas,
    })
}

/// The pack section of a run with no shipped pack on disk. The ledger is the
/// source either way; without the files there is simply nothing to compare the
/// recorded hashes against, and the state says so instead of the command
/// failing.
///
/// # Errors
/// Returns the transport's failure when the core-RPC probe cannot run.
pub(crate) fn describe_ledger(rows: &[LedgerRow], applier: &dyn Applier) -> Result<PackStatus> {
    let recorded = rows
        .iter()
        .filter(|row| row.object_kind == PACK_FILE_KIND)
        .count();
    if rows.is_empty() {
        return Ok(PackStatus {
            state: NOT_PROVISIONED.to_owned(),
            file_count: 0,
            offenders: None,
            pending_files: None,
        });
    }
    if recorded == 0 {
        // The same object-keyed ledger `Plan::ProvisionedUnversioned` describes,
        // reached without the files: the RPCs a client calls are what decide it.
        return describe_pack(
            &Plan::ProvisionedUnversioned {
                files: Vec::new(),
                recorded_objects: rows.len(),
            },
            applier,
        );
    }

    Ok(PackStatus {
        state: format!(
            "provisioned ({recorded} pack file(s) recorded, no pack on disk to compare)"
        ),
        file_count: 0,
        offenders: None,
        pending_files: None,
    })
}

/// The pack section once the ledger's `pack-file` rows are weighed against
/// this build: a row a newer kizunasync recorded is what every command that
/// writes to the database refuses over, so the state says to update and each
/// such row leads the offenders. `status` reports it and reads on.
pub(crate) fn with_ledger_ahead(pack: PackStatus, rows: &[LedgerRow]) -> PackStatus {
    let newer = ledger_newer(rows, crate::VERSION);
    if newer.is_empty() {
        return pack;
    }

    let mut offenders: Vec<String> = newer
        .iter()
        .map(|row| {
            format!(
                "{}: recorded by kizunasync {}, newer than this build",
                row.name, row.pack_version
            )
        })
        .collect();
    offenders.extend(pack.offenders.into_iter().flatten());

    PackStatus {
        state: format!(
            "recorded by a newer kizunasync than this build ({}): update kizunasync",
            crate::VERSION
        ),
        offenders: Some(offenders),
        ..pack
    }
}

/// Turn a plan into the pack section. Split out so the states the real one-file
/// pack cannot produce (a mix of recorded and pending files) are still testable
/// from a hand-built plan.
///
/// # Errors
/// Returns the transport's failure when the core-RPC probe cannot run.
pub fn describe_pack(plan: &Plan, applier: &dyn Applier) -> Result<PackStatus> {
    let file_count = pack_file_count(plan);
    let status = |state: String| PackStatus {
        state,
        file_count,
        offenders: None,
        pending_files: None,
    };

    match plan {
        Plan::Apply { .. } => Ok(status(NOT_PROVISIONED.to_owned())),
        Plan::UpToDate { .. } => Ok(status("up to date".to_owned())),
        Plan::ProvisionedUnversioned { .. } => {
            // An object-keyed ledger proves only that a pack once ran, so check
            // the RPCs a client actually calls.
            let missing = read_missing_core_rpcs(applier)?;
            if missing.is_empty() {
                return Ok(status(
                    "provisioned (no pack-file row: not installed by kizunasync init)".to_owned(),
                ));
            }

            Ok(PackStatus {
                state: format!("drift (missing core RPCs: {})", missing.join(", ")),
                file_count,
                offenders: Some(missing),
                pending_files: None,
            })
        }
        Plan::Drift { offending, .. } => {
            let pending: Vec<&crate::provision::Drift> = offending
                .iter()
                .filter(|offender| offender.reason == crate::provision::DriftReason::NotRecorded)
                .collect();
            if pending.len() == offending.len() {
                return Ok(PackStatus {
                    state: format!("upgrade available ({} pending pack file(s))", pending.len()),
                    file_count,
                    offenders: None,
                    pending_files: Some(
                        pending
                            .iter()
                            .map(|offender| offender.name.clone())
                            .collect(),
                    ),
                });
            }

            Ok(PackStatus {
                state: "drift".to_owned(),
                file_count,
                offenders: Some(
                    offending
                        .iter()
                        .map(|offender| format!("{}: {}", offender.name, offender.reason))
                        .collect(),
                ),
                pending_files: None,
            })
        }
    }
}

fn pack_file_count(plan: &Plan) -> usize {
    match plan {
        Plan::Apply { files }
        | Plan::UpToDate { files }
        | Plan::ProvisionedUnversioned { files, .. }
        | Plan::Drift { files, .. } => files.len(),
    }
}

/// The synced tables, with `project_ttl_days` resolving the retention of every
/// row that declared none of its own.
///
/// # Errors
/// Returns the applier's own failure, or [`Error::Boundary`](crate::error::Error::Boundary)
/// when a row does not carry the columns the pack defines.
pub(crate) fn read_config_tables(
    applier: &dyn Applier,
    project_ttl_days: Option<i64>,
) -> Result<Vec<TableStatus>> {
    let rows = applier.run_query(&config_query())?;
    let mut tables = Vec::with_capacity(rows.len());
    for row in &rows {
        let declared_ttl = optional_number(row, "tombstone_ttl_days")?;
        tables.push(TableStatus {
            table: require_string(row, "table_name")?,
            state: TableState::Synced,
            sync_mode: optional_string(row, "sync_mode")?,
            bucket_column: optional_string(row, "bucket_column")?,
            conflict_mode: optional_string(row, "conflict_mode")?,
            conflict_journal: Some(optional_bool(row, "conflict_journal")?.unwrap_or(false)),
            soft_delete_column: optional_string(row, "soft_delete_column")?,
            tombstone_ttl_days: declared_ttl.or(project_ttl_days),
            tombstone_ttl_inherited: declared_ttl.is_none(),
            min_schema_version: optional_number(row, "min_schema_version")?,
            register_clients: Some(optional_bool(row, "register_clients")?.unwrap_or(false)),
            created_at: optional_string(row, "created_at")?,
            columns: Vec::new(),
        });
    }

    Ok(tables)
}

/// The live columns of every name in `tables`, keyed by table. An empty list
/// reads as an empty map without touching the database.
///
/// # Errors
/// Returns the applier's own failure, or [`Error::Boundary`](crate::error::Error::Boundary)
/// when a catalog row does not carry the columns the query selected.
pub(crate) fn read_table_columns(
    applier: &dyn Applier,
    tables: &[String],
) -> Result<BTreeMap<String, Vec<ColumnStatus>>> {
    let Some(sql) = columns_for_tables_query(tables) else {
        return Ok(BTreeMap::new());
    };

    let rows = applier.run_query(&sql)?;
    let mut by_table: BTreeMap<String, Vec<ColumnStatus>> = BTreeMap::new();
    for row in &rows {
        let table = require_string(row, "table_name")?;
        by_table.entry(table).or_default().push(ColumnStatus {
            schema: require_string(row, "table_schema")?,
            name: require_string(row, "column_name")?,
            data_type: require_string(row, "data_type")?,
        });
    }

    Ok(by_table)
}

pub(crate) fn attach_columns(
    tables: &mut [TableStatus],
    mut columns: BTreeMap<String, Vec<ColumnStatus>>,
) {
    for table in tables.iter_mut() {
        if let Some(live) = columns.remove(&table.table) {
            table.columns = live;
        }
    }
}

/// The client registry roll-up, or `None` when the project registers no
/// clients.
///
/// # Errors
/// Returns the applier's own failure, or [`Error::Boundary`](crate::error::Error::Boundary)
/// when a row does not carry the columns the pack defines.
pub(crate) fn read_clients(applier: &dyn Applier) -> Result<Option<ClientsStatus>> {
    let rows = applier.run_query(&clients_query())?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };

    Ok(Some(ClientsStatus {
        clients: require_number(row, "clients")?,
        users: require_number(row, "users")?,
        last_seen: optional_string(row, "last_seen")?,
        stale: require_number(row, "stale")?,
        ttl_days: optional_number(row, "ttl_days")?,
        per_client: read_per_client(applier)?,
    }))
}

/// One entry per registered device, newest first, capped at
/// [`PER_CLIENT_LIMIT`].
///
/// # Errors
/// Returns the applier's own failure, or [`Error::Boundary`](crate::error::Error::Boundary)
/// when a row does not carry the columns the pack defines.
pub(crate) fn read_per_client(applier: &dyn Applier) -> Result<Vec<ClientStatus>> {
    let rows = applier.run_query(&per_client_query())?;
    let mut clients = Vec::with_capacity(rows.len());
    for row in &rows {
        clients.push(ClientStatus {
            client_id: require_string(row, "client_id")?,
            user_id: require_string(row, "user_id")?,
            last_seen: require_string(row, "last_seen")?,
            last_mutation_id: optional_string(row, "last_mutation_id")?,
            cursor_high_water: optional_number(row, "cursor_high_water")?,
            stale: optional_bool(row, "stale")?.unwrap_or(false),
        });
    }

    Ok(clients)
}

/// The project's server knobs, or `None` when the settings row is absent.
///
/// # Errors
/// Returns the applier's own failure, or [`Error::Boundary`](crate::error::Error::Boundary)
/// when the row does not carry the columns the pack defines.
pub(crate) fn read_settings(applier: &dyn Applier) -> Result<Option<SettingsStatus>> {
    let rows = applier.run_query(&settings_query())?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };

    Ok(Some(SettingsStatus {
        max_batch_size: optional_number(row, "max_batch_size")?,
        require_atomic: optional_bool(row, "require_atomic")?.unwrap_or(false),
        reap_schedule: optional_string(row, "reap_schedule")?,
        compact_schedule: optional_string(row, "compact_schedule")?,
        client_prune_schedule: optional_string(row, "client_prune_schedule")?,
        client_ttl_days: optional_number(row, "client_ttl_days")?,
        hlc_max_skew_ms: optional_number(row, "hlc_max_skew_ms")?,
        tombstone_ttl_days: optional_number(row, "tombstone_ttl_days")?,
        max_pull_scan: optional_number(row, "max_pull_scan")?,
    }))
}

pub(crate) const API_SCHEMAS_EXPOSED: &str = "exposed";
pub(crate) const API_SCHEMAS_NO_FILE: &str = "no supabase/config.toml";
pub(crate) const API_SCHEMAS_UNPARSEABLE: &str =
    "unparseable (supabase/config.toml is not valid TOML)";

pub(crate) fn api_schemas_not_exposed() -> String {
    format!("not exposed (add \"{SCHEMA}\" to [api].schemas)")
}

/// Whether `supabase/config.toml` exposes the kizunasync schema, as the one
/// status section that needs no connection.
pub(crate) fn describe_api_schemas(paths: &ProjectPaths) -> String {
    let Ok(body) = std::fs::read_to_string(&paths.config_toml) else {
        return API_SCHEMAS_NO_FILE.to_owned();
    };

    let Ok(config) = crate::supabase_config::parse(&body) else {
        return API_SCHEMAS_UNPARSEABLE.to_owned();
    };

    if config
        .api
        .schema_names()
        .is_some_and(|schemas| schemas.iter().any(|name| name == SCHEMA))
    {
        return API_SCHEMAS_EXPOSED.to_owned();
    }

    api_schemas_not_exposed()
}
