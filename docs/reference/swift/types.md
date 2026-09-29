---
title: Types
description: Every public Swift type the KizunaSync module exports.
status: alpha
docType: reference
library: swift
pageKind: type
audience: app-developer
---

# Swift: Types

Importing `KizunaSync` brings in the client, the configuration structs, the query and write builders, the scheduler, the inspector, and the records the engine answers with. The records are typealiases over the generated [UniFFI](https://mozilla.github.io/uniffi-rs/) types, so their fields carry the names the generator produced.

```swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync
```

## Client and configuration

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncClient` | `final class` | — | The client itself. Every method except `from(_:)` is `async throws` and hops off the calling thread. `from(_:)` is synchronous and throws `UNKNOWN_TABLE` eagerly, and `dispose()` is `async` but never throws. See [Initializing](./initializing.md). |
| `KizunaSyncClientConfig` | `struct` | — | Whole client configuration: `clientId`, `schemaVersion`, `tables`, `databasePath`, `remote`, `attachmentRoot`, `defaultLimit`, `attachmentAttempts`. `declaresAttachments` reports whether any table declares an attachment column, and `jsonObject()` and `jsonString()` produce the payload handed to the engine. |
| `KizunaSyncTableConfig` | `struct` | — | One synced table: `bucket` (default `.none`), `attachments`, `softDeleteColumn`, `conflictMode`, and `syncMode`. |
| `KizunaSyncBucket` | `enum` | — | Which rows of a table the device pulls: `.none`, `.byOwner(String)` for a column that holds the owning user's id, which the engine fills from the session token, or `.byColumn(String)` for a column whose value the app sets with [Set bucket](./set-bucket.md). Default: `.none`. See [Initializing](./initializing.md#parameters). |
| `KizunaSyncAttachmentSpec` | `struct` | — | One attachment column: `storageBucket` and `ownerColumn`. |
| `KizunaSyncRemoteConfig` | `struct` | — | The [PostgREST](https://postgrest.org/) remote: `url`, `publishableKey`, `accessToken`, `schema`, and `localOnlyColumns`. |
| `KizunaSyncConflictMode` | `enum String` | — | `.arrival` trusts server order; `.hlc` compares the origin clock stamp `apply` attaches. Default: `.arrival`. See [Initializing](./initializing.md#parameters). |
| `KizunaSyncSyncMode` | `enum String` | — | `.readWrite` pulls the table and pushes its local writes; `.pullOnly` pulls it and has the engine refuse every local write with `LOCAL_UNSUPPORTED`. The raw values are the wire names `"read-write"` and `"pull-only"`. Default: `.readWrite`. See [Initializing](./initializing.md#parameters). |

## Writes and queries

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncTable` | `final class` | — | The fluent surface of one table, returned by `KizunaSyncClient.from(_:)`: `insert(_:)`, `update(_:transforms:precondition:)`, `delete(precondition:)`, and `select(_:)`. See [Insert data](./insert-data.md), [Update data](./update-data.md), and [Delete data](./delete-data.md). |
| `KizunaSyncSelectBuilder` | `final class` | — | Fluent read over one table, returned by `KizunaSyncTable.select(_:)`. Chains every filter in [Using filters](./using-filters.md#supported-filters) plus `order(_:ascending:nullsFirst:)`, `limit(_:)`, and `includeDeleted()`, then `execute()`, `single()`, or `maybeSingle()`. |
| `KizunaSyncWriteBuilder` | `final class` | — | Fluent filter-targeted write, returned by `KizunaSyncTable.update(_:transforms:precondition:)` and `KizunaSyncTable.delete(precondition:)`. Chains the same filters as `KizunaSyncSelectBuilder` except `search` and `textSearch`, which stay read-only, then `execute() -> [String]`. See [Write with filters](./apply-where.md). |
| `KizunaSyncOp` | `enum String` | — | `.insert`, `.update`, `.delete`. The raw values are the wire names. |
| `KizunaSyncTextSearchType` | `enum String` | — | `.plain`, `.phrase`, `.websearch`, the parse modes `textSearch` accepts. Default `.plain`. See [Using filters](./using-filters.md#supported-filters). |
| `KizunaSyncQuery` | `enum` | — | Static plan builders: `eq(_:_:)`, `neq(_:_:)`, `gt(_:_:)`, `gte(_:_:)`, `lt(_:_:)`, `lte(_:_:)`, `like(_:_:)`, `ilike(_:_:)`, `is(_:_:)`, `in(_:_:)`, `contains(_:_:)`, `containedBy(_:_:)`, `and(_:)`, `or(_:)`, `not(_:)`, `search(_:columns:)`, `textSearch(_:_:type:)`, `order(_:ascending:nullsFirst:)`, `plan(filters:order:limit:projection:cardinality:includeDeleted:)`, `many(filters:)`, `single(filters:)`, and `maybeSingle(filters:)`. They serialize the plan; they do not evaluate it. `is(_:_:)` takes `Bool?`, nil is the null test, and every other helper's operand is `Any`, with `NSNull()` as the explicit null value where one is accepted. See [Using filters](./using-filters.md). |

Kotlin's `eq`, `neq`, `isValue`, and `inValues` take `Any?` and accept `null` directly; its ordered and containment helpers (`gt`, `gte`, `lt`, `lte`, `contains`, `containedBy`) take a non-null `Any`, the same requirement Swift has for every operand but `is`.

## Records the engine answers with

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncCheckpoint` | `struct` | — | `cursor`, `softBlocked`, and `softBlockReason`. See [Checkpoint](./checkpoint.md#returns). |
| `KizunaSyncRejection` | `struct` | — | `mutationId`, `table`, `pk`, `kind`, `reason`, `changedColumns`, `serverRowJson`, `at`, `dismissed`. See [List rejections](./rejections.md#returns). |
| `KizunaSyncOverwrite` | `struct` | — | `id`, `table`, `pk`, `column`, `loserValueJson`, `winnerMutationId`, `conflictMode`, `winnerSeq`, `at`, `dismissed`. See [List overwrites](./overwrites.md#returns). |
| `KizunaSyncAttachmentStatus` | `struct` | — | `state`, `progress`, `error`, `localPath`, `permanent`, `errorCode`. `state` is `queued`, `uploading`, `downloading`, `synced`, `failed`, `orphaned`, `evicted` (this device dropped its copy and the object stays in Storage), or `missing`. `errorCode` (`String?`) is the catalog code of the last recorded failure, and nil while the row records none. See [Get attachment status](./get-status.md#returns). |
| `KizunaSyncFromFileResult` | `struct` | — | `reference`, `sha256`, `size`, `mediaType`, `localPath`. See [Attach a file](./from-file.md#returns). |
| `KizunaSyncEngineEvent` | `enum` | — | `.localChanged`, `.queueDepth`, `.mutationRejected`, `.batchAborted`, `.deadLetter`, `.columnOverwritten`, `.checkpointExpired`, `.resetRequired`. See [Subscribe to events](./on.md#parameters). |

## Inspector

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncInspector` | `final class` | — | Devtools over one client, built and memoized by `KizunaSyncClient.inspector()`: `snapshot()`, `verdicts()`, `subscribe(_:)`, and `clear()`. See [Inspect the client](./inspect.md) and [Inspector](./inspector.md). |
| `KizunaSyncInspectorSnapshot` | `struct` | — | `queued`, `depth`, `lastMutationId`, `cursor`, `clientId`. The same five fields `KizunaSyncClient.inspect()` answers raw. |
| `KizunaSyncInspectorVerdict` | `struct` | — | `mutationId`, `kind`, `reason`, `at`. One entry of the 50-entry ring. |
| `KizunaSyncInspectorVerdictKind` | `enum String` | — | `.rejected` for a `MUTATION_REJECTED` event, `.aborted` for a `BATCH_ABORTED` event, `.overwritten` for a `COLUMN_OVERWRITTEN` event. |

## Scheduling and errors

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncScheduler` | `final class` | — | The host loop over one client: it takes the client, `refreshSession`, and an optional `sync` closure, and syncs at start, after every local write, on its timer, on the network path, and on the foreground signal. See [Host scheduler](./scheduler.md). |
| `KizunaSyncWakeReason` | `enum String` | — | `.poll`, `.foreground`, `.path`, `.doorbell`, `.localWrite`, `.start`. It names the trigger of a run. |
| `KizunaSyncSyncPhase` | `enum String` | — | `.idle`, `.syncing`, `.backoff`, `.stalled`, `.offline`. What the loop is doing right now. |
| `KizunaSyncSyncHealth` | `struct` | — | `phase`, `consecutiveFailures`, `nextAttemptAt`, `attemptStartedAt`, `lastSuccessAt`, `lastError`, `needsReset`. An observable snapshot of the loop. `nextAttemptAt`, `attemptStartedAt`, and `lastSuccessAt` are `Date?`; `needsReset` is `Bool`, `false` on a scheduler built with no `needsReset` closure. |
| `KizunaSyncSyncHealthError` | `struct` | — | `code` (`String?`), `message`, `at` (`Date`). The failure the last attempt reported; `code` is the catalog code when the failure was a `KizunaSyncError`, and nil for anything else the `sync` closure threw. |
| `KizunaSyncPathMonitor` | `protocol` | — | The network-path source the scheduler gates on: `start(onSatisfied:)` and `cancel()`. See [Path monitoring](./scheduler.md#path-monitoring). |
| `KizunaSyncNetworkPathMonitor` | `final class` | — | The default `KizunaSyncPathMonitor`, backed by `NWPathMonitor`. `KizunaSyncScheduler` builds one when the caller passes no `pathMonitor`. |
| `KizunaSyncForegroundSource` | `protocol` | — | The return-to-foreground source the scheduler wakes on: `start(onForeground:)` and `stop()`. See [Foreground wake](./scheduler.md#foreground-wake). |
| `KizunaSyncNotificationForegroundSource` | `final class` | — | The default `KizunaSyncForegroundSource`, backed by the platform's did-become-active notification. `KizunaSyncScheduler` builds one when `observeForeground` is `true` and the caller passes no `foregroundSource`. |
| `KizunaSyncRealtimeSubscription` | `protocol` | — | One subscription the scheduler holds and releases: `cancel()`, idempotent. |
| `KizunaSyncRealtimeWakeup` | `protocol` | — | The realtime doorbell the app implements: `subscribe(topics:onWake:)`. See [Realtime wake](./scheduler.md#realtime-wake). |
| `KizunaSyncError` | `enum` | — | The client's own error, with the single case `.engine(code: String, message: String)`. `code` is the stable catalog code an app switches on; `description` reads `"CODE: message"`. |

## Notes

[`KizunaSyncClient`](./initializing.md) never lets the generated `KizunaSyncFfiError` escape: every call runs on a dedicated dispatch queue, catches it there, and rethrows `KizunaSyncError.engine`, whose `code` is the value each page's Errors table lists. It raises the same type for the checks it makes itself, such as `ATTACHMENT_PORTS_MISSING` in [Initializing](./initializing.md#errors) and `LOCAL_UNSUPPORTED` for an empty `table` or `pk` on `apply`. Match on `code`, not on `description`, to switch on it.

## Related reference

- [Initializing](./initializing.md)
- [Using filters](./using-filters.md)
- [Host scheduler](./scheduler.md)
- [Inspector](./inspector.md)
- [Kotlin: Types](../kotlin/types.md)
- [JavaScript: Types](../javascript/types.md)
