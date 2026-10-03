use crate::commands::panel::equivalent::Reach;
use crate::commands::reconcile::{Gated, PackGate, ReapplyVia, ask_pack_gate, gate_pack};
use crate::commands::table_checks::{
    refuse_rls_disabled, refuse_unkeyed, rekeyed_proposals, review_proposal_keys,
    warn_unscoped_proposals,
};
use crate::commands::{FAILURE, OK, UNUSABLE, refuse_newer_ledger};
use crate::config::{KizunaSyncConfig, ProjectSettings, load_synced_tables};
use crate::config_sql::{CronGate, render_config_sql_rekeying};
use crate::constants::SCHEMA;
use crate::env::Env;
use crate::management::{
    ExposeOutcome, ManagementApi, ReqwestTransport, redact_access_token, resolve_access_token,
};
use crate::pack::{self, PackFile};
use crate::project_ref::ProjectRef;
use crate::prompts::PromptError;
use crate::proposals::{SchemaCatalog, describe_key_columns, introspect_catalog};
use crate::provision::{
    LedgerRow, LedgerState, Plan, apply_provision, plan_provision, read_ledger_rows,
    read_ledger_state, read_missing_core_rpcs,
};
use crate::server_facts::read_server_facts;
use crate::ui::Ui;
use crate::verify::{describe_gaps, read_provisioning_gaps};
use crate::wizard::settings_note;

use super::{
    CANCELLED, Decided, InitFlags, InitPorts, InteractiveDecision, Introspection, PACK_NOT_FOUND,
    RemoteCredential, STEP_BACK, Written, cancel_or_stop_after, decide_from_flags,
    recorded_contract, stop_for, verify_pg_cron,
};

const REMOTE_CONFIRM_REFUSAL: &str = concat!(
    "\n  refusing to apply without confirmation: re-run with --yes (or run it in a\n",
    "  terminal to confirm interactively)."
);

// MARK: - remote provision

pub(crate) fn run_remote(
    flags: &InitFlags,
    env: &Env,
    project_ref: &ProjectRef,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let token = match resolve_access_token(flags.access_token.as_deref(), env) {
        Ok(token) => token,
        Err(cause) => {
            ui.log(&format!("  {cause}"));

            return UNUSABLE;
        }
    };

    let credential = RemoteCredential {
        token: token.token,
        origin: token.source.to_string(),
    };
    let pack_files = match load_pack(env, ui) {
        Ok(files) => files,
        Err(code) => return code,
    };
    let api = match open_api(project_ref, &credential, ui) {
        Ok(api) => api,
        Err(code) => return code,
    };
    // The wizard tests its project while choosing it; the flag path does it here.
    match read_server_facts(&api) {
        Ok(facts) => ui.log(&format!("  connected:        {}", facts.describe())),
        Err(cause) => {
            ui.error(&format!(
                "  could not connect to the database:\n    {}",
                redact_access_token(&cause.to_string(), &credential.token)
            ));

            return UNUSABLE;
        }
    }

    settle_step_back(
        provision_over(flags, &api, &pack_files, &credential, ports, ui),
        ui,
    )
}

/// The flag-driven path has no earlier step to rewind to, so Backspace ends it
/// the way its final confirm does: declined, nothing written.
pub(crate) fn settle_step_back(code: i32, ui: &mut Ui) -> i32 {
    if code != STEP_BACK {
        return code;
    }

    ui.log(CANCELLED);

    OK
}

/// The Management API path, once a token exists: reached from `--project-ref`
/// with a resolved token, and from the wizard with a discovered one. Returns
/// the exit code the command ends on, with every failure already reported on
/// the [`Ui`] and the token masked out of it.
pub(crate) fn run_remote_with(
    flags: &InitFlags,
    env: &Env,
    project_ref: &ProjectRef,
    credential: &RemoteCredential,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let pack_files = match load_pack(env, ui) {
        Ok(files) => files,
        Err(code) => return code,
    };
    let api = match open_api(project_ref, credential, ui) {
        Ok(api) => api,
        Err(code) => return code,
    };

    provision_over(flags, &api, &pack_files, credential, ports, ui)
}

/// The shipped SQL pack, or the exit code once the reason is on the [`Ui`].
fn load_pack(env: &Env, ui: &mut Ui) -> Result<Vec<PackFile>, i32> {
    let Some(pack_dir) = pack::resolve_pack_dir(env) else {
        ui.log(PACK_NOT_FOUND);

        return Err(UNUSABLE);
    };

    pack::read_pack_files(&pack_dir).map_err(|cause| {
        ui.error(&format!("  {cause}"));

        UNUSABLE
    })
}

/// Name the token's rung, then bind the Management API to the project.
fn open_api(
    project_ref: &ProjectRef,
    credential: &RemoteCredential,
    ui: &mut Ui,
) -> Result<ManagementApi<ReqwestTransport>, i32> {
    ui.log(&format!("  access token:     {}", credential.origin));

    let http = ReqwestTransport::new().map_err(|cause| {
        ui.error(&format!("  {cause}"));

        UNUSABLE
    })?;

    Ok(ManagementApi::new(
        http,
        &credential.token,
        project_ref,
        None,
    ))
}

/// Provision over `api`, masking the token out of any failure.
fn provision_over(
    flags: &InitFlags,
    api: &ManagementApi<ReqwestTransport>,
    pack_files: &[PackFile],
    credential: &RemoteCredential,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    match provision_remotely(flags, api, pack_files, ports, ui) {
        Ok(code) => code,
        Err(cause) => {
            ui.error(&format!(
                "\n  {}",
                redact_access_token(&cause.to_string(), &credential.token)
            ));

            FAILURE
        }
    }
}

/// Plan the install against a hosted project, confirm it, and apply the pack
/// and the config SQL through the Management API, a fresh install as one
/// transaction. Returns the exit code the command ends on: a question the
/// user cancelled ends on `0`, and one the session cannot ask on `2`.
///
/// # Errors
/// Returns [`Error::Transport`](crate::error::Error::Transport) when a
/// Management API call fails, [`Error::Sql`](crate::error::Error::Sql) when it
/// relays a statement the database refused,
/// [`Error::Provision`](crate::error::Error::Provision)
/// when the install rolled back, and
/// [`Error::Boundary`](crate::error::Error::Boundary) when a ledger or catalog
/// row does not carry the columns the pack defines. The caller masks the token
/// out of the message before printing it.
pub(crate) fn provision_remotely<T: crate::management::HttpTransport>(
    flags: &InitFlags,
    api: &ManagementApi<T>,
    pack_files: &[PackFile],
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> crate::error::Result<i32> {
    let (plan, decided, config_sql) = match plan_then_confirm(flags, api, pack_files, ports, ui)? {
        Ok(result) => result,
        Err(code) => return Ok(code),
    };

    apply_and_report(api, &plan, &decided, &config_sql, ui)?;
    let pack_expected = match &plan {
        Plan::ProvisionedUnversioned { .. } => None,
        Plan::Apply { .. } | Plan::UpToDate { .. } | Plan::Drift { .. } => {
            Some(pack_files.to_vec())
        }
    };
    let gaps = read_provisioning_gaps(api, &decided.expectation(pack_expected))?;
    if !gaps.is_empty() {
        ui.error(&describe_gaps(&gaps));

        return Ok(FAILURE);
    }
    loop {
        let code = verify_pg_cron(api, decided.allow_no_cron, ui);
        // `--yes` never prompts, so a failed check is final there.
        if code == OK || flags.yes || !crate::prompts::confirm_retry(&mut ports.prompter) {
            return Ok(code);
        }
    }
}

/// Read the ledger, plan what to provision, and get through the wizard and
/// its confirmation. A ledger a newer kizunasync recorded is refused before
/// anything else, and one that differs from this CLI's pack goes through the
/// pack gate first ([`gate_pack`]). A re-apply that leaves the ledger
/// differing meets the gate's refusal. `Ok(Err(code))` carries an exit code to
/// return immediately (a refusal, [`STEP_BACK`] for a declined re-apply,
/// `--dry-run`, or a declined confirmation); `Ok(Ok(..))` carries what
/// [`apply_and_report`] needs.
fn plan_then_confirm<T: crate::management::HttpTransport>(
    flags: &InitFlags,
    api: &ManagementApi<T>,
    pack_files: &[PackFile],
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> crate::error::Result<std::result::Result<(Plan, Decided, String), i32>> {
    ui.log(&format!("  {}", describe_exposure_preview(api)?));

    let rows = read_ledger_rows(api)?;
    if let Some(code) = refuse_newer_ledger(&rows, ui) {
        return Ok(Err(code));
    }
    let mut plan = plan_remotely(api, pack_files, &rows, ui)?;
    // `--yes` answers without asking and a dry run asks nothing, so both meet
    // the pack gate the way a session without a terminal does: refused with
    // the command that re-applies the pack, and nothing run.
    let mut unasked = None;
    let prompter = if flags.yes || flags.dry_run {
        &mut unasked
    } else {
        &mut ports.prompter
    };
    let gated = gate_pack(&remote_gate(flags, api, &plan, &rows), prompter, ui);
    let written = match gated {
        Ok(Gated::Clear) => Written::Nothing,
        Ok(Gated::Reapply) => {
            let rows = read_ledger_rows(api)?;
            plan = plan_remotely(api, pack_files, &rows, ui)?;
            if let Err(code) = ask_pack_gate(&remote_gate(flags, api, &plan, &rows), &mut None, ui)
            {
                return Ok(Err(code));
            }
            Written::PackReapply
        }
        Ok(Gated::Declined) => return Ok(Err(STEP_BACK)),
        Err(end) => return Ok(Err(end.code())),
    };

    let file_count = match &plan {
        Plan::Apply { files } => files.len(),
        Plan::UpToDate { .. } | Plan::ProvisionedUnversioned { .. } | Plan::Drift { .. } => 0,
    };
    let synced = recorded_contract(&rows, || {
        load_synced_tables(api).map(|tables| KizunaSyncConfig {
            tables,
            settings: None,
        })
    })?;
    let use_wizard = ports.prompter.is_some() && !flags.yes && !flags.dry_run;
    let decided = if use_wizard {
        walk_and_confirm(flags, api, file_count, written, &synced, ports, ui)?
    } else {
        decide_unasked(flags, api, &synced, ui)?
    };

    Ok(decided.map(|(decided, config_sql)| (plan, decided, config_sql)))
}

/// The pack gate over `plan`, planned against `rows`, through `api`.
fn remote_gate<'a, T: crate::management::HttpTransport + 'a>(
    flags: &'a InitFlags,
    api: &'a ManagementApi<T>,
    plan: &'a Plan,
    rows: &'a [LedgerRow],
) -> PackGate<'a> {
    PackGate {
        plan: Some(plan),
        rows,
        applier: api,
        via: ReapplyVia::ManagementApi,
        reach: flags.project_ref.as_ref().map(Reach::ProjectRef),
        allow_no_cron: flags.allow_no_cron,
    }
}

/// The project config the decided tables and settings provision.
fn remote_config_sql(decided: &Decided) -> String {
    render_config_sql_rekeying(
        &crate::config_sql::config_from_proposals(&decided.proposals, decided.settings.clone()),
        CronGate::from_allow_no_cron(decided.allow_no_cron),
        &decided.rekeyed,
    )
}

/// The flag path: RLS policies propose the tables and nothing is asked. A
/// dry run prints the config SQL and stops; a run without `--yes` has nobody
/// to confirm with and refuses. `synced` is the contract the project already
/// records, which a moved key is checked against.
fn decide_unasked<T: crate::management::HttpTransport>(
    flags: &InitFlags,
    api: &ManagementApi<T>,
    synced: &KizunaSyncConfig,
    ui: &mut Ui,
) -> crate::error::Result<std::result::Result<(Decided, String), i32>> {
    let catalog = introspect_catalog(api, &flags.schema)?;
    let mut decided = decide_from_flags(flags, &catalog);
    describe_config_plan(&decided, ui);
    let tables = || {
        decided
            .proposals
            .iter()
            .map(|proposal| proposal.table.as_str())
    };
    if let Some(code) = refuse_unkeyed(tables(), &catalog, ui)
        .or_else(|| refuse_rls_disabled(tables(), &catalog.rls_disabled, flags.allow_no_rls, ui))
        .or_else(|| review_proposal_keys(&decided.proposals, ui))
    {
        return Ok(Err(code));
    }
    decided.rekeyed = match rekeyed_proposals(&decided.proposals, synced, ui) {
        Ok(rekeyed) => rekeyed,
        Err(code) => return Ok(Err(code)),
    };
    let config_sql = remote_config_sql(&decided);

    warn_unscoped_proposals(&decided.proposals, ui);

    if flags.dry_run {
        ui.log("  --- generated project-config SQL ---");
        ui.write_stdout(&format!("{config_sql}\n"));
        ui.log("  --dry-run: nothing was changed.");

        return Ok(Err(OK));
    }

    if !flags.yes {
        ui.log(REMOTE_CONFIRM_REFUSAL);

        return Ok(Err(UNUSABLE));
    }

    Ok(Ok((decided, config_sql)))
}

/// The wizard, then the confirmation as its last step: Backspace on the
/// confirmation reopens the step before it with every answer kept.
/// `Ok(Err(code))` is the exit the wizard or the confirmation stopped on,
/// its reason already on the [`Ui`]: `0` for a cancel or a decline, `2` for
/// a question the session cannot ask, [`STEP_BACK`] for Backspace on the
/// table list. `written` is what the run applied before the walk: after the
/// pack re-apply, a cancel or a decline says it was applied and nothing else
/// was written, and Backspace on the table list ends the run the same way
/// rather than reopening a connection the run has already written to.
fn walk_and_confirm<T: crate::management::HttpTransport>(
    flags: &InitFlags,
    api: &ManagementApi<T>,
    file_count: usize,
    written: Written,
    synced: &KizunaSyncConfig,
    ports: &mut InitPorts<'_>,
    ui: &mut Ui,
) -> crate::error::Result<std::result::Result<(Decided, String), i32>> {
    let introspection = Introspection {
        introspect: &|schema: &str| {
            introspect_catalog(api, schema) as crate::error::Result<SchemaCatalog>
        },
        recorded: synced,
    };
    let Some(prompter) = ports.prompter.as_deref_mut() else {
        return Ok(Err(stop_for(&PromptError::NotInteractive, ui)));
    };
    let mut wizard = match InteractiveDecision::open(flags, &introspection, written, prompter, ui) {
        Ok(wizard) => wizard,
        Err(code) => return Ok(Err(settle_after(code, written, ui))),
    };
    loop {
        let decided = match wizard.decide(prompter, ui) {
            Ok(decided) => decided,
            Err(code) => return Ok(Err(settle_after(code, written, ui))),
        };
        let config_sql = remote_config_sql(&decided);
        describe_config_plan(&decided, ui);
        let _ = prompter.note(
            "Plan",
            &settings_note(
                decided
                    .settings
                    .as_ref()
                    .unwrap_or(&ProjectSettings::default()),
                decided.allow_no_cron,
            ),
        );
        match prompter.confirm(
            &format!(
                "Apply {file_count} pack file(s) and {} to this project now?",
                describe_synced_tables(decided.proposals.len())
            ),
            false,
        ) {
            Ok(true) => return Ok(Ok((decided, config_sql))),
            Ok(false) => {
                ui.log(written.cancelled());

                return Ok(Err(OK));
            }
            Err(PromptError::Back) => wizard.reopen_before_confirm(),
            Err(PromptError::NotInteractive) => {
                ui.log(REMOTE_CONFIRM_REFUSAL);

                return Ok(Err(UNUSABLE));
            }
            Err(error) => {
                return Ok(Err(cancel_or_stop_after(prompter, &error, written, ui)));
            }
        }
    }
}

/// Backspace on the table list after the pack re-apply ends the run on the
/// decline's line and exit; every other code passes through.
fn settle_after(code: i32, written: Written, ui: &mut Ui) -> i32 {
    if code == STEP_BACK && written == Written::PackReapply {
        ui.log(written.cancelled());

        return OK;
    }

    code
}

/// Plan the pack against the ledger's `rows` and describe the plan.
fn plan_remotely<T: crate::management::HttpTransport>(
    api: &ManagementApi<T>,
    pack_files: &[PackFile],
    rows: &[LedgerRow],
    ui: &mut Ui,
) -> crate::error::Result<Plan> {
    let plan = verify_core_rpcs(plan_provision(pack_files, rows), api)?;
    describe_remote_plan(&plan, ui);

    Ok(plan)
}

/// Apply the plan and the project-config SQL, a fresh install as one
/// transaction, then expose the schema, and report what happened. The
/// exposure waits for the committed transaction, so a failed install never
/// leaves the Data API serving a schema that is not there. The `pg_cron`
/// check is the caller's, so a missing extension can be retried without
/// applying the pack again.
fn apply_and_report<T: crate::management::HttpTransport>(
    api: &ManagementApi<T>,
    plan: &Plan,
    decided: &Decided,
    config_sql: &str,
    ui: &mut Ui,
) -> crate::error::Result<()> {
    let applied = apply_provision(plan, config_sql, api)?;
    for name in &applied {
        ui.log(&format!("  applied {name}"));
    }
    ui.log(&format!(
        "  applied the project config ({})",
        describe_synced_tables(decided.proposals.len())
    ));
    ui.log(&format!("  {}", describe_exposure_apply(api)?));
    report_remote_ledger(api, ui)?;

    Ok(())
}

/// What the config SQL provisions, for the line that names it.
fn describe_synced_tables(count: usize) -> String {
    format!("{count} synced table(s) → kizunasync._config")
}

fn describe_config_plan(decided: &Decided, ui: &mut Ui) {
    ui.log("\n  project config:");
    for proposal in &decided.proposals {
        ui.log(&format!(
            "    + {}   key {}   {}",
            proposal.table,
            describe_key_columns(&proposal.key_columns()),
            proposal.provenance
        ));
    }
    if decided
        .settings
        .as_ref()
        .is_some_and(ProjectSettings::is_any_set)
    {
        ui.log("    ~ kizunasync._settings (the knobs this run declared)");
    }
}

fn describe_exposure_preview<T: crate::management::HttpTransport>(
    api: &ManagementApi<T>,
) -> crate::error::Result<String> {
    let exposed = api.exposed_schemas()?;

    Ok(if exposed.iter().any(|entry| entry == SCHEMA) {
        format!("Data API:         {SCHEMA} is already exposed")
    } else {
        format!("Data API:         would add {SCHEMA} to the exposed schemas")
    })
}

fn describe_exposure_apply<T: crate::management::HttpTransport>(
    api: &ManagementApi<T>,
) -> crate::error::Result<String> {
    match api.expose_schema(SCHEMA)? {
        ExposeOutcome::AlreadyPresent => {
            Ok(format!("Data API:         {SCHEMA} is already exposed"))
        }
        ExposeOutcome::Added => Ok(format!(
            "Data API:         added {SCHEMA} to the exposed schemas"
        )),
    }
}

fn verify_core_rpcs(plan: Plan, api: &dyn crate::applier::Applier) -> crate::error::Result<Plan> {
    let Plan::ProvisionedUnversioned {
        files,
        recorded_objects,
    } = plan
    else {
        return Ok(plan);
    };

    let missing = read_missing_core_rpcs(api)?;
    if missing.is_empty() {
        return Ok(Plan::ProvisionedUnversioned {
            files,
            recorded_objects,
        });
    }

    Ok(Plan::Drift {
        files,
        offending: missing
            .into_iter()
            .map(|name| crate::provision::Drift {
                name,
                reason: crate::provision::DriftReason::NotRecorded,
                recorded_hash: None,
            })
            .collect(),
    })
}

fn describe_remote_plan(plan: &Plan, ui: &mut Ui) {
    ui.log("\n  pack plan:");
    let files = match plan {
        Plan::Apply { files }
        | Plan::UpToDate { files }
        | Plan::ProvisionedUnversioned { files, .. }
        | Plan::Drift { files, .. } => files,
    };
    for file in files {
        let mark = if matches!(plan, Plan::Apply { .. }) {
            '+'
        } else {
            '='
        };
        ui.log(&format!(
            "    {mark} {}   md5 {}",
            file.name, file.content_hash
        ));
    }
    match plan {
        Plan::UpToDate { .. } => {
            ui.log("  the ledger already records this pack: up to date, nothing to apply.");
        }
        Plan::ProvisionedUnversioned {
            recorded_objects, ..
        } => {
            ui.log(&format!(
                "  already provisioned: the ledger records {recorded_objects} objects, but no per-file\n\
                 \x20 row to match this pack against, so nothing was applied. `kizunasync init` records one\n\
                 \x20 on every install it makes, so this project was provisioned some other way.\n\
                 \x20 core RPCs verified; run `kizunasync doctor` for a full check."
            ));
        }
        Plan::Drift { offending, .. } => {
            ui.log("  drift: the ledger does not match this pack:");
            for offender in offending {
                let recorded = offender
                    .recorded_hash
                    .as_ref()
                    .map_or_else(String::new, |hash| format!(" (ledger has md5 {hash})"));
                ui.log(&format!(
                    "    ! {}: {}{recorded}",
                    offender.name, offender.reason
                ));
            }
        }
        Plan::Apply { .. } => {}
    }
}

fn report_remote_ledger<T: crate::management::HttpTransport>(
    api: &ManagementApi<T>,
    ui: &mut Ui,
) -> crate::error::Result<()> {
    match read_ledger_state(api)? {
        LedgerState::Absent => {
            ui.log(&format!(
                "\n  ledger:           {SCHEMA}._provisions does not exist yet"
            ));
        }
        LedgerState::Present(entries) => {
            ui.log("\n  ledger:");
            for entry in &entries {
                ui.log(&format!("    {:<22}{}", entry.object_kind, entry.count));
            }
        }
    }

    Ok(())
}
