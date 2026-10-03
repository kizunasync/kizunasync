---
title: Build integration
description: What a browser bundle has to preserve for the worker driver to open.
status: alpha
docType: reference
library: javascript
pageKind: guide
audience: app-developer
---

# JavaScript: Build integration

[Open the browser driver](./create-web-worker-driver.md) spawns a module worker, and that worker loads a [WebAssembly](https://grokipedia.com/page/WebAssembly) build of the Rust engine with [SQLite](https://grokipedia.com/page/SQLite) inside it. Both have to survive the bundle. Vite needs no configuration for either. Metro needs one line naming the engine binary as an asset, plus the same two requirements below that every bundler needs. On Expo SDK 57, Metro's development server also needs lazy bundling turned off.

## Examples

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({})
```

Vite recognizes both URL forms the driver uses and emits the worker and the WebAssembly file as its own chunks. You should now see the app open its database in the browser rather than fail on a worker that did not load.

### Expo web

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.resolver.assetExts.push('wasm')

module.exports = config
```

Metro compiles `import.meta` to a registry the worker bundle does not carry, so `openExpoDriver` hands the driver a function that resolves the engine binary's URL through Metro's asset registry, and the driver calls it when the worker starts. Without the `assetExts` entry above, Metro refuses to bundle the file at all.

### Expo web development server

On Expo SDK 57, the Expo web target needs `expo` 57.0.26 or later in development. With `expo` 57.0.25, `expo start` fails to bundle it with `Worker chunk not found for: .../expo-sqlite/web/worker.ts`, because lazy bundling leaves web-worker modules out of the graph, and `npx expo install expo` moves to the fixed release. Keep lazy bundling on and do not set `EXPO_NO_METRO_LAZY`, because Metro loads the Kizuna engine worker as a split bundle and with lazy bundling off the web driver cannot start that worker (`Bundle splitting is required for Web Worker imports`).

On iOS and Android, Expo Go cannot load the engine, so those targets need a development build, as [Expo: Rust engine](../expo/rust-engine.md#when-neither-condition-holds) explains.

## Requirements

| Requirement | Why |
|---|---|
| The worker survives as its own chunk | It is spawned from a module URL as an ES module, which bundlers recognize and emit separately. A build that inlines it or rewrites it as a classic worker breaks the module imports it makes. |
| The WebAssembly file is served where the build put it | The worker imports the engine binary as a URL and hands the runtime an explicit locator for it. Vite rewrites that URL itself; a bundler that cannot, such as Metro, needs the page to resolve the asset and pass it as `options.wasmUrl` to [`createWebWorkerDriver`](./create-web-worker-driver.md), which `openExpoDriver` does automatically on Expo web. Without either route the default guess resolves to the application shell, which then fails to compile as WebAssembly. |
| No cross-origin isolation is needed | Nothing here needs `COOP` or `COEP` headers, because neither the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool nor the [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) fallback uses shared memory. [Expo](https://expo.dev) web opens the same driver and has the same requirement, which is none. |

## Notes

The browser always runs the Rust engine. The driver carries it, so no build setting and no environment variable selects it. [Initializing](./initializing.md#returns) reports which core a client is running, and [Project status](../../getting-started/status.md#engine-selection) lists every lane.

Keep the Node entry points out of the browser graph. `kizunasync` and `kizunasync/supabase` are the only subpaths a browser bundle needs beside `kizunasync/web`, and importing a native driver subpath instead is what usually breaks a build with a missing module.

[Vite](../../getting-started/vite.md#1-install) shows the same configuration inside a running project, with the client wiring that follows it.

## Related reference

- [Open the browser driver](./create-web-worker-driver.md)
- [Browser file store](./create-web-file-store.md)
- [Initializing](./initializing.md)
- [Installing](./installing.md)
