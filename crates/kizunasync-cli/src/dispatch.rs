use std::path::{Path, PathBuf};

use clap::{CommandFactory, Parser};

use crate::applier::Applier;
use crate::catalog::PgSchemaSource;
use crate::cli::{
    ChurnArgs, Cli, Command, ConflictArg, DeprovisionArgs, DoctorArgs, InitArgs, JobArg, JobsArgs,
    JobsCommand, LintArgs, MockCommand, SeedArgs, StatusArgs, StatusFormat, SyncArgs, SyncModeArg,
    TableDefaultsArgs, TransportArgs, UpgradeArgs,
};
use crate::commands::init as init_command;
use crate::commands::lint as lint_command;
use crate::commands::panel::equivalent::Reach;
use crate::commands::sync as sync_command;
use crate::commands::{
    OK, UNUSABLE, deprovision, doctor, jobs, mock, panel, smart, status, upgrade,
};
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::management::{ManagementApi, ReqwestTransport, ResolvedToken, resolve_access_token};
use crate::pg::{PgApplier, probe_db};
use crate::project_ref::ProjectRef;
use crate::prompts::{CliclackPrompter, is_interactive, is_pretty_tty};
use crate::proposals::{ConflictMode, SyncMode};
use crate::server_facts::{ServerFacts, read_server_facts};
use crate::supabase_cli::{ProcessCli, PushTarget, run_login};
use crate::token::{ACCESS_TOKEN_ENV, KeyringStore};
use crate::ui::{ColorMode, Ui};
use crate::workdir::ProjectPaths;
use crate::{VERSION, db, discovery, env_file, error, login_role, management, mock_seed, workdir};

/// Everything a command reads besides its own flags.
pub struct Session {
    /// The directory the command runs against.
    pub cwd: PathBuf,
    /// The environment it may consult.
    pub env: Env,
}

impl Session {
    /// The real process session: the working directory the process runs in,
    /// and the environment it was started with.
    #[must_use]
    pub fn from_process() -> Self {
        Self {
            // An unreadable cwd (deleted, permission-revoked) falls back to ".":
            // every path this session builds is relative, so a command still runs
            // against whatever the shell's own "." resolves to.
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            env: Env::from_process(),
        }
    }

    /// A fixed session, for tests.
    #[must_use]
    pub fn new(cwd: &Path, env: Env) -> Self {
        Self {
            cwd: cwd.to_path_buf(),
            env,
        }
    }
}

/// A session plus everything derived from it once per invocation: where the
/// project actually lives, and what its `.env` files declare. Resolving these
/// here is what keeps every command reading the same root instead of each
/// rediscovering one.
struct Context<'a> {
    session: &'a Session,
    paths: ProjectPaths,
    env_files: EnvFileValues,
}

/// The help text, rendered exactly as `--help` prints it. Exposed so the golden
/// test can assert the surface without spawning the binary.
#[must_use]
pub fn help_text() -> String {
    Cli::command().render_help().to_string()
}

/// Parse `argv` (without the program name) and run the command.
pub fn run(argv: &[String], session: &Session, ui: &mut Ui) -> i32 {
    let parsed =
        Cli::try_parse_from(std::iter::once("kizunasync".to_owned()).chain(argv.iter().cloned()));
    let cli = match parsed {
        Ok(cli) => cli,
        Err(error) => return render_parse_error(&error, ui),
    };
    if cli.no_color || session.env.get("NO_COLOR").is_some() {
        ui.set_color(ColorMode::Off);
    }
    // `--version` is handled here rather than by clap's own action so its
    // payload is the bare version and a newline, never clap's "kizunasync <version>"
    // form: the same bytes `kizunasync version` writes.
    if cli.version {
        ui.write_stdout(&format!("{VERSION}\n"));

        return OK;
    }

    let Some(command) = cli.command else {
        return run_bare(cli.workdir.as_deref(), session, ui);
    };

    dispatch(
        command,
        &build_context(cli.workdir.as_deref(), session, ui),
        ui,
    )
}

/// Everything derived from the session once per invocation, resolved here so
/// every command reads the same root.
fn build_context<'a>(workdir: Option<&Path>, session: &'a Session, ui: &mut Ui) -> Context<'a> {
    let paths = workdir::resolve(&session.cwd, &session.env, workdir);
    if paths.is_relocated_from(&session.cwd) {
        ui.log(&format!("resolved project root: {}", paths.root.display()));
    }

    Context {
        session,
        env_files: env_file::load(&paths.root),
        paths,
    }
}

/// Bare `kizunasync`.
///
/// Off a terminal, no command is not a failure: print the surface (as human
/// status) and exit clean. On one, the same TTY gate every wizard reads opens
/// the guided flow instead, which is only ever a shortcut to `init` or `sync`,
/// never a third way to provision.
fn run_bare(workdir: Option<&Path>, session: &Session, ui: &mut Ui) -> i32 {
    if !is_interactive() {
        ui.log(help_text().trim_end());

        return OK;
    }

    let context = build_context(workdir, session, ui);
    // `new()`'s only failure is `NotInteractive`, ruled out by the `is_interactive()`
    // guard above; `.ok()` degrades to a headless run rather than assume that
    // invariant can never race a TOCTOU change in the terminal.
    let mut prompter = CliclackPrompter::new().ok();
    let schemas = PgSchemaSource;
    let browser_login = || run_login(&context.paths.root);
    let live = doctor::LivePorts::new();
    let ports = smart::SmartPorts {
        init: init_ports(
            prompter
                .as_mut()
                .map(|prompter| prompter as &mut dyn crate::prompts::Prompter),
            &schemas,
            &browser_login,
        ),
        ledger: &smart::read_ledger_over,
        config: &smart::read_config_over,
        linked: &|project_ref, token| linked_connection(project_ref, token, &context),
        panel: panel::PanelPorts {
            open: &|connection| {
                smart::open_panel(
                    connection,
                    &context.paths,
                    &context.session.env,
                    &context.env_files,
                )
            },
            doctor: live.ports(&context.env_files),
            clock: &crate::clock::now_unix,
        },
    };

    smart::run(
        &context.session.cwd,
        &context.paths,
        &context.session.env,
        &context.env_files,
        ports,
        ui,
    )
}

/// clap already wrote a message for us; help and version are successful output
/// on stdout, everything else is a usage error the shell should see as
/// unusable (exit 2).
fn render_parse_error(error: &clap::Error, ui: &mut Ui) -> i32 {
    let rendered = error.render().to_string();
    if matches!(
        error.kind(),
        clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
    ) {
        ui.write_stdout(&rendered);

        return OK;
    }

    ui.log(rendered.trim_end());

    UNUSABLE
}

fn dispatch(command: Command, context: &Context<'_>, ui: &mut Ui) -> i32 {
    match command {
        Command::Version => {
            ui.write_stdout(&format!("{VERSION}\n"));

            OK
        }
        Command::Init(args) => run_init(&args, context, ui),
        Command::Sync(args) => run_sync(&args, context, ui),
        Command::Doctor(args) => run_doctor(&args, context, ui),
        Command::Lint(args) => run_lint(&args, context, ui),
        Command::Status(args) => run_status(&args, context, ui),
        Command::Upgrade(args) => run_upgrade(&args, context, ui),
        Command::Deprovision(args) => run_deprovision(&args, context, ui),
        Command::Jobs(args) => run_jobs(&args, context, ui),
        Command::Mock(args) => match args.command {
            MockCommand::Seed(seed) => run_seed(&seed, context, ui),
            MockCommand::Churn(churn) => run_churn(&churn, context, ui),
        },
    }
}

fn run_init(args: &InitArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    let mut prompter = interactive_prompter();
    let schemas = PgSchemaSource;
    let browser_login = || run_login(&context.paths.root);
    let mut ports = init_ports(
        prompter
            .as_mut()
            .map(|prompter| prompter as &mut dyn crate::prompts::Prompter),
        &schemas,
        &browser_login,
    );
    let flags = init_command::InitFlags {
        dry_run: args.dry_run,
        yes: args.yes,
        local_only: args.local_only,
        schema: args.schema.clone(),
        project_ref: args.project_ref.clone(),
        db_url: args.db_url.clone(),
        access_token: args.access_token.clone(),
        options: table_options(
            &args.table_defaults,
            register_clients(args.register_clients, args.no_register_clients),
            args.min_schema_version,
            // `init --tombstone-ttl-days` is the project default, which the
            // settings declaration below carries.
            None,
        ),
        settings: sync_command::SettingsOptions {
            max_batch_size: args.max_batch_size,
            no_max_batch_size: args.no_max_batch_size,
            require_atomic: args.require_atomic,
            no_require_atomic: args.no_require_atomic,
            reap_schedule: args.reap_schedule.clone(),
            compact_schedule: args.compact_schedule.clone(),
            client_prune_schedule: args.client_prune_schedule.clone(),
            client_ttl_days: args.client_ttl_days,
            hlc_max_skew_ms: args.hlc_max_skew_ms,
            tombstone_ttl_days: args.tombstone_ttl_days,
            max_pull_scan: args.max_pull_scan,
        },
        allow_no_cron: args.allow_no_cron,
        allow_no_rls: args.allow_no_rls,
    };

    init_command::run(
        &flags,
        &init_command::RunContext {
            cwd: &context.session.cwd,
            paths: &context.paths,
            env: &context.session.env,
            env_files: &context.env_files,
        },
        &mut ports,
        ui,
    )
}

/// The wizard's account rung, wired to the real Management API. Built per call
/// because it is made at most once per run, only after the user picks it.
fn account_projects(token: &str) -> error::Result<Vec<management::ProjectSummary>> {
    management::list_projects(&ReqwestTransport::new()?, token, None)
}

/// The interactive prompter, or `None` off a terminal. `new()`'s only failure
/// is `NotInteractive`, already ruled out by the `is_interactive()` guard;
/// `.ok()` degrades to a headless run rather than assume that invariant can
/// never race a TOCTOU change in the terminal.
fn interactive_prompter() -> Option<CliclackPrompter> {
    if is_interactive() {
        CliclackPrompter::new().ok()
    } else {
        None
    }
}

/// `init`'s ports wired to the real world: the Supabase CLI, the OS keyring,
/// and the live Management API. Shared by `kizunasync init` and the guided
/// flow's install half. `browser_login` is built by the caller (it closes
/// over the resolved project root `run_login` spawns `supabase login`
/// against) so it lives as long as the `InitPorts` this returns.
fn init_ports<'a>(
    prompter: Option<&'a mut dyn crate::prompts::Prompter>,
    schemas: &'a PgSchemaSource,
    browser_login: &'a dyn Fn() -> crate::error::Result<()>,
) -> init_command::InitPorts<'a> {
    init_command::InitPorts {
        prompter,
        schemas,
        supabase: &ProcessCli,
        now_unix: crate::clock::now_unix(),
        tokens: &KeyringStore,
        list_projects: &account_projects,
        browser_login,
        probe_remote: &remote_facts,
    }
}

/// The wizard's connection test for a project, over the real Management API.
fn remote_facts(project_ref: &ProjectRef, token: &str) -> error::Result<ServerFacts> {
    let api = ManagementApi::new(ReqwestTransport::new()?, token, project_ref, None);

    read_server_facts(&api)
}

/// The `TableOptions` `init` and `sync` both build from their table-defaults
/// flags, differing only in `tombstone_ttl_days`.
fn table_options(
    defaults: &TableDefaultsArgs,
    register_clients: Option<bool>,
    min_schema_version: Option<i64>,
    tombstone_ttl_days: Option<i64>,
) -> sync_command::TableOptions {
    sync_command::TableOptions {
        sync: defaults.sync.map(sync_mode),
        bucket_column: defaults.bucket_column.clone(),
        soft_delete: defaults.soft_delete.clone(),
        conflict: defaults.conflict.map(conflict_mode),
        conflict_journal: defaults.conflict_journal,
        register_clients,
        min_schema_version,
        tombstone_ttl_days,
    }
}

fn run_sync(args: &SyncArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    let mut prompter = interactive_prompter();
    let schemas = PgSchemaSource;
    let mut ports = sync_command::SyncPorts {
        prompter: prompter
            .as_mut()
            .map(|prompter| prompter as &mut dyn crate::prompts::Prompter),
        schemas: &schemas,
        supabase: &ProcessCli,
        now_unix: crate::clock::now_unix(),
        tokens: &KeyringStore,
        linked: &|project_ref, token| linked_connection(project_ref, token, context),
    };
    let flags = sync_command::SyncFlags {
        add: args.add.clone(),
        remove: args.remove.clone(),
        options: table_options(
            &args.table_defaults,
            register_clients(args.register_clients, args.no_register_clients),
            args.min_schema_version,
            args.tombstone_ttl_days,
        ),
        settings: sync_command::SettingsOptions {
            max_batch_size: args.max_batch_size,
            no_max_batch_size: args.no_max_batch_size,
            require_atomic: args.require_atomic,
            no_require_atomic: args.no_require_atomic,
            reap_schedule: args.reap_schedule.clone(),
            compact_schedule: args.compact_schedule.clone(),
            client_prune_schedule: args.client_prune_schedule.clone(),
            client_ttl_days: args.client_ttl_days,
            hlc_max_skew_ms: args.hlc_max_skew_ms,
            tombstone_ttl_days: None,
            max_pull_scan: args.max_pull_scan,
        },
        schema: args.schema.clone(),
        db_url: args.db_url.clone(),
        connection: None,
        project_ref: args.project_ref.clone(),
        access_token: args.access_token.clone(),
        allow_no_cron: args.allow_no_cron,
        allow_no_rls: args.allow_no_rls,
        dry_run: args.dry_run,
        yes: args.yes,
        local_only: args.local_only,
    };
    let remote = match sync_remote(&flags, context, ui) {
        Ok(remote) => remote,
        Err(code) => return code,
    };

    sync_command::run(
        &flags,
        &context.paths,
        &context.session.env,
        &context.env_files,
        remote.as_ref().map(|api| api.as_ref() as &dyn Applier),
        &mut ports,
        ui,
    )
}

/// The production linked-project connector: the real Management API, a real
/// TCP probe of the direct host, and a real connect for the pooler.
fn linked_connection(
    project_ref: &ProjectRef,
    token: Option<&str>,
    context: &Context<'_>,
) -> error::Result<login_role::LinkedConnection> {
    let http = ReqwestTransport::new()?;
    let ports = login_role::LinkedPorts {
        transport: &http,
        base_url: None,
        reachable: &|host, port| {
            discovery::is_reachable(host, port, login_role::DIRECT_PROBE_TIMEOUT)
        },
        connect: &|url| probe_db(url).map(|_| ()),
        sleep: &std::thread::sleep,
    };

    login_role::linked_connection(
        project_ref,
        token,
        &context.paths,
        &context.session.env,
        &context.env_files,
        &ports,
    )
}

/// The Management API transport `sync --project-ref` reads and applies through.
/// `Ok(None)` is the direct path, which needs no token at all.
fn sync_remote(
    flags: &sync_command::SyncFlags,
    context: &Context<'_>,
    ui: &mut Ui,
) -> Result<Option<Box<ManagementApi<ReqwestTransport>>>, i32> {
    let Some(project_ref) = flags.project_ref.as_ref() else {
        return Ok(None);
    };

    management_api(project_ref, flags.access_token.as_deref(), context, ui)
        .map(|api| Some(Box::new(api)))
}

/// The Management API client for `project_ref`, its token resolved the way
/// `init --project-ref` resolves it, or the exit code once the reason is on
/// `ui`.
fn management_api(
    project_ref: &ProjectRef,
    access_token: Option<&str>,
    context: &Context<'_>,
    ui: &mut Ui,
) -> Result<ManagementApi<ReqwestTransport>, i32> {
    let token = match resolve_access_token(access_token, &context.session.env) {
        Ok(token) => token,
        Err(cause) => {
            ui.log(&format!("  {cause}"));

            return Err(UNUSABLE);
        }
    };
    let http = match ReqwestTransport::new() {
        Ok(http) => http,
        Err(cause) => {
            ui.error(&format!("  {cause}"));

            return Err(UNUSABLE);
        }
    };
    ui.log(&format!("  access token:     {}", token.source));

    Ok(ManagementApi::new(http, &token.token, project_ref, None))
}

/// The two switches of a boolean pair, as one declaration. Neither passed is
/// `None`, which leaves the column exactly as the project has it.
const fn register_clients(on: bool, off: bool) -> Option<bool> {
    if on {
        return Some(true);
    }

    if off {
        return Some(false);
    }

    None
}

/// `doctor` reads `kizunasync._config` for its first check and stats the
/// project for the rest, so a database it cannot resolve fails one check
/// instead of stopping the command: an offline run still has something to say.
fn run_doctor(args: &DoctorArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    let flags = doctor::DoctorFlags {
        ci: args.ci,
        url: args.url.clone(),
        publishable_key: args.publishable_key.clone(),
        project_ref: args.transport.project_ref.clone(),
        access_token: args.transport.access_token.clone(),
    };
    let resolved = resolve_transport(&args.transport, context);
    let unreachable = UnreachableApplier {
        cause: match &resolved {
            Resolution::Ready { .. } => String::new(),
            Resolution::Failed { cause, .. } => cause.clone(),
        },
    };
    let applier = match &resolved {
        Resolution::Ready { transport, .. } => transport.applier(),
        Resolution::Failed { .. } => &unreachable as &dyn Applier,
    };

    let live = doctor::LivePorts::new();

    doctor::run(
        &flags,
        applier,
        &context.paths,
        &context.session.env,
        &live.ports(&context.env_files),
        ui,
    )
}

fn run_lint(args: &LintArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    if let Some(code) = lint_command::refuse_without_migrations(&context.paths, ui) {
        return code;
    }

    with_applier(&args.transport, context, false, ui, &mut |applier, ui| {
        lint_command::run(applier, &context.paths, ui)
    })
}

fn run_status(args: &StatusArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    if args.json && matches!(args.format, Some(StatusFormat::Text)) {
        ui.error("  --json cannot be combined with --format text");

        return UNUSABLE;
    }

    let shape = status_render(args);
    if shape == status::StatusRender::Text {
        ui.log("kizunasync status: what this project has provisioned\n");
    }

    with_applier(
        &args.transport,
        context,
        shape == status::StatusRender::Text,
        ui,
        &mut |applier, ui| match status::build_report(applier, &context.paths, &context.session.env)
        {
            Ok(report) => status::render(ui, &report, shape),
            Err(cause) => {
                ui.error(&format!("  could not read the project: {cause}"));

                UNUSABLE
            }
        },
    )
}

/// The shape this run's flags and terminal ask for: `--quiet`, `--json`, the
/// Clack report on a terminal, or text.
fn status_render(args: &StatusArgs) -> status::StatusRender {
    let json = args.json || matches!(args.format, Some(StatusFormat::Json));
    let force_text = matches!(args.format, Some(StatusFormat::Text));
    if args.quiet {
        return status::StatusRender::Quiet;
    }
    if json {
        return status::StatusRender::Json;
    }
    if !force_text && is_pretty_tty() {
        return status::StatusRender::Pretty;
    }

    status::StatusRender::Text
}

fn run_upgrade(args: &UpgradeArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    ui.log("kizunasync upgrade: reconciling the ledger against the pack\n");
    let flags = upgrade::UpgradeFlags {
        dry_run: args.dry_run,
        yes: args.yes,
        reapply: args.reapply,
        allow_no_cron: args.allow_no_cron,
    };
    let transport = &args.transport;
    let reach = transport
        .project_ref
        .as_ref()
        .map(Reach::ProjectRef)
        .or_else(|| transport.db_url.as_deref().map(Reach::DbUrl));

    with_applier(transport, context, true, ui, &mut |applier, ui| {
        upgrade::run_over(ui, applier, &context.session.env, &flags, reach)
    })
}

fn run_deprovision(args: &DeprovisionArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    if args.local_only {
        return deprovision::refuse_local_only(ui);
    }

    let request = deprovision::DeprovisionRequest {
        dry_run: args.dry_run,
        yes: args.yes,
        purge: args.purge,
        confirm: args.confirm.as_deref(),
    };
    if let Some(project_ref) = args.transport.project_ref.as_ref() {
        return match management_api(
            project_ref,
            args.transport.access_token.as_deref(),
            context,
            ui,
        ) {
            Ok(api) => {
                deprovision::run_over_api(&api, project_ref, &request, &context.session.env, ui)
            }
            Err(code) => code,
        };
    }

    // A purge may edit a hosted project's exposed schemas, so the token it
    // would do that with is checked before anything connects.
    let token = if args.purge {
        match purge_token(
            args.transport.access_token.as_deref(),
            &context.session.env,
            ui,
        ) {
            Ok(token) => token,
            Err(code) => return code,
        }
    } else {
        PurgeToken::Absent
    };
    let Some((url, source)) = resolve_connection_from(
        "kizunasync deprovision",
        args.transport.db_url.as_deref(),
        context,
        true,
        ui,
    ) else {
        return UNUSABLE;
    };
    let applier = PgApplier::new(&url);
    let execute = |sql: &str| applier.run_script(sql);
    let connection = init_command::DirectConnection {
        push: if source == db::DbUrlSource::LocalConfig {
            PushTarget::Local
        } else {
            PushTarget::DbUrl(url.clone())
        },
        url: url.clone(),
    };
    let delivery = if deprovision::delivers_by_migration(&context.paths) {
        deprovision::Delivery::Migration(deprovision::MigrationPush {
            direct: &connection,
            paths: &context.paths,
            schemas: &PgSchemaSource,
            supabase: &ProcessCli,
            now_unix: crate::clock::now_unix(),
        })
    } else {
        deprovision::Delivery::Direct(&execute)
    };
    let (target, api) = purge_target(&connection, &context.paths, token, ui);
    let exposure = exposure_over(&target, api.as_ref(), &context.paths);

    deprovision::run_over(
        &applier,
        &deprovision::expected_confirmation(&url),
        &request,
        &delivery,
        &exposure,
        &context.session.env,
        ui,
    )
}

/// The list a purge over `connection` edits ([`deprovision::exposure_target`]),
/// and the Management API client for a hosted project the token reaches.
fn purge_target(
    connection: &init_command::DirectConnection,
    paths: &ProjectPaths,
    token: PurgeToken,
    ui: &mut Ui,
) -> (
    deprovision::ExposureTarget,
    Option<ManagementApi<ReqwestTransport>>,
) {
    let hosted = matches!(
        deprovision::exposure_target(connection, paths, None, true),
        deprovision::ExposureTarget::ManagementApi(_)
    );
    let token = if hosted {
        usable_token(token, ui)
    } else {
        None
    };
    let target = deprovision::exposure_target(connection, paths, None, token.is_some());
    let api = match (&target, &token) {
        (deprovision::ExposureTarget::ManagementApi(project_ref), Some(token)) => {
            ReqwestTransport::new()
                .ok()
                .map(|http| ManagementApi::new(http, &token.token, project_ref, None))
        }
        (deprovision::ExposureTarget::ManagementApi(_), None)
        | (deprovision::ExposureTarget::ConfigToml | deprovision::ExposureTarget::ByHand, _) => {
            None
        }
    };

    (target, api)
}

/// `target` as the step [`deprovision::run_over`] takes, through `api` when
/// one was built for it.
fn exposure_over<'a>(
    target: &'a deprovision::ExposureTarget,
    api: Option<&'a ManagementApi<ReqwestTransport>>,
    paths: &'a ProjectPaths,
) -> deprovision::Exposure<'a> {
    match (target, api) {
        (deprovision::ExposureTarget::ManagementApi(project_ref), Some(api)) => {
            deprovision::Exposure::ManagementApi { api, project_ref }
        }
        (deprovision::ExposureTarget::ConfigToml, _) => {
            deprovision::Exposure::ConfigToml(&paths.config_toml)
        }
        (deprovision::ExposureTarget::ManagementApi(_), None)
        | (deprovision::ExposureTarget::ByHand, _) => deprovision::Exposure::ByHand,
    }
}

/// What a purge over a direct connection may edit a hosted project's exposed
/// schemas with.
enum PurgeToken {
    /// A Personal Access Token.
    Valid(ResolvedToken),
    /// `SUPABASE_ACCESS_TOKEN` holds something else, for this reason.
    Invalid(String),
    /// No token at all.
    Absent,
}

/// The token a purge over a direct connection resolves the way
/// `--project-ref` does: `--access-token`, else `SUPABASE_ACCESS_TOKEN`. A flag
/// that is not a token stops the run (exit 2) with the same sentence.
fn purge_token(explicit: Option<&str>, env: &Env, ui: &mut Ui) -> Result<PurgeToken, i32> {
    match resolve_access_token(explicit, env) {
        Ok(token) => Ok(PurgeToken::Valid(token)),
        Err(cause) if explicit.is_some_and(|value| !value.is_empty()) => {
            ui.log(&format!("  {cause}"));

            Err(UNUSABLE)
        }
        Err(cause) if env.get(ACCESS_TOKEN_ENV).is_some() => {
            Ok(PurgeToken::Invalid(cause.to_string()))
        }
        Err(_) => Ok(PurgeToken::Absent),
    }
}

/// The token to use once the purge's target would use one: an environment
/// value that is not a token warns once, and the purge falls back to the
/// by-hand step.
fn usable_token(token: PurgeToken, ui: &mut Ui) -> Option<ResolvedToken> {
    match token {
        PurgeToken::Valid(token) => Some(token),
        PurgeToken::Invalid(cause) => {
            ui.warn(&format!("  {cause}"));

            None
        }
        PurgeToken::Absent => None,
    }
}

/// `jobs` reads `cron.job` and calls the retention functions over SQL, never
/// the Data API: through the Management API with `--project-ref`, else over a
/// direct connection.
fn run_jobs(args: &JobsArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    // clap checks a conflict between global flags only when both sit on the
    // same side of the subcommand.
    if args.project_ref.is_some() && args.db_url.is_some() {
        return render_parse_error(
            &clap::Error::raw(
                clap::error::ErrorKind::ArgumentConflict,
                "the argument '--project-ref <REF>' cannot be used with '--db-url <URL>'\n",
            ),
            ui,
        );
    }

    let action = match &args.command {
        JobsCommand::List => jobs::JobsAction::List,
        JobsCommand::Schedule => jobs::JobsAction::Schedule,
        JobsCommand::Run(run) => match run.job {
            JobArg::Reap => jobs::JobsAction::Run(jobs::Job::Reap),
            JobArg::Compact => jobs::JobsAction::Run(jobs::Job::Compact),
            JobArg::Prune => jobs::JobsAction::Run(jobs::Job::Prune),
            JobArg::All => jobs::JobsAction::RunAll,
        },
    };
    let flags = jobs::JobsFlags {
        json: args.json,
        management_api: args.project_ref.is_some(),
    };
    if let Some(project_ref) = args.project_ref.as_ref() {
        let transport = TransportArgs {
            db_url: None,
            project_ref: Some(project_ref.clone()),
            access_token: args.access_token.clone(),
        };

        return with_applier(&transport, context, true, ui, &mut |api, ui| {
            jobs::run(action, &flags, api, ui)
        });
    }

    let Some(url) =
        resolve_connection("kizunasync jobs", args.db_url.as_deref(), context, true, ui)
    else {
        return UNUSABLE;
    };

    jobs::run(action, &flags, &PgApplier::new(&url), ui)
}

/// The clap value enums, translated into the vocabulary the commands read.
const fn sync_mode(value: SyncModeArg) -> SyncMode {
    match value {
        SyncModeArg::PullOnly => SyncMode::PullOnly,
        SyncModeArg::ReadWrite => SyncMode::ReadWrite,
    }
}

const fn conflict_mode(value: ConflictArg) -> ConflictMode {
    match value {
        ConflictArg::Arrival => ConflictMode::Arrival,
        ConflictArg::Hlc => ConflictMode::Hlc,
    }
}

/// The table a mock run targets, plus the connection its resolution already
/// opened, so an apply that follows does not resolve and probe a second time.
struct MockTarget {
    table: String,
    url: Option<String>,
}

/// `--table` wins and needs no database; without it the answer is in
/// `kizunasync._config`, which does.
fn resolve_mock_table(
    prefix: &str,
    flag: Option<&str>,
    db_url: Option<&str>,
    context: &Context<'_>,
    ui: &mut Ui,
) -> Option<MockTarget> {
    match mock::validate_target_flag(flag) {
        Ok(Some(table)) => return Some(MockTarget { table, url: None }),
        Ok(None) => {}
        Err(cause) => {
            ui.log(&format!("{prefix}: {cause}"));

            return None;
        }
    }
    let url = resolve_connection(prefix, db_url, context, true, ui)?;
    match mock::resolve_target_table(&PgApplier::new(&url), ui) {
        Ok(table) => Some(MockTarget {
            table,
            url: Some(url),
        }),
        Err(cause) => {
            ui.log(&format!("{prefix}: {cause}"));

            None
        }
    }
}

fn run_seed(args: &SeedArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    let session = context.session;
    let Some(target) = resolve_mock_table(
        "kizunasync mock seed",
        args.table.as_deref(),
        args.db_url.as_deref(),
        context,
        ui,
    ) else {
        return UNUSABLE;
    };

    let table = target.table;
    let flags = mock::SeedFlags {
        spec: mock_seed::SeedSpec {
            rows: args.rows,
            users: args.users,
            images: args.images,
            seed: args.seed,
        },
        table,
        dry_run: args.dry_run,
        yes: args.yes,
        clean: args.clean,
    };
    // A run that will not apply (a dry run, or one whose guard is unsatisfied)
    // prints its plan and stops, so it must not open (or demand) a connection
    // first. The executor it is handed is never called on those paths.
    if flags.dry_run || !mock::guard_allows(flags.yes, &session.env) {
        return mock::plan_and_seed(&flags, &session.env, &unreachable_executor, ui);
    }
    let Some(url) = target.url.map_or_else(
        || {
            resolve_connection(
                "kizunasync mock seed",
                args.db_url.as_deref(),
                context,
                true,
                ui,
            )
        },
        Some,
    ) else {
        return UNUSABLE;
    };

    let applier = PgApplier::new(&url);

    mock::plan_and_seed(&flags, &session.env, &|sql| applier.run_script(sql), ui)
}

fn run_churn(args: &ChurnArgs, context: &Context<'_>, ui: &mut Ui) -> i32 {
    let session = context.session;
    let Some(target) = resolve_mock_table(
        "kizunasync mock churn",
        args.table.as_deref(),
        args.db_url.as_deref(),
        context,
        ui,
    ) else {
        return UNUSABLE;
    };

    let table = target.table;
    let flags = mock::ChurnFlags {
        iterations: args.iterations,
        seed: args.seed,
        interval_ms: args.interval_ms,
        table,
        dry_run: args.dry_run,
        yes: args.yes,
    };
    if flags.dry_run || !mock::guard_allows(flags.yes, &session.env) {
        return mock::plan_and_churn(
            &flags,
            &session.env,
            &unreachable_executor,
            &std::thread::sleep,
            ui,
        );
    }
    let Some(url) = target.url.map_or_else(
        || {
            resolve_connection(
                "kizunasync mock churn",
                args.db_url.as_deref(),
                context,
                true,
                ui,
            )
        },
        Some,
    ) else {
        return UNUSABLE;
    };

    let applier = PgApplier::new(&url);

    mock::plan_and_churn(
        &flags,
        &session.env,
        &|sql| applier.run_script(sql),
        &std::thread::sleep,
        ui,
    )
}

/// A dry run, or a refused apply, returns before ever reaching an executor;
/// this only exists to satisfy the parameter without resolving a connection.
fn unreachable_executor(_sql: &str) -> error::Result<()> {
    Err(error::Error::Db(
        "unreachable: a plan-only run never calls the executor".to_owned(),
    ))
}

/// Resolve a direct connection and prove it answers, reporting each step with
/// the command's own prefix. `None` means the caller should exit 2.
fn resolve_connection(
    prefix: &str,
    flag: Option<&str>,
    context: &Context<'_>,
    echo: bool,
    ui: &mut Ui,
) -> Option<String> {
    resolve_connection_from(prefix, flag, context, echo, ui).map(|(url, _)| url)
}

/// [`resolve_connection`], with where the URL came from.
fn resolve_connection_from(
    prefix: &str,
    flag: Option<&str>,
    context: &Context<'_>,
    echo: bool,
    ui: &mut Ui,
) -> Option<(String, db::DbUrlSource)> {
    let resolved = match db::resolve_db_url(
        flag,
        &context.session.env,
        &context.env_files,
        &context.paths,
    ) {
        Ok(resolved) => resolved,
        Err(cause) => {
            ui.log(&format!("{prefix}: {cause}"));

            return None;
        }
    };

    if echo {
        ui.log(&format!(
            "{prefix} database: {} ({})",
            db::redact_db_url(&resolved.url),
            resolved.source
        ));
    }
    let url = db::session_mode(resolved.url, resolved.source.key(), ui);

    if let Err(cause) = probe_db(&url) {
        ui.log(&format!(
            "{prefix}: could not connect to the database:\n  {cause}"
        ));

        return None;
    }

    Some((url, resolved.source))
}

/// Whichever transport the flags selected, built and proven to answer.
enum Transport {
    Direct(PgApplier),
    Remote(Box<ManagementApi<ReqwestTransport>>),
}

impl Transport {
    fn applier(&self) -> &dyn Applier {
        match self {
            Self::Direct(applier) => applier,
            Self::Remote(api) => api.as_ref(),
        }
    }
}

/// An applier that answers every statement with the reason no transport could
/// be built. It exists for `doctor`, whose other checks are worth running when
/// the database is not reachable. Every other command stops instead.
struct UnreachableApplier {
    cause: String,
}

impl Applier for UnreachableApplier {
    fn run_query(&self, _sql: &str) -> error::Result<Vec<crate::row::Row>> {
        Err(error::Error::Db(self.cause.clone()))
    }
}

/// What resolving a transport produced. The line that names the connection is
/// carried either way: a command that echoes it must say which rung it took
/// even when that connection turns out to be unreachable.
enum Resolution {
    Ready { transport: Transport, line: String },
    Failed { cause: String, line: Option<String> },
}

/// Resolve the transport the flags select and prove it answers.
fn resolve_transport(transport: &TransportArgs, context: &Context<'_>) -> Resolution {
    let session = context.session;
    if let Some(project_ref) = transport.project_ref.as_ref() {
        let token = match resolve_access_token(transport.access_token.as_deref(), &session.env) {
            Ok(token) => token,
            Err(cause) => {
                return Resolution::Failed {
                    cause: cause.to_string(),
                    line: None,
                };
            }
        };

        let line = format!("  access token:     {}", token.source);
        let http = match ReqwestTransport::new() {
            Ok(http) => http,
            Err(cause) => {
                return Resolution::Failed {
                    cause: cause.to_string(),
                    line: Some(line),
                };
            }
        };

        return Resolution::Ready {
            transport: Transport::Remote(Box::new(ManagementApi::new(
                http,
                &token.token,
                project_ref,
                None,
            ))),
            line,
        };
    }

    let resolved = match db::resolve_db_url(
        transport.db_url.as_deref(),
        &session.env,
        &context.env_files,
        &context.paths,
    ) {
        Ok(resolved) => resolved,
        Err(cause) => {
            return Resolution::Failed {
                cause: cause.to_string(),
                line: None,
            };
        }
    };

    let mut line = format!(
        "  database:         {} ({})",
        db::redact_db_url(&resolved.url),
        resolved.source
    );
    let url = match db::session_mode_url(&resolved.url) {
        Some(rewritten) => {
            line = format!(
                "{line}\n  {}",
                db::transaction_pooler_note(resolved.source.key())
            );
            rewritten
        }
        None => resolved.url,
    };

    if let Err(cause) = probe_db(&url) {
        return Resolution::Failed {
            cause: format!("could not connect to the database:\n    {cause}"),
            line: Some(line),
        };
    }

    Resolution::Ready {
        transport: Transport::Direct(PgApplier::new(&url)),
        line,
    }
}

/// Build whichever transport the flags select, then hand it to `body`. The two
/// appliers drive identical logic, which is the whole point of the port.
fn with_applier(
    transport: &TransportArgs,
    context: &Context<'_>,
    echo: bool,
    ui: &mut Ui,
    body: &mut dyn FnMut(&dyn Applier, &mut Ui) -> i32,
) -> i32 {
    let resolved = resolve_transport(transport, context);
    let line = match &resolved {
        Resolution::Ready { line, .. } => Some(line.clone()),
        Resolution::Failed { line, .. } => line.clone(),
    };

    if echo && let Some(line) = line {
        ui.log(&line);
    }

    match resolved {
        Resolution::Ready { transport, .. } => body(transport.applier(), ui),
        Resolution::Failed { cause, .. } => {
            ui.error(&format!("  {cause}"));

            UNUSABLE
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::ui::Capture;

    fn drive(argv: &[&str], session: &Session) -> (i32, Capture) {
        let owned: Vec<String> = argv.iter().map(|value| (*value).to_owned()).collect();
        let (mut ui, capture) = Ui::capture();
        let code = run(&owned, session, &mut ui);

        (code, capture)
    }

    fn empty_session() -> (tempfile::TempDir, Session) {
        let dir = tempfile::tempdir().unwrap();
        let session = Session::new(dir.path(), Env::default());

        (dir, session)
    }

    /// An environment pointing at the pack this checkout ships. A test must not
    /// depend on production's executable-walk rung: a `build-dir` outside the
    /// repository moves the binary, and a pack-guarded test would then skip
    /// itself into a pass.
    fn pack_env() -> Env {
        let pack = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/supabase-pack");

        Env::from_pairs(&[("KSYNC_PACK_DIR", pack.to_string_lossy().as_ref())])
    }

    #[test]
    fn the_clap_surface_is_internally_consistent() {
        Cli::command().debug_assert();
    }

    /// Bare `kizunasync` off a terminal, which every test, pipe, and CI job is,
    /// prints the surface and exits clean. The guided
    /// flow is TTY-only, so nothing on this path may prompt, resolve a
    /// connection, or reach a database: the whole output is the help text.
    #[test]
    fn no_command_prints_the_surface_to_stderr_and_exits_clean() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&[], &session);

        assert_eq!(code, OK);
        assert_eq!(capture.stdout(), "");
        assert_eq!(capture.stderr(), format!("{}\n", help_text().trim_end()));
        assert!(capture.stderr().contains("Usage: kizunasync"));
        assert!(capture.stderr().contains("deprovision"));
    }

    #[test]
    fn the_help_says_what_a_bare_run_does() {
        let text = help_text();

        assert!(text.contains("Run kizunasync with no command in a terminal"));
        assert!(text.contains("prints this help"));
    }

    #[test]
    fn help_goes_to_stdout_and_exits_clean() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["--help"], &session);

        assert_eq!(code, OK);
        assert!(capture.stdout().contains("Usage: kizunasync"));
        assert_eq!(capture.stderr(), "");
    }

    #[test]
    fn every_command_is_listed_in_the_help() {
        let text = help_text();
        for command in [
            "init",
            "sync",
            "status",
            "doctor",
            "lint",
            "upgrade",
            "deprovision",
            "mock",
            "version",
        ] {
            assert!(text.contains(command), "{command} is missing from the help");
        }
    }

    #[test]
    fn the_version_is_a_machine_payload_in_all_three_spellings() {
        let (_guard, session) = empty_session();
        for argv in [vec!["version"], vec!["--version"], vec!["-v"]] {
            let (code, capture) = drive(&argv, &session);

            assert_eq!(code, OK);
            assert_eq!(capture.stdout().trim(), VERSION);
        }
    }

    #[test]
    fn an_unknown_command_is_a_usage_error_on_stderr() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["gremlin"], &session);

        assert_eq!(code, UNUSABLE);
        assert_eq!(capture.stdout(), "");
        assert!(capture.stderr().contains("gremlin"));
    }

    #[test]
    fn an_unknown_flag_is_a_usage_error() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["lint", "--nope"], &session);

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("--nope"));
    }

    #[test]
    fn the_two_transports_are_mutually_exclusive() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(
            &["status", "--db-url", "postgres://x", "--project-ref", "abc"],
            &session,
        );

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("cannot be used with"));
    }

    /// `deprovision` and every `jobs` subcommand refuse both transports at
    /// once with the same parse error as the other commands, whichever side
    /// of the subcommand the `jobs` flags sit on.
    #[test]
    fn deprovision_and_jobs_refuse_both_transports_at_once() {
        for argv in [
            &[
                "deprovision",
                "--db-url",
                "postgres://x",
                "--project-ref",
                "abcd",
            ][..],
            &[
                "jobs",
                "list",
                "--db-url",
                "postgres://x",
                "--project-ref",
                "abcd",
            ][..],
            &[
                "jobs",
                "--project-ref",
                "abcd",
                "run",
                "reap",
                "--db-url",
                "postgres://x",
            ][..],
            &[
                "jobs",
                "--db-url",
                "postgres://x",
                "--project-ref",
                "abcd",
                "schedule",
            ][..],
        ] {
            let (_guard, session) = empty_session();
            let (code, capture) = drive(argv, &session);

            assert_eq!(code, UNUSABLE, "{argv:?}");
            assert!(
                capture.stderr().contains("cannot be used with"),
                "{argv:?}: {}",
                capture.stderr()
            );
        }
    }

    /// `--project-ref` routes `deprovision` and `jobs` through the Management
    /// API, which resolves its token the way `init --project-ref` does, before
    /// any direct connection is sought.
    #[test]
    fn deprovision_and_jobs_over_a_project_ref_resolve_a_token_not_a_database() {
        for argv in [
            &["deprovision", "--project-ref", "abcd", "--dry-run"][..],
            &["deprovision", "--purge", "--yes", "--project-ref", "abcd"][..],
            &["jobs", "list", "--project-ref", "abcd"][..],
            &["jobs", "--project-ref", "abcd", "run", "all"][..],
            &["jobs", "schedule", "--project-ref", "abcd"][..],
        ] {
            let (_guard, session) = empty_session();
            let (code, capture) = drive(argv, &session);
            let stderr = capture.stderr();

            assert_eq!(code, UNUSABLE, "{argv:?}: {stderr}");
            assert!(
                stderr.contains("no Supabase Personal Access Token"),
                "{argv:?}: {stderr}"
            );
            assert!(
                !stderr.contains("could not resolve a database connection"),
                "{argv:?}: {stderr}"
            );
            assert_eq!(capture.stdout(), "", "{argv:?}");
        }
    }

    /// A purge over a direct connection checks `--access-token` the way
    /// `--project-ref` does, before it connects to anything.
    #[test]
    fn a_purge_refuses_an_access_token_that_is_not_one_before_connecting() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(
            &[
                "deprovision",
                "--purge",
                "--yes",
                "--db-url",
                "postgres://127.0.0.1:1/x",
                "--access-token",
                "eyJhbGciOiJIUzI1NiJ9.e30.x",
            ],
            &session,
        );
        let stderr = capture.stderr();

        assert_eq!(code, UNUSABLE, "{stderr}");
        assert!(
            stderr.contains("that is not a Personal Access Token (sbp_…)"),
            "{stderr}"
        );
        assert!(!stderr.contains("could not connect"), "{stderr}");
    }

    /// An environment value that is not a token warns once, and the purge
    /// falls back to the by-hand step; a missing one says nothing.
    #[test]
    fn an_environment_token_that_is_not_one_warns_and_is_not_used() {
        for (pairs, warned) in [
            (
                &[("SUPABASE_ACCESS_TOKEN", "eyJhbGciOiJIUzI1NiJ9.e30.x")][..],
                true,
            ),
            (&[][..], false),
        ] {
            let env = Env::from_pairs(pairs);
            let (mut ui, capture) = Ui::capture();
            let token = purge_token(None, &env, &mut ui).unwrap();

            assert!(usable_token(token, &mut ui).is_none(), "{pairs:?}");
            assert_eq!(
                capture
                    .stderr()
                    .matches("that is not a Personal Access Token")
                    .count(),
                usize::from(warned),
                "{pairs:?}: {}",
                capture.stderr()
            );
        }
    }

    /// `--local-only` is refused on `deprovision` whichever transport is named.
    #[test]
    fn deprovision_local_only_is_refused_over_a_project_ref_too() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(
            &["deprovision", "--local-only", "--project-ref", "abcd"],
            &session,
        );

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("--local-only has no ledger to read")
        );
        assert!(!capture.stderr().contains("Personal Access Token"));
    }

    #[test]
    fn status_json_and_quiet_are_mutually_exclusive() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["status", "--json", "--quiet"], &session);

        assert_eq!(code, UNUSABLE);
        assert_eq!(capture.stdout(), "");
        assert!(capture.stderr().contains("cannot be used with"));
    }

    #[test]
    fn status_json_cannot_be_combined_with_format_text() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["status", "--json", "--format", "text"], &session);

        assert_eq!(code, UNUSABLE);
        assert_eq!(capture.stdout(), "");
        assert!(
            capture
                .stderr()
                .contains("--json cannot be combined with --format text")
        );
    }

    #[test]
    fn mock_without_a_subcommand_is_a_usage_error() {
        let (_guard, session) = empty_session();
        let (code, _) = drive(&["mock"], &session);

        assert_eq!(code, UNUSABLE);
    }

    #[test]
    fn init_without_yes_or_flags_refuses_in_a_non_tty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        let session = Session::new(dir.path(), pack_env());
        let (code, capture) = drive(&["init", "--local-only"], &session);

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("refusing to write without confirmation")
        );
    }

    /// Nothing to script and no terminal: the usage line, and no connection is
    /// asked for on the way to it.
    #[test]
    fn sync_without_flags_refuses_in_a_non_tty() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["sync"], &session);

        assert_eq!(code, UNUSABLE);
        assert!(capture.stderr().contains("--add"));
        assert!(!capture.stderr().contains("database"));
    }

    /// One JSONL line per check, every one failing but the engine check: an
    /// empty directory has no project and no database, which is a real
    /// failure, exit 1, and no `package.json` naming an app client.
    #[test]
    fn doctor_runs_offline_against_the_session_directory() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["doctor", "--ci"], &session);
        let stdout = capture.stdout();
        let (engine, others): (Vec<&str>, Vec<&str>) = stdout
            .lines()
            .partition(|line| line.contains("\"check\":\"engine-artifact\""));

        assert_eq!(code, crate::commands::FAILURE);
        assert_eq!(engine.len() + others.len(), 21);
        assert!(engine[0].contains("\"level\":\"ok\""), "{}", engine[0]);
        assert!(
            others
                .iter()
                .all(|line| line.contains("\"level\":\"error\""))
        );
    }

    /// `lint` reads its synced set from the database, so with none resolvable
    /// it stops at resolution, and it must do so against the session's
    /// directory, not the process working directory.
    #[test]
    fn lint_reads_the_session_directory_not_the_process_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("supabase").join("migrations")).unwrap();
        std::fs::write(
            dir.path()
                .join("supabase")
                .join("migrations")
                .join("0001.sql"),
            "drop table todos;",
        )
        .unwrap();
        let session = Session::new(dir.path(), Env::default());
        let (code, capture) = drive(&["lint"], &session);

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("could not resolve a database connection")
        );

        // Without the migrations directory the answer is the other exit-2 sentence.
        let empty = tempfile::tempdir().unwrap();
        let (code, capture) = drive(&["lint"], &Session::new(empty.path(), Env::default()));

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("no supabase/migrations directory")
        );
    }

    #[test]
    fn a_dry_run_seed_needs_no_database_and_prints_deterministic_sql() {
        let dir = tempfile::tempdir().unwrap();
        let session = Session::new(dir.path(), Env::default());
        let (code, first) = drive(
            &[
                "mock",
                "seed",
                "--table",
                "todos",
                "--rows",
                "3",
                "--dry-run",
            ],
            &session,
        );
        let (_, second) = drive(
            &[
                "mock",
                "seed",
                "--table",
                "todos",
                "--rows",
                "3",
                "--dry-run",
            ],
            &session,
        );

        assert_eq!(code, OK);
        assert!(first.stdout().contains("insert into public.\"todos\""));
        assert_eq!(first.stdout(), second.stdout());
    }

    #[test]
    fn a_dry_run_churn_needs_no_database() {
        let dir = tempfile::tempdir().unwrap();
        let session = Session::new(dir.path(), Env::default());
        let (code, capture) = drive(
            &[
                "mock",
                "churn",
                "--table",
                "todos",
                "--iterations",
                "2",
                "--dry-run",
            ],
            &session,
        );

        assert_eq!(code, OK);
        assert_eq!(capture.stdout().lines().count(), 2);
    }

    #[test]
    fn deprovision_local_only_refuses_before_resolving_anything() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["deprovision", "--local-only"], &session);

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("--local-only has no ledger to read")
        );
    }

    #[test]
    fn a_command_that_needs_a_database_names_every_rung_it_tried() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["deprovision"], &session);

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("could not resolve a database connection")
        );
        assert!(capture.stderr().contains("KSYNC_DB_URL"));
    }

    #[test]
    fn a_project_ref_run_without_a_token_says_where_to_get_one() {
        let (_guard, session) = empty_session();
        let (code, capture) = drive(&["status", "--project-ref", "abcd"], &session);

        assert_eq!(code, UNUSABLE);
        assert!(
            capture
                .stderr()
                .contains("no Supabase Personal Access Token")
        );
    }

    /// A ref becomes a host label and a URL path segment, so one that is not
    /// lowercase letters and digits is refused while the flags are parsed, on
    /// every command that takes it, before a token or a transport is sought.
    #[test]
    fn an_invalid_project_ref_is_refused_while_the_flags_are_parsed() {
        for (argv, value) in [
            (
                &["init", "--project-ref", "evil.example/x#"][..],
                "evil.example/x#",
            ),
            (&["sync", "--project-ref", "ABC"][..], "ABC"),
            (&["status", "--project-ref", "a-b"][..], "a-b"),
            (&["doctor", "--project-ref", "a b"][..], "a b"),
            (&["lint", "--project-ref", "a/b"][..], "a/b"),
            (&["upgrade", "--project-ref", ""][..], ""),
            (&["deprovision", "--project-ref", "a.b"][..], "a.b"),
            (&["jobs", "list", "--project-ref", "A1"][..], "A1"),
        ] {
            let (_guard, session) = empty_session();
            let (code, capture) = drive(argv, &session);
            let stderr = capture.stderr();

            assert_eq!(code, UNUSABLE, "{argv:?}: {stderr}");
            assert!(
                stderr.contains(&format!("invalid value '{value}' for '--project-ref")),
                "{argv:?}: {stderr}"
            );
            assert!(
                stderr.contains("not a Supabase project ref"),
                "{argv:?}: {stderr}"
            );
            assert!(
                !stderr.contains("Personal Access Token"),
                "{argv:?}: {stderr}"
            );
        }
    }

    #[test]
    fn no_color_strips_the_ansi_escapes() {
        let (_guard, session) = empty_session();
        let (mut ui, capture) = Ui::capture();
        ui.set_color(ColorMode::On);
        run(
            &["--no-color".to_owned(), "init".to_owned()],
            &session,
            &mut ui,
        );

        assert!(!capture.stderr().contains('\u{1b}'));
    }

    #[test]
    fn the_no_color_environment_variable_is_honoured_too() {
        let dir = tempfile::tempdir().unwrap();
        let session = Session::new(dir.path(), Env::from_pairs(&[("NO_COLOR", "1")]));
        let (mut ui, capture) = Ui::capture();
        ui.set_color(ColorMode::On);
        run(&["init".to_owned()], &session, &mut ui);

        assert!(!capture.stderr().contains('\u{1b}'));
    }
}
