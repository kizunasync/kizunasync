use std::path::PathBuf;

use crate::api_schemas::{PatchOutcome, patch_api_schemas, schemas_key_line};
use crate::commands::history_gate::push_written;
use crate::commands::{FAILURE, OK};
use crate::config_sql::{CronGate, config_from_proposals, render_config_sql};
use crate::constants::SCHEMA;
use crate::emit::{
    EmitPlan, PlannedFile, app_migration_names, config_already_emitted, config_migration_name,
    next_migration_second, plan_emit, plan_reapply,
};
use crate::env::Env;
use crate::error::Result;
use crate::migration_history::version_of;
use crate::pack::{self};
use crate::provision::{
    hash_pack_file, render_pack_file_ledger_sql, render_pack_file_ledger_upsert_sql,
};
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

use super::{Decided, DirectConnection, InitPorts};

const API_SCHEMAS_ABSENT: &str = concat!(
    "  supabase/config.toml not found, nothing to patch. Run `supabase init`, then add\n",
    "    schemas = [\"public\", \"graphql_public\", \"kizunasync\"]\n",
    "  under [api] and run `supabase config push` to carry it to your hosted project.\n",
    "  Without it PostgREST answers every kizunasync RPC with PGRST106."
);

/// The file is left untouched, so the line names the parse error to fix first.
fn api_schemas_unparseable(body: &str) -> String {
    let cause = crate::supabase_config::parse(body)
        .err()
        .map_or_else(String::new, |cause| format!(" ({cause})"));

    format!(
        "  supabase/config.toml does not parse{cause}: left untouched. Fix it, add\n\
         \x20   \"{SCHEMA}\"\n\
         \x20 to [api].schemas, then run `supabase config push`."
    )
}

// MARK: - emit planning

enum ApiSchemasPlan {
    Absent,
    Present {
        path: PathBuf,
        outcome: PatchOutcome,
        body: String,
    },
}

pub(crate) struct EmitContext {
    plan: crate::emit::EmitPlan,
    migrations_dir: PathBuf,
    config_migration_file_name: String,
    config_migration_skip: bool,
    /// The project-config migration this run would write: the proposals the
    /// wizard or the RLS read decided, rendered into the upserts that provision
    /// `kizunasync._config` and `kizunasync._settings`.
    config_sql: String,
    /// How many synced tables that migration provisions, for the plan line.
    synced_table_count: usize,
    api_schemas: ApiSchemasPlan,
}

impl EmitContext {
    /// The files this run writes, in the order they apply.
    fn written_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .plan
            .to_emit
            .iter()
            .map(|entry| entry.target_name.clone())
            .collect();
        if !self.config_migration_skip {
            names.push(self.config_migration_file_name.clone());
        }

        names
    }
}

/// Everything an install writes, resolved before anything is written: the pack
/// files to emit, the config migration derived from `decided`, and the
/// `[api].schemas` patch the project still needs. `Ok(None)` when this machine
/// carries no pack directory. `reapply` is a re-apply the user confirmed:
/// every pack file is written again as a new migration, whatever labels a
/// previous run left. The files are named from `now_unix` on, past every
/// version on disk and every one in `recorded`, the versions the migration
/// history held when the run read it.
///
/// # Errors
/// Returns whatever [`crate::pack::read_pack_files`] reports when a pack
/// directory was found but its manifest or SQL files could not be read.
/// `Ok(None)` means no pack directory was found at all, which is not an error:
/// callers print [`super::PACK_NOT_FOUND`] for that case, the same way
/// `run_remote_with` does for the standalone `resolve_pack_dir` lookup.
pub(crate) fn prepare_emit(
    paths: &ProjectPaths,
    env: &Env,
    decided: &Decided,
    now_unix: i64,
    recorded: &[String],
    reapply: bool,
) -> Result<Option<EmitContext>> {
    let Some(pack_dir) = pack::resolve_pack_dir(env) else {
        return Ok(None);
    };
    let pack_files = pack::read_pack_files(&pack_dir)?;
    let migrations_dir = paths.migrations_dir.clone();
    let existing = app_migration_names(&migrations_dir);
    let taken: Vec<String> = existing
        .iter()
        .filter_map(|name| version_of(name))
        .chain(recorded.iter().cloned())
        .collect();
    let base_secs = next_migration_second(now_unix, &taken);
    let plan = if reapply {
        plan_reapply(&pack_files, base_secs)
    } else {
        plan_emit(&pack_files, &existing, base_secs)
    };
    let config_offset = i64::try_from(plan.to_emit.len()).unwrap_or(0);
    let config = config_from_proposals(&decided.proposals, decided.settings.clone());

    Ok(Some(EmitContext {
        plan,
        migrations_dir,
        config_migration_file_name: config_migration_name(base_secs, config_offset),
        config_migration_skip: config_already_emitted(&existing),
        synced_table_count: config.tables.len(),
        config_sql: render_config_sql(&config, CronGate::from_allow_no_cron(decided.allow_no_cron)),
        api_schemas: plan_api_schemas(paths),
    }))
}

fn plan_api_schemas(paths: &ProjectPaths) -> ApiSchemasPlan {
    let path = paths.config_toml.clone();
    if !path.is_file() {
        return ApiSchemasPlan::Absent;
    }

    let Ok(body) = std::fs::read_to_string(&path) else {
        return ApiSchemasPlan::Absent;
    };

    let schemas_patch = patch_api_schemas(&body);

    ApiSchemasPlan::Present {
        path,
        outcome: schemas_patch.outcome,
        body: schemas_patch.body,
    }
}

fn describe_api_schemas(plan: &ApiSchemasPlan) -> String {
    match plan {
        ApiSchemasPlan::Absent => API_SCHEMAS_ABSENT.to_owned(),
        ApiSchemasPlan::Present { outcome, body, .. } => match outcome {
            PatchOutcome::AlreadyPresent => {
                format!("    = supabase/config.toml: [api].schemas already exposes {SCHEMA}")
            }
            PatchOutcome::Inserted => {
                format!("    ~ supabase/config.toml: would add \"{SCHEMA}\" to [api].schemas")
            }
            PatchOutcome::AddedKey => format!(
                "    ~ supabase/config.toml: would add {} under [api]",
                schemas_key_line()
            ),
            PatchOutcome::AddedSection => {
                format!("    ~ supabase/config.toml: would add an [api] section exposing {SCHEMA}")
            }
            PatchOutcome::Unparseable => api_schemas_unparseable(body),
        },
    }
}

/// Where one emitted file comes from: a pack file copied for the first time,
/// or one written again to re-apply it.
fn provenance(plan: &EmitPlan, entry: &PlannedFile) -> String {
    if plan.reapply {
        format!("re-applies {}", entry.source.name)
    } else {
        format!("from {}", entry.source.name)
    }
}

pub(crate) fn plan_text(emit: &EmitContext) -> String {
    let mut lines = Vec::new();
    for entry in &emit.plan.to_emit {
        lines.push(format!(
            "+ {}   ({})",
            entry.target_name,
            provenance(&emit.plan, entry)
        ));
    }
    for skipped in &emit.plan.skipped {
        lines.push(format!("= {skipped} (already emitted: skipped)"));
    }
    if emit.config_migration_skip {
        lines.push("= config migration (already emitted: skipped)".to_owned());
    } else {
        lines.push(format!(
            "+ {}   ({})",
            emit.config_migration_file_name,
            describe_synced_tables(emit.synced_table_count)
        ));
    }
    lines.push(describe_api_schemas(&emit.api_schemas).trim().to_owned());
    lines.join("\n")
}

/// What the config migration provisions, for the one line that names it.
fn describe_synced_tables(count: usize) -> String {
    format!("{count} synced table(s) → kizunasync._config")
}

/// Print what an install would write, write nothing, and return the exit code
/// the command ends on.
pub(crate) fn print_dry_run(emit: &EmitContext, ui: &mut Ui) -> i32 {
    ui.log("  --dry-run: nothing will be written.\n");
    ui.log("  SQL pack to emit:");
    for entry in &emit.plan.to_emit {
        ui.log(&format!(
            "    + {}   ({})",
            entry.target_name,
            provenance(&emit.plan, entry)
        ));
    }
    for skipped in &emit.plan.skipped {
        ui.log(&format!("    = {skipped} (already emitted: skipped)"));
    }
    if emit.config_migration_skip {
        ui.log("    = config migration (already emitted: skipped)");
    } else {
        ui.log(&format!(
            "    + {}   ({})",
            emit.config_migration_file_name,
            describe_synced_tables(emit.synced_table_count)
        ));
        ui.log("  --- generated project-config SQL ---");
        ui.write_stdout(&format!("{}\n", emit.config_sql));
    }
    ui.log(&describe_api_schemas(&emit.api_schemas));

    OK
}

/// Patch `[api].schemas`, write every planned migration, and apply them with
/// `supabase db push` to the database `direct` names. `None` is a
/// `--local-only` run, which applies nothing and has no database to name.
/// `yes` is a run told to write without asking: a failed push asks nothing
/// either. Returns the exit code the command ends on.
pub(crate) fn perform_writes(
    emit: &EmitContext,
    direct: Option<&DirectConnection>,
    paths: &ProjectPaths,
    ports: &mut InitPorts<'_>,
    yes: bool,
    ui: &mut Ui,
) -> i32 {
    apply_api_schemas(&emit.api_schemas, ui);

    if let Some(code) = write_pack_migrations(emit, ui) {
        return code;
    }
    if let Some(code) = write_config_migration(emit, ui) {
        return code;
    }

    let Some(direct) = direct else {
        ui.log(
            "\n  --local-only: migrations written but NOT applied. Run `supabase db push` yourself.",
        );

        return OK;
    };

    let mut unasked = None;
    let prompter = if yes {
        &mut unasked
    } else {
        &mut ports.prompter
    };
    if let Err(code) = push_written(
        direct,
        paths,
        &emit.written_names(),
        ports.schemas,
        ports.supabase,
        prompter,
        ui,
    ) {
        return code;
    }
    ui.log(&format!(
        "\n  applied via supabase db push {}. Run `kizunasync doctor` to verify.",
        direct.push.describe()
    ));

    OK
}

/// Create the migrations directory and write every planned pack file: its SQL
/// then its ledger row, an upsert when the file re-applies the pack. No file
/// opens a transaction of its own, because `supabase db push` runs each one
/// in its own. `Some` is the exit code `perform_writes` should return
/// immediately; `None` means every file landed (or there was none to write).
fn write_pack_migrations(emit: &EmitContext, ui: &mut Ui) -> Option<i32> {
    if let Err(cause) = std::fs::create_dir_all(&emit.migrations_dir) {
        ui.error(&format!(
            "\n  could not create migrations directory: {cause}"
        ));

        return Some(FAILURE);
    }

    for entry in &emit.plan.to_emit {
        let hash = hash_pack_file(&entry.source.sql);
        let ledger = if emit.plan.reapply {
            render_pack_file_ledger_upsert_sql(&entry.source.name, &hash)
        } else {
            render_pack_file_ledger_sql(&entry.source.name, &hash)
        };
        let body = format!("{}\n{ledger}\n", entry.source.sql);
        if let Err(cause) = std::fs::write(emit.migrations_dir.join(&entry.target_name), body) {
            ui.error(&format!(
                "\n  could not emit {}: {cause}",
                entry.target_name
            ));

            return Some(FAILURE);
        }
        if emit.plan.reapply {
            ui.log(&format!(
                "  emitted {} ({})",
                entry.target_name,
                provenance(&emit.plan, entry)
            ));
        } else {
            ui.log(&format!("  emitted {}", entry.target_name));
        }
    }
    for skipped in &emit.plan.skipped {
        ui.log(&format!("  skipped {skipped} (already emitted)"));
    }

    None
}

/// Write the config migration unless a previous run already emitted it.
/// `Some` is the exit code `perform_writes` should return immediately; `None`
/// means it either wrote cleanly or was skipped.
fn write_config_migration(emit: &EmitContext, ui: &mut Ui) -> Option<i32> {
    if emit.config_migration_skip {
        ui.log("  skipped config migration (already emitted)");

        return None;
    }

    if let Err(cause) = std::fs::write(
        emit.migrations_dir.join(&emit.config_migration_file_name),
        &emit.config_sql,
    ) {
        ui.error(&format!(
            "\n  could not emit {}: {cause}",
            emit.config_migration_file_name
        ));

        return Some(FAILURE);
    }
    ui.log(&format!(
        "  emitted {} ({})",
        emit.config_migration_file_name,
        describe_synced_tables(emit.synced_table_count)
    ));

    None
}

fn apply_api_schemas(plan: &ApiSchemasPlan, ui: &mut Ui) {
    match plan {
        ApiSchemasPlan::Absent => ui.log(API_SCHEMAS_ABSENT),
        ApiSchemasPlan::Present {
            path,
            outcome,
            body,
        } => match outcome {
            PatchOutcome::Unparseable => ui.log(&api_schemas_unparseable(body)),
            PatchOutcome::AlreadyPresent => {
                ui.log(&format!(
                    "  supabase/config.toml already exposes {SCHEMA}: left untouched"
                ));
            }
            PatchOutcome::Inserted | PatchOutcome::AddedKey | PatchOutcome::AddedSection => {
                match std::fs::write(path, body) {
                    Ok(()) => ui.log(&format!(
                        "  patched supabase/config.toml ([api].schemas += \"{SCHEMA}\")"
                    )),
                    Err(cause) => {
                        ui.warn(&format!("  could not patch supabase/config.toml: {cause}"));
                    }
                }
            }
        },
    }
}
