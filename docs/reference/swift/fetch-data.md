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

### Count the matches

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let page = try await kizunasync.from("todos")
  .select("id, title", count: .exact)
  .eq("done", false)
  .range(from: 0, to: 19)
  .execute() as? [String: Any]
let openTodos = page?["count"] as? Int
```

With a count, `execute()`, `single()`, and `maybeSingle()` answer `["rows": …, "count": n]`, and `count` is every open todo, not only the 20 on the page. Every `KizunaSyncCountOption` returns the exact local count.

### CSV text and stripped nulls

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let csv = try await kizunasync.from("todos").select("id, title, done").order("title").csv()
let sparse = try await kizunasync.from("todos").select().eq("id", todoId).stripNulls().single()
```

`csv()` answers a `String`: a header of the selected columns in their order, or of every key the rows carry for `*`, then one line per row. A field holding a quote, a comma, or a line break is quoted per RFC 4180, null is an empty field, and an array or an object is its JSON text. `stripNulls()` drops each row's null-valued keys.

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
| `plan["offset"]` | `Int` | No | Rows skipped after filtering and sorting, before `limit` counts the rest. An offset past the last row matches nothing, and a negative one throws `LOCAL_UNSUPPORTED`. [`from(_:).select()`](./using-filters.md#ordering-limiting-and-cardinality) sets it, with `limit`, through `range(from:to:)`. Default: no row skipped. |
| `plan["projection"]` | `[String]` | No | Columns kept on each row. A named column the row does not hold comes back as null. Default: every column. |
| `plan["cardinality"]` | `String` | No | `"many"`, `"single"`, or `"maybeSingle"`. Default: `"many"`. |
| `plan["includeDeleted"]` | `Bool` | No | Brings back the rows the table's `softDeleteColumn` marks, which every read leaves out by default. A table with no such column is unaffected. [`from(_:).select()`](./using-filters.md#ordering-limiting-and-cardinality) chains it as `includeDeleted()`. Default: `false`. |
| `plan["count"]` | `Bool` | No | Answers `["rows": …, "count": n]`: the usual answer beside the rows the filters matched before `offset` and `limit`. `from(_:).select(_:head:count:)` sets it for any `KizunaSyncCountOption`. Default: `false`. |

## Returns

`Any`, decoded from the engine's JSON with `JSONSerialization`. A `"many"` plan answers an array of row objects, `"single"` answers one row object, and `"maybeSingle"` answers a row object or `NSNull` when nothing matched. A plan with `count` wraps that answer as `["rows": …, "count": n]`, and the select builder answers the same dictionary for `head: true`, with `rows` set to `NSNull`. The select builder's `csv()` answers a `String`.

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `table` is not one of the tables the client was created with. |
| `LOCAL_UNSUPPORTED` | The plan cannot be evaluated locally: a filter whose shape or operand the local evaluator refuses, a `match(_:pattern:)` pattern the local regex engine cannot compile, an `overlaps` operand that is not an array, or a cardinality outside the three names. The select builder also throws it for a clause `filter(_:operator:value:)` cannot decode and for `dryRun()`, `geojson()`, `explain(…)`, and `setHeader(name:value:)`, each named with its reason in [Using filters](./using-filters.md#unsupported-operators). |
| `LOCAL_CONSTRAINT` | A `"single"` plan did not match exactly one row, or a `"maybeSingle"` plan matched more than one. |
| `JSON` | The engine cannot parse the encoded plan. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

A value the platform serializer refuses never reaches the engine: `JSONSerialization` raises inside the client first, so it surfaces as a serialization error rather than an engine code.

Every code in the table is the `code` on a thrown `KizunaSyncError.engine(code:message:)`; its `description` reads `"CODE: message"`, but match on `code` rather than parsing the string.

## Notes

The operators and modifiers keep the meaning Supabase documents for [`select()`](https://supabase.com/docs/reference/swift/select#examples), with three local-first differences: the rows come from local [SQLite](https://grokipedia.com/page/SQLite) rather than from [PostgREST](https://postgrest.org/), they already include writes that have not reached the server, and an operator the local evaluator does not implement throws `LOCAL_UNSUPPORTED` instead of being sent to the database. [How Kizuna works](../../getting-started/how-kizuna-works.md#1-your-screen-uses-local-sqlite) explains why the read is local, and [Supported query operators](../query-operators.md) lists every postgrest-js method with its Swift name and status.

[Row Level Security](https://grokipedia.com/page/Row-level_security) decides which rows ever arrive, but it does so during the pull, not during this call. A row the policy hides is never delivered, so it cannot be read here.

There is no live query on the native clients. Re-run `query` or [`from(_:).select()`](https://supabase.com/docs/reference/swift/select#examples) after `LOCAL_CHANGED` from [Subscribe to events](./on.md#returns) to refresh a screen.

## Related reference

- [Using filters](./using-filters.md)
- [Insert data](./insert-data.md)
- [Subscribe to events](./on.md)
- [Sync](./sync.md)
- [Supported query operators](../query-operators.md)
- [Kotlin: Fetch data](../kotlin/fetch-data.md)
- [JavaScript: Fetch data](../javascript/fetch-data.md)
