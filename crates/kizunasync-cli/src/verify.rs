//! What `init` and `sync` check once their migrations applied: the ledger
//! records the pack this build ships, and `kizunasync._config` holds every
//! table the run provisioned with the key, the mode, and the bucket it
//! planned, and none it removed. A push that applied nothing (a migration
//! the history already recorded, a directory that no longer matches the
//! database) passes `supabase db push` and fails here, so a run never reports
//! success over a database that holds nothing.

use std::collections::BTreeMap;

use crate::applier::Applier;
use crate::config::{TableConfig, load_synced_tables};
use crate::error::Result;
use crate::pack::PackFile;
use crate::proposals::describe_key_columns;
use crate::provision::{LedgerRow, PACK_FILE_KIND, hash_pack_file, read_ledger_rows};

/// A table a run provisioned, as `kizunasync._config` must record it once
/// the run applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedTable {
    /// The table name.
    pub table: String,
    /// The key columns, in key order.
    pub key_columns: Vec<String>,
    /// The sync mode literal.
    pub sync: String,
    /// The bucket column, when the table has one.
    pub bucket_column: Option<String>,
}

impl ExpectedTable {
    /// The table `config` describes.
    #[must_use]
    pub fn of(table: &str, config: &TableConfig) -> Self {
        Self {
            table: table.to_owned(),
            key_columns: config.key_columns.clone(),
            sync: config.sync.clone(),
            bucket_column: config.bucket_column().map(ToOwned::to_owned),
        }
    }
}

/// What a run expects the database to hold once its migrations applied.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Expectation {
    /// The pack files this build ships, each to be recorded under its own
    /// hash. `None` when there is no hash to hold the ledger to (no pack on
    /// disk, or a pack installed without per-file rows): the ledger then only
    /// has to record something.
    pub pack_files: Option<Vec<PackFile>>,
    /// The tables the run provisioned or updated.
    pub tables: Vec<ExpectedTable>,
    /// The tables the run stopped syncing.
    pub removed: Vec<String>,
}

/// What `ledger` and `synced` lack against `expected`, one sentence each,
/// empty when the database holds everything the run planned.
#[must_use]
pub fn provisioning_gaps(
    expected: &Expectation,
    ledger: &[LedgerRow],
    synced: &BTreeMap<String, TableConfig>,
) -> Vec<String> {
    let mut gaps = pack_gaps(expected.pack_files.as_deref(), ledger);
    for table in &expected.tables {
        let Some(live) = synced.get(&table.table) else {
            gaps.push(format!("kizunasync._config has no row for {}", table.table));
            continue;
        };
        if live.key_columns != table.key_columns {
            gaps.push(format!(
                "kizunasync._config records {} keyed by {}, the run provisioned {}",
                table.table,
                describe_key_columns(&live.key_columns),
                describe_key_columns(&table.key_columns)
            ));
        }
        if live.sync != table.sync {
            gaps.push(format!(
                "kizunasync._config records {} as {}, the run provisioned {}",
                table.table, live.sync, table.sync
            ));
        }
        if live.bucket_column() != table.bucket_column.as_deref() {
            gaps.push(format!(
                "kizunasync._config records the bucket column of {} as {}, the run provisioned {}",
                table.table,
                live.bucket_column().unwrap_or("none"),
                table.bucket_column.as_deref().unwrap_or("none")
            ));
        }
    }
    for table in &expected.removed {
        if synced.contains_key(table) {
            gaps.push(format!("kizunasync._config still holds {table}"));
        }
    }

    gaps
}

/// The pack half of [`provisioning_gaps`].
fn pack_gaps(pack_files: Option<&[PackFile]>, ledger: &[LedgerRow]) -> Vec<String> {
    let Some(pack_files) = pack_files else {
        return if ledger.is_empty() {
            vec!["the ledger is empty, so the pack is not installed".to_owned()]
        } else {
            Vec::new()
        };
    };
    let recorded: Vec<&LedgerRow> = ledger
        .iter()
        .filter(|row| row.object_kind == PACK_FILE_KIND)
        .collect();

    pack_files
        .iter()
        .filter_map(|file| {
            let hash = hash_pack_file(&file.sql);
            match recorded.iter().find(|row| row.object_name == file.name) {
                None => Some(format!(
                    "the ledger does not record the pack file {}",
                    file.name
                )),
                Some(row) if row.content_hash != hash => Some(format!(
                    "the ledger records the pack file {} with md5 {}, this build ships {hash}",
                    file.name, row.content_hash
                )),
                Some(_) => None,
            }
        })
        .collect()
}

/// [`provisioning_gaps`] over what `applier` reads: the ledger, and
/// `kizunasync._config` once the ledger shows a pack to read it from.
///
/// # Errors
/// Returns the transport's own failure, or a boundary error when a row does
/// not carry the columns the pack defines.
pub fn read_provisioning_gaps(
    applier: &dyn Applier,
    expected: &Expectation,
) -> Result<Vec<String>> {
    let ledger = read_ledger_rows(applier)?;
    let synced = if ledger.is_empty() {
        BTreeMap::new()
    } else {
        load_synced_tables(applier)?
    };

    Ok(provisioning_gaps(expected, &ledger, &synced))
}

/// The lines a run prints when the database lacks what it provisioned.
#[must_use]
pub fn describe_gaps(gaps: &[String]) -> String {
    let listed: Vec<String> = gaps.iter().map(|gap| format!("    - {gap}")).collect();

    format!(
        "\n  the migrations applied, but the database does not hold what they provision:\n{}\n  run `kizunasync status` to see what it holds.",
        listed.join("\n")
    )
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::applier::fake::{FakeApplier, text_row};
    use crate::config::BucketSpec;

    fn pack() -> Vec<PackFile> {
        vec![PackFile {
            name: "0001_kizuna_init.sql".to_owned(),
            sql: "create schema kizunasync;".to_owned(),
        }]
    }

    fn pack_row(hash: &str) -> LedgerRow {
        LedgerRow {
            object_kind: PACK_FILE_KIND.to_owned(),
            object_name: "0001_kizuna_init.sql".to_owned(),
            content_hash: hash.to_owned(),
            pack_version: crate::VERSION.to_owned(),
        }
    }

    fn todos(sync: &str, key: &[&str], bucket: Option<&str>) -> TableConfig {
        TableConfig {
            sync: sync.to_owned(),
            bucket: bucket.map(|column| BucketSpec {
                column: column.to_owned(),
            }),
            conflict: None,
            conflict_journal: None,
            soft_delete: None,
            register_clients: None,
            min_schema_version: 1,
            tombstone_ttl_days: None,
            key_columns: key.iter().map(|column| (*column).to_owned()).collect(),
        }
    }

    fn expectation() -> Expectation {
        Expectation {
            pack_files: Some(pack()),
            tables: vec![ExpectedTable::of(
                "todos",
                &todos("read-write", &["id"], Some("user_id")),
            )],
            removed: vec!["notes".to_owned()],
        }
    }

    #[test]
    fn a_database_holding_the_pack_and_every_planned_table_has_no_gap() {
        let synced = BTreeMap::from([(
            "todos".to_owned(),
            todos("read-write", &["id"], Some("user_id")),
        )]);
        let ledger = [pack_row(&hash_pack_file("create schema kizunasync;"))];

        assert_eq!(
            provisioning_gaps(&expectation(), &ledger, &synced),
            Vec::<String>::new()
        );
    }

    /// The defect this check exists for: a push that applied nothing leaves
    /// an empty ledger and no `_config` row, and the run says so.
    #[test]
    fn an_empty_database_names_the_pack_file_and_every_planned_table() {
        assert_eq!(
            provisioning_gaps(&expectation(), &[], &BTreeMap::new()),
            [
                "the ledger does not record the pack file 0001_kizuna_init.sql",
                "kizunasync._config has no row for todos",
            ]
        );
    }

    #[test]
    fn a_table_recorded_otherwise_names_each_column_that_differs() {
        let synced = BTreeMap::from([
            ("todos".to_owned(), todos("pull-only", &["slug"], None)),
            ("notes".to_owned(), todos("pull-only", &["id"], None)),
        ]);
        let ledger = [pack_row("stale")];

        assert_eq!(
            provisioning_gaps(&expectation(), &ledger, &synced),
            [
                format!(
                    "the ledger records the pack file 0001_kizuna_init.sql with md5 stale, this build ships {}",
                    hash_pack_file("create schema kizunasync;")
                ),
                "kizunasync._config records todos keyed by slug, the run provisioned id".to_owned(),
                "kizunasync._config records todos as pull-only, the run provisioned read-write".to_owned(),
                "kizunasync._config records the bucket column of todos as none, the run provisioned user_id".to_owned(),
                "kizunasync._config still holds notes".to_owned(),
            ]
        );
    }

    /// Without a hash to hold the ledger to, only whether it records
    /// anything at all decides.
    #[test]
    fn without_a_shipped_hash_any_ledger_row_passes() {
        let expected = Expectation::default();
        let object = LedgerRow {
            object_kind: "function".to_owned(),
            object_name: "kizunasync.pull".to_owned(),
            content_hash: "any".to_owned(),
            pack_version: crate::VERSION.to_owned(),
        };

        assert_eq!(
            provisioning_gaps(&expected, &[], &BTreeMap::new()),
            ["the ledger is empty, so the pack is not installed"]
        );
        assert_eq!(
            provisioning_gaps(&expected, &[object], &BTreeMap::new()),
            Vec::<String>::new()
        );
    }

    /// An absent ledger is read as empty and `_config` is not read at all:
    /// the relation does not exist on a database the pack never reached.
    #[test]
    fn the_read_skips_config_on_a_database_without_a_ledger() {
        let applier = FakeApplier::new()
            .answer("to_regclass", vec![text_row(&[("present", "f")])])
            .fail("from kizunasync._config", "relation does not exist");

        assert_eq!(
            read_provisioning_gaps(&applier, &expectation()).unwrap(),
            [
                "the ledger does not record the pack file 0001_kizuna_init.sql",
                "kizunasync._config has no row for todos",
            ]
        );
    }

    #[test]
    fn the_report_lists_every_gap_and_names_status() {
        assert_eq!(
            describe_gaps(&["a".to_owned(), "b".to_owned()]),
            "\n  the migrations applied, but the database does not hold what they provision:\n    - a\n    - b\n  run `kizunasync status` to see what it holds."
        );
    }
}
