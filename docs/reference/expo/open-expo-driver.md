---
title: Open the SQLite driver
description: Name the local store and carry the device ports: expo-sqlite on device, the @kizunasync/web worker driver on Expo web.
status: alpha
docType: reference
library: expo
pageKind: method
audience: app-developer
---

# Expo: Open the SQLite driver

`openExpoDriver` returns the `IStoreLocator` the client is built on, and the platform decides which one. [Initializing](./initializing.md) passes it to `createSupabaseKizunaSync` in `src/kizunasync.ts`, and nothing else in the app calls it. An app needs this page only to change the database name, to switch to the [op-sqlite driver](./open-op-sqlite-driver.md), or to diagnose an error the first engine call reports.

On iOS and Android the call returns at once and opens nothing. The locator names the expo-sqlite file and carries two platform ports: a NetInfo [connectivity](./create-expo-connectivity.md) port and an `AppState` [foreground](./create-expo-foreground.md) port. The file path is read on first use: when the app client first needs its engine, the driver opens expo-sqlite once to learn the path, closes that handle, and the Rust kernel opens the same file through UniFFI, so no SQL runs in the page. On [Expo](https://expo.dev) web the call returns [`createWebWorkerDriver`](../javascript/create-web-worker-driver.md) from `@kizunasync/web`, passing it the resolver for the engine binary's asset URL, which needs `wasm` in Metro's `resolver.assetExts`. The driver calls that resolver when its worker starts, so neither the import of `src/kizunasync.ts` nor a static render, which has no `location`, runs it. That driver carries the Rust engine in a dedicated worker rather than a local [SQLite](https://grokipedia.com/page/SQLite) connection, and Metro bundles the worker as its own JavaScript bundle.

## Examples

### Basic

The driver goes to `createSupabaseKizunaSync` together with the Supabase client and the config. This is the whole `src/kizunasync.ts` from [Initializing](./initializing.md).

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { openExpoDriver } from '@kizunasync/expo'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: openExpoDriver('todos.db'),
  config,
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | The database, such as `todos.db`. On device it is the expo-sqlite file name. On web it names the database the worker opens, and the lock and channel the tabs coordinate on. Build one driver per database, in the module that builds the app client. |

## Returns

`IStoreLocator`, returned synchronously. [Drivers and the TCK](../drivers-and-tck.md#port-model) defines the port.

| Name | Type | Required | Description |
|---|---|---|---|
| `databasePath` | `string \| null` | — | On device, the file expo-sqlite reports for `name`. The first read opens expo-sqlite, reads the path, closes the handle, and keeps the path for every later read. The app client makes that read on its first engine call. On web, the `name` passed in, which is the database the worker opens. |
| `platformPorts.connectivity` | `IConnectivity` | — | The network signal the app client follows when it is given no `connectivity` option. On device, the NetInfo port [`createExpoConnectivity()`](./create-expo-connectivity.md) builds with its default gate. On web, the browser's online signal from `@kizunasync/web`. |
| `platformPorts.foreground` | `IForeground` | — | The app-became-visible signal the app client follows when it is given no `foreground` option. On device, the `AppState` port [`createExpoForeground()`](./create-expo-foreground.md) builds. Absent on web, where `createSupabaseKizunaSync` listens to the document instead. |
| `engineTransport` | `TEngineTransportFactory` | — | Web only. The live connection to the [Rust engine](./rust-engine.md) running in the worker. The web driver also carries an optional `durability` reading; [Open the browser driver](../javascript/create-web-worker-driver.md) documents that shape in full. |

Neither port subscribes to NetInfo or `AppState` before the app client asks it to.

## Errors

On device the call throws nothing. The path read on the app client's first engine call can fail: expo-sqlite throws while opening or closing the file, or it reports no path, which throws `openExpoDriver: expo-sqlite did not report a databasePath for "<name>"`. The app client turns that failure into a `TEngineError` with code `ENGINE_UNAVAILABLE` that carries the expo-sqlite message, keeps it, and rejects every later engine call with the same error. The pinned expo-sqlite version declares both `databasePath` and `closeSync` as required, so the missing path is a defensive case.

On web nothing is opened here either. The worker starts on the client's first engine call, so an open failure surfaces there, and so does the asset URL. When Metro did not register the engine binary as an asset, the resolver throws `@kizunasync/expo: Metro did not register kizunasync_wasm_bg.wasm as an asset; add "wasm" to resolver.assetExts in metro.config.js` as the worker starts, and the engine calls fail with `ENGINE_UNAVAILABLE`, whose message carries that text after `this tab's own promotion failed:`.

## Notes

The app client follows the driver's ports only when it is given none of its own. An explicit `connectivity` or `foreground` option to `createSupabaseKizunaSync` wins over them; [Connectivity](./create-expo-connectivity.md) and [Foreground](./create-expo-foreground.md) describe when to pass one.

One app client per database is what `src/kizunasync.ts` gives you, because every import shares its module-scope client. On web two clients would not corrupt anything, because the second one becomes a follower of the first, but they would run two schedulers over the one engine.

Expo web needs no COOP or COEP headers and no `SharedArrayBuffer`. The store is the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool, or the relaxed [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) store where the browser cannot support that pool, and neither uses shared memory. A pool another tab is holding is a different case. The worker retries it for about 1.8 s, then fails with `STORE_BUSY` and names the database. It never swaps in an empty store.

[op-sqlite driver](./open-op-sqlite-driver.md) is the alternative on device, over the same `IStoreLocator` port and with the same two ports. Both name a file for the Rust kernel to open; keep this one for the default install and for Expo web, and reach for op-sqlite only when the app already depends on it for another reason.

## Related reference

- [Initializing](./initializing.md)
- [op-sqlite driver](./open-op-sqlite-driver.md)
- [Rust engine](./rust-engine.md)
- [JavaScript: Open the browser driver](../javascript/create-web-worker-driver.md)
- [JavaScript: Build integration](../javascript/build-integration.md)
