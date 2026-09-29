use super::LocalStore;
use crate::error::StoreError;
use crate::types::{LocalMutation, LocalRow, OutboxEntry, op_as_str};
use kizunasync_protocol::{ColumnValues, Op};
use rusqlite::{OptionalExtension, params};
use std::collections::BTreeSet;
use std::ops::ControlFlow;

/// One stored row, its JSON payload decoded into the column map.
fn decode_row(table: &str, pk: String, json_str: &str) -> Result<LocalRow, StoreError> {
    let columns: ColumnValues = serde_json::from_str(json_str)?;
    Ok(LocalRow {
        table: table.to_string(),
        pk,
        columns,
    })
}

impl LocalStore {
    /// The committed (non-deleted) row for `table`/`pk`, or `None`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be read, or
    /// [`StoreError::Json`] when its stored payload will not decode.
    pub fn read(&self, table: &str, pk: &str) -> Result<Option<LocalRow>, StoreError> {
        let row: Option<String> = self
            .conn
            .query_row(
                "SELECT row_json FROM _kizunasync_rows WHERE table_name = ?1 AND pk = ?2 AND deleted = 0",
                params![table, pk],
                |r| r.get(0),
            )
            .optional()?;
        row.map(|json_str| decode_row(table, pk.to_string(), &json_str))
            .transpose()
    }

    /// Ordered by pk so an unordered select is deterministic: a query without
    /// its own `order` clause inherits whatever this returns, and the frozen
    /// vectors compare whole row sequences.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when a row cannot be read, or
    /// [`StoreError::Json`] when a stored payload will not decode.
    pub fn read_all(&self, table: &str) -> Result<Vec<LocalRow>, StoreError> {
        let mut out = Vec::new();
        self.for_each_row(table, |row| {
            out.push(row);
            Ok::<_, StoreError>(ControlFlow::Continue(()))
        })?;
        Ok(out)
    }

    /// Hand the committed rows of `table` to `visit` one at a time, in the pk
    /// order [`Self::read_all`] answers, until `visit` breaks or fails. A row
    /// after the one that stopped the walk is never read or decoded.
    ///
    /// # Errors
    ///
    /// Whatever `visit` returns, or [`StoreError::Sqlite`] when a row cannot be
    /// read and [`StoreError::Json`] when a stored payload will not decode.
    pub fn for_each_row<E>(
        &self,
        table: &str,
        mut visit: impl FnMut(LocalRow) -> Result<ControlFlow<()>, E>,
    ) -> Result<(), E>
    where
        E: From<StoreError>,
    {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT pk, row_json FROM _kizunasync_rows
                 WHERE table_name = ?1 AND deleted = 0
                 ORDER BY pk",
            )
            .map_err(StoreError::from)?;
        let mut rows = stmt.query(params![table]).map_err(StoreError::from)?;
        while let Some(row) = rows.next().map_err(StoreError::from)? {
            let pk: String = row.get(0).map_err(StoreError::from)?;
            let json_str: String = row.get(1).map_err(StoreError::from)?;
            let decoded = decode_row(table, pk, &json_str)?;
            if visit(decoded)?.is_break() {
                break;
            }
        }
        Ok(())
    }

    /// The committed rows of `table` whose pk is in `pks`, each once, in the pk
    /// order [`Self::read_all`] answers. A pk the table does not hold is skipped.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when a row cannot be read, or
    /// [`StoreError::Json`] when a stored payload will not decode.
    pub fn read_rows<'a>(
        &self,
        table: &str,
        pks: impl IntoIterator<Item = &'a str>,
    ) -> Result<Vec<LocalRow>, StoreError> {
        // A `BTreeSet` orders strings by their UTF-8 bytes, which is how SQLite's
        // BINARY collation orders the text `pk` column in `read_all`.
        let pks: BTreeSet<&str> = pks.into_iter().collect();
        let mut stmt = self.conn.prepare(
            "SELECT row_json FROM _kizunasync_rows
             WHERE table_name = ?1 AND pk = ?2 AND deleted = 0",
        )?;
        let mut out = Vec::with_capacity(pks.len());
        for pk in pks {
            let json_str: Option<String> = stmt
                .query_row(params![table, pk], |r| r.get(0))
                .optional()?;
            if let Some(json_str) = json_str {
                out.push(decode_row(table, pk.to_string(), &json_str)?);
            }
        }
        Ok(out)
    }

    /// Apply a caller-issued write to `_kizunasync_rows` and journal it to the
    /// outbox, in one transaction. `meta`, a `_kizunasync_meta` key and value,
    /// is written in that same transaction, so bookkeeping that describes the
    /// write (the origin HLC it was stamped with) commits or rolls back with it.
    ///
    /// # Errors
    ///
    /// [`StoreError::Constraint`] when `mutation_id` is already queued, an
    /// insert targets an existing row, or a transform does not fit its cell,
    /// [`StoreError::Json`] when a payload will not encode, or
    /// [`StoreError::Sqlite`] when a write fails.
    pub fn apply(
        &self,
        mutation: &LocalMutation,
        mutation_id: &str,
        now: &str,
        meta: Option<(&str, &str)>,
    ) -> Result<(), StoreError> {
        self.transaction(|| {
            self.apply_inner(mutation, mutation_id, now)?;
            meta.map_or(Ok(()), |(key, value)| self.meta_set(key, value))
        })
    }

    fn apply_inner(
        &self,
        mutation: &LocalMutation,
        mutation_id: &str,
        now: &str,
    ) -> Result<(), StoreError> {
        self.refuse_queued_mutation_id(mutation_id)?;
        let pre_image = self.read(&mutation.table, &mutation.pk)?;

        match mutation.op {
            Op::Insert => self.apply_insert_row(mutation, pre_image.is_some())?,
            Op::Update => self.apply_update_row(mutation, pre_image.as_ref())?,
            Op::Delete => self.apply_delete_row(mutation, now)?,
        }

        self.conn.execute(
            "INSERT INTO _kizunasync_outbox(
                mutation_id, table_name, pk, op, columns_json, transforms_json, precondition_json,
                batch_id, pre_image_json, hlc, created_at, in_flight
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)",
            params![
                mutation_id,
                mutation.table,
                mutation.pk,
                op_as_str(mutation.op),
                serde_json::to_string(&mutation.columns)?,
                mutation
                    .transforms
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                mutation
                    .precondition
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                mutation.batch_id,
                pre_image
                    .as_ref()
                    .map(|r| serde_json::to_string(&r.columns))
                    .transpose()?,
                mutation.hlc,
                now,
            ],
        )?;
        Ok(())
    }

    /// A mutation id names one queued write: the server records one verdict
    /// per id and a push clears the outbox by id, so a second write under a
    /// queued id would be answered and cleared as the first. Checked before
    /// the row is touched; the unique index backs it for any other writer.
    fn refuse_queued_mutation_id(&self, mutation_id: &str) -> Result<(), StoreError> {
        let queued: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM _kizunasync_outbox WHERE mutation_id = ?1)",
            params![mutation_id],
            |r| r.get(0),
        )?;
        if queued {
            return Err(StoreError::Constraint(format!(
                "mutation id \"{mutation_id}\" is already queued"
            )));
        }
        Ok(())
    }

    fn apply_insert_row(
        &self,
        mutation: &LocalMutation,
        row_exists: bool,
    ) -> Result<(), StoreError> {
        if row_exists {
            return Err(StoreError::Constraint(format!(
                "insert {}/{} already exists",
                mutation.table, mutation.pk
            )));
        }
        self.conn.execute(
            "INSERT INTO _kizunasync_rows(table_name, pk, row_json, deleted, updated_seq)
             VALUES (?1, ?2, ?3, 0, '0')",
            params![
                mutation.table,
                mutation.pk,
                serde_json::to_string(&mutation.columns)?
            ],
        )?;
        Ok(())
    }

    // An update PATCHES the committed column map when a row exists, and makes
    // the masked columns the WHOLE row when none does (never created, or
    // tombstoned by a peer) rather than failing: the write is already queued
    // for the server, so refusing it locally would strand the outbox entry.
    // Neither shape clears the tombstone shadow: only an authoritative server
    // row does (`put_server_row`).
    fn apply_update_row(
        &self,
        mutation: &LocalMutation,
        pre_image: Option<&LocalRow>,
    ) -> Result<(), StoreError> {
        let mut merged = match pre_image {
            Some(existing) => existing.columns.clone(),
            None => ColumnValues::new(),
        };
        for (k, v) in &mutation.columns {
            merged.insert(k.clone(), v.clone());
        }
        self.upsert_transformed_row(&mutation.table, &mutation.pk, &merged, &mutation.transforms)
    }

    fn apply_delete_row(&self, mutation: &LocalMutation, now: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM _kizunasync_rows WHERE table_name = ?1 AND pk = ?2",
            params![mutation.table, mutation.pk],
        )?;
        self.conn.execute(
            "INSERT INTO _kizunasync_tombstones(table_name, pk, seq, deleted_at)
             VALUES (?1, ?2, '0', ?3)
             ON CONFLICT(table_name, pk) DO UPDATE SET deleted_at = excluded.deleted_at",
            params![mutation.table, mutation.pk, now],
        )?;
        Ok(())
    }

    /// Replay every queued mutation, oldest first, onto the rows `reset` names
    /// (D-outbox-rebase). `reset` is every `(table, pk)` whose local row the
    /// caller just replaced: a pulled row or tombstone, an installed server row,
    /// a compensating revert. A row the caller did not replace already holds
    /// each queued write, so replaying onto it would apply a transform twice.
    ///
    /// Runs inside the caller's transaction, after the caller has written
    /// every replacement (a reverse walk included), so the replay is part of
    /// the same commit. Enqueues nothing.
    ///
    /// # Errors
    ///
    /// [`StoreError::Constraint`] when a transform does not fit its cell,
    /// [`StoreError::Json`] when a row will not encode or a queued payload will
    /// not decode, [`StoreError::UnknownVocabulary`] for a queued `op` outside
    /// the closed union, or [`StoreError::Sqlite`] when a read or a write fails.
    pub fn overlay_pending(
        &self,
        reset: &BTreeSet<(String, String)>,
        now: &str,
    ) -> Result<(), StoreError> {
        let depth = self.outbox_depth()?;
        if depth == 0 {
            return Ok(());
        }

        for entry in self.list_outbox(depth)? {
            self.overlay_entry(&entry, reset, now)?;
        }
        Ok(())
    }

    /// One mutation of [`Self::overlay_pending`]'s replay, for a caller that
    /// holds a write outside the queued outbox (a verdict the server applied
    /// without returning its row). A delete always replays as a tombstone; an
    /// insert or update replays only onto a row `reset` names and never over a
    /// tombstone, so a pending write cannot resurrect a deleted row.
    ///
    /// # Errors
    ///
    /// The faults [`Self::overlay_pending`] reports for one write.
    pub fn overlay_entry(
        &self,
        entry: &OutboxEntry,
        reset: &BTreeSet<(String, String)>,
        now: &str,
    ) -> Result<(), StoreError> {
        match entry.op {
            Op::Delete => self.apply_tombstone(&entry.table, &entry.pk, "0", now),
            Op::Insert | Op::Update => {
                if self.has_tombstone(&entry.table, &entry.pk)?
                    || !reset.contains(&(entry.table.clone(), entry.pk.clone()))
                {
                    return Ok(());
                }
                self.overlay_local(entry)
            }
        }
    }

    /// Overlay a pending local mutation onto the committed snapshot without
    /// enqueueing a new outbox row (D-outbox-rebase rebase). Mirrors `upsertRowLocal`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Constraint`] when a transform does not fit its cell,
    /// [`StoreError::Json`] when the merged row will not encode, or
    /// [`StoreError::Sqlite`] when the write fails.
    pub fn overlay_local(&self, entry: &OutboxEntry) -> Result<(), StoreError> {
        let existing = self.read(&entry.table, &entry.pk)?;
        let next = if entry.op == Op::Update {
            let mut merged = match existing {
                Some(row) => row.columns,
                None => ColumnValues::new(),
            };
            for (k, v) in &entry.columns {
                merged.insert(k.clone(), v.clone());
            }
            merged
        } else {
            entry.columns.clone()
        };
        self.upsert_transformed_row(&entry.table, &entry.pk, &next, &entry.transforms)
    }

    /// Write `columns`, with `transforms` applied, as the live row of `table`/`pk`:
    /// a new row, or the stored map replaced and any delete mark cleared.
    #[expect(
        clippy::ref_option,
        reason = "forwarded unchanged to `apply_transforms`, which takes the stored `&Option`; an `Option<&Map>` here would clone the map back into one"
    )]
    fn upsert_transformed_row(
        &self,
        table: &str,
        pk: &str,
        columns: &ColumnValues,
        transforms: &Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<(), StoreError> {
        let row = crate::transforms::apply_transforms(columns, transforms)
            .map_err(|err| StoreError::Constraint(err.to_string()))?;
        self.conn.execute(
            "INSERT INTO _kizunasync_rows(table_name, pk, row_json, deleted, updated_seq)
             VALUES (?1, ?2, ?3, 0, '0')
             ON CONFLICT(table_name, pk) DO UPDATE SET
               row_json = excluded.row_json,
               deleted = 0",
            params![table, pk, serde_json::to_string(&row)?],
        )?;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::LocalStore;
    use crate::error::StoreError;
    use serde_json::{Map, json};
    use std::ops::ControlFlow;

    /// Uppercase, digit-suffixed and multi-byte keys, written out of order, so
    /// the byte order of the keys is what every read has to reproduce.
    const PKS: [&str; 7] = ["b", "é", "a10", "B", "a", "a2", "z"];

    fn seeded() -> LocalStore {
        let store = LocalStore::open_in_memory().unwrap();
        for pk in PKS {
            let mut columns = Map::new();
            columns.insert("title".into(), json!(pk));
            store.put_server_row("todos", pk, &columns, "1").unwrap();
        }
        let mut other = Map::new();
        other.insert("title".into(), json!("other table"));
        store.put_server_row("notes", "a", &other, "1").unwrap();
        store
    }

    fn pks_of(rows: &[crate::LocalRow]) -> Vec<&str> {
        rows.iter().map(|row| row.pk.as_str()).collect()
    }

    #[test]
    fn read_rows_answers_each_named_row_once_in_pk_order() {
        let store = seeded();

        let rows = store
            .read_rows("todos", ["z", "a", "missing", "é", "B", "a"])
            .unwrap();
        assert_eq!(pks_of(&rows), ["B", "a", "z", "é"]);
        assert!(rows.iter().all(|row| row.table == "todos"));
        assert_eq!(rows[1].columns["title"], json!("a"));
        assert!(store.read_rows("todos", []).unwrap().is_empty());
    }

    #[test]
    fn read_rows_and_for_each_row_keep_the_order_read_all_answers() {
        let store = seeded();
        let all = store.read_all("todos").unwrap();
        assert_eq!(pks_of(&all), ["B", "a", "a10", "a2", "b", "z", "é"]);

        assert_eq!(
            pks_of(&store.read_rows("todos", PKS).unwrap()),
            pks_of(&all)
        );

        let mut visited = Vec::new();
        store
            .for_each_row("todos", |row| {
                visited.push(row.pk);
                Ok::<_, StoreError>(ControlFlow::Continue(()))
            })
            .unwrap();
        assert_eq!(visited, pks_of(&all));
    }

    #[test]
    fn for_each_row_stops_when_the_visitor_breaks() {
        let store = seeded();
        let mut visited = Vec::new();
        store
            .for_each_row("todos", |row| {
                visited.push(row.pk);
                Ok::<_, StoreError>(if visited.len() == 2 {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                })
            })
            .unwrap();
        assert_eq!(visited, ["B", "a"]);
    }

    #[test]
    fn for_each_row_hands_back_the_visitor_error_and_stops() {
        let store = seeded();
        let mut visited = 0;
        let error = store
            .for_each_row("todos", |_| {
                visited += 1;
                Err(StoreError::Constraint("stop here".into()))
            })
            .unwrap_err();
        assert!(matches!(error, StoreError::Constraint(message) if message == "stop here"));
        assert_eq!(visited, 1);
    }
}
