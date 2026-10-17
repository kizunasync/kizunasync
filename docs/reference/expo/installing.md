---
title: Installing
description: Install the Expo ports, the subpaths that build the client, and the native peers they wrap.
status: alpha
docType: reference
library: expo
pageKind: installing
audience: app-developer
---

# Expo: Installing

The Expo ports ship in the `kizunasync` package as the `kizunasync/expo` subpath, together with the engine, the [Supabase](https://supabase.com) composition, the React bindings, the browser engine that runs on Expo web, and the React Native module that links the native engine. The package wraps native modules it declares as optional peers, so add those with `npx expo install` and the Expo SDK modules match the app's [Expo](https://expo.dev) SDK. These pages assume an [Expo Router](https://docs.expo.dev/router/introduction/) app with its routes under `src/app/`, so `expo`, `expo-router`, React, and React Native come from the app's own template.

## Install from npm

:::tabs{group=pm}
```bash tab=npm
npm install kizunasync
```

```bash tab=pnpm
pnpm add kizunasync
```

```bash tab=yarn
yarn add kizunasync
```

```bash tab=bun
bun add kizunasync
```
:::

`kizunasync/react` holds `KizunaSyncProvider`, which `src/app/_layout.tsx` wraps the navigator in, and the hooks the screens read. [React: Installing](../react/installing.md) covers the package.

## Install the Expo-managed packages

```bash
npx expo install expo-modules-core expo-file-system @react-native-async-storage/async-storage @react-native-community/netinfo @supabase/supabase-js react-native-url-polyfill
```

| Package | Why the app needs it |
|---|---|
| `expo-modules-core` | SDK 58 Modules API 2.0 runtime for `KizunaSyncExpo`, which hosts the shared Rust Turso engine. |
| `@react-native-async-storage/async-storage` | Persists the Supabase session in the example configuration. |
| [`expo-file-system`](https://docs.expo.dev/versions/latest/sdk/filesystem/) | An optional peer that backs the [File store](./open-expo-file-store.md), which only an app with attachments needs. The [op-sqlite driver](./open-op-sqlite-driver.md) example reads the app's document directory from it. |
| [`@react-native-community/netinfo`](https://github.com/react-native-netinfo/react-native-netinfo#readme) | A required peer that backs the network signal the driver carries, the [Connectivity](./create-expo-connectivity.md) port. |
| [`@supabase/supabase-js`](https://supabase.com/docs/reference/javascript/installing) | Supabase's JavaScript client, which `src/supabase-client.ts` creates and `kizunasync/supabase` takes as a peer. [Native download](./create-expo-supabase-download.md) from `kizunasync/expo/transfer` runs on it too. |
| [`react-native-url-polyfill`](https://github.com/charpeni/react-native-url-polyfill) | A `URL` that follows the WHATWG URL Standard, in place of React Native's partial one. `src/supabase-client.ts` imports `react-native-url-polyfill/auto` first, as Supabase's [Expo quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/expo-react-native) does. |

`expo` and [React Native](https://reactnative.dev) `>=0.86.0 <0.89.0` are required peers too, which any Expo app already satisfies.

The Expo Modules API 2.0 module inside `kizunasync` autolinks and links the native engine on iOS and Android, as [Native engine](#native-engine) describes. `@op-engineering/op-sqlite` is an optional peer for the [op-sqlite driver](./open-op-sqlite-driver.md), and nothing loads it until that path is imported.

`kizunasync/expo` also declares `expo-asset` as a peer, the package [Open the SQLite driver](./open-expo-driver.md) reads the engine binary's asset URL through on Expo web. It arrives already, as a dependency of `expo` itself, so `npx expo install` needs nothing further for it. Metro still needs `wasm` in `resolver.assetExts` to bundle that binary:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.resolver.assetExts.push('wasm')

module.exports = config
```

TypeScript resolves `openExpoDriver` from `kizunasync/expo`.

## Native engine

The Expo Modules API 2.0 host inside `kizunasync` links a prebuilt engine library on iOS and Android. Both platforms fetch the library at the exact version of `kizunasync` from the registries the Swift and Kotlin clients use. The Turso engine needs native artifacts built from the same source version; [Turso migration and recovery](../../operations/turso-migration.md) describes the local build overrides and release checks.

On iOS, `pod install` adds the `KizunaSyncFfi` product of the Swift package `https://github.com/kizunasync/kizunasync-swift` to the Pods project through React Native's `spm_dependency` helper, and Xcode fetches that package when it builds the app. The library requires iOS 16 or later. Expo SDK 58 sets its own floor at iOS 16.4, above that minimum, so an Expo app needs no change for it.

On Android, Gradle resolves `com.kizunasync:kizunasync` and its transitive `kizunasync-engine` dependency from Maven Central. That artifact carries the library for `arm64-v8a`, `armeabi-v7a`, and `x86_64`, and the module builds for the architectures in that list that the app also targets. A 32-bit `x86` emulator cannot load the engine, so run an emulator image for `x86_64` or `arm64-v8a`. The library requires Android API 26 (minSdk 26), and Expo SDK 58 apps default to 24, so add the `expo-build-properties` plugin with `android: { minSdkVersion: 26 }` to the app config before running `npx expo prebuild`.

Expo Go cannot run the engine, because it loads no custom native code. A development build (`npx expo run:ios` / `npx expo run:android`, or EAS Build) is required on iOS and Android, and the engine joins the app during that build; a JavaScript reload or a plain install does not add it. [Rust engine](./rust-engine.md) covers when the client selects it.

### iOS scene life cycle

Expo SDK 58 includes UIKit scene support. Apps upgrading from SDK 57 can remove the `expo-build-properties` `ios.enableSceneSupport` workaround and regenerate their native projects. A native rebuild is required.

## Upgrading an installed app

Rebuild the native app after upgrading to SDK 58. JavaScript updates cannot add the new module or replace the Rust engine. SDK 58 includes UIKit scene support; remove the old SDK 57 `enableSceneSupport` workaround.

Keep the existing database name and Supabase auth storage. Changing where authentication tokens are stored requires a separate token migration; do not remove `expo-sqlite` from an app that still uses its localStorage auth adapter until that session has been transferred. See [Turso migration and recovery](../../operations/turso-migration.md).

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [React: Installing](../react/installing.md)
- [Vue: Installing](../vue/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
