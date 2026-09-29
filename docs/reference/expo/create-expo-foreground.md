---
title: Foreground
description: Wrap AppState as the port that refreshes the session and wakes sync on resume, for an app that passes its own.
status: alpha
docType: reference
library: expo
pageKind: method
audience: app-developer
---

# Expo: Foreground

`createExpoForeground` wraps [React Native](https://reactnative.dev)'s `AppState` as the `IForeground` port. [`openExpoDriver`](./open-expo-driver.md) and [`openOpSqliteDriver`](./open-op-sqlite-driver.md) already build one and hand it to the app client, so most apps never call this function. An app calls it to pass a port of its own through the `foreground` option of `createSupabaseKizunaSync`, which wins over the driver's: a gate that decides by itself when a resume should sync.

A backgrounded app has its timers throttled, so the poll loop is not a reliable path back to a live session; a return to the foreground is, and this is the signal that carries it.

## Examples

### Pass a gate of your own

The gate in `src/foreground.ts` wraps this port and drops the signal while the app has paused sync.

```ts
// src/foreground.ts
import type { IForeground } from '@kizunasync/core'
import { createExpoForeground } from '@kizunasync/expo'

const appState = createExpoForeground()
let paused = false

export function setSyncPaused(value: boolean): void {
  paused = value
}

export const foreground: IForeground = {
  subscribe: (onForeground) =>
    appState.subscribe(() => {
      if (!paused) {
        onForeground()
      }
    }),
}
```

`src/kizunasync.ts` from [Initializing](./initializing.md) then passes it as `foreground`.

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { openExpoDriver } from '@kizunasync/expo'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { foreground } from './foreground'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: openExpoDriver('todos.db'),
  config,
  foreground,
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This factory takes no arguments. The port reads `AppState` directly. |

## Returns

`IForeground`.

| Name | Type | Required | Description |
|---|---|---|---|
| `subscribe` | `(onForeground: () => void) => () => void` | — | Registers an `AppState` change listener and returns the function that removes it. The callback fires only on a transition into `active` from a state that was not `active`, so a notification-shade pull or a repeated `active` reading does not count as a foreground. |

## Errors

Nothing is thrown. An `AppState.currentState` that the native module has not seeded reads as `unknown`, which is not `active`, so the first real transition into `active` fires.

## Notes

A foreground signal drives three things in order. The app client owns all three rather than the port. First it refreshes the Supabase session, under the same `sessionTimeoutMs` deadline the pull and push use. Then it reconnects Realtime when the client holds channels but the socket is down. Then it wakes the scheduler. A refresh that fails does not cancel the wake, because a missing or timed-out session stays retryable. The next attempt recovers.

Refreshing before the wake is the point. Without it the next run rides whatever token the Supabase client happens to hold, which after a long spell in the background is often an expired one. Set `refreshOnForeground: false` on [`createSupabaseKizunaSync`](../javascript/initializing.md#parameters) when your host already owns the refresh.

The engine treats a signal as a hint and never as a data path. Rows arrive through the pull that the wake triggers, which [Sync](../javascript/sync.md) describes.

Without a foreground port, neither the refresh nor the wake happens on resume, and the next run waits for the ordinary 15-second poll. That is the shape [Sync goes quiet after sleep, background, or a token expiry](../../operations/troubleshooting.md#sync-goes-quiet-after-sleep-background-or-a-token-expiry) diagnoses. Both Expo drivers carry a port, so a gate you pass in its place has to keep firing on a real return to `active`. On web, [`createSupabaseKizunaSync`](../javascript/initializing.md) listens to the document instead, so this factory is the native half of the same job.

Supabase's own client needs a separate `AppState` listener calling [`startAutoRefresh`](https://supabase.com/docs/reference/javascript/auth-startautorefresh#examples) and [`stopAutoRefresh`](https://supabase.com/docs/reference/javascript/auth-stopautorefresh#examples), which [Initializing](./initializing.md) shows in `src/supabase-client.ts`. Kizuna's port covers the sync side of a resume; that listener covers the Supabase client's own timer.

## Related reference

- [Initializing](./initializing.md)
- [Connectivity](./create-expo-connectivity.md)
- [JavaScript: Initializing](../javascript/initializing.md)
- [React: useSyncStatus](../react/use-sync-status.md)
