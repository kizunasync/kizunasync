---
title: Update data
description: Update rows with the write builder or the low-level apply call.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Update data

`from(_:).update(_:transforms:precondition:)` starts a [`KizunaSyncWriteBuilder`](./types.md#writes-and-queries) that patches every row a chained filter matches; `execute()` sends it as one [Write with filters](./apply-where.md) call and answers the primary keys touched. `apply(table:pk:op:...)` is the low-level call that patches one row by primary key directly. Only the columns given are touched; every other column keeps the value the local database holds.

## Examples

### One row, by primary key

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

try await kizunasync.apply(
  table: "todos",
  pk: todoId,
  op: .update,
  columns: ["done": true]
)
```

### Every matching row, with the write builder

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let pks = try await kizunasync.from("todos")
  .update(["done": true])
  .eq("done", false)
  .execute()
```

### Return the updated rows

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let completed = try await kizunasync.from("todos")
  .update(["done": true])
  .eq("done", false)
  .maxAffected(50)
  .select("id, title")
  .execute() as? [[String: Any]]
```

The rows come back as a read reports them after the update. When more than 50 rows match, nothing is written and the call throws `LOCAL_CONSTRAINT`.

### With a precondition

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

try await kizunasync.apply(
  table: "todos",
  pk: todoId,
  op: .update,
  columns: ["title": "works on a plane"],
  precondition: ["done": false]
)
```

The local row changes right away. The server compares `precondition` against the row its own policies let it read, and answers a mismatch with a `PRECONDITION` rejection, which reverts the optimistic value.

### With a transform

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

try await kizunasync.apply(
  table: "todos",
  pk: todoId,
  op: .update,
  columns: [:],
  transforms: ["views": ["op": "increment", "by": 1]]
)
```

## Parameters

### `from(_:).update(_:transforms:precondition:)`

| Name | Type | Required | Description |
|---|---|---|---|
| `columns` | `[String: Any]` | Yes | Columns to assign to every matched row. Unlike `insert`, the builder requires this argument; pass `[:]` for a transform-only update. |
| `transforms` | `[String: Any]?` | No | Field transforms, keyed by column, applied to each matched row on top of the assigned columns. See [Using transforms](./using-transforms.md#supported-transforms). Default: `nil`. |
| `precondition` | `[String: Any]?` | No | Column values the server compares per row before it applies that row's mutation. Default: `nil`. |

The returned `KizunaSyncWriteBuilder` then chains every filter [Using filters](./using-filters.md#supported-filters) documents, except `search` and `textSearch`, which stay read-only and are not on this builder. `execute() async throws -> [String]` sends the write once at least one filter is chained. The builder also takes:

| Name | Type | Required | Description |
|---|---|---|---|
| `maxAffected(_:)` | `(Int) -> KizunaSyncWriteBuilder` | No | The most rows the update may reach. When the filters match more, nothing is written and `execute()` throws `LOCAL_CONSTRAINT` naming the match count and the cap. A value outside 0 through 4294967295 throws `LOCAL_UNSUPPORTED`. |
| `select(_:)` | `(String) -> KizunaSyncWriteSelectBuilder` | No | Returns the rows the update reached, as a read reports them after the write, cut to the comma-separated columns. Default: `"*"`. A relational embed or a rename throws `LOCAL_UNSUPPORTED` before anything is written. The returned builder answers `execute() -> Any` (an array of rows), `single()`, and `maybeSingle()`, and chains `stripNulls()` and `retry(enabled:)`. |
| `single()` / `maybeSingle()` after `select(_:)` | `() async throws -> Any` | No | One row instead of a list. The kernel checks the match count before anything is written: `single()` over zero rows or more than one, or `maybeSingle()` over more than one, writes nothing and throws `LOCAL_CONSTRAINT` with the message a read gives, such as `single() requires exactly one row; got 2`. `maybeSingle()` over no row answers `NSNull`. |

### `apply(table:pk:op:columns:mutationId:transforms:precondition:)`

| Name | Type | Required | Description |
|---|---|---|---|
| `table` | `String` | Yes | Table name, which must be one of the keys of `tables` in [Initializing](./initializing.md#parameters). |
| `pk` | `String` | Yes | Primary key of the row to patch. |
| `op` | `KizunaSyncOp` | Yes | Set to [`.update`](https://supabase.com/docs/reference/swift/update#examples), whose column payload is the one Supabase documents. |
| `columns` | `[String: Any]` | No | Columns to assign, encoded to JSON. A column of the table's [row key](../../sync/sync-rules-and-buckets.md#row-keys) is refused, whatever its value, because the key is immutable. Default: empty. |
| `mutationId` | `String?` | No | Client-side id of this mutation, echoed in the server verdict and in the journal. Default: `nil`, which makes the engine generate a [UUID](https://grokipedia.com/page/Universally_unique_identifier). |
| `transforms` | `[String: Any]?` | No | Field transforms, keyed by column, applied on top of the assigned columns. See [Using transforms](./using-transforms.md#supported-transforms). Default: `nil`. |
| `precondition` | `[String: Any]?` | No | Column values the server compares against the row it can see before it applies the mutation. A mismatch is rejected with reason `PRECONDITION`. Default: `nil`. |

## Returns

`apply` answers `Void`; the write builder's `execute()` answers `[String]`, the primary keys that matched. Both are `async throws` and run the engine call on a dedicated dispatch queue, so neither ever blocks the main actor.

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `table` is not one of the tables the client was created with. |
| `LOCAL_CONSTRAINT` | `columns` or `transforms` name a key column, which the engine refuses before it matches any row, or a transform is malformed: an entry that is not an object, a missing `op`, an `op` outside `increment`, `arrayUnion`, and `arrayRemove`, an `increment` without `by` or with a `by` that is not a signed integer, or an `arrayUnion` or `arrayRemove` without a `values` array. |
| `LOCAL_UNSUPPORTED` | The write builder's `execute()` ran with no filter chained, because an unfiltered update would rewrite the whole table. Also thrown, before anything is written, for a `maxAffected(_:)` cap outside 0 through 4294967295, an embed or a rename in `select(_:)`, and the refusals [Using filters](./using-filters.md#unsupported-operators) lists. |
| `LOCAL_CONSTRAINT` (write builder) | The filters match more rows than `maxAffected(_:)` allows, or a match count breaks `single()` or `maybeSingle()` after `select(_:)`; nothing is written. |
| `JSON` | The engine cannot parse the encoded mutation. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

`apply` throws `KizunaSyncError.engine(code: "LOCAL_UNSUPPORTED", message: "apply requires table and pk")` inside the client when `table` or `pk` is empty, before the engine is reached. A value the platform serializer refuses never reaches the engine: `JSONSerialization` raises inside the client first, so it surfaces as a serialization error rather than an engine code.

## Notes

Supabase documents the column payload and its examples on [`update()`](https://supabase.com/docs/reference/swift/update#examples). This page adds only what local-first changes. The update is optimistic: it commits locally at once, and its verdict arrives with a later [Sync](./sync.md). Two peers that write different columns of one row both keep their value, because the merge is per column. Two peers that write the same column settle by the mode the table is configured with, and the loser is reported as `COLUMN_OVERWRITTEN` on [Subscribe to events](./on.md#returns). [Conflict resolution](../../sync/conflict-resolution.md#column-masks) explains the rule. The queued mutation waits in the outbox until a run delivers it, the path [Offline writes](../../sync/offline-writes.md#1-write-locally) walks through.

An update whose row is missing locally writes the assigned columns as the whole row rather than failing, because the mutation is already queued for the server. That shape does not clear a [tombstone](../../resources/glossary.md#tombstone) a peer's delete left behind, so a deleted row is not revived by a late edit.

The write builder is a convenience over [Write with filters](./apply-where.md#parameters): it targets rows a chained filter matches rather than one primary key, which is the shape a bulk edit like "mark every open todo done" wants.

## Related reference

- [Insert data](./insert-data.md)
- [Delete data](./delete-data.md)
- [Write with filters](./apply-where.md)
- [Using transforms](./using-transforms.md)
- [List rejections](./rejections.md)
- [Kotlin: Update data](../kotlin/update-data.md)
- [JavaScript: Update data](../javascript/update-data.md)
