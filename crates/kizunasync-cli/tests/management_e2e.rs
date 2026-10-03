//! Opt-in live test of a fresh install over the Supabase Management API.
//!
//! `init --project-ref` sends a fresh install as one transaction: every pack
//! file with its ledger row, then the project config. Only a hosted project
//! proves the Management API runs that script as one, so this file talks to
//! a real one, and only when asked: without `KSYNC_MGMT_E2E=1` it skips,
//! naming what it needs.
//!
//! With the opt-in it needs `SUPABASE_ACCESS_TOKEN` and
//! `KSYNC_MGMT_E2E_PROJECT_REF`, naming a disposable project that carries no
//! Kizuna install. The run installs Kizuna into it: an install that fails
//! halfway must leave nothing behind, and the real pack must then land with
//! one ledger row per file. The Data API exposure is a separate call made
//! before the install, so it stays in place either way.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use kizunasync_cli::applier::Applier;
use kizunasync_cli::management::{ManagementApi, ReqwestTransport};
use kizunasync_cli::pack::read_pack_manifest;
use kizunasync_cli::project_ref::ProjectRef;
use kizunasync_cli::row::{require_bool, require_string};

const OPT_IN: &str = "KSYNC_MGMT_E2E";
const PROJECT_REF: &str = "KSYNC_MGMT_E2E_PROJECT_REF";
const TOKEN: &str = "SUPABASE_ACCESS_TOKEN";

/// The disposable project and the token that reaches it.
struct Target {
    project_ref: String,
    token: String,
}

/// `Some` only under the opt-in. Without it the test skips with the reason;
/// with it, a missing variable is a failure, because the run was asked for.
fn target() -> Option<Target> {
    if std::env::var(OPT_IN).as_deref() != Ok("1") {
        eprintln!(
            "[mgmt-e2e] SKIPPED: {OPT_IN} is not 1. Set {OPT_IN}=1, {TOKEN}, and {PROJECT_REF} naming a disposable Supabase project with no Kizuna install to run the Management API install."
        );

        return None;
    }

    let read = |name: &str| {
        std::env::var(name)
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| panic!("[mgmt-e2e] {OPT_IN}=1 needs {name}."))
    };

    Some(Target {
        project_ref: read(PROJECT_REF),
        token: read(TOKEN),
    })
}

fn pack_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/supabase-pack")
}

/// This checkout's pack plus a last file that fails, so the install breaks
/// after every other file already ran inside the transaction.
fn failing_pack() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let migrations = dir.path().join("supabase/migrations");
    std::fs::create_dir_all(&migrations).unwrap();
    let mut names = read_pack_manifest(&pack_dir()).unwrap().pack;
    for name in &names {
        std::fs::copy(
            pack_dir().join("supabase/migrations").join(name),
            migrations.join(name),
        )
        .unwrap();
    }
    let failing = "9999_kizunasync_fails.sql".to_owned();
    std::fs::write(migrations.join(&failing), "select 1 / 0;\n").unwrap();
    names.push(failing);
    std::fs::write(
        dir.path().join("pack.manifest.json"),
        serde_json::json!({ "pack": names }).to_string(),
    )
    .unwrap();

    dir
}

fn init(target: &Target, project: &Path, pack: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_kizunasync"))
        .current_dir(project)
        .args([
            "init",
            "--project-ref",
            &target.project_ref,
            "--yes",
            "--allow-no-cron",
        ])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env(TOKEN, &target.token)
        .env("KSYNC_PACK_DIR", pack)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn has_kizunasync_schema(api: &dyn Applier) -> bool {
    let rows = api
        .run_query(
            "select exists (select 1 from pg_namespace where nspname = 'kizunasync') as present;",
        )
        .unwrap();

    require_bool(&rows[0], "present").unwrap()
}

#[test]
fn a_fresh_install_over_the_management_api_is_one_transaction() {
    let Some(target) = target() else { return };
    let api = ManagementApi::new(
        ReqwestTransport::new().unwrap(),
        &target.token,
        &ProjectRef::parse(&target.project_ref).unwrap(),
        None,
    );
    assert!(
        !has_kizunasync_schema(&api),
        "[mgmt-e2e] {} already carries a kizunasync schema: point {PROJECT_REF} at a disposable project with no Kizuna install.",
        target.project_ref
    );
    let project = tempfile::tempdir().unwrap();

    let failing = failing_pack();
    let broken = init(&target, project.path(), failing.path());

    assert_eq!(
        broken.status.code(),
        Some(1),
        "an install whose last file fails is a failure:\n{}",
        String::from_utf8_lossy(&broken.stderr)
    );
    assert!(
        String::from_utf8_lossy(&broken.stderr).contains("nothing was applied"),
        "{}",
        String::from_utf8_lossy(&broken.stderr)
    );
    assert!(
        !has_kizunasync_schema(&api),
        "the failed install left the pack behind: it did not run as one transaction"
    );

    let installed = init(&target, project.path(), &pack_dir());

    assert_eq!(
        installed.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&installed.stderr)
    );
    let recorded: Vec<String> = api
        .run_query(
            "select object_name from kizunasync._provisions where object_kind = 'pack-file' order by 1;",
        )
        .unwrap()
        .iter()
        .map(|row| require_string(row, "object_name").unwrap())
        .collect();
    let mut shipped = read_pack_manifest(&pack_dir()).unwrap().pack;
    shipped.sort();

    assert_eq!(recorded, shipped, "one ledger row per pack file");
}
