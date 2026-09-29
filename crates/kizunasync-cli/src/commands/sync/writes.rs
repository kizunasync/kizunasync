use crate::applier::Applier;
use crate::commands::history_gate::push_written;
use crate::commands::init::DirectConnection;
use crate::commands::{FAILURE, OK};
use crate::config_sql::ResolvedTableConfig;
use crate::proposals::TableProposal;
use crate::sync_delta::DeltaTable;
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

use super::SyncPorts;

/// Supabase's `<YYYYMMDDHHMMSS>_<label>.sql` migration convention.
const MIGRATION_LABEL: &str = "kizunasync_sync";

// MARK: - writes

pub(crate) struct Writes<'a> {
    pub(crate) migration_name: &'a str,
    pub(crate) delta_sql: &'a str,
    pub(crate) local_only: bool,
    /// The run was told to write without asking, so a failed push asks
    /// nothing either.
    pub(crate) yes: bool,
    /// The database `supabase db push` applies the migration to, and whose
    /// migration history a failed push is checked against.
    pub(crate) connection: &'a DirectConnection,
}

/// Write the delta migration and, unless the run is local-only, apply it with
/// `supabase db push` to [`Writes::connection`]. Returns the exit code the
/// command ends on.
pub(crate) fn perform_writes(
    writes: &Writes<'_>,
    paths: &ProjectPaths,
    ports: &mut SyncPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let migrations_dir = &paths.migrations_dir;
    if let Err(cause) = std::fs::create_dir_all(migrations_dir) {
        return report_migration_failure(&cause.to_string(), ui);
    }
    if let Err(cause) = std::fs::write(migrations_dir.join(writes.migration_name), writes.delta_sql)
    {
        return report_migration_failure(&cause.to_string(), ui);
    }
    ui.log(&format!("  emitted {}", writes.migration_name));

    let target = writes.connection.push.describe();
    if writes.local_only {
        ui.log(&format!(
            "\n  --local-only: migrations written but NOT applied. Run `supabase db push {target}` yourself."
        ));

        return OK;
    }

    let mut unasked = None;
    let prompter = if writes.yes {
        &mut unasked
    } else {
        &mut ports.prompter
    };
    if let Err(code) = push_written(
        writes.connection,
        paths,
        &[writes.migration_name.to_owned()],
        ports.schemas,
        ports.supabase,
        prompter,
        ui,
    ) {
        return code;
    }
    ui.log(&format!(
        "\n  applied via supabase db push {target}. Run `kizunasync status` to verify."
    ));

    OK
}

/// The hosted path: the same delta, applied as one transaction through the
/// Management API's SQL endpoint. No file is written, so there is nothing to
/// clean up when it fails.
pub(crate) fn apply_remotely(api: &dyn Applier, delta_sql: &str, ui: &mut Ui) -> i32 {
    if let Err(cause) = api.run_script(delta_sql) {
        ui.error(&format!(
            "\n  the delta did not apply:\n    {cause}\n  nothing else was changed."
        ));

        return FAILURE;
    }

    ui.log("\n  applied over the Management API. Run `kizunasync status` to verify.");

    OK
}

/// Nothing has been written when this fires, which is what makes re-running the
/// whole command the fix.
fn report_migration_failure(cause: &str, ui: &mut Ui) -> i32 {
    ui.error(&format!(
        "\n  could not write the delta migration: {cause}\n  nothing was written. Fix the problem and re-run `kizunasync sync`."
    ));

    FAILURE
}

pub(crate) fn delta_table(proposal: &TableProposal) -> DeltaTable {
    DeltaTable {
        table: proposal.table.clone(),
        config: ResolvedTableConfig::from_proposal(proposal),
    }
}

// MARK: - migration naming

/// `<YYYYMMDDHHMMSS>_kizunasync_sync.sql`, in UTC, the way the Supabase CLI orders
/// migrations.
pub(crate) fn migration_name(now_unix: i64) -> String {
    format!(
        "{}_{MIGRATION_LABEL}.sql",
        crate::clock::migration_version(now_unix)
    )
}
