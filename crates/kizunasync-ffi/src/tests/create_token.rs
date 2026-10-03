//! A token named in the create config is the session's first token: its
//! subject records the store's owner, fills the owner buckets, and latches
//! `identity_changed` over a store another user owns, as a later
//! `set_access_token` does.

use super::delivery::{USER_A, USER_B, token_for};
use crate::KizunaSyncEngine;
use kizunasync_engine::{ProtocolRemote, ScriptedRemote};
use serde_json::{Value, json};
use std::sync::Arc;

/// A `todos` table whose bucket belongs to the store's owner, created with
/// the session of `user`, over `database_path` when one is given.
fn owner_config(user: &str, database_path: Option<&str>) -> String {
    let mut config = json!({
        "client_id": "c1",
        "schema_version": 1,
        "tables": { "todos": { "bucket_column": "owner_id", "bucket_owner": true } },
        "remote": { "access_token": token_for(user) },
    });
    if let Some(path) = database_path {
        config["database_path"] = json!(path);
    }
    config.to_string()
}

fn created_over(config: &str, remote: &Arc<ScriptedRemote>) -> KizunaSyncEngine {
    let engine = KizunaSyncEngine::new();
    engine
        .create_over(config, Arc::clone(remote) as Arc<dyn ProtocolRemote>)
        .expect("create");
    engine
}

#[test]
fn a_token_named_at_create_records_the_owner_and_fills_the_owner_bucket() {
    let remote = Arc::new(ScriptedRemote::new());
    let engine = created_over(&owner_config(USER_A, None), &remote);

    engine
        .apply(
            json!({
                "table": "todos",
                "pk": "r1",
                "op": "insert",
                "mutation_id": "m1",
                "columns": { "title": "buy milk" },
            })
            .to_string(),
        )
        .expect("apply");
    engine.pull_once().expect("the owner bucket is filled");

    let rows: Value = serde_json::from_str(
        &engine
            .query_table("todos".into(), String::new())
            .expect("query"),
    )
    .expect("json");
    assert_eq!(rows[0]["owner_id"], json!("user-a"));
    let pulled = remote
        .last_pull
        .lock()
        .unwrap()
        .clone()
        .expect("a pull request was recorded");
    assert_eq!(pulled.buckets[0].params["owner_id"], json!("user-a"));

    engine
        .set_access_token(Some(token_for(USER_B)))
        .expect("another token");
    assert_eq!(
        engine
            .checkpoint()
            .expect("checkpoint")
            .soft_block_reason
            .as_deref(),
        Some("identity_changed"),
        "the create-time token recorded user a as the owner"
    );
}

#[test]
fn a_token_of_another_user_at_create_latches_identity_changed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owner.sqlite");
    let path = path.to_str().unwrap();
    let remote = Arc::new(ScriptedRemote::new());
    let owned = created_over(&owner_config(USER_A, Some(path)), &remote);
    owned.shutdown().expect("shutdown");

    let engine = created_over(&owner_config(USER_B, Some(path)), &remote);

    let checkpoint = engine.checkpoint().expect("checkpoint");
    assert!(checkpoint.soft_blocked);
    assert_eq!(
        checkpoint.soft_block_reason.as_deref(),
        Some("identity_changed")
    );
}
