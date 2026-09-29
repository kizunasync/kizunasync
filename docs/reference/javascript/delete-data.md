---
title: Delete data
description: Delete the matching local rows and queue a tombstone for each one.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Delete data

`from(table).delete(options?)` returns a write builder. Chain at least one filter to name the rows, then await it. The call signature matches [`.delete()`](https://supabase.com/docs/reference/javascript/delete#parameters) in supabase-js, with an extra options argument for the compare-and-set mask.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function deleteTodo(todoId: string): Promise<void> {
  await kizunasync.from('todos').delete().eq('id', todoId)
}
```

### Only while the row is open

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function deleteOpenTodo(todoId: string): Promise<void> {
  await kizunasync
    .from('todos')
    .delete({ precondition: { done: false } })
    .eq('id', todoId)
}
```

### See a soft-deleted row again

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function loadDeletedTodo(todoId: string) {
  const { data } = await kizunasync
    .from('todos')
    .select()
    .eq('id', todoId)
    .includeDeleted()

  return data
}
```

A table whose config sets `softDelete` turns the call above into that shape on its own: `delete()` stamps the configured column rather than writing a tombstone, and the row leaves the default read until `includeDeleted()` asks for it back.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `options.precondition` | `TColumnValues` | No | A compare-and-set mask carried on the wire with every mutation this call queues. The server compares it against the stored row and rejects the mutation with reason `PRECONDITION` when it does not hold. It is not checked locally, so the row disappears optimistically either way. Default: none. |

Filters are chained on the returned builder and are listed on [Using filters](./using-filters.md#parameters). At least one is required, and the builder carries the same filter set as the read builder minus the two search operators.

[`.includeDeleted()`](./using-filters.md#parameters) targets a row a soft-delete column already marked, the same way it does on a read. Without it, a row the column marks is no more a write target than it is a read result, so a second `delete()` against an already soft-deleted row matches nothing.

## Returns

`Promise<IWriteResult>`, settled once every matched row has been applied.

| Name | Type | Required | Description |
|---|---|---|---|
| `data` | `null` | — | Always `null`. |
| `error` | `null` | — | Always `null`. A refused delete throws instead of returning an error envelope. |

### What the delete changes

| Name | Type | Required | Description |
|---|---|---|---|
| Local rows | — | — | On a table with no `softDelete` column, removed immediately, so a local read stops returning them before any sync runs. On a `softDelete` table, kept, stamped with the engine's own clock, and hidden from the default read and from write targeting until [`includeDeleted()`](./using-filters.md#parameters) asks for them back. |
| Local tombstones | — | — | One shadow entry per removed key on a hard delete, which keeps a later write from reviving the row before a verdict reconciles it. A `softDelete` table writes no tombstone: the row stays a row. |
| Outbox entries | `TOutboxEntry[]` | — | One entry per matched row: a delete operation with an empty column map and that row's pre-image on a hard delete, or an update stamping the soft-delete column on a `softDelete` table. Either way a dead letter restores the pre-image. |
| `LOCAL_CHANGED` and `QUEUE_DEPTH` | `TEngineEvent` | — | Raised once per matched row, after that row's transaction commits. |

The kernel resolves every row the filters match. It applies the delete to each of them in one `apply_where` call, or the stamping update on a `softDelete` table. A broad filter therefore queues one entry per row it matches. A write targeted by `id` matches a row a pull delivered. The `id` may stand alone, sit alongside another filter, come from [`.in('id', …)`](./using-filters.md#parameters), or sit inside [`.or('id.eq.…')`](./using-filters.md#parameters).

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | The table is absent from [Define config](./define-config.md#parameters). |
| `LOCAL_UNSUPPORTED` | The builder was awaited with no filter, which would empty the table, refused when the write executes. Raised naming the table when the table's `sync` is `'pull-only'`. Also raised by the operators [Using filters](./using-filters.md#unsupported-operators) lists. `delete(options)` throws naming the option, synchronously, when `options.count` is set: this method returns no count. Also raised by the methods [Fetch data](./fetch-data.md#errors) lists, which this builder carries too, including a chained [`.select()`](https://supabase.com/docs/reference/javascript/select#parameters) to return the deleted rows. |

`SOFT_DELETE_VIOLATION` is not reachable from this method: it survives only on the low-level `apply` port with `op: 'delete'`, which the builder never sends for a `softDelete` table.

## Notes

The removal stays local until a run delivers it. [Offline writes](../../sync/offline-writes.md#1-write-locally) describes that optimistic path. [Row Level Security](https://grokipedia.com/page/Row-level_security) runs on the server at push time. A refusal comes back as a verdict rather than as a thrown error. [List rejections](./rejections.md) holds it after the fact. [How Kizuna works](../../getting-started/how-kizuna-works.md#2-local-writes-enter-a-durable-outbox) places the queued entry in the whole cycle.

A hard delete outranks a concurrent edit. A peer that edited the same row while offline has its mutation rejected with reason `DELETE_WINS` rather than resurrecting the row, which [Conflict resolution](../../sync/conflict-resolution.md#deletes) covers in full. A `softDelete` table has no tombstone to trigger that rule: the stamping update takes the table's ordinary conflict mode, and a later accepted update can reverse it.

Peers drop the row on their next pull, so the wait is a sync run rather than a request. A tombstone is retained for the window the table's [`tombstone_ttl_days`](../../cli/configuration.md#kizunasync_config) column sets, and a client whose cursor is older than that window re-hydrates from the beginning instead of receiving the tombstone.

## Related reference

- [Insert data](./insert-data.md)
- [Update data](./update-data.md)
- [Using filters](./using-filters.md)
- [Define config](./define-config.md)
- [List rejections](./rejections.md)
- [Swift: Delete data](../swift/delete-data.md)
- [Kotlin: Delete data](../kotlin/delete-data.md)
