---
title: Playground
description: Run the hosted demo, then the five in-repository reference apps against the local Supabase stack.
status: alpha
docType: tutorial
audience: app-developer
---

# Playground

Two ways to see Kizuna move before or alongside your own integration: the hosted demo, then the in-repository reference apps. To provision your own Supabase project, start with [Quick start](./quickstart.md).

The local examples live in [kizunasync/kizunasync](https://github.com/kizunasync/kizunasync).

## Hosted demo

Open [demo.kizunasync.com](https://demo.kizunasync.com) and watch offline queueing, convergence, same-column conflicts, and [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies) turning a write away. Nothing needs cloning.

The public demo runs two panes in the browser. Each pane holds its own local database, both panes share one Supabase session, and a wire viewer shows pull and push.

Kizuna adds nothing to those policies, and the demo shows the same rejection your own project would return.

The hosted demo does not demonstrate attachments, [buckets](../sync/sync-rules-and-buckets.md), or multiple synchronized tables.

## Before you begin

The local apps need these tools:

- [Git](https://git-scm.com/downloads)
- [Bun](https://bun.sh/docs/installation) `1.4.2` (pinned by the root `packageManager` field)
- [Docker](https://docs.docker.com/get-started/get-docker/) for the [local Supabase stack](https://supabase.com/docs/guides/local-development#quickstart)
- [Rust and Cargo](https://www.rust-lang.org/tools/install) for the native iOS and Android examples

Clone the repository and start the stack:

```bash
git clone https://github.com/kizunasync/kizunasync.git
cd kizunasync
bun install
bun run db:start
bun run db:status
```

Copy the repo-root `.env.example` to `.env` and fill the product-prefixed URL and client-facing [publishable key](https://supabase.com/docs/guides/api/api-keys#publishable-keys-and-public-components) printed by `db:status`.

Those scripts wrap the [Supabase CLI](https://supabase.com/docs/reference/cli/introduction), so `supabase status` in the same tree prints the same values. [Local Supabase](../cli/local-supabase.md) covers the stack in detail.

| App | URL variable | Publishable-key variable |
|---|---|---|
| Two-pane demo | `VITE_DEMO_SUPABASE_URL` | `VITE_DEMO_SUPABASE_PUBLISHABLE_KEY` |
| Todo React | `VITE_TODO_REACT_SUPABASE_URL` | `VITE_TODO_REACT_SUPABASE_PUBLISHABLE_KEY` |
| Todo Vue | `VITE_TODO_VUE_SUPABASE_URL` | `VITE_TODO_VUE_SUPABASE_PUBLISHABLE_KEY` |
| Todo Expo | `EXPO_PUBLIC_TODO_EXPO_SUPABASE_URL` | `EXPO_PUBLIC_TODO_EXPO_SUPABASE_PUBLISHABLE_KEY` |

The Expo key variable takes the `sb_publishable_...` value. Never put a [secret key](https://supabase.com/docs/guides/api/api-keys#secret-keys-and-elevated-access) such as `SUPABASE_SERVICE_ROLE_KEY` in any of these client applications.

`EXPO_PUBLIC_TODO_EXPO_SUPABASE_ANON_KEY` is also read as an alias. A secret key bypasses RLS, and every Kizuna client is expected to run under a user's own policies. Your own app, outside this monorepo, still uses the unprefixed `VITE_SUPABASE_*` / `EXPO_PUBLIC_SUPABASE_*` names shown in each library's initializing page.

The Expo app also reads `EXPO_PUBLIC_TODO_EXPO_TURNSTILE_SITE_KEY`. Set it only to point the app at the public demo project, where it adds the Turnstile check that project requires before a visitor signs in.

The local migration directory contains `0001_kizuna_init.sql` plus one demo-only migration, `0002_example.sql`. A fresh local stack applies both. Only `0001_kizuna_init.sql` belongs to the installable pack, as [What is installed](../cli/whats-installed.md) explains.

## React

Path: [`examples/todo-react`](../../examples/todo-react)

```bash
bun run --filter=@kizunasync/example-todo-react dev
```

It uses React, [`@kizunasync/react`](../reference/react/introduction.md), [`createSupabaseKizunaSync`](../reference/javascript/initializing.md), and [`createWebWorkerDriver`](../reference/javascript/create-web-worker-driver.md). Its client declaration is bucketless. The demo RLS shares the board: every visitor reads every row. Writes to an anonymous-owned row come from any visitor; writes to a registered owner's row come only from that owner. The example also shows local queries, locally queued offline mutations, RLS rejection behavior, Realtime [wakeups](../resources/glossary.md#wake-up), attachments, account switching, and lab controls.

The browser driver runs the Rust engine as [WebAssembly](https://grokipedia.com/page/WebAssembly) in a dedicated worker, over the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool or the relaxed [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) fallback.

The suite drives `createKizunaSync` on the [N-API](https://nodejs.org/api/n-api.html) addon, so build it first:

```bash
bun run cargo:napi
bun test examples/todo-react
```

## Vue

Path: [`examples/todo-vue`](../../examples/todo-vue)

```bash
bun run --filter=@kizunasync/example-todo-vue dev
```

It is the Vue 3 counterpart to the React example. Its policies show the same shared board: every visitor reads every row, and only a registered owner can write to their own rows. The app uses [`@kizunasync/vue`](../reference/vue/introduction.md) composables over the same browser driver and the same Supabase protocol adapters. Account switching clears the local cache, then fills it again under the new identity.

The suite drives `createKizunaSync` on the [N-API](https://nodejs.org/api/n-api.html) addon, so build it first:

```bash
bun run cargo:napi
bun test examples/todo-vue
```

## Expo / React Native

Path: [`examples/todo-expo`](../../examples/todo-expo)

```bash
bun run --filter=@kizunasync/example-todo-expo dev
```

Use the Expo prompt to launch iOS, Android, or web. Expo web and the iOS simulator on the development machine can use `127.0.0.1`; the standard Android emulator uses `10.0.2.2` unless port forwarding is configured, and a physical device needs the development machine's reachable LAN address.

The example uses [`openExpoDriver`](../reference/expo/open-expo-driver.md), `createSupabaseKizunaSync`, React hooks, and the [Supabase attachment transfer](../reference/javascript/create-supabase-transfer.md). It also uses Expo file storage, image selection, session persistence, and offline lab controls. Native session persistence uses SecureStore, and web uses AsyncStorage. Expo web runs the Rust engine as WebAssembly in the `@kizunasync/web` worker. A native build reaches the same engine through the linked [`@kizunasync/rn-uniffi`](../reference/expo/rust-engine.md) [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction). Two things have to hold for that path. The native binary has to register that module, and the driver has to report a `databasePath`, the SQLite file the app writes through. Until both hold, the app client's first use fails with `ENGINE_UNAVAILABLE`.

Expo web needs no cross-origin-isolation headers: `metro.config.js` states that `@kizunasync/web`'s worker persists through OPFS access handles rather than a `SharedArrayBuffer`.

The suite drives `createKizunaSync` on the [N-API](https://nodejs.org/api/n-api.html) addon, so build it first:

```bash
bun run cargo:napi
bun test examples/todo-expo
```

## Native iOS

Path: [`examples/todo-ios`](../../examples/todo-ios)

This project is a Swift package plus a SwiftUI app definition. It does not use a JavaScript runtime.

Host test:

```bash
cargo build -p kizunasync-ffi --features http
swift test --package-path examples/todo-ios
```

Simulator build:

```bash
bun run cargo:xcframework
cd examples/todo-ios
xcodegen generate
xcodebuild -project TodoIos.xcodeproj -scheme TodoIos -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

`project.yml` is the source of truth for the generated Xcode project. The example depends on the local Swift package at `crates/kizunasync-ffi/bindings/swift`. It exercises file-backed create, apply, and reopen behavior and the typed [`KizunaSyncClient`](../reference/swift/introduction.md) app client. Thin-client attachments are opt-in through [`attachmentRoot`](../reference/swift/initializing.md); the example's host tests do not require that path.

## Native Android

Path: [`examples/todo-android`](../../examples/todo-android)

This [Gradle](https://gradle.org) project includes a host-test module unconditionally and the Android app only when `ANDROID_HOME` or `ANDROID_SDK_ROOT` is available. The wrapper is Gradle 8.7; Android Gradle Plugin 8.6.1 is the pinned plugin.

Host test:

```bash
cargo build -p kizunasync-ffi --features http
cd examples/todo-android
env -u ANDROID_HOME -u ANDROID_SDK_ROOT ./gradlew :app-core:test
```

Unsetting `ANDROID_HOME` and `ANDROID_SDK_ROOT` omits the Android modules. That leaves the host lane, which runs on the plain JVM with [JNA](https://grokipedia.com/page/Java_Native_Access). The artifact lane builds the Android app itself, under Gradle wrapper 8.7 and Android Gradle Plugin 8.6.1:

```bash
bun run cargo:aar
cd examples/todo-android
./gradlew :app:assembleDebug
```

That artifact lane configures under Gradle wrapper 8.7 and Android Gradle Plugin 8.6.1 when the Android SDK is present. A successful assemble is evidence that CI can package the app. It is not a published AAR or APK. The project depends on the local Kotlin binding project at `crates/kizunasync-ffi/bindings/kotlin`. The app consumes that binding's Android module through a Gradle path dependency rather than a published coordinate. It points [`KizunaSyncClientConfig.databasePath`](../reference/kotlin/initializing.md) at an application files path. Attachments on the Kotlin [thin client](../resources/architecture.md) are opt-in through `attachmentRoot`, and the host tests do not need one.

## Two-pane browser demo

Path: [`apps/demo`](../../apps/demo)

```bash
bun run --filter=@kizunasync/demo dev
```

The local two-pane demo is the same shape as the hosted playground: two independent browser databases and Kizuna clients over one Supabase session, plus a wire viewer. It demonstrates offline queueing, convergence, same-column conflict behavior, RLS rejection and local revert, and wipe and rehydrate. It deliberately does not demonstrate attachments, buckets, or multiple synchronized tables.

The demo is an application workspace, not one of the five projects under `examples/`.

## What to verify

For a JavaScript reference app:

1. Complete an initial pull.
2. Go offline with the app's simulation control or the device network.
3. Write a row and observe the local view plus nonzero [outbox](../resources/glossary.md#outbox) depth.
4. If persistence is in scope, perform a controlled restart and record the result for that driver and platform. The headless suites do not establish forced-termination or crash recovery.
5. Reconnect and synchronize.
6. Open a second client and evaluate eventual convergence. Two different anonymous visitors now see the same shared board, so both converge to the same state.
7. Attempt a write that RLS rejects and confirm the rejection is visible to the application, as [Offline writes](../sync/offline-writes.md) describes.
8. In an attachment-capable app, test both sides of the 6 MiB boundary; above the boundary should use [TUS](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url).

Read a host unit test as evidence for host behavior alone, never for a physical-device matrix. Read an iOS simulator launch or an Android APK assembly the same way, and say which lane you ran when you report a result. [Test offline behavior](../operations/test-offline-behavior.md#6-match-the-test-to-the-claim) sets out that rule for every suite.

## Hosted Supabase instead of local Docker

Do not copy the demo fixture migrations into production. Provision the installable pack and your own table configuration after reviewing a dry run:

:::tabs{group=pm}
```bash tab=npm
SUPABASE_ACCESS_TOKEN=... npx kizunasync init --project-ref <your-project-ref> --dry-run
```

```bash tab=pnpm
SUPABASE_ACCESS_TOKEN=... pnpm dlx kizunasync init --project-ref <your-project-ref> --dry-run
```

```bash tab=yarn
SUPABASE_ACCESS_TOKEN=... yarn dlx kizunasync init --project-ref <your-project-ref> --dry-run
```

```bash tab=bun
SUPABASE_ACCESS_TOKEN=... bunx kizunasync init --project-ref <your-project-ref> --dry-run
```
:::

That path applies the pack through the [Management API](https://supabase.com/docs/reference/api/introduction) rather than a direct [Postgres](https://grokipedia.com/page/PostgreSQL) connection. Hosted examples need the project's URL and publishable key, and the user session supplies the access token RLS checks.

Follow [Install](../cli/install.md#4-provision-a-hosted-project-through-the-management-api) before you apply the plan.

## Next steps

- [Quick start](./quickstart.md): provision your own Supabase project.
- [React](react.md): `KizunaSyncProvider` and the hooks.
- [Vue](vue.md): the composable equivalents.
- [Expo / React Native](expo.md): on-device [SQLite](https://grokipedia.com/page/SQLite) and the development build.
- [Swift and Kotlin](./native-clients.md): `KizunaSyncClient` without a JavaScript UI.
- [Local Supabase](../cli/local-supabase.md): running and resetting the stack safely.
- [Test offline behavior](../operations/test-offline-behavior.md): the suites and what each one proves.
