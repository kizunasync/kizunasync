---
title: Checkpoint
description: Read the durable cursor, the schema version, and the soft-block flag.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Checkpoint

`getCheckpoint()` reads the durable sync state: how far the last committed pull reached, which schema version this client sends, and whether the client is soft-blocked.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const checkpoint = await kizunasync.getCheckpoint()
```

### Tell a first run from a resumed one

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const checkpoint = await kizunasync.getCheckpoint()
const isFirstSync = checkpoint.cursor === '0'
```

While `isFirstSync` is true, no pull boundary has committed yet, so an empty list can mean that the first pull is still running rather than that there is nothing to show.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

## Returns

`Promise<TCheckpointState>`, read from the local database rather than from the wire.

| Name | Type | Required | Description |
|---|---|---|---|
| `cursor` | `TCursor` | — | The last committed pull boundary, stored exactly as the server sent it. It is the [cursor](../../resources/glossary.md#cursor) the protocol carries: opaque text that clients compare for equality and never parse or order. `'0'` before the first boundary closes, which is also the value [Reset](./reset.md) restores. |
| `schemaVersion` | `number` | — | The version this client stamps on every request, from the `schemaVersion` option on [Initializing](./initializing.md#parameters). It is the client's own value, not the server's minimum. Default: `1`. |
| `softBlocked` | `boolean` | — | True once the server answered a pull or a push with the reset signal, or once a token of another user than the one the local database belongs to reached the engine. While it holds, [Pull once](./pull-once.md) and [Push once](./push-once.md) return without reaching the wire. |
| `softBlockReason` | `'reset_required' \| 'identity_changed' \| undefined` | — | Why `softBlocked` is true: `reset_required` for the schema gate, `identity_changed` for the token check. Absent while sync is not soft-blocked. [Sync health](./sync-health.md#returns) reads this same value once, from this method, when a client opens a database that is already blocked. |

A continuation page does not move the cursor: the keyset position it records is separate, and the cursor advances only when the boundary commits. A cursor that stays put across several runs therefore means a long sequence in progress, not a stalled client.

## Notes

The cursor counts committed boundaries, not rows or time, and [Fencing and horizons](../../sync/fencing-and-horizons.md#what-the-cursor-counts) explains what a server may safely omit from a page that carries it. [Consistency model](../../sync/consistency-model.md#checkpoints) states the guarantee an app can rely on: a boundary is all-or-nothing.

[Reset](./reset.md) clears a soft block. It wipes local state and starts the cursor again from the bootstrap value.

Ship a client whose schema version meets the server minimum as well. A reset on its own soft-blocks again on the next pull.

[React: useSyncStatus](../react/use-sync-status.md#returns) returns this same value as `checkpoint` and refreshes it on every engine event, so a React component reads the cursor without calling the method itself.

`seedCheckpoint(cursor)` writes the durable cursor directly. It exists for a client resuming from a cursor the app persisted elsewhere, and for the checkpoint-expiry lab in [Test offline behavior](../../operations/test-offline-behavior.md#5-add-failure-cases). It applies no rows of its own, so a seeded cursor tells the server to send only what has happened since.

## Related reference

- [Sync](./sync.md)
- [Pull once](./pull-once.md)
- [Reset](./reset.md)
- [Sync health](./sync-health.md)
- [Swift: Checkpoint](../swift/checkpoint.md)
- [Kotlin: Checkpoint](../kotlin/checkpoint.md)
