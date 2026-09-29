/**
 * The sync domain. Hexagonal layout:
 *   ports/   : contracts (StoreLocator, EngineTransport, ProtocolRemote,
 *              FileStore, Transfer, Wakeup). Drivers and adapters implement these.
 *   wire/    : generated wire message types plus the engine-facing config, row,
 *              event and error contracts every consumer imports.
 *   host/    : runs beside the engine, not inside it: the sync scheduler, the
 *              sync-health tracker, the attachment byte queue.
 *   query/   : the createKizunaSync app client over the Rust core.
 *   testing/ : the temp-database locator (import from '@kizunasync/core/testing').
 *              The protocol conformance harness lives in conformance/
 *              ('@kizunasync/core/conformance'), a repository-only subpath.
 */

// MARK: - @kizunasync/core public surface

export { type IStoreLocator, type TStoreDurability } from './ports/store-locator'
export { type IEngineLeadership, type IEngineTransport, type TEngineTransportFactory } from './ports/engine-transport'
export { INTERNAL_TABLES, SCHEMA, SIGNED_URL_TTL_SECONDS, TRACKERS } from './constants'
export { alwaysOnline, type IConnectivity } from './ports/connectivity'
export { contentKey, type IFileStat, type IFileStore, type IFileStoreCapabilities } from './ports/file-store'
export { ETransferError, type ITransfer, type IUploadHandle, type IUploadTarget, type TTransferErrorCode } from './ports/transfer'
export { createRequestSignal, createTransferTimeoutError, DEFAULT_TRANSFER_BYTES_TIMEOUT_MS, DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS, withDeadline, type ICreateRequestSignalOptions, type ICreateTransferTimeoutErrorOptions, type IDeadlineOptions, type IRequestSignal } from './util/deadline'
export { createSignedUrlDownload, type ICreateSignedUrlDownloadOptions } from './util/signed-url-download'
export { mimeForExt } from './util/mime'
export { type IWakeup } from './ports/wakeup'
export { type IForeground } from './ports/foreground'
export { type IProtocolRemote } from './ports/protocol-remote'
export { ESyncPhase, type ISyncHealth, type ISyncHealthError, type TSyncPhase } from './host/sync-health'
export { MISSING_CLIENT_MESSAGE } from './host/messages'
export { createSha256, sha256Hex, type ISha256 } from './util/sha256'
export { EVerdictLevel, subscribeVerdictToasts, verdictToMessage, type IVerdictMessage, type TVerdictLevel } from './util/verdict-message'
export { createAttachmentSession, type IAttachmentSession, type IAttachmentSessionOptions } from './util/attachment-session'
export { toAttachmentBudgetFields, toAttachmentDisplayFields, type IAttachmentBudgetFields, type IAttachmentDisplayFields } from './util/attachment-status'
export { createJournalSession, isOverwriteEvent, isRejectionEvent, type IJournalSession, type IJournalSessionOptions } from './util/journal'
export { createSyncStatusSession, initialSyncStatusState, type ISyncStatusSession, type ISyncStatusSessionOptions, type ISyncStatusState } from './util/sync-status'
export { reReadsRows } from './util/re-reads-rows'
export { createConsoleLogger, createLogger, noopLogger, type ILogger, type ILoggerOptions, type TLogLevel } from './util/logger'
export { type IAttachmentClient, type TAttachmentStatus, type TFromFileArgs, type TFromFileResult } from './host/attachment-queue'

// MARK: - Local-first client

export { createKizunaSync, type IKizunaSync, type IKizunaSyncOptions } from './query/kizunasync'
/**
 * The one reader of the engine's `{ ok: false, error }` failure envelope and the
 * guarded parse every engine JSON text goes through, for a host that receives
 * them as text (the `@kizunasync/web` worker driver).
 */
export { isJsonObject, parseFailureEnvelope, readEngineJson } from './query/engine-envelope'
export { createInspector, EInspectorVerdictKind, type IInspector, type IInspectorSnapshot, type IInspectorVerdict, type TInspectorVerdictKind } from './query/inspector'
export { type ILocalFromBuilder, type ILocalSelectBuilder, type ILocalWriteBuilder, type ISelectMaybeOneResult, type ISelectOneResult, type ISelectResult, type IWriteOptions, type IWriteResult } from './query/builder'
export { type TContainsValue } from './query/filter-clauses'
/**
 * The React Native engine contract: what `deps.uniffiHandle` has to implement
 * and what the Turbo Module hands the observer.
 */
export { EUniffiEngineEventTag, type TUniffiEngineEvent, type TUniffiEngineEventTag, type TUniffiEventObserver, type TUniffiHandle } from './query/rust-uniffi-engine'
export { arrayRemove, arrayUnion, increment, isArrayRemove, isArrayUnion, isIncrement, type TArrayRemoveSentinel, type TArrayUnionSentinel, type TFieldTransformSentinel, type TIncrementSentinel, type TUpdateValues } from './query/transforms'
export { attachment, byColumn, byOwner, defineConfig, EBucketKind, type IKizunaSyncConfigInput, type IResolvedTableConfig, type ITableConfig, type TAttachmentSpec, type TBucketKind, type TBucketSpec, type TDatabase, type TKizunaSyncConfig } from './config/config'
export { EAttachmentState, EBatchOutcome, EConflictMode, EEngineErrorCode, EEngineEventType, EOp, ERejectionKind, ERejectReason, ERpcKind, ESignalType, ESoftBlockReason, ESyncMode, EVerdictKind, EWireEntryKind, INITIAL_CHECKPOINT_STATE, TEngineError, type TApplyWhereRequest, type TAttachmentState, type TBatchAbort, type TBatchOutcome, type TBucket, type TBucketParams, type TCheckpointState, type TColumnValue, type TColumnValues, type TConflictMode, type TCursor, type TEngineConfig, type TEngineErrorCode, type TEngineEvent, type TEngineEventType, type TIsoTimestamp, type TLocalMutation, type TLocalRow, type TMutation, type TOp, type TOutboxEntry, type TOverwriteRecord, type TPullRequest, type TPullResponse, type TPushBatch, type TPushRequest, type TPushResponse, type TQueryCompareOp, type TQueryFilter, type TQueryOrder, type TQueryPlan, type TQueryResult, type TRejectionKind, type TRejectionRecord, type TRejectReason, type TRowChange, type TRpcKind, type TSeq, type TSignal, type TSignalType, type TSoftBlockReason, type TSyncMode, type TTableConfig, type TTombstone, type TUuid, type TVerdict, type TVerdictApplied, type TVerdictKind, type TVerdictRejected, type TWireEntryKind } from './wire/types'
