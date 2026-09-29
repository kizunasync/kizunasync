---
title: Fetch data
description: Read rows out of the local database with a query plan.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Fetch data

`query` evaluates a plan against the rows the local database holds and returns the result as parsed JSON. It reaches no network, so the answer is the same offline as online, and it is the rows the last [Sync](./sync.md) committed plus every local write waiting in the outbox.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncQuery
import org.json.JSONArray

val raw = kizunasync.query(
    table = "todos",
    plan = KizunaSyncQuery.many(KizunaSyncQuery.eq("done", false)),
)
val rows = raw as? JSONArray ?: JSONArray()
```

`query` answers `Any`, because the shape follows the plan's cardinality. Cast it to the shape you asked for.

### Ordered and limited

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncQuery
import org.json.JSONArray

val raw = kizunasync.query(
    table = "todos",
    plan = KizunaSyncQuery.plan(
        filters = JSONArray().put(KizunaSyncQuery.eq("done", false)),
        order = JSONArray().put(KizunaSyncQuery.order("title")),
        limit = 20,
    ),
)
```

### One row

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncQuery
import org.json.JSONObject

val raw = kizunasync.query(
    table = "todos",
    plan = KizunaSyncQuery.single(KizunaSyncQuery.eq("id", todoId)),
)
val todo = raw as? JSONObject
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `table` | `String` | Yes | Table name, which must be one of the keys of `tables` in [Initializing](./initializing.md#parameters). |
| `plan` | `JSONObject` | No | The query plan, built by the `KizunaSyncQuery` helpers or written out key by key. Default: an empty object, which reads every row of the table. |
| `plan.filters` | `JSONArray` | No | Filter objects, combined with `and` when there is more than one. [Using filters](./using-filters.md#supported-filters) lists the shapes. Default: none. |
| `plan.orders` | `JSONArray` | No | Sort keys, applied in order. Each entry takes `column`, an optional `ascending` (default `true`), and an optional `nulls_first`, which defaults to sorting nulls first only on a descending key. Default: the order the store returns. |
| `plan.limit` | `Int` | No | Rows kept after filtering and sorting. Default: no limit. |
| `plan.projection` | `JSONArray` | No | Columns kept on each row. A named column the row does not hold comes back as null. Default: every column. |
| `plan.cardinality` | `String` | No | `"many"`, `"single"`, or `"maybeSingle"`. Default: `"many"`. |
| `plan.includeDeleted` | `Boolean` | No | Brings back the rows the table's `softDeleteColumn` marks, which every read leaves out by default. A table with no such column is unaffected. [`from(table).select()`](./using-filters.md#ordering-limiting-and-cardinality) chains it as `includeDeleted()`. Default: `false`. |

## Returns

`Any`, parsed from the engine's JSON. A `"many"` plan answers a `JSONArray` of row objects, `"single"` answers a `JSONObject`, and `"maybeSingle"` answers a `JSONObject` or `JSONObject.NULL` when nothing matched. It is never null, which is the same non-optional shape Swift returns.

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `table` is not one of the tables the client was created with. |
| `LOCAL_UNSUPPORTED` | The plan cannot be evaluated locally: a `"single"` that did not match exactly one row, a `"maybeSingle"` that matched more than one, a filter whose shape or operand the local evaluator refuses, or a cardinality outside the three names. |
| `JSON` | The engine cannot parse the encoded plan. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

A value `org.json` refuses never reaches the engine: the client raises a `JSONException` while encoding, so it surfaces as that exception rather than an engine code.

Every code in the table is the `code` on a thrown `KizunaSyncError.Engine`; `message` reads `"CODE: message"`, but match on `code` rather than parsing the string.

## Notes

The operators and modifiers keep the meaning Supabase documents for [`select()`](https://supabase.com/docs/reference/kotlin/select#parameters), with three local-first differences: the rows come from local [SQLite](https://grokipedia.com/page/SQLite) rather than from [PostgREST](https://postgrest.org/), they already include writes that have not reached the server, and an operator the local evaluator does not implement throws `LOCAL_UNSUPPORTED` instead of being sent to the database. [How Kizuna works](../../getting-started/how-kizuna-works.md#1-your-screen-uses-local-sqlite) explains why the read is local.

[Row Level Security](https://grokipedia.com/page/Row-level_security) decides which rows ever arrive, but it does so during the pull, not during this call. A row the policy hides is never delivered, so it cannot be read here.

There is no live query on the native clients. Re-run `query` or [`from(table).select()`](https://supabase.com/docs/reference/kotlin/select#parameters) after `LOCAL_CHANGED` from [Subscribe to events](./on.md#returns) to refresh a screen.

## Related reference

- [Using filters](./using-filters.md)
- [Insert data](./insert-data.md)
- [Subscribe to events](./on.md)
- [Sync](./sync.md)
- [Swift: Fetch data](../swift/fetch-data.md)
- [JavaScript: Fetch data](../javascript/fetch-data.md)
