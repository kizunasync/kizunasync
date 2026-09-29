---
title: Sync
description: Push the outbox and pull committed changes.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Sync

`sync()` pushes the outbox, drives queued attachment uploads when attachments are configured and the outbox is empty, vacuums orphaned attachments once the push has drained, then pulls until the checkpoint closes. It reaches no wire while the connectivity port reports no network, so a call made offline returns without an attempt. The app client already runs this cycle on its own, so a call is for a **Sync now** button, a pull-to-refresh gesture, or a test that waits for the round trip.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

await kizunasync.sync()
```

### A Sync now button

```ts
// src/sync-button.ts
import { kizunasync } from './kizunasync'

document.querySelector('#sync-now')?.addEventListener('click', () => {
  kizunasync.sync().catch((error: unknown) => {
    console.warn('Sync failed, and the automatic loop will try again', error)
  })
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

These options are set once on `createSupabaseKizunaSync` or `createKizunaSync`; see [Initializing](./initializing.md#parameters).

### Options that shape every run

| Name | Type | Required | Description |
|---|---|---|---|
| `pollIntervalMs` | `number` | No | Jittered poll fallback. Above `0` the engine reschedules a run at a random point between half the interval and the whole interval; `0` arms no timer. A `pollIntervalMs` in `defineConfig` wins over this option. Default: `15000`. |
| `shouldSyncAutomatically` | `() => boolean` | No | Asked on every automatic wake. While it answers `false` the loop's first attempt, the poll tick, a return to connectivity, a Realtime wakeup, a return to the foreground, and a local write start no run; an explicit `sync()` call still runs. Default: none, so every automatic wake runs. |
| `connectivity` | `IConnectivity` | No | Network port. A run returns without reaching the wire while `isOnline()` is false, and a false to true transition wakes the scheduler so the outbox flushes. Default: the driver's `platformPorts.connectivity`, which is the browser's network signal from `createWebWorkerDriver` and the device's from `openExpoDriver`, else always online. |
| `realtimeWakeups` | `boolean` | No | Set in `defineConfig`, not in the options. When false, no Realtime doorbell is built and an explicit `wakeup` is dropped as well, which leaves the poll and the foreground signal as the recovery paths. Default: `true`. |
| `wakeup` | `IWakeup` | No | Server-change hint, a debounced pull now and never a data path. `createSupabaseKizunaSync` derives a Realtime doorbell over the configured tables when none is passed. Default: the derived doorbell on the [Supabase](https://supabase.com) composition, none on bare `createKizunaSync`. |
| `foreground` | `IForeground` | No | App-became-visible port. Default: the driver's `platformPorts.foreground`, which `openExpoDriver` sets to the app's foreground signal on a device. Without one, `createSupabaseKizunaSync` observes `visibilitychange`, the `resume` of a frozen tab, and a bfcache `pageshow` in a browser, and bare `createKizunaSync` observes nothing. |
| `refreshOnForeground` | `boolean` | No | When true, a foreground signal calls `refreshSession()` before waking the scheduler, so the next run does not ride a dead Bearer. Default: `true`. |
| `sessionTimeoutMs` | `number` | No | How long `auth.getSession()` before every pull and push, the anonymous sign-in `anonymousSignIn` runs, and the foreground `refreshSession()` may each take before the attempt fails retryably with `AUTH_SESSION_TIMEOUT`. `0` disables the deadline. Default: `10000`. |
| `anonymousSignIn` | `boolean \| { captchaToken: () => Promise<string> }` | No | When the session read before a pull or push finds no session, the Supabase composition runs [Recover an anonymous session](./recover-anonymous-session.md) and reads the session again. A failed or timed-out recovery fails that attempt retryably, and the next attempt tries again. Default: absent, so a missing session fails the attempt with `AUTH_SESSION_MISSING`. |
| `remoteOptions.requestTimeoutMs` | `number` | No | How long one pull or push may take before the request is aborted and the attempt fails retryably. `0` disables the deadline. Default: `30000`. |
| `remoteOptions.localOnlyColumns` | `readonly string[]` | No | Device-only columns stripped from every mutation before push, because the server has no column to apply them to. Pull is unaffected. Default: none. |
| `setTimer` / `clearTimer` | `(callback: () => void, delayMs: number) => unknown` / `(handle: unknown) => void` | No | Timer pair for the poll fallback and the session deadlines (`sessionTimeoutMs`, on every pull, push, and foreground refresh). Tests inject a fake pair. Default: the platform `setTimeout` and `clearTimeout`. |

## Returns

`Promise<void>` that settles once this call's own push then pull cycle completes. Each `sync()` call reaches the engine and runs a full cycle of its own; only the scheduler's automatic ticks coalesce into one queued run.

### What a run changes

| Name | Type | Required | Description |
|---|---|---|---|
| Outbox depth | `number` | — | Drops as [verdicts](../../resources/glossary.md#verdict) arrive. An applied verdict clears the entry and advances the exactly-once watermark; a rejected verdict reverts the row to the server state and clears the entry. Read it with [Outbox depth](./outbox-depth.md#returns). |
| Checkpoint cursor | `TCursor` | — | Advances only when the pull boundary closes, written verbatim in the same transaction that commits the staged pages and replays the outbox. A continuation page stages its rows and tombstones, and moves the keyset cursor instead. |
| Rejection journal | `TRejectionRecord[]` | — | A rejected verdict adds a `REJECTED` or `SUPERSEDED` entry, an aborted batch adds one `BATCH_ABORTED` entry for the offender, and an exhausted retry budget adds a `DEAD_LETTER` entry. Read it with [List rejections](./rejections.md#returns). |
| Sync health | `ISyncHealth` | — | `attemptStartedAt` is stamped when the run reaches the wire. Settling clears it and then either sets `lastSuccessAt` and resets `consecutiveFailures` to `0`, or records `lastError` and increments `consecutiveFailures`. |

### Events, and what raises them

| Name | Type | Required | Description |
|---|---|---|---|
| `QUEUE_DEPTH` | `{ type: 'QUEUE_DEPTH'; depth: number }` | — | Raised by `apply()` after each local write, not by a run, so the depth it reports is the one the next run drains. |
| `LOCAL_CHANGED` | `{ type: 'LOCAL_CHANGED' }` | — | Raised when a pull boundary commits rows or replays the outbox over them, and when a dead-letter reverts optimistic rows. |
| `MUTATION_REJECTED` | `{ type: 'MUTATION_REJECTED'; mutationId: TUuid; reason: TRejectReason }` | — | Raised once per rejected verdict, after the revert and the journal row land. |
| `BATCH_ABORTED` | `{ type: 'BATCH_ABORTED'; offenderMutationId: TUuid; reason: TRejectReason }` | — | Raised once for an atomic batch the server refused, naming the offender; the other members revert as a consequence. |
| `DEAD_LETTER` | `{ type: 'DEAD_LETTER'; mutationId: TUuid; reason: string }` | — | Raised once per dropped entry: after five consecutive permanent failures naming it, with reason `PERMANENT_TRANSPORT`, or at once when the server refuses an atomic batch's size (`KZP02`), with the server's own message. |
| `COLUMN_OVERWRITTEN` | `{ type: 'COLUMN_OVERWRITTEN'; table: string; pk: TUuid; column: string; loserValue: unknown; winnerMutationId: TUuid; conflictMode: 'arrival' \| 'hlc' }` | — | Raised for each column-level conflict the pull boundary reports, after the overwrite is journalled. Never raised for a conflict this device's own pushed mutation won. |
| `CHECKPOINT_EXPIRED` | `{ type: 'CHECKPOINT_EXPIRED' }` | — | Raised when the server invalidates the pull token; the run drops the staged pages and restarts the keyset from the beginning on the next pull. |
| `RESET_REQUIRED` | `{ type: 'RESET_REQUIRED'; reason?: 'reset_required' \| 'identity_changed' }` | — | Raised when pull or push returns the reset signal; the client soft-blocks, applies nothing, and leaves the durable cursor untouched. `reason` is `reset_required` for the schema gate and `identity_changed` for a token of another user than the one the local database belongs to. |

## Errors

Retryable failures keep the queued mutations in the outbox for the next run, and `AUTH_SESSION_MISSING`, `AUTH_SESSION_TIMEOUT`, the request deadline (30 seconds by default, `requestTimeoutMs`), `PGRST301`, and `42501` are all retryable. Only a failure the remote marks permanent counts against the dead-letter budget: SQLSTATE classes 22, 23, and 42 other than `42501`, plus exact `P0001` and `0A000`. A permanent failure is charged only to the slice it names: a lone unbatched write, or an atomic batch, since a request of either shape can own no failure but its own. The fifth consecutive charge against the same head dead-letters it, reverts its optimistic rows to the pre-image, and records a `DEAD_LETTER` rejection with reason `PERMANENT_TRANSPORT`; the server's size refusal (`KZP02`) on an atomic batch dead-letters it on the first charge, with the server's own message, because the batch can never be split to fit. A permanent failure of an unbatched run of several writes names none of them individually, so it charges nothing: the next attempt sends a shorter run instead, halved when the server named the size (`KZP02`) or cut to the head alone otherwise, until a run of one owns its own failure.

A run also raises whatever the half it is driving raises. `UNKNOWN_SIGNAL`, `MALFORMED_PUSH_RESPONSE`, `VERDICT_BIJECTION`, `UNKNOWN_BATCH_OFFENDER`, `UNKNOWN_VERDICT_REASON`, and `UNKNOWN_OP` mean the exchange broke the wire contract, and they fail loudly rather than counting against the dead-letter budget. [Pull once](./pull-once.md#errors) and [Push once](./push-once.md#errors) state the condition behind each one.

The first call that needs the engine opens it. When that open fails, on this call or an earlier one, `sync()` rejects with the open's typed error, such as `ENGINE_UNAVAILABLE` in Expo Go or `STORE_BUSY`, and every later async call on the client rejects with that same error, because nothing opens the engine a second time. [Sync health](./sync-health.md#notes) reports the same failure without throwing.

## Notes

The app client syncs by itself, so most apps never call this method. The automatic loop makes its first attempt when the client is first used, then runs again after every local write, on a jittered poll (15 seconds by default), when the network comes back, when the app returns to the foreground, and when the Realtime doorbell rings. A burst of writes or signals collapses into one attempt scheduled 250 milliseconds out. A write applies locally and waits in the outbox until a run delivers it, which is the path [Offline writes](../../sync/offline-writes.md#1-write-locally) describes, and the loop reports its phase, failure streak, and last error through [Sync health](./sync-health.md#returns).

Call this method when you want the round trip now and want to know when it finished. Use [`pullOnce`](./pull-once.md) and [`pushOnce`](./push-once.md) only when you need one half of the cycle.

[`attachments.vacuum()`](./vacuum.md) runs on its own after every successful push, so an object orphaned by that run's writes is collected without a separate call. Nothing else about attachments happens inside `sync()`: a download stays lazy, fetched only when [`resolveDownload`](./resolve-download.md) asks for it.

## Related reference

- [Pull once](./pull-once.md)
- [Push once](./push-once.md)
- [Outbox depth](./outbox-depth.md)
- [Sync health](./sync-health.md)
- [Swift: Sync](../swift/sync.md)
- [Kotlin: Sync](../kotlin/sync.md)
