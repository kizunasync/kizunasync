//! What `init` and `sync` check about the tables a run provisions.
//!
//! A pull renders every row under the reader's own policies, so a table whose
//! row level security is disabled hands every row to any signed-in user. A run
//! that read the catalog refuses such a table unless `--allow-no-rls` accepts
//! it. A read-write table with neither a bucket column nor a soft-delete column
//! is provisioned with a warning: its tombstones are table-scoped, so they reach
//! every user who pulled any of its rows
//! (@packages/protocol/decisions/D-tombstone-delivery.md).
//!
//! The pack keys every change by a `uuid` column named `id`, so a table whose
//! primary key is anything else is refused, with a migration the reader can
//! review to give it one. The CLI never runs that migration.

use std::collections::BTreeSet;

use crate::commands::UNUSABLE;
use crate::config::TableConfig;
use crate::config_sql::{ResolvedTableConfig, qualified_table, quote_ident};
use crate::prompts::{Prompter, TableChoice};
use crate::proposals::{PrimaryKey, SchemaCatalog, SyncMode, TableProposal};
use crate::ui::Ui;

/// `Some(2)` once the refusal is on `ui`, when a table in `tables` is one of
/// `rls_disabled` and the run did not pass `--allow-no-rls`. With the flag the
/// same tables are named in a warning and the run goes on.
pub(crate) fn refuse_rls_disabled<'a>(
    tables: impl IntoIterator<Item = &'a str>,
    rls_disabled: &BTreeSet<String>,
    allow_no_rls: bool,
    ui: &mut Ui,
) -> Option<i32> {
    let disabled: Vec<&str> = tables
        .into_iter()
        .filter(|table| rls_disabled.contains(*table))
        .collect();
    if disabled.is_empty() {
        return None;
    }

    let list = disabled.join(", ");
    if allow_no_rls {
        ui.warn(&format!(
            "  --allow-no-rls: syncing {list} with row level security disabled, so a pull hands every row to any signed-in user."
        ));

        return None;
    }

    let pronoun = if disabled.len() == 1 { "it" } else { "them" };
    ui.error(&format!(
        "  refusing to sync {list}: row level security is disabled on {pronoun}, so a pull would hand every row to any signed-in user. Enable it (`alter table public.<table> enable row level security;`) and add policies, or pass --allow-no-rls."
    ));

    Some(UNUSABLE)
}

/// Warn when `contract` leaves `table` read-write with neither a bucket column
/// nor a soft-delete column.
pub(crate) fn warn_unscoped_deletes(table: &str, contract: &TableConfig, ui: &mut Ui) {
    if contract.sync != SyncMode::ReadWrite.as_str()
        || contract.bucket_column().is_some()
        || contract.soft_delete.is_some()
    {
        return;
    }

    ui.warn(&format!(
        "  {table} is read-write with no bucket column and no soft-delete column: every user who pulls a row of it also receives the id of every row deleted from it, rows their policies hide included. A soft-delete column (--soft-delete <column>) keeps each removal an ordinary row update under the reader's policies."
    ));
}

/// [`warn_unscoped_deletes`] for every proposal, as it resolves.
pub(crate) fn warn_unscoped_proposals(proposals: &[TableProposal], ui: &mut Ui) {
    for proposal in proposals {
        warn_unscoped_deletes(
            &proposal.table,
            &ResolvedTableConfig::from_proposal(proposal).as_table_config(),
            ui,
        );
    }
}

// MARK: - the sync key

/// Why every change needs the key: the pack's triggers read `new.id` and
/// `old.id`.
const SYNC_KEY_RULE: &str = "the pack keys every change by a uuid primary key named id";

/// Where the old `id` goes when a uuid column takes its name.
const LEGACY_ID: &str = "legacy_id";

/// A key the pack cannot sync a table by.
enum Unkeyed<'a> {
    /// The table has no primary key.
    Missing,
    /// Its primary key is not one uuid column named `id`.
    Other(&'a PrimaryKey),
}

impl Unkeyed<'_> {
    /// The table's key, as the refusal names it.
    fn phrase(&self) -> String {
        match self {
            Self::Missing => "it has no primary key".to_owned(),
            Self::Other(key) => format!("its primary key is {}", key.describe()),
        }
    }
}

/// The key `catalog` holds for `table` when the pack cannot sync by it,
/// `None` for a table it can sync and for one `catalog` does not hold, which
/// the push itself refuses.
fn unkeyed<'a>(table: &str, catalog: &'a SchemaCatalog) -> Option<Unkeyed<'a>> {
    if !catalog.tables.iter().any(|known| known == table) {
        return None;
    }

    match catalog.primary_keys.get(table) {
        None => Some(Unkeyed::Missing),
        Some(key) if key.is_sync_key() => None,
        Some(key) => Some(Unkeyed::Other(key)),
    }
}

/// What the list says beside a table the pack cannot key. `None` as for
/// [`unkeyed`].
pub(crate) fn unkeyed_reason(table: &str, catalog: &SchemaCatalog) -> Option<String> {
    let fault = unkeyed(table, catalog)?;

    Some(format!(
        "{}; the pack needs a uuid primary key named id",
        fault.phrase()
    ))
}

/// The refusal a run prints for a table the pack cannot key: why, the key the
/// table has, and a migration that gives it the key. `None` as for
/// [`unkeyed`].
pub(crate) fn unkeyed_refusal(table: &str, catalog: &SchemaCatalog) -> Option<String> {
    let fault = unkeyed(table, catalog)?;
    let id_type = catalog
        .columns
        .get(table)
        .and_then(|columns| columns.iter().find(|column| column.name == "id"))
        .map(|column| column.data_type.as_str());
    let key = match &fault {
        Unkeyed::Missing => None,
        Unkeyed::Other(key) => Some(*key),
    };
    let migration = key_migration(table, id_type, key);
    let mut refusal = format!(
        "refusing to sync {table}: {SYNC_KEY_RULE}, and {}. Review this migration, add it to your migrations and apply it, then run the command again (kizunasync never runs it for you):\n\n{}",
        fault.phrase(),
        migration
            .iter()
            .map(|statement| format!("    {statement}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let notes = key_notes(id_type, key);
    if !notes.is_empty() {
        refusal.push_str("\n\n");
        refusal.push_str(&notes.join(" "));
    }

    Some(refusal)
}

/// The statements that give `table` a uuid primary key named `id`, keeping
/// the old key unique. `id_type` is the type of a column named `id` the table
/// already has.
fn key_migration(table: &str, id_type: Option<&str>, key: Option<&PrimaryKey>) -> Vec<String> {
    let alter = format!("alter table {}", qualified_table(table));
    let mut statements = Vec::new();
    match id_type {
        Some("uuid") => {
            statements.push(format!(
                "{alter} alter column id set default gen_random_uuid();"
            ));
        }
        Some(_) => {
            statements.push(format!("{alter} rename column id to {LEGACY_ID};"));
            statements.push(format!(
                "{alter} add column id uuid not null default gen_random_uuid();"
            ));
        }
        None => statements.push(format!(
            "{alter} add column id uuid not null default gen_random_uuid();"
        )),
    }
    if let Some(key) = key {
        statements.push(format!(
            "{alter} drop constraint {};",
            quote_ident(&key.constraint)
        ));
    }
    statements.push(format!("{alter} add primary key (id);"));
    if let Some(key) = key {
        let columns: Vec<String> = kept_key(key, id_type)
            .iter()
            .map(|column| quote_ident(column))
            .collect();
        statements.push(format!("{alter} add unique ({});", columns.join(", ")));
    }

    statements
}

/// What the reader needs to know about [`key_migration`]'s statements.
fn key_notes(id_type: Option<&str>, key: Option<&PrimaryKey>) -> Vec<String> {
    let mut notes = Vec::new();
    if id_type.is_some_and(|data_type| data_type != "uuid") {
        notes.push(format!(
            "The rename keeps the old id as {LEGACY_ID}, so code that reads id changes with it."
        ));
    }
    if let Some(key) = key {
        notes.push(format!(
            "The unique constraint keeps upserts on ({}) working. A foreign key that references the old primary key blocks the drop: drop it before the migration, then create it again against the unique constraint.",
            kept_key(key, id_type).join(", ")
        ));
    }

    notes
}

/// The old key's columns as they are named once the migration ran.
fn kept_key<'a>(key: &'a PrimaryKey, id_type: Option<&str>) -> Vec<&'a str> {
    let renamed = id_type.is_some_and(|data_type| data_type != "uuid");

    key.columns
        .iter()
        .map(|column| {
            if renamed && column.name == "id" {
                LEGACY_ID
            } else {
                column.name.as_str()
            }
        })
        .collect()
}

/// `Some(2)` once every refusal is on `ui`, when a table in `tables` has a key
/// the pack cannot sync by.
pub(crate) fn refuse_unkeyed<'a>(
    tables: impl IntoIterator<Item = &'a str>,
    catalog: &SchemaCatalog,
    ui: &mut Ui,
) -> Option<i32> {
    let refusals: Vec<String> = tables
        .into_iter()
        .filter_map(|table| unkeyed_refusal(table, catalog))
        .collect();
    if refusals.is_empty() {
        return None;
    }

    for refusal in refusals {
        ui.error(&indented(&refusal));
    }

    Some(UNUSABLE)
}

/// `choice`, offered as unavailable when the pack cannot key its table.
pub(crate) fn keyed_choice(choice: TableChoice, catalog: &SchemaCatalog) -> TableChoice {
    match unkeyed_reason(&choice.table, catalog) {
        Some(reason) => choice.unavailable(&reason),
        None => choice,
    }
}

/// The refusal of every unavailable table in `choices`, in one note above the
/// list, so the migration is on screen where the table cannot be picked.
pub(crate) fn note_unavailable(
    choices: &[TableChoice],
    catalog: &SchemaCatalog,
    prompter: &mut dyn Prompter,
) {
    let refusals: Vec<String> = choices
        .iter()
        .filter(|choice| choice.unavailable)
        .filter_map(|choice| unkeyed_refusal(&choice.table, catalog))
        .collect();
    if refusals.is_empty() {
        return;
    }

    // The note only explains the list under it; the list still decides.
    let _ = prompter.note("Unavailable tables", &refusals.join("\n\n"));
}

/// Every line of `text` two columns in, the way a refusal sits under its mark.
fn indented(text: &str) -> String {
    text.lines()
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("  {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::proposals::ColumnInfo;

    /// A catalog holding `table` with `key` and `columns`, each a name and its
    /// type, beside a `todos` keyed the way the pack syncs.
    fn catalog(table: &str, key: Option<PrimaryKey>, columns: &[(&str, &str)]) -> SchemaCatalog {
        let mut catalog = SchemaCatalog {
            tables: vec!["todos".to_owned(), table.to_owned()],
            ..Default::default()
        }
        .keyed_by_uuid_id();
        catalog.primary_keys.remove(table);
        if let Some(key) = key {
            catalog.primary_keys.insert(table.to_owned(), key);
        }
        catalog.columns.insert(
            table.to_owned(),
            columns
                .iter()
                .map(|(name, data_type)| ColumnInfo {
                    name: (*name).to_owned(),
                    data_type: (*data_type).to_owned(),
                })
                .collect(),
        );

        catalog
    }

    /// The table from the report the rule came from: a composite natural key.
    fn favorites() -> SchemaCatalog {
        catalog(
            "user_favorite_places",
            Some(PrimaryKey::of(
                "user_favorite_places_pkey",
                &[("user_id", "uuid"), ("geoname_id", "bigint")],
            )),
            &[
                ("user_id", "uuid"),
                ("geoname_id", "bigint"),
                ("created_at", "timestamp with time zone"),
            ],
        )
    }

    #[test]
    fn a_composite_key_is_refused_with_a_migration_that_keeps_it_unique() {
        assert_eq!(
            unkeyed_refusal("user_favorite_places", &favorites()).unwrap(),
            "refusing to sync user_favorite_places: the pack keys every change by a uuid primary key named id, and its primary key is (user_id uuid, geoname_id bigint). Review this migration, add it to your migrations and apply it, then run the command again (kizunasync never runs it for you):\n\
             \n    alter table public.\"user_favorite_places\" add column id uuid not null default gen_random_uuid();\
             \n    alter table public.\"user_favorite_places\" drop constraint \"user_favorite_places_pkey\";\
             \n    alter table public.\"user_favorite_places\" add primary key (id);\
             \n    alter table public.\"user_favorite_places\" add unique (\"user_id\", \"geoname_id\");\n\
             \nThe unique constraint keeps upserts on (user_id, geoname_id) working. A foreign key that references the old primary key blocks the drop: drop it before the migration, then create it again against the unique constraint."
        );
        assert_eq!(
            unkeyed_reason("user_favorite_places", &favorites()).unwrap(),
            "its primary key is (user_id uuid, geoname_id bigint); the pack needs a uuid primary key named id"
        );
    }

    /// A bigint identity key is named `id` itself, so the migration moves it
    /// aside before the uuid column takes the name.
    #[test]
    fn an_integer_id_is_renamed_before_the_uuid_id_takes_its_place() {
        let events = catalog(
            "events",
            Some(PrimaryKey::of("events_pkey", &[("id", "bigint")])),
            &[("id", "bigint"), ("title", "text")],
        );

        assert_eq!(
            unkeyed_refusal("events", &events).unwrap(),
            "refusing to sync events: the pack keys every change by a uuid primary key named id, and its primary key is (id bigint). Review this migration, add it to your migrations and apply it, then run the command again (kizunasync never runs it for you):\n\
             \n    alter table public.\"events\" rename column id to legacy_id;\
             \n    alter table public.\"events\" add column id uuid not null default gen_random_uuid();\
             \n    alter table public.\"events\" drop constraint \"events_pkey\";\
             \n    alter table public.\"events\" add primary key (id);\
             \n    alter table public.\"events\" add unique (\"legacy_id\");\n\
             \nThe rename keeps the old id as legacy_id, so code that reads id changes with it. The unique constraint keeps upserts on (legacy_id) working. A foreign key that references the old primary key blocks the drop: drop it before the migration, then create it again against the unique constraint."
        );
    }

    #[test]
    fn a_table_without_a_primary_key_is_given_one() {
        let logs = catalog("logs", None, &[("message", "text")]);

        assert_eq!(
            unkeyed_refusal("logs", &logs).unwrap(),
            "refusing to sync logs: the pack keys every change by a uuid primary key named id, and it has no primary key. Review this migration, add it to your migrations and apply it, then run the command again (kizunasync never runs it for you):\n\
             \n    alter table public.\"logs\" add column id uuid not null default gen_random_uuid();\
             \n    alter table public.\"logs\" add primary key (id);"
        );
        assert_eq!(
            unkeyed_reason("logs", &logs).unwrap(),
            "it has no primary key; the pack needs a uuid primary key named id"
        );
    }

    /// A uuid `id` outside the key only needs the key moved onto it.
    #[test]
    fn a_uuid_id_outside_the_key_becomes_the_key() {
        let members = catalog(
            "members",
            Some(PrimaryKey::of(
                "members_pkey",
                &[("team_id", "uuid"), ("id", "uuid")],
            )),
            &[("team_id", "uuid"), ("id", "uuid")],
        );
        let refusal = unkeyed_refusal("members", &members).unwrap();

        assert!(
            refusal.contains(
                "\n    alter table public.\"members\" alter column id set default gen_random_uuid();\
                 \n    alter table public.\"members\" drop constraint \"members_pkey\";\
                 \n    alter table public.\"members\" add primary key (id);\
                 \n    alter table public.\"members\" add unique (\"team_id\", \"id\");\n"
            ),
            "{refusal}"
        );
        assert!(!refusal.contains("add column id"), "{refusal}");
    }

    /// A table the catalog does not hold is left to the push, and a table
    /// keyed by a uuid `id` passes.
    #[test]
    fn a_keyed_or_unknown_table_is_not_refused() {
        let catalog = favorites();

        assert_eq!(unkeyed_refusal("todos", &catalog), None);
        assert_eq!(unkeyed_reason("todos", &catalog), None);
        assert_eq!(unkeyed_refusal("ghost", &catalog), None);
    }

    #[test]
    fn a_flag_run_prints_every_refusal_and_stops_on_exit_two() {
        let (mut ui, capture) = Ui::capture();
        let catalog = favorites();

        assert_eq!(
            refuse_unkeyed(["todos", "user_favorite_places"], &catalog, &mut ui),
            Some(UNUSABLE)
        );
        assert_eq!(refuse_unkeyed(["todos"], &catalog, &mut ui), None);
        let stderr = capture.stderr();
        assert!(
            stderr.starts_with("✗   refusing to sync user_favorite_places: "),
            "{stderr}"
        );
        assert!(
            stderr.contains(
                "\n      alter table public.\"user_favorite_places\" add primary key (id);\n"
            ),
            "{stderr}"
        );
        assert!(!stderr.contains("refusing to sync todos"), "{stderr}");
    }

    #[test]
    fn an_unkeyed_table_is_offered_unavailable_and_unchecked() {
        let catalog = favorites();
        let offered = keyed_choice(TableChoice::new("user_favorite_places", true), &catalog);
        let keyed = keyed_choice(TableChoice::new("todos", true), &catalog);

        assert!(offered.unavailable);
        assert!(!offered.checked);
        assert_eq!(
            offered.hint,
            unkeyed_reason("user_favorite_places", &catalog).unwrap()
        );
        assert!(!keyed.unavailable);
        assert!(keyed.checked);
    }
}
