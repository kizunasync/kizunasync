//! A direct Postgres connection to the linked project, opened the way the
//! Supabase CLI opens one without a stored password.
//!
//! The password is `SUPABASE_DB_PASSWORD` when the session or the project's
//! `.env` files declare it. Otherwise the Management API mints a temporary,
//! read-only Postgres login (`POST /v1/projects/{ref}/cli/login-role`), so a
//! linked project can be introspected with nothing but the access token the
//! machine already has.
//!
//! The direct host `db.<ref>.supabase.co:5432` is tried first. When it does not
//! answer (it is IPv6-only), the session pooler takes over: the URL `supabase
//! link` saved in `supabase/.temp/pooler-url`, else the project's primary pooler
//! from `GET /v1/projects/{ref}/config/database/pooler`, always on port 5432
//! because transaction mode does not support prepared statements. A freshly
//! minted password can take a moment to reach the pooler, so that connect is
//! retried with backoff.
//!
//! The password is a secret: it travels only inside the returned URL, and no
//! error or log line built here carries it.

use std::time::Duration;

use reqwest::Url;
use serde_json::Value;

use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::error::{Error, Result};
use crate::management::{HttpTransport, project_endpoint, redact_access_token};
use crate::project_ref::ProjectRef;
use crate::workdir::ProjectPaths;

const LOGIN_ROLE_SEGMENT: &str = "/cli/login-role";
const POOLER_SEGMENT: &str = "/config/database/pooler";

/// The pooler entry that serves the primary database, not a read replica.
const PRIMARY_DATABASE: &str = "PRIMARY";

/// The password the Supabase CLI reads before minting a login.
const DB_PASSWORD_ENV: &str = "SUPABASE_DB_PASSWORD";

/// The role a `SUPABASE_DB_PASSWORD` authenticates.
const PASSWORD_ROLE: &str = "postgres";

/// Where `supabase link` saves the project's pooler URL, relative to
/// `supabase/`.
const POOLER_URL_FILE: [&str; 2] = [".temp", "pooler-url"];

const SSLMODE: &str = "sslmode";
const REQUIRE: &str = "require";

/// Both the direct host and the session pooler listen here.
const POSTGRES_PORT: u16 = 5432;

/// The reachability probe's budget for the direct host, the Supabase CLI's own.
pub const DIRECT_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// The pauses between pooler connect attempts: three attempts in all.
const POOLER_BACKOFF: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(2)];

/// A temporary Postgres login the Management API minted. Deliberately not
/// `Debug`: the password stays out of every rendering a caller could reach for.
pub struct LoginRole {
    /// The role to connect as.
    pub role: String,
    /// Its password, held in memory only.
    pub password: String,
    /// How long the login lives, in seconds.
    pub ttl_seconds: u64,
}

/// Mint a temporary Postgres login for `project_ref`.
///
/// # Errors
/// Returns [`Error::Transport`] naming the HTTP status when the API answers
/// non-2xx, the transport's own failure when the request did not complete, and
/// a parse failure when the body carries no role or password. No message
/// carries the token or a password.
pub fn create_login_role(
    transport: &dyn HttpTransport,
    token: &str,
    project_ref: &ProjectRef,
    read_only: bool,
    base_url: Option<&str>,
) -> Result<LoginRole> {
    let endpoint = format!(
        "{}{LOGIN_ROLE_SEGMENT}",
        project_endpoint(base_url, project_ref)
    );
    let payload = serde_json::json!({ "read_only": read_only }).to_string();
    let body = exchange(
        transport,
        "POST",
        &endpoint,
        token,
        Some(&payload),
        "could not open a temporary database login",
    )?;
    let role = body.get("role").and_then(Value::as_str);
    let password = body.get("password").and_then(Value::as_str);
    let (Some(role), Some(password)) = (role, password) else {
        return Err(Error::Transport(
            "could not open a temporary database login: the answer carried no role or password"
                .into(),
        ));
    };

    Ok(LoginRole {
        role: role.to_owned(),
        password: password.to_owned(),
        ttl_seconds: body
            .get("ttl_seconds")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    })
}

/// The connection string of the project's primary session pooler.
///
/// # Errors
/// Returns [`Error::Transport`] naming the HTTP status when the API answers
/// non-2xx, and a parse failure when no `PRIMARY` entry carries a
/// `connection_string`.
pub fn pooler_primary(
    transport: &dyn HttpTransport,
    token: &str,
    project_ref: &ProjectRef,
    base_url: Option<&str>,
) -> Result<String> {
    let endpoint = format!(
        "{}{POOLER_SEGMENT}",
        project_endpoint(base_url, project_ref)
    );
    let body = exchange(
        transport,
        "GET",
        &endpoint,
        token,
        None,
        "could not read the project's pooler",
    )?;

    body.as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry.get("database_type").and_then(Value::as_str) == Some(PRIMARY_DATABASE))
        .and_then(|entry| entry.get("connection_string").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            Error::Transport(
                "could not read the project's pooler: no PRIMARY entry carried a connection string"
                    .into(),
            )
        })
}

/// One Management API call whose failure is summarized as `what` plus the HTTP
/// status: the body is dropped rather than echoed, so nothing it carries can
/// reach a log line.
fn exchange(
    transport: &dyn HttpTransport,
    method: &str,
    endpoint: &str,
    token: &str,
    body: Option<&str>,
    what: &str,
) -> Result<Value> {
    let response = transport
        .send(method, endpoint, token, body)
        .map_err(|cause| {
            Error::Transport(format!(
                "{what}: {}",
                redact_access_token(&cause.to_string(), token)
            ))
        })?;
    if !(200..300).contains(&response.status) {
        return Err(Error::Transport(format!(
            "{what} (HTTP {})",
            response.status
        )));
    }

    serde_json::from_str(&response.body)
        .map_err(|_| Error::Transport(format!("{what}: the answer was not JSON")))
}

/// Everything [`linked_connection`] reaches outside itself, injected so no test
/// opens a socket or calls the real API.
pub struct LinkedPorts<'a> {
    /// The Management API transport.
    pub transport: &'a dyn HttpTransport,
    /// The API root, the public one when `None`.
    pub base_url: Option<&'a str>,
    /// Whether a TCP connect to `host:port` succeeds within
    /// [`DIRECT_PROBE_TIMEOUT`].
    pub reachable: &'a dyn Fn(&str, u16) -> bool,
    /// Open, and prove, a Postgres connection.
    pub connect: &'a dyn Fn(&str) -> Result<()>,
    /// Waits between pooler connect attempts.
    pub sleep: &'a dyn Fn(Duration),
}

/// How the linked project was reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkedRoute {
    /// `db.<ref>.supabase.co`.
    Direct,
    /// The session pooler, because the direct host did not answer.
    Pooler,
}

/// A connection string to the linked project, and how it was built. The URL
/// carries a password: redact it before it is ever printed.
pub struct LinkedConnection {
    /// The connection string, held in memory only.
    pub url: String,
    /// The host it reaches.
    pub route: LinkedRoute,
    /// Whether the password is a temporary login rather than
    /// `SUPABASE_DB_PASSWORD`.
    pub minted: bool,
}

/// A direct Postgres connection to `project_ref`, per the module docs.
/// `token` is needed only to mint a login or to look the pooler up.
///
/// # Errors
/// Returns [`Error::Transport`] when a needed token is missing or a
/// Management API call fails; [`Error::Db`] when a saved pooler URL names a
/// non-pooler host (`saved_pooler_url`), the pooler URL is otherwise
/// malformed, or its connect still fails after every retry. No message
/// carries a password.
pub fn linked_connection(
    project_ref: &ProjectRef,
    token: Option<&str>,
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
    ports: &LinkedPorts<'_>,
) -> Result<LinkedConnection> {
    let declared = env
        .get(DB_PASSWORD_ENV)
        .or_else(|| env_files.get(DB_PASSWORD_ENV));
    let login = match declared {
        Some(password) => LoginRole {
            role: PASSWORD_ROLE.to_owned(),
            password: password.to_owned(),
            ttl_seconds: 0,
        },
        None => create_login_role(
            ports.transport,
            require_token(token)?,
            project_ref,
            true,
            ports.base_url,
        )?,
    };
    let minted = declared.is_none();

    let direct_host = format!("db.{project_ref}.supabase.co");
    if (ports.reachable)(&direct_host, POSTGRES_PORT) {
        return Ok(LinkedConnection {
            url: direct_url(&direct_host, &login)?,
            route: LinkedRoute::Direct,
            minted,
        });
    }

    let pooler = match saved_pooler_url(paths)? {
        Some(saved) => saved,
        None => pooler_primary(
            ports.transport,
            require_token(token)?,
            project_ref,
            ports.base_url,
        )?,
    };
    let url = pooler_url(&pooler, project_ref, &login)?;
    connect_with_backoff(&url, ports)?;

    Ok(LinkedConnection {
        url,
        route: LinkedRoute::Pooler,
        minted,
    })
}

fn require_token(token: Option<&str>) -> Result<&str> {
    token.ok_or_else(|| Error::Transport("no Supabase access token".into()))
}

/// The Supabase session pooler's host suffix, every pooler URL an unmodified
/// `supabase link` ever saves.
const POOLER_HOST_SUFFIX: &str = ".pooler.supabase.com";

/// The pooler URL `supabase link` saved, trimmed, when it is there and not
/// blank. `supabase/.temp/pooler-url` is a local file, not an API answer, so
/// its host is checked before [`pooler_url`] ever attaches the freshly minted
/// login to it: a wrong or tampered file must never receive that password.
///
/// # Errors
/// Returns [`Error::Db`] when the file holds a value whose URL does not parse
/// or whose host does not end with [`POOLER_HOST_SUFFIX`].
fn saved_pooler_url(paths: &ProjectPaths) -> Result<Option<String>> {
    let path = POOLER_URL_FILE
        .iter()
        .fold(paths.supabase_dir.clone(), |path, segment| {
            path.join(segment)
        });
    let Ok(saved) = std::fs::read_to_string(path) else {
        return Ok(None);
    };
    let trimmed = saved.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let host = parse(trimmed)?.host_str().unwrap_or_default().to_owned();
    if !host.ends_with(POOLER_HOST_SUFFIX) {
        return Err(Error::Db(format!(
            "supabase/.temp/pooler-url names {host:?}, not a {POOLER_HOST_SUFFIX} host: refusing to attach credentials to it"
        )));
    }

    Ok(Some(trimmed.to_owned()))
}

fn direct_url(host: &str, login: &LoginRole) -> Result<String> {
    let mut url = parse(&format!(
        "postgresql://{host}:{POSTGRES_PORT}/postgres?sslmode=require"
    ))?;
    set_credentials(&mut url, &login.role, &login.password)?;

    Ok(url.into())
}

/// `pooler` with the port forced to session mode, the minted password, the
/// minted role as the user, suffixed `.<ref>` when the pooler's own user is
/// (the Supabase CLI's rule for a shared pooler), and `sslmode=require` in place
/// of a missing or non-verifying `sslmode`, which the hosted TLS policy refuses.
fn pooler_url(pooler: &str, project_ref: &ProjectRef, login: &LoginRole) -> Result<String> {
    let mut url = parse(pooler)?;
    let suffix = format!(".{project_ref}");
    let user = if url.username().ends_with(&suffix) {
        format!("{}{suffix}", login.role)
    } else {
        login.role.clone()
    };
    url.set_port(Some(POSTGRES_PORT))
        .map_err(|()| Error::Db("the pooler URL names no host".into()))?;
    set_credentials(&mut url, &user, &login.password)?;
    require_tls(&mut url);

    Ok(url.into())
}

/// Every `sslmode` that does not verify becomes `require`, and one is appended
/// when there is none; `require`, `verify-ca`, and `verify-full` stay as they
/// are. Only the `sslmode` pair's text changes: re-encoding the query as a form
/// would turn the `%20` of a `sslrootcert` path into a `+`, which names another
/// file, so every other pair keeps its bytes.
fn require_tls(url: &mut Url) {
    let mut named = false;
    let pairs: Vec<String> = url
        .query()
        .unwrap_or_default()
        .split('&')
        .map(|pair| {
            let Some((key, value)) = pair.split_once('=') else {
                return pair.to_owned();
            };
            if key != SSLMODE {
                return pair.to_owned();
            }

            named = true;
            if matches!(value, "disable" | "allow" | "prefer") {
                format!("{SSLMODE}={REQUIRE}")
            } else {
                pair.to_owned()
            }
        })
        .collect();
    if !named {
        url.query_pairs_mut().append_pair(SSLMODE, REQUIRE);
        return;
    }

    url.set_query(Some(&pairs.join("&")));
}

fn parse(raw: &str) -> Result<Url> {
    Url::parse(raw).map_err(|cause| Error::Db(format!("invalid pooler URL: {cause}")))
}

/// `Url` percent-encodes both halves, so a password carrying `@`, `:` or `/`
/// still parses back to itself.
fn set_credentials(url: &mut Url, user: &str, password: &str) -> Result<()> {
    url.set_username(user)
        .and_then(|()| url.set_password(Some(password)))
        .map_err(|()| Error::Db("the connection URL cannot carry credentials".into()))
}

/// The pooler may not accept a password minted a moment ago, so the connect is
/// retried after each pause in [`POOLER_BACKOFF`]. The last failure is the one
/// reported.
fn connect_with_backoff(url: &str, ports: &LinkedPorts<'_>) -> Result<()> {
    let mut outcome = (ports.connect)(url);
    for pause in POOLER_BACKOFF {
        if outcome.is_ok() {
            break;
        }
        (ports.sleep)(pause);
        outcome = (ports.connect)(url);
    }

    outcome.map_err(|cause| {
        Error::Db(format!(
            "could not connect to the session pooler after {} attempts: {cause}",
            POOLER_BACKOFF.len() + 1
        ))
    })
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::path::Path;

    use super::*;
    use crate::management::HttpResponse;

    const REF: &str = "abcdefghijklmnopqrst";

    fn project_ref() -> ProjectRef {
        ProjectRef::parse(REF).unwrap()
    }
    const TOKEN: &str = "sbp_0123456789abcdef0123456789abcdef01234567";
    const MINTED: &str =
        r#"{"role":"cli_login_postgres","password":"p@ss:w/rd","ttl_seconds":300}"#;
    const POOLERS: &str = r#"[
        {"database_type":"READ_REPLICA","connection_string":"postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@replica.pooler.supabase.com:6543/postgres"},
        {"database_type":"PRIMARY","connection_string":"postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"}
    ]"#;

    /// Answers by URL fragment and records every request.
    struct FakeTransport {
        answers: Vec<(&'static str, u16, &'static str)>,
        seen: RefCell<Vec<(String, String, Option<String>)>>,
    }

    impl FakeTransport {
        fn new(answers: &[(&'static str, u16, &'static str)]) -> Self {
            Self {
                answers: answers.to_vec(),
                seen: RefCell::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.seen
                .borrow()
                .iter()
                .map(|(method, url, _)| format!("{method} {url}"))
                .collect()
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
            assert_eq!(token, TOKEN);
            self.seen.borrow_mut().push((
                method.to_owned(),
                url.to_owned(),
                body.map(ToOwned::to_owned),
            ));
            let (_, status, body) = self
                .answers
                .iter()
                .find(|(needle, _, _)| url.ends_with(needle))
                .copied()
                .unwrap_or(("", 404, ""));

            Ok(HttpResponse {
                status,
                body: body.to_owned(),
            })
        }
    }

    fn project(root: &Path) -> ProjectPaths {
        ProjectPaths::rooted_at(root.to_path_buf())
    }

    fn write_saved_pooler(root: &Path, body: &str) {
        let temp = root.join("supabase").join(".temp");
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join("pooler-url"), body).unwrap();
    }

    /// Runs [`linked_connection`] with the direct host answering or not, and
    /// the pooler connect failing `failures` times first.
    struct Run {
        transport: FakeTransport,
        direct_reachable: bool,
        failures: usize,
        connects: RefCell<Vec<String>>,
        pauses: RefCell<Vec<Duration>>,
        probed: RefCell<Vec<(String, u16)>>,
    }

    impl Run {
        fn new(answers: &[(&'static str, u16, &'static str)], direct_reachable: bool) -> Self {
            Self {
                transport: FakeTransport::new(answers),
                direct_reachable,
                failures: 0,
                connects: RefCell::new(Vec::new()),
                pauses: RefCell::new(Vec::new()),
                probed: RefCell::new(Vec::new()),
            }
        }

        fn failing(mut self, failures: usize) -> Self {
            self.failures = failures;
            self
        }

        fn connect(&self, root: &Path, token: Option<&str>, env: &Env) -> Result<LinkedConnection> {
            let attempts = Cell::new(0);
            let reachable = |host: &str, port: u16| {
                self.probed.borrow_mut().push((host.to_owned(), port));
                self.direct_reachable
            };
            let connect = |url: &str| {
                self.connects.borrow_mut().push(url.to_owned());
                attempts.set(attempts.get() + 1);
                if attempts.get() <= self.failures {
                    return Err(Error::Db("password authentication failed".into()));
                }

                Ok(())
            };
            let sleep = |pause: Duration| self.pauses.borrow_mut().push(pause);
            let ports = LinkedPorts {
                transport: &self.transport,
                base_url: Some("https://api.test/"),
                reachable: &reachable,
                connect: &connect,
                sleep: &sleep,
            };

            linked_connection(
                &project_ref(),
                token,
                &project(root),
                env,
                &crate::env_file::load(root),
                &ports,
            )
        }
    }

    #[test]
    fn a_minted_read_only_login_reaches_the_direct_host() {
        let dir = tempfile::tempdir().unwrap();
        let run = Run::new(&[("/cli/login-role", 201, MINTED)], true);
        let connection = run
            .connect(dir.path(), Some(TOKEN), &Env::default())
            .unwrap();

        assert_eq!(connection.route, LinkedRoute::Direct);
        assert!(connection.minted);
        assert_eq!(
            connection.url,
            "postgresql://cli_login_postgres:p%40ss%3Aw%2Frd@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require"
        );
        let seen = run.transport.seen.borrow();
        assert_eq!(
            (seen[0].0.as_str(), seen[0].1.as_str(), seen[0].2.as_deref()),
            (
                "POST",
                "https://api.test/v1/projects/abcdefghijklmnopqrst/cli/login-role",
                Some(r#"{"read_only":true}"#)
            )
        );
        assert_eq!(
            run.probed.borrow().as_slice(),
            [("db.abcdefghijklmnopqrst.supabase.co".to_owned(), 5432)]
        );
        assert!(run.connects.borrow().is_empty());
    }

    #[test]
    fn the_encoded_password_parses_back_to_itself() {
        let dir = tempfile::tempdir().unwrap();
        let run = Run::new(&[("/cli/login-role", 201, MINTED)], true);
        let url = run
            .connect(dir.path(), Some(TOKEN), &Env::default())
            .unwrap()
            .url;
        let config: postgres::Config = url.parse().unwrap();

        assert_eq!(config.get_password(), Some("p@ss:w/rd".as_bytes()));
        assert_eq!(config.get_user(), Some("cli_login_postgres"));
    }

    #[test]
    fn supabase_db_password_skips_minting_and_needs_no_token() {
        let dir = tempfile::tempdir().unwrap();
        let run = Run::new(&[], true);
        let env = Env::from_pairs(&[(DB_PASSWORD_ENV, "hunter2")]);
        let connection = run.connect(dir.path(), None, &env).unwrap();

        assert!(!connection.minted);
        assert_eq!(
            connection.url,
            "postgresql://postgres:hunter2@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require"
        );
        assert!(run.transport.calls().is_empty());
    }

    #[test]
    fn supabase_db_password_is_also_read_from_the_env_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env.local"),
            "SUPABASE_DB_PASSWORD=from-file\n",
        )
        .unwrap();
        let run = Run::new(&[], true);
        let connection = run.connect(dir.path(), None, &Env::default()).unwrap();

        assert!(
            connection
                .url
                .starts_with("postgresql://postgres:from-file@")
        );
        assert!(run.transport.calls().is_empty());
    }

    #[test]
    fn an_unreachable_direct_host_falls_back_to_the_saved_pooler_url_on_5432() {
        let dir = tempfile::tempdir().unwrap();
        write_saved_pooler(
            dir.path(),
            "  postgresql://postgres.abcdefghijklmnopqrst@aws-1-us-east-1.pooler.supabase.com:6543/postgres\n",
        );
        let run = Run::new(&[("/cli/login-role", 201, MINTED)], false);
        let connection = run
            .connect(dir.path(), Some(TOKEN), &Env::default())
            .unwrap();

        assert_eq!(connection.route, LinkedRoute::Pooler);
        assert_eq!(
            connection.url,
            "postgresql://cli_login_postgres.abcdefghijklmnopqrst:p%40ss%3Aw%2Frd@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
        );
        assert!(
            !run.transport
                .calls()
                .iter()
                .any(|call| call.contains("/config/database/pooler"))
        );
        assert_eq!(run.connects.borrow().len(), 1);
    }

    #[test]
    fn a_saved_pooler_url_naming_a_non_pooler_host_is_refused_before_any_credential_attaches() {
        let dir = tempfile::tempdir().unwrap();
        write_saved_pooler(
            dir.path(),
            "postgresql://postgres.abcdefghijklmnopqrst@evil.example:6543/postgres",
        );
        let run = Run::new(&[("/cli/login-role", 201, MINTED)], false);
        let Err(Error::Db(message)) = run.connect(dir.path(), Some(TOKEN), &Env::default()) else {
            panic!("a pooler-url host outside .pooler.supabase.com is a database failure");
        };

        assert!(message.contains("evil.example"), "{message}");
        assert!(message.contains(".pooler.supabase.com"), "{message}");
        assert!(
            !run.transport
                .calls()
                .iter()
                .any(|call| call.contains("/config/database/pooler")),
            "a bad file must not fall back to the API pooler either"
        );
        assert!(run.connects.borrow().is_empty());
    }

    #[test]
    fn without_a_saved_pooler_url_the_api_primary_pooler_is_used() {
        let dir = tempfile::tempdir().unwrap();
        let run = Run::new(
            &[
                ("/cli/login-role", 201, MINTED),
                ("/config/database/pooler", 200, POOLERS),
            ],
            false,
        );
        let connection = run
            .connect(dir.path(), Some(TOKEN), &Env::default())
            .unwrap();

        assert_eq!(
            connection.url,
            "postgresql://cli_login_postgres.abcdefghijklmnopqrst:p%40ss%3Aw%2Frd@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require"
        );
        assert_eq!(
            run.transport.calls()[1],
            "GET https://api.test/v1/projects/abcdefghijklmnopqrst/config/database/pooler"
        );
    }

    #[test]
    fn a_pooler_user_without_the_ref_suffix_takes_the_bare_role() {
        let login = LoginRole {
            role: "cli_login_postgres".to_owned(),
            password: "pw".to_owned(),
            ttl_seconds: 0,
        };

        assert_eq!(
            pooler_url(
                "postgresql://postgres@pooler.example:6543/postgres",
                &project_ref(),
                &login
            )
            .unwrap(),
            "postgresql://cli_login_postgres:pw@pooler.example:5432/postgres?sslmode=require"
        );
    }

    #[test]
    fn a_non_verifying_sslmode_on_the_pooler_becomes_require_and_a_verifying_one_stays() {
        let login = LoginRole {
            role: "r".to_owned(),
            password: "pw".to_owned(),
            ttl_seconds: 0,
        };
        for weak in ["disable", "allow", "prefer"] {
            assert_eq!(
                pooler_url(
                    &format!(
                        "postgresql://u@h.example:6543/postgres?application_name=x&sslmode={weak}"
                    ),
                    &project_ref(),
                    &login
                )
                .unwrap(),
                "postgresql://r:pw@h.example:5432/postgres?application_name=x&sslmode=require"
            );
        }
        assert_eq!(
            pooler_url(
                "postgresql://u@h.example:6543/postgres?sslmode=verify-full",
                &project_ref(),
                &login
            )
            .unwrap(),
            "postgresql://r:pw@h.example:5432/postgres?sslmode=verify-full"
        );
    }

    /// Appending `sslmode` and rewriting a weak one both leave the
    /// `sslrootcert` pair's bytes alone, so the TLS policy decodes the file the
    /// pooler URL named, a `%20` included.
    #[test]
    fn the_pooler_rewrite_keeps_the_sslrootcert_file() {
        let login = LoginRole {
            role: "r".to_owned(),
            password: "pw".to_owned(),
            ttl_seconds: 0,
        };
        for (pooler, path) in [
            (
                "postgresql://u@h.example:6543/postgres?sslrootcert=/etc/ssl/custom-ca_2.pem",
                "/etc/ssl/custom-ca_2.pem",
            ),
            (
                "postgresql://u@h.example:6543/postgres?sslrootcert=/etc/ssl/custom-ca_2.pem&sslmode=disable",
                "/etc/ssl/custom-ca_2.pem",
            ),
            (
                "postgresql://u@h.example:6543/postgres?sslmode=prefer&sslrootcert=%2Fetc%2Fssl%2Fcustom-ca_2.pem",
                "/etc/ssl/custom-ca_2.pem",
            ),
            (
                "postgresql://u@h.example:6543/postgres?sslrootcert=/etc/ssl/custom%20ca.pem",
                "/etc/ssl/custom ca.pem",
            ),
            (
                "postgresql://u@h.example:6543/postgres?sslmode=prefer&sslrootcert=/etc/ssl/custom%20ca.pem",
                "/etc/ssl/custom ca.pem",
            ),
        ] {
            let url = pooler_url(pooler, &project_ref(), &login).unwrap();
            let pair = pooler
                .split(['?', '&'])
                .find(|pair| pair.starts_with("sslrootcert="))
                .unwrap();
            let prepared = crate::tls_url::prepare_connect(&url).unwrap();

            assert!(url.contains(pair), "{pooler} -> {url}");
            assert!(url.contains("sslmode=require"), "{pooler} -> {url}");
            assert_eq!(
                prepared.root_cert.as_deref(),
                Some(Path::new(path)),
                "{pooler} -> {url}"
            );
        }
    }

    #[test]
    fn the_pooler_connect_is_retried_with_backoff_before_it_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        write_saved_pooler(
            dir.path(),
            "postgresql://postgres.abcdefghijklmnopqrst@p.pooler.supabase.com:6543/postgres",
        );
        let run = Run::new(&[("/cli/login-role", 201, MINTED)], false).failing(2);

        assert!(
            run.connect(dir.path(), Some(TOKEN), &Env::default())
                .is_ok()
        );
        assert_eq!(run.connects.borrow().len(), 3);
        assert_eq!(
            run.pauses.borrow().as_slice(),
            [Duration::from_secs(1), Duration::from_secs(2)]
        );
    }

    #[test]
    fn three_failed_pooler_connects_fail_without_the_password() {
        let dir = tempfile::tempdir().unwrap();
        write_saved_pooler(
            dir.path(),
            "postgresql://postgres.abcdefghijklmnopqrst@p.pooler.supabase.com:6543/postgres",
        );
        let run = Run::new(&[("/cli/login-role", 201, MINTED)], false).failing(3);
        let Err(Error::Db(message)) = run.connect(dir.path(), Some(TOKEN), &Env::default()) else {
            panic!("a pooler that never accepts the login is a database failure");
        };

        assert!(message.contains("after 3 attempts"), "{message}");
        assert!(!message.contains("p@ss"), "{message}");
        assert!(!message.contains("p%40ss"), "{message}");
        assert_eq!(run.connects.borrow().len(), 3);
    }

    #[test]
    fn a_rejected_login_names_the_status_and_nothing_the_body_said() {
        let dir = tempfile::tempdir().unwrap();
        let run = Run::new(
            &[("/cli/login-role", 403, "forbidden for sbp_secret")],
            true,
        );
        let Err(Error::Transport(message)) = run.connect(dir.path(), Some(TOKEN), &Env::default())
        else {
            panic!("a rejected login is a transport failure");
        };

        assert_eq!(
            message,
            "could not open a temporary database login (HTTP 403)"
        );
    }

    #[test]
    fn no_token_and_no_password_fails_before_any_call() {
        let dir = tempfile::tempdir().unwrap();
        let run = Run::new(&[], true);
        let Err(Error::Transport(message)) = run.connect(dir.path(), None, &Env::default()) else {
            panic!("a missing token is a transport failure");
        };

        assert_eq!(message, "no Supabase access token");
        assert!(run.transport.calls().is_empty());
    }

    #[test]
    fn a_pooler_lookup_failure_names_its_status() {
        let dir = tempfile::tempdir().unwrap();
        let run = Run::new(
            &[
                ("/cli/login-role", 201, MINTED),
                ("/config/database/pooler", 500, "boom"),
            ],
            false,
        );
        let Err(Error::Transport(message)) = run.connect(dir.path(), Some(TOKEN), &Env::default())
        else {
            panic!("a failed pooler lookup is a transport failure");
        };

        assert_eq!(message, "could not read the project's pooler (HTTP 500)");
    }

    #[test]
    fn a_pooler_list_without_a_primary_is_reported() {
        let transport = FakeTransport::new(&[(
            "/config/database/pooler",
            200,
            r#"[{"database_type":"READ_REPLICA","connection_string":"postgresql://x@h:6543/postgres"}]"#,
        )]);
        let Error::Transport(message) =
            pooler_primary(&transport, TOKEN, &project_ref(), Some("https://api.test"))
                .unwrap_err()
        else {
            panic!("a pooler list without a primary is a transport failure");
        };

        assert!(message.contains("no PRIMARY entry"), "{message}");
    }

    #[test]
    fn a_login_answer_without_a_password_is_reported() {
        let transport = FakeTransport::new(&[("/cli/login-role", 201, r#"{"role":"r"}"#)]);
        let Error::Transport(message) =
            create_login_role(&transport, TOKEN, &project_ref(), true, None)
                .err()
                .unwrap()
        else {
            panic!("a login without a password is a transport failure");
        };

        assert!(message.contains("no role or password"), "{message}");
        assert_eq!(
            transport.calls(),
            ["POST https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/cli/login-role"]
        );
    }

    #[test]
    fn the_minted_ttl_is_kept() {
        let transport = FakeTransport::new(&[("/cli/login-role", 201, MINTED)]);
        let login = create_login_role(&transport, TOKEN, &project_ref(), true, None).unwrap();

        assert_eq!(login.role, "cli_login_postgres");
        assert_eq!(login.ttl_seconds, 300);
    }
}
