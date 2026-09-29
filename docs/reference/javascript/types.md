---
title: Types
description: The exported types an application annotates against.
status: alpha
docType: reference
library: javascript
pageKind: type
audience: app-developer
---

# JavaScript: Types

Every type below is exported from `@kizunasync/core` and can be imported as a type. The list covers what an application annotates: the client, the config, the values methods return, and the closed unions it branches on.

## Examples

```ts
// @kizunasync/core
import type { IKizunaSync, ISyncHealth, TKizunaSyncConfig, TOverwriteRecord, TRejectionRecord } from '@kizunasync/core'
```

## The client and its options

| Name | Type | Required | Description |
|---|---|---|---|
| `IKizunaSync` | `interface` | — | The client [Initializing](./initializing.md#returns) returns, with every member listed there. Its `connectivity` member is the network signal the automatic loop follows: the `connectivity` option, else the driver's `platformPorts.connectivity`, else `alwaysOnline`. Reading it opens nothing. |
| `IKizunaSyncOptions` | `interface` | — | The options `createKizunaSync` accepts, which is the [Supabase](https://supabase.com) composition's option set minus the members that belong to it. |
| `IInspector` | `interface` | — | The development handle on [Inspector](./inspector.md), with `IInspectorSnapshot` and `IInspectorVerdict` for its two reads. |

## Config

| Name | Type | Required | Description |
|---|---|---|---|
| `TKizunaSyncConfig` | `type` | — | The resolved value [Define config](./define-config.md#returns) returns. |
| `IKizunaSyncConfigInput` | `interface` | — | What that function accepts, generic over the generated `Database`. |
| `ITableConfig` and `IResolvedTableConfig` | `interface` | — | One table before and after the defaults are applied. |
| `TBucketSpec` and `TBucketKind` | `type` | — | What `byOwner()` and `byColumn()` return, and which of the two it is. `EBucketKind` is the runtime object of the same two values. |
| `TAttachmentSpec` | `type` | — | What `attachment()` returns. |
| `TSyncMode` | `type` | — | `'read-write' \| 'pull-only'`. |
| `TConflictMode` | `type` | — | `'arrival' \| 'hlc'`. |
| `TDatabase` | `type` | — | The structural mirror of a generated supabase-js `Database` the config is typed against. |

## Queries and writes

| Name | Type | Required | Description |
|---|---|---|---|
| `ILocalFromBuilder` | `interface` | — | What `from(table)` returns. |
| `ILocalSelectBuilder` | `interface` | — | The read chain on [Fetch data](./fetch-data.md). |
| `ILocalWriteBuilder` | `interface` | — | The filter chain on [Update data](./update-data.md) and [Delete data](./delete-data.md). |
| `ISelectResult`, `ISelectOneResult`, `ISelectMaybeOneResult` | `interface` | — | The three read envelopes, for the default await and the two terminals. |
| `IWriteResult` and `IWriteOptions` | `interface` | — | The write envelope, and the options carrying the compare-and-set mask. |
| `TUpdateValues` | `type` | — | An update's values map: assignments plus the sentinels on [Using transforms](./using-transforms.md). |
| `TIncrementSentinel`, `TArrayUnionSentinel`, `TArrayRemoveSentinel` | `type` | — | What `increment()`, `arrayUnion()`, and `arrayRemove()` each return, listed on [Using transforms](./using-transforms.md#returns). |
| `TFieldTransformSentinel` | `type` | — | The union of the three sentinel types above, the value shape `TUpdateValues` admits beside a plain column assignment. |
| `TContainsValue` | `type` | — | The argument shape the two containment filters accept. |
| `TColumnValue` and `TColumnValues` | `type` | — | One stored value, including a scalar array, and a row's column map. |
| `TLocalRow` and `TLocalMutation` | `type` | — | A committed local row, and the write request the engine applies. |
| `TOutboxEntry` | `type` | — | One queued mutation, as [Outbox depth](./outbox-depth.md) and [Inspector](./inspector.md#returns) report it. |
| `TQueryPlan`, `TQueryFilter`, `TQueryOrder`, `TQueryCompareOp` | `type` | — | The plan a select builder sends to the kernel: predicates, sort keys, a row cap, and the requested cardinality, evaluated over local SQLite when the read runs. |
| `TQueryResult` | `type` | — | What `query` answers: an array for `many`, one row for `single`, a row or `null` for `maybeSingle`. |
| `TApplyWhereRequest` | `type` | — | One filter-targeted write: the kernel resolves the rows the filters match and applies the same mutation to each in one `apply_where` call. |

## Sync state

| Name | Type | Required | Description |
|---|---|---|---|
| `TCheckpointState` | `type` | — | What [Checkpoint](./checkpoint.md#returns) returns. `INITIAL_CHECKPOINT_STATE` is the placeholder a binding shows before the first read resolves. |
| `TSoftBlockReason` | `type` | — | `'reset_required' \| 'identity_changed'`, why sync is soft-blocked. `ESoftBlockReason` is the runtime object of the same two values. |
| `ISyncHealth`, `ISyncHealthError`, `TSyncPhase` | `type` | — | What [Sync health](./sync-health.md#returns) returns, and its five phases. |
| `TBucketParams` | `type` | — | The map [Set bucket](./set-bucket.md#parameters) takes. |
| `TCursor`, `TSeq`, `TUuid`, `TIsoTimestamp` | `type` | — | The wire scalars: the opaque cursor, a sequence value, an identifier, and a timestamp. |
| `TEngineEvent` | `type` | — | The closed union [Subscribe to events](./on.md#returns) delivers. |

## Rejections, overwrites, and errors

| Name | Type | Required | Description |
|---|---|---|---|
| `TRejectionRecord` and `TRejectionKind` | `type` | — | A journal row and its four kinds, listed on [List rejections](./rejections.md#returns). `ERejectionKind` is the runtime object of the same values. |
| `TOverwriteRecord` | `type` | — | A journal row of a column a peer's write replaced, listed on [List overwrites](./overwrites.md#returns). |
| `TRejectReason` | `type` | — | The five verdict reasons, with `ERejectReason` as the runtime object. |
| `TEngineError` | `class` | — | The thrown error, carrying `code` and an optional `detail`. |
| `TEngineErrorCode` | `type` | — | Every code the engine throws, with `EEngineErrorCode` as the runtime object. |
| `TTransferErrorCode` | `type` | — | The non-terminal transfer outcomes, with `ETransferError` as the runtime object. |

## Ports

| Name | Type | Required | Description |
|---|---|---|---|
| `IStoreLocator` and `TStoreDurability` | `interface` / `type` | — | The store locator port: the database file the Rust kernel opens, or `null` for a private in-memory store, implemented by [Open the browser driver](./create-web-worker-driver.md) and [Expo: Open the SQLite driver](../expo/open-expo-driver.md). Its optional `platformPorts` carries the platform's own `connectivity` and `foreground` signals, which the app client uses when the options pass none. `TStoreDurability` is how a locator reports what an acknowledged write survives. |
| `IEngineTransport` and `TEngineTransportFactory` | `interface` / `type` | — | The engine a locator carries directly, for a driver such as the browser worker that runs its own transport instead of only naming a file. |
| `IProtocolRemote` | `interface` | — | The pull and push pair, implemented by [Create the RPC remote](./create-rpc-remote.md). |
| `IFileStore` and `IFileStoreCapabilities` | `interface` | — | The byte sandbox, implemented by [Browser file store](./create-web-file-store.md). |
| `IFileStat` | `interface` | — | What `IFileStore.stat` returns: `size` and `modifiedAt`. |
| `ITransfer`, `IUploadHandle`, `IUploadTarget` | `interface` | — | The byte mover, implemented by [Create the Storage transfer](./create-supabase-transfer.md). |
| `IWakeup` | `interface` | — | The doorbell, implemented by [Create the Realtime wakeup](./create-realtime-wakeup.md). |
| `IConnectivity` | `interface` | — | The network signal, implemented by [Browser connectivity](./create-web-connectivity.md), which the browser driver hands over as `platformPorts.connectivity`. `alwaysOnline` is the default when neither the options nor the driver supply one. |
| `IForeground` | `interface` | — | The app-became-visible signal. The Expo driver hands one over as `platformPorts.foreground` on a device, and the Supabase composition observes the document in a browser. |
| `ILogger` and `ILoggerOptions` | `interface` | — | The diagnostics sink and the `logging` option that builds it. |
| `TUniffiHandle` and `TUniffiEventObserver` | `type` | — | The React Native engine contract: what [`uniffiHandle`](./initializing.md#parameters) has to implement, and what the linked Turbo Module hands the observer. |

## Diagnostics and utilities

| Name | Type | Required | Description |
|---|---|---|---|
| `TLogLevel` | `type` | — | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'`, the level `createConsoleLogger` and the `logging.level` option on [Initializing](./initializing.md#parameters) take. |
| `createSha256`, `sha256Hex`, `ISha256` | `function` / `interface` | — | `createSha256()` returns an incremental `ISha256` hasher (`update`, `digest`); `sha256Hex` hashes a whole `ArrayBuffer` or `Uint8Array` in one call. Both return a lowercase hex digest. |
| `verdictToMessage`, `subscribeVerdictToasts`, `IVerdictMessage`, `TVerdictLevel` | `function` / `interface` / `type` | — | `verdictToMessage(event)` maps a rejection or dead-letter event to `{ level, title, message } \| null`; `subscribeVerdictToasts` wires that mapping onto [`kizunasync.on`](./on.md) directly. `TVerdictLevel` is `'error' \| 'warning'`. |
| `MISSING_CLIENT_MESSAGE` | `const` | — | The exact text every binding throws when a hook or composable resolves no client, documented on [React: useKizunaSync](../react/use-kizunasync.md#errors). |

## Attachments

| Name | Type | Required | Description |
|---|---|---|---|
| `IAttachmentClient` | `interface` | — | The eight methods on `kizunasync.attachments`, starting at [Attach a file](./from-file.md). |
| `TFromFileArgs` and `TFromFileResult` | `type` | — | That method's argument and result. |
| `TAttachmentStatus` and `TAttachmentState` | `type` | — | The snapshot, with `permanent`, `attempts`, and `errorCode`, and the seven states on [Get attachment status](./get-status.md#returns). |

## Notes

`@kizunasync/core` exports the wire message types as well, including `TPullRequest`, `TPullResponse`, `TPushRequest`, `TPushResponse`, `TPushBatch`, `TMutation`, `TOp`, `TRowChange`, `TSignal`, `TSignalType`, `TVerdict`, `TVerdictKind`, `TVerdictApplied`, `TVerdictRejected`, `TBatchAbort`, `TBatchOutcome`, `TBucket`, and `TTombstone`. `EOp`, `ESignalType`, `EVerdictKind`, and `EBatchOutcome` are the runtime objects for their closed unions. The protocol schemas generate all of them, so an application that reads them couples itself to the wire rather than to the client. [Protocol reference](../protocol.md) defines them.

`TEngineConfig` and `TTableConfig` are the engine config `createKizunaSync` derives from the value [Define config](./define-config.md) returns. `TTableConfig.bucketOwner` is `true` for a `byOwner` table, the flag that tells the engine to fill that bucket with the store owner instead of waiting for [Set bucket](./set-bucket.md).

`@kizunasync/supabase` exports its own option types beside the factories: `ISupabaseKizunaSyncOptions`, `IRpcRemoteOptions`, `IRealtimeWakeupOptions`, `IRecoverableAuth`, `IRecoverAnonymousSessionOptions`, and `TTusUploadOptions` / `TTusUploadResult` for [Upload with TUS](./tus-upload.md#parameters).

## Related reference

- [Initializing](./initializing.md)
- [Define config](./define-config.md)
- [Sync health](./sync-health.md)
- [List rejections](./rejections.md)
- [Swift: Types](../swift/types.md)
- [Kotlin: Types](../kotlin/types.md)
