---
title: Write with filters
description: Apply one write to every local row a filter matches.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Write with filters

`applyWhere` evaluates the filters against the local rows of one table and applies the same write to each row that matches, one mutation per row. It returns the primary keys it touched, so the caller knows the size of the change before the first sync run carries it.

## Examples

### Mark every open todo done

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let pks = try await kizunasync.applyWhere(
  table: "todos",
  op: .update,
  filters: [KizunaSyncQuery.eq("done", false)],
  columns: ["done": true]
)
```

### Delete the todos of one list

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let pks = try await kizunasync.applyWhere(
  table: "todos",
  op: .delete,
  filters: [KizunaSyncQuery.eq("list_id", listId)]
)
```

### Count every matching row up

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let pks = try await kizunasync.applyWhere(
  table: "todos",
  op: .update,
  filters: [KizunaSyncQuery.eq("done", false)],
  transforms: ["views": ["op": "increment", "by": 1]]
)
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `table` | `String` | Yes | Table name, which must be one of the keys of `tables` in [Initializing](./initializing.md#parameters). |
| `op` | `KizunaSyncOp` | Yes | The operation applied to each match. [`.update`](https://supabase.com/docs/reference/swift/update#examples) and [`.delete`](https://supabase.com/docs/reference/swift/delete#examples) are the meaningful values, because every target is a row that already exists. |
| `filters` | `[[String: Any]]` | Yes | Filters that choose the rows, combined with `and` when there is more than one. The shapes are the ones in [Using filters](./using-filters.md#supported-filters). An empty array is refused rather than treated as every row. |
| `columns` | `[String: Any]` | No | Columns assigned to each matched row, encoded to JSON. Default: empty. |
| `transforms` | `[String: Any]?` | No | Field transforms applied to each matched row on top of the assigned columns. See [Using transforms](./using-transforms.md#supported-transforms). Default: `nil`. |
| `precondition` | `[String: Any]?` | No | Column values the server compares per row before it applies that row's mutation. A row whose values moved is rejected with reason `PRECONDITION` while the others apply. Default: `nil`. |

## Returns

`[String]`, the primary keys that matched, in the order the local store returned them. An empty array means nothing matched and nothing was queued.

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `table` is not one of the tables the client was created with. |
| `LOCAL_CONSTRAINT` | A malformed transform on one of the matched rows: an entry that is not an object, a missing `op`, an `op` outside `increment`, `arrayUnion`, and `arrayRemove`, an `increment` without `by` or with a `by` that is not a signed integer, or an `arrayUnion` or `arrayRemove` without a `values` array. |
| `LOCAL_UNSUPPORTED` | `filters` is empty, because an unfiltered update or delete would rewrite the whole table, or a filter the local evaluator refuses, such as an unusable `like` pattern. |
| `JSON` | A filter kind or operand the engine cannot deserialize. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

A value the platform serializer refuses never reaches the engine: `JSONSerialization` raises inside the client first, so it surfaces as a serialization error rather than an engine code.

Every code in the table is the `code` on a thrown `KizunaSyncError.engine(code:message:)`; its `description` reads `"CODE: message"`, but match on `code` rather than parsing the string.

## Notes

The rows are applied one at a time, so a failure part of the way through leaves the earlier rows written and queued. Re-running the same call after the cause is fixed is safe for an update and for a delete, because both are [idempotent](https://grokipedia.com/page/Idempotence) per row.

The filter vocabulary follows Supabase [Using filters](https://supabase.com/docs/reference/swift/using-filters#examples), with the local-first difference that the filters run over local [SQLite](https://grokipedia.com/page/SQLite) rather than reaching [PostgREST](https://postgrest.org/): the match is decided on the device, including rows written while offline. Each matched row becomes its own outbox entry with its own verdict, so a policy that refuses one row does not revert the others. [Offline writes](../../sync/offline-writes.md#3-handle-a-rejection) shows how a rejection surfaces.

A filtered write is a convenience over [Update data](./update-data.md) and [Delete data](./delete-data.md), not a server-side statement. Rows a peer has but this device has not pulled are not matched, so run it after a [Sync](./sync.md) when the set has to be complete.

Filter matching skips a row the table's `softDeleteColumn` already marks. [Fetch data](./fetch-data.md#parameters) applies the same exclusion to a read. A write has no `includeDeleted` option, so reach an already-marked row with the low-level `apply(table:pk:op:...)` by primary key instead.

On such a table, a [`.delete`](https://supabase.com/docs/reference/swift/delete#examples) that does match a row never removes it. It becomes a mutation that stamps the column with one timestamp for the whole call, the same as [Update data](./update-data.md). `SOFT_DELETE_VIOLATION` therefore never reaches this method; the low-level `apply(op: .delete)` is where that code is raised. See [Delete data](./delete-data.md#notes).

## Related reference

- [Using filters](./using-filters.md)
- [Update data](./update-data.md)
- [Delete data](./delete-data.md)
- [Using transforms](./using-transforms.md)
- [Kotlin: Write with filters](../kotlin/apply-where.md)
- [JavaScript: Update data](../javascript/update-data.md)
