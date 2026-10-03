---
title: Initializing
description: Build the client once at module scope, then hand it to the app with createKizunaSyncPlugin or provideKizunaSync.
status: alpha
docType: reference
library: vue
pageKind: initializing
audience: app-developer
---

# Vue: Initializing

`createKizunaSyncPlugin` and `provideKizunaSync` seed one [`IKizunaSync`](../javascript/types.md) client into Vue's provide scope, so every composable below it resolves the same instance and the same local database. The app builds that client once, at module scope, in `src/kizunasync.ts`, and [Vue](../../getting-started/vue.md) wires it into a running project step by step.

## Examples

### Create the app client

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { createWebWorkerDriver } from 'kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
})
```

The config repeats the table options `kizunasync init` provisioned. The driver brings the browser's network signal, and the app client follows `supabase.auth` for the session, so nothing else is passed. Building the client opens no engine and no database: the engine opens on the client's first use, which is usually the first composable that reads, and the first sync starts right then.

### Sign in anonymously

An app whose first run has no sign-in screen passes `anonymousSignIn: true`, and the app client signs in an anonymous user when it finds no session. Anonymous sign-ins have to be enabled on the Supabase project.

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { createWebWorkerDriver } from 'kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
  anonymousSignIn: true,
})
```

### Register the plugin

```ts
// src/main.ts
import { createApp } from 'vue'
import { createKizunaSyncPlugin } from 'kizunasync/vue'
import App from './App.vue'
import { kizunasync } from './kizunasync'

createApp(App).use(createKizunaSyncPlugin(kizunasync)).mount('#app')
```

### Show loading and errors where the data renders

The root mounts at once and shows no loading screen of its own. A component reads the loading and error states from the composable that needs the data.

```vue
<!-- src/components/TodoList.vue -->
<script setup lang="ts">
import { useQuery } from 'kizunasync/vue'

const { data: todos, error, isLoading } = useQuery((kizunasync) =>
  kizunasync.from('todos').select().order('created_at', { ascending: false }),
)
</script>

<template>
  <p v-if="isLoading">Loading…</p>
  <p v-else-if="error !== null" role="alert">{{ error.message }}</p>
  <ul v-else>
    <li v-for="todo in todos" :key="String(todo.id)">{{ todo.title }}</li>
  </ul>
</template>
```

### Provide from a component instead

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import { provideKizunaSync } from 'kizunasync/vue'
import TodoList from './components/TodoList.vue'
import { kizunasync } from './kizunasync'

provideKizunaSync(kizunasync)
</script>

<template>
  <TodoList />
</template>
```

`provideKizunaSync` seeds the client for the component that calls it and everything below it, so this `App.vue` works without the plugin in `src/main.ts`.

## Parameters

`createKizunaSyncPlugin` and `provideKizunaSync` each take one argument.

| Name | Type | Required | Description |
|---|---|---|---|
| `client` | `IKizunaSync` | Yes | The instance every composable under this scope resolves when it is given no `{ client }` override. Build it with [`createSupabaseKizunaSync`](../javascript/initializing.md), which lists every client option. |

## Returns

`createKizunaSyncPlugin` returns a Vue plugin object; `provideKizunaSync` returns nothing.

| Name | Type | Required | Description |
|---|---|---|---|
| `install` | `(app: App) => void` | — | The plugin hook `app.use()` calls. It provides the client at app level, so the whole tree resolves it without a wrapper component. |

## Errors

Neither helper throws. A composable that runs outside the provide scope, with no `{ client }` override, throws from [useKizunaSync](./use-kizunasync.md) with this message.

```text
useKizunaSync: no Kizuna client found. Pass an explicit { client }, or provide one from an ancestor: <KizunaSyncProvider client={kizunasync}> in React, provideKizunaSync(kizunasync) in Vue.
```

An engine that cannot open, with `ENGINE_UNAVAILABLE` or `STORE_BUSY`, throws nothing at import or during `setup()` either. The app client keeps that typed error and every engine call rejects with it, so [useQuery](./use-query.md) reports it in `error` and [useSyncStatus](./use-sync-status.md) in `lastError` and `health.lastError`.

## Notes

`createKizunaSyncPlugin` and `provideKizunaSync` seed the same injection key, so pick by where the provide belongs. The plugin provides the client to the whole app; `provideKizunaSync` provides it to one component's subtree, and the nearer scope wins for its own subtree.

`kizunasyncInjectionKey` is exported beside both helpers, so a component can call Vue's own `provide` and `inject` against the same symbol rather than going through either one.

The client is a module-scope constant, so every import and every remount reuses the same instance over the same database file. Building it opens no worker and no connection, which keeps `src/kizunasync.ts` safe to import during a server-side render.

The app client follows `supabase.auth`. An app with its own sign-in signs the user in with supabase-js, for example with [`signInWithPassword`](https://supabase.com/docs/reference/javascript/auth-signinwithpassword), and the next sync carries that session. A `byOwner` bucket needs no [`setBucket`](../javascript/set-bucket.md) call: the engine fills it with the signed-in user, also offline after a restart. A different user signing in on the same device soft-blocks sync with `identity_changed` until [`reset()`](../javascript/reset.md) runs, so an account switch is a `reset()`.

The client's lifetime belongs to your app, not to the component tree. Providing it does not open the database, unmounting does not close it, and `dispose()` on the client releases the engine's own subscriptions when your app tears down for good.

[Vite](../../getting-started/vite.md) covers the browser worker the driver starts. On a native host `src/kizunasync.ts` swaps the driver and keeps the rest: [Expo: Initializing](../expo/initializing.md) shows `openExpoDriver`, which also carries the network and foreground signals [React Native](https://reactnative.dev) needs.

## Next steps

1. Read rows in a component with [useQuery](./use-query.md).
2. Write rows with [useMutation](./use-mutation.md).
3. Show sync state with [useSyncStatus](./use-sync-status.md).
4. Reach the rest of the client with [useKizunaSync](./use-kizunasync.md).

Nothing else has to run for the data to move. The app client syncs on its own in the tab that leads the database: when it is first used, after every local write, on a jittered poll, when the network or the tab comes back, and on a Realtime doorbell signal, so the app calls [`sync()`](../javascript/sync.md) only for a **Sync now** button, a pull-to-refresh gesture, or a test.

## Related reference

- [Installing](./installing.md)
- [useKizunaSync](./use-kizunasync.md)
- [JavaScript: Initializing](../javascript/initializing.md)
- [React: Initializing](../react/initializing.md)
- [Expo: Initializing](../expo/initializing.md)
