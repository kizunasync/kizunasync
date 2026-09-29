---
title: Insert data
description: Insert one row with the write builder or the low-level apply call.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Insert data

`from(table).insert(columns)` writes the row into the local database and queues one [outbox](../../resources/glossary.md#outbox) mutation for the next sync run, minting a primary key when `columns` does not carry a usable one. `apply(table, pk, op, ...)` is the same write at the low level, for a call site that already has its own primary key or needs `mutationId`.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
kizunasync.from("todos").insert(
    mapOf("title" to "works on a plane", "done" to false),
)
```

### With your own primary key

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import java.util.UUID

kizunasync.from("todos").insert(
    mapOf(
        "id" to UUID.randomUUID().toString(),
        "title" to "works on a plane",
        "done" to false,
    ),
)
```

### Low-level: apply

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncOp
import java.util.UUID

val mutationId = UUID.randomUUID().toString()
kizunasync.apply(
    table = "todos",
    pk = todoId,
    op = KizunaSyncOp.Insert,
    columns = mapOf("title" to "works on a plane", "done" to false),
    mutationId = mutationId,
)
```

The id you pass as `mutationId` is the one the server's verdict and any journal entry carry, so a screen can match a [rejection](./rejections.md) back to the write that caused it. `from(table).insert(columns)` has no `mutationId` parameter; use `apply` when you need to pass one.

## Parameters

### `from(table).insert(columns)`

| Name | Type | Required | Description |
|---|---|---|---|
| `columns` | `Map<String, Any?>` | No | Column values for the row. A non-empty `String` under `"id"` becomes the primary key; any other value, including a missing key, mints a lowercase UUID and leaves `columns` untouched, so the map's own `"id"` is not overwritten. Default: empty. |

### `apply(table, pk, op, columns, mutationId, transforms, precondition)`

| Name | Type | Required | Description |
|---|---|---|---|
| `table` | `String` | Yes | Table name, which must be one of the keys of `tables` in [Initializing](./initializing.md#parameters). |
| `pk` | `String` | Yes | Primary key of the new row. It must be non-empty: the client refuses an empty value before the engine is reached. The server casts this value to `uuid`, so pass a [UUID](https://grokipedia.com/page/Universally_unique_identifier) string. |
| `op` | `KizunaSyncOp` | Yes | Set to `KizunaSyncOp.Insert`, whose column payload is the one Supabase documents for [`insert()`](https://supabase.com/docs/reference/kotlin/insert#parameters). |
| `columns` | `Map<String, Any?>` | No | Column values for the row, encoded to a `JSONObject`. Default: empty. |
| `mutationId` | `String?` | No | Client-side id of this mutation, echoed in the server verdict and in the journal. Default: `null`, which makes the engine generate a UUID. |
| `transforms` | `Map<String, Any?>?` | No | Field transforms, keyed by column. The local insert path writes `columns` only, so a transform changes nothing locally on an insert. See [Using transforms](./using-transforms.md). Default: `null`. |
| `precondition` | `Map<String, Any?>?` | No | Column values the server compares against the row it can see before it applies the mutation. A mismatch is rejected with reason `PRECONDITION` instead of applied. Default: `null`. |

## Returns

`Unit`. Both functions suspend on `Dispatchers.IO`, so neither ever blocks the Android main thread.

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `table` is not one of the tables the client was created with. |
| `LOCAL_CONSTRAINT` | A live row already holds this `pk` in this table, or `columns["id"]` names an identifier that differs from `pk`. `from(table).insert(columns)` reaches this only when `columns["id"]` holds a value that is not a non-empty string, so the minted key diverges from it; `apply` reaches it whenever the caller passes the two apart. |
| `JSON` | The engine cannot parse the encoded mutation. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

`apply` throws `KizunaSyncError.Engine("LOCAL_UNSUPPORTED", "apply requires table and pk")` inside the client when `table` or `pk` is empty, before the engine is reached. A value `org.json` refuses never reaches the engine: the client raises a `JSONException` while encoding, so it surfaces as that exception rather than an engine code.

## Notes

Supabase documents the column payload and its parameters on [`insert()`](https://supabase.com/docs/reference/kotlin/insert#parameters); this page adds only what local-first changes. The write lands in local [SQLite](https://grokipedia.com/page/SQLite) first and its verdict arrives with a later [Sync](./sync.md), which is the path [Offline writes](../../sync/offline-writes.md#1-write-locally) walks through. A successful insert raises `LOCAL_CHANGED` and then `QUEUE_DEPTH` on [Subscribe to events](./on.md#returns), so a list can refresh itself without polling. Until a run delivers it, the row is counted by [Outbox depth](./outbox-depth.md). The [Host scheduler](./scheduler.md) wakes on that `QUEUE_DEPTH` event, so the write goes out without waiting for its timer.

On a table whose bucket is `KizunaSyncBucket.ByOwner(column)`, an insert that leaves that column out is written with the owner's id: the user the first session token named, at create or through [Set access token](./set-access-token.md), which the local database keeps across launches. The outbox entry carries the filled column too. An insert that names the column keeps its value, `null` included, and an update or a delete is never filled. Before any token has named an owner, the insert keeps only the columns you passed.

Row Level Security judges the insert when the push reaches the server, not when this function returns. When a policy refuses the row, the engine reverts it after the fact and journals the rejection. Supabase describes the policy side under [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#insert-policies).

## Related reference

- [Fetch data](./fetch-data.md)
- [Update data](./update-data.md)
- [Delete data](./delete-data.md)
- [Using transforms](./using-transforms.md)
- [Sync](./sync.md)
- [Swift: Insert data](../swift/insert-data.md)
- [JavaScript: Insert data](../javascript/insert-data.md)
