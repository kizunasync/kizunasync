---
title: Subscribe to events
description: Receive every engine event, from a local write to a refused one.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Subscribe to events

`on(handler)` subscribes to the engine's event stream and returns the function that unsubscribes. Events are fire-and-forget: a handler mounted later does not receive what it missed.

## Examples

### Basic

```ts
// src/todo-list.ts
import { EEngineEventType } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

async function refreshTodos(): Promise<void> {
  const { data } = await kizunasync.from('todos').select()

  console.info('todos on this device', data)
}

const stop = kizunasync.on((event) => {
  if (event.type === EEngineEventType.LOCAL_CHANGED) {
    void refreshTodos()
  }
})

export const closeTodoScreen = (): void => {
  stop()
}
```

The handler runs until the returned function is called, so hold it wherever the screen's teardown lives.

### Tell the user a write was refused

```ts
// src/todo-list.ts
import { EEngineEventType } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

const stop = kizunasync.on((event) => {
  if (event.type === EEngineEventType.MUTATION_REJECTED) {
    window.alert(`Change refused: ${event.reason}`)
  }
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `handler` | `(event: TEngineEvent) => void` | Yes | Called once per event, delivered through the bridge after the operation that raised it completes. A handler that throws is isolated: the failure is swallowed so it cannot reject an already-committed write or block the other handlers. |

## Returns

`() => void`, the unsubscribe function. Call it when the component or screen goes away, or the handler keeps running for the life of the client. The handler receives one of the eight events below.

| Name | Type | Required | Description |
|---|---|---|---|
| `LOCAL_CHANGED` | `{ type: 'LOCAL_CHANGED' }` | — | The local row store changed: a local write applied, a pull boundary committed rows or replayed the outbox over them, a dead letter reverted rows, or [Reset](./reset.md) wiped everything. It carries no payload, so a subscriber re-reads. |
| `QUEUE_DEPTH` | `{ type: 'QUEUE_DEPTH'; depth: number }` | — | Raised after every local write with the new [Outbox depth](./outbox-depth.md). It is raised by the write, not by a run. |
| `MUTATION_REJECTED` | `{ type: 'MUTATION_REJECTED'; mutationId: TUuid; reason: TRejectReason }` | — | One mutation was refused. Raised after the revert and the journal row land, so [List rejections](./rejections.md) already holds it. |
| `BATCH_ABORTED` | `{ type: 'BATCH_ABORTED'; offenderMutationId: TUuid; reason: TRejectReason }` | — | An atomic batch was refused, naming the offender. The other members reverted as a consequence. |
| `DEAD_LETTER` | `{ type: 'DEAD_LETTER'; mutationId: TUuid; reason: string }` | — | A queued write was dropped: after five consecutive permanent failures naming it (a lone write, or an atomic batch), with reason `PERMANENT_TRANSPORT`; or at once when the server refuses an atomic batch's size (`KZP02`), with the server's own message. [Sync](./sync.md#errors) covers how an unbatched run of several writes narrows before either one applies. |
| `COLUMN_OVERWRITTEN` | `{ type: 'COLUMN_OVERWRITTEN'; table: string; pk: TRowKey; column: string; loserValue: unknown; winnerMutationId: TUuid; conflictMode: 'arrival' \| 'hlc' }` | — | A pull delivered a journalled overwrite for a table whose `conflict_journal` column is on, carrying the value that lost. |
| `CHECKPOINT_EXPIRED` | `{ type: 'CHECKPOINT_EXPIRED' }` | — | The server invalidated the pull token, so the next sequence restarts from the beginning and replaces local rows. |
| `RESET_REQUIRED` | `{ type: 'RESET_REQUIRED'; reason?: 'reset_required' \| 'identity_changed' }` | — | Sync is soft-blocked until [Reset](./reset.md) clears it. `reason` is `reset_required` when the client's schema version is below the server minimum, and `identity_changed` when a token of another user than the one the local database belongs to reached the engine. [Sync health](./sync-health.md#returns) keeps the same value as `softBlockReason`. |

## Notes

The phase, the failure streak, and the next armed attempt come from [Sync health](./sync-health.md) instead. This union follows the wire protocol vocabulary, and diagnostics are not part of it.

Attachment progress comes from a per-reference subscription on [Watch an attachment](./watch.md), so a byte-level tick does not re-render every query on the screen.

`COLUMN_OVERWRITTEN` is fire-and-forget like every event here. [List overwrites](./overwrites.md) reads the same information back from the durable journal, for a handler that was not mounted when it fired.

Handlers run after the engine's own operations, once the event crosses the bridge. React and [Vue](https://vuejs.org) wrap the same stream for you: [React: useQuery](../react/use-query.md) re-runs its local read on every event, so a component that only needs fresh rows never subscribes by hand.

Keep a handler cheap and move real work to a microtask or a state update. [Subscribe to engine events](../../sync/offline-writes.md#4-subscribe-to-engine-events) shows the pattern in a running app.

Subscribing counts as a use of the app client, so the first `on()` opens the engine and starts the automatic loop. When that open fails, `on()` returns an unsubscribe that does nothing and no event ever arrives; [Sync health](./sync-health.md#notes) is where the failure shows.

## Related reference

- [Sync health](./sync-health.md)
- [Outbox depth](./outbox-depth.md)
- [List rejections](./rejections.md)
- [List overwrites](./overwrites.md)
- [Watch an attachment](./watch.md)
- [Swift: Subscribe to events](../swift/on.md)
- [Kotlin: Subscribe to events](../kotlin/on.md)
