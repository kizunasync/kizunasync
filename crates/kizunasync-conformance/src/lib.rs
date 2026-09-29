//! Run `packages/protocol` golden transcripts against the Rust `SyncEngine`.
//!
//! # Allocation
//!
//! Allocation-conscious harness: transcript JSON and engine state allocate.
//! Not heapless.

#![forbid(unsafe_code)]

mod transcript_remote;

use kizunasync_engine::{
    ConflictMode, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, EngineError, SyncEngine,
    SyncMode, TableConfig,
};
use kizunasync_protocol::{Op, PullResponse, PushResponse};
use kizunasync_store::{LocalMutation, LocalStore};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use transcript_remote::TranscriptRemote;

#[derive(Debug, Deserialize)]
struct Manifest {
    cases: Vec<ManifestCase>,
}

#[derive(Debug, Deserialize)]
struct ManifestCase {
    id: String,
    status: String,
    #[serde(default)]
    blocked_on: Vec<String>,
    #[serde(default)]
    file: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Transcript {
    case: String,
    context: TranscriptContext,
    steps: Vec<Value>,
    #[serde(default)]
    postconditions: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct TranscriptContext {
    client_id: String,
    schema_version: i64,
    user_id: String,
    server: ServerContext,
}

#[derive(Debug, Deserialize)]
struct ServerContext {
    tables: HashMap<String, ServerTable>,
}

#[derive(Debug, Deserialize)]
struct ServerTable {
    bucket_column: String,
    /// D-corpus-soft-delete-and-refusal: the app-level deletion marker. Present ⇒ the engine refuses a hard
    /// delete on this table (lifecycle/004); absent ⇒ hard deletes stay legal.
    #[serde(default)]
    soft_delete_column: Option<String>,
    /// How the server resolves concurrent column writes here, and so whether a
    /// local write leaves carrying an origin HLC. `arrival` unless the transcript
    /// opts the table into `hlc` (conflict/003).
    #[serde(default = "kizunasync_engine::arrival_mode")]
    conflict_mode: ConflictMode,
}

/// Every way a corpus replay diverges from its transcript, kept apart from
/// [`EngineError`] so a divergence is never carried as its retryable `remote`
/// transport fault.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ConformanceError {
    /// A transcript step names a `kind` this harness does not replay.
    #[error("unknown transcript step kind {kind:?} (known: local, rpc, assert, server, fault)")]
    UnknownStepKind {
        /// The step's own `kind` field.
        kind: String,
    },
    /// The engine's emitted request bytes differ from the transcript's golden
    /// request.
    #[error("{detail}")]
    RequestMismatch {
        /// The RPC the request belongs to (`push` or `pull`).
        rpc: &'static str,
        /// The field path and the values that diverge.
        detail: String,
    },
    /// An `assert` step names a `check` this harness does not evaluate.
    #[error(
        "unknown assert check {check:?} (known: outbox-depth, cursor, local-row, no-intermediate-commit, event)"
    )]
    UnknownCheck {
        /// The check's own `check` field.
        check: String,
    },
    /// A known assert check, or a local/fault step's own expectation, ran and
    /// did not hold.
    #[error("{detail}")]
    CheckFailed {
        /// The check family that failed (`outbox-depth`, `cursor`,
        /// `local-row`, `no-intermediate-commit`, `event`, `local`, `fault`).
        check: &'static str,
        /// What the check expected against what it found.
        detail: String,
    },
    /// A transcript case's JSON does not have the shape this harness expects.
    #[error("{path}: {detail}")]
    MalformedTranscript {
        /// The case id the malformed JSON came from.
        path: String,
        /// The parse or shape failure.
        detail: String,
    },
    /// The engine itself failed to serve the call.
    #[error(transparent)]
    Engine(#[from] EngineError),
}

/// Walk up from the current directory to the repository root, recognized by
/// `packages/protocol/cases/manifest.json`. Falls back to `.` when no ancestor
/// carries the manifest.
#[must_use]
pub fn repo_root_from_cwd() -> PathBuf {
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for _ in 0..8 {
        if dir.join("packages/protocol/cases/manifest.json").is_file() {
            return dir;
        }
        if !dir.pop() {
            break;
        }
    }
    PathBuf::from(".")
}

/// Read the case manifest and return `(case id, transcript path)` for every
/// executable case, skipping the entries an open decision still blocks and the
/// entries that carry no transcript bytes.
///
/// # Errors
///
/// Returns the read or parse failure when the manifest is unreadable or is not
/// valid manifest JSON, and an error when the manifest path has no grandparent
/// directory to resolve transcript paths against.
pub fn non_blocked_cases(manifest_path: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let text = std::fs::read_to_string(manifest_path).map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let root = manifest_path
        .parent()
        .and_then(|p| p.parent())
        .ok_or("manifest parent")?
        .to_path_buf();

    let mut out = Vec::new();
    for c in manifest.cases {
        if c.status == "open-decision" || !c.blocked_on.is_empty() {
            continue;
        }
        let Some(rel) = c.file else {
            continue;
        };
        out.push((c.id, root.join(rel)));
    }
    Ok(out)
}

fn map_from_value(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// Replay one golden transcript file against a fresh `SyncEngine` and return how
/// many of its pull steps the harness skipped, the ones whose recorded request is
/// not this client's identity pull.
///
/// # Errors
///
/// Returns the read or parse failure when the file is unreadable or is not a
/// valid transcript, and the first step divergence prefixed with the case id.
pub async fn run_transcript_file(path: &Path) -> Result<usize, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let t: Transcript = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    run_transcript(&t)
        .await
        .map_err(|e| format!("{}: {e}", t.case))
}

async fn run_transcript(t: &Transcript) -> Result<usize, ConformanceError> {
    let mut replay = Replay::start(t).await?;
    for step in &t.steps {
        replay.run_step(step).await?;
    }

    for check in &t.postconditions {
        apply_check(
            &replay.engine,
            check,
            replay.checkpoint_before_pull.as_deref(),
        )?;
    }
    Ok(replay.skipped_steps)
}

/// The engine configuration a transcript's context declares: one table per
/// server table, each bucketed on its owner column for `context.user_id`.
fn engine_config(t: &Transcript) -> EngineConfig {
    let mut tables = BTreeMap::new();
    for (name, st) in &t.context.server.tables {
        let mut params = Map::new();
        params.insert(st.bucket_column.clone(), json!(t.context.user_id));
        tables.insert(
            name.clone(),
            TableConfig {
                bucket_column: st.bucket_column.clone(),
                bucket_params: params,
                bucket_owner: false,
                // The corpus declares no attachment column, so every case keeps
                // the pull-commit path that does no extra reads.
                attachments: BTreeMap::new(),
                soft_delete_column: st.soft_delete_column.clone(),
                sync_mode: SyncMode::ReadWrite,
                conflict_mode: st.conflict_mode,
            },
        );
    }

    EngineConfig {
        tables,
        schema_version: t.context.schema_version,
        default_limit: first_pull_limit(&t.steps),
        attachment_attempts: DEFAULT_ATTACHMENT_ATTEMPTS,
        client_id: t.context.client_id.clone(),
    }
}

/// One transcript replay in flight: the engine under test, its remote, what the
/// push requests pin for the local writes, and the state later steps read.
struct Replay<'t> {
    transcript: &'t Transcript,
    engine: SyncEngine,
    remote: Arc<TranscriptRemote>,
    atomic_batch_ids: HashMap<String, String>,
    pinned: HashMap<String, PinnedMutation>,
    skipped_steps: usize,
    /// The durable checkpoint the last replayed pull started from: what
    /// `no-intermediate-commit` fences a staged page against.
    checkpoint_before_pull: Option<String>,
}

impl<'t> Replay<'t> {
    async fn start(t: &'t Transcript) -> Result<Self, ConformanceError> {
        let store = LocalStore::open_in_memory().map_err(EngineError::from)?;
        let remote = Arc::new(TranscriptRemote::new());
        let config = engine_config(t);
        let deps = EngineDeps {
            now: Box::new(|| "2020-01-01T00:00:00.000Z".into()),
            // the same instant as `now`: a local write stamps its outbox entry from this one
            now_millis: Box::new(|| 1_577_836_800_000),
            // transcript pins mutation ids; uuid only for unexpected mints
            uuid: Box::new(|| "00000000-0000-4000-8000-deadbeef0001".into()),
        };
        let engine = SyncEngine::new(store, config, remote.clone(), deps);

        // Seed resume cursor from the first pull request (mirrors client-executor).
        if let Some(cursor) = first_pull_cursor(&t.steps) {
            engine.seed_checkpoint(cursor).await?;
        }
        Ok(Self {
            transcript: t,
            engine,
            remote,
            atomic_batch_ids: atomic_batch_id_by_mutation_id(&t.steps),
            pinned: pinned_by_mutation_id(&t.steps),
            skipped_steps: 0,
            checkpoint_before_pull: None,
        })
    }

    /// One step, handed to the handler its `kind` names, like the step loop of
    /// `runTranscriptClient` in `packages/core/src/conformance/client-executor.ts`.
    async fn run_step(&mut self, step: &Value) -> Result<(), ConformanceError> {
        let kind = step.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        match kind {
            "local" => self.run_local_step(step),
            "rpc" => self.run_rpc_step(step).await,
            "assert" => self.run_assert_step(step),
            "server" => {
                seed_server_step(&self.engine, step);
                Ok(())
            }
            "fault" => inject_fault(&self.engine, &self.remote, &self.transcript.case, step).await,
            other => Err(ConformanceError::UnknownStepKind {
                kind: other.to_string(),
            }),
        }
    }

    fn run_local_step(&self, step: &Value) -> Result<(), ConformanceError> {
        let mutation = self.local_mutation(step)?;
        apply_local(
            &self.engine,
            mutation,
            step.get("expect_error").and_then(Value::as_str),
        )
    }

    /// The write a `local` step describes, completed with the batch id,
    /// precondition, and origin HLC the push requests pin for its `mutation_id`.
    fn local_mutation(&self, step: &Value) -> Result<LocalMutation, ConformanceError> {
        let op = match step.get("op").and_then(|o| o.as_str()).unwrap_or("insert") {
            "insert" => Op::Insert,
            "update" => Op::Update,
            "delete" => Op::Delete,
            other => {
                return Err(ConformanceError::MalformedTranscript {
                    path: self.transcript.case.clone(),
                    detail: format!("unknown local op {other:?} (known: insert, update, delete)"),
                });
            }
        };
        let columns = step.get("columns").map(map_from_value).unwrap_or_default();
        let mutation_id = step
            .get("mutation_id")
            .and_then(|m| m.as_str())
            .map(str::to_string);
        let pins = mutation_id.as_deref().and_then(|id| self.pinned.get(id));
        let batch_id = step
            .get("batch_id")
            .and_then(|b| b.as_str())
            .map(str::to_string)
            .or_else(|| {
                mutation_id
                    .as_deref()
                    .and_then(|id| self.atomic_batch_ids.get(id).cloned())
            });

        Ok(LocalMutation {
            table: step["table"].as_str().unwrap_or("").to_string(),
            pk: step["pk"].as_str().unwrap_or("").to_string(),
            op,
            columns,
            transforms: step.get("transforms").and_then(|t| t.as_object()).cloned(),
            precondition: step
                .get("precondition")
                .map(map_from_value)
                .or_else(|| pins.and_then(|p| p.precondition.clone())),
            batch_id,
            hlc: step
                .get("hlc")
                .and_then(|h| h.as_str())
                .map(str::to_string)
                .or_else(|| pins.and_then(|p| p.hlc.clone())),
            mutation_id,
        })
    }

    async fn run_rpc_step(&mut self, step: &Value) -> Result<(), ConformanceError> {
        let rpc = step.get("rpc").and_then(|r| r.as_str()).unwrap_or("");
        match rpc {
            "push" => self.run_push_step(step).await,
            "pull" => self.run_pull_step(step).await,
            other => Err(ConformanceError::MalformedTranscript {
                path: self.transcript.case.clone(),
                detail: format!("unsupported rpc {other}"),
            }),
        }
    }

    async fn run_push_step(&self, step: &Value) -> Result<(), ConformanceError> {
        if let Some(resp_v) = step.get("response") {
            let resp: PushResponse = serde_json::from_value(resp_v.clone())
                .map_err(|e| EngineError::remote(e.to_string()))?;
            self.remote
                .inner()
                .push_responses
                .lock()
                .map_err(|_| EngineError::remote("lock"))?
                .push(resp);
        }
        // Forget the previous request so "the engine emitted
        // nothing here" cannot pass by re-checking an older one.
        *self
            .remote
            .inner()
            .last_push
            .lock()
            .map_err(|_| EngineError::remote("lock"))? = None;
        self.engine.push_once().await?;
        if let Some(expected) = step.get("request") {
            assert_recorded_request("push", &self.remote.inner().last_push, expected)?;
        }
        Ok(())
    }

    async fn run_pull_step(&mut self, step: &Value) -> Result<(), ConformanceError> {
        if let Some(expected) = step.get("request")
            && !pull_is_client_identity(self.transcript, expected)
        {
            // Cross-bucket / empty-param probes (tombstones/003)
            // are server-oracle RPCs. A single client cannot emit
            // them without setBucket, and applying them would
            // advance the checkpoint past later sibling pulls
            // from the same cursor. Protocol executor + live SQL
            // own those bytes.
            self.skipped_steps += 1;
            return Ok(());
        }

        if let Some(resp_v) = step.get("response") {
            let resp: PullResponse = serde_json::from_value(resp_v.clone())
                .map_err(|e| EngineError::remote(e.to_string()))?;
            self.remote
                .inner()
                .pull_responses
                .lock()
                .map_err(|_| EngineError::remote("lock"))?
                .push(resp);
        }
        *self
            .remote
            .inner()
            .last_pull
            .lock()
            .map_err(|_| EngineError::remote("lock"))? = None;
        self.checkpoint_before_pull = Some(self.engine.get_checkpoint()?);
        self.engine.pull_once().await?;
        if let Some(expected) = step.get("request") {
            assert_recorded_request("pull", &self.remote.inner().last_pull, expected)?;
        }
        Ok(())
    }

    fn run_assert_step(&self, step: &Value) -> Result<(), ConformanceError> {
        if let Some(checks) = step.get("checks").and_then(|c| c.as_array()) {
            for check in checks {
                apply_check(&self.engine, check, self.checkpoint_before_pull.as_deref())?;
            }
        }
        Ok(())
    }
}

/// Apply one `local` step, honoring the D-corpus-soft-delete-and-refusal `expect_error` obligation: with it,
/// the engine MUST refuse the mutation with that error code and MUST leave the
/// outbox untouched (the row and its outbox entry are one transaction, so a
/// refusal that queued anything wrote half of it, lifecycle/004). Without it, a
/// refusal is a failure. Mirrors `runLocalStep` in
/// `packages/core/src/conformance/client-executor.ts`.
fn apply_local(
    engine: &SyncEngine,
    mutation: LocalMutation,
    expect_error: Option<&str>,
) -> Result<(), ConformanceError> {
    let Some(expected) = expect_error else {
        engine.apply(mutation)?;
        return Ok(());
    };

    let depth_before = engine.get_outbox_depth()?;
    match engine.apply(mutation) {
        Ok(()) => Err(ConformanceError::CheckFailed {
            check: "local",
            detail: format!(
                "local step was applied but the corpus pins a refusal with {expected} (D-corpus-soft-delete-and-refusal)"
            ),
        }),
        Err(error) => {
            let code = error.code();
            if code != expected {
                return Err(ConformanceError::CheckFailed {
                    check: "local",
                    detail: format!("local refusal code expected {expected} got {code}"),
                });
            }

            let depth_after = engine.get_outbox_depth()?;
            if depth_after == depth_before {
                Ok(())
            } else {
                Err(ConformanceError::CheckFailed {
                    check: "local",
                    detail: format!(
                        "refused local write moved the outbox from {depth_before} to {depth_after} (P:outbox-and-serial-in-flight)"
                    ),
                })
            }
        }
    }
}

const fn seed_server_step(_engine: &SyncEngine, _step: &Value) {
    // Server steps mutate the *reference server* in the full oracle. Our harness
    // uses the fixed `rpc` request/response pairs from the transcript, so the
    // client store must not be seeded here (rows arrive only via pull responses).
}

/// Drive the fault the transcript pins, like `injectFault` in
/// `packages/core/src/conformance/transport-client.ts`: prime the transport
/// fault, run the targeted call ONCE, and consume its expected error.
///
/// A pull fault is not decoration: it is what abandons the in-flight keyset, so
/// the next pull resumes from the durable checkpoint instead of the mid-sequence
/// page cursor (fencing/001, fencing/003). A push fault is the dropped
/// acknowledgement: the request IS sent and its bytes asserted, the server
/// applied it, and the response is lost, so the mutation must stay queued for the
/// transcript's next push step to replay verbatim (push/003). Either way the
/// in-flight call MUST fail: a call that survives means nothing was faulted.
async fn inject_fault(
    engine: &SyncEngine,
    remote: &TranscriptRemote,
    case: &str,
    step: &Value,
) -> Result<(), ConformanceError> {
    let fault = step.get("fault").and_then(Value::as_str).unwrap_or("fault");
    let target = step.get("target").and_then(Value::as_str).unwrap_or("");

    let survived = match target {
        "pull" => {
            remote.fail_next_pull(format!("transcript fault: {fault}"));
            engine.pull_once().await.is_ok()
        }
        "push" => {
            // Forget the previous request so the assertion below cannot pass by
            // re-checking an older one.
            *remote
                .inner()
                .last_push
                .lock()
                .map_err(|_| EngineError::remote("lock"))? = None;
            remote.fail_next_push(format!("transcript fault: {fault}"));
            engine.push_once().await.is_ok()
        }
        other => {
            return Err(ConformanceError::MalformedTranscript {
                path: case.to_string(),
                detail: format!("unknown fault target {other:?} (known: pull, push)"),
            });
        }
    };

    if survived {
        return Err(ConformanceError::CheckFailed {
            check: "fault",
            detail: format!("fault {fault} was primed on {target} but {target}_once succeeded"),
        });
    }

    if target == "push"
        && let Some(expected) = step.get("request")
    {
        assert_recorded_request("push", &remote.inner().last_push, expected)?;
    }
    Ok(())
}

/// What a push request pins for one mutation that the `local` step grammar does
/// not carry.
#[derive(Clone)]
struct PinnedMutation {
    precondition: Option<Map<String, Value>>,
    hlc: Option<String>,
}

/// `precondition` and origin `hlc` recovered by `mutation_id` from the push request
/// bytes, the same corpus-driven recovery as
/// [`atomic_batch_id_by_mutation_id`], mirroring `preconditionsByMutationId` and
/// `hlcsByMutationId` in `packages/core/src/conformance/client-executor.ts`. The
/// `local` step grammar carries neither field; the push request pins both
/// (push/004, push/005, conflict/003). Fault steps carry a batch request too
/// (drop-ack), so they are harvested as well.
fn pinned_by_mutation_id(steps: &[Value]) -> HashMap<String, PinnedMutation> {
    let mut map = HashMap::new();
    for step in steps {
        let kind = step.get("kind").and_then(Value::as_str);
        let is_push_request = kind == Some("fault")
            || (kind == Some("rpc") && step.get("rpc").and_then(Value::as_str) == Some("push"));
        if !is_push_request {
            continue;
        }
        for mutation in step
            .get("request")
            .and_then(|r| r.get("batch"))
            .and_then(|b| b.get("mutations"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let Some(id) = mutation.get("mutation_id").and_then(Value::as_str) else {
                continue;
            };
            let precondition = mutation
                .get("precondition")
                .and_then(Value::as_object)
                .cloned();
            let hlc = mutation
                .get("hlc")
                .and_then(Value::as_str)
                .filter(|h| !h.is_empty())
                .map(str::to_string);
            if precondition.is_none() && hlc.is_none() {
                continue;
            }
            map.insert(id.to_string(), PinnedMutation { precondition, hlc });
        }
    }
    map
}

/// Atomic grouping recovered from the request bytes, exactly like the TS
/// `client-executor`: a push step whose `request.batch.atomic` is true names one
/// atomic group, and its mutations share the batch id `atomic-<n>`. Without this
/// the local writes go out unbatched and a transcript's batch abort is a
/// protocol violation for the engine (push/005).
fn atomic_batch_id_by_mutation_id(steps: &[Value]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for step in steps {
        if step.get("kind").and_then(Value::as_str) != Some("rpc")
            || step.get("rpc").and_then(Value::as_str) != Some("push")
        {
            continue;
        }
        let Some(batch) = step.get("request").and_then(|r| r.get("batch")) else {
            continue;
        };
        if batch.get("atomic").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let n = step.get("n").and_then(Value::as_i64).unwrap_or(0);
        let batch_id = format!("atomic-{n}");
        for mutation in batch
            .get("mutations")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if let Some(id) = mutation.get("mutation_id").and_then(Value::as_str) {
                map.insert(id.to_string(), batch_id.clone());
            }
        }
    }
    map
}

/// Hold the engine's emitted request against the one the transcript recorded, so
/// the corpus is the oracle for the BYTES on the wire and not only for the state
/// they produce (P:protocol-is-the-product-the-corpus-is-the-arbiter).
///
/// EXACT: the canonicalized request must equal the golden, comparing the same
/// serialization production sends. A subset would hide an extra key the schemas
/// forbid, which is the divergence class this comparison exists to catch.
fn assert_emitted_request(
    rpc: &'static str,
    expected: &Value,
    emitted: Option<&Value>,
) -> Result<(), ConformanceError> {
    let Some(emitted) = emitted else {
        return Err(ConformanceError::RequestMismatch {
            rpc,
            detail: format!(
                "{rpc} step records a request but the engine emitted none: expected {expected}"
            ),
        });
    };
    compare_request(rpc, expected, emitted)
}

/// [`assert_emitted_request`] over the request `recorded` holds: the last one
/// the engine sent through the transcript remote.
fn assert_recorded_request<T: Serialize>(
    rpc: &'static str,
    recorded: &Mutex<Option<T>>,
    expected: &Value,
) -> Result<(), ConformanceError> {
    let emitted = recorded
        .lock()
        .map_err(|_| EngineError::remote("lock"))?
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|e| EngineError::remote(e.to_string()))?;
    assert_emitted_request(rpc, expected, emitted.as_ref())
}

fn compare_request(
    rpc: &'static str,
    expected: &Value,
    emitted: &Value,
) -> Result<(), ConformanceError> {
    diff_request(
        rpc,
        rpc,
        &canonical_request(expected),
        &canonical_request(emitted),
    )
}

/// Exact equality, reported at the first path that differs: an extra key, a
/// missing key, a different length and a different scalar are all divergences,
/// and naming the field beats dumping two whole requests at the reader.
fn diff_request(
    rpc: &'static str,
    path: &str,
    want: &Value,
    got: &Value,
) -> Result<(), ConformanceError> {
    match (want, got) {
        (Value::Object(expected), Value::Object(emitted)) => {
            for (key, value) in expected {
                let child = format!("{path}.{key}");
                let Some(have) = emitted.get(key) else {
                    return Err(ConformanceError::RequestMismatch {
                        rpc,
                        detail: format!("request {child}: expected {value}, emitted nothing"),
                    });
                };
                diff_request(rpc, &child, value, have)?;
            }
            for (key, value) in emitted {
                if !expected.contains_key(key) {
                    return Err(ConformanceError::RequestMismatch {
                        rpc,
                        detail: format!(
                            "request {path}.{key}: not in the transcript request, emitted {value}"
                        ),
                    });
                }
            }
            Ok(())
        }
        (Value::Array(expected), Value::Array(emitted)) => {
            if expected.len() != emitted.len() {
                return Err(ConformanceError::RequestMismatch {
                    rpc,
                    detail: format!(
                        "request {path}: expected {} entries, emitted {}",
                        expected.len(),
                        emitted.len()
                    ),
                });
            }
            for (index, (value, have)) in expected.iter().zip(emitted).enumerate() {
                diff_request(rpc, &format!("{path}[{index}]"), value, have)?;
            }
            Ok(())
        }
        _ => {
            if want == got {
                Ok(())
            } else {
                Err(request_mismatch(rpc, path, want, got))
            }
        }
    }
}

/// Both sides in the one shape that makes equality meaningful. Object keys already
/// sort themselves (a `serde_json` map is ordered), so the only normalization left
/// is the bucket list: the engine emits it in config order while the server treats
/// it as a set, so its order is not a wire contract.
fn canonical_request(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, child)| {
                    let canonical = if key == "buckets" {
                        canonical_buckets(child)
                    } else {
                        canonical_request(child)
                    };
                    (key.clone(), canonical)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(canonical_request).collect()),
        scalar => scalar.clone(),
    }
}

fn canonical_buckets(value: &Value) -> Value {
    let Some(items) = value.as_array() else {
        return canonical_request(value);
    };
    let mut buckets: Vec<Value> = items.iter().map(canonical_request).collect();
    buckets.sort_by_key(ToString::to_string);
    Value::Array(buckets)
}

/// Identity buckets this client was configured with: one owner-equality map per
/// table, from `context.user_id`. Probe pulls that name a different map are not
/// this client's `pull_once` (see `pull_is_client_identity`).
fn identity_buckets(t: &Transcript) -> Value {
    let buckets: Vec<Value> = t
        .context
        .server
        .tables
        .iter()
        .map(|(name, table)| {
            let mut params = Map::new();
            params.insert(table.bucket_column.clone(), json!(t.context.user_id));
            json!({ "table": name, "params": params })
        })
        .collect();
    Value::Array(buckets)
}

fn pull_is_client_identity(t: &Transcript, request: &Value) -> bool {
    let Some(want) = request.get("buckets").and_then(Value::as_array) else {
        return false;
    };
    let Some(got) = identity_buckets(t).as_array().cloned() else {
        return false;
    };
    if want.len() != got.len() {
        return false;
    }
    // Exact params equality: `{}` must not match `{ owner_id: <user> }` and drive
    // a probe pull.
    let mut matched = vec![false; got.len()];
    for bucket in want {
        let Some(index) = got.iter().enumerate().find_map(|(index, candidate)| {
            if !matched[index] && bucket == candidate {
                Some(index)
            } else {
                None
            }
        }) else {
            return false;
        };
        matched[index] = true;
    }
    true
}

fn request_mismatch(
    rpc: &'static str,
    path: &str,
    expected: &Value,
    emitted: &Value,
) -> ConformanceError {
    ConformanceError::RequestMismatch {
        rpc,
        detail: format!("request {path}: expected {expected}, emitted {emitted}"),
    }
}

/// The page size this client was configured with, recovered from the corpus: the
/// FIRST pull request that pins `limit` is that setup (pull/002 forces keyset
/// pagination with 2; every other case omits it and so configures none, which
/// keeps `limit` off the wire the same way the goldens do).
/// Mirrors `firstPullLimit` in `packages/core/src/conformance/client-executor.ts`.
fn first_pull_limit(steps: &[Value]) -> Option<i64> {
    for step in steps {
        if step.get("kind").and_then(Value::as_str) != Some("rpc")
            || step.get("rpc").and_then(Value::as_str) != Some("pull")
        {
            continue;
        }
        if let Some(limit) = step
            .get("request")
            .and_then(|r| r.get("limit"))
            .and_then(Value::as_i64)
        {
            return Some(limit);
        }
    }
    None
}

fn first_pull_cursor(steps: &[Value]) -> Option<&str> {
    for step in steps {
        if step.get("kind").and_then(|k| k.as_str()) == Some("rpc")
            && step.get("rpc").and_then(|r| r.as_str()) == Some("pull")
        {
            return step
                .get("request")
                .and_then(|r| r.get("cursor"))
                .and_then(|c| c.as_str());
        }
    }
    None
}

fn apply_check(
    engine: &SyncEngine,
    check: &Value,
    checkpoint_before_pull: Option<&str>,
) -> Result<(), ConformanceError> {
    let kind = check.get("check").and_then(|c| c.as_str()).unwrap_or("");
    match kind {
        "outbox-depth" => check_outbox_depth(engine, check),
        "cursor" => check_cursor(engine, check),
        "local-row" => check_local_row(engine, check),
        "no-intermediate-commit" => check_no_intermediate_commit(engine, checkpoint_before_pull),
        "event" => check_event(engine, check),
        other => Err(ConformanceError::UnknownCheck {
            check: other.to_string(),
        }),
    }
}

fn check_outbox_depth(engine: &SyncEngine, check: &Value) -> Result<(), ConformanceError> {
    let expected = check
        .get("value")
        .and_then(Value::as_u64)
        .and_then(|v| usize::try_from(v).ok())
        .unwrap_or(0);
    let got = engine.get_outbox_depth()?;
    if got != expected {
        return Err(ConformanceError::CheckFailed {
            check: "outbox-depth",
            detail: format!("outbox-depth expected {expected} got {got}"),
        });
    }

    Ok(())
}

fn check_cursor(engine: &SyncEngine, check: &Value) -> Result<(), ConformanceError> {
    let expected = check.get("value").and_then(|v| v.as_str()).unwrap_or("0");
    let got = engine.get_checkpoint()?;
    if got != expected {
        return Err(ConformanceError::CheckFailed {
            check: "cursor",
            detail: format!("cursor expected {expected} got {got}"),
        });
    }

    Ok(())
}

fn check_local_row(engine: &SyncEngine, check: &Value) -> Result<(), ConformanceError> {
    let table = check.get("table").and_then(|t| t.as_str()).unwrap_or("");
    let pk = check.get("pk").and_then(|t| t.as_str()).unwrap_or("");
    let expected = check.get("row").cloned().unwrap_or(Value::Null);
    // Match on the store pk, not `columns.id`: wire rows omit `id` and
    // the TS harness reads by `(table, pk)` the same way.
    let rows = engine.read_local_rows(table)?;
    let found = rows.iter().find(|r| r.pk == pk);
    if expected.is_null() {
        if found.is_some() {
            return Err(ConformanceError::CheckFailed {
                check: "local-row",
                detail: format!("local-row expected absent {table}/{pk}"),
            });
        }
        return Ok(());
    }

    let Some(row) = found else {
        return Err(ConformanceError::CheckFailed {
            check: "local-row",
            detail: format!("local-row missing {table}/{pk}"),
        });
    };
    check_row_equal(&row.columns, &expected)
}

fn check_event(engine: &SyncEngine, check: &Value) -> Result<(), ConformanceError> {
    let Some(expected) = check
        .get("value")
        .or_else(|| check.get("event"))
        .and_then(Value::as_str)
    else {
        return Err(ConformanceError::CheckFailed {
            check: "event",
            detail: "event check needs a string `value` (or `event`)".to_string(),
        });
    };

    // At-least-once since the engine was created: the ring covers the whole
    // transcript because the engine is built per transcript run.
    let seen = engine.recent_event_names();
    if !seen.iter().any(|n| n == expected) {
        return Err(ConformanceError::CheckFailed {
            check: "event",
            detail: format!("event {expected} never emitted (saw {seen:?})"),
        });
    }

    Ok(())
}

/// The staged-page fence: a pull that left `has_more` open stages its rows and
/// commits nothing, so the durable checkpoint must still hold the value the pull
/// started from (pull/002, fencing/001, fencing/003).
fn check_no_intermediate_commit(
    engine: &SyncEngine,
    checkpoint_before_pull: Option<&str>,
) -> Result<(), ConformanceError> {
    let Some(expected) = checkpoint_before_pull else {
        return Err(ConformanceError::CheckFailed {
            check: "no-intermediate-commit",
            detail: "no-intermediate-commit has no replayed pull step before it to fence"
                .to_string(),
        });
    };

    let got = engine.get_checkpoint()?;
    if got == expected {
        Ok(())
    } else {
        Err(ConformanceError::CheckFailed {
            check: "no-intermediate-commit",
            detail: format!(
                "intermediate commit: checkpoint {got} advanced past {expected} while has_more was open"
            ),
        })
    }
}

/// The corpus pins a `local-row` column map EXACTLY, so an extra stored column is
/// a divergence like any wrong value: a subset check would let the engine persist
/// bookkeeping the transcript never recorded (the corpus is the oracle).
fn check_row_equal(row: &Map<String, Value>, expected: &Value) -> Result<(), ConformanceError> {
    let Some(exp) = expected.as_object() else {
        return Err(ConformanceError::CheckFailed {
            check: "local-row",
            detail: "local-row check needs an object value".to_string(),
        });
    };
    for (k, v) in exp {
        let got = row.get(k).cloned().unwrap_or(Value::Null);
        if &got != v {
            return Err(ConformanceError::CheckFailed {
                check: "local-row",
                detail: format!("local-row field {k}: expected {v} got {got}"),
            });
        }
    }
    for k in row.keys() {
        if !exp.contains_key(k) {
            return Err(ConformanceError::CheckFailed {
                check: "local-row",
                detail: format!(
                    "local-row field {k}: not in the transcript row, stored {}",
                    row[k]
                ),
            });
        }
    }
    Ok(())
}

/// What one corpus replay produced.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CorpusSummary {
    /// Cases that replayed to the end without a divergence.
    pub passed: usize,
    /// Cases that diverged from their transcript.
    pub failed: usize,
    /// Pull steps skipped across the cases that replayed to the end, the ones
    /// whose recorded request is not this client's identity pull.
    pub skipped_steps: usize,
    /// One message per diverging case, prefixed with the case id.
    pub failures: Vec<String>,
}

/// Replay every executable case in the corpus. A diverging case counts as a
/// failure rather than aborting the run.
///
/// # Errors
///
/// Returns the manifest read or parse failure; a transcript that diverges is
/// reported in [`CorpusSummary::failures`], not as an error.
pub async fn run_all_non_blocked(repo_root: &Path) -> Result<CorpusSummary, String> {
    let manifest = repo_root.join("packages/protocol/cases/manifest.json");
    let cases = non_blocked_cases(&manifest)?;

    let mut summary = CorpusSummary::default();
    for (id, path) in cases {
        match run_transcript_file(&path).await {
            Ok(skipped) => {
                summary.passed += 1;
                summary.skipped_steps += skipped;
            }
            Err(e) => {
                summary.failed += 1;
                summary.failures.push(format!("{id}: {e}"));
            }
        }
    }

    Ok(summary)
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// Every transcript declares one bucket, so the corpus never exercises the
    /// sort. Two buckets in opposite orders must canonicalize to the same value,
    /// since the server treats the list as a set.
    #[test]
    fn canonical_buckets_sorts_the_list() {
        let todos = json!({ "table": "todos", "params": { "owner_id": "u1" } });
        let notes = json!({ "table": "notes", "params": { "owner_id": "u1" } });
        let one = json!({ "buckets": [todos.clone(), notes.clone()] });
        let other = json!({ "buckets": [notes, todos] });

        assert_eq!(canonical_request(&one), canonical_request(&other));
        compare_request("pull", &one, &other).expect("bucket order is not a wire contract");

        let sorted = canonical_request(&one);
        let tables: Vec<&str> = sorted["buckets"]
            .as_array()
            .expect("buckets")
            .iter()
            .filter_map(|bucket| bucket["table"].as_str())
            .collect();
        assert_eq!(tables, vec!["notes", "todos"]);
    }

    /// The set rule covers order only: a bucket the engine never emitted is still
    /// a divergence.
    #[test]
    fn a_different_bucket_still_fails() {
        let one = json!({ "buckets": [{ "table": "todos", "params": {} }] });
        let other = json!({ "buckets": [{ "table": "notes", "params": {} }] });
        compare_request("pull", &one, &other).expect_err("a different table is a mismatch");
    }

    #[tokio::test]
    async fn push_001_insert_applied() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/protocol/transcripts/push/001-insert-applied.json");
        let skipped = run_transcript_file(&path).await.expect("push/001");
        assert_eq!(skipped, 0, "every pull step in push/001 is replayed");
    }

    fn transcript_with(steps: &Value) -> Transcript {
        let mut tables = HashMap::new();
        tables.insert(
            "todos".to_string(),
            ServerTable {
                bucket_column: "owner_id".into(),
                soft_delete_column: None,
                conflict_mode: ConflictMode::Arrival,
            },
        );
        Transcript {
            case: "synthetic".into(),
            context: TranscriptContext {
                client_id: "c1".into(),
                schema_version: 1,
                user_id: "u1".into(),
                server: ServerContext { tables },
            },
            steps: steps.as_array().cloned().unwrap_or_default(),
            postconditions: vec![],
        }
    }

    #[tokio::test]
    async fn unknown_step_kind_fails_loud() {
        let t = transcript_with(&json!([{ "kind": "teleport" }]));
        let err = run_transcript(&t).await.expect_err("must reject");
        assert!(
            matches!(err, ConformanceError::UnknownStepKind { ref kind } if kind == "teleport"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn unknown_local_op_fails_loud() {
        let t = transcript_with(&json!([
            {
                "kind": "local",
                "table": "todos",
                "pk": "p1",
                "op": "teleport",
                "mutation_id": "m1",
                "columns": { "title": "hi", "owner_id": "u1" }
            }
        ]));
        let err = run_transcript(&t).await.expect_err("must reject");
        assert!(
            matches!(err, ConformanceError::MalformedTranscript { .. }),
            "{err}"
        );
    }

    /// A local insert of `m1` whose push step records a golden request for `m2`.
    fn mismatched_push_transcript() -> Transcript {
        transcript_with(&json!([
            {
                "kind": "local",
                "table": "todos",
                "pk": "p1",
                "op": "insert",
                "mutation_id": "m1",
                "columns": { "title": "hi", "owner_id": "u1" }
            },
            {
                "kind": "rpc",
                "rpc": "push",
                "request": {
                    "batch": {
                        "atomic": false,
                        "mutations": [
                            { "mutation_id": "m2", "op": "insert", "pk": "p1", "table": "todos" }
                        ]
                    }
                }
            }
        ]))
    }

    /// A harness divergence (the emitted request differs from the golden bytes)
    /// must not be reported as [`EngineError::remote`]'s retryable transport
    /// fault: `EngineError::remote` keeps a queued write in flight, which would
    /// hide a corpus mismatch as a condition a caller could just retry away.
    #[tokio::test]
    async fn a_harness_divergence_is_not_an_engine_remote_fault() {
        let t = mismatched_push_transcript();
        let err = run_transcript(&t).await.expect_err("must reject");
        assert!(
            matches!(err, ConformanceError::RequestMismatch { .. }),
            "{err}"
        );
    }

    #[tokio::test]
    async fn emitted_push_request_must_match_the_transcript() {
        let t = mismatched_push_transcript();
        let err = run_transcript(&t).await.expect_err("must reject");
        let ConformanceError::RequestMismatch { rpc, detail } = &err else {
            panic!("{err}");
        };
        assert_eq!(*rpc, "push");
        assert!(
            detail.contains("request push.batch.mutations[0].mutation_id"),
            "{detail}"
        );
    }

    #[tokio::test]
    async fn unknown_check_fails_loud() {
        let t = transcript_with(&json!([
            { "kind": "assert", "checks": [{ "check": "vibes" }] }
        ]));
        let err = run_transcript(&t).await.expect_err("must reject");
        assert!(
            matches!(err, ConformanceError::UnknownCheck { ref check } if check == "vibes"),
            "{err}"
        );
    }

    /// A page that commits while `has_more` is open is the divergence the check
    /// names, so the harness must report it instead of passing.
    #[tokio::test]
    async fn no_intermediate_commit_fails_when_the_checkpoint_advanced() {
        let t = transcript_with(&json!([
            {
                "kind": "rpc",
                "rpc": "pull",
                "response": { "cursor": "5", "has_more": false, "rows": [], "tombstones": [] }
            },
            { "kind": "assert", "checks": [{ "check": "no-intermediate-commit" }] }
        ]));
        let err = run_transcript(&t).await.expect_err("must reject");
        let ConformanceError::CheckFailed { check, detail } = &err else {
            panic!("{err}");
        };
        assert_eq!(*check, "no-intermediate-commit");
        assert!(detail.contains("checkpoint 5 advanced past 0"), "{detail}");
    }

    #[test]
    fn local_row_check_rejects_a_non_object_expectation() {
        let err = check_row_equal(&Map::new(), &json!(42)).expect_err("must reject");
        assert!(
            matches!(
                err,
                ConformanceError::CheckFailed {
                    check: "local-row",
                    ..
                }
            ),
            "{err}"
        );
    }

    #[tokio::test]
    async fn event_check_fails_when_never_emitted() {
        let t = transcript_with(&json!([
            { "kind": "assert", "checks": [{ "check": "event", "event": "RESET_REQUIRED" }] }
        ]));
        let err = run_transcript(&t).await.expect_err("must reject");
        assert!(
            matches!(err, ConformanceError::CheckFailed { check: "event", .. }),
            "{err}"
        );
    }

    #[tokio::test]
    async fn event_check_passes_once_emitted() {
        let t = transcript_with(&json!([
            {
                "kind": "local",
                "table": "todos",
                "pk": "p1",
                "op": "insert",
                "mutation_id": "m1",
                "columns": { "title": "hi", "owner_id": "u1" }
            },
            { "kind": "assert", "checks": [{ "check": "event", "event": "LOCAL_CHANGED" }] }
        ]));
        let skipped = run_transcript(&t).await.expect("local change is observed");
        assert_eq!(skipped, 0, "the transcript carries no pull step to skip");
    }
}
