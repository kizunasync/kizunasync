//! The Supabase Management API transport (`api.supabase.com`).
//!
//! The alternative to a direct Postgres connection: a Personal Access Token
//! authorizes the whole surface, with no Supabase CLI, no local files, and no
//! service-role key. This module calls three endpoints:
//!
//! * `GET /v1/projects`: the account's projects, for the wizard's picker.
//! * `GET`/`PATCH /v1/projects/{ref}/postgrest`: the exposed-schema list
//!   (`db_schema`, a comma-separated string).
//! * `POST /v1/projects/{ref}/database/query`: SQL as the postgres role. The
//!   documented success status is 201, so 2xx is the only safe test.
//!
//! The CLI's other project endpoints are built on [`project_endpoint`] by the
//! module that needs them: [`crate::login_role`] mints a login role
//! (`POST /cli/login-role`) and reads the pooler (`GET /config/database/pooler`),
//! and `doctor` reads the project's API keys (`GET /api-keys`).
//!
//! Failure posture: a non-2xx is an error carrying the status and the body, so a
//! failed call never degrades into a default value, because "no schemas
//! exposed" and "we could not ask" must not look alike. A statement the
//! database refused also carries its SQLSTATE, as over a direct connection.
//!
//! The token is a secret. It travels only in the `Authorization` header and
//! every response body is masked through [`redact_access_token`] on arrival, so
//! not even a token-echoing server can plant the bearer inside an error.

use serde_json::Value;

use crate::applier::Applier;
use crate::env::Env;
use crate::error::{Error, Result};
use crate::project_ref::ProjectRef;
use crate::row::Row;
use crate::token::{ACCESS_TOKEN_ENV, is_valid_token};

const DEFAULT_BASE_URL: &str = "https://api.supabase.com";
const PROJECTS_PATH: &str = "/v1/projects";
const POSTGREST_CONFIG_SEGMENT: &str = "/postgrest";
const DATABASE_QUERY_SEGMENT: &str = "/database/query";
const SCHEMA_SEPARATOR: char = ',';
const REDACTED: &str = "***";
const TOKEN_HELP: &str = "https://supabase.com/dashboard/account/tokens";

/// One HTTP exchange, narrowed to what these calls need so a test fake does not
/// have to reproduce a whole client.
pub trait HttpTransport {
    /// Send `body` (JSON, when present) to `url` with a bearer token.
    ///
    /// # Errors
    /// Returns [`Error::Transport`] when the request could not be completed at
    /// all: distinct from a completed request that answered non-2xx.
    fn send(
        &self,
        method: &str,
        url: &str,
        token: &str,
        body: Option<&str>,
    ) -> Result<HttpResponse>;
}

/// A completed HTTP exchange.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    /// The status code.
    pub status: u16,
    /// The body, already token-masked by the caller of the transport.
    pub body: String,
}

impl HttpResponse {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The real transport: a blocking `reqwest` client.
pub struct ReqwestTransport {
    client: reqwest::blocking::Client,
}

impl ReqwestTransport {
    /// Build the client.
    ///
    /// # Errors
    /// Returns [`Error::Transport`] when the HTTP client cannot be constructed.
    pub fn new() -> Result<Self> {
        reqwest::blocking::Client::builder()
            .build()
            .map(|client| Self { client })
            .map_err(|cause| Error::Transport(format!("could not build an HTTP client: {cause}")))
    }
}

impl HttpTransport for ReqwestTransport {
    fn send(
        &self,
        method: &str,
        url: &str,
        token: &str,
        body: Option<&str>,
    ) -> Result<HttpResponse> {
        let verb = reqwest::Method::from_bytes(method.as_bytes()).map_err(|cause| {
            Error::Transport(format!("{method} is not an HTTP method: {cause}"))
        })?;
        let mut request = self.client.request(verb, url).bearer_auth(token);
        if let Some(payload) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(payload.to_owned());
        }
        let response = request.send().map_err(|cause| {
            Error::Transport(format!(
                "{method} {url} failed: {}",
                redact_access_token(&cause.to_string(), token)
            ))
        })?;
        let status = response.status().as_u16();
        let body = response.text().map_err(|cause| {
            Error::Transport(format!("could not read the response body: {cause}"))
        })?;

        Ok(HttpResponse { status, body })
    }
}

/// Whether `expose_schema` had to change anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExposeOutcome {
    /// The schema was already listed.
    AlreadyPresent,
    /// It was appended to the list.
    Added,
}

/// The Management API caller, and an [`Applier`] over its query endpoint.
pub struct ManagementApi<T: HttpTransport> {
    transport: T,
    token: String,
    postgrest_endpoint: String,
    query_endpoint: String,
}

impl<T: HttpTransport> ManagementApi<T> {
    /// Bind the caller to a project and a token.
    #[must_use]
    pub fn new(
        transport: T,
        token: &str,
        project_ref: &ProjectRef,
        base_url: Option<&str>,
    ) -> Self {
        let project = project_endpoint(base_url, project_ref);

        Self {
            transport,
            token: token.to_owned(),
            postgrest_endpoint: format!("{project}{POSTGREST_CONFIG_SEGMENT}"),
            query_endpoint: format!("{project}{DATABASE_QUERY_SEGMENT}"),
        }
    }

    fn call(&self, method: &str, endpoint: &str, payload: Option<&Value>) -> Result<Value> {
        let body = payload.map(ToString::to_string);
        let response = self
            .transport
            .send(method, endpoint, &self.token, body.as_deref())?;
        let masked = redact_access_token(&response.body, &self.token);
        if !response.ok() {
            let text = format!(
                "Supabase Management API {method} {endpoint} failed: {} {}",
                response.status,
                masked.trim()
            );

            return Err(match refused_sqlstate(&masked) {
                Some(sqlstate) if endpoint == self.query_endpoint => Error::Sql { sqlstate, text },
                _ => Error::Transport(text),
            });
        }
        if masked.trim().is_empty() {
            return Ok(Value::Null);
        }

        serde_json::from_str(&masked).map_err(|_| {
            Error::Transport(format!(
                "Supabase Management API {method} {endpoint} failed: {} the response body was not JSON",
                response.status
            ))
        })
    }

    /// The project's exposed-schema list.
    ///
    /// # Errors
    /// Returns [`Error::Transport`] when the call fails or the config carries
    /// no `db_schema` string, never an empty list.
    pub fn exposed_schemas(&self) -> Result<Vec<String>> {
        let config = self.call("GET", &self.postgrest_endpoint, None)?;
        let Some(db_schema) = config.get("db_schema").and_then(Value::as_str) else {
            return Err(Error::Transport(format!(
                "Supabase Management API GET {} failed: the PostgREST config carried no db_schema string",
                self.postgrest_endpoint
            )));
        };

        Ok(split_schemas(db_schema))
    }

    /// Add `schema` to the exposed list, or report it was already there.
    ///
    /// # Errors
    /// Returns [`Error::Transport`] when either call fails.
    pub fn expose_schema(&self, schema: &str) -> Result<ExposeOutcome> {
        let mut exposed = self.exposed_schemas()?;
        if exposed.iter().any(|entry| entry == schema) {
            return Ok(ExposeOutcome::AlreadyPresent);
        }
        exposed.push(schema.to_owned());
        let payload =
            serde_json::json!({ "db_schema": exposed.join(&SCHEMA_SEPARATOR.to_string()) });
        self.call("PATCH", &self.postgrest_endpoint, Some(&payload))?;

        Ok(ExposeOutcome::Added)
    }
}

/// `/v1/projects/{ref}` under `base_url` (the public API when `None`), the root
/// every project-scoped endpoint hangs off. The ref is a [`ProjectRef`], so
/// the path segment it becomes was checked where the ref entered the CLI.
#[must_use]
pub fn project_endpoint(base_url: Option<&str>, project_ref: &ProjectRef) -> String {
    format!(
        "{}{PROJECTS_PATH}/{project_ref}",
        base_url.unwrap_or(DEFAULT_BASE_URL).trim_end_matches('/')
    )
}

/// The status that means the token itself is the problem.
const UNAUTHORIZED: u16 = 401;

/// One project, as `GET /v1/projects` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSummary {
    /// The project ref: what every other endpoint is keyed by.
    pub project_ref: String,
    /// The name shown in the dashboard; the ref when the API omitted it.
    pub name: String,
    /// The region it runs in, empty when the API omitted it.
    pub region: String,
}

/// Every project the token can see.
///
/// The one call here that is not project-scoped, so it is a free function
/// rather than a [`ManagementApi`] method: the wizard asks it *before* there is
/// a project to bind to.
///
/// # Errors
/// Returns [`Error::Transport`] when the call fails, when the token is rejected
/// (401 earns its own sentence: the cause is the credential, not the request),
/// or when the body is not a project array.
pub fn list_projects<T: HttpTransport>(
    transport: &T,
    token: &str,
    base_url: Option<&str>,
) -> Result<Vec<ProjectSummary>> {
    let endpoint = format!(
        "{}{PROJECTS_PATH}",
        base_url.unwrap_or(DEFAULT_BASE_URL).trim_end_matches('/')
    );
    let response = transport.send("GET", &endpoint, token, None)?;
    if response.status == UNAUTHORIZED {
        return Err(Error::Transport(format!(
            "the Supabase Personal Access Token was rejected (401): create a new one at {TOKEN_HELP}"
        )));
    }
    let masked = redact_access_token(&response.body, token);
    if !response.ok() {
        return Err(Error::Transport(format!(
            "Supabase Management API GET {endpoint} failed: {} {}",
            response.status,
            masked.trim()
        )));
    }
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&masked) else {
        return Err(Error::Transport(format!(
            "Supabase Management API GET {endpoint} failed: the response body was not a project list"
        )));
    };

    Ok(items.iter().filter_map(project_summary).collect())
}

/// One entry, or `None` when it carries no ref: a project that cannot be
/// addressed is not a project that can be offered.
fn project_summary(item: &Value) -> Option<ProjectSummary> {
    let project_ref = item.get("id").and_then(Value::as_str)?;

    Some(ProjectSummary {
        project_ref: project_ref.to_owned(),
        name: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(project_ref)
            .to_owned(),
        region: item
            .get("region")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

impl<T: HttpTransport> Applier for ManagementApi<T> {
    fn run_query(&self, sql: &str) -> Result<Vec<Row>> {
        let payload = serde_json::json!({ "query": sql });
        let value = self.call("POST", &self.query_endpoint, Some(&payload))?;

        Ok(rows_from(&value))
    }
}

/// The SQLSTATE named in a refused query's body. The query endpoint relays the
/// database's error as a JSON `message` such as `... ERROR:  42703: column ...
/// does not exist`, so the code is the five digits or capitals between
/// [`REFUSED_SEVERITY`] and the colon after them.
fn refused_sqlstate(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let message = value.get("message")?.as_str()?;
    let (_, after) = message.split_once(REFUSED_SEVERITY)?;
    let code = after.get(..5)?;
    let well_formed = code
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
        && after.get(5..)?.starts_with(':');

    well_formed.then(|| code.to_owned())
}

/// What the query endpoint's `message` puts before the SQLSTATE.
const REFUSED_SEVERITY: &str = "ERROR:  ";

/// The query endpoint answers with an array of row objects; a DDL statement
/// answers with an empty body (already `null` by then). Anything else carries
/// no rows rather than being invented into one.
fn rows_from(value: &Value) -> Vec<Row> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| item.as_object())
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Row>()
        })
        .collect()
}

fn split_schemas(db_schema: &str) -> Vec<String> {
    db_schema
        .split(SCHEMA_SEPARATOR)
        .map(|entry| entry.trim().to_owned())
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// Where the Personal Access Token came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    /// The `--access-token` flag.
    Flag,
    /// `SUPABASE_ACCESS_TOKEN`.
    Env,
}

impl std::fmt::Display for TokenSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Flag => "flag",
            Self::Env => "env:SUPABASE_ACCESS_TOKEN",
        })
    }
}

/// A resolved token and its rung. `Debug` is written by hand so the token
/// renders masked.
#[derive(Clone)]
pub struct ResolvedToken {
    /// The secret itself. Never echoed.
    pub token: String,
    /// Where it was found.
    pub source: TokenSource,
}

impl std::fmt::Debug for ResolvedToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedToken")
            .field("token", &REDACTED)
            .field("source", &self.source)
            .finish()
    }
}

/// Flag over environment, like every other kizunasync input.
///
/// # Errors
/// Returns [`Error::Transport`] naming both sources and where to mint a token.
/// The message never contains a token value.
pub fn resolve_access_token(flag: Option<&str>, env: &Env) -> Result<ResolvedToken> {
    if let Some(token) = flag.filter(|value| !value.is_empty()) {
        return accept_pat(token, TokenSource::Flag);
    }

    if let Some(token) = env.get(ACCESS_TOKEN_ENV) {
        return accept_pat(token, TokenSource::Env);
    }

    Err(Error::Transport(format!(
        "no Supabase Personal Access Token: pass --access-token <token> or set {ACCESS_TOKEN_ENV}\n\
         \x20 (create one at {TOKEN_HELP}, never a service-role key)."
    )))
}

fn accept_pat(token: &str, source: TokenSource) -> Result<ResolvedToken> {
    if !is_valid_token(token) {
        return Err(Error::Transport(
            "that is not a Personal Access Token (sbp_…): a project secret or JWT cannot authorize the Management API."
                .into(),
        ));
    }
    Ok(ResolvedToken {
        token: token.to_owned(),
        source,
    })
}

/// Mask the token anywhere text that might carry it is echoed. An empty token
/// masks nothing: a blanket replace would rewrite unrelated output.
#[must_use]
pub fn redact_access_token(text: &str, token: &str) -> String {
    if token.is_empty() {
        return text.to_owned();
    }

    text.replace(token, REDACTED)
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct FakeTransport {
        answers: Vec<(String, HttpResponse)>,
        seen: RefCell<Vec<(String, String, Option<String>)>>,
        bearer: RefCell<Vec<String>>,
    }

    impl FakeTransport {
        fn new() -> Self {
            Self {
                answers: Vec::new(),
                seen: RefCell::new(Vec::new()),
                bearer: RefCell::new(Vec::new()),
            }
        }

        fn answer(mut self, needle: &str, status: u16, body: &str) -> Self {
            self.answers.push((
                needle.to_owned(),
                HttpResponse {
                    status,
                    body: body.to_owned(),
                },
            ));
            self
        }
    }

    impl HttpTransport for FakeTransport {
        fn send(
            &self,
            method: &str,
            url: &str,
            token: &str,
            body: Option<&str>,
        ) -> Result<HttpResponse> {
            self.seen.borrow_mut().push((
                method.to_owned(),
                url.to_owned(),
                body.map(ToOwned::to_owned),
            ));
            self.bearer.borrow_mut().push(token.to_owned());
            for (needle, response) in &self.answers {
                if url.contains(needle.as_str()) {
                    return Ok(response.clone());
                }
            }

            Ok(HttpResponse {
                status: 404,
                body: String::new(),
            })
        }
    }

    fn api(transport: FakeTransport) -> ManagementApi<FakeTransport> {
        ManagementApi::new(
            transport,
            "pat-secret",
            &ProjectRef::parse("abcd").unwrap(),
            Some("https://api.test/"),
        )
    }

    #[test]
    fn endpoints_are_built_under_the_project_and_the_base_url_is_trimmed() {
        let client =
            api(FakeTransport::new().answer("/postgrest", 200, r#"{"db_schema":"public"}"#));

        assert_eq!(client.exposed_schemas().unwrap(), ["public"]);
        assert_eq!(
            client.transport.seen.borrow()[0].1,
            "https://api.test/v1/projects/abcd/postgrest"
        );
    }

    #[test]
    fn the_token_travels_as_the_bearer_and_nowhere_else() {
        let client =
            api(FakeTransport::new().answer("/postgrest", 200, r#"{"db_schema":"public"}"#));
        client.exposed_schemas().unwrap();

        assert_eq!(client.transport.bearer.borrow().as_slice(), ["pat-secret"]);
        assert!(client.transport.seen.borrow()[0].2.is_none());
    }

    #[test]
    fn a_comma_list_is_split_and_trimmed() {
        let client = api(FakeTransport::new().answer(
            "/postgrest",
            200,
            r#"{"db_schema":"public, graphql_public , "}"#,
        ));

        assert_eq!(
            client.exposed_schemas().unwrap(),
            ["public", "graphql_public"]
        );
    }

    #[test]
    fn a_config_without_db_schema_fails_instead_of_reading_as_empty() {
        let client = api(FakeTransport::new().answer("/postgrest", 200, "{}"));
        let Error::Transport(message) = client.exposed_schemas().unwrap_err() else {
            panic!("a config without db_schema is a transport failure");
        };

        assert!(message.contains("carried no db_schema string"), "{message}");
    }

    #[test]
    fn a_non_2xx_carries_the_status_and_the_body() {
        let client = api(FakeTransport::new().answer("/postgrest", 403, "forbidden"));
        let Error::Transport(message) = client.exposed_schemas().unwrap_err() else {
            panic!("a non-2xx is a transport failure");
        };

        assert!(message.contains("403"), "{message}");
        assert!(message.contains("forbidden"), "{message}");
    }

    #[test]
    fn a_token_echoing_body_is_masked_before_it_reaches_an_error() {
        let client = api(FakeTransport::new().answer("/postgrest", 401, "bad token pat-secret"));
        let Error::Transport(message) = client.exposed_schemas().unwrap_err() else {
            panic!("a rejected call is a transport failure");
        };

        assert!(!message.contains("pat-secret"), "{message}");
        assert!(message.contains("***"), "{message}");
    }

    #[test]
    fn exposing_an_already_listed_schema_patches_nothing() {
        let client = api(FakeTransport::new().answer(
            "/postgrest",
            200,
            r#"{"db_schema":"public,kizunasync"}"#,
        ));

        assert_eq!(
            client.expose_schema("kizunasync").unwrap(),
            ExposeOutcome::AlreadyPresent
        );
        assert_eq!(client.transport.seen.borrow().len(), 1);
    }

    #[test]
    fn exposing_a_missing_schema_patches_the_whole_list() {
        let client =
            api(FakeTransport::new().answer("/postgrest", 200, r#"{"db_schema":"public"}"#));

        assert_eq!(
            client.expose_schema("kizunasync").unwrap(),
            ExposeOutcome::Added
        );
        let seen = client.transport.seen.borrow();
        assert_eq!(seen[1].0, "PATCH");
        assert_eq!(
            seen[1].2.as_deref(),
            Some(r#"{"db_schema":"public,kizunasync"}"#)
        );
    }

    #[test]
    fn the_query_endpoint_reads_an_array_of_row_objects() {
        let client =
            api(FakeTransport::new().answer("/database/query", 201, r#"[{"a":1,"b":"x"}]"#));
        let rows = client.run_query("select 1;").unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["a"], Value::from(1));
        assert_eq!(rows[0]["b"], Value::from("x"));
    }

    #[test]
    fn an_empty_body_is_a_legitimate_ddl_answer_not_a_parse_failure() {
        let client = api(FakeTransport::new().answer("/database/query", 201, ""));

        assert!(client.run_query("create table t();").unwrap().is_empty());
    }

    /// What the query endpoint answered, with HTTP 400, when the database
    /// refused a `_settings` read over a pack without `max_pull_scan`.
    const REFUSED_QUERY: &str = r#"{"message":"Failed to run sql query: ERROR:  42703: column \"max_pull_scan\" does not exist\nLINE 1: select max_batch_size, require_atomic, reap_schedule, compact_schedule, client_prune_schedule, client_ttl_days, hlc_max_skew_ms, tombstone_ttl_days, max_pull_scan from kizunasync._settings;\n"}"#;

    #[test]
    fn a_refused_query_carries_the_sqlstate_its_message_names() {
        let client = api(FakeTransport::new().answer("/database/query", 400, REFUSED_QUERY));
        let Error::Sql { sqlstate, text } = client.run_query("select 1;").unwrap_err() else {
            panic!("a statement the database refused is an SQL failure");
        };

        assert_eq!(sqlstate, "42703");
        assert!(text.contains("400"), "{text}");
        assert!(text.contains("42703: column"), "{text}");
    }

    #[test]
    fn a_refusal_without_a_sqlstate_stays_a_transport_failure() {
        for body in [
            r#"{"message":"permission denied for schema cron"}"#,
            r#"{"message":"ERROR:  something failed"}"#,
            r#"{"message":"Failed to run sql query: connection 28P01: refused"}"#,
            r#"{"message":"ERROR:  4270: too short"}"#,
            "ERROR:  42703: not a JSON body",
        ] {
            let client = api(FakeTransport::new().answer("/database/query", 400, body));

            assert!(
                matches!(client.run_query("select 1;"), Err(Error::Transport(_))),
                "{body}"
            );
        }
    }

    #[test]
    fn a_config_read_the_database_refused_names_the_reapply() {
        let client = api(FakeTransport::new().answer("/database/query", 400, REFUSED_QUERY));
        let Error::Config(message) = crate::config::load_config_from_db(&client).unwrap_err()
        else {
            panic!("an unreadable config is a config failure");
        };

        assert!(
            message.contains("kizunasync upgrade --reapply --yes"),
            "{message}"
        );
        assert!(
            message.contains("tables from an earlier build of the pack"),
            "{message}"
        );
        assert!(!message.contains("supabase start"), "{message}");
    }

    #[test]
    fn a_non_json_2xx_body_is_reported() {
        let client = api(FakeTransport::new().answer("/database/query", 200, "<html>"));
        let Error::Transport(message) = client.run_query("select 1;").unwrap_err() else {
            panic!("a non-JSON body is a transport failure");
        };

        assert!(message.contains("was not JSON"), "{message}");
    }

    // MARK: - GET /v1/projects

    const PROJECT_LIST: &str = r#"[
        {"id":"aaaaaaaaaaaaaaaaaaaa","name":"kizunasync-prod","region":"eu-central-1","organization_id":"org"},
        {"id":"bbbbbbbbbbbbbbbbbbbb","name":"kizunasync-staging","region":"us-east-1","organization_id":"org"}
    ]"#;

    #[test]
    fn the_project_list_maps_id_name_and_region_in_the_order_the_api_returned() {
        let transport = FakeTransport::new().answer("/v1/projects", 200, PROJECT_LIST);
        let projects = list_projects(&transport, "pat-secret", Some("https://api.test/")).unwrap();

        assert_eq!(
            projects,
            [
                ProjectSummary {
                    project_ref: "aaaaaaaaaaaaaaaaaaaa".to_owned(),
                    name: "kizunasync-prod".to_owned(),
                    region: "eu-central-1".to_owned(),
                },
                ProjectSummary {
                    project_ref: "bbbbbbbbbbbbbbbbbbbb".to_owned(),
                    name: "kizunasync-staging".to_owned(),
                    region: "us-east-1".to_owned(),
                },
            ]
        );
        assert_eq!(
            transport.seen.borrow()[0],
            (
                "GET".to_owned(),
                "https://api.test/v1/projects".to_owned(),
                None
            )
        );
        assert_eq!(transport.bearer.borrow().as_slice(), ["pat-secret"]);
    }

    #[test]
    fn an_account_with_no_projects_is_an_empty_list_not_a_failure() {
        let transport = FakeTransport::new().answer("/v1/projects", 200, "[]");

        assert!(
            list_projects(&transport, "pat-secret", Some("https://api.test"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn an_entry_without_a_ref_is_dropped_and_a_missing_name_falls_back_to_it() {
        let transport = FakeTransport::new().answer(
            "/v1/projects",
            200,
            r#"[{"name":"no ref"},{"id":"cccccccccccccccccccc"}]"#,
        );
        let projects = list_projects(&transport, "pat-secret", Some("https://api.test")).unwrap();

        assert_eq!(
            projects,
            [ProjectSummary {
                project_ref: "cccccccccccccccccccc".to_owned(),
                name: "cccccccccccccccccccc".to_owned(),
                region: String::new(),
            }]
        );
    }

    #[test]
    fn a_rejected_token_says_so_instead_of_echoing_a_status_line() {
        let transport = FakeTransport::new().answer(
            "/v1/projects",
            401,
            r#"{"message":"Unauthorized. pat-secret"}"#,
        );
        let Error::Transport(message) =
            list_projects(&transport, "pat-secret", Some("https://api.test")).unwrap_err()
        else {
            panic!("a rejected token is a transport failure");
        };

        assert!(message.contains("was rejected (401)"), "{message}");
        assert!(message.contains("dashboard/account/tokens"), "{message}");
        assert!(!message.contains("pat-secret"), "{message}");
    }

    #[test]
    fn a_non_json_body_is_reported_as_not_a_project_list() {
        let transport = FakeTransport::new().answer("/v1/projects", 200, "<html>nope</html>");
        let Error::Transport(message) =
            list_projects(&transport, "pat-secret", Some("https://api.test")).unwrap_err()
        else {
            panic!("a non-JSON body is a transport failure");
        };

        assert!(message.contains("was not a project list"), "{message}");
    }

    #[test]
    fn a_json_object_is_not_a_project_list_either() {
        let transport = FakeTransport::new().answer("/v1/projects", 200, r#"{"projects":[]}"#);

        assert!(list_projects(&transport, "pat-secret", Some("https://api.test")).is_err());
    }

    #[test]
    fn a_non_2xx_that_is_not_401_carries_the_status_and_the_masked_body() {
        let transport = FakeTransport::new().answer("/v1/projects", 500, "boom for pat-secret");
        let Error::Transport(message) =
            list_projects(&transport, "pat-secret", Some("https://api.test")).unwrap_err()
        else {
            panic!("a non-2xx is a transport failure");
        };

        assert!(message.contains("500"), "{message}");
        assert!(message.contains("boom for ***"), "{message}");
    }

    #[test]
    fn the_token_resolves_flag_over_environment_and_names_both_when_absent() {
        let flag = format!("sbp_{}", "a".repeat(40));
        let env_token = format!("sbp_{}", "b".repeat(40));
        let env = Env::from_pairs(&[("SUPABASE_ACCESS_TOKEN", env_token.as_str())]);

        assert_eq!(
            resolve_access_token(Some(&flag), &env).unwrap().source,
            TokenSource::Flag
        );
        assert_eq!(resolve_access_token(None, &env).unwrap().token, env_token);

        let Error::Transport(message) = resolve_access_token(None, &Env::default()).unwrap_err()
        else {
            panic!("an absent token is a transport failure");
        };
        assert!(message.contains("--access-token"), "{message}");
        assert!(message.contains("SUPABASE_ACCESS_TOKEN"), "{message}");
    }

    #[test]
    fn a_service_role_key_or_jwt_is_refused() {
        let env = Env::from_pairs(&[("SUPABASE_ACCESS_TOKEN", "service_role")]);
        let Error::Transport(message) = resolve_access_token(None, &env).unwrap_err() else {
            panic!("a service-role key is a transport failure");
        };
        assert!(message.contains("Personal Access Token"), "{message}");

        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
        let Error::Transport(message) =
            resolve_access_token(Some(jwt), &Env::default()).unwrap_err()
        else {
            panic!("a JWT is a transport failure");
        };
        assert!(message.contains("JWT"), "{message}");
    }

    #[test]
    fn redaction_masks_every_occurrence_and_an_empty_token_masks_nothing() {
        assert_eq!(
            redact_access_token("a sbp_1 b sbp_1", "sbp_1"),
            "a *** b ***"
        );
        assert_eq!(redact_access_token("untouched", ""), "untouched");
    }

    #[test]
    fn a_resolved_token_never_debug_prints_the_secret() {
        let token = "sbp_0000000000000000000000000000000000000001";
        let resolved = ResolvedToken {
            token: token.to_owned(),
            source: TokenSource::Env,
        };
        let rendered = format!("{resolved:?}");

        assert!(!rendered.contains(token), "{rendered}");
        assert!(rendered.contains("Env"), "{rendered}");
    }
}
