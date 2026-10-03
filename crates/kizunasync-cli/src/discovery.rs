//! What this machine already knows about where to connect.
//!
//! Asking "paste a connection string" is the wrong first question for a
//! developer who has already linked a project, already has a `.env`, or already
//! has the local stack running. This module answers the question the CLI should
//! ask instead, by probing, *which* of the connections you already have, in
//! priority order:
//!
//! 1. the project the Supabase CLI is linked to (`SUPABASE_PROJECT_ID`, else
//!    `supabase/.temp/project-ref`),
//! 2. connection strings declared in the project's `.env` files,
//! 3. the local stack on the port `supabase/config.toml` gives it,
//! 4. the user's Supabase account, always offered last.
//!
//! A linked ref is checked where it is read ([`ProjectRef`]): one that is not
//! a valid ref is refused, never skipped for the next rung.
//!
//! Every probe is read-only, offline, and local: files are read and one TCP
//! connect is attempted with a short timeout. Nothing here reads a credential
//! store or the network. The account candidate is offered unconditionally, and
//! its token is resolved only once the user has picked it, so a run that never
//! chooses it never touches the OS keychain, and no keychain prompt can appear
//! before the user has asked for one.
//!
//! a candidate carries a redacted URL and never the credential itself. The
//! caller re-reads the real value from the source it names once the user has
//! chosen it.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::db::{URL_KEYS, parse_config_toml_port, redact_db_url};
use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::project_ref::{InvalidProjectRef, ProjectRef};
use crate::workdir::ProjectPaths;

/// How long the local-stack probe waits for a TCP connect. Long enough for a
/// container that is up, short enough that a stopped stack does not stall the
/// wizard.
const LOCAL_PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// Where the Supabase CLI records the project `supabase link` bound this
/// directory to, relative to `supabase/`.
const LINKED_REF_FILE: [&str; 2] = [".temp", "project-ref"];

/// Names the project ref ahead of the link file, as it does for the Supabase
/// CLI.
pub const PROJECT_ID_ENV: &str = "SUPABASE_PROJECT_ID";

/// The local stack always binds loopback.
const LOCAL_HOST: &str = "127.0.0.1";

/// One way this project could connect, as discovered, plus the manual entry
/// the caller appends, which is the one option that is never discovered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionCandidate {
    /// The project `supabase link` bound this directory to, or the one
    /// `SUPABASE_PROJECT_ID` names.
    LinkedProject {
        /// The project ref.
        project_ref: ProjectRef,
        /// Where the ref was read.
        origin: ProjectRefOrigin,
    },
    /// A connection string declared in one of the project's `.env` files.
    EnvUrl {
        /// The key that declared it.
        key: &'static str,
        /// The file it was declared in.
        file: &'static str,
        /// The URL with its password masked: the only spelling kept here.
        redacted_url: String,
    },
    /// The local Supabase stack.
    Local {
        /// The port `supabase/config.toml` gives Postgres.
        port: u16,
        /// Whether something answered on it just now.
        reachable: bool,
    },
    /// A project from the user's Supabase account. Carries nothing: whether a
    /// token exists is not known until this is chosen, on purpose.
    Account,
    /// Type a connection string instead.
    Manual,
}

/// Where a linked project's ref was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectRefOrigin {
    /// `SUPABASE_PROJECT_ID` in the process environment.
    Env,
    /// `SUPABASE_PROJECT_ID` in the named `.env` file.
    EnvFile(&'static str),
    /// `supabase/.temp/project-ref`, written by `supabase link`.
    LinkFile,
}

impl std::fmt::Display for ProjectRefOrigin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Env => write!(f, "env:{PROJECT_ID_ENV}"),
            Self::EnvFile(file) => write!(f, "{PROJECT_ID_ENV} from {file}"),
            Self::LinkFile => f.write_str("supabase/.temp/project-ref"),
        }
    }
}

impl ConnectionCandidate {
    /// The line the user reads.
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::LinkedProject { project_ref, .. } => format!("Linked project {project_ref}"),
            Self::EnvUrl { key, file, .. } => format!("{key} from {file}"),
            Self::Local { port, .. } => format!("Local Supabase stack (127.0.0.1:{port})"),
            Self::Account => "Choose a project from your Supabase account".to_owned(),
            Self::Manual => "Enter a connection string".to_owned(),
        }
    }

    /// The muted right-hand column.
    #[must_use]
    pub fn hint(&self) -> String {
        match self {
            Self::LinkedProject { origin, .. } => origin.to_string(),
            Self::EnvUrl { redacted_url, .. } => redacted_url.clone(),
            Self::Local { reachable, .. } => if *reachable {
                "running"
            } else {
                "not reachable: start it with `supabase start`"
            }
            .to_owned(),
            Self::Account => "opens supabase login if no token is stored".to_owned(),
            Self::Manual => "session pooler URL, kept in memory only".to_owned(),
        }
    }

    /// Whether this candidate can carry a direct Postgres connection, which is
    /// what reading a catalog and emitting a migration both need. The linked
    /// project can, over a temporary login
    /// ([`linked_connection`](crate::login_role::linked_connection)); an account
    /// project is reached with a token alone, and a local stack nothing answered
    /// on is a connection already known to fail. Callers that offer
    /// [`Self::Manual`] append it themselves: [`discover`] never yields it.
    #[must_use]
    pub const fn is_direct(&self) -> bool {
        matches!(
            self,
            Self::LinkedProject { .. }
                | Self::EnvUrl { .. }
                | Self::Local {
                    reachable: true,
                    ..
                }
                | Self::Manual
        )
    }

    /// Whether this candidate can be the one the cursor opens on. A local stack
    /// nothing answered on is still listed, and explains itself, but proposing
    /// it would propose a connection that is known to fail.
    #[must_use]
    pub const fn is_preselectable(&self) -> bool {
        !matches!(
            self,
            Self::Local {
                reachable: false,
                ..
            } | Self::Manual
        )
    }
}

/// Every connection this project could use, best first, with the account
/// always last.
///
/// # Errors
/// Returns [`InvalidLinkedRef`] when the linked project's ref is not a
/// [`ProjectRef`].
pub fn discover(
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
) -> Result<Vec<ConnectionCandidate>, InvalidLinkedRef> {
    let mut candidates = Vec::new();
    if let Some((project_ref, origin)) = linked_project_ref(paths, env, env_files)? {
        candidates.push(ConnectionCandidate::LinkedProject {
            project_ref,
            origin,
        });
    }
    for key in URL_KEYS.map(|key| key.name) {
        if let Some((url, file)) = env_files.get_with_origin(key) {
            candidates.push(ConnectionCandidate::EnvUrl {
                key,
                file,
                redacted_url: redact_db_url(url),
            });
        }
    }
    if let Some(port) = local_port(paths) {
        candidates.push(ConnectionCandidate::Local {
            port,
            reachable: is_reachable(LOCAL_HOST, port, LOCAL_PROBE_TIMEOUT),
        });
    }
    candidates.push(ConnectionCandidate::Account);

    Ok(candidates)
}

/// Printed when the picker has nothing but the account (and manual entry) to
/// offer, so a short list explains itself rather than looking like something
/// went missing.
pub const NOTHING_DISCOVERABLE: &str = "  no --db-url / KSYNC_DB_URL / DIRECT_URL / POSTGRES_URL_NON_POOLING / DATABASE_URL / POSTGRES_URL / local config found.";

/// The Clack step above the connection picker, with its docs link.
pub use crate::docs::CONNECTION_PHASE;

/// Whether anything but the account (and the caller's manual entry) was found.
/// The one condition worth telling the user about, since it explains why the
/// picker is so short.
#[must_use]
pub fn found_nothing_local(candidates: &[ConnectionCandidate]) -> bool {
    candidates
        .iter()
        .all(|candidate| matches!(candidate, ConnectionCandidate::Account))
}

/// Where the cursor opens: the first candidate worth proposing, or the first
/// one at all when none is.
#[must_use]
pub fn preselected(candidates: &[ConnectionCandidate]) -> Option<usize> {
    if candidates.is_empty() {
        return None;
    }

    Some(
        candidates
            .iter()
            .position(ConnectionCandidate::is_preselectable)
            .unwrap_or_default(),
    )
}

/// The connection string the local stack listens on, the same shape
/// [`resolve_db_url`](crate::db::resolve_db_url) builds for its local rung.
#[must_use]
pub fn local_url(port: u16) -> String {
    format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres")
}

/// A linked project ref that is not a [`ProjectRef`], and where it was read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{origin} holds {value:?}, which is {cause}")]
pub struct InvalidLinkedRef {
    /// Where the value was read.
    pub origin: ProjectRefOrigin,
    /// The value, trimmed.
    pub value: String,
    /// Why it is not a ref.
    pub cause: InvalidProjectRef,
}

/// The linked project ref and where it was read: `SUPABASE_PROJECT_ID` from
/// the process environment, then from the `.env` files, then the ref
/// `supabase link` left, the Supabase CLI's own order. A blank value is no ref
/// and falls through to the next source; any other value is checked here.
///
/// # Errors
/// Returns [`InvalidLinkedRef`] when the first value that is not blank is not
/// a [`ProjectRef`]: a wrong or tampered source is refused, never skipped for
/// the next one.
pub fn linked_project_ref(
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
) -> Result<Option<(ProjectRef, ProjectRefOrigin)>, InvalidLinkedRef> {
    let Some((value, origin)) = linked_value(paths, env, env_files) else {
        return Ok(None);
    };

    match ProjectRef::parse(&value) {
        Ok(project_ref) => Ok(Some((project_ref, origin))),
        Err(cause) => Err(InvalidLinkedRef {
            origin,
            value,
            cause,
        }),
    }
}

/// The first linked value that is not blank, unchecked, and where it was read.
fn linked_value(
    paths: &ProjectPaths,
    env: &Env,
    env_files: &EnvFileValues,
) -> Option<(String, ProjectRefOrigin)> {
    if let Some(project_ref) = env.get(PROJECT_ID_ENV).and_then(non_blank) {
        return Some((project_ref, ProjectRefOrigin::Env));
    }

    if let Some((value, file)) = env_files.get_with_origin(PROJECT_ID_ENV)
        && let Some(project_ref) = non_blank(value)
    {
        return Some((project_ref, ProjectRefOrigin::EnvFile(file)));
    }

    let path = LINKED_REF_FILE
        .iter()
        .fold(paths.supabase_dir.clone(), |path, segment| {
            path.join(segment)
        });
    let project_ref = non_blank(&std::fs::read_to_string(path).ok()?)?;

    Some((project_ref, ProjectRefOrigin::LinkFile))
}

fn non_blank(value: &str) -> Option<String> {
    let trimmed = value.trim();

    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// The local Postgres port, or `None` when this project has no
/// `supabase/config.toml` to give it one.
fn local_port(paths: &ProjectPaths) -> Option<u16> {
    let body = std::fs::read_to_string(&paths.config_toml).ok()?;

    Some(parse_config_toml_port(&body))
}

/// Whether a TCP connect to `host:port` succeeds within `timeout`, trying
/// every address the name resolves to. A name that does not resolve is not
/// reachable.
#[must_use]
pub fn is_reachable(host: &str, port: u16, timeout: Duration) -> bool {
    (host, port).to_socket_addrs().is_ok_and(|mut addresses| {
        addresses.any(|address| TcpStream::connect_timeout(&address, timeout).is_ok())
    })
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::net::TcpListener;
    use std::path::Path;

    use super::*;

    fn project(root: &Path) -> ProjectPaths {
        ProjectPaths::rooted_at(root.to_path_buf())
    }

    fn write_config_toml(root: &Path, body: &str) {
        std::fs::create_dir_all(root.join("supabase")).unwrap();
        std::fs::write(root.join("supabase").join("config.toml"), body).unwrap();
    }

    fn write_linked_ref(root: &Path, body: &str) {
        let temp = root.join("supabase").join(LINKED_REF_FILE[0]);
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join(LINKED_REF_FILE[1]), body).unwrap();
    }

    /// A port nothing listens on: bound, read, then dropped, so the number is
    /// real and provably closed rather than guessed at.
    fn closed_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        port
    }

    /// Everything but the account rung, which is unconditional and so says
    /// nothing about what a probe found.
    fn discovered(dir: &Path, files: &EnvFileValues) -> Vec<ConnectionCandidate> {
        let candidates = discover(&project(dir), &Env::default(), files).unwrap();

        assert_eq!(candidates.last(), Some(&ConnectionCandidate::Account));

        candidates[..candidates.len() - 1].to_vec()
    }

    #[test]
    fn an_empty_project_offers_only_the_account() {
        let dir = tempfile::tempdir().unwrap();
        let candidates = discover(
            &project(dir.path()),
            &Env::default(),
            &EnvFileValues::default(),
        )
        .unwrap();

        assert_eq!(candidates, [ConnectionCandidate::Account]);
        assert!(found_nothing_local(&candidates));
    }

    #[test]
    fn a_linked_project_is_the_first_candidate_and_its_ref_is_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        write_linked_ref(dir.path(), "  abcdefghijklmnopqrst\n");

        assert_eq!(
            discovered(dir.path(), &EnvFileValues::default()),
            [ConnectionCandidate::LinkedProject {
                project_ref: ProjectRef::parse("abcdefghijklmnopqrst").unwrap(),
                origin: ProjectRefOrigin::LinkFile,
            }]
        );
    }

    #[test]
    fn supabase_project_id_outranks_the_link_file_and_names_its_origin() {
        let dir = tempfile::tempdir().unwrap();
        write_linked_ref(dir.path(), "linkedlinkedlinkedli");
        std::fs::write(
            dir.path().join(".env.local"),
            "SUPABASE_PROJECT_ID=fromfilefromfilefrom\n",
        )
        .unwrap();
        let files = crate::env_file::load(dir.path());
        let env = Env::from_pairs(&[(PROJECT_ID_ENV, " fromenvfromenvfromen ")]);

        let from_env = linked_project_ref(&project(dir.path()), &env, &files)
            .unwrap()
            .unwrap();
        assert_eq!(
            from_env,
            (
                ProjectRef::parse("fromenvfromenvfromen").unwrap(),
                ProjectRefOrigin::Env
            )
        );

        let from_file = linked_project_ref(&project(dir.path()), &Env::default(), &files)
            .unwrap()
            .unwrap();
        assert_eq!(
            from_file,
            (
                ProjectRef::parse("fromfilefromfilefrom").unwrap(),
                ProjectRefOrigin::EnvFile(".env.local")
            )
        );

        let candidates = discover(&project(dir.path()), &Env::default(), &files).unwrap();
        assert_eq!(candidates[0].hint(), "SUPABASE_PROJECT_ID from .env.local");
        let candidates = discover(&project(dir.path()), &env, &files).unwrap();
        assert_eq!(candidates[0].hint(), "env:SUPABASE_PROJECT_ID");
        assert_eq!(candidates[0].label(), "Linked project fromenvfromenvfromen");
    }

    #[test]
    fn a_blank_project_id_falls_through_to_the_link_file() {
        let dir = tempfile::tempdir().unwrap();
        write_linked_ref(dir.path(), "linkedlinkedlinkedli\n");
        let env = Env::from_pairs(&[(PROJECT_ID_ENV, "   ")]);
        let candidates = discover(&project(dir.path()), &env, &EnvFileValues::default()).unwrap();

        assert_eq!(
            candidates[0],
            ConnectionCandidate::LinkedProject {
                project_ref: ProjectRef::parse("linkedlinkedlinkedli").unwrap(),
                origin: ProjectRefOrigin::LinkFile,
            }
        );
        assert_eq!(candidates[0].hint(), "supabase/.temp/project-ref");
    }

    #[test]
    fn the_reachability_probe_takes_its_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let open = listener.local_addr().unwrap().port();

        assert!(is_reachable("127.0.0.1", open, Duration::from_millis(300)));
        assert!(!is_reachable(
            "127.0.0.1",
            closed_port(),
            Duration::from_millis(300)
        ));
    }

    #[test]
    fn a_blank_linked_ref_file_is_not_a_candidate() {
        let dir = tempfile::tempdir().unwrap();
        write_linked_ref(dir.path(), "\n  \n");

        assert_eq!(
            discovered(dir.path(), &EnvFileValues::default()),
            Vec::<ConnectionCandidate>::new()
        );
    }

    #[test]
    fn env_file_urls_arrive_in_ladder_order_and_are_redacted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "DATABASE_URL=postgresql://postgres:hunter2@db.example:5432/postgres\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join(".env.local"),
            "KSYNC_DB_URL=postgresql://postgres:s3cr3t@localhost:5432/postgres\n",
        )
        .unwrap();
        let files = crate::env_file::load(dir.path());
        let candidates = discovered(dir.path(), &files);

        assert_eq!(
            candidates,
            [
                ConnectionCandidate::EnvUrl {
                    key: "KSYNC_DB_URL",
                    file: ".env.local",
                    redacted_url: "postgresql://postgres:***@localhost:5432/postgres".to_owned(),
                },
                ConnectionCandidate::EnvUrl {
                    key: "DATABASE_URL",
                    file: ".env",
                    redacted_url: "postgresql://postgres:***@db.example:5432/postgres".to_owned(),
                },
            ]
        );
        let rendered = format!("{candidates:?}");
        assert!(!rendered.contains("hunter2"));
        assert!(!rendered.contains("s3cr3t"));
    }

    #[test]
    fn a_local_stack_nothing_answers_on_is_listed_as_unreachable_and_never_preselected() {
        let dir = tempfile::tempdir().unwrap();
        let port = closed_port();
        write_config_toml(dir.path(), &format!("[db]\nport = {port}\n"));
        let candidates = discovered(dir.path(), &EnvFileValues::default());

        assert_eq!(
            candidates,
            [ConnectionCandidate::Local {
                port,
                reachable: false
            }]
        );
        assert!(candidates[0].hint().contains("not reachable"));
        assert!(!candidates[0].is_preselectable());
        // With the account behind it, the cursor moves off the dead stack.
        assert_eq!(
            preselected(
                &discover(
                    &project(dir.path()),
                    &Env::default(),
                    &EnvFileValues::default()
                )
                .unwrap()
            ),
            Some(1)
        );
    }

    #[test]
    fn a_local_stack_that_answers_is_reachable() {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        write_config_toml(dir.path(), &format!("[db]\nport = {port}\n"));
        let candidates = discovered(dir.path(), &EnvFileValues::default());

        assert_eq!(
            candidates,
            [ConnectionCandidate::Local {
                port,
                reachable: true
            }]
        );
        assert!(candidates[0].is_preselectable());
    }

    #[test]
    fn a_config_toml_without_a_db_port_falls_back_to_the_documented_default() {
        let dir = tempfile::tempdir().unwrap();
        write_config_toml(dir.path(), "[api]\nport = 54321\n");

        assert!(matches!(
            discovered(dir.path(), &EnvFileValues::default()).as_slice(),
            [ConnectionCandidate::Local { port: 54322, .. }]
        ));
    }

    /// The account is offered whether or not a token exists, because finding out
    /// would mean reading the credential store before the user asked for it.
    #[test]
    fn the_account_is_always_offered_and_carries_no_token_state() {
        let dir = tempfile::tempdir().unwrap();
        let candidates = discover(
            &project(dir.path()),
            &Env::default(),
            &EnvFileValues::default(),
        )
        .unwrap();

        assert_eq!(candidates, [ConnectionCandidate::Account]);
        assert_eq!(
            candidates[0].label(),
            "Choose a project from your Supabase account"
        );
        assert!(candidates[0].is_preselectable());
    }

    #[test]
    fn everything_at_once_comes_back_in_priority_order() {
        let dir = tempfile::tempdir().unwrap();
        write_linked_ref(dir.path(), "abcdefghijklmnopqrst");
        write_config_toml(dir.path(), &format!("[db]\nport = {}\n", closed_port()));
        std::fs::write(dir.path().join(".env"), "DATABASE_URL=postgres://x\n").unwrap();
        let files = crate::env_file::load(dir.path());
        let candidates = discover(&project(dir.path()), &Env::default(), &files).unwrap();
        let kinds: Vec<&str> = candidates
            .iter()
            .map(|candidate| match candidate {
                ConnectionCandidate::LinkedProject { .. } => "linked",
                ConnectionCandidate::EnvUrl { .. } => "env",
                ConnectionCandidate::Local { .. } => "local",
                ConnectionCandidate::Account => "account",
                ConnectionCandidate::Manual => "manual",
            })
            .collect();

        assert_eq!(kinds, ["linked", "env", "local", "account"]);
        assert_eq!(preselected(&candidates), Some(0));
        assert!(!found_nothing_local(&candidates));
    }

    /// The predicate both connection pickers filter on when the command they
    /// serve introspects a live schema.
    #[test]
    fn a_connection_string_and_the_linked_project_are_direct_never_the_account_or_a_dead_stack() {
        assert!(ConnectionCandidate::Manual.is_direct());
        assert!(
            ConnectionCandidate::EnvUrl {
                key: "DATABASE_URL",
                file: ".env",
                redacted_url: "postgres://x".to_owned(),
            }
            .is_direct()
        );
        assert!(
            ConnectionCandidate::Local {
                port: 54322,
                reachable: true
            }
            .is_direct()
        );
        assert!(
            !ConnectionCandidate::Local {
                port: 54322,
                reachable: false
            }
            .is_direct()
        );
        assert!(!ConnectionCandidate::Account.is_direct());
        assert!(
            ConnectionCandidate::LinkedProject {
                project_ref: ProjectRef::parse("abcdefghijklmnopqrst").unwrap(),
                origin: ProjectRefOrigin::LinkFile,
            }
            .is_direct()
        );
    }

    #[test]
    fn the_cursor_skips_an_unreachable_local_stack() {
        let candidates = [
            ConnectionCandidate::Local {
                port: 54322,
                reachable: false,
            },
            ConnectionCandidate::Account,
        ];

        assert_eq!(preselected(&candidates), Some(1));
        assert_eq!(preselected(&[]), None);
        assert_eq!(preselected(&[ConnectionCandidate::Manual]), Some(0));
    }

    #[test]
    fn the_local_url_matches_the_ladders_own_local_rung() {
        assert_eq!(
            local_url(55555),
            "postgresql://postgres:postgres@127.0.0.1:55555/postgres"
        );
    }

    /// `supabase/.temp/project-ref` is a local file, so a value that is not
    /// a ref is refused where it is read, naming the file, and discovery
    /// offers nothing built on it.
    #[test]
    fn a_link_file_that_holds_no_valid_ref_is_refused_where_it_is_read() {
        let dir = tempfile::tempdir().unwrap();
        write_linked_ref(dir.path(), "evil.example/x#\n");
        let refused = InvalidLinkedRef {
            origin: ProjectRefOrigin::LinkFile,
            value: "evil.example/x#".to_owned(),
            cause: InvalidProjectRef,
        };

        assert_eq!(
            linked_project_ref(
                &project(dir.path()),
                &Env::default(),
                &EnvFileValues::default()
            ),
            Err(refused.clone())
        );
        assert_eq!(
            discover(
                &project(dir.path()),
                &Env::default(),
                &EnvFileValues::default()
            ),
            Err(refused.clone())
        );
        assert_eq!(
            refused.to_string(),
            "supabase/.temp/project-ref holds \"evil.example/x#\", which is not a Supabase project ref: expected lowercase letters and digits only"
        );
    }

    /// The same check covers `SUPABASE_PROJECT_ID`, and an invalid value
    /// there is refused rather than skipped for the link file behind it.
    #[test]
    fn an_invalid_project_id_is_refused_not_skipped_for_the_link_file() {
        let dir = tempfile::tempdir().unwrap();
        write_linked_ref(dir.path(), "linkedlinkedlinkedli");
        let env = Env::from_pairs(&[(PROJECT_ID_ENV, "Not-A-Ref")]);

        assert_eq!(
            linked_project_ref(&project(dir.path()), &env, &EnvFileValues::default()),
            Err(InvalidLinkedRef {
                origin: ProjectRefOrigin::Env,
                value: "Not-A-Ref".to_owned(),
                cause: InvalidProjectRef,
            })
        );
    }
}
