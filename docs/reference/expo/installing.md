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

`@kizunasync/expo` depends on `@kizunasync/core`, `@kizunasync/rn-uniffi`, and `@kizunasync/web`, which carries the engine on Expo web, and wraps native modules it declares as peers. Install it beside the engine, the [Supabase](https://supabase.com) composition, and the React bindings, then add the rest with `npx expo install` so the Expo SDK modules match the app's [Expo](https://expo.dev) SDK. These pages assume an [Expo Router](https://docs.expo.dev/router/introduction/) app with its routes under `src/app/`, so `expo`, `expo-router`, React, and React Native come from the app's own template.

## Install from npm

:::tabs{group=pm}
```bash tab=npm
npm install @kizunasync/expo @kizunasync/core @kizunasync/supabase @kizunasync/react
```

```bash tab=pnpm
pnpm add @kizunasync/expo @kizunasync/core @kizunasync/supabase @kizunasync/react
```

```bash tab=yarn
yarn add @kizunasync/expo @kizunasync/core @kizunasync/supabase @kizunasync/react
```

```bash tab=bun
bun add @kizunasync/expo @kizunasync/core @kizunasync/supabase @kizunasync/react
```
:::

`@kizunasync/react` holds `KizunaSyncProvider`, which `src/app/_layout.tsx` wraps the navigator in, and the hooks the screens read. [React: Installing](../react/installing.md) covers the package.

## Install the Expo-managed packages

```bash
npx expo install expo-sqlite expo-file-system @react-native-community/netinfo @supabase/supabase-js react-native-url-polyfill expo-build-properties
```

| Package | Why the app needs it |
|---|---|
| [`expo-sqlite`](https://docs.expo.dev/versions/latest/sdk/sqlite/) | A required peer that backs [Open the SQLite driver](./open-expo-driver.md). `src/supabase-client.ts` also imports `expo-sqlite/localStorage/install`, the `localStorage` that keeps the Supabase session across launches. |
| [`expo-file-system`](https://docs.expo.dev/versions/latest/sdk/filesystem/) | An optional peer that backs the [File store](./open-expo-file-store.md), which only an app with attachments needs. The [op-sqlite driver](./open-op-sqlite-driver.md) example reads the app's document directory from it. |
| [`@react-native-community/netinfo`](https://github.com/react-native-netinfo/react-native-netinfo#readme) | A required peer that backs the network signal the driver carries, the [Connectivity](./create-expo-connectivity.md) port. |
| [`@supabase/supabase-js`](https://supabase.com/docs/reference/javascript/installing) | Supabase's JavaScript client, which `src/supabase-client.ts` creates and `@kizunasync/supabase` takes as a peer. [Native download](./create-expo-supabase-download.md) from `@kizunasync/expo/transfer` runs on it too. |
| [`react-native-url-polyfill`](https://github.com/charpeni/react-native-url-polyfill) | A `URL` that follows the WHATWG URL Standard, in place of React Native's partial one. `src/supabase-client.ts` imports `react-native-url-polyfill/auto` first, as Supabase's [Expo quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/expo-react-native) does. |
| [`expo-build-properties`](https://docs.expo.dev/versions/v57.0.0/sdk/build-properties/) | The config plugin whose `ios.enableSceneSupport` property adopts the UIKit scene life cycle on SDK 57, as [iOS scene life cycle](#ios-scene-life-cycle) shows. |

`expo` and [React Native](https://reactnative.dev) `0.86` or later are required peers too, which any Expo app already satisfies.

`@kizunasync/rn-uniffi` arrives as a dependency and links the native engine on iOS and Android, as [Native engine](#native-engine) describes. `@op-engineering/op-sqlite` is an optional peer for the [op-sqlite driver](./open-op-sqlite-driver.md), and nothing loads it until that path is imported.

`@kizunasync/expo` also declares `expo-asset` as a peer, the package [Open the SQLite driver](./open-expo-driver.md) reads the engine binary's asset URL through on Expo web. It arrives already, as a dependency of `expo` itself, so `npx expo install` needs nothing further for it. Metro still needs `wasm` in `resolver.assetExts` to bundle that binary:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.resolver.assetExts.push('wasm')

module.exports = config
```

TypeScript resolves `openExpoDriver` from `@kizunasync/expo`.

## Native engine

`@kizunasync/rn-uniffi` links a prebuilt engine library on iOS and Android, so the app project needs no Rust toolchain. Both platforms fetch the library at the exact version of `@kizunasync/rn-uniffi` from the registries the Swift and Kotlin clients use.

On iOS, `pod install` adds the `KizunaSyncEngine` product of the Swift package `https://github.com/kizunasync/kizunasync-swift` to the Pods project through React Native's `spm_dependency` helper, and Xcode fetches that package when it builds the app. The library requires iOS 16 or later. Expo SDK 57 sets its own floor at iOS 16.4, above that minimum, so an Expo app needs no change for it.

On Android, Gradle resolves `com.kizunasync:kizunasync-engine` from Maven Central. That artifact carries the library for `arm64-v8a`, `armeabi-v7a`, and `x86_64`, and the module builds for the architectures in that list that the app also targets. A 32-bit `x86` emulator cannot load the engine, so run an emulator image for `x86_64` or `arm64-v8a`.

Expo Go cannot run the engine, because it loads no custom native code. A development build (`npx expo run:ios` / `npx expo run:android`, or EAS Build) is required on iOS and Android, and the engine joins the app during that build; a JavaScript reload or a plain install does not add it. [Rust engine](./rust-engine.md) covers when the client selects it.

## iOS scene life cycle

iOS 27 terminates an app that does not adopt the UIKit scene life cycle, and Expo SDK 57 adopts it only when the `expo-build-properties` plugin sets `ios.enableSceneSupport`. Add the entry to the `plugins` array in `app.json`, after the plugins the app already lists (`app.config.js` takes the same entry):

```json
{
  "expo": {
    "plugins": [
      "expo-router",
      ["expo-build-properties", { "ios": { "enableSceneSupport": true } }]
    ]
  }
}
```

The property needs `expo` 57.0.23 or later and the standard SDK 57 Swift `AppDelegate`, and the plugin throws when either is missing. Expo SDK 58 and later include scene support in the project template, so the entry applies to SDK 57 only, and the plugin warns when it finds the entry on SDK 58.

The plugin edits the generated iOS project, so rebuild it after adding the entry. `npx expo run:ios` generates the project when the app has no `ios/` folder, and `npx expo prebuild --platform ios --clean` regenerates an existing one, which discards manual edits in `ios/`.

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [React: Installing](../react/installing.md)
- [Vue: Installing](../vue/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
