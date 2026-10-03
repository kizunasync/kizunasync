//! `init`: provision Kizuna into your Supabase project.
//!
//! Detect the app, propose synced tables from RLS policies (or a TTY wizard),
//! emit the SQL pack plus the migration that provisions those tables into
//! `kizunasync._config`, patch `[api].schemas`, and apply via `supabase db push`
//! unless `--local-only` or `--project-ref` (Management API only).

use std::path::Path;

use crate::applier::Applier;
use crate::commands::{FAILURE, OK, UNUSABLE};
use crate::config_sql::SYNCED_TABLE_SCHEMA;
use crate::constants::SCHEMA;
use crate::detect::{Detection, KizunaPackages, PACKAGE_JSON, detect_project};
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::prompts::BackKey;
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

mod decide;
mod emit;
mod flags;
mod remote;
mod wizard;

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

pub(crate) use decide::*;
pub(crate) use emit::*;
pub(crate) use flags::*;
pub use flags::{InitFlags, InitPorts, NO_CONNECTION_ENTERED};
pub(crate) use remote::*;
pub(crate) use wizard::*;
pub use wizard::{
    ConnectionAnswers, DirectChoice, DirectConnection, RemoteCredential, WizardConnection,
    cancel_or_stop, choose_connection, decided_without_asking, direct_connection_for,
    run_with_connection, stop_for,
};

// MARK: - copy

const PACK_NOT_FOUND: &str = concat!(
    "  could not locate the Kizuna SQL pack (pack.manifest.json). Set KSYNC_PACK_DIR;\n",
    "  a published CLI bundles the pack at publish time, and a cargo dev build inside\n",
    "  this checkout finds it at packages/supabase-pack."
);

const CONFIRM_REFUSAL: &str = concat!(
    "  refusing to write without confirmation: re-run with --yes to accept the\n",
    "  proposals above (or --dry-run to preview), or run in a terminal for the\n",
    "  interactive wizard."
);

const CANCELLED: &str = "  cancelled, nothing written.";

/// What a run has applied by the time a later question stops it: nothing, or
/// the pack re-apply the Management API path runs before its wizard. The stop
/// line says which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Written {
    /// Nothing reached the database.
    Nothing,
    /// The pack ran again and the ledger records its hash.
    PackReapply,
}

impl Written {
    /// The line a cancel or a decline ends on.
    pub(crate) const fn cancelled(self) -> &'static str {
        match self {
            Self::Nothing => CANCELLED,
            Self::PackReapply => {
                "  cancelled: the pack re-apply was applied, nothing else was written."
            }
        }
    }

    /// The line an empty table selection ends on.
    pub(crate) const fn no_tables(self) -> &'static str {
        match self {
            Self::Nothing => "  no tables selected, nothing written.",
            Self::PackReapply => {
                "  no tables selected: the pack re-apply was applied, nothing else was written."
            }
        }
    }

    /// The line that closes the wizard on a cancel.
    pub(crate) const fn outro(self) -> &'static str {
        match self {
            Self::Nothing => "Nothing written.",
            Self::PackReapply => "Pack re-applied, nothing else written.",
        }
    }
}

/// What an install without `pg_cron` is told, verbatim: the extension, where it
/// is enabled, and the flag that installs without it.
const PG_CRON_REFUSAL: &str = concat!(
    "pg_cron is not enabled: enable it under Integrations > Cron in the Supabase dashboard, ",
    "then rerun; pass --allow-no-cron to install without scheduled retention"
);

/// What `--allow-no-cron` prints instead: the three functions the scheduler
/// would have scheduled, and the command that runs them.
const PG_CRON_BY_HAND: &str = concat!(
    "  pg_cron is not enabled, so nothing is scheduled. Run retention yourself:\n",
    "    select kizunasync.reap_tombstones();\n",
    "    select kizunasync.compact_changelog();\n",
    "    select kizunasync.prune_clients();\n",
    "  or `kizunasync jobs run all` on a schedule of your own."
);

// MARK: - the pg_cron gate

/// Whether the three retention jobs can be scheduled at all.
///
/// The pack's `_schedule_jobs()` writes nothing when the extension is absent,
/// so an install that silently accepted that would keep tombstones, changelog
/// rows and dead clients forever. Runs after the pack is applied, on both
/// transports.
pub(crate) fn verify_pg_cron(applier: &dyn Applier, allow_no_cron: bool, ui: &mut Ui) -> i32 {
    report_pg_cron(
        crate::provision::read_pg_cron_present(applier),
        allow_no_cron,
        ui,
    )
}

/// The same gate over a presence read another port already made.
pub(crate) fn report_pg_cron(
    present: crate::error::Result<bool>,
    allow_no_cron: bool,
    ui: &mut Ui,
) -> i32 {
    match present {
        Ok(true) => {
            ui.log(&format!(
                "  pg_cron:          enabled, {SCHEMA} schedules its three retention jobs"
            ));

            OK
        }
        Ok(false) if allow_no_cron => {
            ui.warn(PG_CRON_BY_HAND);

            OK
        }
        Ok(false) => {
            ui.error(&format!("\n  {PG_CRON_REFUSAL}"));

            FAILURE
        }
        Err(cause) if allow_no_cron => {
            ui.warn(&format!(
                "  could not check pg_cron ({cause}).\n{PG_CRON_BY_HAND}"
            ));

            OK
        }
        Err(cause) => {
            ui.error(&format!(
                "\n  could not check whether pg_cron is enabled:\n    {cause}\n  \
                 pass --allow-no-cron to install without scheduled retention."
            ));

            FAILURE
        }
    }
}

// MARK: - run

/// The working directory, resolved project root, and env sources every
/// DB-backed step of `init` reads, gathered so the command's own functions
/// carry one context param instead of four loose ones.
pub struct RunContext<'a> {
    pub(crate) cwd: &'a Path,
    pub(crate) paths: &'a ProjectPaths,
    pub(crate) env: &'a Env,
    pub(crate) env_files: &'a EnvFileValues,
}

/// [`RunContext`] without `cwd`/`env_files`: what's left once a connection is
/// already chosen and only introspection, not discovery, remains.
pub(crate) struct ConnectContext<'a> {
    pub(crate) paths: &'a ProjectPaths,
    pub(crate) env: &'a Env,
    /// Whether a question before this step can take the run back: No at the
    /// pack gate returns there when it can.
    pub(crate) back: BackKey,
}

/// Run the command against `context.cwd` and the resolved project root,
/// reporting through `ui`.
pub fn run(
    flags: &InitFlags,
    context: &RunContext<'_>,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    if flags.project_ref.is_some() && flags.local_only {
        ui.log(
            "kizunasync init: --project-ref and --local-only are mutually exclusive. --project-ref\n\
             \x20 provisions the hosted project over the Management API and writes no local files,\n\
             \x20 while --local-only only writes local files. Pick one.",
        );

        return UNUSABLE;
    }

    if let Some(code) = refuse_unsupported_schema(flags, ui) {
        return code;
    }

    if let Some(refusal) = flags.settings.refuse_require_atomic() {
        ui.log(&format!(
            "kizunasync init: {refusal} Use --no-require-atomic (the default)."
        ));

        return UNUSABLE;
    }

    // The pack's own check constraint refuses a batch size below one.
    if let Some(refusal) = flags.settings.refuse_max_batch_size() {
        ui.log(&format!(
            "kizunasync init: {refusal} Use --no-max-batch-size for unlimited."
        ));

        return UNUSABLE;
    }

    // Every other knob carries its own complete refusal, schedules included.
    if let Some(refusal) = flags
        .settings
        .refuse_out_of_range()
        .or_else(|| flags.options.refuse_out_of_range())
        .or_else(|| flags.options.refuse_invalid_identifiers())
    {
        ui.log(&format!("kizunasync init: {refusal}"));

        return UNUSABLE;
    }

    report_header(&describe_mode(flags), context.cwd, context.paths, ui);

    if let Some(project_ref) = flags.project_ref.as_ref() {
        return run_remote(flags, context.env, project_ref, ports, ui);
    }

    let use_wizard = ports.prompter.is_some() && !flags.yes && !flags.local_only && !flags.dry_run;
    if use_wizard {
        return run_wizard(
            flags,
            context.paths,
            context.env,
            context.env_files,
            ports,
            ui,
        );
    }

    run_non_interactive(flags, context, ports, ui)
}

/// The pack addresses `public.<table>` in every trigger, render and delete
/// path, so a synced table lives in `public` and nowhere else. The flag stays
/// because that value is the documented one, not because there is a choice.
fn refuse_unsupported_schema(flags: &InitFlags, ui: &mut Ui) -> Option<i32> {
    if flags.schema == SYNCED_TABLE_SCHEMA {
        return None;
    }

    ui.log(&format!(
        "kizunasync init: --schema {} is not supported: the pack addresses {SYNCED_TABLE_SCHEMA}.<table> in every trigger and RPC, so a synced table lives in {SYNCED_TABLE_SCHEMA}.",
        flags.schema
    ));

    Some(UNUSABLE)
}

/// What every `init` run opens with, whichever entry point reached it: the
/// banner, what the project looks like, and `mode`, the transport that will
/// actually be used (the caller decides that text: the flags-only path from
/// [`describe_mode`], a connection already chosen from `describe_connection_mode`).
fn report_header(mode: &str, cwd: &Path, paths: &ProjectPaths, ui: &mut Ui) {
    let detection = detect_project(cwd, paths);
    ui.log("kizunasync init: provisioning Kizuna into this project\n");
    report_detection(&detection, ui);
    ui.log(&format!("  mode:             {mode}\n"));
}

fn report_detection(detection: &Detection, ui: &mut Ui) {
    let integrations: Vec<String> = detection
        .integrations
        .iter()
        .map(|detected| {
            format!(
                "{} ({})",
                versioned(detected.integration.as_str(), detected.version.as_deref()),
                detected.evidence
            )
        })
        .collect();
    ui.log(&format!(
        "  integrations:     {}",
        if integrations.is_empty() {
            "none recognized".to_owned()
        } else {
            integrations.join(", ")
        }
    ));

    if !detection.toolchains.is_empty() {
        let toolchains: Vec<String> = detection
            .toolchains
            .iter()
            .map(|toolchain| versioned(toolchain.name, toolchain.version.as_deref()))
            .collect();
        ui.log(&format!("  toolchain:        {}", toolchains.join(", ")));
    }

    ui.log(&format!(
        "  kizuna packages:  {}",
        describe_kizuna_packages(&detection.kizuna)
    ));
    ui.log(&format!(
        "  package manager:  {}",
        describe_package_manager(detection)
    ));
    ui.log(&format!(
        "  supabase/ dir:    {}",
        if detection.has_supabase_dir {
            "present"
        } else {
            "missing"
        }
    ));
    ui.log(&format!(
        "  Database types:   {}",
        detection
            .database_types_path
            .as_deref()
            .unwrap_or("not found")
    ));
}

fn versioned(name: &str, version: Option<&str>) -> String {
    version.map_or_else(|| name.to_owned(), |version| format!("{name} {version}"))
}

fn describe_kizuna_packages(kizuna: &KizunaPackages) -> String {
    let installed: Vec<String> = kizuna
        .installed
        .iter()
        .map(|package| versioned(&package.name, package.version.as_deref()))
        .collect();
    let missing = kizuna.missing.join(", ");

    match (installed.is_empty(), kizuna.missing.is_empty()) {
        (true, true) => "none installed".to_owned(),
        (true, false) => format!("none installed; missing {missing}"),
        (false, true) => format!("{}; all installed", installed.join(", ")),
        (false, false) => format!("{}; missing {missing}", installed.join(", ")),
    }
}

/// A parsed `package.json` always yields a JavaScript integration, vanilla at
/// least, so its evidence tells an absent manifest from an unpinned one.
fn describe_package_manager(detection: &Detection) -> String {
    if let Some(manager) = &detection.package_manager {
        return format!(
            "{} ({})",
            versioned(manager.kind.as_str(), manager.version.as_deref()),
            manager.source
        );
    }

    let has_manifest = detection
        .integrations
        .iter()
        .any(|detected| detected.evidence == PACKAGE_JSON);
    if has_manifest {
        "none found (no packageManager field or lockfile)".to_owned()
    } else {
        "none (no package.json)".to_owned()
    }
}

fn describe_mode(flags: &InitFlags) -> String {
    let suffix = if flags.dry_run { " (dry-run)" } else { "" };
    if let Some(project_ref) = &flags.project_ref {
        return format!("remote: project {project_ref}{suffix}");
    }

    format!(
        "{}{suffix}",
        if flags.local_only {
            "local-only"
        } else {
            "migrations, applied with supabase db push"
        }
    )
}
