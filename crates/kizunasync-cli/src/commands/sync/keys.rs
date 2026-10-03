//! A synced table whose primary key is no longer the key
//! `kizunasync._config` records gets the current one recorded again. Devices
//! hold the table's rows under the recorded key, pull-only or read-write, so a
//! run records a new one only while it raises the table's
//! `min_schema_version`, which makes every device bootstrap the table again,
//! and the delta re-keys the table's changelog after the update: the rule a
//! move to another bucket column follows (@docs/reference/sql-pack.md).

use crate::commands::UNUSABLE;
use crate::commands::table_checks::{
    generated_always_refusal, indented, offline_insert_note, rekey_line, unbumped_rekey_refusal,
    unkeyed_refusal,
};
use crate::config::{KizunaSyncConfig, TableConfig};
use crate::config_sql::DeclaredTableConfig;
use crate::proposals::{SchemaCatalog, SyncMode};
use crate::sync_delta::DeltaUpdate;
use crate::ui::Ui;

/// The key `catalog` holds for the synced `table` when it differs from the
/// one `live` records, `None` when it matches and for a table `catalog` does
/// not hold. `Err` is the refusal when the table's current key is one the
/// pack cannot key by.
pub(crate) fn rekey(
    table: &str,
    live: &TableConfig,
    catalog: &SchemaCatalog,
) -> Result<Option<Vec<String>>, String> {
    if !catalog.tables.iter().any(|known| known == table) {
        return Ok(None);
    }

    let current = catalog
        .primary_keys
        .get(table)
        .map(crate::proposals::PrimaryKey::column_names);
    if current.as_ref() == Some(&live.key_columns) {
        return Ok(None);
    }
    if let Some(refusal) = unkeyed_refusal(table, catalog) {
        return Err(refusal);
    }

    Ok(current)
}

/// `Some(2)` once the refusal is on `ui`, when an update in `updated` records
/// a new key for a table without raising its `min_schema_version`, or leaves
/// a table read-write over a key `catalog` shows generated always as
/// identity. Every other update that records a key or makes its table
/// read-write gets the offline-insert note its key calls for.
pub(crate) fn review_updates(
    updated: &[DeltaUpdate],
    config: &KizunaSyncConfig,
    catalog: &SchemaCatalog,
    ui: &mut Ui,
) -> Option<i32> {
    for update in updated {
        let Some(live) = config.tables.get(&update.table) else {
            continue;
        };
        let after = update.declared.over(live);
        let rekeyed = update
            .declared
            .key_columns
            .as_ref()
            .is_some_and(|columns| *columns != live.key_columns);
        let bumped = update
            .declared
            .min_schema_version
            .is_some_and(|version| version > live.min_schema_version);
        if rekeyed && !bumped {
            ui.error(&unbumped_rekey_refusal(
                &update.table,
                &live.key_columns,
                &after.key_columns,
                live.min_schema_version,
            ));

            return Some(UNUSABLE);
        }

        let turns_read_write = update.declared.sync == Some(SyncMode::ReadWrite);
        let Some(key) = catalog.primary_keys.get(&update.table) else {
            continue;
        };
        if after.sync != SyncMode::ReadWrite.as_str() || !(rekeyed || turns_read_write) {
            continue;
        }
        if let Some(refusal) = generated_always_refusal(&update.table, key) {
            ui.error(&indented(&refusal));

            return Some(UNUSABLE);
        }
        if let Some(note) = offline_insert_note(&update.table, key) {
            ui.log(&note);
        }
    }

    None
}

/// An update recording the current key of every synced table that stays
/// synced (every one `removed` does not name) whose key moved, each reviewed
/// by [`review_updates`]. The walk that asks for this raises no schema
/// version, so a moved key is refused with the command that records it.
/// `Err(2)` once a refusal is on `ui`.
pub(crate) fn rekey_kept(
    config: &KizunaSyncConfig,
    removed: &[String],
    catalog: &SchemaCatalog,
    ui: &mut Ui,
) -> Result<Vec<DeltaUpdate>, i32> {
    let mut updated = Vec::new();
    for (table, live) in &config.tables {
        if removed.contains(table) {
            continue;
        }
        match rekey(table, live, catalog) {
            Err(refusal) => {
                ui.error(&indented(&refusal));

                return Err(UNUSABLE);
            }
            Ok(None) => {}
            Ok(Some(current)) => {
                ui.log(&rekey_line(table, &live.key_columns, &current));
                updated.push(DeltaUpdate {
                    table: table.clone(),
                    declared: DeclaredTableConfig {
                        key_columns: Some(current),
                        ..DeclaredTableConfig::default()
                    },
                    relabel: false,
                });
            }
        }
    }

    review_updates(&updated, config, catalog, ui).map_or(Ok(updated), Err)
}
