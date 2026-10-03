//! `doctor`: project-shape checks.
//!
//! The first check reads `kizunasync._config`, the project's own record of what
//! syncs, and every other check but `api-schemas-live` is a filesystem stat
//! against the app repo. The live probe is the single deliberate exception: it
//! asks the project's Data API whether `kizunasync` is really exposed, and it
//! runs ONLY when both a URL and a publishable key resolve (flags, the
//! environment, the project's `.env` files, or the linked project through the
//! Management API: @crates/kizunasync-cli/src/commands/doctor/target.rs). Without
//! both it is skipped silently.
//!
//! An unreachable database fails the one check that needs it and leaves the rest
//! reporting: a doctor that cannot connect still has something to say.
//!
//! `--ci` emits one JSON object per check (JSONL) on stdout and exits non-zero
//! on any failure, so CI can gate on it.

use crate::applier::Applier;
use crate::commands::{FAILURE, OK};
use crate::config::load_config_from_db;
use crate::constants::{INTERNAL_CONFIG, SCHEMA};
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::error::{Error, Result};
use crate::management::{HttpTransport, ReqwestTransport};
use crate::pack::{PackFile, read_pack_files, resolve_pack_dir};
use crate::project_ref::ProjectRef;
use crate::ui::Ui;
use crate::workdir::ProjectPaths;
use std::path::{Path, PathBuf};

mod pack;
mod target;

pub use pack::PUBLIC_RPCS;
pub use target::{ProbeInputs, ProbeResolution, ProbeTarget, resolve_probe_target};

/// How loud a check's verdict is.
///
/// Three levels, not two, because one thing the pack checks is neither pass nor
/// failure: a job that has never run on a freshly installed pack is not broken,
/// and reporting it as an error would make a correct install exit 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckLevel {
    /// It passed.
    Ok,
    /// It did not pass, and that is not a failure by itself.
    Warn,
    /// It failed. Any one of these makes `doctor` exit 1.
    Error,
}

impl CheckLevel {
    /// The token `--ci` writes and the human report keys its glyph on.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }

    /// Error for a failed check, ok for a passed one: the two-state verdict
    /// every filesystem check still has.
    #[must_use]
    pub const fn from_ok(ok: bool) -> Self {
        if ok { Self::Ok } else { Self::Error }
    }
}

/// One check and its verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    /// Stable machine id for `--ci` consumers.
    pub id: String,
    /// What was checked.
    pub label: String,
    /// How to fix it.
    pub hint: String,
    /// How loud the verdict is.
    pub level: CheckLevel,
}

impl Check {
    /// A passing or failing check, for the two-state ones.
    #[must_use]
    pub fn new(id: &str, label: &str, hint: &str, ok: bool) -> Self {
        Self {
            id: id.to_owned(),
            label: label.to_owned(),
            hint: hint.to_owned(),
            level: CheckLevel::from_ok(ok),
        }
    }

    /// The same check at a named level.
    #[must_use]
    pub fn at(id: &str, label: &str, hint: &str, level: CheckLevel) -> Self {
        Self {
            id: id.to_owned(),
            label: label.to_owned(),
            hint: hint.to_owned(),
            level,
        }
    }

    /// Whether it passed.
    #[must_use]
    pub const fn passed(&self) -> bool {
        matches!(self.level, CheckLevel::Ok)
    }

    /// Whether it is one of the failures that make `doctor` exit 1.
    #[must_use]
    pub const fn failed(&self) -> bool {
        matches!(self.level, CheckLevel::Error)
    }
}

/// PostgREST serves only the schemas listed in `[api].schemas`, so a project
/// that never lists ours answers every `kizunasync` RPC with PGRST106. The same
/// hint fixes both the local file and the hosted project.
const API_SCHEMAS_FIX_HINT: &str = "add \"kizunasync\" to [api].schemas in supabase/config.toml, then run `supabase config push` (hosted-only setups: Dashboard → Settings → API → Exposed schemas)";

/// The engine ships as a platform package, so a project whose install skipped
/// the optional dependency has no addon to load and `createKizunaSync` throws
/// `ENGINE_UNAVAILABLE` at the first client it builds.
const ENGINE_ARTIFACT_FIX_HINT: &str = "reinstall kizunasync so its @kizunasync/{platform} optional dependency installs (run your package manager's install without --no-optional or --omit=optional)";

/// An Expo or React Native app compiles the engine from the module inside
/// `kizunasync` into its development build.
const RN_FIX_HINT: &str =
    "reinstall kizunasync (run your package manager's install), then build the app again";

/// A web app loads the WebAssembly engine from `kizunasync`'s worker.
const WEB_FIX_HINT: &str = "reinstall kizunasync (run your package manager's install)";

/// The app client is declared but its files are not in `node_modules`.
const NOT_INSTALLED_FIX_HINT: &str = "install kizunasync (run your package manager's install)";

/// What a project without a JavaScript app client adds once it has one.
const NO_APP_CLIENT_HINT: &str = "add kizunasync to package.json";

/// The React Native module's podspec, which marks the module as shipped.
const RN_PODSPEC: &str = "RnUniffi.podspec";

/// The WebAssembly engine the web worker loads, relative to the package.
const WEB_WASM: &str = "dist/web/wasm/kizunasync_wasm_bg.wasm";

/// `kizunasync._config` is provisioned by the migration `init` emits, so a
/// project that has never run it has nothing to read.
const CONFIG_TABLES_FIX_HINT: &str = "run `kizunasync init` to provision this project";

/// PostgREST's root endpoint: it answers for the requested profile, or refuses.
const PROBE_PATH: &str = "/rest/v1/";
/// PostgREST's answer when the requested profile is not an exposed schema.
const NOT_EXPOSED_STATUS: u16 = 406;
const NOT_EXPOSED_CODE: &str = "PGRST106";

/// The checks, in report order: the project's own record first, then everything
/// the pack installed into the database, then the filesystem. Every filesystem
/// one reads the resolved project root, so a run from a subdirectory reports on
/// the project rather than on wherever the developer was standing.
/// `pack_files` is this build's pack, the one the ledger check holds the
/// ledger against; `None` skips that comparison.
#[must_use]
pub fn run_checks(
    applier: &dyn Applier,
    paths: &ProjectPaths,
    pack_files: Option<&[PackFile]>,
) -> Vec<Check> {
    let mut checks = vec![check_config_tables(applier)];
    checks.extend(pack::run_checks(applier, pack_files));
    checks.extend([
        Check::new(
            "supabase-dir",
            "supabase/ project directory",
            "run `supabase init` so migrations have a home",
            paths.config_toml.exists(),
        ),
        Check::new(
            "migrations-dir",
            "supabase/migrations directory",
            "create it (the SQL pack rides your migration pipeline)",
            paths.migrations_dir.exists(),
        ),
        Check::new(
            "package-json",
            "package.json present at the resolved project root",
            "resolved the wrong root? point --workdir at your app, or run `kizunasync` from inside it",
            paths.root.join("package.json").exists(),
        ),
        check_api_schemas(paths),
        check_engine_artifact(paths, std::env::consts::OS, std::env::consts::ARCH),
    ]);

    checks
}

/// The npm platform package for `os`/`arch` and the library file it ships, or
/// `None` for a host without one. The table is the one
/// `scripts/prepare-npm-release.ts` publishes from; Rust spells the host
/// differently from npm (`macos`/`aarch64` against `darwin`/`arm64`), so the
/// translation lives here rather than in a format string.
fn napi_platform_package(os: &str, arch: &str) -> Option<(&'static str, &'static str)> {
    match (os, arch) {
        ("macos", "aarch64") => Some(("darwin-arm64", "libkizunasync_napi.dylib")),
        ("macos", "x86_64") => Some(("darwin-x64", "libkizunasync_napi.dylib")),
        ("linux", "x86_64") => Some(("linux-x64-gnu", "libkizunasync_napi.so")),
        ("linux", "aarch64") => Some(("linux-arm64-gnu", "libkizunasync_napi.so")),
        ("windows", "x86_64") => Some(("win32-x64-msvc", "kizunasync_napi.dll")),
        _ => None,
    }
}

/// The engine an app client runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppEngine {
    /// `expo` or `react-native` in `dependencies`.
    ReactNative,
    /// `react-dom`, `vue`, or `vite` in `dependencies` or `devDependencies`.
    Web,
    /// Any other app that declares `kizunasync`: the N-API addon on Node or Bun.
    Napi,
}

/// The engine the app client in the root's `package.json` runs, `None` when
/// `dependencies` does not name `kizunasync` or there is no `package.json`.
/// `Err` names a `package.json` that cannot be read.
fn app_engine(root: &Path) -> std::result::Result<Option<AppEngine>, String> {
    let body = match std::fs::read_to_string(root.join("package.json")) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read package.json: {error}")),
    };
    let manifest: serde_json::Value = serde_json::from_str(&body)
        .map_err(|cause| format!("package.json does not parse: {cause}"))?;
    let section = |name: &str| manifest.get(name).and_then(serde_json::Value::as_object);
    let Some(dependencies) = section("dependencies") else {
        return Ok(None);
    };
    if !dependencies.contains_key("kizunasync") {
        return Ok(None);
    }

    let in_dependencies = |package: &str| dependencies.contains_key(package);
    if in_dependencies("expo") || in_dependencies("react-native") {
        return Ok(Some(AppEngine::ReactNative));
    }

    let in_either = |package: &str| {
        in_dependencies(package)
            || section("devDependencies").is_some_and(|dev| dev.contains_key(package))
    };
    if ["react-dom", "vue", "vite"].into_iter().any(in_either) {
        return Ok(Some(AppEngine::Web));
    }

    Ok(Some(AppEngine::Napi))
}

fn check_engine_artifact(paths: &ProjectPaths, os: &str, arch: &str) -> Check {
    let id = "engine-artifact";
    let engine = match app_engine(&paths.root) {
        Err(cause) => return Check::new(id, "the app client's Rust engine", &cause, false),
        Ok(None) => {
            return Check::new(
                id,
                "no JavaScript app client in package.json",
                NO_APP_CLIENT_HINT,
                true,
            );
        }
        Ok(Some(engine)) => engine,
    };

    let package_dir = paths.root.join("node_modules").join("kizunasync");
    if !package_dir.join("package.json").exists() {
        return Check::new(
            id,
            &format!("kizunasync installed at {}", package_dir.display()),
            NOT_INSTALLED_FIX_HINT,
            false,
        );
    }

    match engine {
        AppEngine::ReactNative => {
            let podspec = package_dir.join(RN_PODSPEC);

            Check::new(
                id,
                &format!(
                    "Rust engine React Native module in kizunasync at {} (it builds into the app with a development build)",
                    podspec.display()
                ),
                RN_FIX_HINT,
                podspec.exists(),
            )
        }
        AppEngine::Web => {
            let wasm = package_dir.join(WEB_WASM);

            Check::new(
                id,
                &format!(
                    "Rust engine WebAssembly in kizunasync at {}",
                    wasm.display()
                ),
                WEB_FIX_HINT,
                wasm.exists(),
            )
        }
        AppEngine::Napi => check_napi_artifact(&package_dir, os, arch),
    }
}

/// Where `@kizunasync/<triple>/<library>` resolves Node-style from the real
/// directory of the installed `kizunasync`: its own `node_modules`, then each
/// ancestor named `node_modules`. When nothing resolves, the first candidate,
/// the place a plain install puts it.
fn engine_artifact_path(package_dir: &Path, triple: &str, library: &str) -> PathBuf {
    let real = std::fs::canonicalize(package_dir).unwrap_or_else(|_| package_dir.to_path_buf());
    let in_modules = |modules: &Path| modules.join("@kizunasync").join(triple).join(library);
    let own = in_modules(&real.join("node_modules"));
    let ancestors = real
        .ancestors()
        .filter(|dir| dir.file_name().is_some_and(|name| name == "node_modules"))
        .map(in_modules);

    std::iter::once(own.clone())
        .chain(ancestors)
        .find(|path| path.exists())
        .unwrap_or(own)
}

fn check_napi_artifact(package_dir: &Path, os: &str, arch: &str) -> Check {
    let id = "engine-artifact";
    let Some((triple, library)) = napi_platform_package(os, arch) else {
        return Check::new(
            id,
            &format!("Rust engine artifact for {os}-{arch}"),
            &format!("no @kizunasync platform package is published for {os}-{arch}"),
            false,
        );
    };

    let path = engine_artifact_path(package_dir, triple, library);

    Check::new(
        id,
        &format!(
            "Rust engine artifact @kizunasync/{triple} at {}",
            path.display()
        ),
        &ENGINE_ARTIFACT_FIX_HINT.replace("{platform}", triple),
        path.exists(),
    )
}

/// The configuration record itself: the tables the server syncs. An unreachable
/// database and an uninstalled pack both land here, and both are fixed by the
/// same command.
fn check_config_tables(applier: &dyn Applier) -> Check {
    let id = "config-tables";
    match load_config_from_db(applier) {
        Ok(config) => Check::new(
            id,
            &format!(
                "{SCHEMA}.{INTERNAL_CONFIG} reachable, {} synced table(s)",
                config.tables.len()
            ),
            CONFIG_TABLES_FIX_HINT,
            true,
        ),
        Err(cause) => Check::new(
            id,
            &format!("{SCHEMA}.{INTERNAL_CONFIG} reachable"),
            &format!(
                "{}\n      {CONFIG_TABLES_FIX_HINT}",
                under_the_arrow(&cause.to_string())
            ),
            false,
        ),
    }
}

/// A multi-line cause, re-indented to sit under the report's `→` marker: the
/// message carries its own indentation for the commands that print it on its
/// own, which does not line up once it is nested inside a check.
pub(crate) fn under_the_arrow(cause: &str) -> String {
    cause
        .lines()
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n      ")
}

fn check_api_schemas(paths: &ProjectPaths) -> Check {
    let label = format!("{SCHEMA} exposed in supabase/config.toml ([api].schemas)");
    let Ok(body) = std::fs::read_to_string(&paths.config_toml) else {
        return Check::new(
            "api-schemas",
            &label,
            &format!("run `supabase init` first, then {API_SCHEMAS_FIX_HINT}"),
            false,
        );
    };

    match crate::supabase_config::parse(&body) {
        Err(cause) => Check::new(
            "api-schemas",
            &label,
            &format!(
                "supabase/config.toml does not parse ({cause}): fix it, then {API_SCHEMAS_FIX_HINT}"
            ),
            false,
        ),
        Ok(config) => Check::new(
            "api-schemas",
            &label,
            API_SCHEMAS_FIX_HINT,
            config.api.schemas.is_some_and(|schemas| {
                schemas
                    .get_ref()
                    .iter()
                    .any(|name| name.get_ref() == SCHEMA)
            }),
        ),
    }
}

/// The one HTTP call doctor may make, narrowed to what the probe needs.
pub trait DataApiProbe {
    /// `GET url` with an `apikey` header and an `Accept-Profile` of `profile`.
    ///
    /// # Errors
    /// Returns [`Error::Transport`] when the host could not be reached at all.
    fn get(&self, url: &str, apikey: &str, profile: &str) -> Result<(u16, String)>;
}

/// The real probe: a blocking `reqwest` request.
pub struct ReqwestProbe;

impl DataApiProbe for ReqwestProbe {
    fn get(&self, url: &str, apikey: &str, profile: &str) -> Result<(u16, String)> {
        let response = reqwest::blocking::Client::builder()
            .build()
            .map_err(|cause| Error::Transport(cause.to_string()))?
            .get(url)
            .header("apikey", apikey)
            .header("Accept-Profile", profile)
            .send()
            .map_err(|cause| Error::Transport(cause.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .map_err(|cause| Error::Transport(cause.to_string()))?;

        Ok((status, body))
    }
}

/// Ask the project's Data API for the `kizunasync` profile. A 2xx means the
/// schema is really exposed; a 406/PGRST106 means it is not; anything else is
/// reported as itself. A transport failure is NEVER reported as not-exposed:
/// an unreachable host says nothing about the project's exposed schemas. The
/// key travels in the `apikey` header and is never echoed; the label names
/// where the URL and the key came from.
#[must_use]
pub fn probe_api_schemas_live(target: &ProbeTarget, probe: &dyn DataApiProbe) -> Check {
    let endpoint = format!("{}{PROBE_PATH}", target.url.trim_end_matches('/'));
    let label = format!(
        "{SCHEMA} exposed by the Data API at {endpoint} (live probe: {}, {})",
        target.url_origin, target.key_origin
    );
    let check = |hint: String, ok: bool| Check::new("api-schemas-live", &label, &hint, ok);

    match probe.get(&endpoint, &target.key, SCHEMA) {
        Err(cause) => check(format!("could not reach {endpoint}: {cause}"), false),
        Ok((status, body)) => {
            if (200..300).contains(&status) {
                return check(API_SCHEMAS_FIX_HINT.to_owned(), true);
            }
            if status == NOT_EXPOSED_STATUS || body.contains(NOT_EXPOSED_CODE) {
                return check(API_SCHEMAS_FIX_HINT.to_owned(), false);
            }

            check(
                format!(
                    "the Data API answered {status}: check the URL and the publishable key you passed"
                ),
                false,
            )
        }
    }
}

/// The verdict glyph and its space, which every report line starts with.
const MARK_WIDTH: usize = 2;

/// `text` with each line cut at its spaces to `width` columns, when the
/// report is drawn inside the control panel's frame: a line the terminal
/// wraps itself restarts outside the frame.
fn framed(text: &str, width: Option<usize>) -> String {
    let Some(width) = width else {
        return text.to_owned();
    };

    text.lines()
        .flat_map(|line| {
            let body = line.trim_start();
            let indent = &line[..line.len() - body.len()];

            crate::wizard_theme::wrap_at(body, width, " ")
                .into_iter()
                .map(move |part| format!("{indent}{part}"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Render the report and produce the exit code. `--ci` writes JSONL to stdout;
/// the human view writes ✓/⚠/✗ lines to stderr. Only an error-level check makes
/// the exit code non-zero: a warning is something to know, not something that
/// failed.
pub fn report(checks: &[Check], ci: bool, ui: &mut Ui) -> i32 {
    let failures = checks.iter().filter(|check| check.failed()).count();
    let warnings = checks
        .iter()
        .filter(|check| check.level == CheckLevel::Warn)
        .count();

    if ci {
        for check in checks {
            let line = serde_json::json!({
                "check": check.id,
                "level": check.level.as_str(),
                "message": if check.passed() { &check.label } else { &check.hint },
            });
            ui.write_stdout(&format!("{line}\n"));
        }

        return if failures == 0 { OK } else { FAILURE };
    }

    ui.log("kizunasync doctor: project checks\n");
    let width = crate::wizard_theme::bar_width().map(|width| width.saturating_sub(MARK_WIDTH));
    for check in checks {
        let line = match check.level {
            CheckLevel::Ok => check.label.clone(),
            CheckLevel::Warn | CheckLevel::Error => {
                format!("{}\n    → {}", check.label, check.hint)
            }
        };
        let line = framed(&line, width);
        match check.level {
            CheckLevel::Ok => ui.success(&line),
            CheckLevel::Warn => ui.warn(&line),
            CheckLevel::Error => ui.error(&line),
        }
    }
    ui.log("");
    if failures == 0 {
        if warnings > 0 {
            ui.warn(&format!("all checks passed, {warnings} with a warning"));

            return OK;
        }
        ui.success("all checks passed");

        return OK;
    }

    ui.error(&format!("{failures} check(s) failed"));

    FAILURE
}

/// Flags `doctor` accepts.
///
/// `Debug` is written by hand: `access_token` is a secret, so it renders
/// masked.
#[derive(Clone, Default)]
pub struct DoctorFlags {
    /// Emit JSONL instead of the human report.
    pub ci: bool,
    /// Project URL for the live probe.
    pub url: Option<String>,
    /// Publishable key for the live probe.
    pub publishable_key: Option<String>,
    /// `--project-ref`: the project the probe target can be derived from.
    pub project_ref: Option<ProjectRef>,
    /// `--access-token`: the token that derivation uses.
    pub access_token: Option<String>,
}

impl std::fmt::Debug for DoctorFlags {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DoctorFlags")
            .field("ci", &self.ci)
            .field("url", &self.url)
            .field("publishable_key", &self.publishable_key)
            .field("project_ref", &self.project_ref)
            .field("access_token", &self.access_token.as_ref().map(|_| "***"))
            .finish()
    }
}

/// What `doctor` reaches outside the project besides its database.
pub struct DoctorPorts<'a> {
    /// The project's `.env` files.
    pub env_files: &'a EnvFileValues,
    /// The live Data API probe.
    pub data_api: &'a dyn DataApiProbe,
    /// The Management API transport, `None` when no client could be built.
    pub management: Option<&'a dyn HttpTransport>,
}

/// The production transports behind [`DoctorPorts`]: the live Data API probe,
/// and the Management API client when one could be built. `kizunasync doctor`
/// and the control panel's health check both run over these.
pub struct LivePorts {
    management: Option<ReqwestTransport>,
}

impl LivePorts {
    /// Build the Management API client. A client that cannot be built leaves
    /// the probe target to the flags, the environment, and the `.env` files.
    #[must_use]
    pub fn new() -> Self {
        Self {
            management: ReqwestTransport::new().ok(),
        }
    }

    /// The ports, over the project's `.env` files.
    #[must_use]
    pub fn ports<'a>(&'a self, env_files: &'a EnvFileValues) -> DoctorPorts<'a> {
        DoctorPorts {
            env_files,
            data_api: &ReqwestProbe,
            management: self
                .management
                .as_ref()
                .map(|transport| transport as &dyn HttpTransport),
        }
    }
}

impl Default for LivePorts {
    fn default() -> Self {
        Self::new()
    }
}

/// Run the checks, optionally probing, and report.
pub fn run(
    flags: &DoctorFlags,
    applier: &dyn Applier,
    paths: &ProjectPaths,
    env: &Env,
    ports: &DoctorPorts<'_>,
    ui: &mut Ui,
) -> i32 {
    let pack_files = match resolve_pack_dir(env).map(|pack_dir| read_pack_files(&pack_dir)) {
        Some(Ok(files)) => Some(files),
        Some(Err(cause)) => {
            ui.warn(&format!(
                "{cause}\n  the ledger check skips the comparison with this build's pack."
            ));

            None
        }
        None => None,
    };
    let mut checks = run_checks(applier, paths, pack_files.as_deref());
    let inputs = ProbeInputs {
        url: flags.url.as_deref(),
        publishable_key: flags.publishable_key.as_deref(),
        project_ref: flags.project_ref.as_ref(),
        access_token: flags.access_token.as_deref(),
        env,
        env_files: ports.env_files,
        paths,
        management: ports.management,
    };
    match resolve_probe_target(&inputs) {
        ProbeResolution::Target(target) => {
            checks.push(probe_api_schemas_live(&target, ports.data_api));
        }
        ProbeResolution::Skipped(line) => ui.warn(&line),
        ProbeResolution::Absent => {}
    }

    report(&checks, flags.ci, ui)
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeSet;

    use super::*;
    use crate::applier::fake::{FakeApplier, text_row};
    use crate::ui::Capture;

    struct FakeProbe {
        answer: Result<(u16, String)>,
        seen: RefCell<Vec<(String, String, String)>>,
    }

    impl FakeProbe {
        fn ok(status: u16, body: &str) -> Self {
            Self {
                answer: Ok((status, body.to_owned())),
                seen: RefCell::new(Vec::new()),
            }
        }

        fn unreachable() -> Self {
            Self {
                answer: Err(Error::Transport("connection refused".to_owned())),
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl DataApiProbe for FakeProbe {
        fn get(&self, url: &str, apikey: &str, profile: &str) -> Result<(u16, String)> {
            self.seen
                .borrow_mut()
                .push((url.to_owned(), apikey.to_owned(), profile.to_owned()));

            match &self.answer {
                Ok(value) => Ok(value.clone()),
                Err(cause) => Err(Error::Transport(cause.to_string())),
            }
        }
    }

    fn healthy_project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("supabase").join("migrations")).unwrap();
        std::fs::write(
            root.join("supabase").join("config.toml"),
            "[api]\nschemas = [\"public\", \"kizunasync\"]\n",
        )
        .unwrap();
        std::fs::write(root.join("package.json"), "{}").unwrap();

        (dir, root)
    }

    fn ui() -> (Ui, Capture) {
        Ui::capture()
    }

    fn paths_for(root: &Path) -> ProjectPaths {
        ProjectPaths::rooted_at(root.to_path_buf())
    }

    /// A provisioned project as `kizunasync._config` answers for it.
    fn provisioned() -> FakeApplier {
        FakeApplier::new().answer(
            INTERNAL_CONFIG,
            vec![text_row(&[
                ("table_name", "todos"),
                ("sync_mode", "read-write"),
            ])],
        )
    }

    /// A database nothing can be read from.
    fn unreachable_db() -> FakeApplier {
        FakeApplier::new().fail("", "connection refused")
    }

    /// The checks that read what the pack installed. This fixture answers for
    /// `kizunasync._config` and nothing else, so they are driven against a full
    /// catalog in `pack::tests` instead.
    const PACK_CHECKS: [&str; 15] = [
        "pg-cron",
        "jobs",
        "job-runs",
        "core-rpcs",
        "triggers",
        "table-primary-key",
        "sync-key",
        "rls-enabled",
        "trigger-search-path",
        "change-stamp",
        "realtime-policy",
        "role-and-grants",
        "column-privileges",
        "require-atomic",
        "ledger",
    ];

    fn ids(checks: &[Check]) -> Vec<&str> {
        checks.iter().map(|check| check.id.as_str()).collect()
    }

    #[test]
    fn the_report_is_the_config_record_then_the_pack_then_the_filesystem() {
        let (_guard, root) = healthy_project();
        let checks = run_checks(&provisioned(), &paths_for(&root), None);

        assert_eq!(
            ids(&checks),
            [
                "config-tables",
                "pg-cron",
                "jobs",
                "job-runs",
                "core-rpcs",
                "triggers",
                "table-primary-key",
                "sync-key",
                "rls-enabled",
                "trigger-search-path",
                "change-stamp",
                "realtime-policy",
                "role-and-grants",
                "column-privileges",
                "require-atomic",
                "ledger",
                "supabase-dir",
                "migrations-dir",
                "package-json",
                "api-schemas",
                "engine-artifact"
            ]
        );
    }

    #[test]
    fn a_healthy_project_passes_every_check_that_does_not_read_the_pack() {
        let (_guard, root) = healthy_project();
        let checks = run_checks(&provisioned(), &paths_for(&root), None);

        for check in checks
            .iter()
            .filter(|check| !PACK_CHECKS.contains(&check.id.as_str()))
        {
            assert!(check.passed(), "{}: {}", check.id, check.hint);
        }
    }

    #[test]
    fn the_config_check_counts_the_synced_tables_it_read() {
        let check = check_config_tables(&provisioned());

        assert!(check.passed());
        assert_eq!(check.id, "config-tables");
        assert_eq!(
            check.label,
            "kizunasync._config reachable, 1 synced table(s)"
        );
    }

    #[test]
    fn an_unreachable_database_fails_that_check_and_points_at_init() {
        let check = check_config_tables(&unreachable_db());

        assert!(!check.passed());
        assert!(check.hint.contains("connection refused"));
        assert!(check.hint.contains("kizunasync init"));
    }

    /// Every check that needs the database fails, and the five that stat the
    /// project still report: a doctor that cannot connect has something to say.
    #[test]
    fn an_unreachable_database_leaves_the_filesystem_checks_reporting() {
        let (_guard, root) = healthy_project();
        let checks = run_checks(&unreachable_db(), &paths_for(&root), None);
        let passed: Vec<&str> = checks
            .iter()
            .filter(|check| check.passed())
            .map(|check| check.id.as_str())
            .collect();

        assert_eq!(
            passed,
            [
                "supabase-dir",
                "migrations-dir",
                "package-json",
                "api-schemas",
                "engine-artifact"
            ]
        );
    }

    /// A project whose `package.json` has these `dependencies` and `devDependencies`.
    fn project_with(dependencies: &[&str], dev_dependencies: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let section = |packages: &[&str]| -> serde_json::Map<String, serde_json::Value> {
            packages
                .iter()
                .map(|package| ((*package).to_owned(), serde_json::json!("*")))
                .collect()
        };
        std::fs::write(
            dir.path().join("package.json"),
            serde_json::json!({
                "dependencies": section(dependencies),
                "devDependencies": section(dev_dependencies),
            })
            .to_string(),
        )
        .unwrap();

        dir
    }

    fn depending_on(packages: &[&str]) -> tempfile::TempDir {
        project_with(packages, &[])
    }

    /// `kizunasync` as a package manager installs it in `modules`, with `files`
    /// beside its `package.json`. A file only has to exist: `doctor` stats the
    /// project rather than loading anything.
    fn install_kizunasync(modules: &Path, files: &[&str]) -> PathBuf {
        let package = modules.join("kizunasync");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("package.json"), "{}").unwrap();
        stage(&package, files);

        package
    }

    fn stage(dir: &Path, files: &[&str]) {
        for file in files {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
    }

    fn check_macos(dir: &Path) -> Check {
        check_engine_artifact(&paths_for(dir), "macos", "aarch64")
    }

    #[test]
    fn a_react_native_app_client_checks_the_module_inside_kizunasync() {
        for client in ["expo", "react-native"] {
            let dir = depending_on(&["kizunasync", client]);
            let missing = check_macos(dir.path());
            install_kizunasync(&dir.path().join("node_modules"), &["RnUniffi.podspec"]);
            let check = check_macos(dir.path());

            assert!(!missing.passed(), "{client}");
            assert!(check.passed(), "{client}: {}", check.hint);
            assert_eq!(check.id, "engine-artifact");
            assert!(
                check
                    .label
                    .starts_with("Rust engine React Native module in kizunasync at "),
                "{}",
                check.label
            );
            assert!(
                check
                    .label
                    .ends_with("node_modules/kizunasync/RnUniffi.podspec (it builds into the app with a development build)"),
                "{}",
                check.label
            );
        }
    }

    #[test]
    fn a_react_native_app_without_the_podspec_fails_with_the_reinstall_hint() {
        let dir = depending_on(&["kizunasync", "expo"]);
        install_kizunasync(&dir.path().join("node_modules"), &[]);
        let check = check_macos(dir.path());

        assert!(!check.passed());
        assert_eq!(
            check.hint,
            "reinstall kizunasync (run your package manager's install), then build the app again"
        );
    }

    #[test]
    fn a_web_app_client_checks_the_wasm_engine_inside_kizunasync() {
        let dir = project_with(&["kizunasync"], &["vite"]);
        install_kizunasync(&dir.path().join("node_modules"), &[]);
        let missing = check_macos(dir.path());
        stage(
            &dir.path().join("node_modules/kizunasync"),
            &["dist/web/wasm/kizunasync_wasm_bg.wasm"],
        );
        let installed = check_macos(dir.path());

        assert!(!missing.passed());
        assert_eq!(
            missing.hint,
            "reinstall kizunasync (run your package manager's install)"
        );
        assert!(installed.passed(), "{}", installed.hint);
        assert!(
            installed
                .label
                .starts_with("Rust engine WebAssembly in kizunasync at "),
            "{}",
            installed.label
        );
        assert!(
            installed
                .label
                .ends_with("node_modules/kizunasync/dist/web/wasm/kizunasync_wasm_bg.wasm"),
            "{}",
            installed.label
        );
    }

    #[test]
    fn react_dom_and_vue_in_dependencies_also_mark_a_web_app() {
        for marker in ["react-dom", "vue"] {
            let dir = depending_on(&["kizunasync", marker]);
            install_kizunasync(&dir.path().join("node_modules"), &[]);

            assert!(
                check_macos(dir.path())
                    .label
                    .starts_with("Rust engine WebAssembly"),
                "{marker}"
            );
        }
    }

    /// An app that names the framework in dependencies and a bundler beside it
    /// still runs the React Native engine.
    #[test]
    fn react_native_wins_over_a_web_bundler() {
        let dir = project_with(&["kizunasync", "react-native"], &["vite"]);
        install_kizunasync(&dir.path().join("node_modules"), &[]);

        assert!(
            check_macos(dir.path())
                .label
                .starts_with("Rust engine React Native module")
        );
    }

    /// No `kizunasync` in `dependencies`, whether the project lists nothing or
    /// lists it only under `devDependencies`, means no JavaScript engine.
    #[test]
    fn a_project_without_a_javascript_app_client_passes_and_says_so() {
        let dev_only = project_with(&[], &["kizunasync"]);
        for dir in [depending_on(&[]), depending_on(&["react"]), dev_only] {
            let check = check_engine_artifact(&paths_for(dir.path()), "freebsd", "x86_64");

            assert!(check.passed(), "{}", check.hint);
            assert_eq!(check.label, "no JavaScript app client in package.json");
            assert_eq!(check.hint, "add kizunasync to package.json");
        }
    }

    #[test]
    fn a_declared_but_uninstalled_kizunasync_fails_naming_the_install() {
        let dir = depending_on(&["kizunasync"]);
        let check = check_macos(dir.path());

        assert!(!check.passed());
        assert_eq!(
            check.hint,
            "install kizunasync (run your package manager's install)"
        );
    }

    #[test]
    fn the_engine_artifact_check_reports_the_installed_platform_package() {
        let dir = depending_on(&["kizunasync"]);
        let package = install_kizunasync(&dir.path().join("node_modules"), &[]);
        stage(
            &package,
            &["node_modules/@kizunasync/linux-x64-gnu/libkizunasync_napi.so"],
        );
        let check = check_engine_artifact(&paths_for(dir.path()), "linux", "x86_64");

        assert!(check.passed(), "{}", check.hint);
        assert_eq!(check.id, "engine-artifact");
        assert!(
            check
                .label
                .starts_with("Rust engine artifact @kizunasync/linux-x64-gnu at "),
            "{}",
            check.label
        );
        assert!(
            check
                .label
                .ends_with("@kizunasync/linux-x64-gnu/libkizunasync_napi.so"),
            "{}",
            check.label
        );
    }

    /// pnpm keeps `kizunasync` as a real directory under `.pnpm` and links its
    /// optional dependency beside it, so the app root never sees the platform
    /// package.
    #[test]
    fn a_pnpm_layout_finds_the_platform_package_beside_the_real_directory() {
        let dir = depending_on(&["kizunasync"]);
        let store = dir
            .path()
            .join("node_modules/.pnpm/kizunasync@0.2.6/node_modules");
        let real = install_kizunasync(&store, &[]);
        stage(
            &store,
            &["@kizunasync/darwin-arm64/libkizunasync_napi.dylib"],
        );
        let modules = dir.path().join("node_modules");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, modules.join("kizunasync")).unwrap();
        #[cfg(not(unix))]
        install_kizunasync(&modules, &[]);

        let check = check_macos(dir.path());

        assert!(check.passed(), "{}", check.hint);
        assert!(
            check
                .label
                .contains(".pnpm/kizunasync@0.2.6/node_modules/@kizunasync/darwin-arm64"),
            "{}",
            check.label
        );
    }

    #[test]
    fn an_npm_hoisted_layout_finds_the_platform_package_in_the_shared_node_modules() {
        let dir = depending_on(&["kizunasync"]);
        let modules = dir.path().join("node_modules");
        install_kizunasync(&modules, &[]);
        stage(
            &modules,
            &["@kizunasync/darwin-arm64/libkizunasync_napi.dylib"],
        );

        let check = check_macos(dir.path());

        assert!(check.passed(), "{}", check.hint);
    }

    #[test]
    fn a_missing_platform_package_fails_and_names_the_one_to_install() {
        let dir = depending_on(&["kizunasync"]);
        install_kizunasync(&dir.path().join("node_modules"), &[]);
        let check = check_macos(dir.path());

        assert!(!check.passed());
        assert_eq!(
            check.hint,
            "reinstall kizunasync so its @kizunasync/darwin-arm64 optional dependency installs (run your package manager's install without --no-optional or --omit=optional)"
        );
    }

    /// The npm platform table is published from `scripts/prepare-npm-release.ts`,
    /// and `napi-prebuild.test.ts` already fails when the loader drifts from it.
    /// This is the third copy's guard: a triple added or dropped there without a
    /// matching arm here would leave `doctor` reporting the wrong answer for a
    /// platform that has since gained a package, or naming one that was pulled.
    #[test]
    fn the_platform_table_agrees_with_the_release_script() {
        let script = std::fs::read_to_string("../../scripts/prepare-npm-release.ts")
            .expect("the release script");
        let quoted = |line: &str, key: &str| -> Option<String> {
            line.trim()
                .strip_prefix(key)
                .and_then(|rest| rest.split('\'').nth(1))
                .map(str::to_owned)
        };
        let mut triple: Option<String> = None;
        let mut published: BTreeSet<(String, String)> = BTreeSet::new();
        for line in script.lines() {
            if let Some(value) = quoted(line, "triple: ") {
                triple = Some(value);
            }
            if let Some(library) = quoted(line, "napiLibrary: ") {
                published.insert((triple.take().expect("a triple before its library"), library));
            }
        }

        let mapped: BTreeSet<(String, String)> = [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("windows", "x86_64"),
        ]
        .into_iter()
        .map(|(os, arch)| {
            let (triple, library) =
                napi_platform_package(os, arch).expect("a supported host maps to a package");
            (triple.to_owned(), library.to_owned())
        })
        .collect();

        assert_eq!(mapped, published);
    }

    #[test]
    fn a_platform_with_no_published_package_fails_naming_that_platform() {
        let dir = depending_on(&["kizunasync"]);
        install_kizunasync(&dir.path().join("node_modules"), &[]);
        let check = check_engine_artifact(&paths_for(dir.path()), "freebsd", "x86_64");

        assert!(!check.passed());
        assert!(check.label.contains("freebsd-x86_64"), "{}", check.label);
        assert!(check.hint.contains("freebsd-x86_64"), "{}", check.hint);
    }

    /// An empty directory has no `package.json`, so no app client names an
    /// engine to look for; every other check fails.
    #[test]
    fn an_empty_directory_with_no_database_fails_every_other_check_with_a_hint() {
        let dir = tempfile::tempdir().unwrap();
        let checks = run_checks(&unreachable_db(), &paths_for(dir.path()), None);
        let passed: Vec<&str> = checks
            .iter()
            .filter(|check| check.passed())
            .map(|check| check.id.as_str())
            .collect();

        assert_eq!(passed, ["engine-artifact"]);
        assert!(checks.iter().all(|check| !check.hint.is_empty()));
    }

    #[test]
    fn a_package_json_that_does_not_parse_fails_the_engine_check_naming_why() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), "{ not json").unwrap();
        let check = check_engine_artifact(&paths_for(dir.path()), "macos", "aarch64");

        assert!(!check.passed());
        assert!(
            check.hint.starts_with("package.json does not parse: "),
            "{}",
            check.hint
        );
    }

    #[test]
    fn a_config_toml_that_does_not_list_the_schema_fails_the_api_check() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("supabase")).unwrap();
        std::fs::write(
            dir.path().join("supabase").join("config.toml"),
            "[api]\nschemas = [\"public\"]\n",
        )
        .unwrap();
        let check = check_api_schemas(&paths_for(dir.path()));

        assert!(!check.passed());
        assert_eq!(check.hint, API_SCHEMAS_FIX_HINT);
    }

    #[test]
    fn a_missing_config_toml_asks_for_supabase_init_first() {
        let dir = tempfile::tempdir().unwrap();

        assert!(
            check_api_schemas(&paths_for(dir.path()))
                .hint
                .starts_with("run `supabase init` first")
        );
    }

    #[test]
    fn a_multi_line_schemas_array_that_lists_the_schema_passes_the_api_check() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("supabase")).unwrap();
        std::fs::write(
            dir.path().join("supabase").join("config.toml"),
            "[api]\nschemas = [\n  \"public\", # default\n  \"kizunasync\",\n]\n",
        )
        .unwrap();

        assert!(check_api_schemas(&paths_for(dir.path())).passed());
    }

    #[test]
    fn a_config_toml_that_does_not_parse_names_the_line_and_column() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("supabase")).unwrap();
        std::fs::write(
            dir.path().join("supabase").join("config.toml"),
            "[api]\nschemas = [\"kizunasync\"\n",
        )
        .unwrap();
        let check = check_api_schemas(&paths_for(dir.path()));

        assert!(!check.passed());
        assert!(
            check
                .hint
                .starts_with("supabase/config.toml does not parse (line "),
            "{}",
            check.hint
        );
        assert!(check.hint.contains(", column "), "{}", check.hint);
    }

    #[test]
    fn run_reads_the_probe_target_from_the_env_files_and_names_them() {
        let (_guard, root) = healthy_project();
        std::fs::write(
            root.join(".env.local"),
            "NEXT_PUBLIC_SUPABASE_URL=https://file.example\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=file-secret-key\n",
        )
        .unwrap();
        let files = crate::env_file::load(&root);
        let (mut ui, capture) = ui();
        let probe = FakeProbe::ok(200, "");
        run(
            &DoctorFlags {
                ci: true,
                ..DoctorFlags::default()
            },
            &provisioned(),
            &paths_for(&root),
            &Env::default(),
            &DoctorPorts {
                env_files: &files,
                data_api: &probe,
                management: None,
            },
            &mut ui,
        );

        assert_eq!(probe.seen.borrow()[0].1, "file-secret-key");
        let stdout = capture.stdout();
        let live = stdout
            .lines()
            .find(|line| line.contains("api-schemas-live"))
            .unwrap();
        assert!(
            live.contains("NEXT_PUBLIC_SUPABASE_URL from .env.local"),
            "{live}"
        );
        assert!(
            live.contains("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY from .env.local"),
            "{live}"
        );
        assert!(!stdout.contains("file-secret-key"));
    }

    #[test]
    fn run_names_a_failed_management_api_fallback_on_one_line_and_skips_the_probe() {
        struct Refusing;

        impl HttpTransport for Refusing {
            fn send(
                &self,
                _method: &str,
                _url: &str,
                _token: &str,
                _body: Option<&str>,
            ) -> Result<crate::management::HttpResponse> {
                Ok(crate::management::HttpResponse {
                    status: 401,
                    body: String::new(),
                })
            }
        }

        let (_guard, root) = healthy_project();
        let token = "sbp_0000000000000000000000000000000000000001";
        let env = Env::from_pairs(&[
            ("SUPABASE_ACCESS_TOKEN", token),
            ("SUPABASE_PROJECT_ID", "abcdefghijklmnopqrst"),
        ]);
        let (mut ui, capture) = ui();
        let probe = FakeProbe::ok(200, "");
        run(
            &DoctorFlags {
                ci: true,
                ..DoctorFlags::default()
            },
            &provisioned(),
            &paths_for(&root),
            &env,
            &DoctorPorts {
                env_files: &EnvFileValues::default(),
                data_api: &probe,
                management: Some(&Refusing),
            },
            &mut ui,
        );

        assert!(probe.seen.borrow().is_empty());
        assert!(!capture.stdout().contains("api-schemas-live"));
        let stderr = capture.stderr();
        let skipped: Vec<&str> = stderr
            .lines()
            .filter(|line| line.contains("live Data API probe skipped"))
            .collect();
        assert_eq!(
            skipped,
            ["⚠ live Data API probe skipped: could not read the project's API keys (HTTP 401)"]
        );
        assert!(!stderr.contains(token));
    }

    fn target(url: &str, key: &str) -> ProbeTarget {
        ProbeTarget {
            url: url.to_owned(),
            key: key.to_owned(),
            url_origin: "SUPABASE_URL from .env.local".to_owned(),
            key_origin: "env:VITE_SUPABASE_PUBLISHABLE_KEY".to_owned(),
        }
    }

    #[test]
    fn the_probe_sends_the_key_as_a_header_and_asks_for_our_profile() {
        let probe = FakeProbe::ok(200, "");
        let check = probe_api_schemas_live(&target("https://project.example/", "pub-key"), &probe);

        assert!(check.passed());
        assert_eq!(
            check.label,
            "kizunasync exposed by the Data API at https://project.example/rest/v1/ (live probe: SUPABASE_URL from .env.local, env:VITE_SUPABASE_PUBLISHABLE_KEY)"
        );
        assert_eq!(
            probe.seen.borrow()[0],
            (
                "https://project.example/rest/v1/".to_owned(),
                "pub-key".to_owned(),
                "kizunasync".to_owned()
            )
        );
    }

    #[test]
    fn a_406_or_a_pgrst106_body_means_not_exposed() {
        assert!(
            !probe_api_schemas_live(&target("https://p.example", "k"), &FakeProbe::ok(406, ""))
                .passed()
        );
        assert!(
            !probe_api_schemas_live(
                &target("https://p.example", "k"),
                &FakeProbe::ok(400, "{\"code\":\"PGRST106\"}")
            )
            .passed()
        );
    }

    #[test]
    fn another_status_is_reported_as_itself() {
        let check =
            probe_api_schemas_live(&target("https://p.example", "k"), &FakeProbe::ok(401, ""));

        assert!(!check.passed());
        assert!(check.hint.contains("answered 401"));
    }

    #[test]
    fn an_unreachable_host_is_never_reported_as_not_exposed() {
        let check =
            probe_api_schemas_live(&target("https://p.example", "k"), &FakeProbe::unreachable());

        assert!(!check.passed());
        assert!(
            check
                .hint
                .starts_with("could not reach https://p.example/rest/v1/")
        );
    }

    #[test]
    fn the_key_is_never_echoed_into_the_report() {
        let check = probe_api_schemas_live(
            &target("https://p.example", "super-secret"),
            &FakeProbe::ok(401, "super-secret"),
        );

        assert!(!format!("{} {}", check.label, check.hint).contains("super-secret"));
    }

    /// Inside the control panel's frame every report line fits the terminal,
    /// cut at its spaces; outside it the terminal wraps the line itself.
    #[test]
    fn a_report_line_inside_the_frame_is_cut_to_its_width() {
        let line = "kizunasync._provisions describes what the database holds\n    → grant execute on kizunasync.attachment_confirm to authenticated";

        assert_eq!(framed(line, None), line);
        let cut = framed(line, Some(30));
        assert_eq!(
            cut,
            "kizunasync._provisions\ndescribes what the database\nholds\n    → grant execute on\n    kizunasync.attachment_confirm\n    to authenticated"
        );
        for row in cut.lines() {
            assert!(
                row.trim_start().chars().count() <= 30 || !row.trim().contains(' '),
                "{row:?}"
            );
        }
    }

    #[test]
    fn ci_mode_writes_one_json_line_per_check_to_stdout() {
        let (mut sink, capture) = ui();
        let checks = [
            Check::new("a", "passed", "hint", true),
            Check::at("b", "warned", "hint", CheckLevel::Warn),
        ];
        let code = report(&checks, true, &mut sink);
        let stdout = capture.stdout();
        let lines: Vec<&str> = stdout.lines().collect();

        assert_eq!(code, OK);
        assert_eq!(capture.stderr(), "");
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(first["level"], "ok");
        assert_eq!(first["message"], "passed");
        assert_eq!(second["level"], "warn");
        assert_eq!(second["message"], "hint");
    }

    #[test]
    fn ci_mode_writes_one_line_for_every_check_the_project_produces() {
        let (_guard, root) = healthy_project();
        let (mut sink, capture) = ui();
        let checks = run_checks(&provisioned(), &paths_for(&root), None);
        report(&checks, true, &mut sink);

        assert_eq!(capture.stdout().lines().count(), checks.len());
    }

    /// A warning is something to know, not something that failed: it reaches
    /// `--ci` as its own level and leaves the exit code alone.
    #[test]
    fn a_warning_is_reported_without_changing_the_exit_code() {
        let (mut ui, capture) = ui();
        let checks = [Check::at(
            "job-runs",
            "never ran",
            "run it",
            CheckLevel::Warn,
        )];

        assert_eq!(report(&checks, false, &mut ui), OK);
        assert!(capture.stderr().contains("⚠ never ran"));
        assert!(
            capture
                .stderr()
                .contains("all checks passed, 1 with a warning")
        );
    }

    #[test]
    fn a_failing_check_is_an_error_line_and_exit_one() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ui, capture) = ui();
        let code = report(
            &run_checks(&unreachable_db(), &paths_for(dir.path()), None),
            true,
            &mut ui,
        );

        assert_eq!(code, FAILURE);
        assert!(capture.stdout().contains("\"level\":\"error\""));
    }

    #[test]
    fn the_human_report_stays_on_stderr() {
        let (_guard, root) = healthy_project();
        let (mut ui, capture) = ui();
        report(
            &run_checks(&provisioned(), &paths_for(&root), None),
            false,
            &mut ui,
        );

        assert_eq!(capture.stdout(), "");
        assert!(
            capture
                .stderr()
                .contains("kizunasync doctor: project checks")
        );
        assert!(capture.stderr().contains("supabase/ project directory"));
    }

    #[test]
    fn a_report_with_no_failure_says_every_check_passed() {
        let (mut ui, capture) = ui();
        let checks = [Check::new("a", "the one check", "hint", true)];

        assert_eq!(report(&checks, false, &mut ui), OK);
        assert!(capture.stderr().contains("all checks passed"));
    }

    #[test]
    fn run_appends_the_live_probe_only_when_a_target_resolves() {
        let (_guard, root) = healthy_project();
        let (mut ui, capture) = ui();
        let flags = DoctorFlags {
            ci: true,
            url: Some("https://p.example".to_owned()),
            publishable_key: Some("k".to_owned()),
            ..DoctorFlags::default()
        };
        let probe = FakeProbe::ok(200, "");
        run(
            &flags,
            &provisioned(),
            &paths_for(&root),
            &Env::default(),
            &DoctorPorts {
                env_files: &EnvFileValues::default(),
                data_api: &probe,
                management: None,
            },
            &mut ui,
        );
        let without_probe = run_checks(&provisioned(), &paths_for(&root), None).len();

        assert_eq!(capture.stdout().lines().count(), without_probe + 1);
        assert!(capture.stdout().contains("api-schemas-live"));
    }

    #[test]
    fn the_flags_never_debug_print_the_access_token() {
        let token = "sbp_0000000000000000000000000000000000000001";
        let flags = DoctorFlags {
            access_token: Some(token.to_owned()),
            ..DoctorFlags::default()
        };
        let rendered = format!("{flags:?}");

        assert!(!rendered.contains(token), "{rendered}");
        assert!(
            rendered.contains("access_token: Some(\"***\")"),
            "{rendered}"
        );
    }
}
