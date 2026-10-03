---
title: Using filters
description: The filter, order, and cardinality vocabulary the local query evaluator implements.
status: alpha
docType: reference
library: kotlin
pageKind: guide
audience: app-developer
---

# Kotlin: Using filters

A filter is a `JSONObject` with a `kind` key and the operands that kind needs. `KizunaSyncQuery` builds the common ones; any other kind is written out as a `JSONObject` and passed the same way. Filters are used by [Fetch data](./fetch-data.md#parameters) to select rows and by [Write with filters](./apply-where.md#parameters) to choose the rows a write targets.

## Supported filters

| Name | Type | Required | Description |
|---|---|---|---|
| [`eq`](https://supabase.com/docs/reference/kotlin/eq#parameters) | `{"kind": "eq", "column": String, "value": Any}` | Both | Matches when the cell equals the value. A null or absent cell never matches, and a null value matches no row, as `= NULL` does in SQL. `is` finds the nulls. |
| [`neq`](https://supabase.com/docs/reference/kotlin/neq#parameters) | `{"kind": "neq", "column": String, "value": Any}` | Both | Matches when the cell differs from the value. A null or absent cell never matches, and a null value matches no row, as `<> NULL` does in SQL. |
| [`gt`](https://supabase.com/docs/reference/kotlin/gt#parameters), [`gte`](https://supabase.com/docs/reference/kotlin/gte#parameters), [`lt`](https://supabase.com/docs/reference/kotlin/lt#parameters), [`lte`](https://supabase.com/docs/reference/kotlin/lte#parameters) | `{"kind": "gt", "column": String, "value": Any}` | Both | Ordered comparison. Numbers compare numerically, strings compare by their code points, and a null or absent cell matches nothing. |
| [`like`](https://supabase.com/docs/reference/kotlin/like#parameters) | `{"kind": "like", "column": String, "pattern": String}` | Both | Case-sensitive pattern match, with `%` for any run of characters and `_` for one character. Only string, number, and boolean cells are matched. |
| [`ilike`](https://supabase.com/docs/reference/kotlin/ilike#parameters) | `{"kind": "ilike", "column": String, "pattern": String}` | Both | `like` without case sensitivity. |
| [`is`](https://supabase.com/docs/reference/kotlin/is#parameters) | `{"kind": "is", "column": String, "value": Boolean?}` | Both | Identity test. `KizunaSyncQuery.isValue(column, value)` takes `Boolean?`, so the engine only ever sees `true`, `false`, or null: `null` matches a null cell and an absent column alike, which is the one filter that folds the two together. |
| [`in`](https://supabase.com/docs/reference/kotlin/in#parameters) | `{"kind": "in", "column": String, "values": Array}` | Both | Matches when the cell equals one member of `values`. A null or absent cell never matches, and a null member matches no row. |
| [`contains`](https://supabase.com/docs/reference/kotlin/contains#parameters) | `{"kind": "contains", "column": String, "value": Any}` | Both | Containment, reading the cell as JSON when it holds a JSON array or object as text. An array cell must hold every member of the value, and an object cell must hold every key of the value with a matching value. |
| [`containedBy`](https://supabase.com/docs/reference/kotlin/using-filters#examples) | `{"kind": "containedBy", "column": String, "value": Any}` | Both | Containment the other way round, so the cell must be a subset of the value. |
| [`and`](https://supabase.com/docs/reference/kotlin/filter#parameters) | `{"kind": "and", "filters": Array}` | `filters` | Every member must match. A plan with several filters is combined this way. |
| [`or`](https://supabase.com/docs/reference/kotlin/or#parameters) | `{"kind": "or", "filters": Array}` | `filters` | At least one member must match. |
| [`not`](https://supabase.com/docs/reference/kotlin/not#parameters) | `{"kind": "not", "filter": Object}` | `filter` | Inverts one filter. A filter that is unknown on a row, such as a comparison with a null cell, stays unknown when inverted, so the row is left out either way. |
| `search` | `{"kind": "search", "query": String, "columns": Array?}` | `query` | Case-insensitive substring match across the named columns, or across every string and number column when `columns` is omitted. An empty query matches every row. |
| [`textSearch`](https://supabase.com/docs/reference/kotlin/textsearch#parameters) | `{"kind": "textSearch", "column": String, "query": String, "type": String}` | `column` and `query` | Case-insensitive text match on one column. `KizunaSyncQuery.textSearch(column, query, type)` takes a `KizunaSyncTextSearchType`, one of `Plain`, `Phrase`, or `Websearch`, and encodes its `wire` value into the wire `"type"`. `Plain` requires every whitespace-separated token, `Phrase` requires the whole query as a substring, and `Websearch` requires each quoted phrase and each remaining token. Default: `Plain`. |

`KizunaSyncQuery` has a helper for every kind in the table above. [`client.from("todos").select()`](https://supabase.com/docs/reference/kotlin/select#parameters) chains the same names and sends the plan to the kernel.

## Builder operators

The select builder and the write builder also chain the supabase-kt operators below. Each one builds a filter kind the kernel evaluates, or a combination of the kinds above.

| Name | Type | Required | Description |
|---|---|---|---|
| `regexMatch(column, pattern)` | `(String, String)` | Both | Postgres `~`: the regular expression matches somewhere in the cell's text unless it anchors itself. A backreference, lookaround, or invalid syntax throws `LOCAL_UNSUPPORTED` naming the pattern when the read or write runs. An array or object cell does not match. |
| `regexIMatch(column, pattern)` | `(String, String)` | Both | Postgres `~*`, the same match without case. |
| `match(query)` | `(Map<String, Any?>)` | Yes | `eq` on every key, combined with `and`. An empty map keeps every row on a read; a write refuses it, because it names no rows. |
| `likeAll(column, patterns)`, `likeAny(column, patterns)` | `(String, List<String>)` | Both | `like` against every pattern (`and`) or any pattern (`or`). An empty list matches every row, or no row, on a read. |
| `ilikeAll(column, patterns)`, `ilikeAny(column, patterns)` | `(String, List<String>)` | Both | The same lists with `ilike`. |
| `isDistinct(column, value)` | `(String, Any?)` | `column` | `IS DISTINCT FROM`: true when exactly one of the cell and `value` is null, or both are present and unequal. It never answers unknown, so it keeps the null rows `neq` leaves out. supabase-kt has no such method; the name matches JavaScript and Swift. |
| `notIn(column, values)` | `(String, List<Any?>)` | Both | `not` around `inValues`. A null or absent cell stays out, and so does every row when `values` holds a null. |
| `overlaps(column, values)` | `(String, List<Any?>)` | Both | Postgres `&&`: the cell array shares an element with `values`. A string cell holding a JSON array is decoded first, and a cell that is no array does not match. |
| `filter(column, operator, value)` | `(String, String, String)` | All | One PostgREST clause, decoded with the clause grammar [JavaScript: Using filters](../javascript/using-filters.md#parameters) documents: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, or `in`, optionally behind `not.`, with `null`, `true`, `false`, numbers that print back as themselves, and double-quoted text as values. Any other operator, or an unclosed quote, throws `LOCAL_UNSUPPORTED` when the read or write runs. |

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val travel =
    kizunasync.from("todos")
        .select()
        .likeAny("title", listOf("%plane%", "%train%"))
        .notIn("id", hiddenIds)
        .filter("title", "not.like", "draft*")
        .execute()
```

## Ordering, limiting, and cardinality

| Name | Type | Required | Description |
|---|---|---|---|
| `orders` ([`order`](https://supabase.com/docs/reference/kotlin/order#parameters)) | `JSONArray` | No | Sort keys, applied in order. `KizunaSyncQuery.order(column, ascending, nullsFirst)` builds one. `nullsFirst` may be set per key; it defaults to `true` on a descending key and `false` otherwise. |
| `limit` ([`limit`](https://supabase.com/docs/reference/kotlin/limit#parameters)) | `Int` | No | Rows kept after filtering and sorting. A negative value throws `LOCAL_UNSUPPORTED` at execute rather than being clamped to zero. |
| `offset` (`range(from, to)`) | `Int` | No | Rows skipped after sorting, before `limit` counts the rest. `range(from, to)` sets `offset` to `from` and `limit` to `to - from + 1`. Both ends are inclusive and count from zero, so a `to` one below `from` keeps no row. A later `limit(count)` replaces only the row count. A negative bound, or a `to` further below `from`, throws `LOCAL_UNSUPPORTED` at execute, and so does every later read of that builder. |
| `cardinality` ([`single`](https://supabase.com/docs/reference/kotlin/single#examples)) | `String` | No | `"many"` answers a `JSONArray`, `"single"` demands exactly one row, and `"maybeSingle"` allows zero or one. Default: `"many"`. |
| `includeDeleted` (`includeDeleted()`) | `Boolean` | No | Brings back the rows the table's `softDeleteColumn` marks, which every read leaves out by default. A table with no such column is unaffected. Default: `false`. |
| `count` (`select(columns, head, count)`) | `Boolean` | No | Set by any `KizunaSyncCount`. The terminals then answer a `JSONObject` with `rows` and `count`, where `count` is the rows the filters matched before `offset` and `limit`. `head = true` answers the same object with `rows` set to `JSONObject.NULL`. Default: no count. |

## Usage

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncQuery
import org.json.JSONArray
import org.json.JSONObject

val plan = KizunaSyncQuery.plan(
    filters = JSONArray()
        .put(KizunaSyncQuery.eq("done", false))
        .put(KizunaSyncQuery.ilike("title", "%plane%")),
    order = JSONArray().put(KizunaSyncQuery.order("title")),
    limit = 20,
)
val raw = kizunasync.query(table = "todos", plan = plan)
val also = kizunasync.from("todos").select().eq("done", false).ilike("title", "%plane%").limit(20).execute()
```

Two filters in one plan mean both must match. Use an explicit `or` to widen it:

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncQuery
import org.json.JSONArray
import org.json.JSONObject

val anyDoneState = JSONObject()
    .put("kind", "or")
    .put(
        "filters",
        JSONArray()
            .put(KizunaSyncQuery.eq("done", false))
            .put(JSONObject().put("kind", "is").put("column", "done").put("value", JSONObject.NULL)),
    )
val plan = KizunaSyncQuery.many(anyDoneState)
```

## Unsupported operators

The local evaluator implements the kinds in the tables above and nothing else. A kind outside that list, a malformed operand, or an unusable `like` pattern throws `LOCAL_UNSUPPORTED` rather than being forwarded to the database, because there is no request to forward it on.

The builders also carry the supabase-kt methods that have no local meaning, so a call compiles and the read or write that runs it throws `LOCAL_UNSUPPORTED` naming the reason: `dryRun()` (there is no server transaction to roll back; local writes enter the outbox), `geojson()` (PostGIS output has no local representation), and `explain(analyze, verbose, settings, buffers, wal, format)` (it describes the server query planner). `retry(enabled)` returns the builder unchanged, because a local call makes no network attempt.

[Supported query operators](../query-operators.md) lists every postgrest-js method and option, with its status and its Kotlin name.

## Notes

The names and their meaning follow Supabase [Using filters](https://supabase.com/docs/reference/kotlin/using-filters#examples), and the modifiers follow [Using modifiers](https://supabase.com/docs/reference/kotlin/using-modifiers). One local-first difference applies: they run over [local SQLite](https://grokipedia.com/page/SQLite), so they also see writes that have not reached the server. Comparisons and text search behave like their [PostgREST](https://postgrest.org/) counterparts on ordinary data. They are a local reimplementation rather than the [Postgres](https://grokipedia.com/page/PostgreSQL) operator, so collation-sensitive ordering and dictionary-based text search are out of scope.

Filters follow the three-valued logic of SQL. A comparison with a null or absent cell, or with a null value, answers unknown, a third value beside true and false. `not` leaves an unknown filter unknown, `and` and `or` combine unknown members the way Postgres does, and a read returns a row, or a write targets it, only when every filter of the plan is true on that row. `is` never answers unknown, so it is the filter that finds nulls.

## Related reference

- [Fetch data](./fetch-data.md)
- [Write with filters](./apply-where.md)
- [Update data](./update-data.md)
- [Delete data](./delete-data.md)
- [Supported query operators](../query-operators.md)
- [Swift: Using filters](../swift/using-filters.md)
- [JavaScript: Using filters](../javascript/using-filters.md)
