<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/web</span>
</h1>

Browser driver for Kizuna. It runs the Rust engine, compiled to WebAssembly, in a dedicated module Worker over the OPFS synchronous-access-handle pool. It also ships adapters for connectivity and for OPFS-backed attachment storage.

Browser counterpart of `kizunasync/expo`'s `expo-sqlite` driver on native, and what `kizunasync/expo` itself returns on Expo web. Pass `createWebWorkerDriver` to `createKizunaSync` from `kizunasync`. Query API and reactivity live in `kizunasync`; the engine behind them runs in the worker.

## Install

This workspace is private. Apps install the `kizunasync` package and import it as `kizunasync/web`.

```bash
npm install kizunasync
```

`kizunasync/web` depends only on `kizunasync`. The published package carries the wasm-bindgen output under `src/wasm/`. In this checkout `bun run cargo:wasm` generates all four files; the two committed ones are `src/wasm/kizunasync_wasm.d.ts` and `src/wasm/kizunasync_wasm_bg.wasm.d.ts`. `kizunasync_wasm.js` and `kizunasync_wasm_bg.wasm` are build output, ignored by `.gitignore` and rebuilt by the `wasm-build` job. Your bundler has to handle `new URL('./worker.ts', import.meta.url)` and the worker's own wasm URL. Vite does this automatically; no `optimizeDeps` entry is needed. Where the bundler leaves the wasm URL alone, pass `wasmUrl` to `createWebWorkerDriver`: a URL, or a function the driver calls when the worker spawns, so a driver built during a static render never resolves it.

## Exports

| Name | Returns | Description |
|------|---------|-------------|
| `createWebWorkerDriver(name)` | `IWebEngineDriver` | Store locator carrying the Rust engine for `name`, in a dedicated worker over OPFS or the relaxed IndexedDB fallback. Building it starts nothing |
| `createWebConnectivity()` | `IConnectivity` | `navigator.onLine` + `online`/`offline` events. SSR-safe. The driver already hands it to the app client as `platformPorts.connectivity` |
| `createWebFileStore()` | `IFileStore` | Content-addressed OPFS attachment store under `kizunasync-attachments/`. Building it touches no storage; the first operation opens the directory, and where OPFS is missing every operation fails with `STORE_UNAVAILABLE` |

## Get started

```ts
// src/kizunasync.ts
import { createKizunaSync, defineConfig } from 'kizunasync'
import { createRpcRemote } from 'kizunasync/supabase'
import { createWebWorkerDriver } from 'kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({ tables: { todos: { sync: 'read-write' } } })

export const kizunasync = createKizunaSync(createWebWorkerDriver('kizunasync-todos.db'), createRpcRemote(supabase), config)
```

Full wiring: [`examples/todo-react/src/kizunasync.ts`](../../examples/todo-react/src/kizunasync.ts) and [`examples/todo-vue/src/kizunasync.ts`](../../examples/todo-vue/src/kizunasync.ts).

## How the driver carries the engine

`IWebEngineDriver` is an `IStoreLocator`, so `createKizunaSync` accepts it. It names the database in `databasePath` and carries an `engineTransport`, which `createKizunaSync` reads first. The page opens no database of its own: reading around the engine's back would read a connection the engine does not own. Local reads go through the app client's query API.

Building the driver starts nothing, so the app client can live at module scope. The tab joins the election, and spawns the worker if it wins, on the app client's first engine call. The driver also carries `createWebConnectivity()` as `platformPorts.connectivity`: the app client's sync loop and `useSyncStatus` follow it unless you pass your own `connectivity`. The foreground signal stays with `createSupabaseKizunaSync`, which wakes the loop when the page becomes visible again.

There is no rollback and nothing to select. A store the worker cannot open fails the client with a typed error. A store another browser context holds arrives as `STORE_BUSY`.

## Storage and durability

The worker installs the OPFS synchronous-access-handle pool first. It falls back to a relaxed IndexedDB VFS only when the browser lacks that pool entirely: no dedicated-worker OPFS entry point, or storage access refused outright, as in private browsing. If another tab still holds the pool, the worker retries for about 1.8 s and then fails loud, naming the database; any other OPFS failure fails loud right away. Neither case swaps in an empty IndexedDB store behind a database that may still live in OPFS. Both paths are worker-only and neither uses `SharedArrayBuffer`. COOP, COEP, and `crossOriginIsolated` therefore do not matter to this driver.

The engine answers `store_kind` with the store it opened and the durability an acknowledged write gets there: `full` for the OPFS pool, `relaxed` for IndexedDB (survives orderly shutdown, not proven against an abrupt one), `none` for the private memory store a tab keeps without `navigator.locks`. `:memory:` opens that same kind of private in-memory store explicitly, on any tab, and it dies with the tab either way. `createWebWorkerDriver`'s optional `logger` reports why a tab fell back to the memory store.

## One engine per database, not per tab

Every tab on a database races for an exclusive Web Lock named after it. The winner starts the worker and serves the others over a `BroadcastChannel`. Followers spawn no worker and open no database.

When the leading tab closes or its worker dies, the lock is released and a waiting tab is promoted. It starts a worker behind the same transport object the client already holds, so the client is never rebuilt. A tab the user closes posts `leader-closed` on `pagehide`, so a follower can promote without waiting out the close timeout. A call no leader has taken yet is re-posted to the newly announced leader and still runs exactly once; a call a leader already accepted waits for its answer and fails with `ENGINE_UNAVAILABLE` only when that leader says goodbye without answering, or when leadership changes again and the hand-over budget passes with no answer.

Without `navigator.locks` (an insecure context, or a browser too old), there is nothing to race on: the page leads its own engine and keeps a private memory store, reporting `durability: 'none'`.

Bun tests cover the transport protocol, election, follower handover, and worker runtime against a scripted worker. The real browser round trip lives in the Playwright suite under `conformance/`.

## Related

- [Vite guide](../../docs/getting-started/vite.md)
- [Vanilla JavaScript guide](../../docs/getting-started/vanilla-js.md)
- [kizunasync/web reference](../../docs/reference/javascript/create-web-worker-driver.md)
- [Media and attachments](../../docs/attachments/media-and-attachments.md)
- [`@kizunasync/core`](../core/README.md)
- [Browser conformance](./conformance/README.md)
