//! `ProtocolRemote` over the fenced `kizunasync.pull` / `kizunasync.push` RPCs.
//!
//! The Rust twin of `packages/supabase/src/rpc-remote.ts`: it forwards the
//! engine's request envelope straight to `PostgREST`, which answers the whole
//! fenced transaction. Argument names mirror the SQL signatures 1:1
//! (`pull(buckets, cursor, schema_version, limit, client_id)`,
//! `push(batch, last_mutation_id, schema_version, client_id)`, migration 0001),
//! and an argument the request leaves unset is omitted so the SQL default
//! applies.

use async_trait::async_trait;
use kizunasync_engine::{EngineError, ProtocolRemote};
use kizunasync_protocol::{ColumnValues, PullRequest, PullResponse, PushRequest, PushResponse};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use crate::auth::{AUTH_SESSION_MISSING, AccessToken, missing_session, supabase_http_headers};
use crate::transport::{
    HttpMethod, HttpRequest, HttpResponse, HttpTransport, ReqwestTransport, require_secure_url,
};

/// The Postgres schema every server-side kizunasync object lives under
/// (`SCHEMA` in `packages/core/src/constants.ts`).
pub const DEFAULT_SCHEMA: &str = "kizunasync";

/// Everything [`HttpProtocolRemote`] needs to reach one Supabase project. Its
/// `Debug` output leaves the key and the token out.
#[derive(Clone)]
pub struct RemoteConfig {
    /// Project URL, e.g. `https://abc.supabase.co` (no trailing `/rest/v1`).
    pub base_url: String,
    /// The project's publishable key; sent as `apikey` on every call.
    pub publishable_key: String,
    /// The signed-in user's JWT. Pull/push require this: `kizunasync` RPCs are
    /// `GRANT … TO authenticated`, and a missing token must not fall back to the
    /// publishable key as Bearer (that is the 42501 / role-`anon` stall).
    pub access_token: Option<String>,
    /// `PostgREST` schema profile; the RPCs do not live in `public`.
    pub schema: String,
    /// Device-only columns the server has no slot for (e.g. `local_image_uri`).
    /// Stripped from every mutation's columns before push. The server's
    /// `_apply_upsert` would fail on an unknown column. Pull is unaffected.
    pub local_only_columns: Vec<String>,
}

impl RemoteConfig {
    /// A config with [`DEFAULT_SCHEMA`], no access token, and no local-only
    /// columns. Chain the `with_*` builders to fill in the rest.
    pub fn new(base_url: impl Into<String>, publishable_key: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            publishable_key: publishable_key.into(),
            access_token: None,
            schema: DEFAULT_SCHEMA.to_string(),
            local_only_columns: Vec::new(),
        }
    }

    /// Sets the signed-in user's JWT.
    #[must_use]
    pub fn with_access_token(mut self, token: impl Into<String>) -> Self {
        self.access_token = Some(token.into());
        self
    }

    /// Overrides the `PostgREST` schema profile (default [`DEFAULT_SCHEMA`]).
    #[must_use]
    pub fn with_schema(mut self, schema: impl Into<String>) -> Self {
        self.schema = schema.into();
        self
    }

    /// Names the device-only columns to strip from every mutation before push.
    #[must_use]
    pub fn with_local_only_columns<I, S>(mut self, columns: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.local_only_columns = columns.into_iter().map(Into::into).collect();
        self
    }
}

impl fmt::Debug for RemoteConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteConfig")
            .field("base_url", &self.base_url)
            .field("publishable_key", &"<redacted>")
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "<redacted>"),
            )
            .field("schema", &self.schema)
            .field("local_only_columns", &self.local_only_columns)
            .finish()
    }
}

/// The `{ message, code, … }` envelope `PostgREST` answers a failed RPC with.
#[derive(Debug, Deserialize)]
struct PostgrestError {
    message: Option<String>,
    /// SQLSTATE for a database fault, `PGRST…` for a `PostgREST`-level one.
    code: Option<String>,
}

/// A Postgres data/constraint/syntax fault (SQLSTATE class 22/23/42) means the
/// REQUEST is bad, so a replay can only fail again. Exact code `P0001` is the
/// same: it's Postgres's own default for an un-coded `raise exception` in a
/// user trigger, still a definitive server rejection, so it must dead-letter
/// rather than retry forever. Exact code `0A000` is the same: the pack raises
/// it for a non-conforming client (a mutation missing its HLC, or a table
/// with no sync config), so a replay can only fail again: exact code, not
/// the whole 0A class. Other P0xxx codes (e.g. `P0002`, a named PL/pgSQL
/// condition) stay retryable. Only the bare default is permanent.
/// The pack's own push-policy codes `KZP01` (a mutation against a pull-only
/// table) and `KZP02` (a batch over `max_batch_size`) are definitive server
/// rejections of the request as sent, so they dead-letter instead of retrying
/// forever. `KZP03` (`require_atomic`) stays retryable: the current client
/// sends ordinary writes as non-atomic, so treating KZP03 as permanent would
/// empty the outbox. `KZL01` is the pull-policy code for a bucketed table
/// pulled without its bucket column, definitive because a replay of the same
/// request fails the same way.
/// SQLSTATE `42501` (`insufficient_privilege`) is carved out of class 42: on
/// pull/push the pack turns row RLS into a 200 `RLS_DENIED` verdict, so an
/// HTTP 42501 is GRANT EXECUTE / role `anon` / a missing JWT, environmental,
/// never a row refusal. Everything else: network loss, 5xx, an expired JWT
/// (`PGRST301`), a schema-not-exposed config error (`PGRST106`), is
/// transient/environmental and must keep the write queued. Mirrors
/// `remoteError` in `packages/supabase/src/rpc-remote.ts`.
fn is_permanent(code: Option<&str>) -> bool {
    match code {
        Some("42501") | None => false,
        Some(code) => {
            code.starts_with("22")
                || code.starts_with("23")
                || code.starts_with("42")
                || code == "P0001"
                || code == "0A000"
                || POLICY_CODES.contains(&code)
        }
    }
}

/// The pack's policy SQLSTATEs, raised before any work is done: the push guards
/// `kizunasync.push` runs before a mutation is processed, and the pull guard
/// `kizunasync.pull` runs before a page is assembled (`0001_kizuna_init.sql`).
const POLICY_CODES: [&str; 3] = ["KZP01", "KZP02", "KZL01"];

fn classify(prefix: &str, response: &HttpResponse) -> EngineError {
    let payload = serde_json::from_slice::<PostgrestError>(&response.body).ok();
    let code = payload.as_ref().and_then(|e| e.code.clone());
    let message = payload
        .and_then(|e| e.message)
        .unwrap_or_else(|| match response.text() {
            body if body.is_empty() => format!("HTTP {}", response.status),
            body => format!("HTTP {}: {body}", response.status),
        });
    let message = format!("{prefix}: {message}");
    if is_permanent(code.as_deref()) {
        EngineError::permanent_remote(message)
    } else {
        EngineError::remote(message)
    }
    .with_code(code)
}

/// [`ProtocolRemote`] over the fenced `kizunasync.pull` / `kizunasync.push`
/// `PostgREST` RPCs.
pub struct HttpProtocolRemote {
    config: RemoteConfig,
    access_token: AccessToken,
    transport: Arc<dyn HttpTransport>,
    local_only: HashSet<String>,
}

impl HttpProtocolRemote {
    /// Bind to a live project over `reqwest`.
    ///
    /// # Errors
    /// [`crate::HttpError::Config`] when `base_url` is not `https` (plain
    /// `http` is accepted on a loopback host only), or an error when the HTTP
    /// client cannot be built (TLS backend initialisation).
    pub fn new(config: RemoteConfig) -> Result<Self, crate::transport::HttpError> {
        require_secure_url(&config.base_url, "remote.url")?;
        let transport = Arc::new(ReqwestTransport::new()?);
        Ok(Self::with_transport(config, transport))
    }

    /// Bind to an injected transport (tests, or a host-supplied HTTP stack).
    /// The URL rule of [`Self::new`] is the injector's to enforce.
    #[must_use]
    pub fn with_transport(config: RemoteConfig, transport: Arc<dyn HttpTransport>) -> Self {
        let local_only = config.local_only_columns.iter().cloned().collect();
        let access_token = AccessToken::new(config.access_token.clone());
        Self {
            config,
            access_token,
            transport,
            local_only,
        }
    }

    fn require_user_bearer(&self) -> Result<String, EngineError> {
        self.access_token.get().ok_or_else(|| {
            EngineError::remote(missing_session("refresh the JWT before pull/push"))
                .with_code(Some(AUTH_SESSION_MISSING.to_string()))
        })
    }

    fn rpc_url(&self, function: &str) -> String {
        format!(
            "{}/rest/v1/rpc/{function}",
            self.config.base_url.trim_end_matches('/')
        )
    }

    /// POST the RPC arguments and return the raw JSON the fenced transaction
    /// answered with.
    async fn call(&self, function: &str, args: &Value) -> Result<Value, EngineError> {
        let prefix = format!("{}.{function} failed", self.config.schema);
        let bearer = self.require_user_bearer()?;
        let mut headers =
            supabase_http_headers(&bearer, Some(self.config.publishable_key.as_str()));
        headers.extend([
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "application/json".into()),
            // PostgREST switches schema per request; writes read Content-Profile
            // (postgrest-js does the same for every non-GET).
            ("Content-Profile".into(), self.config.schema.clone()),
        ]);
        let request = HttpRequest {
            method: HttpMethod::Post,
            url: self.rpc_url(function),
            headers,
            body: serde_json::to_vec(args)?,
            timeout: None,
        };

        let response = self
            .transport
            .execute(request)
            .await
            // No response at all is transport, never permanent.
            .map_err(|e| EngineError::remote(format!("{prefix}: {e}")))?;

        if !response.is_success() {
            return Err(classify(&prefix, &response));
        }

        Ok(serde_json::from_slice(&response.body)?)
    }

    fn strip_local_columns(&self, columns: &ColumnValues) -> ColumnValues {
        if self.local_only.is_empty() {
            return columns.clone();
        }
        columns
            .iter()
            .filter(|(key, _)| !self.local_only.contains(*key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }
}

#[async_trait]
impl ProtocolRemote for HttpProtocolRemote {
    /// The request struct IS the wire body: every key it serializes is an
    /// argument name of the SQL function, because `PostgREST` rejects an unknown
    /// argument outright. `limit` is skipped when unset so the SQL default
    /// applies, and `client_id` when unset so the server falls back to the JWT
    /// `session_id` claim (D-client-identity).
    async fn pull(&self, req: PullRequest) -> Result<PullResponse, EngineError> {
        let args = serde_json::to_value(&req)?;
        let data = self.call("pull", &args).await?;
        Ok(serde_json::from_value(data)?)
    }

    /// Same envelope rule as [`Self::pull`], after masking the columns the app
    /// declared local-only: those never leave the device.
    async fn push(&self, req: PushRequest) -> Result<PushResponse, EngineError> {
        let mut wire = req;
        for mutation in &mut wire.batch.mutations {
            mutation.columns = self.strip_local_columns(&mutation.columns);
        }
        let args = serde_json::to_value(&wire)?;
        let data = self.call("push", &args).await?;
        Ok(serde_json::from_value(data)?)
    }

    fn set_access_token(&self, token: Option<String>) {
        self.access_token.set(token);
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::transport::{FakeTransport, json_response};
    use kizunasync_protocol::{Bucket, Mutation, Op, PushBatch};
    use serde_json::{Map, json};

    /// UUID placeholder grammar, kind code `c1`: the client identity a request
    /// carries under D-client-identity.
    const CLIENT_ID: &str = "00000000-0000-4000-8000-c10000000001";

    fn config() -> RemoteConfig {
        RemoteConfig::new("https://abc.supabase.co/", "pub-key")
    }

    /// Pull the transport code out of a `Remote` error, or `None` for any
    /// other variant.
    fn remote_code(error: &EngineError) -> Option<String> {
        match error {
            EngineError::Remote { code, .. } => code.clone(),
            _ => None,
        }
    }

    fn remote_answering(response: HttpResponse) -> (HttpProtocolRemote, Arc<FakeTransport>) {
        let transport = Arc::new(FakeTransport::new(move |_| Ok(response.clone())));
        let remote = HttpProtocolRemote::with_transport(config(), transport.clone());
        remote.set_access_token(Some("user-jwt".into()));
        (remote, transport)
    }

    fn pull_request() -> PullRequest {
        let mut params = Map::new();
        params.insert("owner_id".into(), json!("user-a"));
        PullRequest {
            client_id: Some(CLIENT_ID.into()),
            schema_version: 1,
            cursor: "7".into(),
            limit: Some(500),
            buckets: vec![Bucket {
                table: "todos".into(),
                params,
            }],
        }
    }

    fn push_request(columns: ColumnValues) -> PushRequest {
        PushRequest {
            client_id: Some(CLIENT_ID.into()),
            schema_version: 1,
            batch: PushBatch {
                atomic: false,
                mutations: vec![Mutation {
                    mutation_id: "m1".into(),
                    table: "todos".into(),
                    pk: "p1".into(),
                    op: Op::Insert,
                    columns,
                    transforms: None,
                    precondition: None,
                    hlc: None,
                }],
            },
            last_mutation_id: None,
        }
    }

    #[tokio::test]
    async fn pull_posts_the_sql_argument_envelope() {
        let (remote, transport) = remote_answering(json_response(
            200,
            r#"{"cursor":"9","has_more":false,"rows":[],"tombstones":[]}"#,
        ));

        let response = remote.pull(pull_request()).await.expect("pull");
        assert_eq!(response.cursor, "9");

        let requests = transport.requests();
        assert_eq!(requests.len(), 1);

        let request = &requests[0];
        assert_eq!(request.method, HttpMethod::Post);
        assert_eq!(request.url, "https://abc.supabase.co/rest/v1/rpc/pull");
        assert_eq!(request.header("apikey"), Some("pub-key"));
        assert_eq!(request.header("Authorization"), Some("Bearer user-jwt"));
        assert_eq!(request.header("Content-Type"), Some("application/json"));
        assert_eq!(request.header("Content-Profile"), Some("kizunasync"));

        let body: Value = serde_json::from_slice(&request.body).expect("json body");
        assert_eq!(
            body,
            json!({
                "buckets": [{ "table": "todos", "params": { "owner_id": "user-a" } }],
                "client_id": CLIENT_ID,
                "cursor": "7",
                "schema_version": 1,
                "limit": 500,
            })
        );
    }

    /// A client that carries no identity leaves the key out of the body entirely
    /// rather than sending null, so the server falls back to the JWT
    /// `session_id` claim (D-client-identity).
    #[tokio::test]
    async fn client_id_is_absent_when_unset_and_present_when_set() {
        let (remote, transport) = remote_answering(json_response(
            200,
            r#"{"cursor":"9","has_more":false,"rows":[],"tombstones":[]}"#,
        ));

        let mut anonymous = pull_request();
        anonymous.client_id = None;
        remote
            .pull(anonymous)
            .await
            .expect("pull without an identity");
        let body: Value = serde_json::from_slice(&transport.requests()[0].body).expect("json body");
        assert!(body.get("client_id").is_none());

        let (remote, transport) = remote_answering(json_response(200, r#"{"verdicts":[]}"#));
        remote.push(push_request(Map::new())).await.expect("push");
        let body: Value = serde_json::from_slice(&transport.requests()[0].body).expect("json body");
        assert_eq!(body.get("client_id"), Some(&json!(CLIENT_ID)));
    }

    /// An unset page size leaves `limit` out of the body entirely rather than
    /// sending null, so the SQL default is what applies.
    #[tokio::test]
    async fn limit_is_absent_when_unset_and_present_when_set() {
        let (remote, transport) = remote_answering(json_response(
            200,
            r#"{"cursor":"9","has_more":false,"rows":[],"tombstones":[]}"#,
        ));

        let mut unset = pull_request();
        unset.limit = None;
        remote.pull(unset).await.expect("pull without a limit");
        let body: Value = serde_json::from_slice(&transport.requests()[0].body).expect("json body");
        assert!(body.get("limit").is_none());

        let (remote, transport) = remote_answering(json_response(
            200,
            r#"{"cursor":"9","has_more":false,"rows":[],"tombstones":[]}"#,
        ));
        remote
            .pull(pull_request())
            .await
            .expect("pull with a limit");
        let body: Value = serde_json::from_slice(&transport.requests()[0].body).expect("json body");
        assert_eq!(body.get("limit"), Some(&json!(500)));
    }

    #[tokio::test]
    async fn an_access_token_is_bearer_and_the_publishable_key_stays_apikey() {
        let transport = Arc::new(FakeTransport::new(|_| {
            Ok(json_response(
                200,
                r#"{"cursor":"0","has_more":false,"rows":[],"tombstones":[]}"#,
            ))
        }));
        let remote = HttpProtocolRemote::with_transport(
            config().with_access_token("user-jwt"),
            transport.clone(),
        );

        remote.pull(pull_request()).await.expect("pull");

        let requests = transport.requests();
        assert_eq!(requests[0].header("Authorization"), Some("Bearer user-jwt"));
        // apikey stays the project key even when a user JWT is present.
        assert_eq!(requests[0].header("apikey"), Some("pub-key"));
    }

    #[tokio::test]
    async fn missing_access_token_does_not_call_the_transport() {
        let transport = Arc::new(FakeTransport::new(|_| {
            panic!("pull/push must not hit PostgREST without a user JWT");
        }));
        let remote = HttpProtocolRemote::with_transport(config(), transport);
        let error = remote.pull(pull_request()).await.expect_err("no session");
        assert!(error.is_budget_exempt());
        assert_eq!(
            remote_code(&error),
            Some("AUTH_SESSION_MISSING".to_string())
        );
    }

    #[tokio::test]
    async fn set_access_token_replaces_the_bearer_on_the_next_call() {
        let transport = Arc::new(FakeTransport::new(|_| {
            Ok(json_response(
                200,
                r#"{"cursor":"0","has_more":false,"rows":[],"tombstones":[]}"#,
            ))
        }));
        let remote = HttpProtocolRemote::with_transport(config(), transport.clone());
        let missing = remote.pull(pull_request()).await.expect_err("no session");
        assert!(missing.is_budget_exempt());
        assert_eq!(
            remote_code(&missing),
            Some("AUTH_SESSION_MISSING".to_string())
        );

        remote.set_access_token(Some("jwt-1".into()));
        remote.pull(pull_request()).await.expect("jwt-1");
        remote.set_access_token(Some("jwt-2".into()));
        remote.pull(pull_request()).await.expect("jwt-2");
        remote.set_access_token(None);
        let missing_again = remote.pull(pull_request()).await.expect_err("cleared");
        assert_eq!(
            remote_code(&missing_again),
            Some("AUTH_SESSION_MISSING".to_string())
        );

        let requests = transport.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].header("Authorization"), Some("Bearer jwt-1"));
        assert_eq!(requests[1].header("Authorization"), Some("Bearer jwt-2"));
        assert!(
            requests
                .iter()
                .all(|r| r.header("apikey") == Some("pub-key"))
        );
    }

    #[tokio::test]
    async fn set_access_token_replaces_the_bearer_on_the_next_push() {
        let transport = Arc::new(FakeTransport::new(|_| {
            Ok(json_response(200, r#"{"verdicts":[]}"#))
        }));
        let remote = HttpProtocolRemote::with_transport(config(), transport.clone());
        remote.set_access_token(Some("jwt-push".into()));
        remote.push(push_request(Map::new())).await.expect("push");
        assert_eq!(
            transport.requests()[0].header("Authorization"),
            Some("Bearer jwt-push")
        );
        assert_eq!(transport.requests()[0].header("apikey"), Some("pub-key"));
    }

    #[tokio::test]
    async fn a_push_posts_the_whole_batch_envelope_to_the_push_rpc_url() {
        let (remote, transport) = remote_answering(json_response(200, r#"{"verdicts":[]}"#));

        let mut columns = Map::new();
        columns.insert("title".into(), json!("hi"));
        remote.push(push_request(columns)).await.expect("push");

        let requests = transport.requests();
        assert_eq!(requests[0].url, "https://abc.supabase.co/rest/v1/rpc/push");
        let body: Value = serde_json::from_slice(&requests[0].body).expect("json body");
        assert_eq!(
            body,
            json!({
                "batch": {
                    "atomic": false,
                    "mutations": [{
                        "mutation_id": "m1",
                        "table": "todos",
                        "pk": "p1",
                        "op": "insert",
                        "columns": { "title": "hi" },
                    }],
                },
                "client_id": CLIENT_ID,
                "last_mutation_id": null,
                "schema_version": 1,
            })
        );
    }

    #[tokio::test]
    async fn push_strips_device_only_columns() {
        let transport = Arc::new(FakeTransport::new(|_| {
            Ok(json_response(200, r#"{"verdicts":[]}"#))
        }));
        let remote = HttpProtocolRemote::with_transport(
            config().with_local_only_columns(["local_image_uri"]),
            transport.clone(),
        );
        remote.set_access_token(Some("user-jwt".into()));

        let mut columns = Map::new();
        columns.insert("title".into(), json!("hi"));
        columns.insert("local_image_uri".into(), json!("file:///tmp/x.png"));
        remote.push(push_request(columns)).await.expect("push");

        let body: Value = serde_json::from_slice(&transport.requests()[0].body).expect("json");
        assert_eq!(
            body["batch"]["mutations"][0]["columns"],
            json!({ "title": "hi" })
        );
    }

    async fn push_error(status: u16, body: &str) -> EngineError {
        let (remote, _) = remote_answering(json_response(status, body));
        remote
            .push(push_request(Map::new()))
            .await
            .expect_err("push should fail")
    }

    async fn pull_error(status: u16, body: &str) -> EngineError {
        let (remote, _) = remote_answering(json_response(status, body));
        remote
            .pull(pull_request())
            .await
            .expect_err("pull should fail")
    }

    #[tokio::test]
    async fn a_constraint_violation_is_permanent() {
        let error = push_error(400, r#"{"message":"duplicate key","code":"23505"}"#).await;
        assert!(!error.is_budget_exempt());
        assert_eq!(
            error.to_string(),
            "remote: kizunasync.push failed: duplicate key"
        );
        assert_eq!(remote_code(&error), Some("23505".to_string()));
    }

    #[tokio::test]
    async fn a_data_exception_is_permanent() {
        let error = push_error(400, r#"{"message":"invalid input","code":"22P02"}"#).await;
        assert!(!error.is_budget_exempt());
    }

    #[tokio::test]
    async fn an_uncoded_trigger_raise_is_permanent() {
        let error = push_error(400, r#"{"message":"demo cap exceeded","code":"P0001"}"#).await;
        assert!(!error.is_budget_exempt());
    }

    #[tokio::test]
    async fn a_non_conforming_client_mutation_is_permanent() {
        let error = push_error(
            400,
            r#"{"message":"kizunasync: mutation has no hlc","code":"0A000"}"#,
        )
        .await;
        assert!(!error.is_budget_exempt());
    }

    #[tokio::test]
    async fn a_pull_only_push_rejection_is_permanent() {
        let message =
            "kizunasync.push(): table \"todos\" is pull-only (sync_mode), pushes are rejected";
        let body = json!({ "message": message, "code": "KZP01" }).to_string();
        let error = push_error(400, &body).await;
        assert!(!error.is_budget_exempt(), "KZP01 must not stay queued");
        assert_eq!(error.code(), "PERMANENT_TRANSPORT");
        assert_eq!(remote_code(&error), Some("KZP01".to_string()));
        // The server's own message is the contract: the push loop surfaces it verbatim.
        assert_eq!(
            error.to_string(),
            format!("remote: kizunasync.push failed: {message}")
        );
    }

    #[tokio::test]
    async fn an_oversized_batch_rejection_is_permanent() {
        let message = "kizunasync.push(): batch of 51 mutations exceeds max_batch_size 50";
        let body = json!({ "message": message, "code": "KZP02" }).to_string();
        let error = push_error(400, &body).await;
        assert!(!error.is_budget_exempt(), "KZP02 must not stay queued");
        assert_eq!(error.code(), "PERMANENT_TRANSPORT");
        assert_eq!(remote_code(&error), Some("KZP02".to_string()));
        // The server's own message is the contract: the push loop surfaces it verbatim.
        assert_eq!(
            error.to_string(),
            format!("remote: kizunasync.push failed: {message}")
        );
    }

    #[tokio::test]
    async fn an_unscoped_bucketed_pull_rejection_is_permanent() {
        let message = "kizunasync.pull(): table \"todos\" is bucketed on \"user_id\": the pull bucket must name that column";
        let body = json!({ "message": message, "code": "KZL01" }).to_string();
        let error = pull_error(400, &body).await;
        assert!(!error.is_budget_exempt(), "KZL01 must not stay queued");
        assert_eq!(error.code(), "PERMANENT_TRANSPORT");
        assert_eq!(remote_code(&error), Some("KZL01".to_string()));
        // The server's own message is the contract: the pull loop surfaces it verbatim.
        assert_eq!(
            error.to_string(),
            format!("remote: kizunasync.pull failed: {message}")
        );
    }

    #[tokio::test]
    async fn a_require_atomic_rejection_is_retryable() {
        let error = push_error(
            400,
            r#"{"message":"kizunasync.push(): require_atomic is set, non-atomic push rejected","code":"KZP03"}"#,
        )
        .await;
        assert!(error.is_budget_exempt());
    }

    #[tokio::test]
    async fn a_named_p0_condition_is_retryable() {
        let error = push_error(400, r#"{"message":"named condition","code":"P0002"}"#).await;
        assert!(error.is_budget_exempt());
    }

    #[tokio::test]
    async fn insufficient_privilege_is_retryable() {
        let error = push_error(403, r#"{"message":"permission denied","code":"42501"}"#).await;
        assert!(error.is_budget_exempt());
    }

    #[tokio::test]
    async fn a_syntax_fault_is_permanent() {
        let error = push_error(400, r#"{"message":"syntax error","code":"42601"}"#).await;
        assert!(!error.is_budget_exempt());
    }

    #[tokio::test]
    async fn an_expired_jwt_with_42501_body_is_retryable() {
        let error = push_error(401, r#"{"message":"JWT expired","code":"42501"}"#).await;
        assert!(error.is_budget_exempt());
    }

    #[tokio::test]
    async fn an_expired_jwt_is_retryable() {
        let error = push_error(401, r#"{"message":"JWT expired","code":"PGRST301"}"#).await;
        assert!(error.is_budget_exempt());
        assert_eq!(remote_code(&error), Some("PGRST301".to_string()));
    }

    #[tokio::test]
    async fn a_schema_not_exposed_config_error_is_retryable() {
        let error = push_error(404, r#"{"message":"schema not found","code":"PGRST106"}"#).await;
        assert!(error.is_budget_exempt());
    }

    #[tokio::test]
    async fn a_codeless_or_unparseable_failure_is_retryable() {
        assert!(
            push_error(500, r#"{"message":"boom"}"#)
                .await
                .is_budget_exempt()
        );
        assert!(
            push_error(502, "<html>bad gateway</html>")
                .await
                .is_budget_exempt()
        );
    }

    #[test]
    fn a_config_debug_hides_the_key_and_the_token() {
        let config = RemoteConfig::new("https://abc.supabase.co", "publishable-secret")
            .with_access_token("user-jwt-secret");

        let debug = format!("{config:?}");

        assert!(!debug.contains("publishable-secret"), "{debug}");
        assert!(!debug.contains("user-jwt-secret"), "{debug}");
        assert!(debug.contains("https://abc.supabase.co"), "{debug}");
    }

    #[test]
    fn the_live_remote_refuses_a_plain_http_project_url() {
        for url in [
            "http://abc.supabase.co",
            "ftp://abc.supabase.co",
            "not a url",
        ] {
            let refused = HttpProtocolRemote::new(RemoteConfig::new(url, "pub-key"));
            assert!(
                matches!(refused, Err(crate::transport::HttpError::Config(_))),
                "{url} must be refused"
            );
        }
    }

    #[test]
    fn the_live_remote_accepts_https_and_a_loopback_http_url() {
        for url in [
            "https://abc.supabase.co",
            "http://127.0.0.1:54321",
            "http://localhost:54321",
            "http://[::1]:54321",
        ] {
            assert!(
                HttpProtocolRemote::new(RemoteConfig::new(url, "pub-key")).is_ok(),
                "{url} must be accepted"
            );
        }
    }

    #[tokio::test]
    async fn a_dead_connection_is_retryable() {
        let transport = Arc::new(FakeTransport::new(|_| {
            Err(crate::transport::HttpError::Transport(
                "connection refused".into(),
            ))
        }));
        let remote = HttpProtocolRemote::with_transport(config(), transport);
        remote.set_access_token(Some("user-jwt".into()));
        let error = remote
            .push(push_request(Map::new()))
            .await
            .expect_err("transport down");
        assert!(error.is_budget_exempt());
    }
}
