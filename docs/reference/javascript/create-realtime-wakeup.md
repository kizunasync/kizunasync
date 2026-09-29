---
title: Create the Realtime wakeup
description: Turn the database's contentless broadcast into a pull-now hint.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Create the Realtime wakeup

`createRealtimeWakeup(client, options)` from `@kizunasync/supabase` builds the doorbell: one Realtime channel per synced table, whose only effect is to ask the scheduler to pull now. The broadcast payload is dropped, so this is never a data path.

The `createSupabaseKizunaSync` call in `src/kizunasync.ts`, shown on [Initializing](./initializing.md#create-the-app-client), derives this doorbell over the configured tables by itself, and its `wakeupOptions` change the prefix, the privacy, the logger, and the timers of the derived doorbell. Call this factory only to listen on a different set of tables or to wrap the port, and pass the result as `wakeup` in that same file. Read this page to see what one signal does and how a dropped channel recovers.

## Examples

### Basic

```ts
// src/kizunasync.ts (excerpt)
import { createRealtimeWakeup } from '@kizunasync/supabase'
import { supabase } from './supabase-client'

const wakeup = createRealtimeWakeup(supabase, { tables: ['todos'] })
```

### Pass it to the client

The whole module, here on public channels for a demo project:

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { createRealtimeWakeup, createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
  wakeup: createRealtimeWakeup(supabase, { tables: ['todos'], private: false }),
})
```

For public channels alone, `wakeupOptions: { private: false }` on the same call gives the derived doorbell that setting without this factory.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `client` | `SupabaseClient` | Yes | The supabase-js client. Its Realtime slice holds the socket and the channels. |
| `options.tables` | `readonly string[]` | Yes | The tables to listen on. Each opens its own channel, and a signal on any of them wakes one pull of everything. |
| `options.topicPrefix` | `string` | No | The channel topic prefix, which must match the prefix the database triggers broadcast on. Changing it here without changing the installed triggers means no signal ever arrives. Default: `'kizunasync'`. |
| `options.private` | `boolean` | No | Opens each channel as private, so [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization#how-it-works) decides who may read the topic. Default: `true`. |
| `options.logger` | `ILogger` | No | Sink for the channel transitions this adapter reports: a drop, each reconnect attempt, and a recovery. Default: silent. |
| `options.setTimer` / `options.clearTimer` | `(callback: () => void, delayMs: number) => unknown` / `(handle: unknown) => void` | No | Timer pair for the re-subscribe backoff. Default: the platform `setTimeout` and `clearTimeout`. |

## Returns

`IWakeup`, the value [Initializing](./initializing.md#parameters) takes as its `wakeup` argument.

| Name | Type | Required | Description |
|---|---|---|---|
| `subscribe` | `(onSignal: () => void) => () => void` | — | Opens every channel and returns the function that closes them. The engine calls it once, when the app client's first use opens it, and disposes it with the client. |

### What one signal does

| Name | Type | Required | Description |
|---|---|---|---|
| The payload | — | — | Dropped before anything else. The message tells the client that a table changed and never what changed. |
| The scheduler | — | — | Woken. A burst of signals collapses into one attempt scheduled 250 milliseconds out, and the wake clears the failure streak on [Sync health](./sync-health.md#returns). |

## Errors

This factory throws nothing. A channel that reports `CHANNEL_ERROR`, `TIMED_OUT`, or `CLOSED` counts as dead, and the port re-subscribes it. The backoff starts at one second and doubles to a ceiling of 30 seconds, so a channel that keeps failing retries forever at a bounded rate rather than giving up. The port releases the previous handle before each rejoin, so a retry does not leak a dead channel onto the socket.

## Notes

Correctness never depends on the doorbell. A missed signal only delays the next poll, which is why [Sync](./sync.md#parameters) arms a jittered poll by default and calls it the recovery path. Setting `realtimeWakeups: false` on [Define config](./define-config.md#parameters) builds no doorbell at all, and drops an explicit one as well.

A backgrounded tab is the case the reconnect above cannot catch: the socket can die without any status event, which Supabase describes under [silent disconnections](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794#understanding-the-problem-why-realtime-stops-silently). [Initializing](./initializing.md) reconnects the socket on a foreground signal for that reason.

A browser client recovers faster with two supabase-js options: a heartbeat callback that reconnects on a disconnected status, and the [Realtime](https://supabase.com/docs/guides/realtime) worker. Never enable that worker on [React Native](https://reactnative.dev), which has no worker to use.

The signal itself comes from the triggers the pack installs, which send a [broadcast from the database](https://supabase.com/docs/guides/realtime/broadcast#broadcast-from-the-database) naming only the table. [Realtime doorbell](../sql-pack.md#realtime-doorbell) documents the server half, and [Wake-ups](../../sync/protocol-overview.md#wake-ups) places it in the protocol.

## Related reference

- [Initializing](./initializing.md)
- [Define config](./define-config.md)
- [Sync](./sync.md)
- [Sync health](./sync-health.md)
- [SQL pack](../sql-pack.md)
