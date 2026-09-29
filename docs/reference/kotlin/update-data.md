---
title: Update data
description: Update rows with the write builder or the low-level apply call.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Update data

`from(table).update(columns, transforms, precondition)` starts a [`KizunaSyncWriteBuilder`](./types.md#writes-and-queries) that patches every row a chained filter matches; `execute()` sends it as one [Write with filters](./apply-where.md) call and answers the primary keys touched. `apply(table, pk, op, ...)` is the low-level call that patches one row by primary key directly. Only the columns given are touched; every other column keeps the value the local database holds.

## Examples

### One row, by primary key

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncOp

kizunasync.apply(
    table = "todos",
    pk = todoId,
    op = KizunaSyncOp.Update,
    columns = mapOf("done" to true),
)
```

### Every matching row, with the write builder

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val pks =
    kizunasync.from("todos")
        .update(mapOf("done" to true))
        .eq("done", false)
        .execute()
```

### With a precondition

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncOp

kizunasync.apply(
    table = "todos",
    pk = todoId,
    op = KizunaSyncOp.Update,
    columns = mapOf("title" to "works on a plane"),
    precondition = mapOf("done" to false),
)
```

The local row changes right away. The server compares `precondition` against the row its own policies let it read, and answers a mismatch with a `PRECONDITION` rejection, which reverts the optimistic value.

### With a transform

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncOp

kizunasync.apply(
    table = "todos",
    pk = todoId,
    op = KizunaSyncOp.Update,
    transforms = mapOf("views" to mapOf("op" to "increment", "by" to 1)),
)
```

## Parameters

### `from(table).update(columns, transforms, precondition)`

| Name | Type | Required | Description |
|---|---|---|---|
| `columns` | `Map<String, Any?>` | Yes | Columns to assign to every matched row. Unlike `insert`, the builder requires this argument; pass `emptyMap()` for a transform-only update. |
| `transforms` | `Map<String, Any?>?` | No | Field transforms, keyed by column, applied to each matched row on top of the assigned columns. See [Using transforms](./using-transforms.md#supported-transforms). Default: `null`. |
| `precondition` | `Map<String, Any?>?` | No | Column values the server compares per row before it applies that row's mutation. Default: `null`. |

The returned `KizunaSyncWriteBuilder` then chains every filter [Using filters](./using-filters.md#supported-filters) documents, except `search` and `textSearch`, which stay read-only and are not on this builder. `suspend fun execute(): List<String>` sends the write once at least one filter is chained.

### `apply(table, pk, op, columns, mutationId, transforms, precondition)`

| Name | Type | Required | Description |
|---|---|---|---|
| `table` | `String` | Yes | Table name, which must be one of the keys of `tables` in [Initializing](./initializing.md#parameters). |
| `pk` | `String` | Yes | Primary key of the row to patch. |
| `op` | `KizunaSyncOp` | Yes | Set to `KizunaSyncOp.Update`, whose column payload is the one Supabase documents for [`update()`](https://supabase.com/docs/reference/kotlin/update#parameters). |
| `columns` | `Map<String, Any?>` | No | Columns to assign, encoded to a `JSONObject`. An `id` key is refused when it differs from `pk`. Default: empty. |
| `mutationId` | `String?` | No | Client-side id of this mutation, echoed in the server verdict and in the journal. Default: `null`, which makes the engine generate a [UUID](https://grokipedia.com/page/Universally_unique_identifier). |
| `transforms` | `Map<String, Any?>?` | No | Field transforms, keyed by column, applied on top of the assigned columns. See [Using transforms](./using-transforms.md#supported-transforms). Default: `null`. |
| `precondition` | `Map<String, Any?>?` | No | Column values the server compares against the row it can see before it applies the mutation. A mismatch is rejected with reason `PRECONDITION`. Default: `null`. |

## Returns

`apply` answers `Unit`; the write builder's `execute()` answers `List<String>`, the primary keys that matched. Both functions suspend on `Dispatchers.IO`, so neither ever blocks the Android main thread.

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `table` is not one of the tables the client was created with. |
| `LOCAL_CONSTRAINT` | `columns["id"]` differs from `pk` (`apply` only; the write builder's `columns` carries no `id` convention), or a transform is malformed: an entry that is not an object, a missing `op`, an `op` outside `increment`, `arrayUnion`, and `arrayRemove`, an `increment` without `by` or with a `by` that is not a signed integer, or an `arrayUnion` or `arrayRemove` without a `values` array. |
| `LOCAL_UNSUPPORTED` | The write builder's `execute()` ran with no filter chained, because an unfiltered update would rewrite the whole table. |
| `JSON` | The engine cannot parse the encoded mutation. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

`apply` throws `KizunaSyncError.Engine("LOCAL_UNSUPPORTED", "apply requires table and pk")` inside the client when `table` or `pk` is empty, before the engine is reached. A value `org.json` refuses never reaches the engine: the client raises a `JSONException` while encoding, so it surfaces as that exception rather than an engine code.

## Notes

Supabase documents the column payload and its parameters on [`update()`](https://supabase.com/docs/reference/kotlin/update#parameters). This page adds only what local-first changes. The update is optimistic: it commits locally at once, and its verdict arrives with a later [Sync](./sync.md). Two peers that write different columns of one row both keep their value, because the merge is per column. Two peers that write the same column settle by the mode the table is configured with, and the loser is reported as `COLUMN_OVERWRITTEN` on [Subscribe to events](./on.md#returns). [Conflict resolution](../../sync/conflict-resolution.md#column-masks) explains the rule. The queued mutation waits in the outbox until a run delivers it, the path [Offline writes](../../sync/offline-writes.md#1-write-locally) walks through.

An update whose row is missing locally writes the assigned columns as the whole row rather than failing, because the mutation is already queued for the server. That shape does not clear a [tombstone](../../resources/glossary.md#tombstone) a peer's delete left behind, so a deleted row is not revived by a late edit.

The write builder is a convenience over [Write with filters](./apply-where.md#parameters): it targets rows a chained filter matches rather than one primary key, which is the shape a bulk edit like "mark every open todo done" wants.

## Related reference

- [Insert data](./insert-data.md)
- [Delete data](./delete-data.md)
- [Write with filters](./apply-where.md)
- [Using transforms](./using-transforms.md)
- [List rejections](./rejections.md)
- [Swift: Update data](../swift/update-data.md)
- [JavaScript: Update data](../javascript/update-data.md)
