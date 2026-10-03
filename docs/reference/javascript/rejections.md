---
title: List rejections
description: Read the durable journal of every write the server refused.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: List rejections

`rejections(options?)` reads the durable journal of writes the server refused, newest first. The matching engine events are fire-and-forget, so this journal is what an app reads after a reload to explain a write that disappeared.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const records = await kizunasync.rejections()
```

### Show the row the server kept

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

for (const record of await kizunasync.rejections()) {
  if (record.reason === 'PRECONDITION' && record.serverRow !== null) {
    console.info(`The server kept ${record.table} ${record.pk} as`, record.serverRow)
  }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `options.includeDismissed` | `boolean` | No | When true, entries already acknowledged through [Dismiss a rejection](./dismiss-rejection.md) are returned as well. Default: `false`, so only undismissed entries come back. |

## Returns

`Promise<TRejectionRecord[]>`, ordered by the recorded timestamp, newest first.

| Name | Type | Required | Description |
|---|---|---|---|
| `mutationId` | `TUuid` | — | The id of the refused mutation, and the argument [Dismiss a rejection](./dismiss-rejection.md) takes. |
| `table` | `string` | — | The table the mutation targeted. |
| `pk` | `TRowKey` | — | The row the mutation targeted. |
| `kind` | `TRejectionKind` | — | How the write died, from the four values below. |
| `reason` | `string` | — | The verdict reason for the first three kinds, one of `CONSTRAINT`, `COLUMN_DENIED`, `DELETE_WINS`, `PRECONDITION`, `RLS_DENIED`, and `SUPERSEDED`. A dead letter carries `PERMANENT_TRANSPORT`, or the server's own message when the server refused an atomic batch's size (`KZP02`), which drops the batch at once rather than counting toward the budget. |
| `changedColumns` | `string[]` | — | The columns the mutation carried, which is the mask the server compared. Empty for a delete. |
| `serverRow` | `TColumnValues \| null` | — | The authoritative row the verdict carried, and the value the local row was reverted to. `null` when the verdict carried none, in which case the local row was deleted instead. |
| `at` | `number` | — | Epoch milliseconds the entry was recorded. |
| `dismissed` | `boolean` | — | Whether the entry was acknowledged. |

### The four kinds

| Name | Type | Required | Description |
|---|---|---|---|
| `REJECTED` | `TRejectionKind` | — | One mutation was refused by its own verdict. |
| `SUPERSEDED` | `TRejectionKind` | — | Every masked column lost the origin-clock comparison, on a table configured with `conflict: 'hlc'`. |
| `BATCH_ABORTED` | `TRejectionKind` | — | An atomic batch was refused. Only the offender gets an entry; the other members reverted as a consequence and are not journalled. |
| `DEAD_LETTER` | `TRejectionKind` | — | A permanent failure that names one write, a lone unbatched mutation or an atomic batch, dropped it after five consecutive attempts; the server's size refusal (`KZP02`) on an atomic batch drops it on the first attempt instead, since the batch can never be split to fit. A permanent failure of an unbatched run of several writes narrows the next attempt to a shorter run rather than charging any of them, until the run is down to the one write that owns the failure. |

The same four kinds are listed project-wide under [Rejection kinds](../status-taxonomy.md#rejection-kinds).

## Notes

Each entry lands in the same transaction as the compensating revert, so the journal and the local row can never disagree about what happened. The event stream carries the same news first, through `MUTATION_REJECTED`, `BATCH_ABORTED`, and `DEAD_LETTER` on [Subscribe to events](./on.md), and a listener that is not mounted at the time misses it.

The journal stays on the client. No push carries it, and only two calls clear it: [Dismiss a rejection](./dismiss-rejection.md), which flags one entry, and [Reset](./reset.md), which deletes every one.

[Read the journal in the app](../../sync/validate-writes.md#4-read-the-journal-in-the-app) shows the pattern end to end, from a server-side rule to the message a user sees. React apps read the same rows through [React: useRejections](../react/use-rejections.md), which returns them newest first alongside the action that dismisses one.

## Related reference

- [Dismiss a rejection](./dismiss-rejection.md)
- [Subscribe to events](./on.md)
- [Push once](./push-once.md)
- [Update data](./update-data.md)
- [React: useRejections](../react/use-rejections.md)
- [Swift: List rejections](../swift/rejections.md)
- [Kotlin: List rejections](../kotlin/rejections.md)
