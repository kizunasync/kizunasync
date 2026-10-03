---
title: useSyncStatus
description: Read the outbox depth, the checkpoint, connectivity, and the automatic loop's health as refs.
status: alpha
docType: reference
library: vue
pageKind: method
audience: app-developer
---

# Vue: useSyncStatus

`useSyncStatus` reports what the engine is doing: how many writes wait in the outbox, where the durable pull cursor stands, whether the device is online, and what the automatic sync loop is up to. It re-reads on every engine event and returns one action, `syncNow`, for a button.

## Examples

### Basic

```vue
<!-- src/components/SyncBar.vue -->
<script setup lang="ts">
import { useSyncStatus } from 'kizunasync/vue'

const { outboxDepth, isOnline, isSyncing, syncNow } = useSyncStatus()
</script>

<template>
  <p>
    {{ isOnline ? 'Online' : 'Offline' }}, {{ outboxDepth }} waiting.
    <button type="button" :disabled="isSyncing" @click="syncNow">Sync now</button>
  </p>
</template>
```

### Show reconnecting state

```ts
// src/components/SyncBanner.vue (script setup)
import { computed } from 'vue'
import { useSyncStatus } from 'kizunasync/vue'

const { isStalled, nextRetryAt, outboxDepth } = useSyncStatus()

const banner = computed(() => {
  if (isStalled.value) {
    return `Reconnecting. ${outboxDepth.value} writes are waiting.`
  }
  if (nextRetryAt.value !== null) {
    return `Retrying at ${new Date(nextRetryAt.value).toLocaleTimeString()}.`
  }
  return null
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `opts` | `IUseSyncStatusOptions` | No | Client override plus the connectivity source. Default: the provided client and its own `connectivity`. |
| `opts.client` | `IKizunaSync` | No | Used instead of the client seeded by [`createKizunaSyncPlugin` or `provideKizunaSync`](./initializing.md), resolved through [useKizunaSync](./use-kizunasync.md). Default: the provided client. |
| `opts.connectivity` | `IConnectivity` | No | A port that replaces the app client's own for `isOnline` only; the sync loop keeps following the client's. Pass one when the banner should read a different signal, such as a gate the app controls. Default: `connectivity` on the resolved client, which is the port its sync loop follows: the `connectivity` option of [`createSupabaseKizunaSync`](../javascript/initializing.md), else the driver's network signal ([`createWebWorkerDriver`](../javascript/create-web-worker-driver.md) and [`openExpoDriver`](../expo/open-expo-driver.md) both carry one), else `alwaysOnline`. |

## Returns

`IUseSyncStatusResult`. Every state field is a ref, `isStalled`, `nextRetryAt`, `needsReset`, and `softBlockReason` are computed refs, and `syncNow` is a plain function.

| Name | Type | Required | Description |
|---|---|---|---|
| `outboxDepth` | `Ref<number>` | — | Queued mutations waiting for a push, from `getOutboxDepth()`. `0` until the first read resolves. Documented on [Outbox depth](../javascript/outbox-depth.md). |
| `isSyncing` | `Ref<boolean>` | — | `true` while a `syncNow()` call from this composable is in flight. A background poll leaves it `false`, so a button spinner does not flicker with the automatic loop. |
| `lastError` | `Ref<Error \| null>` | — | The last `syncNow()` failure, the last failed snapshot read, or the last error-level verdict event. Cleared at the start of the next `syncNow()`. |
| `checkpoint` | `Ref<TCheckpointState>` | — | The durable pull cursor, schema version, soft-block flag, and soft-block reason, from `getCheckpoint()`. Documented on [Checkpoint](../javascript/checkpoint.md). |
| `checkpoint.value.cursor` | `TCursor` | — | The opaque server cursor the last closed pull boundary wrote. `''` before the first read resolves, then `'0'` until the first boundary closes. |
| `checkpoint.value.schemaVersion` | `number` | — | The schema version the cursor belongs to. `0` in the placeholder the composable holds before the first read. |
| `checkpoint.value.softBlocked` | `boolean` | — | `true` after a reset signal, while the client applies nothing and leaves the cursor untouched. |
| `checkpoint.value.softBlockReason` | `'reset_required' \| 'identity_changed' \| undefined` | — | Why the client is soft-blocked: `reset_required` when the server's schema gate answered the reset signal, `identity_changed` when a token of another user than the one the local database belongs to reached the engine. Absent while `softBlocked` is `false`. |
| `isOnline` | `Ref<boolean>` | — | The current reading of the connectivity port, updated on every transition it emits. The port is the app client's `connectivity` unless `opts.connectivity` replaces it. |
| `health` | `Ref<ISyncHealth>` | — | The automatic loop's own snapshot, from `getSyncHealth()` and refreshed through `onSyncHealth`. Documented on [Sync health](../javascript/sync-health.md). |
| `health.value.phase` | `'idle' \| 'syncing' \| 'backoff' \| 'stalled' \| 'offline'` | — | What the loop is doing right now. Derived on every read, because connectivity changes without telling the tracker its new value. |
| `health.value.consecutiveFailures` | `number` | — | Failed attempts since the last success. Reset to `0` by a settled success. |
| `health.value.nextAttemptAt` | `number \| null` | — | Epoch milliseconds of the next armed automatic attempt. `null` when none is armed, which is the case with the poll off or the client disposed. |
| `health.value.attemptStartedAt` | `number \| null` | — | Epoch milliseconds when the attempt now in flight reached the wire. `null` while idle. |
| `health.value.lastSuccessAt` | `number \| null` | — | Epoch milliseconds of the last attempt that settled successfully. `null` before the first one. |
| `health.value.lastError` | `ISyncHealthError \| null` | — | The last recorded failure as `{ code, message, at }`, where `code` is `null` when the failure carried none. |
| `health.value.softBlockReason` | `'reset_required' \| 'identity_changed' \| null` | — | Why sync is soft-blocked until a reset, recorded from the `RESET_REQUIRED` event that latched the block, or from the checkpoint when the client opens a database that is already blocked. `null` while sync is not soft-blocked. |
| `isStalled` | `ComputedRef<boolean>` | — | `true` when `health.value.phase` is `stalled`, which means the attempt in flight has not settled for two poll ticks. |
| `nextRetryAt` | `ComputedRef<number \| null>` | — | The same value as `health.value.nextAttemptAt`, lifted to the top level for a banner. |
| `needsReset` | `ComputedRef<boolean>` | — | `true` when `checkpoint.softBlocked` is set, which only `RESET_REQUIRED` latches. A reset action belongs on this flag, never on `lastError`, which also carries verdicts a reset would not fix. A `CHECKPOINT_EXPIRED` event rehydrates on its own. |
| `softBlockReason` | `ComputedRef<'reset_required' \| 'identity_changed' \| null>` | — | The same value as `health.value.softBlockReason`, lifted to the top level beside `needsReset`, so a banner can tell a schema reset from a change of signed-in account. `null` while sync is not soft-blocked, and again once `reset()` clears the block. |
| `syncNow` | `() => Promise<void>` | — | Runs `sync()`, then re-reads the outbox depth and the checkpoint, so the refs are current when the promise settles. |

## Errors

`syncNow` never rejects. It clears `lastError`, awaits [`sync()`](../javascript/sync.md), and puts any failure in `lastError`, so a component reads the outcome from the ref. A failed snapshot read lands in `lastError` the same way and leaves the previous depth and checkpoint in place.

A composable that runs outside the provide scope and passes no `{ client }` override throws from [useKizunaSync](./use-kizunasync.md) instead.

`MUTATION_REJECTED`, `BATCH_ABORTED`, and `DEAD_LETTER` also reach `lastError`, worded by the shared verdict mapping: `Write rejected`, `Batch aborted`, and `Sync gave up`. The durable record of the same events is the journal that [useRejections](./use-rejections.md) reads, and `lastError` holds only the most recent one.

## Notes

`isSyncing` and `health` answer different questions. The first tracks your own `syncNow()` call, the second tracks the loop that runs between your calls, which is what separates a queued retry from a blocked request from an offline device. A banner reads `health`; a button reads `isSyncing`.

`isStalled` and `nextRetryAt` are computed refs over `health`, so they track it without a second subscription. The second name differs from the snapshot's `nextAttemptAt`, which [Sync health](../javascript/sync-health.md#returns) documents.

`syncNow` is not wrapped in a ref, so destructuring it is safe. The state fields are refs and lose their reactivity if you spread the result into a plain object; pass the result around whole, or keep the refs.

[Sync goes quiet after sleep, background, or a token expiry](../../operations/troubleshooting.md#sync-goes-quiet-after-sleep-background-or-a-token-expiry) diagnoses an `outboxDepth` that stays put while `isOnline` is `true`. A failure streak that starts after a long spell in the background often begins with an expired access token. The refresh timer runs throttled while the app sits in the background. Supabase sizes those lifetimes in [Recommended values for access token expiration](https://supabase.com/docs/guides/auth/sessions#what-are-recommended-values-for-access-token-jwt-expiration). Kizuna adds the foreground refresh before the next run. The retry therefore never carries an expired token.

`onScopeDispose` releases the engine, connectivity, and health subscriptions with the owning component, so a route change leaves no listener behind.

## Related reference

- [useKizunaSync](./use-kizunasync.md)
- [useRejections](./use-rejections.md)
- [JavaScript: Sync health](../javascript/sync-health.md)
- [JavaScript: Outbox depth](../javascript/outbox-depth.md)
- [JavaScript: Subscribe to events](../javascript/on.md)
- [React: useSyncStatus](../react/use-sync-status.md)
