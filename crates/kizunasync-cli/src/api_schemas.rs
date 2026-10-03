//! Expose `kizunasync` through the customer project's Data API.
//!
//! PostgREST serves only the schemas listed in `[api].schemas`, so a project
//! that never lists ours answers every `kizunasync` RPC with `PGRST106`.
//!
//! The file is read through [`crate::supabase_config`], and the patch is
//! byte-preserving surgery located by the spans the parser reports: every edit
//! inserts into the original string, so comments, key order, blank lines, and
//! line endings outside the edit survive untouched. Single-line and multi-line
//! arrays are both patched. A body that does not parse is reported as
//! `Unparseable` and left alone.

use std::ops::Range;

use toml::Spanned;

use crate::constants::SCHEMA;
use crate::supabase_config::{parse, read};

/// Supabase's documented default exposed schemas plus ours. Writing `schemas`
/// OVERRIDES the defaults instead of extending them, so a config that had no
/// key at all must restate the defaults alongside `kizunasync`.
const DEFAULT_API_SCHEMAS: [&str; 3] = ["public", "graphql_public", SCHEMA];

const API_SECTION_HEADER: &str = "[api]";

/// The indentation an entry of an empty multi-line array gets, relative to the
/// line of its closing bracket.
const ENTRY_INDENT: &str = "  ";

/// What a patch had to do to the config body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchOutcome {
    /// `kizunasync` was already listed.
    AlreadyPresent,
    /// It was inserted into the existing array.
    Inserted,
    /// An `[api]` section existed without a `schemas` key; the key was added.
    AddedKey,
    /// No `[api]` section existed; one was appended.
    AddedSection,
    /// The body does not parse as TOML: reported, never rewritten.
    Unparseable,
}

/// The result of [`patch_api_schemas`].
#[derive(Debug, Clone)]
pub struct Patch {
    /// The new config body (unchanged for `AlreadyPresent` and `Unparseable`).
    pub body: String,
    /// What had to be done.
    pub outcome: PatchOutcome,
}

/// The exact line written, and the one `doctor` tells a user to add by hand.
#[must_use]
pub fn schemas_key_line() -> String {
    let entries = DEFAULT_API_SCHEMAS
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ");

    format!("schemas = [{entries}]")
}

/// The schemas listed in `[api].schemas`, or `None` when the section or the key
/// is absent or the body does not parse.
#[must_use]
pub fn read_api_schemas(config_body: &str) -> Option<Vec<String>> {
    read(config_body).api.schema_names()
}

/// Add `kizunasync` to `[api].schemas`. Pure and byte-preserving outside the
/// insertion; `AlreadyPresent` and `Unparseable` return the input unchanged,
/// which also makes this idempotent.
#[must_use]
pub fn patch_api_schemas(config_body: &str) -> Patch {
    let unchanged = |outcome| Patch {
        body: config_body.to_owned(),
        outcome,
    };
    let Ok(config) = parse(config_body) else {
        return unchanged(PatchOutcome::Unparseable);
    };

    let Some(schemas) = config.api.schemas else {
        return match api_header_end(config_body) {
            Some(header_end) => insert_after(
                config_body,
                header_end,
                &schemas_key_line(),
                PatchOutcome::AddedKey,
            ),
            // No `[api]` header, but the table exists through dotted keys
            // (`api.port = …`): add ours as one more dotted key, never a
            // second `[api]` section that would collide with the first.
            None => match last_api_dotted_key_line_end(config_body) {
                Some(dotted_key_end) => insert_after(
                    config_body,
                    dotted_key_end,
                    &format!("api.{}", schemas_key_line()),
                    PatchOutcome::AddedKey,
                ),
                None => Patch {
                    body: format!(
                        "{config_body}\n{API_SECTION_HEADER}\n{}\n",
                        schemas_key_line()
                    ),
                    outcome: PatchOutcome::AddedSection,
                },
            },
        };
    };

    if schemas
        .get_ref()
        .iter()
        .any(|entry| entry.get_ref() == SCHEMA)
    {
        return unchanged(PatchOutcome::AlreadyPresent);
    }

    insert_entry(config_body, &schemas).map_or_else(
        || unchanged(PatchOutcome::Unparseable),
        |body| Patch {
            body,
            outcome: PatchOutcome::Inserted,
        },
    )
}

/// `kizunasync` inserted as the array's last entry, or `None` when the span the
/// parser reported does not open on `[` and close on `]` in this body.
fn insert_entry(body: &str, schemas: &Spanned<Vec<Spanned<String>>>) -> Option<String> {
    let Range { start: open, end } = schemas.span();
    let close = end.checked_sub(1)?;
    if body.as_bytes().get(open) != Some(&b'[') || body.as_bytes().get(close) != Some(&b']') {
        return None;
    }
    let inner = body.get(open + 1..close)?;

    let Some(last) = schemas.get_ref().last() else {
        if !inner.contains('\n') {
            return Some(splice(body, &[(open + 1, format!("\"{SCHEMA}\""))]));
        }

        let line_start = line_start(body, close);
        let indent = body.get(line_start..close)?;

        return Some(splice(
            body,
            &[(
                line_start,
                format!(
                    "{indent}{ENTRY_INDENT}\"{SCHEMA}\",{}",
                    line_break_before(body, line_start)
                ),
            )],
        ));
    };

    let last_end = last.span().end;
    let tail = body.get(last_end..close)?;
    let comma = has_comma(tail);

    // `]` on the last entry's line: the new entry joins that line, keeping the
    // array's trailing-comma style. Such a tail holds no comment.
    let Some(newline) = tail.rfind('\n') else {
        let insertion = match tail.find(',') {
            Some(at) => (last_end + at + 1, format!(" \"{SCHEMA}\",")),
            None => (last_end, format!(", \"{SCHEMA}\"")),
        };
        return Some(splice(body, &[insertion]));
    };

    // The new line goes after every line of the tail, comments included, and
    // takes the last entry's indentation and the body's line ending.
    let newline = last_end + newline;
    let line_end = if newline > 0 && body.as_bytes().get(newline - 1) == Some(&b'\r') {
        newline - 1
    } else {
        newline
    };
    let entry_line = line_start(body, last.span().start);
    let indent: String = body
        .get(entry_line..)?
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .collect();
    let line = format!(
        "{}{indent}\"{SCHEMA}\",",
        line_break_before(body, newline + 1)
    );

    Some(splice(
        body,
        &(!comma)
            .then(|| (last_end, ",".to_owned()))
            .into_iter()
            .chain([(line_end, line)])
            .collect::<Vec<_>>(),
    ))
}

/// Whether the text between the last entry and `]` already carries TOML's
/// optional trailing comma. That text holds no strings, so every `#` opens a
/// comment, and a comma inside one does not count.
fn has_comma(tail: &str) -> bool {
    tail.split('\n')
        .any(|line| line.split('#').next().unwrap_or_default().contains(','))
}

/// The offset of the first byte of the line holding `at`.
fn line_start(body: &str, at: usize) -> usize {
    body.get(..at)
        .and_then(|before| before.rfind('\n'))
        .map_or(0, |newline| newline + 1)
}

/// The line break that ends just before `line_start`: `\r\n` or `\n`.
fn line_break_before(body: &str, line_start: usize) -> &'static str {
    if line_start >= 2 && body.as_bytes().get(line_start - 2) == Some(&b'\r') {
        "\r\n"
    } else {
        "\n"
    }
}

/// `insertions`, in ascending offset order, applied to `body` in one pass.
fn splice(body: &str, insertions: &[(usize, String)]) -> String {
    let mut spliced = String::with_capacity(body.len() + 64);
    let mut cursor = 0;
    for (at, text) in insertions {
        let (before, _) = split_at_checked(
            body.get(cursor..).unwrap_or_default(),
            at.saturating_sub(cursor),
        );
        spliced.push_str(before);
        spliced.push_str(text);
        cursor = *at;
    }
    spliced.push_str(body.get(cursor..).unwrap_or_default());

    spliced
}

/// Insert `line` as a new line right after byte offset `at`.
fn insert_after(body: &str, at: usize, line: &str, outcome: PatchOutcome) -> Patch {
    let (before, after) = split_at_checked(body, at);

    Patch {
        body: format!("{before}\n{line}{after}"),
        outcome,
    }
}

/// Absolute byte offset just past the `[api]` header line, the insertion
/// point for a missing `schemas` key, or `None` when no line opens `[api]`.
fn api_header_end(config_body: &str) -> Option<usize> {
    let mut start = 0_usize;
    for text in config_body.split('\n') {
        let line_end = start + text.len();
        if strip_header_comment(text.trim()) == API_SECTION_HEADER {
            return Some(line_end);
        }
        start = line_end + 1;
    }

    None
}

/// Absolute byte offset just past the last top-level `api.<key> = …` dotted
/// key line, the insertion point for a missing `schemas` key when the `api`
/// table exists that way instead of under an `[api]` header. Dotted keys stop
/// naming the root-level `api` table once any `[section]` header has opened
/// (a later `x.y = …` belongs to that section instead), so lines from there
/// on are not candidates. `None` when no such line exists.
fn last_api_dotted_key_line_end(config_body: &str) -> Option<usize> {
    let mut start = 0_usize;
    let mut root_scope = true;
    let mut last_end = None;
    for text in config_body.split('\n') {
        let line_end = start + text.len();
        let trimmed = text.trim();
        if trimmed.starts_with('[') {
            root_scope = false;
        } else if root_scope
            && trimmed
                .strip_prefix("api.")
                .is_some_and(|rest| !rest.is_empty())
        {
            last_end = Some(line_end);
        }
        start = line_end + 1;
    }

    last_end
}

/// `[api] # the Data API` is still the `[api]` section. Only a `#` AFTER the
/// closing bracket is a comment (one inside the brackets belongs to the key)
/// and only the recognition is affected: the insertion point still lands past
/// the comment.
fn strip_header_comment(line: &str) -> &str {
    let Some(closing_bracket) = line.find(']') else {
        return line;
    };
    line.get(closing_bracket..)
        .and_then(|rest| rest.find('#'))
        .map_or(line, |at| {
            line.get(..closing_bracket + at).unwrap_or(line).trim_end()
        })
}

/// Byte-offset split that never panics on a bad index.
fn split_at_checked(text: &str, at: usize) -> (&str, &str) {
    match (text.get(..at), text.get(at..)) {
        (Some(before), Some(after)) => (before, after),
        _ => (text, ""),
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// The patched body parses, lists every original entry and `kizunasync`,
    /// and differs from the input only by inserted bytes.
    fn assert_sound(before: &str, patch: &Patch) {
        let listed = read_api_schemas(&patch.body).expect("the patched body parses");
        assert!(listed.iter().any(|entry| entry == SCHEMA), "{}", patch.body);
        for entry in read_api_schemas(before).unwrap_or_default() {
            assert!(listed.contains(&entry), "{entry} lost: {}", patch.body);
        }
        let mut rest = patch.body.as_str();
        for c in before.chars() {
            let at = rest.find(c).expect("every original byte survives in order");
            rest = &rest[at + c.len_utf8()..];
        }
    }

    fn patched(body: &str) -> Patch {
        let patch = patch_api_schemas(body);
        assert_sound(body, &patch);

        patch
    }

    #[test]
    fn reads_single_and_multi_line_arrays() {
        assert_eq!(
            read_api_schemas("[api]\nschemas = [\"public\", \"graphql_public\"]\n"),
            Some(vec!["public".to_owned(), "graphql_public".to_owned()])
        );
        assert_eq!(
            read_api_schemas(
                "[api]\nschemas = [\n  \"public\", # default\n  \"graphql_public\"\n]\n"
            ),
            Some(vec!["public".to_owned(), "graphql_public".to_owned()])
        );
    }

    #[test]
    fn a_missing_section_or_key_or_an_unparseable_body_reads_as_none() {
        assert_eq!(read_api_schemas("[db]\nport = 1\n"), None);
        assert_eq!(read_api_schemas("[api]\nport = 1\n"), None);
        assert_eq!(read_api_schemas("[api]\nschemas = [\"public\"\n"), None);
    }

    #[test]
    fn inserting_preserves_every_other_byte() {
        let body = "# top\n[api]\nport = 54321\nschemas = [\"public\"]\n\n[db]\nport = 54322\n";
        let patch = patched(body);

        assert_eq!(patch.outcome, PatchOutcome::Inserted);
        assert_eq!(
            patch.body,
            "# top\n[api]\nport = 54321\nschemas = [\"public\", \"kizunasync\"]\n\n[db]\nport = 54322\n"
        );
    }

    #[test]
    fn a_trailing_comma_is_kept_after_the_new_entry() {
        let patch = patched("[api]\nschemas = [\"public\",]\n");

        assert_eq!(
            patch.body,
            "[api]\nschemas = [\"public\", \"kizunasync\",]\n"
        );

        let patch = patched("[api]\nschemas = [ \"public\" , ]\n");

        assert_eq!(
            patch.body,
            "[api]\nschemas = [ \"public\" , \"kizunasync\", ]\n"
        );
    }

    #[test]
    fn without_a_trailing_comma_the_entry_follows_the_last_element() {
        let patch = patched("[api]\nschemas = [ \"public\" ]\n");

        assert_eq!(
            patch.body,
            "[api]\nschemas = [ \"public\", \"kizunasync\" ]\n"
        );
    }

    #[test]
    fn an_empty_array_takes_the_bare_entry() {
        let patch = patched("[api]\nschemas = []\n");

        assert_eq!(patch.body, "[api]\nschemas = [\"kizunasync\"]\n");
    }

    #[test]
    fn a_comment_after_the_last_element_stays_after_it() {
        let patch = patched("[api]\nschemas = [\n  \"public\" # the default, kept\n]\n");

        assert_eq!(
            patch.body,
            "[api]\nschemas = [\n  \"public\", # the default, kept\n  \"kizunasync\",\n]\n"
        );
    }

    #[test]
    fn a_comment_line_before_the_closing_bracket_stays_above_the_new_entry() {
        let patch = patched("[api]\nschemas = [\n  \"public\",\n  # more to come\n]\n");

        assert_eq!(
            patch.body,
            "[api]\nschemas = [\n  \"public\",\n  # more to come\n  \"kizunasync\",\n]\n"
        );
    }

    #[test]
    fn a_multi_line_array_with_a_trailing_comma_gets_a_new_line_at_the_entries_indentation() {
        let patch = patched(
            "[api]\nschemas = [\n    \"public\",\n    \"graphql_public\",\n]\nmax_rows = 1000\n",
        );

        assert_eq!(patch.outcome, PatchOutcome::Inserted);
        assert_eq!(
            patch.body,
            "[api]\nschemas = [\n    \"public\",\n    \"graphql_public\",\n    \"kizunasync\",\n]\nmax_rows = 1000\n"
        );
    }

    #[test]
    fn a_multi_line_array_without_a_trailing_comma_gets_one_after_its_last_entry() {
        let patch = patched("[api]\nschemas = [\n  \"public\",\n  \"graphql_public\"\n]\n");

        assert_eq!(
            patch.body,
            "[api]\nschemas = [\n  \"public\",\n  \"graphql_public\",\n  \"kizunasync\",\n]\n"
        );
    }

    #[test]
    fn comments_inside_a_multi_line_array_stay_on_their_lines() {
        let patch = patched(
            "[api]\nschemas = [\n  \"public\", # the default\n  \"graphql_public\" # a, b\n  # the end\n]\n",
        );

        assert_eq!(
            patch.body,
            "[api]\nschemas = [\n  \"public\", # the default\n  \"graphql_public\", # a, b\n  # the end\n  \"kizunasync\",\n]\n"
        );
    }

    #[test]
    fn a_multi_line_array_closed_on_its_last_entry_line_joins_that_line() {
        let patch = patched("[api]\nschemas = [\n  \"public\",\n  \"graphql_public\"]\n");

        assert_eq!(
            patch.body,
            "[api]\nschemas = [\n  \"public\",\n  \"graphql_public\", \"kizunasync\"]\n"
        );
    }

    #[test]
    fn an_empty_multi_line_array_gets_an_indented_entry() {
        let patch = patched("[api]\nschemas = [\n]\n");

        assert_eq!(patch.body, "[api]\nschemas = [\n  \"kizunasync\",\n]\n");
    }

    #[test]
    fn an_already_listed_schema_leaves_either_array_shape_unchanged() {
        for body in [
            "[api]\nschemas = [\"public\", \"kizunasync\"]\n",
            "[api]\nschemas = [\n  \"public\",\n  'kizunasync' # ours\n]\n",
        ] {
            let patch = patch_api_schemas(body);

            assert_eq!(patch.outcome, PatchOutcome::AlreadyPresent);
            assert_eq!(patch.body, body);
        }
    }

    #[test]
    fn an_api_section_without_the_key_gets_the_full_default_line() {
        let patch = patched("[api]\nport = 54321\n\n[db]\nport = 54322\n");

        assert_eq!(patch.outcome, PatchOutcome::AddedKey);
        assert_eq!(
            patch.body,
            "[api]\nschemas = [\"public\", \"graphql_public\", \"kizunasync\"]\nport = 54321\n\n[db]\nport = 54322\n"
        );
    }

    #[test]
    fn a_config_without_an_api_section_gets_one_appended() {
        let patch = patched("[db]\nport = 54322\n");

        assert_eq!(patch.outcome, PatchOutcome::AddedSection);
        assert_eq!(
            patch.body,
            "[db]\nport = 54322\n\n[api]\nschemas = [\"public\", \"graphql_public\", \"kizunasync\"]\n"
        );
    }

    #[test]
    fn a_dotted_api_table_without_a_header_gets_a_dotted_schemas_key() {
        let patch = patched("project_id = \"demo\"\napi.port = 54321\n\n[db]\nport = 54322\n");

        assert_eq!(patch.outcome, PatchOutcome::AddedKey);
        assert_eq!(
            patch.body,
            "project_id = \"demo\"\napi.port = 54321\napi.schemas = [\"public\", \"graphql_public\", \"kizunasync\"]\n\n[db]\nport = 54322\n"
        );
    }

    #[test]
    fn a_dotted_schemas_key_without_a_header_uses_the_existing_span_based_patch() {
        let patch = patched("api.port = 54321\napi.schemas = [\"public\"]\n\n[db]\nport = 54322\n");

        assert_eq!(patch.outcome, PatchOutcome::Inserted);
        assert_eq!(
            patch.body,
            "api.port = 54321\napi.schemas = [\"public\", \"kizunasync\"]\n\n[db]\nport = 54322\n"
        );
    }

    #[test]
    fn an_unparseable_body_is_reported_and_never_rewritten() {
        for body in [
            "[api]\nschemas = [\n  \"public\",\n",
            "[api]\nschemas = [\"public\"]\n[api]\n",
            "[db]\nport = \"54322\"\n",
        ] {
            let patch = patch_api_schemas(body);

            assert_eq!(patch.outcome, PatchOutcome::Unparseable, "{body}");
            assert_eq!(patch.body, body);
        }
    }

    #[test]
    fn a_second_patch_reports_already_present_and_leaves_the_body_unchanged() {
        for body in [
            "[api]\nschemas = [\"public\"]\n",
            "[api]\nschemas = [\n  \"public\"\n]\n",
            "[api]\nport = 1\n",
            "[db]\nport = 1\n",
        ] {
            let once = patched(body);
            let twice = patch_api_schemas(&once.body);

            assert_eq!(twice.outcome, PatchOutcome::AlreadyPresent, "{body}");
            assert_eq!(twice.body, once.body);
        }
    }

    #[test]
    fn a_commented_section_header_is_still_the_api_section() {
        let patch = patched("[api] # the Data API\nport = 1\n");

        assert_eq!(patch.outcome, PatchOutcome::AddedKey);
        assert_eq!(
            patch.body,
            "[api] # the Data API\nschemas = [\"public\", \"graphql_public\", \"kizunasync\"]\nport = 1\n"
        );
    }

    #[test]
    fn crlf_endings_outside_the_edit_survive() {
        let patch = patched("[api]\r\nschemas = [\"public\"]\r\n[db]\r\n");

        assert_eq!(
            patch.body,
            "[api]\r\nschemas = [\"public\", \"kizunasync\"]\r\n[db]\r\n"
        );

        let patch = patched("[api]\r\nschemas = [\r\n  \"public\"\r\n]\r\n");

        assert_eq!(
            patch.body,
            "[api]\r\nschemas = [\r\n  \"public\",\r\n  \"kizunasync\",\r\n]\r\n"
        );

        let patch = patched("[api]\r\nschemas = [\r\n]\r\n");

        assert_eq!(
            patch.body,
            "[api]\r\nschemas = [\r\n  \"kizunasync\",\r\n]\r\n"
        );
    }

    #[test]
    fn the_supabase_init_template_is_patched_in_place() {
        let body = "# For detailed configuration reference documentation, visit:\n# https://supabase.com/docs/guides/local-development/cli/config\nproject_id = \"demo\"\n\n[api]\nenabled = true\n# Port to use for the API URL.\nport = 54321\n# Schemas to expose in your API. Tables, views and stored procedures in this schema will get API\n# endpoints. `public` and `graphql_public` schemas are included by default.\nschemas = [\"public\", \"graphql_public\"]\n# Extra schemas to add to the search_path of every request.\nextra_search_path = [\"public\", \"extensions\"]\nmax_rows = 1000\n\n[db]\nport = 54322\n";
        let patch = patched(body);

        assert_eq!(patch.outcome, PatchOutcome::Inserted);
        assert_eq!(
            patch.body,
            body.replace(
                "schemas = [\"public\", \"graphql_public\"]",
                "schemas = [\"public\", \"graphql_public\", \"kizunasync\"]"
            )
        );
    }
}
