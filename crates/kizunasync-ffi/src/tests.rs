use super::*;
#[cfg(not(feature = "http"))]
use actor::{DEADLINE, within};
#[cfg(not(feature = "http"))]
use delivery::Heard;

mod actor;
mod create_token;
mod delivery;

/// The faults this crate raises itself must carry a code the generated catalog
/// contains: `docs/reference/kotlin/types.md` promises every `KizunaSyncError` code
/// is the one that page's Errors table lists.
#[test]
fn crate_raised_faults_carry_a_catalog_code() {
    for error in [lock_err(), not_created(), crate::actor::stopped()] {
        let KizunaSyncFfiError::Engine { code, .. } = error;
        assert_eq!(code, ENGINE_UNAVAILABLE);
        assert!(
            kizunasync_engine::error_catalog::contains(&code),
            "{code} is outside the generated catalog"
        );
    }
}

/// The same code over the real `UniFFI` surface: a handle whose engine was
/// never created is the reachable half of the three.
#[test]
fn uniffi_call_before_create_reports_engine_unavailable() {
    let engine = KizunaSyncEngine::new();
    let error = engine
        .outbox_depth()
        .expect_err("a handle with no engine cannot answer");
    let KizunaSyncFfiError::Engine { code, .. } = error;
    assert_eq!(code, ENGINE_UNAVAILABLE);
}

/// A config the caller spelled wrong is caller input, not a dead handle, so
/// it must not arrive as `ENGINE_UNAVAILABLE`: a host that retries only on
/// that code would otherwise resend the same broken JSON forever.
#[test]
fn a_malformed_config_is_config_invalid_not_engine_unavailable() {
    let eng = KizunaSyncEngine::new();
    let error = eng
        .create("{ not json".into())
        .expect_err("a config that does not parse must fail");
    let KizunaSyncFfiError::Engine { code, .. } = error;
    assert_eq!(code, kizunasync_engine::error_catalog::CONFIG_INVALID);
}

#[test]
fn an_applied_insert_is_queryable_and_queued() {
    let eng = KizunaSyncEngine::new();
    eng.create(base_config().to_string()).expect("create");
    eng.apply(
        r#"{"table":"items","pk":"p-uniffi","op":"insert","mutation_id":"m-uniffi","columns":{"title":"Beta","user_id":"u1"}}"#
            .into(),
    )
    .expect("apply");
    let raw = eng
        .query(
            r#"{"table":"items","plan":{"filters":[{"kind":"eq","column":"title","value":"Beta"}],"cardinality":"many"}}"#
                .into(),
        )
        .expect("query");
    let rows: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(rows.as_array().expect("arr").len(), 1);
    assert_eq!(eng.outbox_depth().expect("depth"), 1);
}

const ITEMS: &str = r#"{"client_id":"u","schema_version":1,"tables":{"items":{"bucket_column":"user_id","bucket_params":{"user_id":"u1"}}}}"#;
const INSERT: &str = r#"{"table":"items","pk":"p-file","op":"insert","mutation_id":"m-file","columns":{"title":"Gamma","user_id":"u1"}}"#;
const QUERY: &str = r#"{"table":"items","plan":{"filters":[{"kind":"eq","column":"title","value":"Gamma"}],"cardinality":"many"}}"#;

/// The baseline create config every functional test builds from. `build_remote`
/// refuses a config without a `remote` key under the `http` feature, so this
/// carries a placeholder that satisfies the shape check without ever
/// resolving; without the feature the extra key is inert.
fn base_config() -> Value {
    let mut v: Value = serde_json::from_str(ITEMS).unwrap();
    if cfg!(feature = "http") {
        v.as_object_mut().unwrap().insert(
            "remote".into(),
            json!({"url": "https://127.0.0.1:1", "publishable_key": "pub-xxx"}),
        );
    }
    v
}

fn with_path(path: &str) -> String {
    let mut v = base_config();
    v.as_object_mut()
        .unwrap()
        .insert("database_path".into(), json!(path));
    v.to_string()
}

#[test]
fn file_backed_store_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("kizunasync.sqlite");
    let path = path.to_str().expect("utf8 path");

    let first = KizunaSyncEngine::new();
    first.create(with_path(path)).expect("create");
    first.apply(INSERT.into()).expect("apply");
    assert_eq!(first.outbox_depth().expect("depth"), 1);
    drop(first);

    let second = KizunaSyncEngine::new();
    second.create(with_path(path)).expect("reopen");
    let raw = second.query(QUERY.into()).expect("query");
    let rows: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(rows.as_array().expect("arr").len(), 1);
    assert_eq!(second.outbox_depth().expect("depth"), 1);
}

fn code_of(error: KizunaSyncFfiError) -> String {
    let KizunaSyncFfiError::Engine { code, .. } = error;
    code
}

/// A database the store cannot open keeps the STORE code, not the config
/// one: the host spelled the path it meant, and the disk refused it.
#[test]
fn missing_database_parent_is_typed_error() {
    let eng = KizunaSyncEngine::new();
    let err = eng
        .create(with_path("/no/such/kizunasync-parent/db.sqlite"))
        .expect_err("missing parent must fail");
    assert_eq!(code_of(err), kizunasync_engine::error_catalog::STORE);
}

#[test]
fn remote_without_url_is_typed_error() {
    let mut v: Value = serde_json::from_str(ITEMS).unwrap();
    v.as_object_mut()
        .unwrap()
        .insert("remote".into(), json!({"anon_key": "pub-xxx"}));
    let eng = KizunaSyncEngine::new();
    let err = eng
        .create(v.to_string())
        .expect_err("remote without url must fail");
    assert_eq!(
        code_of(err),
        kizunasync_engine::error_catalog::CONFIG_INVALID
    );
}

#[test]
fn remote_null_is_typed_error() {
    let mut v: Value = serde_json::from_str(ITEMS).unwrap();
    v.as_object_mut()
        .unwrap()
        .insert("remote".into(), Value::Null);
    let eng = KizunaSyncEngine::new();
    let err = eng
        .create(v.to_string())
        .expect_err("null remote must fail");
    assert_eq!(
        code_of(err),
        kizunasync_engine::error_catalog::CONFIG_INVALID
    );
}

#[test]
fn empty_database_path_is_typed_error() {
    let eng = KizunaSyncEngine::new();
    let err = eng
        .create(with_path(""))
        .expect_err("empty database_path must fail");
    assert_eq!(
        code_of(err),
        kizunasync_engine::error_catalog::CONFIG_INVALID
    );
}

#[test]
#[cfg(not(feature = "http"))]
fn remote_without_http_feature_is_typed_error() {
    let mut v: Value = serde_json::from_str(ITEMS).unwrap();
    v.as_object_mut().unwrap().insert(
        "remote".into(),
        json!({
            "url": "https://127.0.0.1:1",
            "publishable_key": "pub-xxx",
        }),
    );
    let eng = KizunaSyncEngine::new();
    let err = eng
        .create(v.to_string())
        .expect_err("http feature must be required");
    assert_eq!(
        code_of(err),
        kizunasync_engine::error_catalog::CONFIG_INVALID
    );
}

#[test]
#[cfg(feature = "http")]
fn live_remote_does_not_auto_apply_like_scripted() {
    let mut v: Value = serde_json::from_str(ITEMS).unwrap();
    v.as_object_mut().unwrap().insert(
        "remote".into(),
        json!({
            "url": "https://127.0.0.1:1",
            "publishable_key": "pub-xxx",
        }),
    );
    let eng = KizunaSyncEngine::new();
    eng.create(v.to_string()).expect("create http remote");
    eng.apply(INSERT.into()).expect("apply");
    assert!(
        eng.sync().is_err(),
        "HTTP remote must not silently succeed like ScriptedRemote"
    );
    assert!(
        eng.sync().is_err(),
        "a second sync must reuse the engine runtime, not panic"
    );
    assert_eq!(eng.outbox_depth().expect("depth"), 1);
}

#[test]
fn the_typed_surface_lands_a_transform_a_filtered_update_and_a_seeded_checkpoint() {
    let eng = KizunaSyncEngine::new();
    eng.create(base_config().to_string()).expect("create");
    eng.apply(
        r#"{"table":"items","pk":"p1","op":"insert","mutation_id":"m1","columns":{"title":"A","user_id":"u1","rank":1,"done":false}}"#
            .into(),
    )
    .expect("insert");
    eng.apply(
        r#"{"table":"items","pk":"p1","op":"update","mutation_id":"m2","columns":{},"transforms":{"rank":{"op":"increment","by":2}}}"#
            .into(),
    )
    .expect("increment");
    let pks = eng
        .apply_where(
            "items".into(),
            "update".into(),
            r#"[{"kind":"eq","column":"done","value":false}]"#.into(),
            r#"{"title":"B"}"#.into(),
            String::new(),
            String::new(),
        )
        .expect("apply_where");
    assert_eq!(pks, vec!["p1"]);
    let raw = eng
        .query(
            r#"{"table":"items","plan":{"filters":[{"kind":"eq","column":"title","value":"B"}],"cardinality":"single"}}"#
                .into(),
        )
        .expect("query");
    let row: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(row["title"], "B");
    assert_eq!(row["rank"], 3);
    assert!(eng.rejections(false).expect("rejections").is_empty());
    let checkpoint = eng.checkpoint().expect("checkpoint");
    assert!(!checkpoint.soft_blocked);
    eng.set_bucket(r#"{"user_id":"u2"}"#.into())
        .expect("bucket");
    eng.set_access_token(Some("jwt".into())).expect("token");
    eng.seed_checkpoint("c1".into()).expect("seed");
    assert_eq!(eng.checkpoint().expect("cp").cursor, "c1");
}

/// The owner and primary key of the row the attachment tests import a file
/// for: the engine refuses an attachment reference whose owner or primary key
/// is not a uuid.
#[cfg(not(feature = "http"))]
const PHOTO_OWNER: &str = "00000000-0000-4000-8000-0000000000a1";
#[cfg(not(feature = "http"))]
const PHOTO_PK: &str = "00000000-0000-4000-8000-0000000000b1";

#[cfg(not(feature = "http"))]
fn photo_row() -> String {
    json!({
        "table": "items",
        "pk": PHOTO_PK,
        "op": "insert",
        "mutation_id": "m1",
        "columns": {"title": "pic", "user_id": PHOTO_OWNER},
    })
    .to_string()
}

// Needs the scripted remote: the HTTP remote cannot sync offline.
#[test]
#[cfg(not(feature = "http"))]
fn from_file_without_remote_enqueues_and_applies_ref() {
    let dir = tempfile::tempdir().unwrap();
    let sandbox = dir.path().join("sandbox");
    let source = dir.path().join("photo.bin");
    std::fs::write(&source, b"hello-bytes").unwrap();
    let mut cfg: Value = base_config();
    let tables = cfg["tables"]["items"].as_object_mut().unwrap();
    tables.insert(
        "attachments".into(),
        json!({"image": {"storage_bucket": "media", "owner_column": "user_id"}}),
    );
    cfg.as_object_mut()
        .unwrap()
        .insert("attachment_root".into(), json!(sandbox.to_str().unwrap()));
    let eng = KizunaSyncEngine::new();
    eng.create(cfg.to_string()).expect("create");
    eng.apply(photo_row()).expect("insert");
    let imported = eng
        .from_file(
            "items".into(),
            "image".into(),
            PHOTO_PK.into(),
            source.to_str().unwrap().into(),
            Some("image/png".into()),
        )
        .expect("from_file");
    assert!(
        imported
            .reference
            .starts_with(&format!("{PHOTO_OWNER}/{PHOTO_PK}/"))
    );
    let status = eng
        .get_status(imported.reference.clone())
        .expect("status")
        .expect("queued");
    assert_eq!(status.state, "queued");
    eng.sync().expect("offline sync without HTTP");
    let raw = eng
        .query(r#"{"table":"items","plan":{"cardinality":"many"}}"#.into())
        .expect("query");
    let rows: Value = serde_json::from_str(&raw).expect("json");
    let row = rows.as_array().expect("arr")[0].clone();
    assert_eq!(row["image"], imported.reference);
    let resolved = eng
        .resolve_download(imported.reference.clone())
        .expect("resolve");
    assert_eq!(resolved.as_deref(), Some(imported.local_path.as_str()));
}

#[test]
fn a_library_build_refuses_a_missing_remote() {
    let error = crate::create::missing_remote_error();
    assert!(
        matches!(error, kizunasync_engine::EngineError::Config(_)),
        "{error}"
    );
}

#[test]
fn missing_apply_op_is_typed_error() {
    let eng = KizunaSyncEngine::new();
    eng.create(base_config().to_string()).expect("create");
    let err = eng
        .apply(r#"{"table":"items","pk":"p1","mutation_id":"m1","columns":{"title":"A","user_id":"u1"}}"#.into())
        .expect_err("an omitted op must fail loud");
    match err {
        KizunaSyncFfiError::Engine { code, msg } => {
            assert_eq!(code, "UNKNOWN_OP");
            assert!(msg.contains("<missing>"), "{msg}");
        }
    }
    assert_eq!(eng.outbox_depth().expect("depth"), 0);
}

#[test]
fn unknown_apply_op_is_typed_error() {
    let eng = KizunaSyncEngine::new();
    eng.create(base_config().to_string()).expect("create");
    let err = eng
        .apply(
            r#"{"table":"items","pk":"p1","op":"upsert","mutation_id":"m1","columns":{"title":"A","user_id":"u1"}}"#
                .into(),
        )
        .expect_err("an unknown op must fail loud");
    match err {
        KizunaSyncFfiError::Engine { code, msg } => {
            assert_eq!(code, "UNKNOWN_OP");
            assert!(msg.contains("upsert"), "{msg}");
        }
    }
    assert_eq!(eng.outbox_depth().expect("depth"), 0);
}

#[test]
fn unknown_apply_where_op_is_typed_error() {
    let eng = KizunaSyncEngine::new();
    eng.create(base_config().to_string()).expect("create");
    let err = eng
        .apply_where(
            "items".into(),
            "Update".into(),
            r#"[{"kind":"eq","column":"done","value":false}]"#.into(),
            r#"{"title":"B"}"#.into(),
            String::new(),
            String::new(),
        )
        .expect_err("op matching is case-sensitive");
    match err {
        KizunaSyncFfiError::Engine { code, msg } => {
            assert_eq!(code, "UNKNOWN_OP");
            assert!(msg.contains("Update"), "{msg}");
        }
    }
}

#[test]
fn missing_client_id_is_typed_error() {
    let mut cfg: Value = base_config();
    cfg.as_object_mut().unwrap().remove("client_id");
    let eng = KizunaSyncEngine::new();
    let err = eng
        .create(cfg.to_string())
        .expect_err("client_id must be required");
    // Every refused config carries CONFIG_INVALID, so the message is what tells
    // one missing key from another: it is matched whole.
    match err {
        KizunaSyncFfiError::Engine { code, msg } => {
            assert_eq!(code, kizunasync_engine::error_catalog::CONFIG_INVALID);
            assert_eq!(msg, "config: client_id is required");
        }
    }
}

#[test]
fn attachment_spec_without_owner_column_is_typed_error() {
    let mut cfg: Value = base_config();
    cfg["tables"]["items"].as_object_mut().unwrap().insert(
        "attachments".into(),
        json!({"image": {"storage_bucket": "media"}}),
    );
    let eng = KizunaSyncEngine::new();
    let err = eng
        .create(cfg.to_string())
        .expect_err("a half-declared attachment must fail");
    // Every refused config carries CONFIG_INVALID, so the message is what names
    // the half-declared spec: it is matched whole.
    match err {
        KizunaSyncFfiError::Engine { code, msg } => {
            assert_eq!(code, kizunasync_engine::error_catalog::CONFIG_INVALID);
            assert_eq!(
                msg,
                "config: tables.items.attachments.image.owner_column is required"
            );
        }
    }
}

const PINNED_NOW: &str = "2021-05-05T05:05:05.000Z";
const PINNED_NOW_MS: i64 = 1_620_191_105_000;

fn queued_entries(engine: &KizunaSyncEngine) -> Vec<Value> {
    let raw = engine
        .call("inspect".into(), "{}".into())
        .expect("inspect call");
    let envelope: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(envelope["ok"], json!(true), "{envelope}");
    envelope["value"]["queued"]
        .as_array()
        .expect("queued rows")
        .clone()
}

#[test]
fn call_pins_the_embedder_clock() {
    let eng = KizunaSyncEngine::new();
    eng.create(base_config().to_string()).expect("create");
    let raw = eng
        .call(
            "apply".into(),
            json!({
                "table": "items",
                "pk": "p-clock",
                "op": "insert",
                "mutation_id": "m-clock",
                "columns": {"title": "Pinned", "user_id": "u1"},
                "now": PINNED_NOW,
                "now_ms": PINNED_NOW_MS,
            })
            .to_string(),
        )
        .expect("apply call");
    let envelope: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(envelope["ok"], json!(true), "{envelope}");
    let queued = queued_entries(&eng);
    assert_eq!(queued[0]["created_at"], json!(PINNED_NOW));
}

/// `apply_where` carries no explicit `now`, so its stamp can only come from
/// the deps the envelope pinned, the proof that `create` wired the clock in.
#[test]
fn pinned_clock_stamps_a_request_without_an_explicit_now() {
    let eng = KizunaSyncEngine::new();
    eng.create(base_config().to_string()).expect("create");
    eng.apply(
        r#"{"table":"items","pk":"p-clock","op":"insert","mutation_id":"m-seed","columns":{"title":"Seed","user_id":"u1","done":false}}"#
            .into(),
    )
    .expect("seed insert");
    let raw = eng
        .call(
            "apply_where".into(),
            json!({
                "table": "items",
                "op": "update",
                "filters": [{"kind": "eq", "column": "done", "value": false}],
                "columns": {"title": "Pinned"},
                "now": PINNED_NOW,
                "now_ms": PINNED_NOW_MS,
            })
            .to_string(),
        )
        .expect("apply_where call");
    let envelope: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(envelope["value"], json!(["p-clock"]), "{envelope}");
    let queued = queued_entries(&eng);
    assert_eq!(queued.len(), 2);
    assert_eq!(queued[1]["created_at"], json!(PINNED_NOW));
}

/// The clock a request carried reaches what the apply wrote: the row is in
/// the store and its outbox entry carries the pinned stamp, not the system
/// clock's. Read through the typed `inspect()`, which is also the proof that
/// it returns the bare snapshot rather than the envelope.
#[test]
fn a_pinned_now_reaches_the_row_the_apply_wrote() {
    let eng = KizunaSyncEngine::new();
    eng.create(base_config().to_string()).expect("create");
    eng.call(
        "apply".into(),
        json!({
            "table": "items",
            "pk": "p-clock",
            "op": "insert",
            "mutation_id": "m-clock",
            "columns": {"title": "Pinned", "user_id": "u1"},
            "now": PINNED_NOW,
            "now_ms": PINNED_NOW_MS,
        })
        .to_string(),
    )
    .expect("apply call");

    let snapshot: Value = serde_json::from_str(&eng.inspect().expect("inspect")).expect("json");
    assert_eq!(snapshot["depth"], json!(1), "{snapshot}");
    assert_eq!(snapshot["queued"][0]["pk"], json!("p-clock"));
    assert_eq!(snapshot["queued"][0]["created_at"], json!(PINNED_NOW));

    let raw = eng
        .query(
            r#"{"table":"items","plan":{"filters":[{"kind":"eq","column":"title","value":"Pinned"}],"cardinality":"single"}}"#
                .into(),
        )
        .expect("query");
    let row: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(row["title"], "Pinned");
}

#[test]
fn the_pinned_clock_does_not_leak_into_typed_methods() {
    let eng = KizunaSyncEngine::new();
    eng.create(base_config().to_string()).expect("create");
    eng.call(
        "apply".into(),
        json!({
            "table": "items",
            "pk": "p-pinned",
            "op": "insert",
            "mutation_id": "m-pinned",
            "columns": {"title": "Pinned", "user_id": "u1"},
            "now": PINNED_NOW,
            "now_ms": PINNED_NOW_MS,
        })
        .to_string(),
    )
    .expect("apply call");
    eng.apply(
        r#"{"table":"items","pk":"p-typed","op":"insert","mutation_id":"m-typed","columns":{"title":"Typed","user_id":"u1"}}"#
            .into(),
    )
    .expect("typed apply");
    let queued = queued_entries(&eng);
    assert_eq!(queued[0]["created_at"], json!(PINNED_NOW));
    assert_ne!(
        queued[1]["created_at"],
        json!(PINNED_NOW),
        "a typed apply after a pinned call must stamp with the system clock"
    );
}

// Needs the scripted remote: the HTTP remote cannot sync offline.
#[test]
#[cfg(not(feature = "http"))]
fn two_watchers_on_one_reference_are_notified_once_each_per_sync() {
    let dir = tempfile::tempdir().unwrap();
    let sandbox = dir.path().join("sandbox");
    let source = dir.path().join("photo.bin");
    std::fs::write(&source, b"hello-bytes").unwrap();
    let mut cfg: Value = base_config();
    cfg["tables"]["items"].as_object_mut().unwrap().insert(
        "attachments".into(),
        json!({"image": {"storage_bucket": "media", "owner_column": "user_id"}}),
    );
    cfg.as_object_mut()
        .unwrap()
        .insert("attachment_root".into(), json!(sandbox.to_str().unwrap()));
    let eng = KizunaSyncEngine::new();
    eng.create(cfg.to_string()).expect("create");
    eng.apply(photo_row()).expect("insert");
    let imported = eng
        .from_file(
            "items".into(),
            "image".into(),
            PHOTO_PK.into(),
            source.to_str().unwrap().into(),
            Some("image/png".into()),
        )
        .expect("from_file");
    let first: Arc<Heard<String>> = Heard::new();
    let second: Arc<Heard<String>> = Heard::new();
    eng.watch(imported.reference.clone(), first.clone())
        .expect("watch first");
    assert_eq!(
        first.wait_for(1).len(),
        1,
        "registration hands over the current status"
    );
    eng.watch(imported.reference.clone(), second.clone())
        .expect("watch second");
    second.wait_for(1);
    assert_eq!(
        first.snapshot().len(),
        1,
        "a second registration must not re-fire an existing listener"
    );
    eng.sync().expect("offline sync without HTTP");
    first.wait_for(2);
    second.wait_for(2);
    assert_eq!(first.snapshot().len(), 2);
    assert_eq!(second.snapshot().len(), 2);
}

/// A listener that calls back into the handle from its delivery: the handle
/// must be free by then, or this reentrant read would deadlock.
#[cfg(not(feature = "http"))]
struct ReentrantWatcher {
    engine: Arc<KizunaSyncEngine>,
    reference: String,
    observed: Arc<Heard<(String, String)>>,
}

#[cfg(not(feature = "http"))]
impl AttachmentListener for ReentrantWatcher {
    fn on_status(&self, status: FfiAttachmentStatus) {
        let echoed = self
            .engine
            .get_status(self.reference.clone())
            .expect("reentrant get_status")
            .map_or_else(|| "missing".to_string(), |current| current.state);
        self.observed.push((status.state, echoed));
    }
}

// Needs the scripted remote: the HTTP remote cannot sync offline.
#[test]
#[cfg(not(feature = "http"))]
fn attachment_listener_may_call_back_into_the_engine() {
    let dir = tempfile::tempdir().unwrap();
    let sandbox = dir.path().join("sandbox");
    let source = dir.path().join("photo.bin");
    std::fs::write(&source, b"hello-bytes").unwrap();
    let mut cfg: Value = base_config();
    cfg["tables"]["items"].as_object_mut().unwrap().insert(
        "attachments".into(),
        json!({"image": {"storage_bucket": "media", "owner_column": "user_id"}}),
    );
    cfg.as_object_mut()
        .unwrap()
        .insert("attachment_root".into(), json!(sandbox.to_str().unwrap()));
    let eng = Arc::new(KizunaSyncEngine::new());
    eng.create(cfg.to_string()).expect("create");
    eng.apply(photo_row()).expect("insert");
    let imported = eng
        .from_file(
            "items".into(),
            "image".into(),
            PHOTO_PK.into(),
            source.to_str().unwrap().into(),
            Some("image/png".into()),
        )
        .expect("from_file");
    let observed = Heard::new();
    let listener: Arc<dyn AttachmentListener> = Arc::new(ReentrantWatcher {
        engine: Arc::clone(&eng),
        reference: imported.reference.clone(),
        observed: Arc::clone(&observed),
    });
    let reference = imported.reference.clone();
    let notifier = Arc::clone(&eng);
    // Off the test thread with a deadline: a callback run while the handle is
    // held hangs instead of failing, and a hung assertion reports nothing.
    within(DEADLINE, move || {
        let id = notifier.watch(reference, listener).expect("watch");
        notifier.sync().expect("offline sync without HTTP");
        notifier.unwatch(id).expect("unwatch");
    })
    .expect("watch()/sync() never returned: a listener ran while the handle was held");

    let observed = observed.wait_for(2);
    assert_eq!(observed.len(), 2, "watch and sync each notify once");
    let (delivered, echoed) = &observed[1];
    assert_eq!(
        delivered, echoed,
        "the read after the last round saw the status that round delivered"
    );
    eng.shutdown().expect("shutdown");
}

#[test]
fn from_file_without_attachment_root_is_ports_missing() {
    let mut cfg: Value = base_config();
    cfg["tables"]["items"].as_object_mut().unwrap().insert(
        "attachments".into(),
        json!({"image": {"storage_bucket": "media", "owner_column": "user_id"}}),
    );
    let eng = KizunaSyncEngine::new();
    eng.create(cfg.to_string()).expect("create without root");
    eng.apply(
        r#"{"table":"items","pk":"p1","op":"insert","mutation_id":"m1","columns":{"title":"pic","user_id":"u1"}}"#
            .into(),
    )
    .expect("insert");
    let err = eng
        .from_file(
            "items".into(),
            "image".into(),
            "p1".into(),
            "/tmp/missing.bin".into(),
            None,
        )
        .expect_err("root required");
    match err {
        KizunaSyncFfiError::Engine { code, .. } => assert_eq!(code, "ATTACHMENT_PORTS_MISSING"),
    }
}

/// `KizunaSyncEngine` is `Send + Sync`: every handle method hands its work to
/// the engine thread and waits for the answer, so multiple Swift or Kotlin
/// threads may hold and call through the same handle concurrently.
#[test]
fn the_engine_handle_is_send_and_sync() {
    fn assert<T: Send + Sync>() {}
    assert::<KizunaSyncEngine>();
}
