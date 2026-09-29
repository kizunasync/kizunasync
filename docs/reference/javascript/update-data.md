---
title: Update data
description: Update the matching local rows and queue one mutation per row.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Update data

`from(table).update(values, options?)` returns a write builder. Chain at least one filter to name the rows, then await it. The call signature matches [`.update()`](https://supabase.com/docs/reference/javascript/update#parameters) in supabase-js, with an extra options argument for the compare-and-set mask.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function completeTodo(todoId: string): Promise<void> {
  await kizunasync
    .from('todos')
    .update({ done: true })
    .eq('id', todoId)
}
```

### With a precondition

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function renameOpenTodo(todoId: string): Promise<void> {
  await kizunasync
    .from('todos')
    .update({ title: 'works on a plane' }, { precondition: { done: false } })
    .eq('id', todoId)
}
```

### With a field transform

```ts
// src/todo-list.ts
import { increment } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export async function countView(todoId: string): Promise<void> {
  await kizunasync
    .from('todos')
    .update({ views: increment(1) })
    .eq('id', todoId)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `values` | `TUpdateValues` | Yes | One record mapping each column to either a plain value or a transform sentinel from [Using transforms](./using-transforms.md). |
| `options.precondition` | `TColumnValues` | No | A compare-and-set mask carried on the wire with every mutation this call queues. The server compares it against the stored row and rejects the mutation with reason `PRECONDITION` when it does not hold. It is not checked locally, so the optimistic row applies either way. Default: none. |

Filters are chained on the returned builder and are listed on [Using filters](./using-filters.md#parameters). At least one is required, and the builder carries the same filter set as the read builder minus the two search operators, plus [`.includeDeleted()`](./using-filters.md#parameters) to target a row a `softDelete` column already marked.

## Returns

`Promise<IWriteResult>`, settled once every matched row has been applied.

| Name | Type | Required | Description |
|---|---|---|---|
| `data` | `null` | — | Always `null`. The updated rows are not echoed back; read them with [Fetch data](./fetch-data.md). |
| `error` | `null` | — | Always `null`. A refused update throws instead of returning an error envelope. |

### What the update changes

| Name | Type | Required | Description |
|---|---|---|---|
| Local rows | `TLocalRow[]` | — | One row per filter match, committed immediately. A transform is applied to the stored value on top of the assignment pass, so the optimistic row shows the new total. |
| Outbox entries | `TOutboxEntry[]` | — | One entry per matched row, each carrying its own pre-image so a dead letter reverts that row to the value it held before this call. |
| `LOCAL_CHANGED` and `QUEUE_DEPTH` | `TEngineEvent` | — | Raised once per matched row, after that row's transaction commits. |

The kernel resolves every row the filters match and applies the mutation to each in one `apply_where` call, so a broad filter queues one mutation per row it matched. A write targeted by `id`, alone or alongside another filter, by [`.in('id', …)`](./using-filters.md#parameters), or inside [`.or('id.eq.…')`](./using-filters.md#parameters), matches a row a pull delivered.

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | The table is absent from [Define config](./define-config.md#parameters). |
| `LOCAL_UNSUPPORTED` | The builder was awaited with no filter, which would rewrite every row of the table, refused when the write executes. Raised naming the table when the table's `sync` is `'pull-only'`. Also raised by the operators [Using filters](./using-filters.md#unsupported-operators) lists. `update(values, options)` throws naming the option, synchronously, when `options.count` is set: this method returns no count. Also raised by the methods [Fetch data](./fetch-data.md#errors) lists, which this builder carries too, including a chained [`.select()`](https://supabase.com/docs/reference/javascript/select#parameters) to return the updated rows. |
| `LOCAL_CONSTRAINT` | `values.id` differs from the row's primary key; an `id` equal to the pk is written like any other column. A transform assigned to `id` throws from the builder with the message `update() cannot transform "id": the primary key is immutable`. Also raised when a transform argument is not a signed integer. |

## Notes

Every matched row applies locally first. It then waits in the outbox until a run delivers it. That is the optimistic path [Offline writes](../../sync/offline-writes.md#1-write-locally) describes. [Row Level Security](https://grokipedia.com/page/Row-level_security) runs on the server at push time, under the [update policies](https://supabase.com/docs/guides/database/postgres/row-level-security#update-policies) the project declares. A refusal arrives as a verdict rather than a thrown error. [List rejections](./rejections.md) holds it after the fact. [How Kizuna works](../../getting-started/how-kizuna-works.md#3-push-returns-a-verdict-for-each-mutation) places the verdict in the whole cycle.

A precondition is the safer form of read-then-write when two devices may edit the same row. [Validate writes](../../sync/validate-writes.md) shows the same rule written as a server-side check.

Two clients editing different columns of one row both keep their edits, because resolution is per column. [Conflict resolution](../../sync/conflict-resolution.md) covers which write wins when they touch the same column.

A row a `softDelete` column marks is no more a write target than it is a read result: an `update()` whose filters would otherwise match it skips the row unless [`.includeDeleted()`](./using-filters.md#parameters) is chained.

## Related reference

- [Insert data](./insert-data.md)
- [Delete data](./delete-data.md)
- [Using filters](./using-filters.md)
- [Using transforms](./using-transforms.md)
- [List rejections](./rejections.md)
- [Swift: Update data](../swift/update-data.md)
- [Kotlin: Update data](../kotlin/update-data.md)
