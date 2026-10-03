---
title: Using filters
description: The filter, order, and cardinality vocabulary the local query evaluator implements.
status: alpha
docType: reference
library: swift
pageKind: guide
audience: app-developer
---

# Swift: Using filters

A filter is a dictionary with a `kind` key and the operands that kind needs. `KizunaSyncQuery` builds the common ones; any other kind is written out as a dictionary and passed the same way. Filters are used by [Fetch data](./fetch-data.md#parameters) to select rows and by [Write with filters](./apply-where.md#parameters) to choose the rows a write targets.

## Supported filters

| Name | Type | Required | Description |
|---|---|---|---|
| [`eq`](https://supabase.com/docs/reference/swift/eq#examples) | `["kind": "eq", "column": String, "value": Any]` | Both | Matches when the cell equals the value. A null or absent cell never matches, and a null value matches no row, as `= NULL` does in SQL. `is` finds the nulls. |
| [`neq`](https://supabase.com/docs/reference/swift/neq#examples) | `["kind": "neq", "column": String, "value": Any]` | Both | Matches when the cell differs from the value. A null or absent cell never matches, and a null value matches no row, as `<> NULL` does in SQL. |
| [`gt`](https://supabase.com/docs/reference/swift/gt#examples), [`gte`](https://supabase.com/docs/reference/swift/gte#examples), [`lt`](https://supabase.com/docs/reference/swift/lt#examples), [`lte`](https://supabase.com/docs/reference/swift/lte#examples) | `["kind": "gt", "column": String, "value": Any]` | Both | Ordered comparison. Numbers compare numerically, strings compare by their code points, and a null or absent cell matches nothing. |
| [`like`](https://supabase.com/docs/reference/swift/like#examples) | `["kind": "like", "column": String, "pattern": String]` | Both | Case-sensitive pattern match, with `%` for any run of characters and `_` for one character. Only string, number, and boolean cells are matched. |
| [`ilike`](https://supabase.com/docs/reference/swift/ilike#examples) | `["kind": "ilike", "column": String, "pattern": String]` | Both | `like` without case sensitivity. |
| [`is`](https://supabase.com/docs/reference/swift/is#examples) | `["kind": "is", "column": String, "value": Bool?]` | Both | Identity test. `KizunaSyncQuery.is(_:_:)` takes `Bool?`, so the engine only ever sees `true`, `false`, or null: `nil` matches a null cell and an absent column alike, which is the one filter that folds the two together. |
| [`in`](https://supabase.com/docs/reference/swift/in#examples) | `["kind": "in", "column": String, "values": [Any]]` | Both | Matches when the cell equals one member of `values`. A null or absent cell never matches, and a null member matches no row. |
| [`contains`](https://supabase.com/docs/reference/swift/contains#examples) | `["kind": "contains", "column": String, "value": Any]` | Both | Containment, reading the cell as JSON when it holds a JSON array or object as text. An array cell must hold every member of the value, and an object cell must hold every key of the value with a matching value. |
| [`containedBy`](https://supabase.com/docs/reference/swift/using-filters#examples) | `["kind": "containedBy", "column": String, "value": Any]` | Both | Containment the other way round, so the cell must be a subset of the value. |
| [`and`](https://supabase.com/docs/reference/swift/filter#examples) | `["kind": "and", "filters": [[String: Any]]]` | `filters` | Every member must match. A plan with several filters is combined this way. |
| [`or`](https://supabase.com/docs/reference/swift/or#examples) | `["kind": "or", "filters": [[String: Any]]]` | `filters` | At least one member must match. |
| [`not`](https://supabase.com/docs/reference/swift/not#examples) | `["kind": "not", "filter": [String: Any]]` | `filter` | Inverts one filter. A filter that is unknown on a row, such as a comparison with a null cell, stays unknown when inverted, so the row is left out either way. |
| `search` | `["kind": "search", "query": String, "columns": [String]?]` | `query` | Case-insensitive substring match across the named columns, or across every string and number column when `columns` is omitted. An empty query matches every row. |
| [`textSearch`](https://supabase.com/docs/reference/swift/using-filters#examples) | `["kind": "textSearch", "column": String, "query": String, "type": String]` | `column` and `query` | Case-insensitive text match on one column. `KizunaSyncQuery.textSearch(_:_:type:)` takes a `KizunaSyncTextSearchType`, one of `.plain`, `.phrase`, or `.websearch`, and encodes its raw value into the wire `"type"`. `.plain` requires every whitespace-separated token, `.phrase` requires the whole query as a substring, and `.websearch` requires each quoted phrase and each remaining token. Default: `.plain`. |

`KizunaSyncQuery` has a helper for every kind in the table above. [`client.from("todos").select()`](https://supabase.com/docs/reference/swift/select#examples) chains the same names and sends the plan to the kernel.

## Builder operators

The select builder and the write builder also chain the supabase-swift operators below. Each one builds a filter kind the kernel evaluates, or a combination of the kinds above.

| Name | Type | Required | Description |
|---|---|---|---|
| `match(_:pattern:)` | `(String, pattern: String)` | Both | Postgres `~`, wire kind `regexMatch`: the regular expression matches somewhere in the cell's text unless it anchors itself. A backreference, lookaround, or invalid syntax throws `LOCAL_UNSUPPORTED` naming the pattern when the read or write runs. An array or object cell does not match. |
| `imatch(_:pattern:)` | `(String, pattern: String)` | Both | Postgres `~*`, wire kind `regexIMatch`, the same match without case. |
| `match(_:)` | `([String: Any?])` | Yes | `eq` on every key, combined with `and`. An empty dictionary keeps every row on a read; a write refuses it, because it names no rows. |
| `likeAllOf(_:patterns:)`, `likeAnyOf(_:patterns:)` | `(String, patterns: [String])` | Both | `like` against every pattern (`and`) or any pattern (`or`). An empty list matches every row, or no row, on a read. |
| `iLikeAllOf(_:patterns:)`, `iLikeAnyOf(_:patterns:)` | `(String, patterns: [String])` | Both | The same lists with `ilike`. |
| `isDistinct(_:value:)` | `(String, value: Any?)` | `column` | `IS DISTINCT FROM`: true when exactly one of the cell and `value` is null, or both are present and unequal. It never answers unknown, so it keeps the null rows `neq` leaves out. |
| `notIn(_:values:)` | `(String, values: [Any?])` | Both | `not` around `in`. A null or absent cell stays out, and so does every row when `values` holds a null. |
| `overlaps(_:value:)` | `(String, value: [Any?])` | Both | Postgres `&&`: the cell array shares an element with `value`. A string cell holding a JSON array is decoded first, and a cell that is no array does not match. |
| `filter(_:operator:value:)` | `(String, operator: String, value: String)` | All | One PostgREST clause, decoded with the clause grammar [JavaScript: Using filters](../javascript/using-filters.md#parameters) documents: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, or `in`, optionally behind `not.`, with `null`, `true`, `false`, numbers that print back as themselves, and double-quoted text as values. Any other operator, or an unclosed quote, throws `LOCAL_UNSUPPORTED` when the read or write runs. |

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let travel = try await kizunasync.from("todos")
  .select()
  .likeAnyOf("title", patterns: ["%plane%", "%train%"])
  .notIn("id", values: hiddenIds)
  .filter("title", operator: "not.like", value: "draft*")
  .execute()
```

## Ordering, limiting, and cardinality

| Name | Type | Required | Description |
|---|---|---|---|
| `orders` ([`order`](https://supabase.com/docs/reference/swift/order#examples)) | `[[String: Any]]` | No | Sort keys, applied in order. `KizunaSyncQuery.order(_:ascending:nullsFirst:)` builds one. `nullsFirst` may be set per key; it defaults to `true` on a descending key and `false` otherwise. |
| `limit` ([`limit`](https://supabase.com/docs/reference/swift/limit#examples)) | `Int` | No | Rows kept after filtering and sorting. A negative value throws `LOCAL_UNSUPPORTED` at execute rather than being clamped to zero. |
| `offset` (`range(from:to:)`) | `Int` | No | Rows skipped after sorting, before `limit` counts the rest. `range(from:to:)` sets `offset` to `from` and `limit` to `to - from + 1`. Both ends are inclusive and count from zero, so a `to` one below `from` keeps no row. A later `limit(_:)` replaces only the row count. A negative bound, or a `to` further below `from`, throws `LOCAL_UNSUPPORTED` at execute, and so does every later read of that builder. |
| `cardinality` ([`single`](https://supabase.com/docs/reference/swift/single#examples)) | `String` | No | `"many"` answers an array, `"single"` demands exactly one row, and `"maybeSingle"` allows zero or one. Default: `"many"`. |
| `includeDeleted` (`includeDeleted()`) | `Bool` | No | Brings back the rows the table's `softDeleteColumn` marks, which every read leaves out by default. A table with no such column is unaffected. Default: `false`. |
| `count` (`select(_:head:count:)`) | `Bool` | No | Set by any `KizunaSyncCountOption`. The terminals then answer `["rows": …, "count": n]`, where `count` is the rows the filters matched before `offset` and `limit`. `head: true` answers the same dictionary with `rows` set to `NSNull`. Default: no count. |

## Usage

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let plan = KizunaSyncQuery.plan(
  filters: [
    KizunaSyncQuery.eq("done", false),
    KizunaSyncQuery.ilike("title", "%plane%")
  ],
  order: [KizunaSyncQuery.order("title")],
  limit: 20
)
let raw = try await kizunasync.query(table: "todos", plan: plan)
let also = try await kizunasync.from("todos").select().eq("done", false).ilike("title", "%plane%").limit(20).execute()
```

Two filters in one plan mean both must match. Use an explicit `or` to widen it:

```swift
// TodoApp/TodoListView.swift (excerpt)
import Foundation
import KizunaSync

let plan = KizunaSyncQuery.many(filters: [[
  "kind": "or",
  "filters": [
    KizunaSyncQuery.eq("done", false),
    ["kind": "is", "column": "done", "value": NSNull()]
  ]
]])
```

## Unsupported operators

The local evaluator implements the kinds in the tables above and nothing else. A kind outside that list, a malformed operand, or an unusable `like` pattern throws `LOCAL_UNSUPPORTED` rather than being forwarded to the database, because there is no request to forward it on.

The builders also carry the supabase-swift methods that have no local meaning, so a call compiles and the read or write that runs it throws `LOCAL_UNSUPPORTED` naming the reason: `dryRun()` (there is no server transaction to roll back; local writes enter the outbox), `geojson()` (PostGIS output has no local representation), `explain(analyze:verbose:settings:buffers:wal:format:)` (it describes the server query planner), and `setHeader(name:value:)` (a local read or write sends no HTTP request). `retry(enabled:)` returns the builder unchanged, because a local call makes no network attempt.

[Supported query operators](../query-operators.md) lists every postgrest-js method and option, with its status and its Swift name.

## Notes

The names and their meaning follow Supabase [Using filters](https://supabase.com/docs/reference/swift/using-filters#examples), and the modifiers follow [Using modifiers](https://supabase.com/docs/reference/swift/using-modifiers). One local-first difference applies: they run over [local SQLite](https://grokipedia.com/page/SQLite), so they also see writes that have not reached the server. Comparisons and text search behave like their [PostgREST](https://postgrest.org/) counterparts on ordinary data. They are a local reimplementation rather than the [Postgres](https://grokipedia.com/page/PostgreSQL) operator, so collation-sensitive ordering and dictionary-based text search are out of scope.

Filters follow the three-valued logic of SQL. A comparison with a null or absent cell, or with a null value, answers unknown, a third value beside true and false. `not` leaves an unknown filter unknown, `and` and `or` combine unknown members the way Postgres does, and a read returns a row, or a write targets it, only when every filter of the plan is true on that row. `is` never answers unknown, so it is the filter that finds nulls.

## Related reference

- [Fetch data](./fetch-data.md)
- [Write with filters](./apply-where.md)
- [Update data](./update-data.md)
- [Delete data](./delete-data.md)
- [Supported query operators](../query-operators.md)
- [Kotlin: Using filters](../kotlin/using-filters.md)
- [JavaScript: Using filters](../javascript/using-filters.md)
