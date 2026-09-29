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

On Expo SDK 57 (`expo` 57.0.25 with `@expo/metro-config` 57.0.12), `expo start` fails to bundle the web target with `Worker chunk not found for: .../expo-sqlite/web/worker.ts`. Any app that imports `expo-sqlite` hits it, with or without Kizuna, because lazy bundling in the development server leaves web-worker modules out of the graph. The production export is unaffected. Start the development server with `EXPO_NO_METRO_LAZY=1`, which turns lazy bundling off:

:::tabs{group=pm}
```bash tab=npm
EXPO_NO_METRO_LAZY=1 npx expo start
```

```bash tab=pnpm
EXPO_NO_METRO_LAZY=1 pnpm expo start
```

```bash tab=yarn
EXPO_NO_METRO_LAZY=1 yarn expo start
```

```bash tab=bun
EXPO_NO_METRO_LAZY=1 bunx expo start
```
:::

To start that way every time, set the variable in the `start` script:

```jsonc
// package.json (excerpt)
{
  "scripts": {
    "start": "EXPO_NO_METRO_LAZY=1 expo start"
  }
}
```

On iOS and Android, Expo Go cannot load the engine, so those targets need a development build, as [Expo: Rust engine](../expo/rust-engine.md#when-neither-condition-holds) explains.

## Requirements

| Requirement | Why |
|---|---|
| The worker survives as its own chunk | It is spawned from a module URL as an ES module, which bundlers recognize and emit separately. A build that inlines it or rewrites it as a classic worker breaks the module imports it makes. |
| The WebAssembly file is served where the build put it | The worker imports the engine binary as a URL and hands the runtime an explicit locator for it. Vite rewrites that URL itself; a bundler that cannot, such as Metro, needs the page to resolve the asset and pass it as `options.wasmUrl` to [`createWebWorkerDriver`](./create-web-worker-driver.md), which `openExpoDriver` does automatically on Expo web. Without either route the default guess resolves to the application shell, which then fails to compile as WebAssembly. |
| No cross-origin isolation is needed | Nothing here needs `COOP` or `COEP` headers, because neither the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool nor the [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) fallback uses shared memory. [Expo](https://expo.dev) web opens the same driver and has the same requirement, which is none. |

## Notes

The browser always runs the Rust engine. The driver carries it, so no build setting and no environment variable selects it. [Initializing](./initializing.md#returns) reports which core a client is running, and [Project status](../../getting-started/status.md#engine-selection) lists every lane.

Keep the Node entry points out of the browser graph. `@kizunasync/core` and `@kizunasync/supabase` are the only packages a browser bundle needs beside `@kizunasync/web`, and pulling in a native driver package instead is what usually breaks a build with a missing module.

[Vite](../../getting-started/vite.md#1-install) shows the same configuration inside a running project, with the client wiring that follows it.

## Related reference

- [Open the browser driver](./create-web-worker-driver.md)
- [Browser file store](./create-web-file-store.md)
- [Initializing](./initializing.md)
- [Installing](./installing.md)
