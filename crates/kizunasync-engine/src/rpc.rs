//! The one JSON request/response surface shared by the NAPI, wasm, and `UniFFI`
//! bridges.
//!
//! Every app client operation crosses the FFI as `(method, paramsJson)` and comes
//! back as an envelope, so a binding stays thin type mapping
//! (@../../../CONVENTIONS.md, "FFI and multi-language surfaces") and every bridge
//! has exactly one call shape to test. Errors ride the envelope as data, not
//! thrown strings: the adapter re-raises each catalog code as the typed error
//! that code names, so one engine's failure surface stays identical on every
//! bridge. The envelope's `retryable` is the catalog flag for the fault's code
//! ([`crate::error_catalog::catalog_retryable`]), the same flag the generated
//! `ENGINE_ERROR_RETRYABLE` table carries, so an app reads one answer whichever
//! surface it holds. [`crate::EngineError::is_budget_exempt`] answers a
//! different question, the engine's own dead-letter classification, and never
//! rides the envelope.

#![expect(
    clippy::needless_pass_by_value,
    reason = "the dispatch table hands each method its own owned request struct: deserialization allocates one per call and the method consumes it"
)]

use crate::clock;
use crate::engine::{ApplyWhere, SyncEngine, WriteCardinality};
use crate::error::EngineError;
use crate::error_catalog as catalog;
use kizunasync_protocol::{ColumnValues, Op};
use kizunasync_query::{Filter, QueryPlan};
use kizunasync_store::{AttachmentEntry, AttachmentState, LocalMutation, StoreError};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use thiserror::Error;

/// The engine never returns more queued writes than one push can carry.
const OUTBOX_PAGE: usize = 500;

/// Everything one dispatched call can fail with.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum RpcError {
    /// The engine refused the call.
    #[error(transparent)]
    Engine(#[from] EngineError),
    /// The method name is outside the dispatch table.
    #[error("unknown engine method \"{0}\"")]
    UnknownMethod(String),
}

// MARK: - Request shapes

#[derive(Deserialize)]
struct ApplyRequest {
    #[serde(flatten)]
    mutation: LocalMutation,
    /// The embedder's clock, injected so a pinned test clock reaches the store.
    #[serde(default)]
    now: Option<String>,
}

#[derive(Deserialize)]
struct ApplyWhereRequest {
    table: String,
    op: Op,
    #[serde(default)]
    filters: Vec<Filter>,
    #[serde(default)]
    columns: ColumnValues,
    #[serde(default)]
    transforms: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    precondition: Option<ColumnValues>,
    /// Whether soft-deleted rows may be targeted. Same key and same default as
    /// `QueryPlan`, so one builder call covers the read and the write.
    #[serde(default, rename = "includeDeleted")]
    include_deleted: bool,
    /// The most rows the write may reach; past it nothing is written.
    #[serde(default, rename = "maxAffected")]
    max_affected: Option<u32>,
    /// Answer the rows the write reached instead of their keys.
    #[serde(default)]
    returning: bool,
    /// The one-row terminal the returning write ends in, if any.
    #[serde(default)]
    cardinality: Option<WriteCardinality>,
}

#[derive(Deserialize)]
struct RowRequest {
    table: String,
    pk: String,
}

#[derive(Deserialize)]
struct QueryRequest {
    table: String,
    #[serde(default)]
    plan: QueryPlan,
}

#[derive(Deserialize)]
struct CursorRequest {
    cursor: String,
}

#[derive(Deserialize)]
struct RejectionsRequest {
    #[serde(default)]
    include_dismissed: bool,
}

#[derive(Deserialize)]
struct MutationIdRequest {
    mutation_id: String,
}

#[derive(Deserialize)]
struct OverwritesRequest {
    #[serde(default)]
    include_dismissed: bool,
}

/// One journal row of `_kizunasync_overwrites`, by its own autoincrement id: the
/// winner of a column resolution is a peer's write, so there is no mutation of
/// ours to key the acknowledgement on.
#[derive(Deserialize)]
struct OverwriteIdRequest {
    id: i64,
}

#[derive(Deserialize)]
struct BucketRequest {
    #[serde(default)]
    params: ColumnValues,
}

#[derive(Deserialize)]
struct AccessTokenRequest {
    token: Option<String>,
}

#[derive(Deserialize)]
struct ReferenceRequest {
    reference: String,
}

/// One durable queue row as the embedder's queue enqueues it: the locator plus
/// whatever integrity metadata it already has (a lazy download has none until the
/// bytes land). The transfer bookkeeping is NOT part of the request: the store
/// resets it, because a re-enqueue is a fresh job.
#[derive(Deserialize)]
struct AttachmentPutRequest {
    reference: String,
    upload_id: String,
    table: String,
    pk: String,
    column: String,
    bucket: String,
    owner: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    size: Option<i64>,
    #[serde(default)]
    local_path: Option<String>,
    direction: String,
    state: AttachmentState,
    created_at: String,
}

#[derive(Deserialize)]
struct AttachmentDirectionRequest {
    direction: String,
}

#[derive(Deserialize)]
struct AttachmentClaimRequest {
    reference: String,
    state: AttachmentState,
}

#[derive(Deserialize)]
struct AttachmentCountRequest {
    local_path: String,
    #[serde(default)]
    excluding_reference: Option<String>,
}

#[derive(Deserialize)]
struct AttachmentPatchRequest {
    reference: String,
    #[serde(default)]
    patch: ColumnValues,
}

// MARK: - Dispatch

/// Run one method and encode its outcome. Infallible by construction: a fault is
/// an `ok:false` envelope, never a rejected promise, so the adapter's mapping is
/// the single place a Rust error becomes a `TypeScript` one.
///
/// The clock `params` carries (`now` / `now_ms`) is pinned for every poll of
/// this call and for no other call ([`crate::clock`]), so two calls in flight
/// on one engine each stamp their own time. A local method answers while a
/// network method of the same engine awaits the remote ([`SyncEngine::sync`]).
pub async fn dispatch(engine: &SyncEngine, method: &str, params: &str) -> String {
    match clock::pin_for_dispatch(params, run(engine, method, params)).await {
        Ok(value) => encode(&json!({ "ok": true, "value": value })),
        Err(error) => failure_envelope(&describe(&error)),
    }
}

/// The one encoder every bridge uses for a failed call: the full
/// `{"ok":false,"error":<engine error>}` envelope for one engine error, byte for
/// byte what [`dispatch`] answers its own failures with.
///
/// The `napi`, `ffi`, and `wasm` bridges call it to report a failure from before
/// an engine exists (a refused create-time config, or a call against a handle
/// whose engine was never created), a case [`dispatch`] itself never runs because
/// there is no [`SyncEngine`] to hand it.
#[must_use]
pub fn error_envelope(error: &EngineError) -> String {
    failure_envelope(&describe_engine(error))
}

fn encode(value: &Value) -> String {
    // A `Value` built by this module always encodes; the fallback keeps the
    // envelope contract (never a rejected promise) if that ever stops holding.
    serde_json::to_string(value).unwrap_or_else(|_| {
        r#"{"ok":false,"error":{"kind":"internal","message":"engine response is not encodable"}}"#
            .to_string()
    })
}

fn failure_envelope(description: &Value) -> String {
    encode(&json!({ "ok": false, "error": description }))
}

/// The machine-readable half of a failure. `kind` is what the adapter switches on
/// to rebuild a typed `TEngineError`; free text is never classified.
fn describe(error: &RpcError) -> Value {
    match error {
        RpcError::UnknownMethod(method) => json!({
            "kind": "unknown_method",
            "message": format!("unknown engine method \"{method}\""),
            "retryable": false,
        }),
        RpcError::Engine(engine) => describe_engine(engine),
    }
}

fn describe_engine(engine: &EngineError) -> Value {
    let description = Description::new(
        engine.to_string(),
        catalog::catalog_retryable(&engine.code()),
    );
    let described = match engine {
        EngineError::Protocol { code, .. } => description.kind("protocol").code(code),
        EngineError::Remote { code, .. } => {
            let remote = description.kind("remote");
            // A code-less remote fault carries no `code` key at all: that field
            // holds the adapter's transport vocabulary, which has nothing to say
            // here, and an invented value would name a code no adapter sent.
            if let Some(code) = code {
                remote.code(code)
            } else {
                remote
            }
        }
        EngineError::Store(StoreError::Constraint(_)) | EngineError::LocalConstraint(_) => {
            description
                .kind("constraint")
                .code(catalog::LOCAL_CONSTRAINT)
        }
        // A store the page could not take, told apart from one it can never have:
        // the holder of an OPFS pool releases it, so a busy store is worth
        // retrying, while a browser with no persistent VFS at all is not.
        EngineError::Store(StoreError::VfsBusy { name }) => description
            .kind("store_busy")
            .code(catalog::STORE_BUSY)
            .name(name),
        EngineError::Store(StoreError::VfsUnavailable { .. }) => description
            .kind("store_unavailable")
            .code(catalog::STORE_UNAVAILABLE),
        EngineError::UnknownTable(table) => description
            .kind("unknown_table")
            .code(catalog::UNKNOWN_TABLE)
            .table(table),
        EngineError::SoftDeleteViolation { table } => description
            .kind("soft_delete_violation")
            .code(catalog::SOFT_DELETE_VIOLATION)
            .table(table),
        EngineError::BucketUnset | EngineError::BucketColumnUnknown { .. } => {
            description.kind("bucket_unset").code(catalog::BUCKET_UNSET)
        }
        EngineError::EngineUnavailable { .. } => description
            .kind("engine_unavailable")
            .code(catalog::ENGINE_UNAVAILABLE),
        // A configuration the engine refuses is its own kind: it is answered
        // before any call could run, and no retry of the same call changes it.
        EngineError::Config(_) => description.kind("config").code(catalog::CONFIG_INVALID),
        // A local read or a filter-targeted write the local subset refuses. One
        // fault class, one kind, on every entry point; the code tells the two
        // conditions apart: a cardinality miss is `LOCAL_CONSTRAINT`, an
        // unsupported construct `LOCAL_UNSUPPORTED`.
        EngineError::Query(_) => description.kind("query").code(&engine.code()),
        EngineError::Store(_)
        | EngineError::Transfer(_)
        | EngineError::Json(_)
        | EngineError::AttachmentPortsMissing
        | EngineError::AttachmentRowGone(_)
        | EngineError::AttachmentOwnerMissing(_)
        | EngineError::AttachmentUnverified(_)
        | EngineError::AttachmentHashMismatch(_)
        | EngineError::AttachmentNotYetAvailable(_)
        | EngineError::AttachmentUploadExpired(_)
        | EngineError::AttachmentTransferTimeout(_) => {
            description.kind("internal").code(&engine.code())
        }
    };
    described.into()
}

/// One engine failure's description as [`describe_engine`] assembles it: the
/// `message` and `retryable` every kind carries, then the `kind` and whichever
/// of `code`, `table`, and `name` that kind names.
struct Description(serde_json::Map<String, Value>);

impl Description {
    fn new(message: String, retryable: bool) -> Self {
        let mut fields = serde_json::Map::new();
        fields.insert("message".into(), Value::String(message));
        fields.insert("retryable".into(), Value::Bool(retryable));
        Self(fields)
    }

    fn kind(self, kind: &str) -> Self {
        self.with("kind", kind)
    }

    fn code(self, code: &str) -> Self {
        self.with("code", code)
    }

    fn table(self, table: &str) -> Self {
        self.with("table", table)
    }

    fn name(self, name: &str) -> Self {
        self.with("name", name)
    }

    fn with(mut self, key: &str, value: &str) -> Self {
        self.0.insert(key.into(), Value::from(value));
        self
    }
}

impl From<Description> for Value {
    fn from(description: Description) -> Self {
        Self::Object(description.0)
    }
}

fn parse<T: DeserializeOwned>(params: &str) -> Result<T, RpcError> {
    Ok(serde_json::from_str(params).map_err(EngineError::from)?)
}

async fn run(engine: &SyncEngine, method: &str, params: &str) -> Result<Value, RpcError> {
    match method {
        "ping" => Ok(json!("pong")),
        "apply" => apply(engine, parse(params)?),
        "apply_where" => apply_where(engine, parse(params)?),
        "query" => query(engine, parse(params)?),
        "read" => read(engine, parse(params)?),
        "has_tombstone" => has_tombstone(engine, parse(params)?),
        "outbox_depth" => Ok(json!(engine.get_outbox_depth().map_err(RpcError::from)?)),
        "store_kind" => Ok(store_kind(engine)),
        "checkpoint" => checkpoint(engine),
        "seed_checkpoint" => seed_checkpoint(engine, parse(params)?).await,
        "inspect" => inspect(engine),
        "rejections" => rejections(engine, parse(params)?),
        "dismiss_rejection" => dismiss_rejection(engine, parse(params)?),
        "overwrites" => overwrites(engine, parse(params)?),
        "dismiss_overwrite" => dismiss_overwrite(engine, parse(params)?),
        "reset" => serde_json::to_value(engine.reset().await?).map_err(json_err),
        "set_bucket" => set_bucket(engine, params),
        "set_access_token" => Ok(set_access_token(engine, parse(params)?)),
        "attachment_status" => attachment_status(engine, parse(params)?),
        "attachment_put" => attachment_put(engine, parse(params)?),
        "attachment_get" => attachment_get(engine, parse(params)?),
        "attachment_pending" => attachment_pending(engine, parse(params)?),
        "attachment_claim" => attachment_claim(engine, parse(params)?),
        "attachment_patch" => attachment_patch(engine, parse(params)?),
        "attachment_orphan" => attachment_orphan(engine, parse(params)?),
        "attachment_purge" => attachment_purge(engine, parse(params)?),
        "attachment_retry" => attachment_retry(engine, parse(params)?),
        "attachment_cancel" => attachment_cancel(engine, parse(params)?),
        "attachment_remove" => attachment_remove(engine, parse(params)?),
        "attachment_orphaned" => {
            serde_json::to_value(engine.orphaned_attachments()?).map_err(json_err)
        }
        "attachment_recover" => {
            engine.recover_in_flight_attachments()?;
            Ok(Value::Null)
        }
        "attachment_count_at_path" => attachment_count_at_path(engine, parse(params)?),
        "sync" => {
            engine.sync().await.map_err(RpcError::from)?;
            Ok(Value::Null)
        }
        "sync_push" => {
            engine.sync_push().await.map_err(RpcError::from)?;
            Ok(Value::Null)
        }
        "sync_pull" => {
            engine.sync_pull().await.map_err(RpcError::from)?;
            Ok(Value::Null)
        }
        "pull_once" => {
            engine.pull_once().await.map_err(RpcError::from)?;
            Ok(Value::Null)
        }
        "push_once" => {
            engine.push_once().await.map_err(RpcError::from)?;
            Ok(Value::Null)
        }
        other => Err(RpcError::UnknownMethod(other.to_string())),
    }
}

fn json_err(error: serde_json::Error) -> RpcError {
    RpcError::Engine(EngineError::from(error))
}

// MARK: - Methods

fn apply(engine: &SyncEngine, request: ApplyRequest) -> Result<Value, RpcError> {
    engine.apply_at(request.mutation, request.now)?;
    Ok(Value::Null)
}

fn apply_where(engine: &SyncEngine, request: ApplyWhereRequest) -> Result<Value, RpcError> {
    let applied = engine.apply_where(ApplyWhere {
        table: request.table,
        filters: request.filters,
        op: request.op,
        columns: request.columns,
        transforms: request.transforms,
        precondition: request.precondition,
        include_deleted: request.include_deleted,
        max_affected: request.max_affected,
        returning: request.returning,
        cardinality: request.cardinality,
    })?;
    match applied.rows {
        Some(rows) => serde_json::to_value(rows),
        None => serde_json::to_value(applied.keys),
    }
    .map_err(json_err)
}

fn query(engine: &SyncEngine, request: QueryRequest) -> Result<Value, RpcError> {
    let result = engine.query(&request.table, &request.plan)?;
    serde_json::to_value(result).map_err(json_err)
}

fn read(engine: &SyncEngine, request: RowRequest) -> Result<Value, RpcError> {
    let row = engine.read_row(&request.table, &request.pk)?;
    serde_json::to_value(row).map_err(json_err)
}

fn has_tombstone(engine: &SyncEngine, request: RowRequest) -> Result<Value, RpcError> {
    Ok(json!(engine.has_tombstone(&request.table, &request.pk)?))
}

fn store_kind(engine: &SyncEngine) -> Value {
    let kind = engine.store_kind();
    json!({
        "kind": kind.name(),
        "durability": kind.durability(),
    })
}

fn checkpoint(engine: &SyncEngine) -> Result<Value, RpcError> {
    Ok(json!({
        "cursor": engine.get_checkpoint()?,
        "soft_blocked": engine.is_soft_blocked()?,
        "soft_block_reason": engine.soft_block_reason()?,
    }))
}

async fn seed_checkpoint(engine: &SyncEngine, request: CursorRequest) -> Result<Value, RpcError> {
    engine.seed_checkpoint(&request.cursor).await?;
    Ok(Value::Null)
}

fn inspect(engine: &SyncEngine) -> Result<Value, RpcError> {
    Ok(json!({
        "queued": serde_json::to_value(engine.list_outbox(OUTBOX_PAGE)?).map_err(json_err)?,
        "depth": engine.get_outbox_depth()?,
        "last_mutation_id": engine.last_mutation_id()?,
        "cursor": engine.get_checkpoint()?,
        "client_id": engine.client_id()?,
    }))
}

fn rejections(engine: &SyncEngine, request: RejectionsRequest) -> Result<Value, RpcError> {
    let records = engine.list_rejections(request.include_dismissed)?;
    serde_json::to_value(records).map_err(json_err)
}

fn dismiss_rejection(engine: &SyncEngine, request: MutationIdRequest) -> Result<Value, RpcError> {
    Ok(json!(engine.dismiss_rejection(&request.mutation_id)?))
}

fn overwrites(engine: &SyncEngine, request: OverwritesRequest) -> Result<Value, RpcError> {
    let records = engine.list_overwrites(request.include_dismissed)?;
    serde_json::to_value(records).map_err(json_err)
}

fn dismiss_overwrite(engine: &SyncEngine, request: OverwriteIdRequest) -> Result<Value, RpcError> {
    Ok(json!(engine.dismiss_overwrite(request.id)?))
}

fn set_bucket(engine: &SyncEngine, params: &str) -> Result<Value, RpcError> {
    let request: BucketRequest = parse(params)?;
    engine.set_bucket_params(&request.params)?;
    Ok(Value::Null)
}

fn set_access_token(engine: &SyncEngine, request: AccessTokenRequest) -> Value {
    engine.set_remote_access_token(request.token);
    Value::Null
}

fn attachment_status(engine: &SyncEngine, request: ReferenceRequest) -> Result<Value, RpcError> {
    let status = engine.attachment_status(&request.reference)?;
    serde_json::to_value(status).map_err(json_err)
}

// MARK: - The embedder-driven queue
//
// The adapter's `IAttachmentStore` is exactly these calls: the `TypeScript`
// attachment queue moves the bytes (that is where `IFileStore` / `ITransfer`
// were injected) and the Rust store stays the single writer of the rows.

fn attachment_put(engine: &SyncEngine, request: AttachmentPutRequest) -> Result<Value, RpcError> {
    engine.put_attachment(&AttachmentEntry {
        reference: request.reference,
        upload_id: request.upload_id,
        table: request.table,
        pk: request.pk,
        column: request.column,
        bucket: request.bucket,
        owner: request.owner,
        sha256: request.sha256,
        content_type: request.content_type,
        size: request.size,
        local_path: request.local_path,
        direction: request.direction,
        state: request.state,
        in_flight: false,
        fingerprint: None,
        progress: 0,
        attempts: 0,
        permanent: false,
        chunk_offset: 0,
        tus_url: None,
        error: None,
        updated_at: request.created_at.clone(),
        error_code: None,
        created_at: request.created_at,
    })?;
    Ok(Value::Null)
}

fn attachment_get(engine: &SyncEngine, request: ReferenceRequest) -> Result<Value, RpcError> {
    serde_json::to_value(engine.get_attachment(&request.reference)?).map_err(json_err)
}

fn attachment_pending(
    engine: &SyncEngine,
    request: AttachmentDirectionRequest,
) -> Result<Value, RpcError> {
    serde_json::to_value(engine.pending_attachments(&request.direction)?).map_err(json_err)
}

fn attachment_claim(
    engine: &SyncEngine,
    request: AttachmentClaimRequest,
) -> Result<Value, RpcError> {
    Ok(json!(
        engine.claim_attachment(&request.reference, request.state)?
    ))
}

fn attachment_patch(
    engine: &SyncEngine,
    request: AttachmentPatchRequest,
) -> Result<Value, RpcError> {
    engine.patch_attachment(&request.reference, &request.patch)?;
    Ok(Value::Null)
}

fn attachment_orphan(engine: &SyncEngine, request: ReferenceRequest) -> Result<Value, RpcError> {
    engine.orphan_attachment(&request.reference)?;
    Ok(Value::Null)
}

fn attachment_purge(engine: &SyncEngine, request: ReferenceRequest) -> Result<Value, RpcError> {
    engine.purge_attachment(&request.reference)?;
    Ok(Value::Null)
}

// MARK: - The app's own attachment controls
//
// Three calls an app makes about ONE reference, all of them the host's decision
// rather than the queue's: take a stopped transfer back, stop one that is
// running, and forget one outright. The queue's own rules (the budget, the
// orphan sweep) never do any of the three on their own.

fn attachment_retry(engine: &SyncEngine, request: ReferenceRequest) -> Result<Value, RpcError> {
    Ok(json!(engine.retry_attachment(&request.reference)?))
}

fn attachment_cancel(engine: &SyncEngine, request: ReferenceRequest) -> Result<Value, RpcError> {
    Ok(json!(engine.cancel_attachment(&request.reference)?))
}

fn attachment_remove(engine: &SyncEngine, request: ReferenceRequest) -> Result<Value, RpcError> {
    serde_json::to_value(engine.remove_attachment(&request.reference)?).map_err(json_err)
}

fn attachment_count_at_path(
    engine: &SyncEngine,
    request: AttachmentCountRequest,
) -> Result<Value, RpcError> {
    Ok(json!(engine.count_live_attachments_at_local_path(
        &request.local_path,
        request.excluding_reference.as_deref(),
    )?))
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::engine::tests::memory_engine;
    use crate::{DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, ScriptedRemote};
    use kizunasync_store::{LocalStore, NewOverwrite};
    use kizunasync_transfer::FakeTransfer;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    /// The session Supabase Auth hands user `u1`: `{"sub":"u1"}` as its
    /// payload. The signature is never checked.
    const SESSION_U1: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln";

    #[test]
    fn describe_includes_code_only_when_present() {
        let with_code = RpcError::Engine(
            EngineError::remote("boom").with_code(Some("AUTH_SESSION_MISSING".to_string())),
        );
        let envelope = describe(&with_code);
        assert_eq!(envelope["code"], json!("AUTH_SESSION_MISSING"));

        let without_code = RpcError::Engine(EngineError::remote("boom"));
        let envelope = describe(&without_code);
        assert!(envelope.get("code").is_none());
    }

    #[test]
    fn describe_reports_engine_unavailable_with_its_catalog_code() {
        let error = RpcError::Engine(EngineError::EngineUnavailable {
            message: "create() was not called".into(),
        });
        let envelope = describe(&error);
        assert_eq!(envelope["kind"], json!("engine_unavailable"));
        assert_eq!(
            envelope["code"],
            json!(crate::error_catalog::ENGINE_UNAVAILABLE)
        );
        assert_eq!(
            envelope["message"],
            json!("ENGINE_UNAVAILABLE: create() was not called")
        );
        assert_eq!(envelope["retryable"], json!(false));
    }

    #[test]
    fn describe_tells_a_busy_store_from_an_unavailable_one() {
        let busy = RpcError::Engine(EngineError::Store(StoreError::VfsBusy {
            name: "todos.db".into(),
        }));
        let envelope = describe(&busy);
        assert_eq!(envelope["kind"], json!("store_busy"));
        assert_eq!(envelope["code"], json!(crate::error_catalog::STORE_BUSY));
        assert_eq!(envelope["name"], json!("todos.db"));
        assert_eq!(envelope["retryable"], json!(true));

        let unavailable = RpcError::Engine(EngineError::Store(StoreError::VfsUnavailable {
            sahpool: "no sync access handles".into(),
            relaxed_idb: "no IndexedDB".into(),
        }));
        let envelope = describe(&unavailable);
        assert_eq!(envelope["kind"], json!("store_unavailable"));
        assert_eq!(
            envelope["code"],
            json!(crate::error_catalog::STORE_UNAVAILABLE)
        );
        assert_eq!(envelope["retryable"], json!(false));
    }

    /// Every kind carries its catalog code, `internal` included: a fault the JSON
    /// surface described without one would reach the app as a bare `Error` there
    /// and as a typed one on the `UniFFI` bridge, which has `code()` for all of
    /// them.
    #[test]
    fn describe_carries_a_catalog_code_on_every_kind() {
        let bad_json = || serde_json::from_str::<Value>("!").unwrap_err();
        let cases = [
            (
                EngineError::LocalConstraint("dup pk".into()),
                "constraint",
                crate::error_catalog::LOCAL_CONSTRAINT,
            ),
            (
                EngineError::UnknownTable("ghosts".into()),
                "unknown_table",
                crate::error_catalog::UNKNOWN_TABLE,
            ),
            (
                EngineError::SoftDeleteViolation {
                    table: "todos".into(),
                },
                "soft_delete_violation",
                crate::error_catalog::SOFT_DELETE_VIOLATION,
            ),
            (
                EngineError::BucketUnset,
                "bucket_unset",
                crate::error_catalog::BUCKET_UNSET,
            ),
            (
                EngineError::Json(bad_json()),
                "internal",
                crate::error_catalog::JSON,
            ),
            (
                EngineError::AttachmentPortsMissing,
                "internal",
                crate::error_catalog::ATTACHMENT_PORTS_MISSING,
            ),
            (
                EngineError::AttachmentRowGone("ref".into()),
                "internal",
                crate::error_catalog::ATTACHMENT_ROW_GONE,
            ),
            (
                EngineError::AttachmentOwnerMissing("ref".into()),
                "internal",
                crate::error_catalog::ATTACHMENT_OWNER_MISSING,
            ),
            (
                EngineError::Store(StoreError::Json(bad_json())),
                "internal",
                crate::error_catalog::STORE,
            ),
        ];
        for (error, kind, code) in cases {
            let envelope = describe(&RpcError::Engine(error));
            assert_eq!(envelope["kind"], json!(kind), "{envelope}");
            assert_eq!(envelope["code"], json!(code), "{envelope}");
            assert!(
                crate::error_catalog::contains(envelope["code"].as_str().unwrap()),
                "{envelope} carries a code outside the catalog"
            );
        }
    }

    /// A code-less remote fault is the one exception, and deliberately so: that
    /// `code` carries the ADAPTER's transport vocabulary (`AUTH_SESSION_TIMEOUT`,
    /// a SQLSTATE), never a catalog code, so inventing one would hand the app a
    /// value no adapter sent.
    #[test]
    fn describe_leaves_a_code_less_remote_fault_without_one() {
        let envelope = describe(&RpcError::Engine(EngineError::remote("network is down")));
        assert_eq!(envelope["kind"], json!("remote"));
        assert!(envelope.get("code").is_none(), "{envelope}");
    }

    /// One fault, one answer: the envelope's flag is the catalog's, so the JSON
    /// surface and the generated `ENGINE_ERROR_RETRYABLE` table can never tell an
    /// app two different things about the same code.
    #[test]
    fn envelope_retryable_matches_the_catalog_flag_for_every_variant() {
        for error in crate::error::tests::every_variant() {
            let code = error.code();
            assert_eq!(
                describe_engine(&error)["retryable"],
                json!(crate::error_catalog::catalog_retryable(&code)),
                "{code}"
            );
        }
    }

    /// The encoded description of each [`crate::error::tests::every_variant`]
    /// entry, in that order: every key and value it carries, and no other key.
    const PINNED_DESCRIPTIONS: [&str; 31] = [
        r#"{"code":"STORE","kind":"internal","message":"store: json: expected value at line 1 column 1","retryable":false}"#,
        r#"{"code":"LOCAL_CONSTRAINT","kind":"constraint","message":"store: constraint: dup pk","retryable":false}"#,
        r#"{"code":"STORE_BUSY","kind":"store_busy","message":"store: wasm store: OPFS store for \"todos.db\" is held by another browser context","name":"todos.db","retryable":true}"#,
        r#"{"code":"STORE_UNAVAILABLE","kind":"store_unavailable","message":"store: wasm store: no persistent VFS available (opfs-sahpool: no sync access handles; relaxed-idb: no IndexedDB)","retryable":false}"#,
        r#"{"code":"LOCAL_UNSUPPORTED","kind":"query","message":"query: invalid filter: op","retryable":false}"#,
        r#"{"kind":"remote","message":"remote: offline","retryable":true}"#,
        r#"{"kind":"remote","message":"remote: 22P02","retryable":false}"#,
        r#"{"code":"TRANSFER","kind":"internal","message":"transfer: attachment not yet available","retryable":true}"#,
        r#"{"code":"BUCKET_UNSET","kind":"bucket_unset","message":"bucket unset","retryable":false}"#,
        r#"{"code":"BUCKET_UNSET","kind":"bucket_unset","message":"set_bucket: \"team_id\" is not a configured bucket column (configured: \"owner_id\")","retryable":false}"#,
        r#"{"code":"UNKNOWN_TABLE","kind":"unknown_table","message":"unknown table: items","retryable":false,"table":"items"}"#,
        r#"{"code":"LOCAL_CONSTRAINT","kind":"constraint","message":"local constraint: dup pk","retryable":false}"#,
        r#"{"code":"LOCAL_CONSTRAINT","kind":"query","message":"query: single() requires exactly one row; got 0","retryable":false}"#,
        r#"{"code":"CONFIG_INVALID","kind":"config","message":"config: remote must be an object","retryable":false}"#,
        r#"{"code":"SOFT_DELETE_VIOLATION","kind":"soft_delete_violation","message":"delete refused on soft-delete table items: write the soft-delete column instead","retryable":false,"table":"items"}"#,
        r#"{"code":"JSON","kind":"internal","message":"json: expected value at line 1 column 1","retryable":false}"#,
        r#"{"code":"ATTACHMENT_PORTS_MISSING","kind":"internal","message":"ATTACHMENT_PORTS_MISSING: a table declares attachments but attachment_root is unset","retryable":false}"#,
        r#"{"code":"ATTACHMENT_ROW_GONE","kind":"internal","message":"ATTACHMENT_ROW_GONE: items/p-1","retryable":false}"#,
        r#"{"code":"ATTACHMENT_OWNER_MISSING","kind":"internal","message":"ATTACHMENT_OWNER_MISSING: items.owner","retryable":false}"#,
        r#"{"code":"ATTACHMENT_UNVERIFIED","kind":"internal","message":"ATTACHMENT_UNVERIFIED: items/p-1/photo","retryable":true}"#,
        r#"{"code":"ATTACHMENT_HASH_MISMATCH","kind":"internal","message":"ATTACHMENT_HASH_MISMATCH: items/p-1/photo","retryable":true}"#,
        r#"{"code":"ATTACHMENT_NOT_YET_AVAILABLE","kind":"internal","message":"ATTACHMENT_NOT_YET_AVAILABLE: items/p-1/photo","retryable":true}"#,
        r#"{"code":"ATTACHMENT_UPLOAD_EXPIRED","kind":"internal","message":"ATTACHMENT_UPLOAD_EXPIRED: items/p-1/photo","retryable":true}"#,
        r#"{"code":"ATTACHMENT_TRANSFER_TIMEOUT","kind":"internal","message":"ATTACHMENT_TRANSFER_TIMEOUT: items/p-1/photo","retryable":true}"#,
        r#"{"code":"ENGINE_UNAVAILABLE","kind":"engine_unavailable","message":"ENGINE_UNAVAILABLE: create() was not called","retryable":false}"#,
        r#"{"code":"MALFORMED_PUSH_RESPONSE","kind":"protocol","message":"MALFORMED_PUSH_RESPONSE: dummy","retryable":false}"#,
        r#"{"code":"UNKNOWN_BATCH_OFFENDER","kind":"protocol","message":"UNKNOWN_BATCH_OFFENDER: dummy","retryable":false}"#,
        r#"{"code":"UNKNOWN_OP","kind":"protocol","message":"UNKNOWN_OP: dummy","retryable":false}"#,
        r#"{"code":"UNKNOWN_SIGNAL","kind":"protocol","message":"UNKNOWN_SIGNAL: dummy","retryable":false}"#,
        r#"{"code":"UNKNOWN_VERDICT_REASON","kind":"protocol","message":"UNKNOWN_VERDICT_REASON: dummy","retryable":false}"#,
        r#"{"code":"VERDICT_BIJECTION","kind":"protocol","message":"VERDICT_BIJECTION: dummy","retryable":false}"#,
    ];

    /// The whole mapping, pinned byte for byte: a renamed key, a changed value,
    /// or a key gained or lost fails on the row of the variant it touched.
    #[test]
    fn describe_engine_encodes_the_pinned_description_of_every_variant() {
        let variants = crate::error::tests::every_variant();
        assert_eq!(
            variants.len(),
            PINNED_DESCRIPTIONS.len(),
            "one row per variant"
        );
        for (error, pinned) in variants.iter().zip(PINNED_DESCRIPTIONS) {
            let encoded = serde_json::to_string(&describe_engine(error)).unwrap();
            assert_eq!(encoded, pinned, "{error:?}");
        }
    }

    #[test]
    fn error_envelope_carries_a_busy_store_the_page_can_retry() {
        let error = EngineError::Store(StoreError::VfsBusy {
            name: "todos.db".into(),
        });
        let envelope: Value = serde_json::from_str(&error_envelope(&error)).unwrap();
        assert_eq!(envelope["ok"], json!(false));
        assert_eq!(envelope["error"]["kind"], json!("store_busy"));
        assert_eq!(
            envelope["error"]["code"],
            json!(crate::error_catalog::STORE_BUSY)
        );
        assert_eq!(envelope["error"]["retryable"], json!(true));
    }

    #[test]
    fn error_envelope_matches_dispatch_failure_shape() {
        let error = EngineError::EngineUnavailable {
            message: "create() was not called".into(),
        };
        let envelope: Value = serde_json::from_str(&error_envelope(&error)).unwrap();
        assert_eq!(envelope["ok"], json!(false));
        assert_eq!(envelope["error"]["kind"], json!("engine_unavailable"));
        assert_eq!(
            envelope["error"]["code"],
            json!(crate::error_catalog::ENGINE_UNAVAILABLE)
        );
        assert_eq!(envelope["error"]["retryable"], json!(false));
    }

    /// One fault class, one kind: a refused plan and a refused write both arrive
    /// as `query`, and the code is what tells a cardinality miss from a construct
    /// the local subset cannot answer.
    #[test]
    fn error_envelope_carries_a_query_refusal_with_its_code() {
        let cardinality =
            EngineError::Query(kizunasync_query::QueryError::MaybeSingleCardinality(2));
        let envelope: Value = serde_json::from_str(&error_envelope(&cardinality)).unwrap();
        assert_eq!(envelope["error"]["kind"], json!("query"));
        assert_eq!(
            envelope["error"]["code"],
            json!(crate::error_catalog::LOCAL_CONSTRAINT)
        );

        let unsupported = EngineError::Query(kizunasync_query::QueryError::Unsupported(
            "is(): operand must be null, true, or false".into(),
        ));
        let envelope: Value = serde_json::from_str(&error_envelope(&unsupported)).unwrap();
        assert_eq!(envelope["error"]["kind"], json!("query"));
        assert_eq!(
            envelope["error"]["code"],
            json!(crate::error_catalog::LOCAL_UNSUPPORTED)
        );
        assert_eq!(envelope["error"]["retryable"], json!(false));
    }

    /// A create-time config refusal is the one fault a bridge reports with no
    /// engine behind it, so its kind and code have to survive that path.
    #[test]
    fn error_envelope_carries_a_refused_config() {
        let error = EngineError::Config("remote must be an object".into());
        let envelope: Value = serde_json::from_str(&error_envelope(&error)).unwrap();
        assert_eq!(envelope["ok"], json!(false));
        assert_eq!(envelope["error"]["kind"], json!("config"));
        assert_eq!(
            envelope["error"]["code"],
            json!(crate::error_catalog::CONFIG_INVALID)
        );
        assert_eq!(envelope["error"]["retryable"], json!(false));
    }

    #[tokio::test]
    async fn store_kind_reports_memory_and_none_durability() {
        let store = LocalStore::open_in_memory().unwrap();
        let config = EngineConfig {
            tables: BTreeMap::new(),
            schema_version: 1,
            default_limit: None,
            attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
            client_id: "c1".into(),
        };
        let engine = SyncEngine::new(
            store,
            config,
            Arc::new(ScriptedRemote::new()),
            EngineDeps::default(),
        );

        let response = dispatch(&engine, "store_kind", "{}").await;

        let envelope: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(
            envelope,
            json!({ "ok": true, "value": { "kind": "memory", "durability": "none" } })
        );
    }

    /// The three app-facing attachment controls answer one JSON shape each, which
    /// is what every host queue binds to: a boolean for retry and cancel, the
    /// sandbox path or null for remove.
    #[tokio::test]
    async fn the_attachment_controls_answer_their_documented_shapes() {
        let engine = memory_engine();
        let reference = "u1/p1/photo.png";
        let put = json!({
            "reference": reference,
            "upload_id": "photo",
            "table": "todos",
            "pk": "p1",
            "column": "photo",
            "bucket": "media",
            "owner": "u1",
            "local_path": "/sandbox/photo.png",
            "direction": "upload",
            "state": "queued",
            "created_at": "2024-01-01T00:00:00.000Z",
        });
        let response = dispatch(&engine, "attachment_put", &put.to_string()).await;
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            json!({ "ok": true, "value": null })
        );

        let params = json!({ "reference": reference }).to_string();
        for method in ["attachment_cancel", "attachment_retry"] {
            let response = dispatch(&engine, method, &params).await;
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap(),
                json!({ "ok": true, "value": true }),
                "{method}"
            );
        }

        let removed = dispatch(&engine, "attachment_remove", &params).await;
        assert_eq!(
            serde_json::from_str::<Value>(&removed).unwrap(),
            json!({ "ok": true, "value": "/sandbox/photo.png" })
        );
        let gone = dispatch(&engine, "attachment_remove", &params).await;
        assert_eq!(
            serde_json::from_str::<Value>(&gone).unwrap(),
            json!({ "ok": true, "value": null })
        );
        let missing = dispatch(&engine, "attachment_retry", &params).await;
        assert_eq!(
            serde_json::from_str::<Value>(&missing).unwrap(),
            json!({ "ok": true, "value": false })
        );
    }

    /// Enqueue `reference` through the host's put call as an uploaded object
    /// of the user its first segment names.
    async fn put_uploaded(engine: &SyncEngine, reference: &str) {
        let put = json!({
            "reference": reference,
            "upload_id": "photo",
            "table": "todos",
            "pk": "p1",
            "column": "photo",
            "bucket": "media",
            "owner": reference.split('/').next().unwrap(),
            "direction": "upload",
            "state": "synced",
            "created_at": "2024-01-01T00:00:00.000Z",
        });
        let response = dispatch(engine, "attachment_put", &put.to_string()).await;
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            json!({ "ok": true, "value": null })
        );
    }

    /// Call `attachment_orphan` on `reference` and answer the state its row
    /// is left in.
    async fn orphan_through_rpc(engine: &SyncEngine, reference: &str) -> Value {
        let params = json!({ "reference": reference }).to_string();
        let response = dispatch(engine, "attachment_orphan", &params).await;
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            json!({ "ok": true, "value": null })
        );
        let status = dispatch(engine, "attachment_status", &params).await;
        serde_json::from_str::<Value>(&status).unwrap()["value"]["state"].clone()
    }

    /// The host's orphan call hands the vacuum only an object of the user
    /// the store belongs to. Another user's object is evicted, so Storage is
    /// never asked to remove it.
    #[tokio::test]
    async fn attachment_orphan_hands_only_the_owners_object_to_the_vacuum() {
        let transfer = Arc::new(FakeTransfer::new());
        let engine = memory_engine().with_transfer(transfer.clone());
        let token = json!({ "token": SESSION_U1 }).to_string();
        dispatch(&engine, "set_access_token", &token).await;
        put_uploaded(&engine, "u1/p1/own.png").await;
        put_uploaded(&engine, "u2/p9/peer.png").await;

        assert_eq!(
            orphan_through_rpc(&engine, "u1/p1/own.png").await,
            json!("orphaned")
        );
        assert_eq!(
            orphan_through_rpc(&engine, "u2/p9/peer.png").await,
            json!("evicted")
        );

        engine.vacuum_attachments().await.unwrap();
        let removed: Vec<String> = transfer
            .removed
            .lock()
            .unwrap()
            .iter()
            .map(|target| target.path.clone())
            .collect();
        assert_eq!(removed, vec!["u1/p1/own.png".to_owned()]);
    }

    /// A store that records no user owns no object: the host's orphan call
    /// only evicts.
    #[tokio::test]
    async fn attachment_orphan_on_a_store_without_a_recorded_user_evicts() {
        let engine = memory_engine();
        put_uploaded(&engine, "u1/p1/own.png").await;

        assert_eq!(
            orphan_through_rpc(&engine, "u1/p1/own.png").await,
            json!("evicted")
        );
    }

    /// `attachment_status` carries the budget's verdict, so a host can tell a
    /// failure the next drive retries from one nothing will move again.
    #[tokio::test]
    async fn attachment_status_carries_the_permanent_flag() {
        let engine = memory_engine();
        let reference = "u1/p1/photo.png";
        engine
            .put_attachment(&AttachmentEntry {
                reference: reference.into(),
                upload_id: "photo".into(),
                table: "todos".into(),
                pk: "p1".into(),
                column: "photo".into(),
                bucket: "media".into(),
                owner: "u1".into(),
                sha256: None,
                content_type: None,
                size: None,
                local_path: None,
                direction: "upload".into(),
                state: AttachmentState::Failed,
                in_flight: false,
                fingerprint: None,
                progress: 0,
                attempts: 0,
                permanent: false,
                chunk_offset: 0,
                tus_url: None,
                error: None,
                created_at: "2024-01-01T00:00:00.000Z".into(),
                updated_at: "2024-01-01T00:00:00.000Z".into(),
                error_code: None,
            })
            .unwrap();
        let params = json!({ "reference": reference }).to_string();

        let response = dispatch(&engine, "attachment_status", &params).await;
        let envelope: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(envelope["value"]["permanent"], json!(false));

        engine
            .store
            .fail_attachment_permanently(reference, 5, "2024-01-01T00:00:01.000Z")
            .unwrap();
        let response = dispatch(&engine, "attachment_status", &params).await;
        let envelope: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(envelope["value"]["permanent"], json!(true));
        assert_eq!(envelope["value"]["state"], json!("failed"));
    }

    /// The overwrite journal answers the same two shapes the rejection journal
    /// does: a list filtered by `include_dismissed`, and a boolean saying
    /// whether the acknowledgement found a row.
    #[tokio::test]
    async fn the_overwrite_journal_lists_and_dismisses() {
        let engine = memory_engine();
        engine
            .store
            .record_overwrite(&NewOverwrite {
                table: "todos",
                pk: "p1",
                column: "title",
                loser_value: &json!("mine"),
                winner_mutation_id: "peer-1",
                conflict_mode: "arrival",
                winner_seq: Some("42"),
                at: 1_700_000_000_000,
            })
            .unwrap();

        let listed = dispatch(&engine, "overwrites", "{}").await;
        let envelope: Value = serde_json::from_str(&listed).unwrap();
        assert_eq!(envelope["ok"], json!(true));
        assert_eq!(envelope["value"].as_array().unwrap().len(), 1);
        let record = &envelope["value"][0];
        assert_eq!(record["table"], json!("todos"));
        assert_eq!(record["column"], json!("title"));
        assert_eq!(record["loser_value"], json!("mine"));
        assert_eq!(record["winner_mutation_id"], json!("peer-1"));
        assert_eq!(record["conflict_mode"], json!("arrival"));
        assert_eq!(record["winner_seq"], json!("42"));
        assert_eq!(record["dismissed"], json!(false));
        let id = record["id"].as_i64().unwrap();

        let dismissed = dispatch(
            &engine,
            "dismiss_overwrite",
            &json!({ "id": id }).to_string(),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&dismissed).unwrap(),
            json!({ "ok": true, "value": true })
        );

        let visible = dispatch(&engine, "overwrites", "{}").await;
        let envelope: Value = serde_json::from_str(&visible).unwrap();
        assert_eq!(envelope["value"].as_array().unwrap().len(), 0);

        let all = dispatch(
            &engine,
            "overwrites",
            &json!({ "include_dismissed": true }).to_string(),
        )
        .await;
        let envelope: Value = serde_json::from_str(&all).unwrap();
        assert_eq!(envelope["value"][0]["dismissed"], json!(true));

        let missing = dispatch(
            &engine,
            "dismiss_overwrite",
            &json!({ "id": -1 }).to_string(),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&missing).unwrap(),
            json!({ "ok": true, "value": false })
        );
    }

    /// A misspelled bucket key is refused with the bucket code rather than
    /// silently filling nothing.
    #[tokio::test]
    async fn set_bucket_refuses_a_key_no_table_declares() {
        let engine = memory_engine();

        let response = dispatch(
            &engine,
            "set_bucket",
            &json!({ "params": { "tenant_id": "t1" } }).to_string(),
        )
        .await;

        let envelope: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(envelope["ok"], json!(false));
        assert_eq!(envelope["error"]["kind"], json!("bucket_unset"));
        assert_eq!(
            envelope["error"]["code"],
            json!(crate::error_catalog::BUCKET_UNSET)
        );
    }
}
