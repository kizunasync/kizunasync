---
title: Installing
description: Install the JavaScript client from npm.
status: alpha
docType: reference
library: javascript
pageKind: installing
audience: app-developer
---

# JavaScript: Installing

The single npm package `kizunasync` holds the app client, the config helpers, the local query builder, the Supabase composition, the browser engine, the `kizunasync` CLI, and the SQL pack. Each part is a subpath of the package. `@supabase/supabase-js` is the Supabase client, which the app creates in `src/supabase-client.ts` and which `kizunasync/supabase` wraps.

## Install from npm

:::tabs{group=pm}
```bash tab=npm
npm install kizunasync @supabase/supabase-js
```

```bash tab=pnpm
pnpm add kizunasync @supabase/supabase-js
```

```bash tab=yarn
yarn add kizunasync @supabase/supabase-js
```

```bash tab=bun
bun add kizunasync @supabase/supabase-js
```
:::

## What each subpath holds

| Import path | Contents |
|---|---|
| `kizunasync` | `createKizunaSync`, `defineConfig`, the local query builder, the sync engine, and the shared [Types](./types.md). |
| `kizunasync/config` | `defineConfig`, the bucket and attachment builders, and the config types. |
| `kizunasync/constants` | The shared constants. |
| `kizunasync/testing` | Test helpers such as `createTempDatabase`. |
| `kizunasync/supabase` | The Supabase composition and its adapters: [Create the RPC remote](./create-rpc-remote.md), [Create the Storage transfer](./create-supabase-transfer.md), [Create the Realtime wakeup](./create-realtime-wakeup.md), [Recover an anonymous session](./recover-anonymous-session.md). |
| `kizunasync/web` | The browser ports: [Open the browser driver](./create-web-worker-driver.md), [Browser connectivity](./create-web-connectivity.md), [Browser file store](./create-web-file-store.md). |
| `@supabase/supabase-js` | Supabase's JavaScript client, an optional peer of `kizunasync`. `src/supabase-client.ts` creates it with `createClient`, and the app client runs pull, push, the Realtime doorbell, and Storage transfers through it. Supabase documents the package under [Installing](https://supabase.com/docs/reference/javascript/installing). |

`kizunasync/web` is the browser driver. On [Expo](https://expo.dev) and [React Native](https://reactnative.dev) the app imports [`kizunasync/expo`](../expo/installing.md) in its place, while `kizunasync` and `kizunasync/supabase` stay the same. [React](https://react.dev) apps add [`kizunasync/react`](../react/installing.md) and [Vue](https://vuejs.org) apps add [`kizunasync/vue`](../vue/installing.md) on top. All of them come from the one install above, and every peer is optional: install the ones your platform uses.

## What the install resolves per platform

`kizunasync` declares one optional dependency per platform: `@kizunasync/darwin-arm64`, `@kizunasync/darwin-x64`, `@kizunasync/linux-x64-gnu`, `@kizunasync/linux-arm64-gnu`, and `@kizunasync/win32-x64-msvc`. Each one holds the `kizunasync` CLI binary under `bin/` and the [N-API](https://nodejs.org/api/n-api.html) library at the package root, and each sets its own `os` and `cpu`. npm therefore installs the one the host machine matches and skips the other four. Node and [Bun](https://bun.sh) then run the Rust engine with no build step and no `node-gyp`. The app never imports a platform package. On a platform with no matching package, or where that library fails to load, the app client's first use fails with `ENGINE_UNAVAILABLE`, as [Initializing](./initializing.md#errors) describes, and the message names the package to install. There is no fallback engine and no environment variable that changes the outcome. [Engine selection](../../getting-started/status.md#engine-selection) states this in full.

`kizunasync/web` needs no platform package. The package carries the WebAssembly engine and its glue, and the driver loads both from inside it, so the browser runs the same Rust engine everywhere. Bundler settings for the worker and the wasm asset are on [Build integration](./build-integration.md).

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [Swift: Installing](../swift/installing.md)
- [Kotlin: Installing](../kotlin/installing.md)
