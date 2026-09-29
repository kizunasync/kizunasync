---
title: Fetch data
description: Read rows out of the local database with a query plan.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Fetch data

`query(table:plan:)` evaluates a plan against the rows the local database holds and returns the result as decoded JSON. It reaches no network, so the answer is the same offline as online, and it is the rows the last [Sync](./sync.md) committed plus every local write waiting in the outbox.

## Examples

### Basic

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let raw = try await kizunasync.query(
  table: "todos",
  plan: KizunaSyncQuery.many(filters: [KizunaSyncQuery.eq("done", false)])
)
let rows = raw as? [[String: Any]] ?? []
let also = try await kizunasync.from("todos").select().eq("done", false).execute()
```

`query` answers `Any`, because the shape follows the plan's cardinality. Cast it to the shape you asked for.

### Ordered and limited

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let raw = try await kizunasync.query(
  table: "todos",
  plan: KizunaSyncQuery.plan(
    filters: [KizunaSyncQuery.eq("done", false)],
    order: [KizunaSyncQuery.order("title")],
    limit: 20
  )
)
```

### One row

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let raw = try await kizunasync.query(
  table: "todos",
  plan: KizunaSyncQuery.single(filters: [KizunaSyncQuery.eq("id", todoId)])
)
let todo = raw as? [String: Any]
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `table` | `String` | Yes | Table name, which must be one of the keys of `tables` in [Initializing](./initializing.md#parameters). |
| `plan` | `[String: Any]` | No | The query plan, built by the `KizunaSyncQuery` helpers or written out key by key. Default: empty, which reads every row of the table. |
| `plan["filters"]` | `[[String: Any]]` | No | Filter objects, combined with `and` when there is more than one. [Using filters](./using-filters.md#supported-filters) lists the shapes. Default: none. |
| `plan["orders"]` | `[[String: Any]]` | No | Sort keys, applied in order. Each entry takes `column`, an optional `ascending` (default `true`), and an optional `nulls_first`, which defaults to sorting nulls first only on a descending key. Default: the order the store returns. |
| `plan["limit"]` | `Int` | No | Rows kept after filtering and sorting. Default: no limit. |
| `plan["projection"]` | `[String]` | No | Columns kept on each row. A named column the row does not hold comes back as null. Default: every column. |
| `plan["cardinality"]` | `String` | No | `"many"`, `"single"`, or `"maybeSingle"`. Default: `"many"`. |
| `plan["includeDeleted"]` | `Bool` | No | Brings back the rows the table's `softDeleteColumn` marks, which every read leaves out by default. A table with no such column is unaffected. [`from(_:).select()`](./using-filters.md#ordering-limiting-and-cardinality) chains it as `includeDeleted()`. Default: `false`. |

## Returns

`Any`, decoded from the engine's JSON with `JSONSerialization`. A `"many"` plan answers an array of row objects, `"single"` answers one row object, and `"maybeSingle"` answers a row object or `NSNull` when nothing matched.

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `table` is not one of the tables the client was created with. |
| `LOCAL_UNSUPPORTED` | The plan cannot be evaluated locally: a `"single"` that did not match exactly one row, a `"maybeSingle"` that matched more than one, a filter whose shape or operand the local evaluator refuses, or a cardinality outside the three names. |
| `JSON` | The engine cannot parse the encoded plan. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

A value the platform serializer refuses never reaches the engine: `JSONSerialization` raises inside the client first, so it surfaces as a serialization error rather than an engine code.

Every code in the table is the `code` on a thrown `KizunaSyncError.engine(code:message:)`; its `description` reads `"CODE: message"`, but match on `code` rather than parsing the string.

## Notes

The operators and modifiers keep the meaning Supabase documents for [`select()`](https://supabase.com/docs/reference/swift/select#examples), with three local-first differences: the rows come from local [SQLite](https://grokipedia.com/page/SQLite) rather than from [PostgREST](https://postgrest.org/), they already include writes that have not reached the server, and an operator the local evaluator does not implement throws `LOCAL_UNSUPPORTED` instead of being sent to the database. [How Kizuna works](../../getting-started/how-kizuna-works.md#1-your-screen-uses-local-sqlite) explains why the read is local.

[Row Level Security](https://grokipedia.com/page/Row-level_security) decides which rows ever arrive, but it does so during the pull, not during this call. A row the policy hides is never delivered, so it cannot be read here.

There is no live query on the native clients. Re-run `query` or [`from(_:).select()`](https://supabase.com/docs/reference/swift/select#examples) after `LOCAL_CHANGED` from [Subscribe to events](./on.md#returns) to refresh a screen.

## Related reference

- [Using filters](./using-filters.md)
- [Insert data](./insert-data.md)
- [Subscribe to events](./on.md)
- [Sync](./sync.md)
- [Kotlin: Fetch data](../kotlin/fetch-data.md)
- [JavaScript: Fetch data](../javascript/fetch-data.md)
