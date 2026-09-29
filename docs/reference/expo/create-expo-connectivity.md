---
title: Connectivity
description: Wrap NetInfo as the connectivity port, for an app that passes its own gate instead of the driver one.
status: alpha
docType: reference
library: expo
pageKind: method
audience: app-developer
---

# Expo: Connectivity

`createExpoConnectivity` wraps `@react-native-community/netinfo` as the `IConnectivity` port. [`openExpoDriver`](./open-expo-driver.md) and [`openOpSqliteDriver`](./open-op-sqlite-driver.md) already build one with the default gate and hand it to the app client, so most apps never call this function. An app calls it to pass a port of its own through the `connectivity` option of `createSupabaseKizunaSync`, which wins over the driver's.

The engine reads the port to keep mutations queued instead of pushing into a dead link, and it treats a transition from offline to online as an instruction to flush the outbox now.

## Examples

### Use the reachability probe

This is `src/kizunasync.ts` from [Initializing](./initializing.md) with the gate switched, for an app that has pointed NetInfo's probe at a backend it controls.

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { createExpoConnectivity, openExpoDriver } from '@kizunasync/expo'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: openExpoDriver('todos.db'),
  config,
  connectivity: createExpoConnectivity({ gate: 'internet-reachable' }),
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `options` | `IExpoConnectivityOptions` | No | The gate selector. Default: `{}`. |
| `options.gate` | `'connected' \| 'internet-reachable'` | No | Which NetInfo reading decides `isOnline()`. `connected` reads the radio state and treats an unknown reading as online. `internet-reachable` prefers NetInfo's reachability probe once it has resolved; while the probe is `null` it reports online only when the radio state is explicitly connected, so an unknown radio reading counts as offline under this gate and as online under the default. Default: `'connected'`. |

## Returns

`IConnectivity`.

| Name | Type | Required | Description |
|---|---|---|---|
| `isOnline` | `() => boolean` | — | The cached reading, so the call is synchronous. `true` until the first NetInfo reading arrives, which matches the port's optimistic contract for an unknown state. |
| `subscribe` | `(onChange: (online: boolean) => void) => () => void` | — | Registers a transition listener and returns the function that removes it. The listener fires only when the value changes, never on a repeated reading. |

## Errors

This factory throws nothing. The port swallows a rejected `NetInfo.fetch()`, which leaves the optimistic default in place rather than reporting a device as offline on the strength of a failed probe.

## Notes

Pass a port explicitly in two cases: a different NetInfo gate, as in the example, or a gate of your own. A gate of your own is an `IConnectivity` that wraps this port and adds a condition the app controls, such as an in-app switch that keeps sync offline. Whichever port wins becomes the client's `connectivity`, and [`useSyncStatus`](../react/use-sync-status.md) reads that port with no argument, so the banner and the engine follow one signal.

The default gate trusts the radio. A real pull or push then decides reachability. Both are [Postgres](https://grokipedia.com/page/PostgreSQL) functions called through [`rpc`](https://supabase.com/docs/reference/javascript/rpc#parameters). A request that reaches the database settles the question NetInfo can only guess at. The two failures cost different amounts. A false negative from the reachability probe stops every sync attempt, with nothing to show the person using the app. A false positive costs one request that backs off. Switch to `internet-reachable` once you have pointed NetInfo's `reachabilityUrl` at a backend you control.

One internal NetInfo subscription serves every caller of one port. It is created when the first listener registers and removed when the last one detaches, so building a port subscribes to nothing, and an engine that disposes does not leave a permanent subscription behind.

A connectivity port gates and wakes sync and never carries data. Server-side changes arrive through the wake-up doorbell and the poll, which [Sync](../javascript/sync.md) describes.

A device that reports online while the outbox stays put is the shape [Sync goes quiet after sleep, background, or a token expiry](../../operations/troubleshooting.md#sync-goes-quiet-after-sleep-background-or-a-token-expiry) diagnoses. [Foreground](./create-expo-foreground.md) covers the other half of a resume: connectivity says the radio is back, the foreground signal says the app is, and each wakes the scheduler on its own.

## Related reference

- [Initializing](./initializing.md)
- [Foreground](./create-expo-foreground.md)
- [JavaScript: Browser connectivity](../javascript/create-web-connectivity.md)
- [JavaScript: Sync](../javascript/sync.md)
- [React: useSyncStatus](../react/use-sync-status.md)
