//! The engine's error type and its retry/protocol classification.

use crate::error_catalog as catalog;
use kizunasync_query::QueryError;
use kizunasync_store::StoreError;
use kizunasync_transfer::TransferError;
use thiserror::Error;

/// Every way an engine call fails, with one catalog code per condition.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum EngineError {
    /// The local store refused the operation.
    #[error("store: {0}")]
    Store(#[from] StoreError),
    /// A local read or a filter-targeted write the local subset refuses, or a row
    /// count that contradicts the cardinality the caller asked for.
    #[error("query: {0}")]
    Query(#[from] kizunasync_query::QueryError),
    /// A remote/transport fault. `retryable: false` marks a request the server
    /// DEFINITIVELY rejects (a Postgres data/constraint/syntax fault), the only
    /// thing `sync()`'s dead-letter budget is allowed to drop. Everything else
    /// (network loss, 5xx, an expired JWT, a schema-config error) stays retryable
    /// so a queued write is never dropped over a recoverable condition. `code` is
    /// the adapter's transport code (a PostgREST/SQLSTATE code, `AUTH_SESSION_MISSING`,
    /// `AUTH_SESSION_TIMEOUT`, …), distinct from [`EngineError::code`], which is
    /// the engine-level classification the dead-letter reason vocabulary uses;
    /// this transport code is what the app shows and switches on instead.
    #[error("remote: {message}")]
    Remote {
        /// What the adapter reported.
        message: String,
        /// `false` only when the server definitively rejects the request.
        retryable: bool,
        /// The adapter's own transport code, if it sent one.
        code: Option<String>,
    },
    /// A response that violates the wire contract (a broken verdict bijection, a
    /// literal outside a closed union, an abort naming a non-member offender).
    /// `code` is the oracle's own code, so a malformed reply is named the same
    /// way wherever it is reported. Never counted against the dead-letter budget:
    /// a malformed response is a contract fault, not a transport fault.
    #[error("{code}: {message}")]
    Protocol {
        /// The shared oracle code for this violation.
        code: String,
        /// What the response got wrong.
        message: String,
    },
    /// An attachment transfer failed.
    #[error("transfer: {0}")]
    Transfer(#[from] TransferError),
    /// A pull ran before the bucket params were set.
    #[error("bucket unset")]
    BucketUnset,
    /// `set_bucket` named a key no table declares as its bucket column. Routing
    /// on a column the config does not carry would pull a scope the app never
    /// configured, so the whole call is refused.
    #[error("set_bucket: \"{key}\" is not a configured bucket column (configured: {configured})")]
    BucketColumnUnknown {
        /// The key the caller passed.
        key: String,
        /// The configured bucket columns, quoted, or `none`.
        configured: String,
    },
    /// A mutation, bucket or query names a table absent from the config.
    #[error("unknown table: {0}")]
    UnknownTable(String),
    /// A local write violates a constraint the engine enforces before the store:
    /// a duplicate primary key, or a write that would change one.
    #[error("local constraint: {0}")]
    LocalConstraint(String),
    /// The engine refused its own configuration before it could serve anything:
    /// a config JSON that does not parse, a `remote` that is not an object, or an
    /// attachment root the host cannot use. A caller cannot fix it by retrying.
    #[error("config: {0}")]
    Config(String),
    /// A hard delete on a table that declares a soft-delete column. Refused
    /// before anything is written, so the outbox is untouched.
    #[error("delete refused on soft-delete table {table}: write the soft-delete column instead")]
    SoftDeleteViolation {
        /// The table that declares a soft-delete column.
        table: String,
    },
    /// A payload failed to serialize or deserialize.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// A table declares `attachments` but the thin client was created without
    /// `attachment_root` (parity `ATTACHMENT_PORTS_MISSING` / `createKizunaSync`).
    #[error("ATTACHMENT_PORTS_MISSING: a table declares attachments but attachment_root is unset")]
    AttachmentPortsMissing,
    /// The row owning a queued attachment no longer exists locally.
    #[error("ATTACHMENT_ROW_GONE: {0}")]
    AttachmentRowGone(String),
    /// An attachment row names an owner column the table does not carry.
    #[error("ATTACHMENT_OWNER_MISSING: {0}")]
    AttachmentOwnerMissing(String),
    /// A downloaded attachment has no known SHA-256, neither the server's nor
    /// one this device kept, so its bytes are refused instead of trusted.
    #[error("ATTACHMENT_UNVERIFIED: {0}")]
    AttachmentUnverified(String),
    /// A downloaded attachment's bytes do not match the SHA-256 recorded for
    /// the object, so they are refused and never cached.
    #[error("ATTACHMENT_HASH_MISMATCH: {0}")]
    AttachmentHashMismatch(String),
    /// A peer's attachment is not on Storage yet, so its download waits.
    #[error("ATTACHMENT_NOT_YET_AVAILABLE: {0}")]
    AttachmentNotYetAvailable(String),
    /// The resumable upload session expired on the host, so the upload
    /// starts again from zero.
    #[error("ATTACHMENT_UPLOAD_EXPIRED: {0}")]
    AttachmentUploadExpired(String),
    /// An attachment transfer ran past its deadline.
    #[error("ATTACHMENT_TRANSFER_TIMEOUT: {0}")]
    AttachmentTransferTimeout(String),
    /// No engine can take the call: the bridge was never created, this runtime
    /// ships no engine, or a call is already in flight. Retrying the same call
    /// against the same handle cannot change any of the three.
    #[error("ENGINE_UNAVAILABLE: {message}")]
    EngineUnavailable {
        /// Which of the three conditions took the call.
        message: String,
    },
}

impl EngineError {
    /// A transient remote fault: keep the write queued and retry.
    pub fn remote(message: impl Into<String>) -> Self {
        Self::Remote {
            message: message.into(),
            retryable: true,
            code: None,
        }
    }

    /// A remote fault the server will never accept on replay.
    pub fn permanent_remote(message: impl Into<String>) -> Self {
        Self::Remote {
            message: message.into(),
            retryable: false,
            code: None,
        }
    }

    /// Attach the adapter's transport code to a [`Self::Remote`] fault; any other
    /// variant is returned unchanged.
    #[must_use]
    pub fn with_code(self, code: Option<String>) -> Self {
        match self {
            Self::Remote {
                message, retryable, ..
            } => Self::Remote {
                message,
                retryable,
                code,
            },
            other => other,
        }
    }

    /// A wire-contract violation, tagged with the shared oracle error code.
    pub fn protocol(code: &str, message: impl Into<String>) -> Self {
        Self::Protocol {
            code: code.to_string(),
            message: message.into(),
        }
    }

    /// `true` when the push loop must not count this fault against the
    /// dead-letter budget: transient remote faults, and protocol or local faults
    /// that fail loud instead.
    ///
    /// `false` for a remote fault explicitly classified as permanent, a
    /// soft-delete refusal, a refused configuration, an unavailable engine, a
    /// store this environment cannot install, and the transfer faults a replay
    /// leaves unchanged (no filesystem port, missing local bytes, a payload over
    /// the adapter's limit, a session URL off the upload origin).
    ///
    /// This is the engine's own classification, not the flag the JSON envelope
    /// and the generated TypeScript table carry; that one is
    /// [`crate::error_catalog::catalog_retryable`].
    #[must_use]
    pub const fn is_budget_exempt(&self) -> bool {
        match self {
            Self::Remote { retryable, .. } => *retryable,
            Self::EngineUnavailable { .. }
            | Self::Config(_)
            | Self::SoftDeleteViolation { .. }
            | Self::Store(StoreError::VfsUnavailable { .. })
            | Self::Transfer(
                TransferError::FilesystemUnavailable
                | TransferError::LocalBytesMissing { .. }
                | TransferError::TooLarge { .. }
                | TransferError::OriginMismatch,
            ) => false,
            Self::Store(_)
            | Self::Query(_)
            | Self::Protocol { .. }
            | Self::Transfer(_)
            | Self::BucketUnset
            | Self::BucketColumnUnknown { .. }
            | Self::UnknownTable(_)
            | Self::LocalConstraint(_)
            | Self::Json(_)
            | Self::AttachmentPortsMissing
            | Self::AttachmentRowGone(_)
            | Self::AttachmentOwnerMissing(_)
            | Self::AttachmentUnverified(_)
            | Self::AttachmentHashMismatch(_)
            | Self::AttachmentNotYetAvailable(_)
            | Self::AttachmentUploadExpired(_)
            | Self::AttachmentTransferTimeout(_) => true,
        }
    }

    /// Machine-readable code, one of [`crate::error_catalog::CATALOG`]. Protocol
    /// faults keep the oracle code the corpus already asserts. Add a code to the
    /// catalog and regenerate both sides; never to a client file.
    ///
    /// Every arm except `Protocol` returns a `const` the catalog itself is built
    /// from. `Protocol` returns the code its constructor was given, which every
    /// call site takes from the same constants; `PROTOCOL_CODES` is that list.
    #[must_use]
    pub fn code(&self) -> String {
        match self {
            Self::Protocol { code, .. } => code.clone(),
            Self::UnknownTable(_) => catalog::UNKNOWN_TABLE.into(),
            Self::BucketUnset | Self::BucketColumnUnknown { .. } => catalog::BUCKET_UNSET.into(),
            Self::LocalConstraint(_) | Self::Store(StoreError::Constraint(_)) => {
                catalog::LOCAL_CONSTRAINT.into()
            }
            // A queued write whose stored `op` is outside the closed union would
            // ship as a DIFFERENT write than the app made, so it keeps its own
            // code; every other corrupt column is an ordinary store fault.
            Self::Store(StoreError::UnknownVocabulary { column: "op", .. }) => {
                catalog::UNKNOWN_OP.into()
            }
            Self::Store(StoreError::VfsBusy { .. }) => catalog::STORE_BUSY.into(),
            Self::Store(StoreError::VfsUnavailable { .. }) => catalog::STORE_UNAVAILABLE.into(),
            Self::SoftDeleteViolation { .. } => catalog::SOFT_DELETE_VIOLATION.into(),
            Self::Config(_) => catalog::CONFIG_INVALID.into(),
            Self::Query(
                QueryError::SingleCardinality(_) | QueryError::MaybeSingleCardinality(_),
            ) => catalog::LOCAL_CONSTRAINT.into(),
            Self::Query(_) => catalog::LOCAL_UNSUPPORTED.into(),
            Self::AttachmentPortsMissing => catalog::ATTACHMENT_PORTS_MISSING.into(),
            Self::AttachmentRowGone(_) => catalog::ATTACHMENT_ROW_GONE.into(),
            Self::AttachmentOwnerMissing(_) => catalog::ATTACHMENT_OWNER_MISSING.into(),
            Self::AttachmentUnverified(_) => catalog::ATTACHMENT_UNVERIFIED.into(),
            Self::AttachmentHashMismatch(_) => catalog::ATTACHMENT_HASH_MISMATCH.into(),
            Self::AttachmentNotYetAvailable(_) => catalog::ATTACHMENT_NOT_YET_AVAILABLE.into(),
            Self::AttachmentUploadExpired(_) => catalog::ATTACHMENT_UPLOAD_EXPIRED.into(),
            Self::AttachmentTransferTimeout(_) => catalog::ATTACHMENT_TRANSFER_TIMEOUT.into(),
            Self::EngineUnavailable { .. } => catalog::ENGINE_UNAVAILABLE.into(),
            Self::Remote {
                retryable: false, ..
            } => catalog::PERMANENT_TRANSPORT.into(),
            Self::Remote { .. } => catalog::REMOTE.into(),
            Self::Transfer(_) => catalog::TRANSFER.into(),
            Self::Json(_) => catalog::JSON.into(),
            Self::Store(_) => catalog::STORE.into(),
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
pub(crate) mod tests {
    use super::EngineError;
    use crate::error_catalog::{self, PROTOCOL_CODES};

    /// Exhaustive by construction: a new `EngineError` variant fails to compile
    /// here until [`every_variant`] is extended to build one.
    fn assert_every_variant_listed(error: &EngineError) {
        match error {
            EngineError::Store(_)
            | EngineError::Query(_)
            | EngineError::Remote { .. }
            | EngineError::Protocol { .. }
            | EngineError::Transfer(_)
            | EngineError::BucketUnset
            | EngineError::BucketColumnUnknown { .. }
            | EngineError::UnknownTable(_)
            | EngineError::LocalConstraint(_)
            | EngineError::Config(_)
            | EngineError::SoftDeleteViolation { .. }
            | EngineError::Json(_)
            | EngineError::AttachmentPortsMissing
            | EngineError::AttachmentRowGone(_)
            | EngineError::AttachmentOwnerMissing(_)
            | EngineError::AttachmentUnverified(_)
            | EngineError::AttachmentHashMismatch(_)
            | EngineError::AttachmentNotYetAvailable(_)
            | EngineError::AttachmentUploadExpired(_)
            | EngineError::AttachmentTransferTimeout(_)
            | EngineError::EngineUnavailable { .. } => {}
        }
    }

    fn json_error() -> serde_json::Error {
        serde_json::from_str::<serde_json::Value>("!").unwrap_err()
    }

    /// One error per variant, plus one `Protocol` per catalog protocol code, so a
    /// test that has to cover the whole failure surface builds it from here.
    pub(crate) fn every_variant() -> Vec<EngineError> {
        let mut variants = vec![
            EngineError::Store(kizunasync_store::StoreError::Json(json_error())),
            EngineError::Store(kizunasync_store::StoreError::Constraint("dup pk".into())),
            EngineError::Store(kizunasync_store::StoreError::VfsBusy {
                name: "todos.db".into(),
            }),
            EngineError::Store(kizunasync_store::StoreError::VfsUnavailable {
                sahpool: "no sync access handles".into(),
                relaxed_idb: "no IndexedDB".into(),
            }),
            EngineError::Query(kizunasync_query::QueryError::InvalidFilter("op".into())),
            EngineError::remote("offline"),
            EngineError::permanent_remote("22P02"),
            EngineError::Transfer(kizunasync_transfer::TransferError::NotYetAvailable),
            EngineError::BucketUnset,
            EngineError::BucketColumnUnknown {
                key: "team_id".into(),
                configured: "\"owner_id\"".into(),
            },
            EngineError::UnknownTable("items".into()),
            EngineError::LocalConstraint("dup pk".into()),
            EngineError::Query(kizunasync_query::QueryError::SingleCardinality(0)),
            EngineError::Config("remote must be an object".into()),
            EngineError::SoftDeleteViolation {
                table: "items".into(),
            },
            EngineError::Json(json_error()),
            EngineError::AttachmentPortsMissing,
            EngineError::AttachmentRowGone("items/p-1".into()),
            EngineError::AttachmentOwnerMissing("items.owner".into()),
            EngineError::AttachmentUnverified("items/p-1/photo".into()),
            EngineError::AttachmentHashMismatch("items/p-1/photo".into()),
            EngineError::AttachmentNotYetAvailable("items/p-1/photo".into()),
            EngineError::AttachmentUploadExpired("items/p-1/photo".into()),
            EngineError::AttachmentTransferTimeout("items/p-1/photo".into()),
            EngineError::EngineUnavailable {
                message: "create() was not called".into(),
            },
        ];
        variants.extend(
            PROTOCOL_CODES
                .iter()
                .map(|code| EngineError::protocol(code, "dummy")),
        );
        variants
    }

    #[test]
    fn every_code_is_a_catalog_member() {
        for error in every_variant() {
            assert_every_variant_listed(&error);
            let code = error.code();
            assert!(
                error_catalog::contains(&code),
                "{code} is missing from error_catalog::CATALOG"
            );
        }
    }

    /// The store codes are the ones a host reads to decide whether to open again,
    /// so the catalog's answer and the engine's must be the same one. `VfsBusy` is
    /// released by whoever holds it; no persistent VFS never appears.
    #[test]
    fn the_store_codes_answer_retryable_the_same_way_as_the_catalog() {
        let busy = EngineError::Store(kizunasync_store::StoreError::VfsBusy {
            name: "todos.db".into(),
        });
        let unavailable = EngineError::Store(kizunasync_store::StoreError::VfsUnavailable {
            sahpool: "no sync access handles".into(),
            relaxed_idb: "no IndexedDB".into(),
        });

        for error in [busy, unavailable] {
            assert_eq!(
                error.is_budget_exempt(),
                error_catalog::catalog_retryable(&error.code()),
                "{}",
                error.code()
            );
        }
    }

    /// The one direction that can lose a write: a code the catalog promises is
    /// worth retrying must never be classified as unretryable here, because the
    /// push loop counts an unretryable failure against the dead-letter budget.
    ///
    /// The opposite direction is deliberately NOT asserted. The two flags answer
    /// different questions: the catalog documents whether repeating the operation
    /// unchanged may succeed, while this predicate says whether the push loop may
    /// ever drop the write, and a protocol or local fault answers `true` here so
    /// it fails loud instead of being dropped.
    #[test]
    fn no_variant_refuses_a_retry_the_catalog_promises() {
        for error in every_variant() {
            if matches!(error, EngineError::Remote { .. }) {
                continue;
            }
            let code = error.code();
            assert!(
                error.is_budget_exempt() || !error_catalog::catalog_retryable(&code),
                "{code} is retryable in the catalog but not here"
            );
        }
    }

    #[test]
    fn the_variant_codes_and_the_catalog_codes_are_the_same_set() {
        let mut codes: Vec<String> = every_variant().iter().map(EngineError::code).collect();
        codes.sort_unstable();
        codes.dedup();
        let catalog: Vec<&str> = error_catalog::CATALOG
            .iter()
            .map(|entry| entry.code)
            .collect();
        assert_eq!(
            codes, catalog,
            "a catalog code has no EngineError producing it"
        );
    }
}
