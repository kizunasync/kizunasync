---
title: Supported query operators
description: Every postgrest-js method and option, with its status in the JavaScript, Swift, and Kotlin app clients and the reason behind each refusal.
status: alpha
docType: reference
audience: app-developer
---

# Supported query operators

The app client's `from(table)` builder speaks the query language of supabase-js, and it answers every call from the device's local database. This page lists each method of postgrest-js 2.117.2, the query builder inside supabase-js, with its status in the JavaScript, Swift, and Kotlin app clients.

A supported method keeps the meaning Supabase documents for it. The Rust kernel evaluates it over the rows earlier pulls delivered and the writes this device made, with the local differences each method's reference page lists, and a write applies locally before it waits in the [outbox](../resources/glossary.md#outbox) for the next push. An unsupported method throws `LOCAL_UNSUPPORTED` with the reason in its message, and no call falls back to the network.

## Methods

In the three platform columns, Yes means the client runs the method locally. No means the method exists and throws `LOCAL_UNSUPPORTED`: JavaScript throws when you call it, and Swift and Kotlin throw when the chain runs. A dash means the client has no method of that name. Notes give the Swift or Kotlin name where it differs, and for a refused method the reason its error message carries. Each supported method links to its JavaScript reference entry.

| Method | JavaScript | Swift | Kotlin | Notes |
|---|---|---|---|---|
| [`abortSignal`](./javascript/fetch-data.md#parameters) | Yes | — | — | Reads only. A read whose signal aborts before it settles rejects with the signal's reason. An update or a delete refuses it, because a local write is applied at once and cannot be aborted. |
| [`containedBy`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Containment with the two sides swapped, over JSON-string, array, and scalar cells. |
| [`contains`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Local containment over JSON-string, array, and scalar cells, standing in for the Postgres `@>` operator. |
| [`csv`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | Reads only. Returns the rows as CSV text. An update or a delete refuses it, because csv() formats a read, not a write. |
| [`delete`](./javascript/delete-data.md#parameters) | Yes | Yes | Yes | Needs a filter that names rows. On a table with a soft-delete column it stamps that column instead of removing the row. A `pull-only` table refuses it. |
| [`eq`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | A null cell or a `null` argument never matches, as `= NULL` in SQL. |
| `explain` | No | No | No | `LOCAL_UNSUPPORTED`: EXPLAIN describes the server query planner. |
| [`filter`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | One `column.operator.value` clause in the grammar `or` accepts, the `not.` prefix included. |
| [`from`](./javascript/initializing.md#returns) | Yes | Yes | Yes | Opens the builder of one synced table. A table missing from the client's config throws `UNKNOWN_TABLE`. |
| `geojson` | No | No | No | `LOCAL_UNSUPPORTED`: PostGIS output has no local representation. |
| `getOpenApiSpec` | No | — | — | `LOCAL_UNSUPPORTED`: the OpenAPI spec is server metadata. |
| [`gt`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Greater than. |
| [`gte`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Greater than or equal. |
| [`ilike`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | The `like` grammar, case-insensitive. |
| [`ilikeAllOf`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Every pattern must match, case-insensitive. Swift `iLikeAllOf`, Kotlin `ilikeAll`. |
| [`ilikeAnyOf`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Any pattern may match, case-insensitive. Swift `iLikeAnyOf`, Kotlin `ilikeAny`. |
| [`in`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Membership in a list. A null cell never matches. Kotlin `inValues`. |
| [`insert`](./javascript/insert-data.md#parameters) | Yes | Yes | Yes | Writes the row locally and queues it for the next push. JavaScript chains `select()` after it to read the row back, while the Swift and Kotlin insert returns nothing. A `pull-only` table refuses it. |
| [`is`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | `null`, `true`, or `false` only. Kotlin `isValue`. |
| [`isDistinct`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | `IS DISTINCT FROM`, which treats null as a value. |
| [`like`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | SQL `LIKE` patterns with `%` and `_`, anchored at both ends. |
| [`likeAllOf`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Every pattern must match. Kotlin `likeAll`. |
| [`likeAnyOf`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Any pattern may match. Kotlin `likeAny`. |
| [`limit`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | Keeps the first rows after the sort. |
| [`lt`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Less than. |
| [`lte`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Less than or equal. |
| [`match`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | `eq` on every key, combined with AND. A write refuses an empty object, because it names no rows. |
| [`maxAffected`](./javascript/update-data.md#parameters) | Yes | Yes | Yes | Updates and deletes. When the filters match more rows than the cap, nothing is written and the call throws `LOCAL_CONSTRAINT`. A read refuses it, because maxAffected() caps an update or a delete, not a read. |
| [`maybeSingle`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | Zero rows or one. More than one throws `LOCAL_CONSTRAINT`. |
| [`neq`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Inequality. A null cell never matches. |
| [`not`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Negates one clause. Swift and Kotlin take a filter node instead of a column, an operator, and a value. |
| [`notIn`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | SQL `NOT IN`, with its null handling. |
| [`or`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | JavaScript decodes the PostgREST clause string on the device and refuses a nested `or` or `and` inside it. Swift and Kotlin take a list of filter nodes. |
| [`order`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | Nulls sort last ascending and first descending, as in Postgres, unless `nullsFirst` says otherwise. |
| [`overlaps`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Array overlap. A range literal such as `'[1,5)'` throws `LOCAL_UNSUPPORTED`, because Postgres range types have no local representation. |
| [`overrideTypes`](./javascript/fetch-data.md#parameters) | Yes | — | — | Changes the static type only. An update or a delete refuses it until `select()` follows, because a write without select() has no rows to type. |
| [`range`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | Reads only. Keeps an inclusive window of rows after the sort. An update or a delete refuses it, because a write has no row window to page. |
| `rangeAdjacent` | No | — | — | `LOCAL_UNSUPPORTED`: Postgres range types have no local representation. |
| `rangeGt` | No | — | — | `LOCAL_UNSUPPORTED`: Postgres range types have no local representation. |
| `rangeGte` | No | — | — | `LOCAL_UNSUPPORTED`: Postgres range types have no local representation. |
| `rangeLt` | No | — | — | `LOCAL_UNSUPPORTED`: Postgres range types have no local representation. |
| `rangeLte` | No | — | — | `LOCAL_UNSUPPORTED`: Postgres range types have no local representation. |
| [`regexIMatch`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Postgres `~*`, the case-insensitive `regexMatch`. Swift `imatch`. |
| [`regexMatch`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Postgres `~`, evaluated by the Rust `regex` crate. A pattern it cannot compile, such as one with a backreference or a lookaround, throws `LOCAL_UNSUPPORTED` naming the pattern. Swift `match(_:pattern:)`. |
| [`retry`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | No effect, because a local read or write makes no network attempt to retry. |
| [`returns`](./javascript/fetch-data.md#parameters) | Yes | — | — | Changes the static type only. An update or a delete refuses it until `select()` follows, because a write without select() has no rows to type. |
| `rollback` | No | No | No | `LOCAL_UNSUPPORTED`: there is no server transaction to roll back; local writes enter the outbox. Swift and Kotlin `dryRun`. |
| `rpc` | No | — | — | `LOCAL_UNSUPPORTED`: rpc() runs a server function; call it through supabase-js when online. JavaScript refuses it on the app client and after `from()`. |
| `schema` | No | — | — | `LOCAL_UNSUPPORTED`: synced tables are addressed by name. |
| [`select`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | A column projection, applied when the read runs. After an update or a delete it returns the rows the write reached. The options below cover counts, embeds, and renames. |
| `setHeader` | No | No | — | `LOCAL_UNSUPPORTED`: a local read or write sends no HTTP request. |
| [`single`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | Exactly one row. Zero rows or more than one throw `LOCAL_CONSTRAINT`. |
| [`stripNulls`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | Drops the null-valued keys of each row. An update or a delete refuses it until `select()` follows, because a write without select() has no rows to strip. |
| [`textSearch`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Reads only. A local stand-in for full-text search over one column, with the `plain`, `phrase`, and `websearch` types. |
| [`throwOnError`](./javascript/fetch-data.md#parameters) | Yes | — | — | No effect, because a local read or write already throws on error. |
| [`update`](./javascript/update-data.md#parameters) | Yes | Yes | Yes | Needs a filter that names rows, and never changes a column of the [row key](../sync/sync-rules-and-buckets.md#row-keys). A `pull-only` table refuses it. |
| `upsert` | No | — | — | `LOCAL_UNSUPPORTED`: an offline device cannot know whether the server holds the row; use insert or update. |

## Options

The same columns apply to the options postgrest-js methods take.

| Option | JavaScript | Swift | Kotlin | Notes |
|---|---|---|---|---|
| `select` `count` | Yes | Yes | Yes | Returns how many rows the filters match before `range` and `limit`. The kernel counts every match, so `exact`, `planned`, and `estimated` all return the exact local count. |
| `select` `head` | Yes | Yes | Yes | Returns the count without the rows. |
| `insert` `count` | Yes | — | — | Returns `1`, the one row written. |
| `update` and `delete` `count` | Yes | — | — | Returns the number of rows the write reached. |
| `insert` `defaultToNull` | No | — | — | `LOCAL_UNSUPPORTED`: the push sends only the columns written and the database fills defaults. |
| `upsert` `onConflict` and `ignoreDuplicates` | No | — | — | `LOCAL_UNSUPPORTED` on `insert` as well: it belongs to upsert(), which the local store does not offer. |
| `referencedTable` and its alias `foreignTable` | No | — | — | `LOCAL_UNSUPPORTED` on `order`, `limit`, `range`, `or`, and `textSearch`: the local store holds each synced table without foreign-key joins; read related rows with a second query. |
| Relational embeds in `select` | No | No | No | `LOCAL_UNSUPPORTED`: relational embeds are not supported locally; the local store holds each synced table without foreign-key joins, so read related rows with a second query. |
| Renames in `select` | No | No | No | `LOCAL_UNSUPPORTED`: renames are not supported locally. |

## Kizuna additions

Three methods have no postgrest-js counterpart.

| Addition | JavaScript | Swift | Kotlin | Notes |
|---|---|---|---|---|
| [`and`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Every clause must match. JavaScript takes the clause string `or` takes, and Swift and Kotlin take a list of filter nodes. |
| [`search`](./javascript/using-filters.md#parameters) | Yes | Yes | Yes | Reads only. A case-insensitive substring search across every string and number column, or across the columns you name. |
| [`includeDeleted`](./javascript/fetch-data.md#parameters) | Yes | Yes | Yes | Keeps the rows a table's soft-delete column marks. JavaScript offers it on reads and writes, and Swift and Kotlin on reads. |

## Related reference

- [JavaScript: Fetch data](./javascript/fetch-data.md): the read builder, its modifiers, and its errors.
- [JavaScript: Using filters](./javascript/using-filters.md): every filter and the clause grammar.
- [Swift: Using filters](./swift/using-filters.md): the filter nodes and builder operators in Swift.
- [Kotlin: Using filters](./kotlin/using-filters.md): the filter nodes and builder operators in Kotlin.
- [Offline writes](../sync/offline-writes.md): what happens to a write after the builder applies it.
