//! Config parsing and engine construction for the `UniFFI` surface.
//!
//! Extra JSON keys (`database_path`, `remote`) sit beside `EngineConfig` so the
//! exported `create(config_json)` signature stays unchanged (bindgen-stable).
//! Every fault a caller can fix by resending different JSON is
//! [`EngineError::Config`]; the store keeps its own typed error.

#[cfg(not(all(feature = "http", not(target_arch = "wasm32"))))]
use kizunasync_engine::ScriptedRemote;
use kizunasync_engine::bridge::{database_path, first_str, open_store_at, parse_config};
use kizunasync_engine::{EngineDeps, EngineError, ProtocolRemote, SyncEngine};
use kizunasync_protocol::Op;
use kizunasync_query::{QueryPlan, QueryResult};
use kizunasync_store::{LocalMutation, LocalStore};
use serde_json::{Map, Value, json};
use std::sync::Arc;

/// Error code for a mutation op outside the closed protocol set. Shared by the
/// typed `UniFFI` methods and the JSON mutation shape so an embedder classifies
/// one discriminant, never two; the engine's catalog owns the string.
pub(crate) use kizunasync_engine::error_catalog::UNKNOWN_OP;

pub(crate) fn unknown_op_message(op: &str) -> String {
    format!("unknown op \"{op}\" (known: insert, update, delete)")
}

/// Reads one mutation out of the JSON an embedder sent. Only `op` is closed:
/// an absent `table` or `pk` reads as an empty string and the engine refuses it
/// under its own rule.
///
/// # Errors
///
/// [`EngineError::Protocol`] under [`UNKNOWN_OP`] when `op` is absent or names
/// anything outside insert, update, and delete.
pub(crate) fn mutation_from_value(
    v: &Value,
) -> Result<LocalMutation, kizunasync_engine::EngineError> {
    let op = match v.get("op").and_then(Value::as_str) {
        Some("insert") => Op::Insert,
        Some("update") => Op::Update,
        Some("delete") => Op::Delete,
        Some(other) => {
            return Err(kizunasync_engine::EngineError::protocol(
                UNKNOWN_OP,
                unknown_op_message(other),
            ));
        }
        None => {
            return Err(kizunasync_engine::EngineError::protocol(
                UNKNOWN_OP,
                unknown_op_message("<missing>"),
            ));
        }
    };

    let columns: Map<String, Value> = v
        .get("columns")
        .and_then(|c| c.as_object())
        .cloned()
        .unwrap_or_default();
    Ok(LocalMutation {
        table: v.get("table").and_then(|t| t.as_str()).unwrap_or("").into(),
        pk: v.get("pk").and_then(|t| t.as_str()).unwrap_or("").into(),
        op,
        columns,
        transforms: v.get("transforms").and_then(|c| c.as_object()).cloned(),
        precondition: v.get("precondition").and_then(|c| c.as_object()).cloned(),
        batch_id: v
            .get("batch_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        hlc: v.get("hlc").and_then(Value::as_str).map(str::to_string),
        mutation_id: v
            .get("mutation_id")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Packaging-build refusal when create JSON omits `remote`. A plain
/// `cargo test` build without `http` uses `ScriptedRemote` instead.
#[cfg(any(test, all(feature = "http", not(target_arch = "wasm32"))))]
pub(crate) fn missing_remote_error() -> EngineError {
    EngineError::Config("remote is required (url and publishable_key)".into())
}

/// JSON keys for the public Supabase client key. Publishable names win when
/// both a publishable key and a legacy anon key are present.
#[cfg(all(feature = "http", not(target_arch = "wasm32")))]
const PUBLISHABLE_KEY_JSON: &[&str] = &["publishable_key", "publishableKey", "anon_key", "anonKey"];

fn open_store(v: &Value) -> Result<LocalStore, EngineError> {
    open_store_at(database_path(v)?)
}

fn build_remote(v: &Value) -> Result<Arc<dyn ProtocolRemote>, EngineError> {
    let Some(remote) = v.get("remote") else {
        // A packaging build (`http` on) refuses a missing remote. A plain
        // `cargo test` / JVM host build has no HTTP remote, so the offline
        // ScriptedRemote stands in.
        #[cfg(all(feature = "http", not(target_arch = "wasm32")))]
        {
            return Err(missing_remote_error());
        }
        #[cfg(not(all(feature = "http", not(target_arch = "wasm32"))))]
        {
            return Ok(Arc::new(ScriptedRemote::new()));
        }
    };

    if remote.is_null() || !remote.is_object() {
        return Err(EngineError::Config(
            "remote must be an object with url and publishable_key".into(),
        ));
    }

    #[cfg(not(all(feature = "http", not(target_arch = "wasm32"))))]
    {
        Err(EngineError::Config(
            "remote requires kizunasync-ffi built with the http feature (cargo:xcframework / cargo:aar)"
                .into(),
        ))
    }
    #[cfg(all(feature = "http", not(target_arch = "wasm32")))]
    {
        use kizunasync_remote_http::{HttpProtocolRemote, RemoteConfig};
        let base_url = first_str(remote, &["url"])
            .ok_or_else(|| EngineError::Config("remote.url is required".into()))?;
        let publishable_key = first_str(remote, PUBLISHABLE_KEY_JSON).ok_or_else(|| {
            EngineError::Config("remote.publishable_key is required (or anon_key)".into())
        })?;
        let mut config = RemoteConfig::new(base_url, publishable_key);
        if let Some(token) = first_str(remote, &["access_token", "accessToken"]) {
            config = config.with_access_token(token);
        }
        if let Some(schema) = first_str(remote, &["schema"]) {
            config = config.with_schema(schema);
        }
        if let Some(cols) = remote
            .get("local_only_columns")
            .or_else(|| remote.get("localOnlyColumns"))
        {
            let list = cols.as_array().ok_or_else(|| {
                EngineError::Config("remote.local_only_columns must be an array of strings".into())
            })?;
            let mut names = Vec::with_capacity(list.len());
            for col in list {
                let Some(name) = col.as_str() else {
                    return Err(EngineError::Config(
                        "remote.local_only_columns must be an array of strings".into(),
                    ));
                };
                names.push(name.to_string());
            }
            config = config.with_local_only_columns(names);
        }
        HttpProtocolRemote::new(config)
            .map(|remote| Arc::new(remote) as Arc<dyn ProtocolRemote>)
            .map_err(|e| EngineError::Config(format!("http remote: {e}")))
    }
}

fn attachment_root_of(v: &Value) -> Result<Option<String>, EngineError> {
    match v.get("attachment_root").or_else(|| v.get("attachmentRoot")) {
        None => Ok(None),
        Some(Value::String(path)) if !path.is_empty() => Ok(Some(path.clone())),
        Some(Value::String(_)) => Err(EngineError::Config(
            "attachment_root must be a non-empty path".into(),
        )),
        Some(_) => Err(EngineError::Config(
            "attachment_root must be a string".into(),
        )),
    }
}

#[cfg(all(feature = "http", not(target_arch = "wasm32")))]
fn attach_live_transfer(engine: SyncEngine, v: &Value) -> Result<SyncEngine, EngineError> {
    use kizunasync_remote_http::{TusConfig, TusTransfer};
    let Some(remote) = v.get("remote") else {
        return Ok(engine);
    };

    if !remote.is_object() {
        return Ok(engine);
    }

    let base_url = first_str(remote, &["url"])
        .ok_or_else(|| EngineError::Config("remote.url is required to attach transfer".into()))?;
    let publishable_key = first_str(remote, PUBLISHABLE_KEY_JSON).unwrap_or_default();
    let token = first_str(remote, &["access_token", "accessToken"]).unwrap_or_default();
    let mut config = TusConfig::new(base_url, token);
    if !publishable_key.is_empty() {
        config = config.with_publishable_key(publishable_key);
    }
    let transfer =
        TusTransfer::new(config).map_err(|e| EngineError::Config(format!("tus transfer: {e}")))?;
    Ok(engine.with_transfer(Arc::new(transfer)))
}

// One signature for both builds: the http twin is fallible, and a caller that
// had to know which one it linked would need a `cfg` of its own.
#[cfg(not(all(feature = "http", not(target_arch = "wasm32"))))]
#[expect(clippy::unnecessary_wraps)]
fn attach_live_transfer(engine: SyncEngine, _v: &Value) -> Result<SyncEngine, EngineError> {
    Ok(engine)
}

/// Read the create JSON the embedder sent. Every refusal a caller can fix by
/// resending different JSON is a configuration error.
pub(crate) fn config_value(config_json: &str) -> Result<Value, EngineError> {
    serde_json::from_str(config_json).map_err(|e| EngineError::Config(e.to_string()))
}

/// Builds the engine the config describes. `deps` carries the embedder's clock,
/// so the handle's `call` surface can pin `now` per request.
///
/// # Errors
///
/// [`EngineError::Config`] for anything the caller can fix by resending
/// different JSON, including a `remote` this build cannot construct and an
/// `attachment_root` the process cannot create, or [`EngineError::Store`] when
/// the database named by `database_path` cannot be opened.
pub(crate) fn build_engine(v: &Value, deps: EngineDeps) -> Result<SyncEngine, EngineError> {
    let store = open_store(v)?;
    let remote = build_remote(v)?;
    assemble_engine(v, store, remote, deps)
}

/// [`build_engine`] over a remote the caller supplies instead of the one the
/// config names, so a test can hold a pull or a push open.
///
/// # Errors
///
/// The same as [`build_engine`], minus every refusal of the `remote` object.
#[cfg(test)]
pub(crate) fn build_engine_over(
    v: &Value,
    remote: Arc<dyn ProtocolRemote>,
    deps: EngineDeps,
) -> Result<SyncEngine, EngineError> {
    let store = open_store(v)?;
    assemble_engine(v, store, remote, deps)
}

fn assemble_engine(
    v: &Value,
    store: LocalStore,
    remote: Arc<dyn ProtocolRemote>,
    deps: EngineDeps,
) -> Result<SyncEngine, EngineError> {
    let mut engine = SyncEngine::new(store, parse_config(v)?, remote, deps);

    if let Some(root) = attachment_root_of(v)? {
        let path = std::path::PathBuf::from(&root);
        std::fs::create_dir_all(&path)
            .map_err(|e| EngineError::Config(format!("create attachment_root \"{root}\": {e}")))?;
        engine = engine
            .with_attachment_root(path)
            .with_attachment_bytes(Arc::new(kizunasync_engine::FsAttachmentBytes));
        engine = attach_live_transfer(engine, v)?;
    }

    // A token named at create is the session's first token, so its subject records the owner, fills the owner buckets, and latches a changed identity like one set later.
    if let Some(token) = v
        .get("remote")
        .and_then(|remote| first_str(remote, &["access_token", "accessToken"]))
    {
        engine.set_remote_access_token(Some(token));
    }

    Ok(engine)
}

/// Applies one mutation the embedder sent as JSON.
///
/// # Errors
///
/// [`EngineError::Json`] for malformed JSON, [`EngineError::Protocol`] under
/// [`UNKNOWN_OP`] for an op outside the closed set, and whatever
/// [`SyncEngine::apply`] reports for the write itself.
pub(crate) fn apply_on(
    engine: &SyncEngine,
    mutation_json: &str,
) -> Result<(), kizunasync_engine::EngineError> {
    let v: Value = serde_json::from_str(mutation_json)?;
    engine.apply(mutation_from_value(&v)?)
}

/// Runs one local query the embedder sent as JSON and answers its rows as
/// JSON, one value for `One` and `Maybe`, an array for `Many`, and
/// `{"rows": …, "count": n}` for `Counted`.
///
/// # Errors
///
/// [`EngineError::Json`] for malformed JSON or a plan that will not decode,
/// [`EngineError::LocalConstraint`] when `table` is absent, and whatever
/// [`SyncEngine::query`] reports for the plan itself.
pub(crate) fn query_on(
    engine: &SyncEngine,
    req_json: &str,
) -> Result<Value, kizunasync_engine::EngineError> {
    let v: Value = serde_json::from_str(req_json)?;
    let table = v
        .get("table")
        .and_then(|t| t.as_str())
        .ok_or_else(|| kizunasync_engine::EngineError::LocalConstraint("table required".into()))?;
    let plan: QueryPlan =
        serde_json::from_value(v.get("plan").cloned().unwrap_or_else(|| json!({})))?;

    Ok(match engine.query(table, &plan)? {
        QueryResult::Many(rows) => json!(rows),
        QueryResult::One(row) => json!(row),
        QueryResult::Maybe(row) => json!(row),
        counted @ QueryResult::Counted { .. } => json!(counted),
    })
}

/// The current-thread runtime an engine thread drives its calls on.
///
/// A runtime that will not build is not something the caller can respell, so it
/// is an unavailable engine rather than a refused config.
///
/// # Errors
///
/// [`EngineError::EngineUnavailable`] when the runtime cannot be built.
pub(crate) fn new_runtime() -> Result<tokio::runtime::Runtime, EngineError> {
    kizunasync_engine::current_thread_runtime()
}
