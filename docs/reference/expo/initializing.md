---
title: Initializing
description: Build the app client over the Expo driver, which carries the device network and foreground signals.
status: alpha
docType: reference
library: expo
pageKind: initializing
audience: app-developer
---

# Expo: Initializing

On React Native the app client needs a driver that names the local database and brings the device's network and foreground signals, which a browser provides on its own. `openExpoDriver` is that driver: it names the expo-sqlite file and carries a NetInfo [connectivity](./create-expo-connectivity.md) port and an `AppState` [foreground](./create-expo-foreground.md) port. [`createSupabaseKizunaSync`](../javascript/initializing.md) builds one [`IKizunaSync`](../javascript/types.md) client over it after `kizunasync init` has provisioned the Supabase project.

The app builds that client once, at module scope, in `src/kizunasync.ts`, and the root layout `src/app/_layout.tsx` wraps the navigator in the provider. [Expo / React Native](../../getting-started/expo.md) walks through the full wiring, from the Supabase client to a screen that reads and writes.

## Examples

### Create the app client

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { openExpoDriver } from 'kizunasync/expo'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
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

The config repeats each table's sync mode and bucket column as [`kizunasync status`](../../cli/cli.md#kizunasync-status) reports them. `openExpoDriver` returns at once, and building the client opens no engine and no database: the engine opens on the client's first use, which is usually the first hook that reads, and the first sync starts right then. That keeps `src/kizunasync.ts` safe to import during Expo Router's static rendering of web routes, because on web the driver resolves the engine binary's asset URL only when its worker starts. The app client follows `supabase.auth` for the session, so nothing else is passed.

### Sign in anonymously

An app whose first run has no sign-in screen passes `anonymousSignIn: true`, and the app client signs in an anonymous user when it finds no session. Anonymous sign-ins have to be enabled on the Supabase project.

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { openExpoDriver } from 'kizunasync/expo'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: openExpoDriver('todos.db'),
  config,
  anonymousSignIn: true,
})
```

### Connect Supabase with a persisted session

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
    supabase.realtime.connect()
  } else {
    supabase.auth.stopAutoRefresh()
  }
})
```

### Provide it in the root layout

```tsx
// src/app/_layout.tsx
import { Stack } from 'expo-router'
import { KizunaSyncProvider } from 'kizunasync/react'
import { kizunasync } from '../kizunasync'

export default function RootLayout() {
  return (
    <KizunaSyncProvider client={kizunasync}>
      <Stack />
    </KizunaSyncProvider>
  )
}
```

### Show loading and errors where the data renders

The layout renders no loading screen of its own. A screen reads the loading and error states from the hook that needs the data, and an engine that cannot open, as in Expo Go, shows up there as `error`.

```tsx
// src/app/index.tsx
import { FlatList, Text } from 'react-native'
import { useQuery } from 'kizunasync/react'

export default function TodosScreen() {
  const { data: todos, error, isLoading } = useQuery((kizunasync) =>
    kizunasync.from('todos').select().order('created_at', { ascending: false }),
  )

  if (isLoading) {
    return <Text>Loading…</Text>
  }
  if (error !== null) {
    return <Text>{error.message}</Text>
  }

  return <FlatList data={todos} keyExtractor={(todo) => String(todo.id)} renderItem={({ item }) => <Text>{String(item.title)}</Text>} />
}
```

## Parameters

The Expo-specific arguments to `createSupabaseKizunaSync`. [JavaScript: Initializing](../javascript/initializing.md) lists every other option, `anonymousSignIn` included, and they behave the same on native.

| Name | Type | Required | Description |
|---|---|---|---|
| `driver` | `IStoreLocator` | Yes | The local store. `openExpoDriver(name)` for the default expo-sqlite path, or `openOpSqliteDriver(name, { location })` for the op-sqlite one. Both return synchronously, name the file the [Rust engine](./rust-engine.md) opens, and carry the NetInfo and `AppState` ports as `platformPorts`. |
| `connectivity` | `IConnectivity` | No | Replaces the driver's network signal for the sync loop. Pass one for a different gate, such as [`createExpoConnectivity({ gate: 'internet-reachable' })`](./create-expo-connectivity.md) or a port of your own. Default: the driver's NetInfo port, which gates on the radio state. |
| `foreground` | `IForeground` | No | Replaces the driver's app-became-visible signal. Pass one only when your own code decides what counts as a return to the foreground. Default: the driver's `AppState` port, the one [`createExpoForeground()`](./create-expo-foreground.md) builds. |
| `fileStore` | `IFileStore` | No | Required when a table declares an attachment column. Build it with [`openExpoFileStore()`](./open-expo-file-store.md). Default: none, and every `attachments` method rejects with `ATTACHMENT_PORTS_MISSING`. |
| `transfer` | `ITransfer` | No | On iOS and Android, pass it alongside `fileStore`: compose [`createExpoSupabaseDownload`](./create-expo-supabase-download.md) over the Storage transfer, as that page shows. Default: the Storage transfer built over `fileStore` when one is passed, which is what Expo web uses, and none otherwise. |

## Returns

`createSupabaseKizunaSync` returns an `IKizunaSync` client synchronously, and `openExpoDriver` returns its `IStoreLocator` the same way, so `src/kizunasync.ts` awaits nothing. The client's members are documented in [JavaScript: Initializing](../javascript/initializing.md#returns).

## Errors

| Code | Condition |
|---|---|
| `ATTACHMENT_PORTS_MISSING` | Thrown by `createSupabaseKizunaSync` when a table in `defineConfig` declares an attachment column and the client was built without both `fileStore` and `transfer`. [ATTACHMENT_PORTS_MISSING](../../operations/troubleshooting.md#attachment_ports_missing) names the two ports. |
| `ENGINE_UNAVAILABLE` | Not thrown here. The first engine call fails with it when the engine cannot open: in Expo Go, which carries no build of the engine, or when expo-sqlite cannot open the database or report its path. The client keeps that error, so every later call reports it too, and the hooks show it as their error state. [Rust engine](./rust-engine.md#when-neither-condition-holds) covers the causes. |
| `AUTH_SESSION_TIMEOUT` | Not thrown here. A session lookup that does not settle within `sessionTimeoutMs`, 10 seconds by default, fails one sync attempt retryably and leaves the write queued. [Sync](../javascript/sync.md#errors) lists it with the other retryable failures. |

`openOpSqliteDriver` throws a plain `Error` when `location` is missing, while `src/kizunasync.ts` loads; [op-sqlite driver](./open-op-sqlite-driver.md) quotes it. On Expo web, an engine binary Metro did not register as an asset fails the engine calls with `ENGINE_UNAVAILABLE` rather than the module's import, as [Open the SQLite driver](./open-expo-driver.md#errors) describes.

## Notes

The driver's ports are what the app client follows when the app passes none: NetInfo gates the sync loop and wakes it when the network returns, and `AppState` wakes it when the app comes back to the foreground. An explicit `connectivity` or `foreground` option wins over the driver's, and [useSyncStatus](../react/use-sync-status.md) reads whichever port the client ended up with.

On a return to the foreground the app client does three things before the next run. It refreshes the session, so an attempt never runs on an expired access token. It reconnects Realtime when the client holds channels but the socket is down. It wakes the scheduler.

Supabase's own client needs the separate `AppState` listener in `src/supabase-client.ts`. [`startAutoRefresh`](https://supabase.com/docs/reference/javascript/auth-startautorefresh#examples) keeps its stored token current, and [`stopAutoRefresh`](https://supabase.com/docs/reference/javascript/auth-stopautorefresh#examples) stops the timer in the background. Supabase pairs the same listener with a Realtime reconnect in [Reconnect when a React Native app comes to the foreground](https://supabase.com/docs/guides/troubleshooting/realtime-heartbeat-messages#reconnect-when-react-native-app-comes-to-foreground).

`src/supabase-client.ts` persists the Supabase session in the `localStorage` that `expo-sqlite` installs, the way Supabase's [Expo quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/expo-react-native) does, so queued writes keep the same identity after a relaunch. With `anonymousSignIn: true` the app client restores that stored user rather than signing in a new one. An app with its own sign-in screen signs the user in with supabase-js, and the next sync carries that session. [Expo / React Native](../../getting-started/expo.md#2-connect-supabase) walks the whole step, including the environment variables a physical device needs.

A `byOwner` bucket needs no [`setBucket`](../javascript/set-bucket.md) call: the engine fills it with the signed-in user, also offline after a restart. A different user signing in on the same device soft-blocks sync with `identity_changed` until [`reset()`](../javascript/reset.md) runs, so an account switch is a `reset()`.

Picking the op-sqlite driver over the default adds one release obligation: run [Verify op-sqlite](./verify-op-sqlite-driver.md) on a device, because the optional peer is native code that no check above the port can see.

## Next steps

- [Read data](../react/use-query.md): list rows from the local database with `useQuery`.
- [Write data](../react/use-mutation.md): insert, update, and delete through `useMutation`.
- [Show sync state](../react/use-sync-status.md): render the outbox depth, the online signal, and a **Sync now** button with `useSyncStatus`.
- [Reach the client](../react/use-kizunasync.md): call any other client member through `useKizunaSync`.

Nothing else has to run for the data to move. The client syncs on its own when it is first used, after every local write, on a jittered poll, when the network or the app comes back, and on a Realtime doorbell signal, so the app calls [`sync()`](../javascript/sync.md) only for a **Sync now** button, a pull-to-refresh gesture, or a test.

## Related reference

- [Installing](./installing.md)
- [Open the SQLite driver](./open-expo-driver.md)
- [Connectivity](./create-expo-connectivity.md)
- [Foreground](./create-expo-foreground.md)
- [JavaScript: Initializing](../javascript/initializing.md)
- [React: Initializing](../react/initializing.md)
- [Vue: Initializing](../vue/initializing.md)
