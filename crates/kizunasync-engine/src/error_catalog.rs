//! The engine error catalog: the single source of the engine error codes.
//!
//! Every code [`crate::EngineError::code`] can return is declared here as a
//! `const` and listed in [`CATALOG`], and every call site that names a code uses
//! those same constants, so the three cannot drift apart. `cargo run -p
//! kizunasync-bindgen -- engine-errors` projects the list into
//! `packages/protocol/spec/engine-errors.json`, which the TypeScript generator
//! turns into `ENGINE_ERROR_CODES`. Add a code here first, then regenerate both
//! sides; `tests/error_catalog.rs` fails on drift.

// MARK: - Codes

/// A downloaded attachment's bytes do not match its recorded SHA-256.
pub const ATTACHMENT_HASH_MISMATCH: &str = "ATTACHMENT_HASH_MISMATCH";
/// A peer's attachment is not on Storage yet.
pub const ATTACHMENT_NOT_YET_AVAILABLE: &str = "ATTACHMENT_NOT_YET_AVAILABLE";
/// An attachment row names an owner column the table does not carry.
pub const ATTACHMENT_OWNER_MISSING: &str = "ATTACHMENT_OWNER_MISSING";
/// A table declares attachments but the attachment ports are unset.
pub const ATTACHMENT_PORTS_MISSING: &str = "ATTACHMENT_PORTS_MISSING";
/// The row owning a queued attachment no longer exists locally.
pub const ATTACHMENT_ROW_GONE: &str = "ATTACHMENT_ROW_GONE";
/// An attachment transfer ran past its deadline.
pub const ATTACHMENT_TRANSFER_TIMEOUT: &str = "ATTACHMENT_TRANSFER_TIMEOUT";
/// A downloaded attachment has no known SHA-256 to verify its bytes against.
pub const ATTACHMENT_UNVERIFIED: &str = "ATTACHMENT_UNVERIFIED";
/// The resumable upload session expired on the host.
pub const ATTACHMENT_UPLOAD_EXPIRED: &str = "ATTACHMENT_UPLOAD_EXPIRED";
/// A pull ran before the bucket params were set.
pub const BUCKET_UNSET: &str = "BUCKET_UNSET";
/// The engine refused the configuration it was created with.
pub const CONFIG_INVALID: &str = "CONFIG_INVALID";
/// No engine can take this call on this runtime.
pub const ENGINE_UNAVAILABLE: &str = "ENGINE_UNAVAILABLE";
/// A payload failed to serialize or deserialize.
pub const JSON: &str = "JSON";
/// A local write or a single-row read violates a constraint.
pub const LOCAL_CONSTRAINT: &str = "LOCAL_CONSTRAINT";
/// A query or write construct the local subset cannot answer.
pub const LOCAL_UNSUPPORTED: &str = "LOCAL_UNSUPPORTED";
/// A push response contradicts the request it answers.
pub const MALFORMED_PUSH_RESPONSE: &str = "MALFORMED_PUSH_RESPONSE";
/// A remote fault the server definitively rejects on replay.
pub const PERMANENT_TRANSPORT: &str = "PERMANENT_TRANSPORT";
/// A transient remote or transport fault.
pub const REMOTE: &str = "REMOTE";
/// A hard delete refused on a soft-delete table.
pub const SOFT_DELETE_VIOLATION: &str = "SOFT_DELETE_VIOLATION";
/// A local store operation failed.
pub const STORE: &str = "STORE";
/// The local store is held by another browser context.
pub const STORE_BUSY: &str = "STORE_BUSY";
/// No persistent local store can be installed in this environment.
pub const STORE_UNAVAILABLE: &str = "STORE_UNAVAILABLE";
/// An attachment transfer failed.
pub const TRANSFER: &str = "TRANSFER";
/// A batch abort names an offender outside the sent batch.
pub const UNKNOWN_BATCH_OFFENDER: &str = "UNKNOWN_BATCH_OFFENDER";
/// An outbox row carries an op outside the closed union.
pub const UNKNOWN_OP: &str = "UNKNOWN_OP";
/// A pull or push signal type the engine does not recognize.
pub const UNKNOWN_SIGNAL: &str = "UNKNOWN_SIGNAL";
/// A mutation or bucket names a table absent from config.
pub const UNKNOWN_TABLE: &str = "UNKNOWN_TABLE";
/// A verdict carries a kind or reject reason outside the closed union.
pub const UNKNOWN_VERDICT_REASON: &str = "UNKNOWN_VERDICT_REASON";
/// The verdict list does not match the mutations it answers.
pub const VERDICT_BIJECTION: &str = "VERDICT_BIJECTION";

/// The wire-contract codes [`crate::EngineError::protocol`] is constructed with.
/// Every bridge must report the same code for the same violation, so the shared
/// conflict vectors assert on them.
pub const PROTOCOL_CODES: &[&str] = &[
    MALFORMED_PUSH_RESPONSE,
    UNKNOWN_BATCH_OFFENDER,
    UNKNOWN_OP,
    UNKNOWN_SIGNAL,
    UNKNOWN_VERDICT_REASON,
    VERDICT_BIJECTION,
];

// MARK: - Catalog

/// One engine error code with its retry classification and a one-clause meaning.
#[non_exhaustive]
pub struct CatalogEntry {
    /// The machine-readable code, one of the `const` items above.
    pub code: &'static str,
    /// Documented default: a retry of the same operation unchanged may succeed; an
    /// instance may carry its own flag (`REMOTE`).
    pub retryable: bool,
    /// One clause naming the condition, projected into the generated spec and the
    /// TypeScript doc comment.
    pub description: &'static str,
}

/// Sorted by `code`, matching the generated JSON exactly.
pub static CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        code: ATTACHMENT_HASH_MISMATCH,
        retryable: true,
        description: "downloaded bytes do not match the recorded SHA-256, so the bytes are refused",
    },
    CatalogEntry {
        code: ATTACHMENT_NOT_YET_AVAILABLE,
        retryable: true,
        description: "a peer's attachment is not on Storage yet; the download is queued again",
    },
    CatalogEntry {
        code: ATTACHMENT_OWNER_MISSING,
        retryable: false,
        description: "an attachment row names an owner column the table does not carry",
    },
    CatalogEntry {
        code: ATTACHMENT_PORTS_MISSING,
        retryable: false,
        description: "a table declares attachments but the attachment ports are unset",
    },
    CatalogEntry {
        code: ATTACHMENT_ROW_GONE,
        retryable: false,
        description: "the row owning a queued attachment no longer exists locally",
    },
    CatalogEntry {
        code: ATTACHMENT_TRANSFER_TIMEOUT,
        retryable: true,
        description: "an attachment transfer ran past its deadline",
    },
    CatalogEntry {
        code: ATTACHMENT_UNVERIFIED,
        retryable: true,
        description: "a downloaded attachment has no known SHA-256 to verify its bytes against, so the bytes are refused",
    },
    CatalogEntry {
        code: ATTACHMENT_UPLOAD_EXPIRED,
        retryable: true,
        description: "the resumable upload session expired; the upload starts again from zero",
    },
    CatalogEntry {
        code: BUCKET_UNSET,
        retryable: false,
        description: "a pull ran before the bucket params were set",
    },
    CatalogEntry {
        code: CONFIG_INVALID,
        retryable: false,
        description: "The engine refused its configuration: a malformed config JSON, a remote that is not an object, or an unusable attachment root.",
    },
    CatalogEntry {
        code: ENGINE_UNAVAILABLE,
        retryable: false,
        description: "no engine can take this call on this runtime: the bridge was not created or the runtime ships no engine",
    },
    CatalogEntry {
        code: JSON,
        retryable: false,
        description: "a payload failed to serialize or deserialize",
    },
    CatalogEntry {
        code: LOCAL_CONSTRAINT,
        retryable: false,
        description: "A local write or a single-row read violates a constraint: a duplicate primary key, an immutable primary key in an update, a mutation id the outbox already queues, or a single()/maybeSingle() that matched the wrong number of rows.",
    },
    CatalogEntry {
        code: LOCAL_UNSUPPORTED,
        retryable: false,
        description: "A query or write construct the local subset cannot answer: an unsupported operator or operand, a relational embed or rename, a negative limit, or an unfiltered update or delete.",
    },
    CatalogEntry {
        code: MALFORMED_PUSH_RESPONSE,
        retryable: false,
        description: "a push response contradicts the request it answers",
    },
    CatalogEntry {
        code: PERMANENT_TRANSPORT,
        retryable: false,
        description: "a remote fault the server definitively rejects on replay",
    },
    CatalogEntry {
        code: REMOTE,
        retryable: true,
        description: "a transient remote or transport fault",
    },
    CatalogEntry {
        code: SOFT_DELETE_VIOLATION,
        retryable: false,
        description: "delete refused on a soft-delete table",
    },
    CatalogEntry {
        code: STORE,
        retryable: false,
        description: "a local store operation failed",
    },
    CatalogEntry {
        code: STORE_BUSY,
        retryable: true,
        description: "the local store is held by another browser context; retry",
    },
    CatalogEntry {
        code: STORE_UNAVAILABLE,
        retryable: false,
        description: "no persistent local store is available in this environment",
    },
    CatalogEntry {
        code: TRANSFER,
        retryable: true,
        description: "an attachment transfer failed",
    },
    CatalogEntry {
        code: UNKNOWN_BATCH_OFFENDER,
        retryable: false,
        description: "a batch abort names an offender outside the sent batch",
    },
    CatalogEntry {
        code: UNKNOWN_OP,
        retryable: false,
        description: "an outbox row carries an op outside insert, update and delete",
    },
    CatalogEntry {
        code: UNKNOWN_SIGNAL,
        retryable: false,
        description: "a pull or push signal type the engine does not recognize",
    },
    CatalogEntry {
        code: UNKNOWN_TABLE,
        retryable: false,
        description: "a mutation or bucket names a table absent from config",
    },
    CatalogEntry {
        code: UNKNOWN_VERDICT_REASON,
        retryable: false,
        description: "a verdict carries a kind or reject reason outside the closed union",
    },
    CatalogEntry {
        code: VERDICT_BIJECTION,
        retryable: false,
        description: "the verdict list does not match the mutations it answers",
    },
];

/// `true` when `code` is a catalog member.
#[must_use]
pub fn contains(code: &str) -> bool {
    CATALOG.iter().any(|entry| entry.code == code)
}

/// The retry flag [`CATALOG`] declares for `code`, and `false` for a code the
/// catalog does not carry, so an unknown code never promises a retry.
///
/// This is the app-facing answer: the same flag `kizunasync-bindgen` projects into
/// `packages/protocol/spec/engine-errors.json` and the generated
/// `ENGINE_ERROR_RETRYABLE` table, so the JSON envelope and the TypeScript
/// surface answer the question with one value.
#[must_use]
pub fn catalog_retryable(code: &str) -> bool {
    CATALOG
        .iter()
        .find(|entry| entry.code == code)
        .is_some_and(|entry| entry.retryable)
}
