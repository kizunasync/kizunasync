---
title: Sync health
description: Read what the automatic sync loop is doing, and subscribe to every transition.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Sync health

`getSyncHealth()` returns what the automatic sync loop is doing right now, and `onSyncHealth(listener)` publishes every transition. Both read the loop's own state rather than the database, so the first is synchronous.

## Examples

### Read once

```ts
// src/sync-banner.ts
import { kizunasync } from './kizunasync'

const health = kizunasync.getSyncHealth()

if (health.phase === 'stalled') {
  console.warn('Sync is stalled: the request in flight has not settled yet')
}
```

### Subscribe

```ts
// src/sync-banner.ts
import { kizunasync } from './kizunasync'

const banner = document.querySelector('#sync-banner')

const stop = kizunasync.onSyncHealth((health) => {
  if (banner !== null) {
    banner.textContent = health.lastError?.message ?? health.phase
  }
})

export const closeSyncBanner = (): void => {
  stop()
}
```

The listener runs until the returned function is called, so hold it wherever the banner's teardown lives.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | `getSyncHealth()` takes no arguments. |
| `listener` | `(health: ISyncHealth) => void` | Yes | Passed to `onSyncHealth()` and called with the new snapshot after every transition. A listener that throws is isolated, so it cannot break the transition that produced the snapshot or reach the other listeners. |

## Returns

`getSyncHealth()` returns a frozen `ISyncHealth`. `onSyncHealth()` returns the unsubscribe function; call it to stop the listener.

| Name | Type | Required | Description |
|---|---|---|---|
| `phase` | `TSyncPhase` | — | What the loop is doing, from the five values below. It is derived at read time rather than stored, because connectivity can change without telling the loop what the new value is. |
| `consecutiveFailures` | `number` | — | Attempts that failed in a row. Reset to `0` by a success and by any wake signal. |
| `nextAttemptAt` | `number \| null` | — | Epoch milliseconds of the next armed automatic attempt. `null` when none is armed, which is the case with the poll off, after `dispose()`, and after an open that failed. [React: useSyncStatus](../react/use-sync-status.md#returns) and [Vue: useSyncStatus](../vue/use-sync-status.md#returns) expose this same value under the name `nextRetryAt`. |
| `attemptStartedAt` | `number \| null` | — | Epoch milliseconds when the attempt in flight started. `null` when no attempt is running, and cleared the moment one settles. |
| `lastSuccessAt` | `number \| null` | — | Epoch milliseconds of the last attempt that settled successfully. `null` before the first one. |
| `lastError` | `ISyncHealthError \| null` | — | The last failure, or a server signal an otherwise-successful attempt carried. `null` after a clean attempt that carried neither. |
| `lastError.code` | `string \| null` | — | The failure's own code when it carried one, such as `AUTH_SESSION_TIMEOUT`, or `'RESET_REQUIRED'` / `'CHECKPOINT_EXPIRED'` for a signal. `null` for a failure that carried none. |
| `lastError.message` | `string` | — | The failure's message, or the [verdict copy](./on.md#returns) for a signal. |
| `lastError.at` | `number` | — | Epoch milliseconds the failure or signal was recorded. |
| `softBlockReason` | `'reset_required' \| 'identity_changed' \| null` | — | Why sync is soft-blocked until [Reset](./reset.md) runs: `reset_required` when the server's schema gate refused this client, `identity_changed` when a token of another user than the one the local database belongs to reached the engine. The engine records it from the `RESET_REQUIRED` event that latches the block, and reads it once from the checkpoint when a client opens a database that is already blocked. `null` while sync is not soft-blocked, and again once `reset()` clears the block. |

A `RESET_REQUIRED` or `CHECKPOINT_EXPIRED` event arrives on the event bus while the pull or push that carried it still resolves successfully. `lastError` records the signal, `consecutiveFailures` stays at `0`, and `lastSuccessAt` advances. The attempt itself completed, so there is no failure streak to back off from. The next attempt that carries no signal clears `lastError`, the same as an ordinary failure. `softBlockReason` stays until `reset()` runs, because a clean attempt does not lift the block.

### The five phases

| Name | Type | Required | Description |
|---|---|---|---|
| `offline` | `TSyncPhase` | — | The connectivity port reports no network. It outranks every other phase, and while it holds the loop reaches no wire, so the streak neither grows nor resets. |
| `syncing` | `TSyncPhase` | — | An attempt is in flight and has not settled. |
| `stalled` | `TSyncPhase` | — | The attempt in flight has occupied the slot for two poll ticks. The loop keeps waiting for it rather than starting a second one, which would push the same outbox rows twice. |
| `backoff` | `TSyncPhase` | — | No attempt is running and the streak is above zero, so the next tick is armed further out. |
| `idle` | `TSyncPhase` | — | No attempt is running and nothing has failed. |

The same five values are listed project-wide under [Sync phases](../status-taxonomy.md#sync-phases).

## Notes

Sync health is diagnostics. It sits outside the engine event vocabulary [Subscribe to events](./on.md) delivers, because that vocabulary is pinned to the wire protocol and loop state is not part of it.

Both methods count as a use of the app client, so the first call opens the engine and starts the automatic loop. When that open fails, neither method throws. Both report one fixed snapshot instead: `phase` is `backoff`, `consecutiveFailures` is `1`, `lastError` carries the open's code and message, such as `ENGINE_UNAVAILABLE` in Expo Go or `STORE_BUSY`, and `nextAttemptAt`, `attemptStartedAt`, `lastSuccessAt`, and `softBlockReason` are `null`. Nothing retries the open, so that snapshot never changes, and `onSyncHealth()` calls the listener once with it and returns an unsubscribe that does nothing. The client's async calls reject with that same error, as [Sync](./sync.md#errors) describes.

A client disposed before its first use opens nothing and reports an idle loop the same way: `phase` is `idle`, `consecutiveFailures` is `0`, and every other field is `null`. The dispose was deliberate, so there is no error to show.

The backoff doubles with the streak and stops at whichever is larger, 30 seconds or the configured `pollIntervalMs`, so a deliberately slow poll is never sped up by a failure. Crossing the stall threshold counts one failure, once per attempt, so a long hang grows the backoff without being reported again and again.

A return to connectivity, a return to the foreground, a local write, and a Realtime wakeup each clear the streak and pull the next attempt into a short debounce window, so recovery does not wait out the remaining backoff. [Troubleshooting](../../operations/troubleshooting.md#sync-goes-quiet-after-sleep-background-or-a-token-expiry) walks through a client that went quiet and what each phase says about why.

The automatic loop also skips a poll tick or a wake without touching the snapshot in two cases: while the `shouldSyncAutomatically` option on [Initializing](./initializing.md#parameters) answers `false`, and on a browser tab that does not lead its database, whose calls the leading tab runs. The skipped wake starts no attempt and clears no streak, and an explicit [`sync()`](./sync.md) runs either way. A tab promoted to leader wakes the loop once.

A streak that keeps growing on the same queued write eventually ends in a dead letter, which [Consistency model](../../sync/consistency-model.md#dead-letters-and-liveness) bounds: only a failure the server marks permanent counts toward that budget. [Sync](./sync.md#errors) lists which codes those are.

The whole snapshot reaches a component as `health` through [React: useSyncStatus](../react/use-sync-status.md#returns) and [Vue: useSyncStatus](../vue/use-sync-status.md#returns), which also lift the stalled flag and the next attempt to the top level of their result. [Show sync state](../../getting-started/react.md#7-show-sync-state) wires the React one into a banner.

## Related reference

- [Sync](./sync.md)
- [Outbox depth](./outbox-depth.md)
- [Subscribe to events](./on.md)
- [Initializing](./initializing.md)
- [React: useSyncStatus](../react/use-sync-status.md)
- [Vue: useSyncStatus](../vue/use-sync-status.md)
