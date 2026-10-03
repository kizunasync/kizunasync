---
title: useOverwrites
description: Read the durable overwrite journal and dismiss entries the reader has seen.
status: alpha
docType: reference
library: react
pageKind: method
audience: app-developer
---

# React: useOverwrites

`useOverwrites` reads the client-local journal of every column a peer's write replaced, newest first, and returns the action that acknowledges one. The engine's `COLUMN_OVERWRITTEN` events are fire and forget; this journal survives reloads until each entry is dismissed, so a component can explain a value that changed under it an hour ago.

## Examples

### Basic

```tsx
// src/components/overwrite-count.tsx
import { useOverwrites } from '@kizunasync/react'

export function OverwriteCount() {
  const { overwrites } = useOverwrites()

  return <span>{overwrites.length} values replaced by another device</span>
}
```

### Render the journal

```tsx
// src/components/overwrite-list.tsx
import { useOverwrites } from '@kizunasync/react'

export function OverwriteList() {
  const { overwrites, error, isLoading, dismiss } = useOverwrites()

  if (isLoading) return null
  if (error !== null) return <p>The journal could not be read: {error.message}</p>

  return (
    <ul>
      {overwrites.map((entry) => (
        <li key={entry.id}>
          {entry.table}.{entry.column} was replaced
          <button onClick={() => dismiss(entry.id)}>Dismiss</button>
        </li>
      ))}
    </ul>
  )
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `opts` | `IOverwritesOption` | No | Client override plus the dismissed filter. Default: the context client and live entries only. |
| `opts.client` | `IKizunaSync` | No | Used instead of the [`KizunaSyncProvider`](./initializing.md) client, resolved through [useKizunaSync](./use-kizunasync.md). Default: the context client. |
| `opts.includeDismissed` | `boolean` | No | When `true`, entries already acknowledged stay in the list, which is what a history view wants. Changing it re-reads the journal. Default: `false`. |

## Returns

`IOverwritesResult`.

| Name | Type | Required | Description |
|---|---|---|---|
| `overwrites` | `TOverwriteRecord[]` | — | The journal rows the last read returned, newest first. `[]` before the first read resolves and after a failed one. |
| `error` | `Error \| null` | — | The failure the last read raised, wrapped in an `Error` when it was not one. Cleared by the next successful read. |
| `isLoading` | `boolean` | — | `true` until the first read settles, then `false` for the life of the subscription. |
| `dismiss` | `(id: number) => Promise<void>` | — | Calls [`dismissOverwrite`](../javascript/dismiss-overwrite.md) for one entry and then awaits a fresh read, so the list already reflects the change when the promise settles. |

Fields on one `TOverwriteRecord`, the same record [List overwrites](../javascript/overwrites.md#returns) returns from the client:

| Name | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | — | The journal row's own identity, and the argument `dismiss` takes. |
| `table` | `string` | — | The table the overwritten column belongs to. |
| `pk` | `TRowKey` | — | The row the overwritten column belongs to. |
| `column` | `string` | — | The column a peer's write replaced. |
| `loserValue` | `unknown` | — | The value this device's write held before the peer's write replaced it. |
| `winnerMutationId` | `TUuid` | — | The id of the peer's mutation that won the column. |
| `conflictMode` | `'arrival' \| 'hlc'` | — | The table's conflict mode at the time the column was resolved. |
| `winnerSeq` | `string \| null` | — | The changelog sequence the winning value arrived on, a required field on every conflict a pull delivers. |
| `at` | `number` | — | Epoch milliseconds the entry was recorded. |
| `dismissed` | `boolean` | — | Whether this entry has been acknowledged. Only ever `true` in a list read with `includeDismissed`. |

## Errors

A failed read lands in `error` rather than being swallowed, because a component that cannot read this journal has to be able to say so instead of rendering an empty list as though nothing had gone wrong.

`dismiss` rejects when [`dismissOverwrite`](../javascript/dismiss-overwrite.md) fails, so a button handler can catch it. A dismiss whose follow-up read fails resolves regardless, with that failure in `error`.

A component that renders outside [`KizunaSyncProvider`](./initializing.md) and passes no `{ client }` override throws from [useKizunaSync](./use-kizunasync.md).

## Notes

The list re-reads on `COLUMN_OVERWRITTEN`, the only event that adds a row, and on nothing else.

Dismissing is an acknowledgement, not a repair. The column already holds the peer's value; `loserValue` on the record is the only place your device's replaced value is still readable. [Restore an overwritten assign](../../sync/collaborative-fields.md#4-restore-an-overwritten-assign-from-the-journal) shows the write that would put it back.

Recording an overwrite at all depends on the table's `conflict_journal` setting on the server. With it off, the journal stays empty for that table even though the column still resolves the normal way. A conflict this device's own write won journals and announces nothing, since the column already holds this device's value and there is nothing to explain.

An overwrite and a rejection answer different questions: a rejection is a write that never landed, an overwrite is a write that landed and lost one column to a peer. [useRejections](./use-rejections.md) is the hook for the first case.

## Related reference

- [useMutation](./use-mutation.md)
- [useSyncStatus](./use-sync-status.md)
- [JavaScript: List overwrites](../javascript/overwrites.md)
- [JavaScript: Dismiss an overwrite](../javascript/dismiss-overwrite.md)
- [Vue: useOverwrites](../vue/use-overwrites.md)
