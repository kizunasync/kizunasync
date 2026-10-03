---
title: Types
description: Every public Kotlin type the com.kizunasync.kizunasync package exports.
status: alpha
docType: reference
library: kotlin
pageKind: type
audience: app-developer
---

# Kotlin: Types

The `com.kizunasync.kizunasync` package holds the client, the configuration data classes, the query and write builders, the scheduler, the inspector, and the records the engine answers with. The records are typealiases over the generated [UniFFI](https://mozilla.github.io/uniffi-rs/) types, so their fields carry the names the generator produced.

```kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncClient
```

## Client and configuration

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncClient` | `class` | — | The client itself. Every function except `from(table)` is a suspending function that runs on `Dispatchers.IO`. `from(table)` is synchronous and throws `UNKNOWN_TABLE` eagerly, and `dispose()` suspends but never throws. See [Initializing](./initializing.md). |
| `KizunaSyncClientConfig` | `data class` | — | Whole client configuration: `clientId`, `schemaVersion`, `tables`, `databasePath`, `remote`, `attachmentRoot`, `defaultLimit`, `attachmentAttempts`. `deviceId` is `clientId`, or a minted lowercase uuid when `clientId` is `null`; `toJson()` encodes `deviceId`, not the nullable field. `declaresAttachments()` reports whether any table declares an attachment column. |
| `KizunaSyncTableConfig` | `data class` | — | One synced table: `bucket` (default `KizunaSyncBucket.None`), `attachments`, `softDeleteColumn`, `conflictMode`, `syncMode`, and `key` (default `listOf("id")`, the table's primary-key columns in key order). |
| `KizunaSyncBucket` | `sealed class` | — | Which rows of a table the device pulls: `None`, `ByOwner(column)` for a column that holds the owning user's id, which the engine fills from the session token, or `ByColumn(column)` for a column whose value the app sets with [Set bucket](./set-bucket.md). Default: `KizunaSyncBucket.None`. See [Initializing](./initializing.md#parameters). |
| `KizunaSyncAttachmentSpec` | `data class` | — | One attachment column: `storageBucket` and `ownerColumn`. |
| `KizunaSyncRemoteConfig` | `data class` | — | The [PostgREST](https://postgrest.org/) remote: `url`, `publishableKey`, `accessToken`, `schema`, and `localOnlyColumns`. |
| `KizunaSyncConflictMode` | `enum class` | — | `Arrival` trusts server order; `Hlc` compares the origin clock stamp `apply` attaches. Each carries the wire name in `wire`. Default: `Arrival`. See [Initializing](./initializing.md#parameters). |
| `KizunaSyncSyncMode` | `enum class` | — | `ReadWrite` pulls the table and pushes its local writes; `PullOnly` pulls it and has the engine refuse every local write with `LOCAL_UNSUPPORTED`. Each carries the wire name in `wire`, `"read-write"` or `"pull-only"`. Default: `ReadWrite`. See [Initializing](./initializing.md#parameters). |

## Writes and queries

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncTable` | `class` | — | The fluent surface of one table, returned by `KizunaSyncClient.from(table)`: `insert(columns)`, `update(columns, transforms, precondition)`, `delete(precondition)`, and `select(columns, head, count)`. See [Insert data](./insert-data.md), [Update data](./update-data.md), and [Delete data](./delete-data.md). |
| `KizunaSyncSelectBuilder` | `class` | — | Fluent read over one table, returned by `KizunaSyncTable.select(columns, head, count)`. Chains every filter and builder operator in [Using filters](./using-filters.md#builder-operators) plus `order(column, ascending, nullsFirst)`, `limit(count)`, `range(from, to)`, `includeDeleted()`, `stripNulls()`, and `retry(enabled)`, then `execute()`, `single()`, `maybeSingle()`, or `csv(): String`. |
| `KizunaSyncCount` | `enum class` | — | `Exact`, `Planned`, `Estimated`, the `count` options `select(columns, head, count)` takes. Every one returns the exact local count. |
| `KizunaSyncWriteBuilder` | `class` | — | Fluent filter-targeted write, returned by `KizunaSyncTable.update(columns, transforms, precondition)` and `KizunaSyncTable.delete(precondition)`. Chains the same filters as `KizunaSyncSelectBuilder` except `search` and `textSearch`, which stay read-only, plus `maxAffected(value)`, then `execute(): List<String>` or `select(columns)`. See [Write with filters](./apply-where.md). |
| `KizunaSyncWriteSelectBuilder` | `class` | — | A write chained with `select(columns)`: `execute(): JSONArray` answers the rows it reached, and `single()` and `maybeSingle()` one row. Chains `stripNulls()` and `retry(enabled)`. See [Update data](./update-data.md#parameters). |
| `KizunaSyncOp` | `enum class` | — | `Insert`, `Update`, `Delete`. Each carries the wire name in `wire`. |
| `KizunaSyncTextSearchType` | `enum class` | — | `Plain`, `Phrase`, `Websearch`, the parse modes `textSearch` accepts. Each carries the wire name in `wire`. Default `Plain`. See [Using filters](./using-filters.md#supported-filters). |
| `KizunaSyncQuery` | `object` | — | Plan builders: `eq(column, value)`, `neq(column, value)`, `gt(column, value)`, `gte(column, value)`, `lt(column, value)`, `lte(column, value)`, `like(column, pattern)`, `ilike(column, pattern)`, `isValue(column, value)`, `inValues(column, values)`, `contains(column, value)`, `containedBy(column, value)`, `and(vararg filters)`, `or(vararg filters)`, `not(filter)`, `search(query, columns)`, `textSearch(column, query, type)`, `order(column, ascending, nullsFirst)`, `plan(filters, order, limit, projection, cardinality, includeDeleted)`, `many(vararg filters)`, `single(vararg filters)`, and `maybeSingle(vararg filters)`. They serialize the plan; they do not evaluate it. `eq`, `neq`, `isValue`, and `inValues` take `Any?` and accept `null` directly; `gt`, `gte`, `lt`, `lte`, `contains`, and `containedBy` take a non-null `Any`. See [Using filters](./using-filters.md). |

Swift takes `Any` for every `KizunaSyncQuery` operand, including the ordered and containment helpers Kotlin requires non-null. Its `is` is the one exception: that helper is typed `Bool?`, with `nil` as the null test. Kotlin's twin `isValue` takes `Boolean?` the same way.

## Records the engine answers with

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncCheckpoint` | `data class` | — | `cursor`, `softBlocked`, and `softBlockReason`. See [Checkpoint](./checkpoint.md#returns). |
| `KizunaSyncRejection` | `data class` | — | `mutationId`, `table`, `pk`, `kind`, `reason`, `changedColumns`, `serverRowJson`, `at`, `dismissed`. See [List rejections](./rejections.md#returns). |
| `KizunaSyncOverwrite` | `data class` | — | `id`, `table`, `pk`, `column`, `loserValueJson`, `winnerMutationId`, `conflictMode`, `winnerSeq`, `at`, `dismissed`. See [List overwrites](./overwrites.md#returns). |
| `KizunaSyncAttachmentStatus` | `data class` | — | `state`, `progress`, `error`, `localPath`, `permanent`, `errorCode`. `state` is `queued`, `uploading`, `downloading`, `synced`, `failed`, `orphaned`, `evicted` (this device dropped its copy and the object stays in Storage), or `missing`. `errorCode` (`String?`) is the catalog code of the last recorded failure, and null while the row records none. See [Get attachment status](./get-status.md#returns). |
| `KizunaSyncFromFileResult` | `data class` | — | `reference`, `sha256`, `size`, `mediaType`, `localPath`. See [Attach a file](./from-file.md#returns). |
| `KizunaSyncEngineEvent` | `sealed class` | — | `LocalChanged`, `QueueDepth`, `MutationRejected`, `BatchAborted`, `DeadLetter`, `ColumnOverwritten`, `CheckpointExpired`, `ResetRequired`. See [Subscribe to events](./on.md#parameters). |

## Inspector

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncInspector` | `class` | — | Devtools over one client, built and memoized by `KizunaSyncClient.inspector()`: `snapshot()`, `verdicts()`, `subscribe(onChange)`, and `clear()`. See [Inspect the client](./inspect.md) and [Inspector](./inspector.md). |
| `KizunaSyncInspectorSnapshot` | `data class` | — | `queued`, `depth`, `lastMutationId`, `cursor`, `clientId`. The same five fields `KizunaSyncClient.inspect()` answers raw. |
| `KizunaSyncInspectorVerdict` | `data class` | — | `mutationId`, `kind`, `reason`, `at` (epoch milliseconds). One entry of the 50-entry ring. |
| `KizunaSyncInspectorVerdictKind` | `enum class` | — | `Rejected` for a `MutationRejected` event, `Aborted` for a `BatchAborted` event, `Overwritten` for a `ColumnOverwritten` event. |

## Scheduling and errors

| Name | Type | Required | Description |
|---|---|---|---|
| `KizunaSyncScheduler` | `class` | — | The host loop over one client: it takes the client, `refreshSession`, and a `sync` lambda that defaults to the client's `sync()`, and syncs at start, after every local write, on its timer, and on the path and foreground sources the app passes. See [Host scheduler](./scheduler.md). |
| `KizunaSyncWakeReason` | `enum class` | — | `Poll`, `Foreground`, `Path`, `Doorbell`, `LocalWrite`, `Start`. It names the trigger of a run. |
| `KizunaSyncSyncPhase` | `enum class` | — | `Idle`, `Syncing`, `Backoff`, `Stalled`, `Offline`. What the loop is doing right now. |
| `KizunaSyncSyncHealth` | `data class` | — | `phase`, `consecutiveFailures`, `nextAttemptAt`, `attemptStartedAt`, `lastSuccessAt`, `lastError`, `needsReset`. An observable snapshot of the loop. `nextAttemptAt`, `attemptStartedAt`, and `lastSuccessAt` are `Long?` epoch milliseconds; `needsReset` is `Boolean`, `false` on a scheduler built with no `needsResetSource`. |
| `KizunaSyncSyncHealthError` | `data class` | — | `code` (`String?`), `message`, `at` (epoch milliseconds). The failure the last attempt reported; `code` is the catalog code when the failure was a `KizunaSyncError`, and null for anything else the `sync` or `refreshSession` lambda threw. |
| `KizunaSyncPathMonitor` | `interface` | — | The network-path source the scheduler gates on: `start(onSatisfied)` and `stop()`. See [Path monitoring](./scheduler.md#path-monitoring). |
| `KizunaSyncConnectivityPathMonitor` | `class` | — | The Android `KizunaSyncPathMonitor` over `ConnectivityManager.NetworkCallback`. It takes a `Context` and ships in the Android artifact only. |
| `KizunaSyncForegroundSource` | `interface` | — | The return-to-foreground source the scheduler wakes on: `start(onForeground)` and `stop()`. See [Foreground wake](./scheduler.md#foreground-wake). |
| `KizunaSyncProcessForegroundSource` | `class` | — | The Android `KizunaSyncForegroundSource` over `ProcessLifecycleOwner`. It ships in the Android artifact only; a JVM host passes none and calls `notifyForeground()` itself. |
| `KizunaSyncRealtimeSubscription` | `fun interface` | — | One subscription the scheduler holds and releases: `cancel()`, idempotent. |
| `KizunaSyncRealtimeWakeup` | `interface` | — | The realtime doorbell the app implements: `subscribe(topics, onWake)`. See [Realtime wake](./scheduler.md#realtime-wake). |
| `KizunaSyncError` | `sealed class` | — | The client's own error, an `Exception` with the single subclass `Engine(code: String, message: String)`. `code` is the stable catalog code an app switches on; `detail` is the text alone, and `message` (inherited from `Exception`) reads `"CODE: message"`. |

## Notes

[`KizunaSyncClient`](./initializing.md) never lets the generated `KizunaSyncFfiException` escape: every call catches it off the calling thread and rethrows `KizunaSyncError.Engine`, whose `code` is the value each page's Errors table lists. It raises the same type for the checks it makes itself, such as `ATTACHMENT_PORTS_MISSING` in [Initializing](./initializing.md#errors) and `LOCAL_UNSUPPORTED` for an empty `table` or `pk` on `apply`. Match on `code`, not on `message`, to switch on it.

## Related reference

- [Initializing](./initializing.md)
- [Using filters](./using-filters.md)
- [Host scheduler](./scheduler.md)
- [Inspector](./inspector.md)
- [Swift: Types](../swift/types.md)
- [JavaScript: Types](../javascript/types.md)
