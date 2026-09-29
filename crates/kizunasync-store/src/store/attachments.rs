use super::LocalStore;
use crate::error::StoreError;
use crate::mapping::{ATTACHMENT_SELECT, map_attachment, sql_value};
use crate::types::{AttachmentEntry, AttachmentFailure, AttachmentState};
use kizunasync_protocol::ColumnValues;
use rusqlite::{OptionalExtension, ToSql, params};

impl LocalStore {
    /// Records how far a transfer has moved, so a resumed one restarts from the
    /// last chunk instead of from zero.
    ///
    /// `in_flight` is the claim the row keeps AFTER this write. A progress write
    /// made mid-transfer must pass `true`: releasing the claim before the
    /// transfer settles leaves a process kill in that window with a row no
    /// candidate SELECT and no recovery arm would ever return to. A terminal
    /// write ('synced', 'failed') passes `false`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    // Each parameter is an independent column of the progress row; one struct
    // parameter would only rename this same field count.
    #[expect(clippy::too_many_arguments)]
    pub fn upsert_attachment_progress(
        &self,
        reference: &str,
        progress: i64,
        chunk_offset: i64,
        tus_url: Option<&str>,
        state: AttachmentState,
        in_flight: bool,
        now: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE _kizunasync_attachments SET progress = ?1, chunk_offset = ?2, tus_url = COALESCE(?3, tus_url),
             state = ?4, in_flight = ?5, updated_at = ?6 WHERE ref = ?7",
            params![
                progress,
                chunk_offset,
                tus_url,
                state.as_str(),
                i64::from(in_flight),
                now,
                reference
            ],
        )?;
        Ok(())
    }

    /// Enqueue a durable attachment job (upload or download).
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn enqueue_attachment(&self, entry: &AttachmentEntry) -> Result<(), StoreError> {
        self.insert_attachment(
            entry,
            "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)
             ON CONFLICT(ref) DO UPDATE SET
                state = excluded.state,
                local_path = COALESCE(excluded.local_path, _kizunasync_attachments.local_path),
                sha256 = COALESCE(excluded.sha256, _kizunasync_attachments.sha256),
                content_type = COALESCE(excluded.content_type, _kizunasync_attachments.content_type),
                size = COALESCE(excluded.size, _kizunasync_attachments.size),
                updated_at = excluded.updated_at,
                error = NULL,
                error_code = NULL,
                in_flight = 0",
            params![
                i64::from(entry.in_flight),
                entry.fingerprint,
                entry.progress,
                entry.attempts,
                i64::from(entry.permanent),
                entry.chunk_offset,
                entry.tus_url,
                entry.error,
                entry.created_at,
                entry.updated_at,
                entry.error_code,
            ],
        )
    }

    /// One queue-row INSERT. `tail` is the statement's VALUES list and conflict
    /// policy: the job's identity and state bind `?1` to `?13`, and `extra` binds
    /// every placeholder `tail` numbers after them, in order.
    fn insert_attachment(
        &self,
        entry: &AttachmentEntry,
        tail: &str,
        extra: &[&dyn ToSql],
    ) -> Result<(), StoreError> {
        let sql = format!(
            "INSERT INTO _kizunasync_attachments(
                ref, upload_id, table_name, pk, column_name, bucket, owner, sha256, content_type,
                size, local_path, direction, state, in_flight, fingerprint, progress, attempts,
                permanent, chunk_offset, tus_url, error, created_at, updated_at, error_code
             ) {tail}"
        );
        let state = entry.state.as_str();
        let job: [&dyn ToSql; 13] = [
            &entry.reference,
            &entry.upload_id,
            &entry.table,
            &entry.pk,
            &entry.column,
            &entry.bucket,
            &entry.owner,
            &entry.sha256,
            &entry.content_type,
            &entry.size,
            &entry.local_path,
            &entry.direction,
            &state,
        ];
        self.conn
            .execute(&sql, rusqlite::params_from_iter(job.iter().chain(extra)))?;
        Ok(())
    }

    /// The queue row for `reference`, or `None` when it does not exist.
    ///
    /// # Errors
    ///
    /// [`StoreError::UnknownVocabulary`] when the row's `state` falls outside
    /// the closed union, or [`StoreError::Sqlite`] when the query fails.
    pub fn get_attachment(&self, reference: &str) -> Result<Option<AttachmentEntry>, StoreError> {
        let sql = format!("{ATTACHMENT_SELECT} WHERE ref = ?1");
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params![reference])?;
        rows.next()?.map(map_attachment).transpose()
    }

    /// Insert-or-replace one queue row with the embedder queue's semantics
    /// (`enqueueAttachment` in `packages/core/src/host/attachment-queue.ts`): a
    /// re-enqueue of the same ref is a FRESH job, so every piece of transfer
    /// bookkeeping resets instead of surviving, the transfer budget included: a
    /// row the budget stopped is drivable again once the app re-enqueues it.
    /// [`Self::enqueue_attachment`] keeps the opposite (COALESCE) contract for
    /// the in-Rust drive loop, which re-enqueues to RESUME rather than to
    /// restart.
    ///
    /// The TUS resume columns reset too: they are Rust-only, so an embedder
    /// re-enqueue cannot have meant to keep an offset into the previous job's
    /// bytes.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn put_attachment(&self, entry: &AttachmentEntry) -> Result<(), StoreError> {
        self.insert_attachment(
            entry,
            "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,NULL,0,0,0,0,NULL,NULL,?14,?15,NULL)
             ON CONFLICT(ref) DO UPDATE SET
                upload_id = excluded.upload_id,
                table_name = excluded.table_name,
                pk = excluded.pk,
                column_name = excluded.column_name,
                bucket = excluded.bucket,
                owner = excluded.owner,
                sha256 = excluded.sha256,
                content_type = excluded.content_type,
                size = excluded.size,
                local_path = excluded.local_path,
                direction = excluded.direction,
                state = excluded.state,
                in_flight = 0,
                fingerprint = NULL,
                progress = 0,
                attempts = 0,
                permanent = 0,
                chunk_offset = 0,
                tus_url = NULL,
                error = NULL,
                error_code = NULL,
                updated_at = excluded.updated_at",
            params![entry.created_at, entry.updated_at],
        )
    }

    /// Pending jobs ready to drive for one direction (queued or retryable, not
    /// already claimed, not stopped by the transfer budget). `ref` breaks the
    /// `created_at` tie so a fixed-clock run drains in a stable order
    /// (`pendingAttachments` in `packages/core/src/host/attachment-queue.ts`).
    ///
    /// # Errors
    ///
    /// [`StoreError::UnknownVocabulary`] when a row's `state` falls outside the
    /// closed union, or [`StoreError::Sqlite`] when the query fails.
    pub fn list_pending_attachments(
        &self,
        direction: &str,
        limit: usize,
    ) -> Result<Vec<AttachmentEntry>, StoreError> {
        let sql = format!(
            "{ATTACHMENT_SELECT}
             WHERE direction = ?1
               AND state IN ('queued', 'failed')
               AND in_flight = 0
               AND permanent = 0
             ORDER BY created_at ASC, ref ASC
             LIMIT ?2"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        // `usize::MAX` is how the in-Rust drive asks for the whole queue, so an
        // over-i64 limit saturates into "no bound" rather than failing the read.
        let mut rows = stmt.query(params![direction, i64::try_from(limit).unwrap_or(i64::MAX)])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(map_attachment(row)?);
        }
        Ok(out)
    }

    /// The rows the vacuum works on, oldest first: every orphaned row, whose
    /// Storage object, sandbox file and row the vacuum removes, and every
    /// evicted row that still names its cached bytes, which the vacuum deletes
    /// without touching Storage. Each row carries its state.
    ///
    /// # Errors
    ///
    /// [`StoreError::UnknownVocabulary`] when a row's `state` falls outside the
    /// closed union, or [`StoreError::Sqlite`] when the query fails.
    pub fn list_orphaned_attachments(&self) -> Result<Vec<AttachmentEntry>, StoreError> {
        let sql = format!(
            "{ATTACHMENT_SELECT}
             WHERE state = 'orphaned' OR (state = 'evicted' AND local_path IS NOT NULL)
             ORDER BY created_at ASC, ref ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(map_attachment(row)?);
        }
        Ok(out)
    }

    /// Every sandboxed path still referenced: the file set a reset has to delete
    /// through the embedder's file port (this store has none).
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the query fails.
    pub fn attachment_local_paths(&self) -> Result<Vec<String>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT local_path FROM _kizunasync_attachments WHERE local_path IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Delete the queue row for `reference`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the delete fails.
    pub fn purge_attachment(&self, reference: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM _kizunasync_attachments WHERE ref = ?1",
            params![reference],
        )?;
        Ok(())
    }

    /// Claim a job for exclusive drive (CAS on `in_flight`) and charge it one
    /// attempt.
    ///
    /// Answers how many attempts the row had ALREADY consumed when the claim
    /// landed, or `None` when nothing was claimed (another driver holds it, the
    /// row is gone, its state is not claimable, or the transfer budget stopped
    /// it). The budget itself lives in the engine config, so the caller compares
    /// that number against it: the store keeps no policy, only the count.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the attempts cannot be read or the claim
    /// cannot be written.
    pub fn claim_attachment(
        &self,
        reference: &str,
        next_state: AttachmentState,
        now: &str,
    ) -> Result<Option<i64>, StoreError> {
        self.claim_with(
            reference,
            "UPDATE _kizunasync_attachments
             SET state = ?1, in_flight = 1, attempts = attempts + 1, updated_at = ?2, error = NULL,
                 error_code = NULL
             WHERE ref = ?3 AND in_flight = 0 AND permanent = 0
               AND state IN ('queued', 'failed', 'uploading')",
            params![next_state.as_str(), now, reference],
        )
    }

    /// Claim for an embedder-driven transfer (`claimAttachment` in
    /// `packages/core/src/host/attachment-queue.ts`): the same `in_flight` CAS and
    /// the same attempts answer, but NO attempts bump: that queue counts an
    /// attempt itself when the transfer fails, so bumping here would charge every
    /// retry twice. Any state is claimable.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the attempts cannot be read or the claim
    /// cannot be written.
    pub fn claim_attachment_without_attempt(
        &self,
        reference: &str,
        next_state: AttachmentState,
        now: &str,
    ) -> Result<Option<i64>, StoreError> {
        self.claim_with(
            reference,
            "UPDATE _kizunasync_attachments
             SET state = ?1, in_flight = 1, updated_at = ?2
             WHERE ref = ?3 AND in_flight = 0 AND permanent = 0",
            params![next_state.as_str(), now, reference],
        )
    }

    /// The claim both claim calls make: read the attempts `reference` has
    /// consumed, then run the `cas` UPDATE over `bind`. The count answers only
    /// when that UPDATE claimed exactly one row.
    fn claim_with(
        &self,
        reference: &str,
        cas: &str,
        bind: &[&dyn ToSql],
    ) -> Result<Option<i64>, StoreError> {
        let Some(consumed) = self.attempts_consumed(reference)? else {
            return Ok(None);
        };

        let n = self.conn.execute(cas, bind)?;
        Ok((n == 1).then_some(consumed))
    }

    /// How many attempts the row has consumed so far, or `None` when no row
    /// carries `reference`.
    fn attempts_consumed(&self, reference: &str) -> Result<Option<i64>, StoreError> {
        let attempts = self
            .conn
            .query_row(
                "SELECT attempts FROM _kizunasync_attachments WHERE ref = ?1",
                params![reference],
                |r| r.get::<_, i64>(0),
            )
            .optional()?;
        Ok(attempts)
    }

    /// Stop one row for good: the transfer budget is spent, so it lands in
    /// `failed` with the claim released and `permanent` set, and no candidate
    /// query returns it again.
    ///
    /// `attempts` is written back as the count the row actually consumed, so the
    /// claim that discovered the budget is not recorded as one of them.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn fail_attachment_permanently(
        &self,
        reference: &str,
        attempts: i64,
        now: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE _kizunasync_attachments
             SET state = 'failed', permanent = 1, in_flight = 0, attempts = ?1, updated_at = ?2
             WHERE ref = ?3",
            params![attempts, now, reference],
        )?;
        Ok(())
    }

    /// Hand one row back to the queue by hand: the budget is forgiven, the
    /// attempts start over and the row is `queued` again. `false` when no row
    /// carries `reference`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn retry_attachment(&self, reference: &str, now: &str) -> Result<bool, StoreError> {
        let n = self.conn.execute(
            "UPDATE _kizunasync_attachments
             SET state = 'queued', permanent = 0, attempts = 0, in_flight = 0, error = NULL,
                 error_code = NULL, updated_at = ?1
             WHERE ref = ?2",
            params![now, reference],
        )?;
        Ok(n == 1)
    }

    /// Stop a transfer at the app's request: the row lands in `failed` with no
    /// claim, and stays retryable, because cancelling is the app saying
    /// "not now", never "never again". `false` when no row carries `reference`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn cancel_attachment(&self, reference: &str, now: &str) -> Result<bool, StoreError> {
        let n = self.conn.execute(
            "UPDATE _kizunasync_attachments
             SET state = 'failed', in_flight = 0, permanent = 0, updated_at = ?1
             WHERE ref = ?2",
            params![now, reference],
        )?;
        Ok(n == 1)
    }

    /// Delete one queue row and answer the sandbox path it held, which is the
    /// bytes the host still has to delete: this store owns no file port.
    /// `None` when no row carried `reference` or it cached no bytes.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be read or deleted.
    pub fn remove_attachment(&self, reference: &str) -> Result<Option<String>, StoreError> {
        let local_path = self
            .conn
            .query_row(
                "SELECT local_path FROM _kizunasync_attachments WHERE ref = ?1",
                params![reference],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();

        self.purge_attachment(reference)?;
        Ok(local_path)
    }

    /// Patch the mutable fields of one queue row; `updated_at` is always
    /// restamped. Every key of `patch` is a COLUMN name from the allowlist below;
    /// an unknown one is a caller bug, not a field to skip silently, and
    /// an absent one is left untouched (`updateAttachment` in
    /// `packages/core/src/host/attachment-queue.ts`).
    ///
    /// `direction` is the one column the `TypeScript` patch surface does not
    /// carry: only the in-Rust resolve turns a confirmed upload into a download
    /// job when its sandbox bytes are gone, and the JavaScript app client drives its
    /// own queue.
    ///
    /// # Errors
    ///
    /// [`StoreError::Constraint`] when `patch` names a column outside the
    /// allowlist, carries a `state` outside [`AttachmentState`], or holds a
    /// value no column can bind, or [`StoreError::Sqlite`] when the write
    /// fails.
    pub fn update_attachment(
        &self,
        reference: &str,
        patch: &ColumnValues,
        now: &str,
    ) -> Result<(), StoreError> {
        const PATCHABLE: [&str; 13] = [
            "state",
            "progress",
            "fingerprint",
            "sha256",
            "size",
            "content_type",
            "local_path",
            "error",
            "error_code",
            "attempts",
            "permanent",
            "in_flight",
            "direction",
        ];
        let mut sets = Vec::with_capacity(patch.len() + 1);
        let mut values: Vec<rusqlite::types::Value> = Vec::with_capacity(patch.len() + 2);
        for (column, value) in patch {
            if !PATCHABLE.contains(&column.as_str()) {
                return Err(StoreError::Constraint(format!(
                    "attachment patch column \"{column}\" is not patchable"
                )));
            }
            // The column is typed [`AttachmentState`] once it is read back, so an
            // unpersisted state here would make every later read of this row fail.
            if column == "state" {
                let _: AttachmentState = value
                    .as_str()
                    .ok_or_else(|| {
                        StoreError::Constraint(
                            "attachment patch \"state\" must be a string".to_string(),
                        )
                    })?
                    .parse()?;
            }
            values.push(sql_value(column, value)?);
            sets.push(format!("{column} = ?{}", values.len()));
        }
        values.push(rusqlite::types::Value::Text(now.to_string()));
        sets.push(format!("updated_at = ?{}", values.len()));
        values.push(rusqlite::types::Value::Text(reference.to_string()));
        let sql = format!(
            "UPDATE _kizunasync_attachments SET {} WHERE ref = ?{}",
            sets.join(", "),
            values.len()
        );
        self.conn
            .execute(&sql, rusqlite::params_from_iter(values))?;
        Ok(())
    }

    /// Forget the resumable session a row persisted: the host lost it or
    /// refused it, so the next attempt opens a new one from the first byte.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn drop_attachment_session(&self, reference: &str, now: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE _kizunasync_attachments SET tus_url = NULL, chunk_offset = 0, updated_at = ?1
             WHERE ref = ?2",
            params![now, reference],
        )?;
        Ok(())
    }

    /// Overwrite `state` and `in_flight` for one queue row, and record
    /// `failure` as its error message and code, or clear both when `None`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn update_attachment_state(
        &self,
        reference: &str,
        state: AttachmentState,
        in_flight: bool,
        failure: Option<AttachmentFailure<'_>>,
        now: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE _kizunasync_attachments
             SET state = ?1, in_flight = ?2, error = ?3, error_code = ?4, updated_at = ?5
             WHERE ref = ?6",
            params![
                state.as_str(),
                i64::from(in_flight),
                failure.map(|failure| failure.message),
                failure.map(|failure| failure.code),
                now,
                reference
            ],
        )?;
        Ok(())
    }

    /// Mark a queue row `orphaned` (GC-eligible) with no active claim or error.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn mark_attachment_orphaned(&self, reference: &str, now: &str) -> Result<(), StoreError> {
        self.update_attachment_state(reference, AttachmentState::Orphaned, false, None, now)
    }

    /// Mark a queue row `evicted`: this device drops its copy and the vacuum
    /// deletes the cached bytes, never the Storage object. The hash, size,
    /// media type and sandbox path stay. A row already `orphaned` keeps that
    /// state, so an object handed to the vacuum for removal from Storage is
    /// still removed.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the row cannot be written.
    pub fn mark_attachment_evicted(&self, reference: &str, now: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE _kizunasync_attachments
             SET state = 'evicted', in_flight = 0, error = NULL, error_code = NULL, updated_at = ?1
             WHERE ref = ?2 AND state != 'orphaned'",
            params![now, reference],
        )?;
        Ok(())
    }

    /// Crash recovery: every row a dead process left mid-transfer goes back to a
    /// retryable 'queued'. Two arms, both invisible to the queue otherwise:
    ///
    /// - `in_flight = 1`: a claim nobody holds any more. The candidate SELECT
    ///   skips an in-flight row and the claim refuses it, so without this a
    ///   transfer interrupted by a crash never resumes
    ///   (`recoverInFlightAttachments` in
    ///   `packages/core/src/host/attachment-queue.ts`).
    /// - a running state whose claim is already released: a row left at
    ///   `state = 'uploading' | 'downloading', in_flight = 0` when the claim
    ///   drops before the transfer settles.
    ///   [`Self::list_pending_attachments`] selects 'queued'/'failed' only, so
    ///   such a row is permanently unreachable without this arm.
    ///
    /// Both collapse to 'queued'; attempts and every other column survive.
    /// Widening past `in_flight = 1` is safe because recovery runs at engine
    /// construction or on an explicit recover call, never while a drive is
    /// holding a claim.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the rows cannot be written.
    pub fn recover_in_flight_attachments(&self, now: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE _kizunasync_attachments
             SET in_flight = 0, state = 'queued', updated_at = ?1
             WHERE in_flight = 1 OR (state IN ('uploading', 'downloading') AND in_flight = 0)",
            params![now],
        )?;
        Ok(())
    }

    /// How many LIVE (neither orphaned nor evicted) rows point at
    /// `local_path`, ignoring `excluding_reference` when given. Content
    /// addressing lets two different refs share one sandbox file, so the
    /// embedder's vacuum asks this before deleting the bytes a still-live row
    /// caches
    /// (`countLiveAttachmentsAtLocalPath` in
    /// `packages/core/src/host/attachment-queue.ts`).
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] when the count cannot be read.
    pub fn count_live_attachments_at_local_path(
        &self,
        local_path: &str,
        excluding_reference: Option<&str>,
    ) -> Result<u64, StoreError> {
        let mut sql = String::from(
            "SELECT COUNT(*) FROM _kizunasync_attachments
             WHERE local_path = ?1 AND state NOT IN ('orphaned', 'evicted')",
        );
        let mut values: Vec<rusqlite::types::Value> =
            vec![rusqlite::types::Value::Text(local_path.to_string())];
        if let Some(reference) = excluding_reference {
            sql.push_str(" AND ref != ?2");
            values.push(rusqlite::types::Value::Text(reference.to_string()));
        }

        let count: i64 = self
            .conn
            .query_row(&sql, rusqlite::params_from_iter(values), |r| r.get(0))?;
        Ok(u64::try_from(count).unwrap_or(0))
    }
}
