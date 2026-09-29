---
title: Inspector
description: Read one coherent snapshot of the local command queue, plus a ring of recent verdicts.
status: alpha
docType: reference
library: javascript
pageKind: guide
audience: app-developer
---

# JavaScript: Inspector

`kizunasync.inspector` is a read-only view of the local command queue for development tooling. It adds no tables and tracks nothing of its own: the snapshot is an ordinary read of the local store plus the identity the client registers under, and `verdicts()` is a bounded in-memory ring fed by the engine's event stream.

## Examples

### Read a snapshot

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const snapshot = await kizunasync.inspector?.snapshot()
```

### Show the verdicts that arrived this session

```ts
// src/verdict-log.ts
import type { IInspectorVerdict } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export function watchVerdicts(render: (verdicts: IInspectorVerdict[]) => void): () => void {
  const inspector = kizunasync.inspector

  if (inspector == null) {
    return () => {}
  }
  return inspector.subscribe(() => {
    render(inspector.verdicts())
  })
}
```

## Returns

| Name | Type | Required | Description |
|---|---|---|---|
| `snapshot()` | `() => Promise<IInspectorSnapshot>` | — | One coherent read of the queue, taken inside a single transaction so a concurrent run cannot tear it. |
| `verdicts()` | `() => IInspectorVerdict[]` | — | A copy of the ring, oldest first. It holds the 50 most recent entries and is not durable. |
| `subscribe(onChange)` | `(onChange: () => void) => () => void` | — | Called after every engine event, not only the ones that enter the ring, and after `clear()`. Returns the unsubscribe function. It carries no payload, so a subscriber re-reads. |
| `clear()` | `() => void` | — | Empties the ring and notifies the subscribers. It touches no stored data. |

### The snapshot

| Name | Type | Required | Description |
|---|---|---|---|
| `queued` | `TOutboxEntry[]` | — | The outbox entries themselves, in queue order. |
| `depth` | `number` | — | The same count [Outbox depth](./outbox-depth.md) returns, read in the same transaction as the entries above. |
| `lastMutationId` | `string \| null` | — | The exactly-once watermark sent on the next push. `null` until the first applied verdict. |
| `cursor` | `TCursor` | — | The durable pull cursor, also on [Checkpoint](./checkpoint.md#returns). |
| `clientId` | `string` | — | The client's current registered identity. It changes after [Reset](./reset.md). |

### A verdict in the ring

| Name | Type | Required | Description |
|---|---|---|---|
| `mutationId` | `string` | — | The refused mutation, the offender of a refused batch, or, for an `'overwritten'` entry, the winning mutation: the device has no mutation of its own left to point at. |
| `kind` | `'rejected' \| 'aborted' \| 'overwritten'` | — | Which event produced the entry: a per-mutation rejection, an atomic batch abort, or a column a peer's write replaced. |
| `reason` | `TRejectReason \| string` | — | The reason the verdict carried. For an `'overwritten'` entry, `<table>.<column>` naming what was replaced; the pk and the losing value are not in the ring, and are read through [List overwrites](./overwrites.md) instead. |
| `at` | `string` | — | The timestamp from the client's own clock source. |

## Notes

`kizunasync.inspector` is `null` when the inspector is off, so read it optionally. It is on when `process.env.NODE_ENV` is `'development'` or `'test'` and off otherwise, which includes a page loaded without a bundler, where no `process` exists. The `inspector` option on [Initializing](./initializing.md#parameters) forces it either way.

Reading `kizunasync.inspector` opens nothing, and its methods open the engine on their first call. When that open fails, `subscribe` and `clear` do nothing, `verdicts()` returns an empty list, and `snapshot()` rejects with the error [Initializing](./initializing.md#errors) describes.

This is a development surface, not a product one. A user-facing screen reads [Outbox depth](./outbox-depth.md) for the count, [Sync health](./sync-health.md) for the phase, and [List rejections](./rejections.md) for refused writes, all of which are durable and defined.

The ring is the reason: it lives in memory, holds 50 entries, and is gone on reload, while the rejection journal survives and can be dismissed. Both are fed by the same events.

## Related reference

- [Outbox depth](./outbox-depth.md)
- [Checkpoint](./checkpoint.md)
- [List rejections](./rejections.md)
- [List overwrites](./overwrites.md)
- [Subscribe to events](./on.md)
- [Initializing](./initializing.md)
- [Swift: Inspector](../swift/inspector.md)
- [Kotlin: Inspector](../kotlin/inspector.md)
