---
title: Installing
description: Install the Expo ports, the packages that build the client, and the native peers they wrap.
status: alpha
docType: reference
library: expo
pageKind: installing
audience: app-developer
---

# Expo: Installing

`@kizunasync/expo` depends on `@kizunasync/core`, `@kizunasync/rn-uniffi`, and `@kizunasync/web`, which carries the engine on Expo web, and wraps native modules it declares as peers. Install it beside the engine and the [Supabase](https://supabase.com) composition, then add the peers with `expo install` so the versions match the [Expo](https://expo.dev) SDK.

## Install from npm

:::tabs{group=pm}
```bash tab=npm
npm install @kizunasync/expo @kizunasync/core @kizunasync/supabase
```

```bash tab=pnpm
pnpm add @kizunasync/expo @kizunasync/core @kizunasync/supabase
```

```bash tab=yarn
yarn add @kizunasync/expo @kizunasync/core @kizunasync/supabase
```

```bash tab=bun
bun add @kizunasync/expo @kizunasync/core @kizunasync/supabase
```
:::

## Install the native peers

```bash
npx expo install expo-sqlite expo-file-system @react-native-community/netinfo @supabase/supabase-js
```

`expo-sqlite` and `@react-native-community/netinfo` are required peers: the first backs [Open the SQLite driver](./open-expo-driver.md) and the second backs the network signal that driver carries, the [Connectivity](./create-expo-connectivity.md) port. `expo` and [React Native](https://reactnative.dev) `0.86` or later are required too, which any Expo app already satisfies. `expo-file-system` is optional and backs the [File store](./open-expo-file-store.md), which only an app with attachments needs, and `@supabase/supabase-js` is optional, needed only when the app imports [Native download](./create-expo-supabase-download.md) from `@kizunasync/expo/transfer`.

`@kizunasync/rn-uniffi` arrives as a dependency and links the native engine on iOS and Android, as [Native engine](#native-engine) describes. `@op-engineering/op-sqlite` is an optional peer for the [op-sqlite driver](./open-op-sqlite-driver.md), and nothing loads it until that path is imported.

`@kizunasync/expo` also declares `expo-asset` as a peer, the package [Open the SQLite driver](./open-expo-driver.md) reads the engine binary's asset URL through on Expo web. It arrives already, as a dependency of `expo` itself, so `npx expo install` needs nothing further for it. Metro still needs `wasm` in `resolver.assetExts` to bundle that binary:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.resolver.assetExts.push('wasm')

module.exports = config
```

TypeScript resolves `openExpoDriver` from `@kizunasync/expo`. Add [`@kizunasync/react`](../react/installing.md) when components read the client through hooks.

## Native engine

`@kizunasync/rn-uniffi` links a prebuilt engine library on iOS and Android, so the app project needs no Rust toolchain. Both platforms fetch the library at the exact version of `@kizunasync/rn-uniffi` from the registries the Swift and Kotlin clients use.

On iOS, `pod install` adds the `KizunaSyncEngine` product of the Swift package `https://github.com/kizunasync/kizunasync-swift` to the Pods project through React Native's `spm_dependency` helper, and Xcode fetches that package when it builds the app. The library requires iOS 16 or later. Expo SDK 57 sets its own floor at iOS 16.4, above that minimum, so an Expo app needs no change for it.

On Android, Gradle resolves `com.kizunasync:kizunasync-engine` from Maven Central. That artifact carries the library for `arm64-v8a`, `armeabi-v7a`, and `x86_64`, and the module builds for the architectures in that list that the app also targets. A 32-bit `x86` emulator cannot load the engine, so run an emulator image for `x86_64` or `arm64-v8a`.

Expo Go cannot run the engine, because it loads no custom native code. A development build (`npx expo run:ios` / `npx expo run:android`, or EAS Build) is required on iOS and Android, and the engine joins the app during that build; a JavaScript reload or a plain install does not add it. [Rust engine](./rust-engine.md) covers when the client selects it.

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [React: Installing](../react/installing.md)
- [Vue: Installing](../vue/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
