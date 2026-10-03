use super::LocalStore;
use crate::error::StoreError;
use crate::types::{NewOverwrite, OverwriteRecord};
use rusqlite::params;

const OVERWRITE_SELECT: &str = "SELECT id, table_name, pk, column_name, loser_value,
    winner_mutation_id, conflict_mode, winner_seq, at, dismissed
    FROM _kizunasync_overwrites";

impl LocalStore {
    /// Journals one overwrite the pull just committed, so a surface can show
    /// what a peer replaced (D-conflict-journal-visibility). Not keyed by our
    /// `mutation_id`: the winner is a peer's push.
    ///
    /// # Errors
    ///
    /// [`StoreError::Json`] when `loser_value` cannot be encoded, or
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn record_overwrite(&self, overwrite: &NewOverwrite<'_>) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO _kizunasync_overwrites(
                table_name, pk, column_name, loser_value, winner_mutation_id,
                conflict_mode, winner_seq, at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                overwrite.table,
                overwrite.pk,
                overwrite.column,
                serde_json::to_string(overwrite.loser_value)?,
                overwrite.winner_mutation_id,
                overwrite.conflict_mode,
                overwrite.winner_seq,
                overwrite.at,
            ],
        )?;
        Ok(())
    }

    /// Newest first: the order a "what did a peer overwrite" surface shows.
    /// Dismissed entries are excluded unless `include_dismissed` is set, the
    /// same rule [`Self::list_rejections`] follows.
    ///
    /// # Errors
    ///
    /// [`StoreError::Json`] when a stored `loser_value` will not decode, or
    /// [`StoreError::Sqlite`] when the query fails.
    pub fn list_overwrites(
        &self,
        include_dismissed: bool,
    ) -> Result<Vec<OverwriteRecord>, StoreError> {
        let filter = if include_dismissed {
            ""
        } else {
            " WHERE dismissed = 0"
        };
        let sql = format!("{OVERWRITE_SELECT}{filter} ORDER BY at DESC, id DESC");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            <(
                i64,
                String,
                String,
                String,
                String,
                String,
                String,
                Option<String>,
                i64,
                i64,
            )>::try_from(r)
        })?;
        let mut out = Vec::new();
        for item in rows {
            let (
                id,
                table,
                pk,
                column,
                loser_value,
                winner_mutation_id,
                conflict_mode,
                winner_seq,
                at,
                dismissed,
            ) = item?;
            out.push(OverwriteRecord {
                id,
                table,
                pk,
                column,
                loser_value: serde_json::from_str(&loser_value)?,
                winner_mutation_id,
                conflict_mode,
                winner_seq,
                at,
                dismissed: dismissed != 0,
            });
        }
        Ok(out)
    }

    /// Acknowledge one journalled overwrite. Returns `false` when no row matched.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the update fails.
    pub fn dismiss_overwrite(&self, id: i64) -> Result<bool, StoreError> {
        let n = self.conn.execute(
            "UPDATE _kizunasync_overwrites SET dismissed = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(n == 1)
    }
}
