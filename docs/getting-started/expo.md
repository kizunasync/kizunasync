---
title: Expo / React Native
description: Wire @kizunasync/expo drivers and React hooks into an Expo app.
status: alpha
docType: how-to
audience: app-developer
---

# Expo / React Native

This guide wires Kizuna Sync into an [Expo Router](https://docs.expo.dev/router/introduction/) app, from the Supabase client to a screen that reads and writes todos offline. You create the app client once in `src/kizunasync.ts` with [`openExpoDriver`](../reference/expo/open-expo-driver.md) and [`createSupabaseKizunaSync`](../reference/javascript/initializing.md), wrap the navigator in `src/app/_layout.tsx`, and read and write through the [`@kizunasync/react`](../reference/react/introduction.md) hooks.

After that wiring, screens read and write the on-device [SQLite](https://grokipedia.com/page/SQLite) database, and the app client pushes and pulls in the background on its own.

## Before you begin

- A Supabase project provisioned with [`kizunasync`](../cli/cli.md) in your app repository. Follow the [Quick start](./quickstart.md) and [Install](../cli/install.md) if you have not run [`kizunasync init`](../cli/cli.md#kizunasync-init).
- An Expo app that uses Expo Router with its routes under `src/app/` ([Expo install guide](https://docs.expo.dev/get-started/installation/)).
- A way for users to sign in to Supabase: your own sign-in screen, or [anonymous sign-ins](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) enabled on the project. Step 5 covers both.
- Skim the [Expo reference introduction](../reference/expo/introduction.md) for drivers, the file store, and native engine notes.
- Expo Go cannot run Kizuna's native engine: the Turbo Module compiles into the app binary during a native build. Use a development build (`npx expo run:ios` / `npx expo run:android`, or [EAS Build](https://docs.expo.dev/build/introduction/)) on iOS and Android; Expo web needs no native build.

## 1. Install

Install `@kizunasync/expo`, `@kizunasync/core`, `@kizunasync/supabase`, and `@kizunasync/react` from npm, then `expo-sqlite`, `expo-file-system`, `@react-native-community/netinfo`, `@supabase/supabase-js`, `react-native-url-polyfill`, and `expo-build-properties` with `npx expo install`, as shown in [Expo: Installing](../reference/expo/installing.md). That page gives the reason for each package.

iOS 27 terminates an app that does not adopt the UIKit scene life cycle, and Expo SDK 57 adopts it when `expo-build-properties` sets `ios.enableSceneSupport`. Add the entry to the `plugins` array in `app.json`, after the plugins the app already lists (`app.config.js` takes the same entry):

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

Expo SDK 58 and later include scene support, so the entry applies to SDK 57 only. [iOS scene life cycle](../reference/expo/installing.md#ios-scene-life-cycle) lists the version requirements and how to regenerate the iOS project. You should now resolve `openExpoDriver` from `@kizunasync/expo`.

## 2. Connect Supabase

Create the one Supabase client the whole app shares in `src/supabase-client.ts`. The app client runs pull, push, the Realtime doorbell, and Storage transfers through it, and the server judges every queued write under the session it holds, so that session has to survive a relaunch. Supabase's [Expo quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/expo-react-native) persists it in a `localStorage` that `expo-sqlite` installs, and `expo-sqlite` is already a Kizuna peer. The file also imports `react-native-url-polyfill` first, as the same quickstart does; step 1 installed both packages.

Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.local`. On a physical device, use the development machine's reachable LAN address rather than `127.0.0.1`. The key value is a [publishable key](https://supabase.com/docs/guides/api/api-keys#publishable-keys-and-public-components), and it is safe in the bundle because RLS decides every row regardless.

```ts
// src/supabase-client.ts
import 'react-native-url-polyfill/auto'
import 'expo-sqlite/localStorage/install'
import { AppState } from 'react-native'
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  {
    auth: {
      storage: localStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
)

AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh()
  } else {
    supabase.auth.stopAutoRefresh()
  }
})
```

The `AppState` listener keeps the Supabase client's own token timer aligned with the app state, following the official [startAutoRefresh reference](https://supabase.com/docs/reference/javascript/auth-startautorefresh) and the [Auth sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session) guide. When the app returns to the foreground, the app client refreshes the session, reconnects Realtime when its channels have lost their socket, and then syncs, using the AppState signal the Expo driver in the next step brings. You should now be able to import `supabase` from `src/supabase-client.ts` anywhere in the app.

## 3. Create the app client

Create the app client once, at module scope, in `src/kizunasync.ts`. Every other file imports it from there. The config repeats what `kizunasync init` provisioned, so read each table's sync mode and bucket column in the tables section of [`kizunasync status`](../cli/cli.md#kizunasync-status):

:::tabs{group=pm}
```bash tab=npm
npx kizunasync status
```

```bash tab=pnpm
pnpm dlx kizunasync status
```

```bash tab=yarn
yarn dlx kizunasync status
```

```bash tab=bun
bunx kizunasync status
```
:::

A `todos` table provisioned as `read-write` with `user_id` as its bucket column becomes the config below.

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { openExpoDriver } from '@kizunasync/expo'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: openExpoDriver('todos.db'),
  config,
})
```

Creating the client opens nothing, so importing this module starts no engine, even during Expo Router's static rendering of web routes. The first query or write opens the database, and the first sync runs right away. On iOS and Android, [`openExpoDriver`](../reference/expo/open-expo-driver.md) names the `expo-sqlite` file and brings the device's network signal (NetInfo) and app state (AppState), so the client wakes when the network returns and when the app comes back to the foreground with nothing else to pass. That network signal follows NetInfo's `isConnected`, and [`createExpoConnectivity`](../reference/expo/create-expo-connectivity.md) describes the stricter `internet-reachable` gate, which you pass as the `connectivity` option.

The engine fills a `byOwner` bucket with the signed-in user's id and remembers that user in the local database, so after a relaunch the bucket and every new insert carry that user before the app reaches the network. A table without a bucket column takes no `bucket` option, and [Define config](../reference/javascript/define-config.md) lists the remaining options.

On native iOS and Android, the app client runs the Rust engine through [`@kizunasync/rn-uniffi`](../reference/expo/rust-engine.md), the [UniFFI](https://mozilla.github.io/uniffi-rs/) [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction) a development build links, and the driver from `openExpoDriver` loads that module on the client's first use. The Expo web target runs on the `@kizunasync/web` driver, and Metro bundles that driver's worker as its own JavaScript bundle. [Build integration](../reference/javascript/build-integration.md) covers what Metro needs to bundle the engine binary that worker loads. [Project status](./status.md#engine-selection) records what each path is, and [Expo: Initializing](../reference/expo/initializing.md) lists every parameter.

## 4. Provide it to the app

Wrap the navigator in [`KizunaSyncProvider`](../reference/react/initializing.md) in the root layout, `src/app/_layout.tsx`, so every hook in every screen reads the same client:

```tsx
// src/app/_layout.tsx
import { Stack } from 'expo-router'
import { KizunaSyncProvider } from '@kizunasync/react'
import { kizunasync } from '../kizunasync'

export default function RootLayout() {
  return (
    <KizunaSyncProvider client={kizunasync}>
      <Stack />
    </KizunaSyncProvider>
  )
}
```

Nothing else in the app creates the client or passes it around.

## 5. Sign in

The app client follows `supabase.auth` on its own. It pulls and pushes as whichever user supabase-js holds a session for, and it picks up a sign-in, a token refresh, or a sign-out without a call from your code. Get that session in one of two ways:

- An app with its own sign-in screen signs in with supabase-js, for example with [`signInWithPassword`](https://supabase.com/docs/reference/javascript/auth-signinwithpassword#examples). [Supabase Auth](https://supabase.com/docs/guides/auth) covers every sign-in method.
- An app whose first launch has no sign-in screen adds `anonymousSignIn: true` to the `createSupabaseKizunaSync` options in `src/kizunasync.ts`. When a sync finds no session, the client restores the session the device already had, or signs in a new anonymous user, and a sync that fails offline tries again on the next run. The project needs [anonymous sign-ins](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) enabled.

The session persistence in `src/supabase-client.ts` is what keeps the same user across relaunches. Switching accounts on the same device takes a [`reset()`](../reference/javascript/reset.md). When a different user signs in, the engine soft-blocks sync with `identity_changed` until `reset()` runs, so writes queued under one user never go out under another. [Sync soft-blocks after switching accounts](../operations/troubleshooting.md#sync-soft-blocks-after-switching-accounts) walks through it.

## 6. Read and write

A screen reads with [`useQuery`](../reference/react/use-query.md) and writes with [`useMutation`](../reference/react/use-mutation.md). Both find the client through the provider, so the screen imports nothing from `src/kizunasync.ts`.

```tsx
// src/app/index.tsx
import { Button, FlatList, Text, View } from 'react-native'
import { useMutation, useQuery } from '@kizunasync/react'

type TTodo = { id: string; title: string }

export default function TodosScreen() {
  const { data: todos, error } = useQuery<TTodo>((kizunasync) =>
    kizunasync.from('todos').select().order('created_at', { ascending: false }),
  )
  const { mutate } = useMutation()

  function addTodo() {
    void mutate((kizunasync) =>
      kizunasync.from('todos').insert({ title: 'works on a plane', done: false, created_at: new Date().toISOString() }),
    )
  }

  return (
    <View style={{ flex: 1 }}>
      {error !== null && <Text>{error.message}</Text>}
      <FlatList data={todos} keyExtractor={(todo) => todo.id} renderItem={({ item }) => <Text>{item.title}</Text>} />
      <Button title="Add a todo" onPress={addTodo} />
    </View>
  )
}
```

`useQuery` reads the local database only, and it reads again whenever a local write or a pull changes the table. The insert commits to the local database and queues the change in the outbox in one step, so the new row shows in the list before any request leaves the device, online or not. `error` carries a read that failed, including an engine that could not open, which in Expo Go is `ENGINE_UNAVAILABLE`.

The insert leaves out `id`, which [`insert`](../reference/javascript/insert-data.md) mints, so the app does not depend on `crypto.randomUUID` being present in your React Native runtime. It also leaves out `user_id`, which the engine fills with the signed-in user's id because the table uses `byOwner`. An insert made before any user has signed in on this device keeps only the columns you gave it. Pass `created_at` yourself: a row that omits it has no value locally until the server answers, so it sorts to the wrong end of this list.

You should now see a new todo in the list each time you tap **Add a todo**, with or without a network.

## What runs on its own

Nothing in the screen calls `sync()`, and nothing needs to. Each of these wakes the sync loop:

- The app uses the client for the first time, as the first `useQuery` read does. The client opens the local database and syncs right away.
- A local write that raises the outbox depth wakes a sync, so the todo from step 6 pushes as soon as the device is online.
- A poll tick fires at a random point between half the interval and the whole interval, 7.5 to 15 seconds with the default `pollIntervalMs` of `15000`, and `0` turns the poll off.
- Connectivity coming back, as NetInfo reports it through the driver, flushes the writes queued while the device was offline.
- The app returning to the foreground, as AppState reports it through the driver, refreshes the session and then wakes the loop.
- The Supabase Realtime doorbell carries no data. It tells the loop that a synced table changed on the server, and the loop pulls the change.
- On Expo web, only the leader tab runs the loop for a database, and a tab promoted to leader syncs at once.

Call [`sync()`](../reference/javascript/sync.md) yourself only for a **Sync now** button, a pull-to-refresh gesture, or a test. The `syncNow` function in the next step is that button.

A session lookup that does not settle within 10 seconds fails the attempt retryably with `AUTH_SESSION_TIMEOUT`, so the write stays queued; `sessionTimeoutMs` changes that deadline, and [Sync](../reference/javascript/sync.md#parameters) lists it beside the other run options.

## 7. Show sync state

[`useSyncStatus`](../reference/react/use-sync-status.md) reports the outbox depth and whether the device is online, and it carries a manual sync trigger:

```tsx
// src/components/sync-bar.tsx
import { Pressable, Text } from 'react-native'
import { useSyncStatus } from '@kizunasync/react'

export function SyncBar() {
  const { outboxDepth, isOnline, isSyncing, isStalled, syncNow } = useSyncStatus()
  const label = !isOnline ? 'Offline' : isStalled ? 'Reconnecting…' : isSyncing ? 'Syncing…' : `Sync now (${outboxDepth} pending)`

  return (
    <Pressable disabled={isSyncing} onPress={() => void syncNow()}>
      <Text>{label}</Text>
    </Pressable>
  )
}
```

Render `<SyncBar />` in any screen under the provider, for example above the list in `src/app/index.tsx`. `isOnline` follows the same NetInfo signal the client's sync loop follows. The hook also returns `health` and `nextRetryAt`, which [Sync health](../reference/javascript/sync-health.md) documents field by field. [Offline writes](../sync/offline-writes.md#2-show-sync-state-in-your-ui) builds the complete indicator.

## Verify it worked

Start a development build against your provisioned project with `npx expo run:ios` or `npx expo run:android`, and sign in if your app has a sign-in screen. Tap **Add a todo**, and within a few seconds the row appears in the `todos` table in Supabase Studio. Turn on airplane mode and add another todo: it shows in the list at once, and the sync bar counts it as pending. Turn airplane mode off, and the pending count drops to zero as the queued write reaches the server.

## Common errors

- The screen shows `ENGINE_UNAVAILABLE` as the `useQuery` error in Expo Go, because Expo Go cannot load the native engine. Build a development build with `npx expo run:ios` or `npx expo run:android` and open the app from it, as [Rust engine](../reference/expo/rust-engine.md#when-neither-condition-holds) explains. In a development build, the same error means the driver could not load the engine the build links. Its message names the cause, which that section lists case by case, and quotes the error itself when the module's generated JavaScript bindings fail to load.
- On a physical device, nothing syncs when `EXPO_PUBLIC_SUPABASE_URL` is not the development machine's reachable LAN address, because the device cannot reach `127.0.0.1` on your computer. See [Expo or a physical device cannot reach local services](../operations/troubleshooting.md#expo-or-a-physical-device-cannot-reach-local-services).
- Writes stay pending and `health.lastError.code` is `AUTH_SESSION_MISSING` when no user has signed in. Sign in with supabase-js or pass `anonymousSignIn: true`, as step 5 describes. With `anonymousSignIn: true` on a project that has anonymous sign-ins turned off, every sync fails its sign-in until you turn them on.
- A pull fails with `KZL01` when the config's bucket does not match the bucket column `kizunasync init` provisioned. Copy the bucket column from `kizunasync status` into `defineConfig`. See [KZL01](../operations/troubleshooting.md#kzl01).
- Sync that soft-blocks with `identity_changed` after a relaunch means session persistence did not carry the anonymous user across, so a new anonymous user signed in and the engine held the queued writes back. Check the `storage` option in `src/supabase-client.ts`, and see [Sync soft-blocks after switching accounts](../operations/troubleshooting.md#sync-soft-blocks-after-switching-accounts).
- If Metro cannot reach the bundler, disable the VPN or restart with `--localhost`.
- On Expo SDK 57, the Expo web target needs `expo` 57.0.26 or later in development. With `expo` 57.0.25, `expo start` fails to bundle it with `Worker chunk not found for: .../expo-sqlite/web/worker.ts`, because lazy bundling leaves web-worker modules out of the graph, and `npx expo install expo` moves to the fixed release. Keep lazy bundling on and do not set `EXPO_NO_METRO_LAZY`, because Metro loads the Kizuna engine worker as a split bundle and with lazy bundling off the web driver cannot start that worker (`Bundle splitting is required for Web Worker imports`).

## Next steps

- [React](react.md): the hooks in detail, and the same client factory for the browser.
- [Offline writes](../sync/offline-writes.md): queue writes, show sync state, and handle a rejection.
- [Media and attachments](../attachments/media-and-attachments.md): files through the Expo file store.
- [Swift and Kotlin](native-clients.md): a native host without React Native.
- [Playground](./playground.md): the shipped Expo example and how to run it.
