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
//! The pack keys every change by the table's primary key, so a table without
//! one is refused, and so is a key column whose type renders a different text
//! on the device than on the server. A read-write table is refused over a key
//! generated always as identity, since devices mint the key of every row they
//! insert, and one whose key has a database default gets a note: offline
//! inserts supply that value themselves (@packages/protocol/decisions/D-row-key.md).

use std::collections::BTreeSet;

use crate::commands::UNUSABLE;
use crate::config::{KizunaSyncConfig, TableConfig};
use crate::config_sql::ResolvedTableConfig;
use crate::prompts::{Prompter, TableChoice};
use crate::proposals::{
    KeyColumn, PrimaryKey, SchemaCatalog, SyncMode, TableProposal, build_table_config,
    describe_key_columns, listed,
};
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

/// Why a key column's type matters.
const TEXT_FORM: &str = "text form is not identical on the device and on the server";

/// The key column types, as a refusal names them.
const KEY_TYPES_SENTENCE: &str =
    "A key column is uuid, text, character varying, smallint, integer, or bigint.";

/// What a table's primary key lacks for the pack to key its rows by.
enum KeyFault<'a> {
    /// The table has no primary key.
    Missing,
    /// Key columns of a type whose text form differs between the two sides.
    Types(Vec<&'a KeyColumn>),
}

/// The fault `catalog` shows in `table`'s key, `None` for a key the pack can
/// sync by and for a table `catalog` does not hold, which the push itself
/// refuses.
fn key_fault<'a>(table: &str, catalog: &'a SchemaCatalog) -> Option<KeyFault<'a>> {
    if !catalog.tables.iter().any(|known| known == table) {
        return None;
    }

    fault_of(catalog.primary_keys.get(table))
}

/// The fault in `key`, `None` for a key the pack can sync by.
fn fault_of(key: Option<&PrimaryKey>) -> Option<KeyFault<'_>> {
    let Some(key) = key else {
        return Some(KeyFault::Missing);
    };
    let columns = key.unkeyable_columns();

    (!columns.is_empty()).then_some(KeyFault::Types(columns))
}

/// Each column as `name (type)`.
fn typed(columns: &[&KeyColumn]) -> Vec<String> {
    columns
        .iter()
        .map(|column| format!("{} ({})", column.name, column.data_type))
        .collect()
}

/// What the list says beside a table the pack cannot key. `None` as for
/// [`key_fault`].
pub(crate) fn unkeyed_reason(table: &str, catalog: &SchemaCatalog) -> Option<String> {
    key_fault(table, catalog).map(|fault| describe_fault(&fault))
}

/// What is wrong with `key` in a few words, `None` for a key the pack can
/// sync by: the phrase `doctor` names a synced table's key with.
pub(crate) fn key_reason(key: Option<&PrimaryKey>) -> Option<String> {
    fault_of(key).map(|fault| describe_fault(&fault))
}

fn describe_fault(fault: &KeyFault<'_>) -> String {
    match fault {
        KeyFault::Missing => "no primary key".to_owned(),
        KeyFault::Types(columns) => match columns.as_slice() {
            [only] => format!("key column {} is {}", only.name, only.data_type),
            _ => format!("key columns {}", listed(&typed(columns))),
        },
    }
}

/// The refusal a run prints for a table the pack cannot key: why, naming each
/// key column it cannot key by with its type. `None` as for [`key_fault`].
pub(crate) fn unkeyed_refusal(table: &str, catalog: &SchemaCatalog) -> Option<String> {
    let reason = match key_fault(table, catalog)? {
        KeyFault::Missing => "it has no primary key, and the pack keys every change by the table's primary key. Add one in a migration you review, then run the command again.".to_owned(),
        KeyFault::Types(columns) => match columns.as_slice() {
            [only] => format!(
                "its key column {} is {}, and its {TEXT_FORM}. {KEY_TYPES_SENTENCE}",
                only.name, only.data_type
            ),
            _ => format!(
                "its key columns {} have types whose {TEXT_FORM}. {KEY_TYPES_SENTENCE}",
                listed(&typed(&columns))
            ),
        },
    };

    Some(format!("refusing to sync {table}: {reason}"))
}

/// The refusal for `table` synced read-write over `key` when a key column is
/// generated always as identity, `None` when none is: a device mints the key
/// of every row it inserts, and the database refuses a supplied value.
pub(crate) fn generated_always_refusal(table: &str, key: &PrimaryKey) -> Option<String> {
    let columns: Vec<String> = key
        .generated_always_columns()
        .iter()
        .map(|column| column.name.clone())
        .collect();
    let (noun, verb, value, object) = match columns.as_slice() {
        [] => return None,
        [_] => ("column", "is", "its value", "it"),
        _ => ("columns", "are", "their values", "them"),
    };

    Some(format!(
        "refusing to sync {table} read-write: its key {noun} {} {verb} generated always as identity, so devices cannot supply {value}. Make {object} generated by default as identity, key the table by a uuid column, or sync it pull-only.",
        listed(&columns)
    ))
}

/// The note for `table` synced read-write over `key` when a key column has a
/// database default, `None` when none has: the default runs on the server, so
/// a device inserting offline supplies the value itself.
pub(crate) fn offline_insert_note(table: &str, key: &PrimaryKey) -> Option<String> {
    let columns: Vec<String> = key
        .defaulted_columns()
        .iter()
        .map(|column| column.name.clone())
        .collect();
    if columns.is_empty() {
        return None;
    }

    Some(format!(
        "  note: {table} is read-write and its key has a database default: offline inserts must provide {}.",
        listed(&columns)
    ))
}

/// The line a run prints for a table whose key it records again: the key
/// the table has now, `current`, and the one `_config` records.
pub(crate) fn rekey_line(table: &str, recorded: &[String], current: &[String]) -> String {
    format!(
        "  {table}: its primary key is {}, and kizunasync._config records {}: recording the current key.",
        describe_key_columns(current),
        describe_key_columns(recorded)
    )
}

/// The refusal for a run that would record `current` as `table`'s key
/// without raising its `min_schema_version` above `min_schema_version`:
/// devices hold the table's rows under the recorded key, so every one has to
/// bootstrap the table again, and the command that records the key with the
/// bump.
pub(crate) fn unbumped_rekey_refusal(
    table: &str,
    recorded: &[String],
    current: &[String],
    min_schema_version: i64,
) -> String {
    format!(
        "  refusing to record the key {} of {table} without raising --min-schema-version above {min_schema_version}: devices hold its rows under {}, the key kizunasync._config records, so every device has to bootstrap {table} again. Run `kizunasync sync --add {table} --min-schema-version {}`.",
        describe_key_columns(current),
        describe_key_columns(recorded),
        min_schema_version + 1
    )
}

/// The tables among `proposals` whose primary key is no longer the key
/// `recorded` records for them, each logged with [`rekey_line`]: the tables
/// the migration re-keys. `Err(2)` once the refusal is on `ui`, when one of
/// them does not raise its `min_schema_version` above the recorded one.
pub(crate) fn rekeyed_proposals(
    proposals: &[TableProposal],
    recorded: &KizunaSyncConfig,
    ui: &mut Ui,
) -> Result<Vec<String>, i32> {
    let mut rekeyed = Vec::new();
    for proposal in proposals {
        let Some(live) = recorded.tables.get(&proposal.table) else {
            continue;
        };
        let current = proposal.key_columns();
        if proposal.key.is_none() || current == live.key_columns {
            continue;
        }
        if ResolvedTableConfig::from_proposal(proposal).min_schema_version
            <= live.min_schema_version
        {
            ui.error(&unbumped_rekey_refusal(
                &proposal.table,
                &live.key_columns,
                &current,
                live.min_schema_version,
            ));

            return Err(UNUSABLE);
        }
        ui.log(&rekey_line(&proposal.table, &live.key_columns, &current));
        rekeyed.push(proposal.table.clone());
    }

    Ok(rekeyed)
}

/// `Some(2)` once every refusal is on `ui`, when a proposal resolves
/// read-write over a key generated always as identity. Otherwise every
/// read-write proposal whose key has a database default gets its note.
pub(crate) fn review_proposal_keys(proposals: &[TableProposal], ui: &mut Ui) -> Option<i32> {
    let read_write: Vec<(&str, &PrimaryKey)> = proposals
        .iter()
        .filter(|proposal| build_table_config(proposal).sync == SyncMode::ReadWrite)
        .filter_map(|proposal| Some((proposal.table.as_str(), proposal.key.as_ref()?)))
        .collect();
    let refusals: Vec<String> = read_write
        .iter()
        .filter_map(|(table, key)| generated_always_refusal(table, key))
        .collect();
    if !refusals.is_empty() {
        for refusal in refusals {
            ui.error(&indented(&refusal));
        }

        return Some(UNUSABLE);
    }

    for (table, key) in read_write {
        if let Some(note) = offline_insert_note(table, key) {
            ui.log(&note);
        }
    }

    None
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
/// list, so the reason is on screen where the table cannot be picked.
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
pub(crate) fn indented(text: &str) -> String {
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
    use crate::proposals::{Identity, KeyColumn, SyncMode};

    /// A catalog holding `table` with `key`, beside a `todos` keyed by a
    /// uuid `id`.
    fn catalog(table: &str, key: Option<PrimaryKey>) -> SchemaCatalog {
        let mut catalog = SchemaCatalog {
            tables: vec!["todos".to_owned(), table.to_owned()],
            ..Default::default()
        }
        .keyed_by_uuid_id();
        catalog.primary_keys.remove(table);
        if let Some(key) = key {
            catalog.primary_keys.insert(table.to_owned(), key);
        }

        catalog
    }

    /// A key whose middle column's type the pack cannot key by.
    fn priced() -> SchemaCatalog {
        catalog(
            "prices",
            Some(PrimaryKey::of(
                "prices_pkey",
                &[
                    ("sku", "text"),
                    ("amount", "numeric"),
                    ("region", "smallint"),
                ],
            )),
        )
    }

    /// `table` resolved `sync`, keyed by `key`.
    fn proposal(table: &str, sync: SyncMode, key: PrimaryKey) -> TableProposal {
        TableProposal {
            sync: Some(sync),
            key: Some(key),
            ..TableProposal::derived(table, None, "[flag]")
        }
    }

    #[test]
    fn a_table_without_a_primary_key_is_refused() {
        let logs = catalog("logs", None);

        assert_eq!(
            unkeyed_refusal("logs", &logs).unwrap(),
            "refusing to sync logs: it has no primary key, and the pack keys every change by the table's primary key. Add one in a migration you review, then run the command again."
        );
        assert_eq!(unkeyed_reason("logs", &logs).unwrap(), "no primary key");
    }

    #[test]
    fn a_key_column_of_another_type_is_refused_by_name_type_and_reason() {
        let events = catalog(
            "events",
            Some(PrimaryKey::of(
                "events_pkey",
                &[("at", "timestamp with time zone")],
            )),
        );

        assert_eq!(
            unkeyed_refusal("events", &events).unwrap(),
            "refusing to sync events: its key column at is timestamp with time zone, and its text form is not identical on the device and on the server. A key column is uuid, text, character varying, smallint, integer, or bigint."
        );
        assert_eq!(
            unkeyed_reason("events", &events).unwrap(),
            "key column at is timestamp with time zone"
        );
    }

    #[test]
    fn every_unkeyable_column_of_a_composite_key_is_named_and_only_those() {
        let catalog = catalog(
            "readings",
            Some(PrimaryKey::of(
                "readings_pkey",
                &[
                    ("sensor", "bigint"),
                    ("at", "date"),
                    ("value", "double precision"),
                ],
            )),
        );

        assert_eq!(
            unkeyed_refusal("readings", &catalog).unwrap(),
            "refusing to sync readings: its key columns at (date) and value (double precision) have types whose text form is not identical on the device and on the server. A key column is uuid, text, character varying, smallint, integer, or bigint."
        );
        assert_eq!(
            unkeyed_reason("readings", &catalog).unwrap(),
            "key columns at (date) and value (double precision)"
        );
        assert_eq!(
            unkeyed_reason("prices", &priced()).unwrap(),
            "key column amount is numeric"
        );
    }

    /// A single or composite key over the six key types passes, a domain over
    /// one of them too, and a table the catalog does not hold is left to the
    /// push.
    #[test]
    fn a_key_of_any_supported_shape_is_not_refused() {
        for key in [
            PrimaryKey::of("t_pkey", &[("id", "uuid")]),
            PrimaryKey::of("t_pkey", &[("id", "bigint")]),
            PrimaryKey::of("t_pkey", &[("slug", "text")]),
            PrimaryKey::of("t_pkey", &[("hall", "bigint"), ("seat", "integer")]),
            PrimaryKey::over(
                "t_pkey",
                vec![
                    KeyColumn::plain("code", "character varying(64)")
                        .over_base("character varying"),
                    KeyColumn::plain("rank", "smallint"),
                ],
            ),
            PrimaryKey::over(
                "t_pkey",
                vec![KeyColumn::plain("slug", "slug_domain").over_base("text")],
            ),
        ] {
            let catalog = catalog("keyed", Some(key.clone()));

            assert_eq!(unkeyed_refusal("keyed", &catalog), None, "{key:?}");
            assert_eq!(unkeyed_reason("keyed", &catalog), None, "{key:?}");
        }
        assert_eq!(unkeyed_refusal("ghost", &priced()), None);
    }

    #[test]
    fn a_flag_run_prints_every_refusal_and_stops_on_exit_two() {
        let (mut ui, capture) = Ui::capture();
        let catalog = priced();

        assert_eq!(
            refuse_unkeyed(["todos", "prices"], &catalog, &mut ui),
            Some(UNUSABLE)
        );
        assert_eq!(refuse_unkeyed(["todos"], &catalog, &mut ui), None);
        let stderr = capture.stderr();
        assert!(
            stderr.starts_with(
                "✗   refusing to sync prices: its key column amount is numeric, and its text form"
            ),
            "{stderr}"
        );
        assert!(!stderr.contains("refusing to sync todos"), "{stderr}");
        assert!(!stderr.contains("migration"), "{stderr}");
    }

    #[test]
    fn an_unkeyed_table_is_offered_unavailable_and_unchecked() {
        let catalog = priced();
        let offered = keyed_choice(TableChoice::new("prices", true), &catalog);
        let keyed = keyed_choice(TableChoice::new("todos", true), &catalog);

        assert!(offered.unavailable);
        assert!(!offered.checked);
        assert_eq!(offered.hint, unkeyed_reason("prices", &catalog).unwrap());
        assert!(!keyed.unavailable);
        assert!(keyed.checked);
    }

    /// Devices mint the key of a row they insert, and the database refuses a
    /// supplied value for a column generated always: read-write is refused,
    /// pull-only is not.
    #[test]
    fn a_read_write_table_keyed_by_a_generated_always_identity_is_refused() {
        let key = PrimaryKey::over(
            "events_pkey",
            vec![KeyColumn::plain("id", "bigint").generated(Identity::Always)],
        );
        let (mut ui, capture) = Ui::capture();

        assert_eq!(
            review_proposal_keys(
                &[proposal("events", SyncMode::ReadWrite, key.clone())],
                &mut ui
            ),
            Some(UNUSABLE)
        );
        assert_eq!(
            review_proposal_keys(&[proposal("events", SyncMode::PullOnly, key)], &mut ui),
            None
        );
        assert_eq!(
            capture.stderr(),
            "✗   refusing to sync events read-write: its key column id is generated always as identity, so devices cannot supply its value. Make it generated by default as identity, key the table by a uuid column, or sync it pull-only.\n"
        );
    }

    /// A value the database picks is one a device offline does not know; a
    /// minted uuid is one it does.
    #[test]
    fn a_read_write_key_with_a_database_default_gets_the_offline_insert_note() {
        let counters = PrimaryKey::over(
            "counters_pkey",
            vec![KeyColumn::plain("id", "bigint").generated(Identity::ByDefault)],
        );
        let seats = PrimaryKey::over(
            "seats_pkey",
            vec![
                KeyColumn::plain("hall", "bigint"),
                KeyColumn::plain("seat", "integer")
                    .defaulting("nextval('seats_seat_seq'::regclass)"),
            ],
        );
        let todos = PrimaryKey::over(
            "todos_pkey",
            vec![KeyColumn::plain("id", "uuid").defaulting("gen_random_uuid()")],
        );
        let (mut ui, capture) = Ui::capture();

        assert_eq!(
            review_proposal_keys(
                &[
                    proposal("counters", SyncMode::ReadWrite, counters.clone()),
                    proposal("seats", SyncMode::ReadWrite, seats),
                    proposal("todos", SyncMode::ReadWrite, todos),
                    proposal("feed", SyncMode::PullOnly, counters),
                ],
                &mut ui
            ),
            None
        );
        assert_eq!(
            capture.stderr(),
            "  note: counters is read-write and its key has a database default: offline inserts must provide id.\n  note: seats is read-write and its key has a database default: offline inserts must provide seat.\n"
        );
    }
}
