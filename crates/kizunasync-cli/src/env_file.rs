//! The project's `.env` files, read as data.
//!
//! An app keeps its Postgres URL in `.env` far more often than in the shell, so
//! the connection ladder consults those files: always after the process
//! environment, never before it, and always named as such when it reports where
//! a connection came from.
//!
//! Two narrowings keep this honest. Only the keys `kizunasync` itself resolves are
//! kept, so nothing else in a developer's `.env` is ever held in memory, and
//! no value is ever logged . And the parser is deliberately small: `KEY=value`
//! with an optional `export `, `#` comments, and one pair of surrounding quotes.
//! It is not a dotenv implementation: no interpolation, no multi-line values, no
//! escapes. A line it does not understand is skipped, never guessed at.

use std::collections::BTreeMap;
use std::path::Path;

/// The files read, lowest precedence first: a later file's value replaces an
/// earlier one.
pub const FILE_NAMES: [&str; 4] = [
    ".env",
    ".env.development",
    ".env.local",
    ".env.development.local",
];

/// The only keys kept, for the reason the module docs give. The connection
/// strings come first, in [`URL_KEYS`](crate::db::URL_KEYS) order; the Data API
/// URL and key names `doctor`'s live probe reads close the list.
pub(crate) const RECOGNIZED_KEYS: [&str; 29] = [
    "KSYNC_DB_URL",
    "DIRECT_URL",
    "POSTGRES_URL_NON_POOLING",
    "DATABASE_URL",
    "POSTGRES_URL",
    "SUPABASE_DB_PASSWORD",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_PROJECT_ID",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEYS",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "EXPO_PUBLIC_SUPABASE_URL",
    "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "EXPO_PUBLIC_SUPABASE_ANON_KEY",
    "PUBLIC_SUPABASE_URL",
    "PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "PUBLIC_SUPABASE_ANON_KEY",
];

/// The recognized values a project's `.env` files declare, each paired with the
/// file it came from: provenance a connection log has to be able to name.
#[derive(Debug, Clone, Default)]
pub struct EnvFileValues(BTreeMap<String, (String, &'static str)>);

impl EnvFileValues {
    /// The value of `key`, treating an empty string as unset: the rule
    /// [`Env::get`](crate::env::Env::get) applies to the process environment.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.get_with_origin(key).map(|(value, _)| value)
    }

    /// The value of `key` and the file that declared it, one of [`FILE_NAMES`].
    #[must_use]
    pub fn get_with_origin(&self, key: &str) -> Option<(&str, &'static str)> {
        self.0
            .get(key)
            .map(|(value, file)| (value.as_str(), *file))
            .filter(|(value, _)| !value.is_empty())
    }
}

/// Read every one of [`FILE_NAMES`] under `root`, in order.
///
/// A missing or unreadable file yields no values rather than a failure: `.env`
/// is optional everywhere `kizunasync` runs.
#[must_use]
pub fn load(root: &Path) -> EnvFileValues {
    let mut values = BTreeMap::new();
    for name in FILE_NAMES {
        let Ok(body) = std::fs::read_to_string(root.join(name)) else {
            continue;
        };
        for line in body.lines() {
            if let Some((key, value)) = parse_line(line) {
                values.insert(key.to_owned(), (value.to_owned(), name));
            }
        }
    }

    EnvFileValues(values)
}

/// One `KEY=value` assignment, or `None` for a blank line, a comment, a
/// malformed line, or a key we do not read.
fn parse_line(raw: &str) -> Option<(&str, &str)> {
    let line = raw.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    let assignment = line.strip_prefix("export ").map_or(line, str::trim_start);
    let (key, value) = assignment.split_once('=')?;
    let key = key.trim();
    if !RECOGNIZED_KEYS.contains(&key) {
        return None;
    }

    Some((key, unquote(value.trim())))
}

/// One pair of matching quotes, stripped. An unbalanced quote is part of the
/// value: guessing at it would invent a connection string.
fn unquote(value: &str) -> &str {
    for quote in ['"', '\''] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            return inner;
        }
    }

    value
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn write(root: &Path, name: &str, body: &str) {
        std::fs::write(root.join(name), body).unwrap();
    }

    #[test]
    fn a_directory_without_env_files_yields_nothing_rather_than_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let values = load(dir.path());

        assert_eq!(values.get("DATABASE_URL"), None);
    }

    #[test]
    fn comments_blank_lines_export_and_quotes_are_all_handled() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".env",
            "# a comment\n\
             \n\
             export KSYNC_DB_URL=postgres://exported\n\
             DATABASE_URL = \"postgres://quoted\"\n\
             SUPABASE_DB_PASSWORD='single'\n",
        );
        let values = load(dir.path());

        assert_eq!(values.get("KSYNC_DB_URL"), Some("postgres://exported"));
        assert_eq!(values.get("DATABASE_URL"), Some("postgres://quoted"));
        assert_eq!(values.get("SUPABASE_DB_PASSWORD"), Some("single"));
    }

    #[test]
    fn malformed_lines_and_unread_keys_are_skipped_silently() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".env",
            "not an assignment\n\
             =novalue\n\
             SOMETHING_ELSE=kept-out\n\
             #DATABASE_URL=commented\n\
             DATABASE_URL=postgres://kept\n",
        );
        let values = load(dir.path());

        assert_eq!(values.get("DATABASE_URL"), Some("postgres://kept"));
        assert_eq!(values.get("SOMETHING_ELSE"), None);
    }

    #[test]
    fn an_unbalanced_quote_stays_part_of_the_value() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), ".env", "DATABASE_URL=\"postgres://open\n");

        assert_eq!(
            load(dir.path()).get("DATABASE_URL"),
            Some("\"postgres://open")
        );
    }

    #[test]
    fn env_local_overrides_env_key_by_key() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".env",
            "DATABASE_URL=postgres://base\nKSYNC_DB_URL=postgres://only-in-base\n",
        );
        write(dir.path(), ".env.local", "DATABASE_URL=postgres://local\n");
        let values = load(dir.path());

        assert_eq!(values.get("DATABASE_URL"), Some("postgres://local"));
        assert_eq!(values.get("KSYNC_DB_URL"), Some("postgres://only-in-base"));
    }

    #[test]
    fn each_value_remembers_which_file_declared_it() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".env",
            "DATABASE_URL=postgres://base\nKSYNC_DB_URL=postgres://only-in-base\n",
        );
        write(dir.path(), ".env.local", "DATABASE_URL=postgres://local\n");
        let values = load(dir.path());

        assert_eq!(
            values.get_with_origin("DATABASE_URL"),
            Some(("postgres://local", ".env.local"))
        );
        assert_eq!(
            values.get_with_origin("KSYNC_DB_URL"),
            Some(("postgres://only-in-base", ".env"))
        );
        assert_eq!(values.get_with_origin("SUPABASE_DB_PASSWORD"), None);
    }

    #[test]
    fn the_four_files_layer_in_order_and_keep_the_winning_file() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".env",
            "DATABASE_URL=base\nDIRECT_URL=base\nPOSTGRES_URL=base\nSUPABASE_PROJECT_ID=base\n",
        );
        write(
            dir.path(),
            ".env.development",
            "DATABASE_URL=development\nDIRECT_URL=development\nPOSTGRES_URL=development\n",
        );
        write(
            dir.path(),
            ".env.local",
            "DATABASE_URL=local\nDIRECT_URL=local\n",
        );
        write(
            dir.path(),
            ".env.development.local",
            "DATABASE_URL=development-local\n",
        );
        let values = load(dir.path());

        assert_eq!(
            values.get_with_origin("DATABASE_URL"),
            Some(("development-local", ".env.development.local"))
        );
        assert_eq!(
            values.get_with_origin("DIRECT_URL"),
            Some(("local", ".env.local"))
        );
        assert_eq!(
            values.get_with_origin("POSTGRES_URL"),
            Some(("development", ".env.development"))
        );
        assert_eq!(
            values.get_with_origin("SUPABASE_PROJECT_ID"),
            Some(("base", ".env"))
        );
    }

    #[test]
    fn every_connection_key_and_the_project_id_are_recognized() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".env",
            "DIRECT_URL=a\nPOSTGRES_URL_NON_POOLING=b\nPOSTGRES_URL=c\nSUPABASE_PROJECT_ID=abcd\n",
        );
        let values = load(dir.path());

        assert_eq!(values.get("DIRECT_URL"), Some("a"));
        assert_eq!(values.get("POSTGRES_URL_NON_POOLING"), Some("b"));
        assert_eq!(values.get("POSTGRES_URL"), Some("c"));
        assert_eq!(values.get("SUPABASE_PROJECT_ID"), Some("abcd"));
        for key in crate::db::URL_KEYS {
            assert!(RECOGNIZED_KEYS.contains(&key.name), "{}", key.name);
        }
    }

    #[test]
    fn an_empty_value_reads_as_unset() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), ".env", "DATABASE_URL=\nKSYNC_DB_URL=\"\"\n");
        let values = load(dir.path());

        assert_eq!(values.get("DATABASE_URL"), None);
        assert_eq!(values.get("KSYNC_DB_URL"), None);
    }
}
