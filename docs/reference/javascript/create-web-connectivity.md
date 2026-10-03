---
title: Browser connectivity
description: Report the browser's online state and its transitions to the scheduler.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Browser connectivity

`createWebConnectivity()` from `@kizunasync/web` builds the connectivity port from the browser's own online state and its two transition events. The engine reads it before every run and wakes the scheduler when the state turns back on.

[Open the browser driver](./create-web-worker-driver.md) builds one and hands it to the app client as `platformPorts.connectivity`, so a standard app never calls this factory. The client exposes the port it follows as `kizunasync.connectivity`. Read this page to see what the engine does with the browser's online flag, or to read the same signal in a sync indicator.

## Examples

### Basic

```ts
// src/connectivity.ts
import { createWebConnectivity } from '@kizunasync/web'

export const connectivity = createWebConnectivity()
```

### Read the port the client follows

```ts
// src/online-badge.ts
import { kizunasync } from './kizunasync'

const badge = document.querySelector('#online-badge')

function render(online: boolean): void {
  if (badge !== null) {
    badge.textContent = online ? 'Online' : 'Offline'
  }
}

render(kizunasync.connectivity.isOnline())
kizunasync.connectivity.subscribe(render)
```

Reading `kizunasync.connectivity` keeps the badge and the engine on one source, so they never disagree about whether the device is online, and the read opens nothing. [React: useSyncStatus](../react/use-sync-status.md) and [Vue: useSyncStatus](../vue/use-sync-status.md) read the same port for `isOnline` when no `connectivity` option is passed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This factory takes no arguments. |

## Returns

`IConnectivity`, the value the browser driver carries as `platformPorts.connectivity` and [Initializing](./initializing.md#parameters) takes as its `connectivity` argument, which replaces the driver's.

| Name | Type | Required | Description |
|---|---|---|---|
| `isOnline` | `() => boolean` | — | Reads the browser's online flag. It reports `true` when there is no navigator at all and when the runtime exposes one without that flag, so an unknown environment is treated as online rather than as offline. |
| `subscribe` | `(onChange: (online: boolean) => void) => () => void` | — | Listens for the window's online and offline events and returns the function that removes both listeners. With no window, it subscribes to nothing and the returned function does nothing. |

### What the engine does with it

| Name | Type | Required | Description |
|---|---|---|---|
| A run while offline | — | — | [Sync](./sync.md) returns without reaching the wire, so no attempt is recorded and the failure streak does not grow. |
| A transition to online | — | — | Wakes the scheduler, which clears the streak and pulls the next attempt into a short debounce window, so a queued write flushes on reconnect; a local write wakes the scheduler the same way, without waiting for this transition. |
| The reported phase | `TSyncPhase` | — | `offline` on [Sync health](./sync-health.md#returns), which outranks every other phase while it holds. |

## Notes

The browser's flag is a weak signal, and this port inherits that. A captive portal, a dead route, and a link that is up but useless all leave it `true`, which is why the poll fallback rather than this port is the client's recovery path. [Sync](./sync.md#parameters) covers the poll and its default.

Server-side rendering is safe: with no window the port reports online and subscribes to nothing, so importing the module in a prerender does not touch a browser global.

Expo and [React Native](https://reactnative.dev) use [`createExpoConnectivity`](../expo/create-expo-connectivity.md) in its place, which reads the platform's own network state, and the Expo driver carries it on device the same way.

## Related reference

- [Initializing](./initializing.md)
- [Sync](./sync.md)
- [Sync health](./sync-health.md)
- [Open the browser driver](./create-web-worker-driver.md)
- [Expo: Expo connectivity](../expo/create-expo-connectivity.md)
