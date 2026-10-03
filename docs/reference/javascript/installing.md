---
title: Installing
description: Install the JavaScript client packages from npm.
status: alpha
docType: reference
library: javascript
pageKind: installing
audience: app-developer
---

# JavaScript: Installing

`@kizunasync/core` holds the app client, the config helpers, and the local query builder, `@kizunasync/supabase` wraps the supabase-js client it declares as a peer, and `@kizunasync/web` runs the Rust engine as [WebAssembly](https://grokipedia.com/page/WebAssembly) in a dedicated worker. `@supabase/supabase-js` is that Supabase client, which the app creates in `src/supabase-client.ts`.

## Install from npm

:::tabs{group=pm}
```bash tab=npm
npm install @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```

```bash tab=pnpm
pnpm add @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```

```bash tab=yarn
yarn add @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```

```bash tab=bun
bun add @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```
:::

## What each package holds

| Package | Contents |
|---|---|
| `@kizunasync/core` | `createKizunaSync`, `defineConfig`, the local query builder, the sync engine, and the shared [Types](./types.md). |
| `@kizunasync/supabase` | The Supabase composition and its adapters: [Create the RPC remote](./create-rpc-remote.md), [Create the Storage transfer](./create-supabase-transfer.md), [Create the Realtime wakeup](./create-realtime-wakeup.md), [Recover an anonymous session](./recover-anonymous-session.md). |
| `@kizunasync/web` | The browser ports: [Open the browser driver](./create-web-worker-driver.md), [Browser connectivity](./create-web-connectivity.md), [Browser file store](./create-web-file-store.md). |
| `@supabase/supabase-js` | Supabase's JavaScript client, a peer of `@kizunasync/supabase`. `src/supabase-client.ts` creates it with `createClient`, and the app client runs pull, push, the Realtime doorbell, and Storage transfers through it. Supabase documents the package under [Installing](https://supabase.com/docs/reference/javascript/installing). |

`@kizunasync/web` is the browser driver; on [Expo](https://expo.dev) and [React Native](https://reactnative.dev) install [`@kizunasync/expo`](../expo/installing.md) in its place, while the core and [Supabase](https://supabase.com) packages stay the same. [React](https://react.dev) apps add [`@kizunasync/react`](../react/installing.md) and [Vue](https://vuejs.org) apps add [`@kizunasync/vue`](../vue/installing.md) on top, and TypeScript then resolves `@kizunasync/core` imports.

## What the install resolves per platform

`@kizunasync/core` declares one optional dependency per platform under `publishConfig.optionalDependencies`: `@kizunasync/napi-darwin-arm64`, `@kizunasync/napi-darwin-x64`, `@kizunasync/napi-linux-x64-gnu`, `@kizunasync/napi-linux-arm64-gnu`, and `@kizunasync/napi-win32-x64-msvc`. Each one holds the [N-API](https://nodejs.org/api/n-api.html) library for a single platform. Each sets its own `os` and `cpu`. The registry release therefore installs the one the host machine matches. It skips the other four. Node and [Bun](https://bun.sh) then run the Rust engine with no build step and no `node-gyp`. On a platform with no matching package, or where that library fails to load, the app client's first use fails with `ENGINE_UNAVAILABLE`, as [Initializing](./initializing.md#errors) describes, and the message names the package to install. There is no fallback engine and no environment variable that changes the outcome. [Engine selection](../../getting-started/status.md#engine-selection) states this in full.

`@kizunasync/web` needs no platform package. The published package carries the WebAssembly engine and its glue, and the driver loads both from inside the package, so the browser runs the same Rust engine everywhere. Bundler settings for the worker and the wasm asset are on [Build integration](./build-integration.md).

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [Swift: Installing](../swift/installing.md)
- [Kotlin: Installing](../kotlin/installing.md)
