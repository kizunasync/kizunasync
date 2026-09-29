---
title: Delete data
description: Delete rows with the write builder or the low-level apply call.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Delete data

`from(table).delete(precondition)` starts a [`KizunaSyncWriteBuilder`](./types.md#writes-and-queries), and `execute()` sends the chained filters as one [Write with filters](./apply-where.md) call that tombstones every matching row and answers the primary keys touched. `apply(table, pk, op, ...)` is the low-level call that deletes one row by primary key directly.

Either path removes the row from the local database, records a tombstone for it, and queues the mutation for the next sync run; on a table that sets `softDeleteColumn` the row stays and only that column changes, as Notes describes.

## Examples

### One row, by primary key

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncOp

kizunasync.apply(
    table = "todos",
    pk = todoId,
    op = KizunaSyncOp.Delete,
)
```

### Every matching row, with the write builder

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val pks =
    kizunasync.from("todos")
        .delete()
        .eq("list_id", listId)
        .execute()
```

### Only if the row remains done

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncOp

kizunasync.apply(
    table = "todos",
    pk = todoId,
    op = KizunaSyncOp.Delete,
    precondition = mapOf("done" to true),
)
```

## Parameters

### `from(table).delete(precondition)`

| Name | Type | Required | Description |
|---|---|---|---|
| `precondition` | `Map<String, Any?>?` | No | Column values the server compares per row before it applies that row's delete. Default: `null`. |

The returned `KizunaSyncWriteBuilder` takes no `columns` and no `transforms` parameter, because the store's delete path reads neither; it chains every filter [Using filters](./using-filters.md#supported-filters) documents except `search` and `textSearch`, which stay read-only on the select builder. `suspend fun execute(): List<String>` sends the write once at least one filter is chained.

### `apply(table, pk, op, columns, mutationId, precondition)`

| Name | Type | Required | Description |
|---|---|---|---|
| `table` | `String` | Yes | Table name, which must be one of the keys of `tables` in [Initializing](./initializing.md#parameters). |
| `pk` | `String` | Yes | Primary key of the row to delete. |
| `op` | `KizunaSyncOp` | Yes | Set to `KizunaSyncOp.Delete`, which targets one row here rather than a filter, unlike Supabase [`delete()`](https://supabase.com/docs/reference/kotlin/delete#parameters). |
| `columns` | `Map<String, Any?>` | No | Carried on the mutation and ignored by the delete path, which needs only the primary key. Default: empty. |
| `mutationId` | `String?` | No | Client-side id of this mutation, echoed in the server verdict and in the journal. Default: `null`, which makes the engine generate a [UUID](https://grokipedia.com/page/Universally_unique_identifier). |
| `precondition` | `Map<String, Any?>?` | No | Column values the server compares against the row it can see before it applies the delete. A mismatch is rejected with reason `PRECONDITION` and the row comes back. Default: `null`. |

## Returns

`apply` answers `Unit`; the write builder's `execute()` answers `List<String>`, the primary keys that matched. Both functions suspend on `Dispatchers.IO`, so neither ever blocks the Android main thread.

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `table` is not one of the tables the client was created with. |
| `SOFT_DELETE_VIOLATION` | `apply(table, pk, op = KizunaSyncOp.Delete, ...)` targeted a row whose table sets `softDeleteColumn` in [Initializing](./initializing.md#parameters). The write builder's filter-targeted `execute()` never raises this; see Notes. |
| `LOCAL_UNSUPPORTED` | The write builder's `execute()` ran with no filter chained, because an unfiltered delete would rewrite the whole table. |
| `JSON` | The engine cannot parse the encoded mutation. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

`apply` throws `KizunaSyncError.Engine("LOCAL_UNSUPPORTED", "apply requires table and pk")` inside the client when `table` or `pk` is empty, before the engine is reached. A value `org.json` refuses never reaches the engine: the client raises a `JSONException` while encoding, so it surfaces as that exception rather than an engine code.

## Notes

Supabase documents the call and its parameters on [`delete()`](https://supabase.com/docs/reference/kotlin/delete#parameters); this page adds only what local-first changes. The row disappears from local [SQLite](https://grokipedia.com/page/SQLite) at once and the delete waits in the [outbox](../../resources/glossary.md#outbox) until a run carries it, so a screen never waits for the network to hide it. A delete a policy refuses is rejected with reason `RLS_DENIED`, and the row is restored from the pre-image the outbox kept. A delete the caller's role holds no `DELETE` privilege on is rejected with reason `COLUMN_DENIED` instead: the check is table-level here, because a delete carries no column of its own to restrict. [Offline writes](../../sync/offline-writes.md#3-handle-a-rejection) shows the handling.

A delete wins over a concurrent edit from another device: the peer's update is answered with reason `DELETE_WINS` rather than reviving the row. [Conflict resolution](../../sync/conflict-resolution.md#deletes) states the rule. When the row held an attachment whose bytes had not finished uploading, the next run finds the row gone and orphans that object for [Vacuum attachments](./vacuum.md).

A table whose [`KizunaSyncTableConfig`](./initializing.md#parameters) sets `softDeleteColumn` treats the two paths differently. `from(table).delete(precondition)`'s filter-targeted `execute()` still tombstones nothing removable. It queues a mutation that stamps the column with one timestamp for the whole call, the same as [Update data](./update-data.md), so the row leaves the default read the way a hard delete would and [`includeDeleted()`](./fetch-data.md#parameters) brings it back. The low-level `apply(table, pk, op = KizunaSyncOp.Delete, ...)` refuses instead, with `SOFT_DELETE_VIOLATION`, because that call expects a caller reaching for one row by primary key to write the column explicitly. The same column is [`softDelete`](../javascript/define-config.md#parameters) in a JavaScript config. JavaScript's write builder makes the identical substitution.

The write builder is a convenience over [Write with filters](./apply-where.md#parameters): it targets rows a chained filter matches rather than one primary key, which is the shape a bulk cleanup like "delete every todo in this list" wants.

## Related reference

- [Insert data](./insert-data.md)
- [Update data](./update-data.md)
- [Write with filters](./apply-where.md)
- [List rejections](./rejections.md)
- [Swift: Delete data](../swift/delete-data.md)
- [JavaScript: Delete data](../javascript/delete-data.md)
