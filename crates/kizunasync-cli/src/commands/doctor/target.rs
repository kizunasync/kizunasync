//! Where the live Data API probe finds its target: the project URL and a
//! publishable key, resolved independently and used only as a pair.
//!
//! Each half walks the same ladder: its flag, the process environment, the
//! project's `.env` files, then the linked project. The environment and the
//! files are read under every framework prefix apps use (none, `NEXT_PUBLIC_`,
//! `VITE_`, `EXPO_PUBLIC_`, `PUBLIC_`), in that order. The linked-project rung
//! needs a project ref and a Personal Access Token found without the keychain:
//! the URL is then the project's own host and the key comes from the
//! Management API, a publishable key before the legacy anon one and never a
//! secret. A Management API call that fails leaves the probe skipped with one
//! line naming the reason, token redacted. No key value is ever part of an
//! origin.

use serde_json::Value;

use crate::discovery::{InvalidLinkedRef, linked_project_ref};
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::management::{HttpTransport, project_endpoint, redact_access_token};
use crate::project_ref::ProjectRef;
use crate::token::{NoTokenStore, discover_token};
use crate::workdir::ProjectPaths;

/// The framework prefixes, in resolution order.
const PREFIXES: [&str; 5] = ["", "NEXT_PUBLIC_", "VITE_", "EXPO_PUBLIC_", "PUBLIC_"];

const URL_NAME: &str = "SUPABASE_URL";

/// The key names read under every prefix, in resolution order.
const KEY_NAMES: [&str; 3] = [
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "SUPABASE_ANON_KEY",
];

/// A JSON object of named keys, read unprefixed only, before the anon key.
const PUBLISHABLE_KEYS_NAME: &str = "SUPABASE_PUBLISHABLE_KEYS";

/// `doctor` is non-interactive and must never read, or prompt for, a keychain.
const PROBE_TOKEN_STORE: NoTokenStore = NoTokenStore;

const API_KEYS_SEGMENT: &str = "/api-keys";

/// A resolved probe target and where each half came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeTarget {
    /// The project URL.
    pub url: String,
    /// The publishable key. Never displayed.
    pub key: String,
    /// Where the URL came from, as the report names it.
    pub url_origin: String,
    /// Where the key came from, as the report names it.
    pub key_origin: String,
}

/// Everything the resolution reads.
pub struct ProbeInputs<'a> {
    /// `--url`.
    pub url: Option<&'a str>,
    /// `--publishable-key`.
    pub publishable_key: Option<&'a str>,
    /// `--project-ref`.
    pub project_ref: Option<&'a ProjectRef>,
    /// `--access-token`.
    pub access_token: Option<&'a str>,
    /// The process environment.
    pub env: &'a Env,
    /// The project's `.env` files.
    pub env_files: &'a EnvFileValues,
    /// The resolved project.
    pub paths: &'a ProjectPaths,
    /// The Management API transport, `None` when no client could be built.
    pub management: Option<&'a dyn HttpTransport>,
}

/// What resolving the probe target produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeResolution {
    /// Both halves resolved.
    Target(ProbeTarget),
    /// A half is missing: the probe is not run and nothing is said.
    Absent,
    /// The Management API fallback failed: the probe is not run, and this
    /// line says why.
    Skipped(String),
}

impl ProbeResolution {
    /// The target, when both halves resolved.
    #[must_use]
    pub fn target(self) -> Option<ProbeTarget> {
        match self {
            Self::Target(target) => Some(target),
            Self::Absent | Self::Skipped(_) => None,
        }
    }
}

/// The line a failed Management API fallback prints.
const SKIPPED_PREFIX: &str = "live Data API probe skipped: ";

/// The linked project a probe target can be derived from.
struct Linked {
    project_ref: ProjectRef,
    ref_origin: String,
    token: String,
}

/// Both a URL and a key, or nothing: the probe is opt-in, and half a target is
/// not a target.
#[must_use]
pub fn resolve_probe_target(inputs: &ProbeInputs<'_>) -> ProbeResolution {
    let url_names = prefixed(URL_NAME);
    let key_names = key_names();
    let url = flag(inputs.url, "--url")
        .or_else(|| from_env(&url_names, inputs.env))
        .or_else(|| from_env_files(&url_names, inputs.env_files));
    let key = flag(inputs.publishable_key, "--publishable-key")
        .or_else(|| from_env(&key_names, inputs.env))
        .or_else(|| from_env_files(&key_names, inputs.env_files));

    let linked = if url.is_none() || key.is_none() {
        match linked_project(inputs) {
            Ok(linked) => linked,
            Err(cause) => return ProbeResolution::Skipped(format!("{SKIPPED_PREFIX}{cause}")),
        }
    } else {
        None
    };

    let Some((url, url_origin)) = url.or_else(|| {
        linked.as_ref().map(|linked| {
            (
                format!("https://{}.supabase.co", linked.project_ref),
                format!("project {} ({})", linked.project_ref, linked.ref_origin),
            )
        })
    }) else {
        return ProbeResolution::Absent;
    };

    let (key, key_origin) = match (key, linked.as_ref()) {
        (Some(key), _) => key,
        (None, None) => return ProbeResolution::Absent,
        (None, Some(linked)) => match api_key_from_management(inputs.management, linked) {
            Ok(key) => key,
            Err(reason) => return ProbeResolution::Skipped(format!("{SKIPPED_PREFIX}{reason}")),
        },
    };

    ProbeResolution::Target(ProbeTarget {
        url,
        key,
        url_origin,
        key_origin,
    })
}

fn prefixed(name: &str) -> Vec<String> {
    PREFIXES
        .iter()
        .map(|prefix| format!("{prefix}{name}"))
        .collect()
}

/// Every key name, in resolution order: the JSON object sits after the
/// unprefixed publishable names and before the unprefixed anon key.
fn key_names() -> Vec<String> {
    let mut names = Vec::new();
    for prefix in PREFIXES {
        for name in KEY_NAMES {
            if prefix.is_empty() && name == "SUPABASE_ANON_KEY" {
                names.push(PUBLISHABLE_KEYS_NAME.to_owned());
            }
            names.push(format!("{prefix}{name}"));
        }
    }

    names
}

fn flag(value: Option<&str>, name: &str) -> Option<(String, String)> {
    value
        .filter(|value| !value.is_empty())
        .map(|value| (value.to_owned(), name.to_owned()))
}

fn from_env(names: &[String], env: &Env) -> Option<(String, String)> {
    names.iter().find_map(|name| {
        let value = interpret(name, env.get(name)?)?;

        Some((value, format!("env:{name}")))
    })
}

fn from_env_files(names: &[String], files: &EnvFileValues) -> Option<(String, String)> {
    names.iter().find_map(|name| {
        let (raw, file) = files.get_with_origin(name)?;
        let value = interpret(name, raw)?;

        Some((value, format!("{name} from {file}")))
    })
}

/// The value a name carries: `SUPABASE_PUBLISHABLE_KEYS` is decoded, every
/// other name is taken as it is.
fn interpret(name: &str, raw: &str) -> Option<String> {
    if name != PUBLISHABLE_KEYS_NAME {
        return Some(raw.to_owned());
    }

    if let Some(parsed) = first_publishable_key_from_json(raw) {
        return Some(parsed);
    }
    let trimmed = raw.trim();

    (!trimmed.is_empty() && !trimmed.starts_with('{')).then(|| trimmed.to_owned())
}

/// `SUPABASE_PUBLISHABLE_KEYS` is a JSON object of named keys (Supabase's
/// `@supabase/server` shape). Prefer `"default"`, else the first non-empty
/// string value. A bare string is accepted when someone pasted a single key.
fn first_publishable_key_from_json(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    if let Some(default) = object
        .get("default")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
    {
        return Some(default.to_owned());
    }

    object.values().find_map(|value| {
        value
            .as_str()
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
    })
}

/// The project ref (the flag, else the linked project) and a token found
/// without the keychain, or `None` when either is missing.
///
/// # Errors
/// Returns [`InvalidLinkedRef`] when the linked project's ref is not a valid
/// ref, which skips the probe with that reason.
fn linked_project(inputs: &ProbeInputs<'_>) -> Result<Option<Linked>, InvalidLinkedRef> {
    let (project_ref, ref_origin) = if let Some(project_ref) = inputs.project_ref {
        (project_ref.clone(), "--project-ref".to_owned())
    } else {
        let Some((project_ref, origin)) =
            linked_project_ref(inputs.paths, inputs.env, inputs.env_files)?
        else {
            return Ok(None);
        };
        (project_ref, origin.to_string())
    };

    let token = discover_token(
        inputs.access_token,
        inputs.env,
        inputs.env_files,
        &PROBE_TOKEN_STORE,
    );

    Ok(token.map(|token| Linked {
        project_ref,
        ref_origin,
        token: token.token,
    }))
}

/// The project's first publishable key, else its legacy anon key, from
/// `GET /v1/projects/{ref}/api-keys`. A secret key is never taken.
///
/// # Errors
/// Returns the reason, token redacted, when there is no transport, the call
/// fails or answers non-2xx, the answer is not a key list, or it holds neither
/// key.
fn api_key_from_management(
    transport: Option<&dyn HttpTransport>,
    linked: &Linked,
) -> Result<(String, String), String> {
    const WHAT: &str = "could not read the project's API keys";

    let transport = transport.ok_or_else(|| format!("{WHAT}: no HTTP client could be built"))?;
    let endpoint = format!(
        "{}{API_KEYS_SEGMENT}",
        project_endpoint(None, &linked.project_ref)
    );
    let response = transport
        .send("GET", &endpoint, &linked.token, None)
        .map_err(|cause| {
            format!(
                "{WHAT}: {}",
                redact_access_token(&cause.to_string(), &linked.token)
            )
        })?;
    if !(200..300).contains(&response.status) {
        return Err(format!("{WHAT} (HTTP {})", response.status));
    }

    let keys: Value = serde_json::from_str(&response.body)
        .map_err(|_| format!("{WHAT}: the answer was not JSON"))?;
    let keys = keys
        .as_array()
        .ok_or_else(|| format!("{WHAT}: the answer was not a key list"))?;
    let pick = |kind: &str, name: Option<&str>| {
        keys.iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some(kind))
            .filter(|entry| {
                name.is_none_or(|name| entry.get("name").and_then(Value::as_str) == Some(name))
            })
            .find_map(|entry| {
                entry
                    .get("api_key")
                    .and_then(Value::as_str)
                    .filter(|key| !key.is_empty())
                    .map(str::to_owned)
            })
    };
    let project = &linked.project_ref;

    if let Some(key) = pick("publishable", None) {
        return Ok((
            key,
            format!("publishable key from the Management API (project {project})"),
        ));
    }

    pick("legacy", Some("anon"))
        .map(|key| {
            (
                key,
                format!("legacy anon key from the Management API (project {project})"),
            )
        })
        .ok_or_else(|| format!("project {project} has no publishable or legacy anon key"))
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::cell::RefCell;
    use std::path::Path;

    use super::*;
    use crate::error::Result;
    use crate::management::HttpResponse;

    const TOKEN: &str = "sbp_0000000000000000000000000000000000000001";
    const REF: &str = "abcdefghijklmnopqrst";

    /// A Management API that answers `api-keys` with a fixed body and records
    /// every call.
    struct FakeManagement {
        status: u16,
        body: String,
        fail_with: Option<String>,
        seen: RefCell<Vec<(String, String)>>,
    }

    impl FakeManagement {
        fn answering(body: &str) -> Self {
            Self {
                status: 200,
                body: body.to_owned(),
                fail_with: None,
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl HttpTransport for FakeManagement {
        fn send(
            &self,
            _method: &str,
            url: &str,
            token: &str,
            _body: Option<&str>,
        ) -> Result<HttpResponse> {
            self.seen
                .borrow_mut()
                .push((url.to_owned(), token.to_owned()));
            if let Some(cause) = &self.fail_with {
                return Err(crate::error::Error::Transport(cause.clone()));
            }

            Ok(HttpResponse {
                status: self.status,
                body: self.body.clone(),
            })
        }
    }

    const KEYS: &str = r#"[
        {"api_key": "sb_secret_x", "type": "secret", "name": "default"},
        {"api_key": "legacy-anon", "type": "legacy", "name": "anon"},
        {"api_key": "legacy-service", "type": "legacy", "name": "service_role"},
        {"api_key": "sb_publishable_x", "type": "publishable", "name": "default"}
    ]"#;

    struct Fixture {
        dir: tempfile::TempDir,
        env: Env,
        files: EnvFileValues,
        paths: ProjectPaths,
    }

    impl Fixture {
        fn new(env: &[(&str, &str)], dotenv: &[(&str, &str)]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let body: Vec<String> = dotenv
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect();
            std::fs::write(dir.path().join(".env.local"), body.join("\n")).unwrap();
            let files = crate::env_file::load(dir.path());
            let paths = ProjectPaths::rooted_at(dir.path().to_path_buf());

            Self {
                env: Env::from_pairs(env),
                files,
                paths,
                dir,
            }
        }

        fn link(&self, project_ref: &str) {
            let temp = self.dir.path().join("supabase").join(".temp");
            std::fs::create_dir_all(&temp).unwrap();
            std::fs::write(temp.join("project-ref"), project_ref).unwrap();
        }

        fn inputs<'a>(&'a self, management: Option<&'a dyn HttpTransport>) -> ProbeInputs<'a> {
            ProbeInputs {
                url: None,
                publishable_key: None,
                project_ref: None,
                access_token: None,
                env: &self.env,
                env_files: &self.files,
                paths: &self.paths,
                management,
            }
        }

        fn root(&self) -> &Path {
            self.dir.path()
        }
    }

    fn resolve(inputs: &ProbeInputs<'_>) -> Option<ProbeTarget> {
        resolve_probe_target(inputs).target()
    }

    fn skipped(inputs: &ProbeInputs<'_>) -> String {
        match resolve_probe_target(inputs) {
            ProbeResolution::Skipped(line) => line,
            other => panic!("expected a skipped probe, got {other:?}"),
        }
    }

    fn halves(target: &ProbeTarget) -> (&str, &str, &str, &str) {
        (
            target.url.as_str(),
            target.url_origin.as_str(),
            target.key.as_str(),
            target.key_origin.as_str(),
        )
    }

    #[test]
    fn the_probe_is_opt_in_and_needs_both_halves_of_a_target() {
        let fixture = Fixture::new(&[("SUPABASE_URL", "https://env.example")], &[]);

        assert_eq!(resolve(&fixture.inputs(None)), None);

        let mut inputs = fixture.inputs(None);
        inputs.publishable_key = Some("key");
        assert_eq!(
            halves(&resolve(&inputs).unwrap()),
            (
                "https://env.example",
                "env:SUPABASE_URL",
                "key",
                "--publishable-key"
            )
        );

        inputs.url = Some("https://flag.example");
        assert_eq!(
            halves(&resolve(&inputs).unwrap()),
            ("https://flag.example", "--url", "key", "--publishable-key")
        );
    }

    #[test]
    fn the_unprefixed_key_names_resolve_publishable_first_then_json_then_anon() {
        let all = [
            ("SUPABASE_PUBLISHABLE_KEY", "pub"),
            ("SUPABASE_PUBLISHABLE_DEFAULT_KEY", "pub-default"),
            (
                "SUPABASE_PUBLISHABLE_KEYS",
                r#"{"ios":"ios-key","default":"from-json"}"#,
            ),
            ("SUPABASE_ANON_KEY", "legacy"),
        ];
        let expected = ["pub", "pub-default", "from-json", "legacy"];
        for skipped in 0..all.len() {
            let mut pairs = vec![("SUPABASE_URL", "https://env.example")];
            pairs.extend_from_slice(&all[skipped..]);
            let fixture = Fixture::new(&pairs, &[]);
            let target = resolve(&fixture.inputs(None)).unwrap();

            assert_eq!(target.key, expected[skipped]);
            assert_eq!(target.key_origin, format!("env:{}", all[skipped].0));
        }
    }

    #[test]
    fn publishable_keys_json_without_a_default_takes_the_first_value_and_a_bare_string_is_a_key() {
        let fixture = Fixture::new(
            &[
                ("SUPABASE_URL", "https://env.example"),
                ("SUPABASE_PUBLISHABLE_KEYS", r#"{"ios":"ios-key"}"#),
            ],
            &[],
        );
        assert_eq!(resolve(&fixture.inputs(None)).unwrap().key, "ios-key");

        let fixture = Fixture::new(
            &[
                ("SUPABASE_URL", "https://env.example"),
                ("SUPABASE_PUBLISHABLE_KEYS", " pasted "),
            ],
            &[],
        );
        assert_eq!(resolve(&fixture.inputs(None)).unwrap().key, "pasted");

        let fixture = Fixture::new(
            &[
                ("SUPABASE_URL", "https://env.example"),
                ("SUPABASE_PUBLISHABLE_KEYS", "{broken"),
            ],
            &[],
        );
        assert_eq!(resolve(&fixture.inputs(None)), None);
    }

    #[test]
    fn the_prefixes_resolve_in_order_for_both_halves() {
        for (index, prefix) in PREFIXES.iter().enumerate() {
            let url_name = format!("{prefix}SUPABASE_URL");
            let key_name = format!("{prefix}SUPABASE_ANON_KEY");
            let mut pairs = vec![
                (url_name.as_str(), "https://winner.example"),
                (key_name.as_str(), "winner"),
            ];
            let later: Vec<(String, String)> = PREFIXES[index + 1..]
                .iter()
                .flat_map(|later| {
                    [
                        (
                            format!("{later}SUPABASE_URL"),
                            "https://later.example".to_owned(),
                        ),
                        (
                            format!("{later}SUPABASE_PUBLISHABLE_KEY"),
                            "later".to_owned(),
                        ),
                    ]
                })
                .collect();
            pairs.extend(
                later
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str())),
            );
            let fixture = Fixture::new(&pairs, &[]);
            let target = resolve(&fixture.inputs(None)).unwrap();

            assert_eq!(
                halves(&target),
                (
                    "https://winner.example",
                    format!("env:{url_name}").as_str(),
                    "winner",
                    format!("env:{key_name}").as_str()
                )
            );
        }
    }

    #[test]
    fn a_prefixed_publishable_key_loses_to_an_unprefixed_anon_key() {
        let fixture = Fixture::new(
            &[
                ("SUPABASE_URL", "https://env.example"),
                ("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "next"),
                ("SUPABASE_ANON_KEY", "bare"),
            ],
            &[],
        );

        assert_eq!(resolve(&fixture.inputs(None)).unwrap().key, "bare");
    }

    #[test]
    fn the_env_files_are_read_under_every_family_and_named() {
        let fixture = Fixture::new(
            &[],
            &[
                ("VITE_SUPABASE_URL", "https://vite.example"),
                ("EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "expo"),
            ],
        );
        let target = resolve(&fixture.inputs(None)).unwrap();

        assert_eq!(
            halves(&target),
            (
                "https://vite.example",
                "VITE_SUPABASE_URL from .env.local",
                "expo",
                "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY from .env.local"
            )
        );
    }

    #[test]
    fn the_process_environment_outranks_the_env_files_and_the_flag_outranks_both() {
        let fixture = Fixture::new(
            &[
                ("NEXT_PUBLIC_SUPABASE_URL", "https://env.example"),
                ("PUBLIC_SUPABASE_ANON_KEY", "env-key"),
            ],
            &[
                ("SUPABASE_URL", "https://file.example"),
                ("SUPABASE_PUBLISHABLE_KEY", "file-key"),
            ],
        );
        let target = resolve(&fixture.inputs(None)).unwrap();
        assert_eq!(
            halves(&target),
            (
                "https://env.example",
                "env:NEXT_PUBLIC_SUPABASE_URL",
                "env-key",
                "env:PUBLIC_SUPABASE_ANON_KEY"
            )
        );

        let mut inputs = fixture.inputs(None);
        inputs.url = Some("https://flag.example");
        inputs.publishable_key = Some("flag-key");
        assert_eq!(
            halves(&resolve(&inputs).unwrap()),
            (
                "https://flag.example",
                "--url",
                "flag-key",
                "--publishable-key"
            )
        );
    }

    #[test]
    fn the_management_api_supplies_both_halves_preferring_a_publishable_key() {
        let fixture = Fixture::new(&[("SUPABASE_ACCESS_TOKEN", TOKEN)], &[]);
        fixture.link(REF);
        let management = FakeManagement::answering(KEYS);
        let target = resolve(&fixture.inputs(Some(&management))).unwrap();

        assert_eq!(
            halves(&target),
            (
                "https://abcdefghijklmnopqrst.supabase.co",
                "project abcdefghijklmnopqrst (supabase/.temp/project-ref)",
                "sb_publishable_x",
                "publishable key from the Management API (project abcdefghijklmnopqrst)"
            )
        );
        assert_eq!(
            management.seen.borrow().as_slice(),
            [(
                format!("https://api.supabase.com/v1/projects/{REF}/api-keys"),
                TOKEN.to_owned()
            )]
        );
        assert!(!target.url_origin.contains(TOKEN) && !target.key_origin.contains("sb_"));
    }

    #[test]
    fn without_a_publishable_key_the_legacy_anon_key_is_taken_and_a_secret_never_is() {
        let fixture = Fixture::new(&[("SUPABASE_ACCESS_TOKEN", TOKEN)], &[]);
        fixture.link(REF);
        let management = FakeManagement::answering(
            r#"[{"api_key":"sb_secret_x","type":"secret","name":"default"},{"api_key":"legacy-service","type":"legacy","name":"service_role"},{"api_key":"legacy-anon","type":"legacy","name":"anon"}]"#,
        );
        let target = resolve(&fixture.inputs(Some(&management))).unwrap();

        assert_eq!(target.key, "legacy-anon");
        assert_eq!(
            target.key_origin,
            "legacy anon key from the Management API (project abcdefghijklmnopqrst)"
        );

        let only_secrets = FakeManagement::answering(
            r#"[{"api_key":"sb_secret_x","type":"secret","name":"default"},{"api_key":"legacy-service","type":"legacy","name":"service_role"}]"#,
        );
        assert_eq!(
            skipped(&fixture.inputs(Some(&only_secrets))),
            "live Data API probe skipped: project abcdefghijklmnopqrst has no publishable or legacy anon key"
        );
    }

    #[test]
    fn the_flag_ref_and_the_env_file_token_feed_the_management_rung() {
        let fixture = Fixture::new(&[], &[("SUPABASE_ACCESS_TOKEN", TOKEN)]);
        let management = FakeManagement::answering(KEYS);
        let flag = ProjectRef::parse("zyxwvutsrqponmlkjihg").unwrap();
        let mut inputs = fixture.inputs(Some(&management));
        inputs.project_ref = Some(&flag);
        let target = resolve(&inputs).unwrap();

        assert_eq!(target.url, "https://zyxwvutsrqponmlkjihg.supabase.co");
        assert_eq!(
            target.url_origin,
            "project zyxwvutsrqponmlkjihg (--project-ref)"
        );
        assert!(
            management.seen.borrow()[0]
                .0
                .contains("/zyxwvutsrqponmlkjihg/api-keys")
        );
    }

    #[test]
    fn the_management_rung_only_fills_the_half_the_ladder_left_empty() {
        let fixture = Fixture::new(
            &[
                ("SUPABASE_ACCESS_TOKEN", TOKEN),
                ("SUPABASE_PROJECT_ID", REF),
            ],
            &[("SUPABASE_URL", "https://custom.example")],
        );
        let management = FakeManagement::answering(KEYS);
        let target = resolve(&fixture.inputs(Some(&management))).unwrap();

        assert_eq!(target.url, "https://custom.example");
        assert_eq!(target.url_origin, "SUPABASE_URL from .env.local");
        assert_eq!(target.key, "sb_publishable_x");

        let fixture = Fixture::new(
            &[
                ("SUPABASE_ACCESS_TOKEN", TOKEN),
                ("SUPABASE_PROJECT_ID", REF),
                ("SUPABASE_URL", "https://env.example"),
                ("SUPABASE_ANON_KEY", "env-key"),
            ],
            &[],
        );
        let management = FakeManagement::answering(KEYS);
        let target = resolve(&fixture.inputs(Some(&management))).unwrap();

        assert_eq!(target.key, "env-key");
        assert!(management.seen.borrow().is_empty());
    }

    #[test]
    fn the_management_rung_needs_a_ref_a_token_and_an_answer() {
        let management = FakeManagement::answering(KEYS);

        let no_ref = Fixture::new(&[("SUPABASE_ACCESS_TOKEN", TOKEN)], &[]);
        assert_eq!(resolve(&no_ref.inputs(Some(&management))), None);

        let no_token = Fixture::new(&[("HOME", "/nowhere")], &[]);
        no_token.link(REF);
        assert_eq!(resolve(&no_token.inputs(Some(&management))), None);
        assert!(management.seen.borrow().is_empty());

        let refused = FakeManagement {
            status: 401,
            ..FakeManagement::answering(KEYS)
        };
        let linked = Fixture::new(&[("SUPABASE_ACCESS_TOKEN", TOKEN)], &[]);
        linked.link(REF);
        assert_eq!(
            skipped(&linked.inputs(Some(&refused))),
            "live Data API probe skipped: could not read the project's API keys (HTTP 401)"
        );
        assert_eq!(
            skipped(&linked.inputs(None)),
            "live Data API probe skipped: could not read the project's API keys: no HTTP client could be built"
        );

        let not_json = FakeManagement::answering("<html>");
        assert_eq!(
            skipped(&linked.inputs(Some(&not_json))),
            "live Data API probe skipped: could not read the project's API keys: the answer was not JSON"
        );
        let not_a_list = FakeManagement::answering("{}");
        assert_eq!(
            skipped(&linked.inputs(Some(&not_a_list))),
            "live Data API probe skipped: could not read the project's API keys: the answer was not a key list"
        );

        let unreachable = FakeManagement {
            fail_with: Some(format!("GET failed: connection refused for {TOKEN}")),
            ..FakeManagement::answering(KEYS)
        };
        let line = skipped(&linked.inputs(Some(&unreachable)));
        assert_eq!(
            line,
            "live Data API probe skipped: could not read the project's API keys: GET failed: connection refused for ***"
        );
        assert!(!line.contains(TOKEN));
    }

    /// `supabase/.temp/project-ref` is read here, so a value that is not a
    /// ref is refused where it is read: the probe is skipped with the reason
    /// and the token never travels.
    #[test]
    fn a_linked_ref_that_is_not_one_host_label_skips_the_probe_and_says_why() {
        let management = FakeManagement::answering(KEYS);
        for bad in ["evil.example/x#", "ABC", "a b", "a-b"] {
            let fixture = Fixture::new(&[("SUPABASE_ACCESS_TOKEN", TOKEN)], &[]);
            fixture.link(bad);

            assert_eq!(
                skipped(&fixture.inputs(Some(&management))),
                format!(
                    "live Data API probe skipped: supabase/.temp/project-ref holds {bad:?}, which is not a Supabase project ref: expected lowercase letters and digits only"
                ),
                "{bad}"
            );
        }
        assert!(management.seen.borrow().is_empty());
    }

    #[test]
    fn the_token_file_is_a_rung_and_the_keychain_is_not() {
        let fixture = Fixture::new(&[], &[]);
        fixture.link(REF);
        let home = fixture.root().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("access-token"), TOKEN).unwrap();
        let env = Env::from_pairs(&[("SUPABASE_HOME", home.to_str().unwrap())]);
        let management = FakeManagement::answering(KEYS);
        let mut inputs = fixture.inputs(Some(&management));
        inputs.env = &env;

        assert!(resolve(&inputs).is_some());
        assert_eq!(management.seen.borrow()[0].1, TOKEN);

        // The store is fixed by type: a keychain-reading store does not compile here.
        let _: &NoTokenStore = &PROBE_TOKEN_STORE;
    }

    #[test]
    fn every_name_the_ladder_reads_is_kept_from_the_env_files() {
        for name in prefixed(URL_NAME).iter().chain(key_names().iter()) {
            assert!(
                crate::env_file::RECOGNIZED_KEYS.contains(&name.as_str()),
                "{name}"
            );
        }
        assert_eq!(key_names().len() + prefixed(URL_NAME).len(), 21);
    }
}
