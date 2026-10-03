---
title: Rust engine
description: How a React Native client reaches the Rust core over UniFFI, what Expo web runs, and what happens when neither artifact resolves.
status: alpha
docType: reference
library: expo
pageKind: guide
audience: app-developer
---

# Expo: Rust engine

One app client sits over one engine. Only the artifact that reaches it varies. On iOS and Android that artifact is a [UniFFI](https://mozilla.github.io/uniffi-rs/) [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction). On [Expo](https://expo.dev) web it is the same core compiled to [WebAssembly](https://grokipedia.com/page/WebAssembly). There is no third possibility: where neither resolves, the client's first engine call fails. The Expo web target runs on the `@kizunasync/web` driver, and Metro bundles that driver's worker as its own JavaScript bundle, separate from the app. The client makes the choice once, on its first use. The query builder, the scheduler, the rejection journal, and the attachment queue are the same code on both.

## Selection

`kizunasync.engine` names the engine the app client selected. `src/kizunasync.ts` is the one from [Initializing](./initializing.md).

```ts
// src/engine-probe.ts
import { kizunasync } from './kizunasync'

export function logEngine(): void {
  console.log(kizunasync.engine) // 'rust' on Expo web, and on device with the module linked
}
```

On iOS and Android, two conditions have to hold for the Rust engine, and both are checked on the client's first use.

- `@kizunasync/rn-uniffi` loads. It arrives as a dependency of `@kizunasync/expo`, and the locator that [`openExpoDriver`](./open-expo-driver.md) or [`openOpSqliteDriver`](./open-op-sqlite-driver.md) returns on device carries a `loadNativeEngine` function that loads it, so `@kizunasync/core` never imports the package and nothing calls it on web. The Turbo Module and the prebuilt engine it links, described under [iOS and Android](#ios-and-android), reach the binary only through a native build of the app, never through a plain install. Expo Go carries no such build, so it cannot load the Turbo Module; only a development build (`npx expo run:ios` / `npx expo run:android`, or EAS Build) links one in. [Later work](../../resources/roadmap.md#expo-module-over-the-uniffi-bindings) covers replacing this Turbo Module with an Expo Module over the same UniFFI bindings.
- The driver reports a `databasePath`. The Rust core opens its own SQLite connection, so it has to be told which file the app writes through. [`openExpoDriver`](./open-expo-driver.md) reports one on native, read from expo-sqlite on that first use, and does not keep expo-sqlite open, and [`openOpSqliteDriver`](./open-op-sqlite-driver.md) reports one from the `location` it requires.

`kizunasync.engine` reads back `'rust'`, which is its one value. It is a diagnostic, not a switch. Reading it opens the engine, so on a client whose engine cannot open it throws the kept `ENGINE_UNAVAILABLE`.

Once selected, the Turbo Module carries the whole engine surface: `kizunasync.on()` fires from the device events it forwards the same way it does on every other runtime, so `useQuery`, `useSyncStatus`, `useRejections`, and the inspector ring stay current on React Native. `dispose()` unsubscribes that listener and shuts the engine down.

## iOS and Android

The Turbo Module links a prebuilt `kizunasync-ffi` library, so the app project needs no Rust toolchain. Both platforms pin that library to the version of `@kizunasync/rn-uniffi` itself. On iOS it is the `KizunaSyncEngine` product of the Swift package `https://github.com/kizunasync/kizunasync-swift`, which `pod install` adds through React Native's `spm_dependency` helper and Xcode fetches at build time. It requires iOS 16 or later, which every Expo SDK 57 app meets because Expo's own floor is iOS 16.4. On Android it is `com.kizunasync:kizunasync-engine` from Maven Central, built for `arm64-v8a`, `armeabi-v7a`, and `x86_64`. [Installing](./installing.md#native-engine) lists the same sources from the app's side.

## Expo web

Expo web runs on the `@kizunasync/web` driver instead of `expo-sqlite`. [`openExpoDriver`](./open-expo-driver.md) branches on the platform and returns that driver. The driver starts a dedicated worker and compiles the Rust core to WebAssembly there. It opens the database through the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool. Where the browser cannot support that pool, the worker opens a relaxed [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) store instead. A pool another tab is holding is a different case. The worker retries it for about 1.8 s, then fails with `STORE_BUSY` and names the database. It never swaps in an empty store. Neither backend uses `SharedArrayBuffer`, so the web target needs no COOP or COEP headers.

That driver carries the engine rather than a SQL connection, so the first condition does not apply to it: there is no Turbo Module to link. The second holds, and the driver meets it by reporting the `name` passed to it as its `databasePath`. `kizunasync.engine` reads `'rust'` on Expo web, and it cannot fall back, because the worker owns the store and the driver itself exposes no SQL methods to reach it any other way.

Tabs share one engine: every tab on a database races for a [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) named after it, the winner runs the worker, and the others send their calls to the winner over a `BroadcastChannel`. When the leading tab goes away, one of the waiting tabs is promoted and starts a worker behind the transport the client already holds.

## When neither condition holds

There is nothing to pin and nothing to fall back to. The client's first engine call fails with a typed `TEngineError` whose code is `ENGINE_UNAVAILABLE`, and its message names what is missing. Building the client does not throw, so `src/kizunasync.ts` loads in Expo Go too. The client keeps that error: every later engine call rejects with it, a hook shows it as its error state, and sync health reports it as the last error.

A driver with no `databasePath` reports that the Rust engine cannot open the same database the app writes through. On iOS and Android, the other messages name one of four causes:

- The binary does not register the Turbo Module, which is the case in Expo Go. The message names the native rebuild with `@kizunasync/rn-uniffi` installed, which a JavaScript reload cannot substitute for.
- The binary registers the Turbo Module, but the module exports no `KizunaSyncEngine` with the six members the app client drives. The message asks for a native rebuild against a matching `@kizunasync/rn-uniffi`.
- The binary registers the Turbo Module, but the package's generated JavaScript bindings throw while they load. The message quotes that error.
- The locator carries no `loadNativeEngine`, as with a locator object the app builds itself. The message asks for an `@kizunasync/expo` driver, which links `@kizunasync/rn-uniffi`, and notes that a JavaScript reload cannot load a native module.

The first three messages come from `@kizunasync/rn-uniffi` through the driver's `loadNativeEngine`. No environment variable changes any of these outcomes.

Expo web has no rollback to ask for. The browser driver carries the engine and exposes no SQL methods of its own. The transport is therefore the only route to those rows. A store the worker cannot open fails the client rather than degrading it. [Project status](../../getting-started/status.md#engine-selection) records the current maturity of each path.

## Notes

Attachments leave the choice open. Both artifacts mount the same queue over the engine's own store. The client raises the missing-ports refusal when it is built, before it chooses an artifact.

[Drivers and the TCK](../drivers-and-tck.md#engine-selection) covers the same selection from the driver's side, including what a store swap has to keep for the engine to stay correct.

## Related reference

- [Open the SQLite driver](./open-expo-driver.md)
- [op-sqlite driver](./open-op-sqlite-driver.md)
- [Initializing](./initializing.md)
- [Drivers and the TCK](../drivers-and-tck.md)
