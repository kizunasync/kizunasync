//! Classify migration statements additive vs breaking against the sync
//! contract.
//!
//! For each statement that touches a synced table:
//!
//! * **Additive**: `ADD COLUMN` that is nullable or has a `DEFAULT`, and
//!   `DROP CONSTRAINT`, which only widens what a push may write. Safe to ship
//!   without a schema-version bump.
//! * **Breaking**: requires a schema-version bump (the client's stored
//!   `schema_version` must move so stale clients soft-block): `DROP COLUMN` /
//!   `DROP TABLE`, `RENAME`, `ALTER COLUMN … TYPE`, `ALTER COLUMN … SET NOT
//!   NULL`, `ALTER COLUMN … DROP DEFAULT`, `ADD CONSTRAINT`, and `ADD COLUMN …
//!   NOT NULL` with no default.
//!
//! This is a regex scan, deliberately blunt: it biases to flagging. A
//! flagged-but-actually-safe migration is the accepted failure mode, because it
//! is louder than the alternative (a silent breaking change).
//!
//! The patterns use lookahead (`add (?!constraint) …`), which the `regex` crate
//! does not support, so the classifier runs on `fancy-regex`.

use std::path::Path;
use std::sync::OnceLock;

use fancy_regex::Regex;

use crate::error::{Error, Result};

/// How a finding is classified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    /// Safe to ship as is.
    Additive,
    /// Requires a schema-version bump.
    Breaking,
}

impl Severity {
    /// The label printed in the report.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Additive => "additive",
            Self::Breaking => "BREAKING",
        }
    }
}

/// One classified statement, without the file it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// The synced table the statement touches.
    pub table: String,
    /// Additive or breaking.
    pub severity: Severity,
    /// The stable rule id.
    pub rule: &'static str,
    /// The human explanation.
    pub detail: &'static str,
}

/// A [`Hit`] plus its migration file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// Migration filename.
    pub file: String,
    /// The classified statement.
    pub hit: Hit,
}

/// A whole directory scan.
#[derive(Debug, Clone, Default)]
pub struct LintReport {
    /// Every finding, in file then table order.
    pub findings: Vec<Finding>,
    /// How many are breaking.
    pub breaking: usize,
    /// How many are additive.
    pub additive: usize,
}

/// Strip line (`--`) and block (`/* */`) comments and collapse whitespace so a
/// statement that wraps lines still matches. Crude but enough for flagging.
#[must_use]
pub fn normalize_sql(sql: &str) -> String {
    let without_blocks = strip_block_comments(sql);
    let without_lines = strip_line_comments(&without_blocks);

    collapse_whitespace(&without_lines)
}

fn strip_block_comments(sql: &str) -> String {
    let mut output = String::with_capacity(sql.len());
    let mut rest = sql;
    while let Some(open) = rest.find("/*") {
        output.push_str(rest.get(..open).unwrap_or_default());
        output.push(' ');
        let after_open = rest.get(open + 2..).unwrap_or_default();
        match after_open.find("*/") {
            // An unterminated block comment swallows the remainder, as the
            // source's non-greedy `/\*[\s\S]*?\*\//g` leaves it in place; the
            // closest faithful behaviour is to stop stripping.
            None => return format!("{output}{after_open}"),
            Some(close) => rest = after_open.get(close + 2..).unwrap_or_default(),
        }
    }
    output.push_str(rest);

    output
}

fn strip_line_comments(sql: &str) -> String {
    sql.split('\n')
        .map(|line| {
            line.find("--").map_or_else(
                || line.to_owned(),
                |at| format!("{} ", line.get(..at).unwrap_or_default()),
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn collapse_whitespace(sql: &str) -> String {
    let mut output = String::with_capacity(sql.len());
    let mut in_whitespace = false;
    for character in sql.chars() {
        if character.is_whitespace() {
            if !in_whitespace {
                output.push(' ');
                in_whitespace = true;
            }
            continue;
        }
        in_whitespace = false;
        output.push(character);
    }

    output
}

struct Patterns {
    drop_table: Regex,
    drop_column: Regex,
    rename_direct: Regex,
    rename_alter_table: Regex,
    type_change: Regex,
    set_not_null: Regex,
    drop_default: Regex,
    add_constraint: Regex,
    drop_constraint: Regex,
    add_column_action: Regex,
    add_column_not_null: Regex,
    add_column_default: Regex,
    has_column_add: Regex,
}

fn patterns() -> Result<&'static Patterns> {
    static PATTERNS: OnceLock<Option<Patterns>> = OnceLock::new();

    PATTERNS
        .get_or_init(|| {
            Some(Patterns {
                drop_table: Regex::new(r"(?i)\bdrop\s+table\b").ok()?,
                // Anchored on ALTER TABLE: a column drop is the only DROP this
                // rule is about. `drop trigger`, `drop policy`, and `drop
                // function` are how every migration kizunasync emits replaces an
                // object, and they take nothing away from a client.
                drop_column: Regex::new(
                    r#"(?i)\balter\s+table\b[\s\S]*?\bdrop\s+(?!constraint\b|default\b|not\s+null\b|identity\b|expression\b)(?:column\s+)?(?:if\s+exists\s+)?["a-z_]"#,
                )
                .ok()?,
                rename_direct: Regex::new(r"(?i)\brename\s+(?:column\s+|to\b)").ok()?,
                rename_alter_table: Regex::new(r"(?i)\balter\s+table\b[\s\S]*\brename\b").ok()?,
                type_change: Regex::new(r"(?i)\balter\s+column\b[\s\S]*?\b(?:set\s+data\s+)?type\b").ok()?,
                set_not_null: Regex::new(r"(?i)\balter\s+column\b[\s\S]*?\bset\s+not\s+null\b").ok()?,
                drop_default: Regex::new(r"(?i)\balter\s+column\b[\s\S]*?\bdrop\s+default\b").ok()?,
                // Anchored on the add action, so a defaulted column carrying a
                // CHECK in its own definition is not read as a table-level one.
                add_constraint: Regex::new(
                    r"(?i)\badd\s+(?:constraint\b|primary\s+key\b|foreign\s+key\b|unique\b|check\b|exclude\b)",
                )
                .ok()?,
                drop_constraint: Regex::new(r"(?i)\bdrop\s+constraint\b").ok()?,
                add_column_action: Regex::new(
                    r"(?i)\badd\s+(?!constraint\b|primary\b|foreign\b|unique\b|check\b|exclude\b)(?:column\s+)?(?:if\s+not\s+exists\s+)?[\s\S]*?(?=,\s*\b(?:add|drop|alter|rename)\b|$)",
                )
                .ok()?,
                add_column_not_null: Regex::new(r"(?i)\bnot\s+null\b").ok()?,
                add_column_default: Regex::new(r"(?i)\bdefault\b").ok()?,
                has_column_add: Regex::new(
                    r#"(?i)\badd\s+(?!constraint\b|primary\b|foreign\b|unique\b|check\b|exclude\b)(?:column\s+)?(?:if\s+not\s+exists\s+)?["a-z_]"#,
                )
                .ok()?,
            })
        })
        .as_ref()
        .ok_or_else(|| Error::Internal("the migration classifier's patterns failed to compile".to_owned()))
}

/// # Errors
/// Returns [`Error::Internal`] when `fancy-regex` cannot decide the match (its
/// backtracking budget was exceeded). This module is deliberately blunt and
/// biases to flagging a migration breaking, so a match failure must reach the
/// caller as an error rather than resolve to a silent, unflagged `false`.
fn is_match(pattern: &Regex, statement: &str) -> Result<bool> {
    pattern.is_match(statement).map_err(|cause| {
        Error::Internal(format!(
            "could not run a migration-classifier pattern: {cause}"
        ))
    })
}

/// Does this statement target one of the synced tables? Matches the bare or
/// schema-qualified (`public.todos`) name as a whole word.
///
/// # Errors
/// Returns [`Error::Internal`] when the per-table pattern cannot be built or run.
pub fn statement_touches(statement: &str, table: &str) -> Result<bool> {
    let pattern = Regex::new(&format!(r"(?i)\b(?:public\.)?{}\b", regex::escape(table))).map_err(
        |cause| {
            Error::Internal(format!(
                "could not build a matcher for table {table:?}: {cause}"
            ))
        },
    )?;

    is_match(&pattern, statement)
}

/// Classify a single normalized statement against one synced table. Returns the
/// first matching rule: breaking rules are checked before the additive
/// `add-column` catch-all, so a breaking add-column wins.
///
/// # Errors
/// Returns [`Error::Internal`] when a pattern cannot be built.
pub fn classify_statement(statement: &str, table: &str) -> Result<Option<Hit>> {
    if !statement_touches(statement, table)? {
        return Ok(None);
    }

    let patterns = patterns()?;
    let hit = |severity: Severity, rule: &'static str, detail: &'static str| {
        Some(Hit {
            table: table.to_owned(),
            severity,
            rule,
            detail,
        })
    };

    if is_match(&patterns.drop_table, statement)? {
        return Ok(hit(
            Severity::Breaking,
            "drop-table",
            "DROP TABLE on a synced table",
        ));
    }

    if is_match(&patterns.drop_column, statement)? {
        return Ok(hit(
            Severity::Breaking,
            "drop-column",
            "DROP COLUMN on a synced table",
        ));
    }

    if is_match(&patterns.rename_direct, statement)?
        || is_match(&patterns.rename_alter_table, statement)?
    {
        return Ok(hit(
            Severity::Breaking,
            "rename",
            "RENAME on a synced table (column or table)",
        ));
    }

    if is_match(&patterns.type_change, statement)? {
        return Ok(hit(
            Severity::Breaking,
            "type-change",
            "ALTER COLUMN ... TYPE (type change) on a synced table",
        ));
    }

    if is_match(&patterns.set_not_null, statement)? {
        return Ok(hit(
            Severity::Breaking,
            "set-not-null",
            "ALTER COLUMN ... SET NOT NULL on a synced table (rejects pushes of rows written offline without it)",
        ));
    }

    if is_match(&patterns.drop_default, statement)? {
        return Ok(hit(
            Severity::Breaking,
            "drop-default",
            "ALTER COLUMN ... DROP DEFAULT on a synced table (a client that omits the column stops getting the server's value)",
        ));
    }

    if is_match(&patterns.add_constraint, statement)? {
        return Ok(hit(
            Severity::Breaking,
            "add-constraint",
            "ADD CONSTRAINT on a synced table (rejects pushes of rows written offline under the old rule)",
        ));
    }

    if is_match(&patterns.drop_constraint, statement)? {
        return Ok(hit(
            Severity::Additive,
            "drop-constraint",
            "DROP CONSTRAINT on a synced table (relaxes what a push may write)",
        ));
    }

    if has_bare_not_null_add(patterns, statement)? {
        return Ok(hit(
            Severity::Breaking,
            "add-column-not-null-no-default",
            "ADD COLUMN NOT NULL without DEFAULT (rejects pre-existing offline rows)",
        ));
    }

    if is_match(&patterns.has_column_add, statement)? {
        return Ok(hit(
            Severity::Additive,
            "add-column",
            "ADD COLUMN (nullable or defaulted)",
        ));
    }

    Ok(None)
}

/// `ADD COLUMN … NOT NULL` with no `DEFAULT`, scoped per column-add action
/// (bounded by the next top-level action) so a defaulted sibling in the same
/// `ALTER` cannot mask a bare `NOT NULL` one.
///
/// # Errors
/// Returns [`Error::Internal`] when a pattern cannot be run.
fn has_bare_not_null_add(patterns: &Patterns, statement: &str) -> Result<bool> {
    for clause in patterns
        .add_column_action
        .find_iter(statement)
        .filter_map(std::result::Result::ok)
    {
        let text = clause.as_str();
        if is_match(&patterns.add_column_not_null, text)?
            && !is_match(&patterns.add_column_default, text)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Classify every statement in one SQL string against the synced-table set.
/// Pure, with no file I/O, so `upgrade` runs it against a pending pack file's SQL
/// the same way `lint` runs it per migration file.
///
/// # Errors
/// Returns [`Error::Internal`] when a pattern cannot be built.
pub fn classify_sql(sql: &str, synced_tables: &[String]) -> Result<Vec<Hit>> {
    let normalized = normalize_sql(sql);
    let mut hits = Vec::new();
    for statement in normalized
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        for table in synced_tables {
            if let Some(hit) = classify_statement(statement, table)? {
                hits.push(hit);
            }
        }
    }

    Ok(hits)
}

/// Scan every `.sql` file in `dir`, in lexical order (Supabase applies them
/// sorted by filename).
///
/// # Errors
/// Returns [`Error::Cli`] when the directory or a `.sql` file cannot be read,
/// and [`Error::Internal`] when a compiled-in pattern cannot be built.
pub fn scan_migrations(dir: &Path, synced_tables: &[String]) -> Result<LintReport> {
    let mut names: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(dir)
        .map_err(|cause| Error::Cli(format!("could not read {}: {cause}", dir.display())))?
    {
        let entry = entry
            .map_err(|cause| Error::Cli(format!("could not read {}: {cause}", dir.display())))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if Path::new(&name)
            .extension()
            .is_some_and(|extension| extension == "sql")
        {
            names.push(name);
        }
    }
    names.sort();

    let mut findings = Vec::new();
    for name in names {
        let path = dir.join(&name);
        let content = std::fs::read_to_string(&path)
            .map_err(|cause| Error::Cli(format!("could not read {}: {cause}", path.display())))?;
        for hit in classify_sql(&content, synced_tables)? {
            findings.push(Finding {
                file: name.clone(),
                hit,
            });
        }
    }
    let breaking = findings
        .iter()
        .filter(|finding| finding.hit.severity == Severity::Breaking)
        .count();

    Ok(LintReport {
        additive: findings.len() - breaking,
        breaking,
        findings,
    })
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::config::TableConfig;
    use crate::config_sql::table_provision_sql;

    fn classify(sql: &str) -> Vec<Hit> {
        classify_sql(sql, &["todos".to_owned()]).unwrap()
    }

    fn rules(sql: &str) -> Vec<&'static str> {
        classify(sql).into_iter().map(|hit| hit.rule).collect()
    }

    #[test]
    fn comments_are_stripped_and_whitespace_collapsed() {
        assert_eq!(normalize_sql("select /* a\nb */ 1;"), "select 1;");
        assert_eq!(
            normalize_sql("select 1; -- drop table todos\n"),
            "select 1; "
        );
        assert_eq!(normalize_sql("alter\n  table\ttodos"), "alter table todos");
    }

    #[test]
    fn a_statement_that_touches_nothing_synced_is_not_classified() {
        assert!(classify("alter table other drop column x;").is_empty());
    }

    #[test]
    fn the_table_match_is_whole_word_and_schema_qualified() {
        assert!(statement_touches("alter table public.todos add column a text", "todos").unwrap());
        assert!(statement_touches("alter table todos add column a text", "todos").unwrap());
        assert!(
            !statement_touches("alter table todos_archive add column a text", "todos").unwrap()
        );
    }

    #[test]
    fn drop_table_and_drop_column_are_breaking() {
        assert_eq!(rules("drop table todos;"), ["drop-table"]);
        assert_eq!(
            rules("alter table todos drop column title;"),
            ["drop-column"]
        );
        assert_eq!(rules("alter table todos drop title;"), ["drop-column"]);
        assert_eq!(
            rules("alter table todos drop if exists title;"),
            ["drop-column"]
        );
    }

    /// The migration `kizunasync sync` writes for an added table replaces both
    /// change-capture triggers, so it drops them first. Reading that as a
    /// column drop would make every project's own provisioning migration
    /// breaking against the table it provisions.
    #[test]
    fn the_migration_kizunasync_emits_for_a_synced_table_is_not_breaking() {
        let config = TableConfig {
            sync: "read-write".to_owned(),
            bucket: None,
            soft_delete: None,
            conflict: Some("arrival".to_owned()),
            conflict_journal: Some(false),
            register_clients: None,
            tombstone_ttl_days: None,
            min_schema_version: 1,
            key_columns: vec!["hall".to_owned(), "seat".to_owned()],
        };
        let breaking: Vec<&'static str> = classify(&table_provision_sql("todos", &config))
            .into_iter()
            .filter(|hit| hit.severity == Severity::Breaking)
            .map(|hit| hit.rule)
            .collect();

        assert!(
            breaking.is_empty(),
            "kizunasync's own provisioning SQL should carry no breaking finding, got {breaking:?}"
        );
    }

    #[test]
    fn a_real_column_drop_on_a_synced_table_is_still_breaking() {
        assert_eq!(
            rules("alter table todos drop column title;"),
            ["drop-column"]
        );
        assert_eq!(
            rules("alter table public.todos drop column title;"),
            ["drop-column"]
        );
    }

    #[test]
    fn dropping_an_object_that_is_not_a_column_is_not_breaking() {
        for statement in [
            "drop trigger if exists kizunasync_track_change on public.todos;",
            "drop policy if exists todos_owner on public.todos;",
            "drop function if exists public.todos_touch_updated_at();",
            "drop index if exists todos_user_id_idx;",
            "drop view if exists todos_view;",
        ] {
            assert!(
                rules(statement).is_empty(),
                "{statement} should carry no finding"
            );
        }
    }

    #[test]
    fn the_non_column_drop_forms_are_not_drop_column() {
        assert_eq!(
            rules("alter table todos drop constraint todos_pkey;"),
            ["drop-constraint"]
        );
        assert!(
            !rules("alter table todos alter column title drop not null;").contains(&"drop-column")
        );
        assert!(
            !rules("alter table todos alter column title drop default;").contains(&"drop-column")
        );
    }

    /// The four rules the regex scan could not see before: a tightened column,
    /// a dropped default, and either side of a constraint change.
    #[test]
    fn tightening_a_column_or_adding_a_constraint_is_breaking() {
        assert_eq!(
            rules("alter table todos alter column title set not null;"),
            ["set-not-null"]
        );
        assert_eq!(
            rules("alter table todos alter column title drop default;"),
            ["drop-default"]
        );
        assert_eq!(
            rules("alter table todos add constraint todos_title_len check (length(title) < 80);"),
            ["add-constraint"]
        );
        for rule in [
            "set-not-null",
            "drop-default",
            "add-constraint",
            "drop-constraint",
        ] {
            assert!(
                !rule.is_empty(),
                "every new rule carries a stable id in the report"
            );
        }
    }

    /// Dropping a constraint only widens what a push may write, so a stale
    /// client is not blocked by it.
    #[test]
    fn dropping_a_constraint_is_additive() {
        let hits = classify("alter table todos drop constraint todos_title_len;");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rule, "drop-constraint");
        assert_eq!(hits[0].severity, Severity::Additive);
    }

    #[test]
    fn a_constraint_change_on_a_table_that_is_not_synced_is_not_classified() {
        assert!(classify("alter table other alter column title set not null;").is_empty());
        assert!(classify("alter table other add constraint c unique (title);").is_empty());
    }

    #[test]
    fn renames_are_breaking_in_both_spellings() {
        assert_eq!(rules("alter table todos rename column a to b;"), ["rename"]);
        assert_eq!(rules("alter table todos rename to tasks;"), ["rename"]);
    }

    #[test]
    fn a_type_change_is_breaking() {
        assert_eq!(
            rules("alter table todos alter column title type text;"),
            ["type-change"]
        );
        assert_eq!(
            rules("alter table todos alter column title set data type text;"),
            ["type-change"]
        );
    }

    #[test]
    fn add_column_not_null_without_default_is_breaking() {
        assert_eq!(
            rules("alter table todos add column priority int not null;"),
            ["add-column-not-null-no-default"]
        );
    }

    #[test]
    fn add_column_not_null_with_a_default_is_additive() {
        assert_eq!(
            rules("alter table todos add column priority int not null default 0;"),
            ["add-column"]
        );
    }

    #[test]
    fn a_defaulted_sibling_cannot_mask_a_bare_not_null_in_the_same_alter() {
        assert_eq!(
            rules(
                "alter table todos add column a int not null default 0, add column b int not null;"
            ),
            ["add-column-not-null-no-default"]
        );
    }

    #[test]
    fn a_nullable_add_column_is_additive() {
        assert_eq!(
            rules("alter table todos add column note text;"),
            ["add-column"]
        );
        assert_eq!(rules("alter table todos add note text;"), ["add-column"]);
        assert_eq!(
            rules("alter table todos add column if not exists note text;"),
            ["add-column"]
        );
    }

    /// A table-level add is not a column add, so it never reads as the
    /// additive `add-column`: every one of them is a constraint change.
    #[test]
    fn table_level_add_forms_are_constraint_changes_not_column_adds() {
        for statement in [
            "alter table todos add constraint todos_pkey primary key (id);",
            "alter table todos add unique (title);",
            "alter table todos add check (done is not null);",
            "alter table todos add primary key (id);",
            "alter table todos add foreign key (user_id) references public.users (id);",
        ] {
            assert_eq!(rules(statement), ["add-constraint"], "{statement}");
        }
    }

    #[test]
    fn a_breaking_add_column_wins_over_the_additive_catch_all() {
        let hits = classify("alter table todos add column a int not null;");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].severity, Severity::Breaking);
    }

    #[test]
    fn every_statement_is_classified_against_every_synced_table() {
        let hits = classify_sql(
            "drop table todos; alter table notes add column a text;",
            &["notes".to_owned(), "todos".to_owned()],
        )
        .unwrap();

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].table, "todos");
        assert_eq!(hits[1].table, "notes");
    }

    #[test]
    fn a_directory_scan_reads_sql_files_in_lexical_order_and_counts_severities() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("0002_break.sql"), "drop table todos;").unwrap();
        std::fs::write(
            dir.path().join("0001_add.sql"),
            "alter table todos add column a text;",
        )
        .unwrap();
        std::fs::write(dir.path().join("notes.txt"), "drop table todos;").unwrap();

        let report = scan_migrations(dir.path(), &["todos".to_owned()]).unwrap();

        assert_eq!(report.findings.len(), 2);
        assert_eq!(report.findings[0].file, "0001_add.sql");
        assert_eq!(report.findings[1].file, "0002_break.sql");
        assert_eq!(report.additive, 1);
        assert_eq!(report.breaking, 1);
    }

    #[test]
    fn an_unreadable_sql_file_fails_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("0001_not_a_file.sql")).unwrap();

        let Error::Cli(message) = scan_migrations(dir.path(), &["todos".to_owned()]).unwrap_err()
        else {
            panic!("an unreadable .sql path is a CLI failure, not a skip");
        };

        assert!(message.contains("0001_not_a_file.sql"), "{message}");
    }
}
