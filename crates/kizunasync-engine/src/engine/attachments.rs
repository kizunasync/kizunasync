//! Bucket-parameter setters, server-authoritative seeding, and the session
//! facts the attachment queue reads.

use super::{BUCKET_SCOPE_KEY, OWNER_SUBJECT_KEY, SyncEngine};
use crate::config::{EngineEvent, TableConfig};
use crate::error::EngineError;
use kizunasync_protocol::ColumnValues;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::PoisonError;

/// Per table, the last non-empty value `set_bucket` gave each bucket key.
type BucketScope = BTreeMap<String, ColumnValues>;

/// One bucket value a call names: its table, its key, and the value.
type NamedValue<'a> = (&'a str, &'a str, &'a Value);

/// Whether `key` routes `table`'s pull: its bucket column, or a key its params
/// already carry.
fn routes_on(table: &TableConfig, key: &str) -> bool {
    table.bucket_column == key || table.bucket_params.contains_key(key)
}

impl SyncEngine {
    /// Set every bucket parameter the caller supplied a value for, leaving the
    /// others untouched: the engine-side half of `setBucket` in
    /// `packages/core/src/query/kizunasync.ts` (byColumn at runtime, byOwner at sign-in).
    /// A key reaches every table bucketed on it, and every table whose params
    /// already carry it.
    ///
    /// Every key is checked against the configured bucket columns before any of
    /// them is written, so a misspelled key refuses the whole call instead of
    /// half-filling the routing and pulling a scope nobody asked for.
    ///
    /// The store keeps, per table, the last non-empty value each key was set
    /// to. A non-empty value that differs from the kept one replaces the local
    /// scope, across restarts too: the next pull re-bootstraps every table from
    /// `"0"` and its boundary drops the rows the new scope does not carry, while
    /// queued writes stay. Filling a key the store keeps no value for, setting
    /// `""`, or setting the kept value again replaces nothing. The values a
    /// table config names count as one such call at open
    /// ([`SyncEngine::new`]), and so does the owner a `bucket_owner` table
    /// is filled with, at open and when a token first records the owner
    /// ([`SyncEngine::set_remote_access_token`]). The engine restores no other
    /// parameter at open: the host sets them at sign-in on every launch. Once
    /// the store records an owner, that owner overwrites any value this call
    /// set earlier on a `bucket_owner` table.
    ///
    /// A local call: it answers while a network call awaits the remote. A pull
    /// awaiting the remote when a value replaces the scope commits nothing of
    /// its answer ([`SyncEngine::pull_once`]).
    ///
    /// # Errors
    /// [`EngineError::BucketColumnUnknown`] naming the key and the configured
    /// bucket columns, and [`EngineError::Store`] or [`EngineError::Json`] when
    /// the kept scope cannot be read or written; either way no parameter
    /// changes and no re-bootstrap is armed.
    pub fn set_bucket_params(&self, params: &ColumnValues) -> Result<(), EngineError> {
        for key in params.keys() {
            if !self
                .config
                .tables
                .values()
                .any(|table| table.bucket_column == *key)
            {
                return Err(EngineError::BucketColumnUnknown {
                    key: key.clone(),
                    configured: self.configured_bucket_columns(),
                });
            }
        }

        let named: Vec<NamedValue<'_>> = self
            .config
            .tables
            .iter()
            .flat_map(|(name, table)| {
                params
                    .iter()
                    .filter(|(key, _)| routes_on(table, key))
                    .map(|(key, value)| (name.as_str(), key.as_str(), value))
            })
            .collect();
        self.route(&named)
    }

    /// Keep `named` as the store's scope, then route the next pull on it.
    /// A store that cannot keep the scope changes no parameter.
    fn route(&self, named: &[NamedValue<'_>]) -> Result<(), EngineError> {
        self.with_buckets(|routing| {
            if self.keep_scope(named)? {
                routing.generation += 1;
            }
            for &(table, key, value) in named {
                routing
                    .params
                    .entry(table.to_string())
                    .or_default()
                    .insert(key.to_string(), value.clone());
            }
            Ok(())
        })
    }

    /// Set the bucket value of every `bucket_owner` table to `owner`, the
    /// same way a [`Self::set_bucket_params`] call naming those tables would.
    ///
    /// # Errors
    /// [`EngineError::Store`] or [`EngineError::Json`] when the kept scope
    /// cannot be read or written; no parameter changes then.
    pub(super) fn fill_owner_buckets(&self, owner: &str) -> Result<(), EngineError> {
        let columns: Vec<(&str, &str)> = self.owner_bucket_columns().collect();
        self.route_owner(&columns, owner)
    }

    /// Fill the owner buckets still unset with the owner the store keeps, the
    /// way [`Self::fill_owner_buckets`] does, before a pull builds its
    /// buckets. This retries a fill the store could not keep at open and fills
    /// a bucket set back to `""`; a value set on another owner bucket stays.
    /// With no owner recorded, nothing changes and the pull refuses with
    /// `BUCKET_UNSET`.
    ///
    /// # Errors
    /// [`EngineError::Store`] or [`EngineError::Json`] when the owner cannot
    /// be read or the kept scope cannot be read or written; no parameter
    /// changes then.
    pub(super) fn fill_unset_owner_buckets(&self) -> Result<(), EngineError> {
        let unset: Vec<(&str, &str)> = self.with_buckets(|routing| {
            self.owner_bucket_columns()
                .filter(|&(table, column)| {
                    routing
                        .params
                        .get(table)
                        .and_then(|params| params.get(column))
                        .is_none_or(|value| value.as_str() == Some(""))
                })
                .collect()
        });
        if unset.is_empty() {
            return Ok(());
        }

        match self.owner_subject()? {
            Some(owner) => self.route_owner(&unset, &owner),
            None => Ok(()),
        }
    }

    /// Route `owner` as the value of each `(table, column)` in `columns`.
    fn route_owner(&self, columns: &[(&str, &str)], owner: &str) -> Result<(), EngineError> {
        if columns.is_empty() {
            return Ok(());
        }

        let owner = Value::String(owner.to_string());
        let named: Vec<NamedValue<'_>> = columns
            .iter()
            .map(|&(table, column)| (table, column, &owner))
            .collect();
        self.route(&named)
    }

    /// Fill the owner buckets at open with the owner the store already has.
    ///
    /// When the store cannot read the owner or keep the scope, those values
    /// stay unset until the next pull fills them
    /// ([`Self::fill_unset_owner_buckets`]).
    pub(super) fn fill_kept_owner_buckets(&self) {
        if let Ok(Some(owner)) = self.owner_subject() {
            let _ = self.fill_owner_buckets(&owner);
        }
    }

    /// Return every `bucket_owner` table's bucket value to unset, the state a
    /// reset store starts in until a token records its next owner.
    pub(super) fn unset_owner_buckets(&self) {
        self.with_buckets(|routing| {
            for (table, column) in self.owner_bucket_columns() {
                routing
                    .params
                    .entry(table.to_string())
                    .or_default()
                    .insert(column.to_string(), Value::String(String::new()));
            }
        });
    }

    /// Each `bucket_owner` table with the bucket column its owner goes in.
    fn owner_bucket_columns(&self) -> impl Iterator<Item = (&str, &str)> {
        self.config
            .tables
            .iter()
            .filter_map(|(name, table)| Some((name.as_str(), table.owner_bucket_column()?)))
    }

    /// Keep the non-empty bucket values the table configs name, as one
    /// [`Self::set_bucket_params`] call at open would.
    ///
    /// A store that cannot keep them leaves those values unset, so the pull
    /// refuses with `BUCKET_UNSET` instead of pulling a scope the store never
    /// recorded over rows of the one it did.
    pub(super) fn keep_configured_scope(&self) {
        let named: Vec<NamedValue<'_>> = self
            .config
            .tables
            .iter()
            .flat_map(|(name, table)| {
                table
                    .bucket_params
                    .iter()
                    .map(|(key, value)| (name.as_str(), key.as_str(), value))
            })
            .collect();
        if self.keep_scope(&named).is_ok() {
            return;
        }

        self.with_buckets(|routing| {
            for &(table, key, _) in &named {
                if let Some(values) = routing.params.get_mut(table) {
                    values.insert(key.to_string(), Value::String(String::new()));
                }
            }
        });
    }

    /// Keep every non-empty value `named` carries as the store's scope, and
    /// answer whether one of them replaced a different non-empty value the
    /// store kept: that replacement arms the re-bootstrap in the same store
    /// transaction.
    fn keep_scope(&self, named: &[NamedValue<'_>]) -> Result<bool, EngineError> {
        let kept = self.kept_bucket_scope()?;
        let mut scope = kept.clone();
        let mut replaces_the_scope = false;
        for &(table, key, value) in named {
            if value.as_str() == Some("") {
                continue;
            }
            let values = scope.entry(table.to_string()).or_default();
            replaces_the_scope |= values.get(key).is_some_and(|previous| previous != value);
            values.insert(key.to_string(), value.clone());
        }
        if scope == kept {
            return Ok(false);
        }

        let scope = serde_json::to_string(&scope)?;
        // The kept scope and the re-bootstrap it arms are one state change.
        self.store.transaction(|| {
            if replaces_the_scope {
                self.arm_rehydration()?;
            }
            self.meta_set(BUCKET_SCOPE_KEY, &scope)
        })?;
        Ok(replaces_the_scope)
    }

    /// The scope the store keeps, empty before the first non-empty value.
    fn kept_bucket_scope(&self) -> Result<BucketScope, EngineError> {
        let kept = self.meta_get(BUCKET_SCOPE_KEY)?;
        if kept.is_empty() {
            return Ok(BucketScope::new());
        }

        Ok(serde_json::from_str(&kept)?)
    }

    /// The bucket columns the config declares, quoted and deduplicated, or
    /// `none` for a config whose tables are all unbucketed.
    fn configured_bucket_columns(&self) -> String {
        let columns: BTreeSet<&str> = self
            .config
            .tables
            .values()
            .map(|table| table.bucket_column.as_str())
            .filter(|column| !column.is_empty())
            .collect();
        if columns.is_empty() {
            return "none".to_string();
        }

        columns
            .into_iter()
            .map(|column| format!("\"{column}\""))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// Seed a server-authoritative row without touching the outbox (corpus `server` steps).
    ///
    /// # Errors
    ///
    /// [`EngineError::Store`] when the row cannot be written.
    pub fn seed_row(
        &self,
        table: &str,
        pk: &str,
        columns: &ColumnValues,
        seq: &str,
    ) -> Result<(), EngineError> {
        self.store.put_server_row(table, pk, columns, seq)?;
        self.emit(&EngineEvent::LocalChanged);
        Ok(())
    }

    /// Seed a server-authoritative tombstone, the delete half of [`Self::seed_row`].
    ///
    /// # Errors
    ///
    /// [`EngineError::Store`] when the tombstone cannot be written.
    pub fn seed_tombstone(&self, table: &str, pk: &str, seq: &str) -> Result<(), EngineError> {
        let now = (self.deps.now)();
        self.store.apply_tombstone(table, pk, seq, &now)?;
        self.emit(&EngineEvent::LocalChanged);
        Ok(())
    }

    /// The `sub` claim of the user this store belongs to, or `None` before a
    /// token named one. Only this user's objects are ever removed from
    /// Storage.
    ///
    /// # Errors
    ///
    /// [`EngineError::Store`] when the owner cannot be read.
    pub(crate) fn owner_subject(&self) -> Result<Option<String>, EngineError> {
        let subject = self.meta_get(OWNER_SUBJECT_KEY)?;
        Ok((!subject.is_empty()).then_some(subject))
    }

    /// Whether the host has set a token that names a user: the attachment
    /// drive and vacuum reach Storage only under one.
    pub(crate) fn has_session(&self) -> bool {
        self.token_subject
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    /// Set the pull cursor without pulling, so a client can resume from a
    /// checkpoint the host already holds.
    ///
    /// Waits for the network call in flight, so a pull's commit cannot
    /// overwrite the cursor this sets.
    ///
    /// # Errors
    ///
    /// [`EngineError::Store`] when the cursor cannot be written.
    pub async fn seed_checkpoint(&self, cursor: &str) -> Result<(), EngineError> {
        let _turn = self.network.lock().await;
        self.store.set_cursor(cursor)?;
        Ok(())
    }
}
