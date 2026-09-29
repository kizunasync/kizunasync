/** Generated from packages/protocol/spec/engine-errors.json by scripts/gen-engine-errors.ts; do not edit. */
export const ENGINE_ERROR_CODES = {
  /** downloaded bytes do not match the recorded SHA-256, so the bytes are refused */
  ATTACHMENT_HASH_MISMATCH: 'ATTACHMENT_HASH_MISMATCH',
  /** a peer's attachment is not on Storage yet; the download is queued again */
  ATTACHMENT_NOT_YET_AVAILABLE: 'ATTACHMENT_NOT_YET_AVAILABLE',
  /** an attachment row names an owner column the table does not carry */
  ATTACHMENT_OWNER_MISSING: 'ATTACHMENT_OWNER_MISSING',
  /** a table declares attachments but the attachment ports are unset */
  ATTACHMENT_PORTS_MISSING: 'ATTACHMENT_PORTS_MISSING',
  /** the row owning a queued attachment no longer exists locally */
  ATTACHMENT_ROW_GONE: 'ATTACHMENT_ROW_GONE',
  /** an attachment transfer ran past its deadline */
  ATTACHMENT_TRANSFER_TIMEOUT: 'ATTACHMENT_TRANSFER_TIMEOUT',
  /** a downloaded attachment has no known SHA-256 to verify its bytes against, so the bytes are refused */
  ATTACHMENT_UNVERIFIED: 'ATTACHMENT_UNVERIFIED',
  /** the resumable upload session expired; the upload starts again from zero */
  ATTACHMENT_UPLOAD_EXPIRED: 'ATTACHMENT_UPLOAD_EXPIRED',
  /** a pull ran before the bucket params were set */
  BUCKET_UNSET: 'BUCKET_UNSET',
  /** The engine refused its configuration: a malformed config JSON, a remote that is not an object, or an unusable attachment root. */
  CONFIG_INVALID: 'CONFIG_INVALID',
  /** no engine can take this call on this runtime: the bridge was not created or the runtime ships no engine */
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  /** a payload failed to serialize or deserialize */
  JSON: 'JSON',
  /** A local write or a single-row read violates a constraint: a duplicate primary key, an immutable primary key in an update, a mutation id the outbox already queues, or a single()/maybeSingle() that matched the wrong number of rows. */
  LOCAL_CONSTRAINT: 'LOCAL_CONSTRAINT',
  /** A query or write construct the local subset cannot answer: an unsupported operator or operand, a relational embed or rename, a negative limit, or an unfiltered update or delete. */
  LOCAL_UNSUPPORTED: 'LOCAL_UNSUPPORTED',
  /** a push response contradicts the request it answers */
  MALFORMED_PUSH_RESPONSE: 'MALFORMED_PUSH_RESPONSE',
  /** a remote fault the server definitively rejects on replay */
  PERMANENT_TRANSPORT: 'PERMANENT_TRANSPORT',
  /** a transient remote or transport fault */
  REMOTE: 'REMOTE',
  /** delete refused on a soft-delete table */
  SOFT_DELETE_VIOLATION: 'SOFT_DELETE_VIOLATION',
  /** a local store operation failed */
  STORE: 'STORE',
  /** the local store is held by another browser context; retry */
  STORE_BUSY: 'STORE_BUSY',
  /** no persistent local store is available in this environment */
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  /** an attachment transfer failed */
  TRANSFER: 'TRANSFER',
  /** a batch abort names an offender outside the sent batch */
  UNKNOWN_BATCH_OFFENDER: 'UNKNOWN_BATCH_OFFENDER',
  /** an outbox row carries an op outside insert, update and delete */
  UNKNOWN_OP: 'UNKNOWN_OP',
  /** a pull or push signal type the engine does not recognize */
  UNKNOWN_SIGNAL: 'UNKNOWN_SIGNAL',
  /** a mutation or bucket names a table absent from config */
  UNKNOWN_TABLE: 'UNKNOWN_TABLE',
  /** a verdict carries a kind or reject reason outside the closed union */
  UNKNOWN_VERDICT_REASON: 'UNKNOWN_VERDICT_REASON',
  /** the verdict list does not match the mutations it answers */
  VERDICT_BIJECTION: 'VERDICT_BIJECTION',
} as const

export type TEngineErrorCode = (typeof ENGINE_ERROR_CODES)[keyof typeof ENGINE_ERROR_CODES]

/**
 * The catalog's documented default per code: true when a retry of the same
 * operation unchanged may succeed. An instance may still carry its own flag
 * (a remote fault does). The failure envelope reports that instance flag.
 */
export const ENGINE_ERROR_RETRYABLE: Record<TEngineErrorCode, boolean> = {
  ATTACHMENT_HASH_MISMATCH: true,
  ATTACHMENT_NOT_YET_AVAILABLE: true,
  ATTACHMENT_OWNER_MISSING: false,
  ATTACHMENT_PORTS_MISSING: false,
  ATTACHMENT_ROW_GONE: false,
  ATTACHMENT_TRANSFER_TIMEOUT: true,
  ATTACHMENT_UNVERIFIED: true,
  ATTACHMENT_UPLOAD_EXPIRED: true,
  BUCKET_UNSET: false,
  CONFIG_INVALID: false,
  ENGINE_UNAVAILABLE: false,
  JSON: false,
  LOCAL_CONSTRAINT: false,
  LOCAL_UNSUPPORTED: false,
  MALFORMED_PUSH_RESPONSE: false,
  PERMANENT_TRANSPORT: false,
  REMOTE: true,
  SOFT_DELETE_VIOLATION: false,
  STORE: false,
  STORE_BUSY: true,
  STORE_UNAVAILABLE: false,
  TRANSFER: true,
  UNKNOWN_BATCH_OFFENDER: false,
  UNKNOWN_OP: false,
  UNKNOWN_SIGNAL: false,
  UNKNOWN_TABLE: false,
  UNKNOWN_VERDICT_REASON: false,
  VERDICT_BIJECTION: false,
}
