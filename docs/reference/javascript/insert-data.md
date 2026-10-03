---
title: Insert data
description: Write one new row to the local database and queue it for the next push.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Insert data

`from(table).insert(values)` writes one row to the local database and enqueues the matching outbox entry in the same transaction. The call signature matches [`.insert()`](https://supabase.com/docs/reference/javascript/insert#parameters) in supabase-js for a single row.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const { error } = await kizunasync.from('todos').insert({ title: 'works on a plane', done: false })
```

The row leaves out `user_id`, the column of the table's `byOwner` bucket, and the engine fills it with the signed-in user before the row is written.

### Supply the primary key

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const todoId = crypto.randomUUID()

await kizunasync.from('todos').insert({ id: todoId, title: 'works on a plane', done: false })
```

Supply `id` when the app needs the value before the write settles, for example to attach a file to the new row.

### Return the inserted row

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function addTodo(title: string) {
  const { data } = await kizunasync.from('todos').insert({ title, done: false }).select('id, title').single()

  return data
}
```

The row is read back from the local database by its `id` once the insert commits, so it carries the owner column the engine filled.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `values` | `TColumnValues` | Yes | The column map for the new row. Values are `string`, `number`, `boolean`, `null`, or a scalar array (`string[]`, `number[]`, or `boolean[]`). Every column the server needs must be present, because no default is applied locally, apart from `id` and the owner column below. |
| `values.id` | `string \| number` | No | The primary key of a table keyed by `id` alone, a uuid string or an integer as the column's type requires. Default: a uuid minted from the `uuid` option on [Initializing](./initializing.md#parameters), which is `crypto.randomUUID()` unless the caller replaced it. A table whose [row key](../../sync/sync-rules-and-buckets.md#row-keys) is any other column list mints nothing, so the row names every key column with a string or an integer. A uuid-shaped key value is stored and pushed in lowercase, whatever case you pass. |
| `values.<owner column>` | `string` | No | The column of the table's [`byOwner`](./define-config.md#parameters) bucket, `user_id` in these examples. A value the row carries, `null` included, is kept as written. Default: the user the local database belongs to, which the engine fills in when that user is known; before any session has reached the client, the row is written without it and the server's column default decides. |
| `options.count` | `'exact' \| 'planned' \| 'estimated'` | No | Returns `1` in `count`, the one row written. Default: no count, and `count` is `null`. |

The returned promise carries [`.select(columns?)`](https://supabase.com/docs/reference/javascript/select#parameters), which reads the inserted row back by its key columns and cuts it to `columns`, then [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples) or [`.maybeSingle()`](https://supabase.com/docs/reference/javascript/using-modifiers-maybesingle#examples) for one row instead of a list. `.stripNulls()`, `.returns()`, and `.overrideTypes()` chain after it as they do on a read.

The method takes one row map. supabase-js also accepts an array of rows on [`.insert()`](https://supabase.com/docs/reference/javascript/insert#parameters); call this method once per row instead.

## Returns

`ILocalInsertQuery`, a `Promise<IWriteResult>` settled once the local transaction commits. The insert starts when `insert()` is called, before any chained call runs.

| Name | Type | Required | Description |
|---|---|---|---|
| `data` | `null` | — | `null` without [`.select()`](https://supabase.com/docs/reference/javascript/select#parameters); with it, the inserted row in a one-row list, or the row itself after [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples). |
| `error` | `null` | — | Always `null`. A refused insert throws instead of returning an error envelope. |
| `count` | `number \| null` | — | `1` when `options.count` is set, else `null`. |

### What the insert changes

| Name | Type | Required | Description |
|---|---|---|---|
| Local row | `TLocalRow` | — | Committed immediately, with the owner column filled as above, so every local read sees it before any sync runs. |
| Outbox entry | `TOutboxEntry` | — | Enqueued in the same transaction, carrying the operation, the columns including a filled owner column, and a null pre-image so a dead letter reverts to no row. Read the count with [Outbox depth](./outbox-depth.md). |
| `LOCAL_CHANGED` | `{ type: 'LOCAL_CHANGED' }` | — | Raised after the transaction commits, so reactive bindings re-read. |
| `QUEUE_DEPTH` | `{ type: 'QUEUE_DEPTH'; depth: number }` | — | Raised with the new depth right after `LOCAL_CHANGED`. Both arrive through [Subscribe to events](./on.md). |

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | The table is absent from [Define config](./define-config.md#parameters). The message lists the configured tables. |
| `LOCAL_CONSTRAINT` | A key column the insert needs is missing or `null`, or holds a value that is neither a string nor an integer, and the message names those columns. Or a row with that key already exists locally: the local store refuses the duplicate primary key inside the write transaction, so two racing inserts of the same key cannot both pass. |
| `LOCAL_UNSUPPORTED` | The table's `sync` is `'pull-only'` in [Define config](./define-config.md#parameters). The kernel refuses the write before it reaches the outbox, naming the table in the message. The promise rejects naming the option, before anything is written, when `options.defaultToNull` is set (the push sends only the columns written and the database fills defaults), when `options.onConflict` or `options.ignoreDuplicates` is set (both belong to `upsert`), or when `options.count` is outside `exact`, `planned`, and `estimated`. A chained [`.select()`](https://supabase.com/docs/reference/javascript/select#parameters) throws synchronously on a relational embed or a rename in its columns; the row was already written by then. `upsert(values, options)` throws naming itself, whatever it is called with: an offline device cannot know whether the server holds the row, so use insert or update. |

A peer sometimes deletes the row first. The local [tombstone](../../resources/glossary.md#tombstone) then shadows the key. An insert that names an attachment column drops rather than applies. The Storage object that column named turns orphaned for the next [Vacuum attachments](./vacuum.md).

## Notes

The row stays local until a run delivers it. The server applies [Row Level Security](https://grokipedia.com/page/Row-level_security) when the push carries the queued mutation. [Offline writes](../../sync/offline-writes.md#1-write-locally) describes that path. A refusal comes back as a verdict rather than as a thrown error. [List rejections](./rejections.md) or the `MUTATION_REJECTED` event reports it. Supabase documents the policy side under [insert policies](https://supabase.com/docs/guides/database/postgres/row-level-security#insert-policies). [How Kizuna works](../../getting-started/how-kizuna-works.md#2-local-writes-enter-a-durable-outbox) places the outbox in the whole cycle.

Peers see the row only after this client pushes and their own client pulls. The wait is a sync run rather than a request, and the insert itself starts one: a local write wakes the automatic loop, so no call to [Sync](./sync.md) is needed.

## Related reference

- [Fetch data](./fetch-data.md)
- [Update data](./update-data.md)
- [Delete data](./delete-data.md)
- [Attach a file](./from-file.md)
- [Sync](./sync.md)
- [Swift: Insert data](../swift/insert-data.md)
- [Kotlin: Insert data](../kotlin/insert-data.md)
