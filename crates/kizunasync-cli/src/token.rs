//! Where a Personal Access Token already lives on this machine.
//!
//! A developer who has run `supabase login` already has a token; asking them to
//! paste one again is asking for the wrong thing twice. This module is the
//! ladder that finds it, in the order an explicit input must always beat an
//! ambient one: the `--access-token` flag, `SUPABASE_ACCESS_TOKEN` in the
//! process environment, the same key in the project's `.env` files, the OS
//! credential store the Supabase CLI writes to (the current profile's account,
//! then the `access-token` account older logins used), then `access-token` in the
//! Supabase home directory (`SUPABASE_HOME`, else `~/.supabase`).
//!
//! Every rung is validated against the token's documented shape before it is
//! accepted, and a rung that is malformed, or that errors, as a locked keychain
//! does: degrades to the next one silently. A wrong token found for the user is
//! worse than no token: it produces a 401 whose cause is invisible.
//!
//! no value here is ever logged, echoed, or written. Only a [`TokenOrigin`]
//! is ever printed.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use regex::Regex;

use crate::env::Env;
use crate::env_file::EnvFileValues;

/// The environment variable the Supabase CLI and `kizunasync` both read.
pub const ACCESS_TOKEN_ENV: &str = "SUPABASE_ACCESS_TOKEN";

/// Where a human creates a PAT when `supabase login` is not available.
pub const TOKENS_PAGE: &str = "https://supabase.com/dashboard/account/tokens";

/// The credential-store service the Supabase CLI writes under.
const KEYRING_SERVICE: &str = "Supabase CLI";

/// The account older Supabase CLI logins wrote to, still read after the
/// profile's own account for backwards compatibility, as the Supabase CLI does.
const LEGACY_KEYRING_ACCOUNT: &str = "access-token";

/// Selects the Supabase CLI profile, and so the keyring account a login wrote.
const PROFILE_ENV: &str = "SUPABASE_PROFILE";

/// The profile the Supabase CLI uses when neither the environment nor
/// `<home>/profile` names one.
const DEFAULT_PROFILE: &str = "supabase";

/// Relocates the Supabase CLI's home directory.
const SUPABASE_HOME_ENV: &str = "SUPABASE_HOME";

/// The Supabase CLI's home directory, relative to the user's home.
const SUPABASE_HOME_DIR: &str = ".supabase";

/// The file fallback, relative to the Supabase home directory.
const TOKEN_FILE: &str = "access-token";

/// The file `supabase` writes the current profile name to, relative to the
/// Supabase home directory.
const PROFILE_FILE: &str = "profile";

/// go-keyring (the Supabase CLI's Go library) stores values it considers unsafe
/// for the platform store base64-encoded behind this marker.
const KEYRING_BASE64_PREFIX: &str = "go-keyring-base64:";

/// go-keyring writes padded standard base64. Padding is accepted either way
/// rather than required, so a value that lost its `=` still decodes instead of
/// silently dropping the whole rung.
const KEYRING_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// The home directory, per platform. Read from the session environment rather
/// than the process so the ladder stays testable.
const HOME_KEYS: [&str; 2] = ["HOME", "USERPROFILE"];

/// A Personal Access Token: `sbp_` (optionally `sbp_oauth_`, or the dashboard's
/// `sbp_v0_`) plus 40 lowercase hex characters, the Supabase CLI's own pattern.
/// Service-role keys and JWTs are rejected by construction.
const TOKEN_PATTERN: &str = r"^sbp_(oauth_|v0_)?[a-f0-9]{40}$";

/// Which rung of the ladder produced the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenOrigin {
    /// The `--access-token` flag.
    Flag,
    /// `SUPABASE_ACCESS_TOKEN` in the process environment.
    Env,
    /// `SUPABASE_ACCESS_TOKEN` in the named `.env` file.
    EnvFile(&'static str),
    /// The OS credential store, written by `supabase login`, under the named
    /// account.
    Keyring(KeyringAccount),
    /// `access-token` in the Supabase home directory, spelled as the path it
    /// was read from, with `~` for the user's home.
    File(String),
}

/// Which credential-store account answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyringAccount {
    /// The account named after the current Supabase CLI profile.
    Profile(String),
    /// The `access-token` account older logins wrote to.
    Legacy,
}

impl std::fmt::Display for TokenOrigin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Flag => f.write_str("flag"),
            Self::Env => write!(f, "env:{ACCESS_TOKEN_ENV}"),
            Self::EnvFile(file) => write!(f, "{ACCESS_TOKEN_ENV} from {file}"),
            Self::Keyring(KeyringAccount::Profile(profile)) => {
                write!(f, "OS credential store (profile {profile})")
            }
            Self::Keyring(KeyringAccount::Legacy) => {
                write!(f, "OS credential store (legacy {LEGACY_KEYRING_ACCOUNT})")
            }
            Self::File(path) => f.write_str(path),
        }
    }
}

/// A token and the rung it came from. The token itself is never displayed:
/// `Debug` is written by hand so it renders masked.
#[derive(Clone)]
pub struct DiscoveredToken {
    /// The secret. Never logged, never written.
    pub token: String,
    /// Where it was found: the only half that is ever printed.
    pub origin: TokenOrigin,
}

impl std::fmt::Debug for DiscoveredToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DiscoveredToken")
            .field("token", &"***")
            .field("origin", &self.origin)
            .finish()
    }
}

/// The OS credential store, narrowed to the one read this ladder needs so the
/// chain is testable without a keychain (and so no test can pop a keychain
/// prompt on a developer's machine).
pub trait TokenStore {
    /// The secret stored under `account` in the Supabase CLI's service, or
    /// `None` when there is none, or when the store could not be read at all,
    /// which is not distinguishable to a caller that moves to the next rung.
    fn read(&self, account: &str) -> Option<String>;
}

/// The real credential store: Keychain, Credential Manager, or Secret Service.
pub struct KeyringStore;

impl TokenStore for KeyringStore {
    fn read(&self, account: &str) -> Option<String> {
        keyring::Entry::new(KEYRING_SERVICE, account)
            .ok()?
            .get_password()
            .ok()
    }
}

/// A store that never answers: the wiring for every path that must not touch a
/// keychain (non-interactive runs, tests).
pub struct NoTokenStore;

impl TokenStore for NoTokenStore {
    fn read(&self, _account: &str) -> Option<String> {
        None
    }
}

/// Walk the ladder and return the first valid token, or `None`.
#[must_use]
pub fn discover_token(
    flag: Option<&str>,
    env: &Env,
    env_files: &EnvFileValues,
    store: &dyn TokenStore,
) -> Option<DiscoveredToken> {
    if let Some(token) = flag.and_then(accept) {
        return Some(DiscoveredToken {
            token,
            origin: TokenOrigin::Flag,
        });
    }

    if let Some(token) = env.get(ACCESS_TOKEN_ENV).and_then(accept) {
        return Some(DiscoveredToken {
            token,
            origin: TokenOrigin::Env,
        });
    }

    if let Some((value, file)) = env_files.get_with_origin(ACCESS_TOKEN_ENV)
        && let Some(token) = accept(value)
    {
        return Some(DiscoveredToken {
            token,
            origin: TokenOrigin::EnvFile(file),
        });
    }

    let profile = profile_name(env);
    let accounts = [
        (profile.as_str(), KeyringAccount::Profile(profile.clone())),
        (LEGACY_KEYRING_ACCOUNT, KeyringAccount::Legacy),
    ];
    for (account, answered) in accounts {
        if let Some(token) = store
            .read(account)
            .as_deref()
            .and_then(decode_stored)
            .as_deref()
            .and_then(accept)
        {
            return Some(DiscoveredToken {
                token,
                origin: TokenOrigin::Keyring(answered),
            });
        }
    }

    if let Some(path) = token_file_path(env)
        && let Some(token) = std::fs::read_to_string(&path)
            .ok()
            .as_deref()
            .and_then(accept)
    {
        return Some(DiscoveredToken {
            token,
            origin: TokenOrigin::File(display_path(&path, env)),
        });
    }

    None
}

/// Whether `value` has the documented Personal Access Token shape.
#[must_use]
pub fn is_valid_token(value: &str) -> bool {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();

    // TOKEN_PATTERN is a fixed literal the crate's own tests exercise; a
    // compile failure here would be a build-time bug, not a runtime one, so it
    // degrades to "no token matches" rather than panicking.
    PATTERN
        .get_or_init(|| Regex::new(TOKEN_PATTERN).ok())
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(value))
}

/// A rung's raw value, trimmed and validated. Anything else is `None`, which is
/// what makes an invalid rung degrade to the next instead of failing the run.
fn accept(value: &str) -> Option<String> {
    let token = value.trim();

    is_valid_token(token).then(|| token.to_owned())
}

/// The credential store's value, with go-keyring's base64 envelope removed when
/// it is there. A marked value that does not decode is dropped rather than used
/// as-is: the marker means the bytes are encoded, so the raw form is not a token.
fn decode_stored(raw: &str) -> Option<String> {
    let Some(encoded) = raw.trim().strip_prefix(KEYRING_BASE64_PREFIX) else {
        return Some(raw.to_owned());
    };

    String::from_utf8(KEYRING_BASE64.decode(encoded.trim()).ok()?).ok()
}

/// `path` as the user would type it: `~/…` when it lies under the home
/// directory, the full path otherwise.
fn display_path(path: &Path, env: &Env) -> String {
    HOME_KEYS
        .iter()
        .find_map(|key| env.get(key))
        .and_then(|home| path.strip_prefix(home).ok())
        .map_or_else(
            || path.display().to_string(),
            |relative| format!("~/{}", relative.display()),
        )
}

fn token_file_path(env: &Env) -> Option<PathBuf> {
    Some(supabase_home(env)?.join(TOKEN_FILE))
}

/// The Supabase CLI's home directory: `SUPABASE_HOME`, else `.supabase` under
/// the user's home. `None` when the session names neither.
fn supabase_home(env: &Env) -> Option<PathBuf> {
    if let Some(home) = env.get(SUPABASE_HOME_ENV) {
        return Some(PathBuf::from(home));
    }

    let home = HOME_KEYS.iter().find_map(|key| env.get(key))?;

    Some(PathBuf::from(home).join(SUPABASE_HOME_DIR))
}

/// The current Supabase CLI profile: `SUPABASE_PROFILE`, else the trimmed
/// content of `<home>/profile` when it is not blank, else the default.
fn profile_name(env: &Env) -> String {
    if let Some(profile) = env.get(PROFILE_ENV) {
        return profile.to_owned();
    }

    supabase_home(env)
        .and_then(|home| std::fs::read_to_string(home.join(PROFILE_FILE)).ok())
        .map(|body| body.trim().to_owned())
        .filter(|profile| !profile.is_empty())
        .unwrap_or_else(|| DEFAULT_PROFILE.to_owned())
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// Four distinguishable, structurally valid tokens, one per rung, so a
    /// test that asserts precedence cannot pass on the wrong one.
    const FLAG_TOKEN: &str = "sbp_0000000000000000000000000000000000000001";
    const ENV_TOKEN: &str = "sbp_0000000000000000000000000000000000000002";
    const FILE_ENV_TOKEN: &str = "sbp_0000000000000000000000000000000000000003";
    const KEYRING_TOKEN: &str = "sbp_0000000000000000000000000000000000000004";
    const HOME_FILE_TOKEN: &str = "sbp_0000000000000000000000000000000000000005";

    /// Two more, for the keyring's profile-keyed and legacy accounts.
    const PROFILE_TOKEN: &str = "sbp_0000000000000000000000000000000000000006";
    const LEGACY_TOKEN: &str = "sbp_0000000000000000000000000000000000000007";

    /// A credential store keyed by account, the way the Supabase CLI's service
    /// is.
    struct FakeStore(Vec<(String, String)>);

    impl FakeStore {
        /// A value under the default profile's account.
        fn holding(value: &str) -> Self {
            Self::empty().with(DEFAULT_PROFILE, value)
        }

        fn empty() -> Self {
            Self(Vec::new())
        }

        fn with(mut self, account: &str, value: &str) -> Self {
            self.0.push((account.to_owned(), value.to_owned()));
            self
        }
    }

    impl TokenStore for FakeStore {
        fn read(&self, account: &str) -> Option<String> {
            self.0
                .iter()
                .find(|(stored, _)| stored == account)
                .map(|(_, value)| value.clone())
        }
    }

    fn default_profile() -> TokenOrigin {
        TokenOrigin::Keyring(KeyringAccount::Profile(DEFAULT_PROFILE.to_owned()))
    }

    /// A home directory holding `~/.supabase/access-token`, plus the `Env` that
    /// points at it.
    fn home_with_token(body: &str) -> (tempfile::TempDir, Env) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(SUPABASE_HOME_DIR)).unwrap();
        std::fs::write(dir.path().join(SUPABASE_HOME_DIR).join(TOKEN_FILE), body).unwrap();
        let env = Env::from_pairs(&[("HOME", &dir.path().display().to_string())]);

        (dir, env)
    }

    fn env_file_with(value: &str) -> (tempfile::TempDir, EnvFileValues) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            format!("{ACCESS_TOKEN_ENV}={value}\n"),
        )
        .unwrap();
        let values = crate::env_file::load(dir.path());

        (dir, values)
    }

    #[test]
    fn a_discovered_token_never_debug_prints_the_secret() {
        let found = DiscoveredToken {
            token: FLAG_TOKEN.to_owned(),
            origin: TokenOrigin::Flag,
        };
        let rendered = format!("{found:?}");

        assert!(!rendered.contains(FLAG_TOKEN), "{rendered}");
        assert!(rendered.contains("Flag"), "{rendered}");
    }

    #[test]
    fn the_flag_wins_over_every_other_rung() {
        let (_guard, env) = home_with_token(HOME_FILE_TOKEN);
        let (_files_guard, files) = env_file_with(FILE_ENV_TOKEN);
        let found = discover_token(
            Some(FLAG_TOKEN),
            &env,
            &files,
            &FakeStore::holding(KEYRING_TOKEN),
        )
        .unwrap();

        assert_eq!(found.token, FLAG_TOKEN);
        assert_eq!(found.origin, TokenOrigin::Flag);
    }

    #[test]
    fn the_process_environment_outranks_the_env_files_the_keyring_and_the_file() {
        let (dir, _) = home_with_token(HOME_FILE_TOKEN);
        let env = Env::from_pairs(&[
            ("HOME", &dir.path().display().to_string()),
            (ACCESS_TOKEN_ENV, ENV_TOKEN),
        ]);
        let (_files_guard, files) = env_file_with(FILE_ENV_TOKEN);
        let found = discover_token(None, &env, &files, &FakeStore::holding(KEYRING_TOKEN)).unwrap();

        assert_eq!(found.token, ENV_TOKEN);
        assert_eq!(found.origin, TokenOrigin::Env);
    }

    #[test]
    fn an_env_file_outranks_the_keyring_and_names_the_file_it_came_from() {
        let (_files_guard, files) = env_file_with(FILE_ENV_TOKEN);
        let found = discover_token(
            None,
            &Env::default(),
            &files,
            &FakeStore::holding(KEYRING_TOKEN),
        )
        .unwrap();

        assert_eq!(found.token, FILE_ENV_TOKEN);
        assert_eq!(found.origin, TokenOrigin::EnvFile(".env"));
        assert_eq!(found.origin.to_string(), "SUPABASE_ACCESS_TOKEN from .env");
    }

    #[test]
    fn the_keyring_outranks_the_home_file() {
        let (_guard, env) = home_with_token(HOME_FILE_TOKEN);
        let found = discover_token(
            None,
            &env,
            &EnvFileValues::default(),
            &FakeStore::holding(KEYRING_TOKEN),
        )
        .unwrap();

        assert_eq!(found.token, KEYRING_TOKEN);
        assert_eq!(found.origin, default_profile());
    }

    #[test]
    fn the_home_file_is_the_last_rung_and_is_trimmed() {
        let (_guard, env) = home_with_token(&format!("  {HOME_FILE_TOKEN}\n"));
        let found =
            discover_token(None, &env, &EnvFileValues::default(), &FakeStore::empty()).unwrap();

        assert_eq!(found.token, HOME_FILE_TOKEN);
        assert_eq!(
            found.origin,
            TokenOrigin::File("~/.supabase/access-token".to_owned())
        );
        assert_eq!(found.origin.to_string(), "~/.supabase/access-token");
    }

    #[test]
    fn a_base64_wrapped_keyring_value_is_decoded() {
        // base64 of KEYRING_TOKEN, as go-keyring would have written it.
        let encoded = "c2JwXzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDQ=";
        let found = discover_token(
            None,
            &Env::default(),
            &EnvFileValues::default(),
            &FakeStore::holding(&format!("{KEYRING_BASE64_PREFIX}{encoded}")),
        )
        .unwrap();

        assert_eq!(found.token, KEYRING_TOKEN);
        assert_eq!(found.origin, default_profile());
    }

    #[test]
    fn a_marked_value_that_does_not_decode_is_dropped_rather_than_used_raw() {
        assert_eq!(decode_stored(&format!("{KEYRING_BASE64_PREFIX}!!!!")), None);
        assert_eq!(decode_stored("plain"), Some("plain".to_owned()));
        // An empty envelope decodes to an empty string, which the pattern rejects.
        assert_eq!(
            decode_stored(&format!("{KEYRING_BASE64_PREFIX} ")),
            Some(String::new())
        );
        assert_eq!(accept(""), None);
    }

    /// The envelope decodes with or without its padding, and a byte outside the
    /// standard alphabet fails the rung instead of decoding to something else.
    #[test]
    fn the_envelope_takes_padding_as_optional_and_rejects_a_foreign_alphabet() {
        let padded = format!("{KEYRING_BASE64_PREFIX}aGk=");
        let unpadded = format!("{KEYRING_BASE64_PREFIX}aGk");

        assert_eq!(decode_stored(&padded), Some("hi".to_owned()));
        assert_eq!(decode_stored(&unpadded), Some("hi".to_owned()));
        assert_eq!(
            decode_stored(&format!("{KEYRING_BASE64_PREFIX}YQ==")),
            Some("a".to_owned())
        );
        assert_eq!(decode_stored(&format!("{KEYRING_BASE64_PREFIX}aG-k")), None);
    }

    #[test]
    fn a_malformed_rung_degrades_to_the_next_instead_of_failing() {
        let (_guard, env) = home_with_token(HOME_FILE_TOKEN);
        let found = discover_token(
            Some("not-a-token"),
            &env,
            &EnvFileValues::default(),
            &FakeStore::holding("sbp_TOO_SHORT"),
        )
        .unwrap();

        assert_eq!(found.token, HOME_FILE_TOKEN);
        assert_eq!(found.origin.to_string(), "~/.supabase/access-token");
    }

    #[test]
    fn nothing_anywhere_is_none_rather_than_an_error() {
        assert!(
            discover_token(
                None,
                &Env::default(),
                &EnvFileValues::default(),
                &FakeStore::empty(),
            )
            .is_none()
        );
    }

    #[test]
    fn the_pattern_accepts_both_documented_spellings_and_nothing_else() {
        assert!(is_valid_token(&format!("sbp_{}", "a".repeat(40))));
        assert!(is_valid_token(&format!("sbp_oauth_{}", "0".repeat(40))));

        assert!(!is_valid_token(&format!("sbp_{}", "A".repeat(40))));
        assert!(!is_valid_token(&format!("sbp_{}", "a".repeat(39))));
        assert!(!is_valid_token(&format!("sbp_{}", "a".repeat(41))));
        assert!(!is_valid_token("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
        assert!(!is_valid_token(
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig"
        ));
        assert!(!is_valid_token("sb_secret_live_abcdefghijklmnopqrstuv"));
        assert!(!is_valid_token("service_role"));
        assert!(!is_valid_token(""));
    }

    #[test]
    fn the_pattern_accepts_a_dashboard_v0_token() {
        assert!(is_valid_token(&format!("sbp_v0_{}", "c".repeat(40))));
        assert!(!is_valid_token(&format!("sbp_v1_{}", "c".repeat(40))));
        assert!(!is_valid_token(&format!("sbp_v0_{}", "c".repeat(39))));
    }

    #[test]
    fn the_profile_account_outranks_the_legacy_account() {
        let store = FakeStore::empty()
            .with(LEGACY_KEYRING_ACCOUNT, LEGACY_TOKEN)
            .with(DEFAULT_PROFILE, PROFILE_TOKEN);
        let found =
            discover_token(None, &Env::default(), &EnvFileValues::default(), &store).unwrap();

        assert_eq!(found.token, PROFILE_TOKEN);
        assert_eq!(found.origin, default_profile());
        assert_eq!(
            found.origin.to_string(),
            "OS credential store (profile supabase)"
        );
    }

    #[test]
    fn the_legacy_account_answers_when_the_profile_account_is_empty() {
        let store = FakeStore::empty().with(LEGACY_KEYRING_ACCOUNT, LEGACY_TOKEN);
        let found =
            discover_token(None, &Env::default(), &EnvFileValues::default(), &store).unwrap();

        assert_eq!(found.token, LEGACY_TOKEN);
        assert_eq!(found.origin, TokenOrigin::Keyring(KeyringAccount::Legacy));
        assert_eq!(
            found.origin.to_string(),
            "OS credential store (legacy access-token)"
        );
    }

    #[test]
    fn a_malformed_profile_value_degrades_to_the_legacy_account() {
        let store = FakeStore::empty()
            .with(DEFAULT_PROFILE, "sbp_TOO_SHORT")
            .with(LEGACY_KEYRING_ACCOUNT, LEGACY_TOKEN);
        let found =
            discover_token(None, &Env::default(), &EnvFileValues::default(), &store).unwrap();

        assert_eq!(found.origin, TokenOrigin::Keyring(KeyringAccount::Legacy));
    }

    #[test]
    fn supabase_profile_selects_the_keyring_account() {
        let store = FakeStore::empty()
            .with(DEFAULT_PROFILE, KEYRING_TOKEN)
            .with("staging", PROFILE_TOKEN);
        let env = Env::from_pairs(&[(PROFILE_ENV, "staging")]);
        let found = discover_token(None, &env, &EnvFileValues::default(), &store).unwrap();

        assert_eq!(found.token, PROFILE_TOKEN);
        assert_eq!(
            found.origin,
            TokenOrigin::Keyring(KeyringAccount::Profile("staging".to_owned()))
        );
    }

    #[test]
    fn the_home_profile_file_selects_the_keyring_account_and_the_env_outranks_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(SUPABASE_HOME_DIR)).unwrap();
        std::fs::write(
            dir.path().join(SUPABASE_HOME_DIR).join(PROFILE_FILE),
            "  staging\n",
        )
        .unwrap();
        let home = dir.path().display().to_string();

        assert_eq!(
            profile_name(&Env::from_pairs(&[("HOME", &home)])),
            "staging"
        );
        assert_eq!(
            profile_name(&Env::from_pairs(&[("HOME", &home), (PROFILE_ENV, "prod")])),
            "prod"
        );

        let store = FakeStore::empty().with("staging", PROFILE_TOKEN);
        let found = discover_token(
            None,
            &Env::from_pairs(&[("HOME", &home)]),
            &EnvFileValues::default(),
            &store,
        )
        .unwrap();

        assert_eq!(found.token, PROFILE_TOKEN);
    }

    #[test]
    fn a_blank_profile_file_falls_back_to_the_default_profile() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(SUPABASE_HOME_DIR)).unwrap();
        std::fs::write(dir.path().join(SUPABASE_HOME_DIR).join(PROFILE_FILE), " \n").unwrap();
        let env = Env::from_pairs(&[("HOME", &dir.path().display().to_string())]);

        assert_eq!(profile_name(&env), DEFAULT_PROFILE);
        assert_eq!(profile_name(&Env::default()), DEFAULT_PROFILE);
    }

    #[test]
    fn supabase_home_relocates_the_token_file_and_the_profile_file() {
        let (_user_home, user_env) = home_with_token(KEYRING_TOKEN);
        let relocated = tempfile::tempdir().unwrap();
        std::fs::write(relocated.path().join(TOKEN_FILE), HOME_FILE_TOKEN).unwrap();
        std::fs::write(relocated.path().join(PROFILE_FILE), "relocated").unwrap();
        let user_home = user_env.get("HOME").unwrap().to_owned();
        let env = Env::from_pairs(&[
            ("HOME", &user_home),
            (SUPABASE_HOME_ENV, &relocated.path().display().to_string()),
        ]);

        assert_eq!(
            token_file_path(&env),
            Some(relocated.path().join(TOKEN_FILE))
        );
        assert_eq!(profile_name(&env), "relocated");

        let found =
            discover_token(None, &env, &EnvFileValues::default(), &FakeStore::empty()).unwrap();

        assert_eq!(found.token, HOME_FILE_TOKEN);
        assert_eq!(
            found.origin,
            TokenOrigin::File(relocated.path().join(TOKEN_FILE).display().to_string()),
            "a home outside the user's home is printed in full"
        );
    }

    #[test]
    fn a_relocated_home_under_the_users_home_keeps_the_tilde() {
        assert_eq!(
            display_path(
                Path::new("/users/x/config/supabase/access-token"),
                &Env::from_pairs(&[("HOME", "/users/x")])
            ),
            "~/config/supabase/access-token"
        );
        assert_eq!(
            display_path(Path::new("/elsewhere/access-token"), &Env::default()),
            "/elsewhere/access-token"
        );
    }

    #[test]
    fn an_empty_supabase_home_is_unset() {
        let env = Env::from_pairs(&[(SUPABASE_HOME_ENV, ""), ("HOME", "/users/x")]);

        assert_eq!(
            token_file_path(&env),
            Some(PathBuf::from("/users/x/.supabase/access-token"))
        );
    }

    #[test]
    fn a_session_without_a_home_directory_simply_has_no_file_rung() {
        assert_eq!(token_file_path(&Env::default()), None);
        assert_eq!(
            token_file_path(&Env::from_pairs(&[("USERPROFILE", "/users/x")])),
            Some(PathBuf::from("/users/x/.supabase/access-token"))
        );
    }
}
