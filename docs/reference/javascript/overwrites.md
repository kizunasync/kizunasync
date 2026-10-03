---
title: List overwrites
description: Read the durable journal of every column a peer's write replaced.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: List overwrites

`overwrites(options?)` reads the durable journal of columns a peer's write replaced under [column-level last-writer-wins](../../resources/glossary.md#column-last-writer-wins-column-lww), newest first. The matching `COLUMN_OVERWRITTEN` event is fire-and-forget, so this journal is what an app reads after a reload to explain a value that changed under it.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const overwrites = await kizunasync.overwrites()
```

### Show what a peer replaced

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

for (const entry of await kizunasync.overwrites()) {
  console.info(`${entry.table}.${entry.column} lost the value`, entry.loserValue)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `options.includeDismissed` | `boolean` | No | When true, entries already acknowledged through [Dismiss an overwrite](./dismiss-overwrite.md) are returned as well. Default: `false`, so only undismissed entries come back. |

## Returns

`Promise<TOverwriteRecord[]>`, ordered by the recorded timestamp, newest first.

| Name | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | — | The journal row's own identity, and the argument [Dismiss an overwrite](./dismiss-overwrite.md) takes. The write that lost carries no id of its own: it landed, and only one of its columns did not. |
| `table` | `string` | — | The table the overwritten column belongs to. |
| `pk` | `TRowKey` | — | The row the overwritten column belongs to. |
| `column` | `string` | — | The column a peer's write replaced. |
| `loserValue` | `unknown` | — | The value this device's write held before the peer's write replaced it. |
| `winnerMutationId` | `TUuid` | — | The id of the peer's mutation that won the column. |
| `conflictMode` | `'arrival' \| 'hlc'` | — | The table's conflict mode at the time the column was resolved, from [Define config](./define-config.md#parameters). |
| `winnerSeq` | `string \| null` | — | The changelog sequence the winning value arrived on, a required field on every conflict a pull delivers. |
| `at` | `number` | — | Epoch milliseconds the entry was recorded. |
| `dismissed` | `boolean` | — | Whether the entry was acknowledged. |

## Notes

The engine writes an entry in the same transaction as the pull page that delivered the overwrite, so the journal and the local row can never disagree about what the row now holds. The engine tracks the mutation ids this device pushed and saw applied, so a conflict a pull reports on one of them never becomes an entry here or a `COLUMN_OVERWRITTEN` event: the device's own write is the winner, not the column that lost. The event stream carries the same news first, through `COLUMN_OVERWRITTEN` on [Subscribe to events](./on.md), and a listener that was not mounted at the time misses it.

The journal is client-local. No push carries it, and only two calls clear it: [Dismiss an overwrite](./dismiss-overwrite.md), which flags one entry, and [Reset](./reset.md), which deletes every one.

Recording an overwrite at all depends on the table's [`conflict_journal`](../../cli/configuration.md#kizunasync_config) setting on the server: with it off, the column still resolves the normal way, but no server-side history exists for a pull to deliver, so this journal stays empty for that table. [Conflict resolution](../../sync/conflict-resolution.md#conflict-history) covers the server side. React apps read the same rows through [React: useOverwrites](../react/use-overwrites.md), which returns them newest first alongside the action that dismisses one.

An overwrite and a rejection answer different questions: a rejection is a write that never landed, an overwrite is a write that landed and lost one of its columns to a peer. [List rejections](./rejections.md) is the journal for the first case.

## Related reference

- [Dismiss an overwrite](./dismiss-overwrite.md)
- [Subscribe to events](./on.md)
- [Update data](./update-data.md)
- [React: useOverwrites](../react/use-overwrites.md)
- [Vue: useOverwrites](../vue/use-overwrites.md)
- [Swift: List overwrites](../swift/overwrites.md)
- [Kotlin: List overwrites](../kotlin/overwrites.md)
