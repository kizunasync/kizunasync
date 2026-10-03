//! The project's `supabase/config.toml`, read through the `toml` crate.
//!
//! One typed read model for the keys `kizunasync` reads (`[db] port`, `[api] port`,
//! `[api] schemas`); every other key is ignored. A body that does not parse
//! reads as the defaults through [`read`], and [`parse`] hands the parse error,
//! with the line and column the crate reports, to the callers that show it.

use serde::Deserialize;

/// The keys `kizunasync` reads from `supabase/config.toml`.
#[derive(Debug, Default, Deserialize)]
pub struct SupabaseConfig {
    /// `[db]`.
    #[serde(default)]
    pub db: DbSection,
    /// `[api]`.
    #[serde(default)]
    pub api: ApiSection,
}

/// `[db]`: the local Postgres.
#[derive(Debug, Default, Deserialize)]
pub struct DbSection {
    /// The local Postgres port.
    pub port: Option<u16>,
}

/// `[api]`: the Data API.
#[derive(Debug, Default, Deserialize)]
pub struct ApiSection {
    /// The local Data API port.
    pub port: Option<u16>,
    /// The exposed schemas, with the byte spans of the array value and of each
    /// entry so a patch can splice into the original body.
    pub schemas: Option<toml::Spanned<Vec<toml::Spanned<String>>>>,
}

impl ApiSection {
    /// The exposed schema names, without their spans.
    #[must_use]
    pub fn schema_names(&self) -> Option<Vec<String>> {
        self.schemas.as_ref().map(|schemas| {
            schemas
                .get_ref()
                .iter()
                .map(|entry| entry.get_ref().clone())
                .collect()
        })
    }
}

/// A body that is not valid TOML, or not the shape of the keys read here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError(String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ParseError {}

/// The crate's own rendering opens on this when it knows where the error is.
const LOCATION_PREFIX: &str = "TOML parse error at ";

impl From<toml::de::Error> for ParseError {
    /// One line: the crate's `line N, column M` when it has a span, then its
    /// message. The multi-line snippet it renders under that is dropped.
    fn from(error: toml::de::Error) -> Self {
        let rendered = error.to_string();
        let location = rendered
            .lines()
            .next()
            .and_then(|line| line.strip_prefix(LOCATION_PREFIX));

        Self(location.map_or_else(
            || error.message().to_owned(),
            |at| format!("{at}: {}", error.message()),
        ))
    }
}

/// Parse `body`.
///
/// # Errors
/// Returns [`ParseError`] when `body` is not valid TOML or a key read here has
/// the wrong type.
pub fn parse(body: &str) -> Result<SupabaseConfig, ParseError> {
    toml::from_str(body).map_err(ParseError::from)
}

/// Parse `body`, reading a body that does not parse as the defaults.
#[must_use]
pub fn read(body: &str) -> SupabaseConfig {
    parse(body).unwrap_or_default()
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn the_read_keys_come_from_their_sections_and_everything_else_is_ignored() {
        let config = parse(
            "project_id = \"demo\"\n\n# local stack\n[api]\nenabled = true\nport = 54321\nschemas = [\"public\", \"graphql_public\"]\n\n[db]\n# the port\nport = 54322 # trailing\nmajor_version = 17\n\n[auth]\nport = 1\n",
        )
        .unwrap();

        assert_eq!(config.db.port, Some(54322));
        assert_eq!(config.api.port, Some(54321));
        assert_eq!(
            config.api.schema_names(),
            Some(vec!["public".to_owned(), "graphql_public".to_owned()])
        );
    }

    #[test]
    fn missing_sections_and_keys_read_as_none() {
        let config = parse("").unwrap();
        assert_eq!(config.db.port, None);
        assert_eq!(config.api.port, None);
        assert!(config.api.schemas.is_none());

        let config = parse("[db]\n[api]\n").unwrap();
        assert_eq!(config.db.port, None);
        assert!(config.api.schemas.is_none());
    }

    #[test]
    fn a_multi_line_array_reads_like_a_single_line_one() {
        let config =
            parse("[api]\nschemas = [\n  \"public\", # the default\n  'graphql_public',\n]\n")
                .unwrap();

        assert_eq!(
            config.api.schema_names(),
            Some(vec!["public".to_owned(), "graphql_public".to_owned()])
        );
    }

    #[test]
    fn the_schemas_span_covers_the_array_value() {
        let body = "[api]\nschemas = [\"public\"]\n";
        let schemas = parse(body).unwrap().api.schemas.unwrap();

        assert_eq!(&body[schemas.span()], "[\"public\"]");
        assert_eq!(&body[schemas.get_ref()[0].span()], "\"public\"");
    }

    #[test]
    fn a_body_that_does_not_parse_reports_its_line_and_column_and_reads_as_defaults() {
        let body = "[db]\nport = 54322\n\n[api]\nschemas = [\"public\"\n";
        let error = parse(body).unwrap_err();

        assert!(
            error
                .to_string()
                .starts_with("line 5, column 20: unclosed array"),
            "{error}"
        );
        assert!(!error.to_string().contains('\n'), "{error}");

        let config = read(body);
        assert_eq!(config.db.port, None);
        assert!(config.api.schemas.is_none());
    }

    #[test]
    fn a_read_key_of_the_wrong_type_is_a_parse_error() {
        assert!(parse("[db]\nport = \"54322\"\n").is_err());
        assert!(parse("[db]\nport = 70000\n").is_err());
        assert!(parse("[api]\nschemas = [1]\n").is_err());
    }
}
