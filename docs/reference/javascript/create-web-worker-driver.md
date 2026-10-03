---
title: Open the browser driver
description: Open the browser driver, which carries the Rust engine in a dedicated worker over OPFS.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Open the browser driver

`createWebWorkerDriver(name, options?)` from `kizunasync/web` returns the driver a browser client is built on. It runs no SQL on the page. It carries the Rust engine instead, and the client reaches that engine in a dedicated worker, where SQLite is persisted through the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool. Nothing here uses shared memory, so a browser build needs no cross-origin isolation.

[Initializing](./initializing.md#create-the-app-client) calls it once, in `src/kizunasync.ts`; nothing else in the app calls it. Read this page to change the database name, to point a bundler that does not rewrite `import.meta.url` at the WebAssembly file, or to understand the errors a store that cannot open raises.

## Examples

### Basic

An excerpt of `src/kizunasync.ts`:

```ts
// src/kizunasync.ts (excerpt)
import { createWebWorkerDriver } from 'kizunasync/web'

const driver = createWebWorkerDriver('todos.db')
```

### Pass it to the client

The whole module, as [Initializing](./initializing.md#create-the-app-client) shows it:

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { createWebWorkerDriver } from 'kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
})
```

The driver hands the app client the browser's online and offline signal, so the call passes no `connectivity`. Build the driver once, in the module that exports the app client. A second client on the same name joins the same election, loses it to the first, and runs its own scheduler over the one engine.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | The database the engine opens, such as `'todos.db'`. It names the lock and the channel as well, so two clients that pass the same name share one engine, and two names are two independent local stores. `':memory:'` opens a private in-memory store that dies with the tab. |
| `options.wasmUrl` | `string \| URL \| (() => string \| URL \| undefined)` | No | Where the worker fetches `kizunasync_wasm_bg.wasm`: the URL itself, or a function the driver calls when the worker starts, whose `undefined` answer keeps the worker's own reference. Unset under Vite, which rewrites the worker's own reference to the binary; `kizunasync/expo` passes its asset resolver here under Metro, which does not. |
| `options.logger` | `ILogger` | No | Where the driver reports a degradation. A tab without Web Locks logs a `driver.memory_store` warning here, naming the database it could not share, and so does a tab whose browser refuses OPFS storage, as Safari Private Browsing does. Pass the logger you give `createKizunaSync`. |

## Returns

`IWebEngineDriver`, returned synchronously. Building it starts nothing: the election, and the worker if this tab wins it, wait for the app client's first engine call, so importing the module that builds it costs nothing until the client is used.

| Name | Type | Required | Description |
|---|---|---|---|
| `databasePath` | `string \| null` | — | The `name` this driver was given, unchanged. `':memory:'` reaches the engine as a path and opens a private in-memory store for it. `null` in a tab without Web Locks, where the engine opens a private in-memory store instead of the named database (see Notes). |
| `engineTransport` | `TEngineTransportFactory` | — | Opens one engine for this database. The app client calls it on its first engine call, and the call joins or wins the election for that name. |
| `platformPorts` | `{ connectivity?: IConnectivity; foreground?: IForeground }` | — | Holds `connectivity`, the browser's network signal built by [Browser connectivity](./create-web-connectivity.md), which the app client follows unless its own `connectivity` option replaces it. `foreground` is left unset, so `createSupabaseKizunaSync` watches the document instead. |
| `durability` | `TStoreDurability \| undefined` | — | Absent until the engine has opened its store and answered `store_kind`. `'full'` on the OPFS pool, `'relaxed'` on the [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) fallback, `'none'` on a private in-memory store. A tab without Web Locks reports `'none'` from the start. |

## Errors

A worker that cannot open the database fails the client's first engine call. A worker-level failure, such as a [WebAssembly](https://grokipedia.com/page/WebAssembly) asset that did not load, fails every outstanding call rather than leaving them pending. A bundler that does not rewrite the worker's own `import.meta.url`, such as Metro, fails the worker with `the kizunasync/web worker cannot locate kizunasync_wasm_bg.wasm: this bundler does not rewrite import.meta.url, so pass wasmUrl to createWebWorkerDriver` unless the caller passed `options.wasmUrl`. A follower's call that no leading tab takes within 30 seconds fails with `ENGINE_UNAVAILABLE`. Once a leading tab has taken a call, the call waits for its answer as long as the engine runs it. When the leading tab goes away, the tab promoted in its place re-issues on its own worker every call no leader took, and each of those runs exactly once. A call the old leader took drains from where it runs, and fails with `ENGINE_UNAVAILABLE` only when that leader says goodbye without answering it, or when 5 seconds pass after another tab took over with no answer. [Troubleshooting](../../operations/troubleshooting.md#local-web-database-will-not-open) lists what usually causes these.

## Notes

The driver spawns the worker from a module URL the bundler rewrites, so the worker chunk and the WebAssembly asset have to survive your build. A bundler that does not rewrite the worker's own `import.meta.url`, such as Metro, needs `options.wasmUrl` set to the asset URL, or to a function that resolves it when the worker starts, instead. [Build integration](./build-integration.md) covers both routes; Vite needs neither.

One tab per database leads the engine. Every tab races for an exclusive [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) named after the database; the winner starts the worker, and the others post their calls to it over a `BroadcastChannel` and receive its events the same way. A follower spawns no worker and opens no database. When the leader goes away, a waiting tab is promoted and starts a worker behind the transport the client already holds, so the client is never rebuilt. As its worker opens the store, the leading tab resets the attachment transfers a previous engine left claimed, once per open, so a tab that joins later never resets the uploads the leader has in flight.

A leading tab that closes says goodbye first: on `pagehide`, and only on `pagehide` (a `visibilitychange` to hidden still leads and still answers calls, so it announces nothing), it posts a `leader-closed` message on the same channel before the browser tears the page down. A promoted follower that hears it takes over at once instead of waiting out the hand-over budget it would otherwise sit through with no news from the tab that closed.

Because the driver carries the engine, a browser client always reports `rust` on [Initializing](./initializing.md#returns). There is no rollback on this path and nothing to select: the transport is the only route to these rows, so a store the worker cannot open fails the client instead of degrading it.

Expo and [React Native](https://reactnative.dev) on device open their local database with [Expo: Open the SQLite driver](../expo/open-expo-driver.md) instead, which returns the same port over expo-sqlite. Expo web returns this driver.

The worker opens the database on the OPFS pool and falls back to IndexedDB only when the browser lacks that pool: no `navigator.storage.getDirectory`, no synchronous access handles, or storage access refused with `SecurityError`, as in private browsing. Any other OPFS failure, apart from the refused OPFS directory of Safari Private Browsing described below, fails the open with `STORE_UNAVAILABLE` rather than opening IndexedDB, because the database may already live in OPFS and IndexedDB would show an empty store in its place. A browser that exposes neither OPFS nor `IndexedDB` cannot open a store at all, and the worker reports both failures together.

A pool some other context already holds, one that opened the same underlying database and has not released its handles, is a separate case from a missing pool: the worker retries for about 1.8 seconds and then fails the open with `STORE_BUSY` rather than falling back to IndexedDB, naming the database. Retrying the open once that other context has closed commonly succeeds.

Tabs share a database through Web Locks, which browsers offer only in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts): a page served over HTTPS, or from `localhost` during development. Without them no two tabs could agree on which one runs the engine, so the driver keeps each tab on a private in-memory store. `databasePath` is `null`, `durability` is `'none'`, writes last only as long as the tab, and `options.logger` receives a `driver.memory_store` warning that names the database. Serve the app from a secure origin to keep the named database, and ask for `':memory:'` when a store that dies with the tab is what you want. A static render in Node has no Web Locks either, so a driver built there reports the same private store and starts nothing, because nothing uses the client during the render.

Safari Private Browsing refuses the OPFS directory itself with `UnknownError`, so no OPFS store is reachable in that tab, and the worker keeps a private in-memory store the way a tab without Web Locks does. `durability` is `'none'`, writes last only as long as the tab, and `options.logger` receives a `driver.memory_store` warning that names the database. The worker does not open IndexedDB there, because that would create a second persistent store that can later diverge from an OPFS one.

## Related reference

- [Build integration](./build-integration.md)
- [Browser connectivity](./create-web-connectivity.md)
- [Browser file store](./create-web-file-store.md)
- [Initializing](./initializing.md)
- [Drivers and TCK](../drivers-and-tck.md)
