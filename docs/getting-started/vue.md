---
title: Vue
description: Wire @kizunasync/vue composables into a Vue 3 app.
status: alpha
docType: how-to
audience: app-developer
---

# Vue

Build a Vue app that reads and writes locally, so the interface keeps working with no network and catches up when one returns. You create the app client once in `src/kizunasync.ts`, install it on the app with the plugin from `@kizunasync/vue` in `src/main.ts`, and read and write through the composables. The app client pushes your writes and pulls changes from other devices by itself.

## Before you begin

- A Supabase project provisioned with [`kizunasync`](../cli/cli.md) in your app repository. Follow the [Quick start](./quickstart.md) and [Install](../cli/install.md) if you have not run [`kizunasync init`](../cli/cli.md#kizunasync-init).
- Vue `^3.5.13` ([Vue install guide](https://vuejs.org/guide/quick-start.html)) and a Vite app that resolves `@kizunasync/web` workers. [Vite](./vite.md) describes the browser engine and why Vite needs no extra settings for it.
- A way for users to sign in to Supabase: your own sign-in screen, or [anonymous sign-ins](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) enabled on the project. Step 5 covers both.
- Skim the [Vue reference introduction](../reference/vue/introduction.md) for composable scope.

## 1. Install

Install `@kizunasync/vue`, `@kizunasync/core`, `@kizunasync/supabase`, and `@kizunasync/web` from npm as shown in [Vue: Installing](../reference/vue/installing.md). `@kizunasync/supabase` expects `@supabase/supabase-js` as a peer, so add it too if your app does not use it yet. You should now resolve `createKizunaSyncPlugin` from `@kizunasync/vue`.

## 2. Connect Supabase

Create the supabase-js client in its own file, so the app client and your sign-in code share one session. Vite exposes to browser code only the variables whose names start with `VITE_`, and the key is the project's [publishable key](https://supabase.com/docs/guides/api/api-keys#publishable-keys-and-public-components).

```sh
# .env.local
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
```

```ts
// src/supabase-client.ts
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !publishableKey) {
  throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.')
}

export const supabase = createClient(url, publishableKey)
```

In a browser, supabase-js keeps the session in `localStorage` and refreshes its access token on its own, which is how a reload comes back as the same user. The app client reads that session before every pull and push, so this file needs no Kizuna-specific option. Supabase describes the session itself in [Auth sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session). You should now be able to import `supabase` from `./supabase-client` anywhere in the app.

## 3. Create the app client

Create the app client once, at module scope, in `src/kizunasync.ts`. Every other file imports it from there, and components reach it through the plugin in step 4.

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
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

Creating the client opens no database and starts no timer. The first query or write opens the local database in the browser worker, and the first sync runs right away. [`createWebWorkerDriver`](../reference/javascript/create-web-worker-driver.md) also hands the client the browser's online and offline events, so there is nothing else to pass.

The config declares each table with the options `kizunasync init` provisioned for it. [`kizunasync status`](../cli/cli.md#kizunasync-status), the command the [Quick start](./quickstart.md#4-confirm-project-shape) runs, lists each table's `syncMode` and `bucketColumn`, and those become `sync` and `bucket` here. A bucket column that holds the owner's user id takes `byOwner(column)`, and the engine fills it with the signed-in user's id and remembers that user in the local database, so after a restart the bucket and every new insert carry that user before the app reaches the network. A column your app fills at runtime takes `byColumn(column)` and a [`setBucket`](../reference/javascript/set-bucket.md) call, and a table with no bucket column leaves `bucket` out. [Define config](../reference/javascript/define-config.md#parameters) lists the other table options.

## 4. Provide it to the app

Install [`createKizunaSyncPlugin`](../reference/vue/initializing.md) on the app in `src/main.ts`. The plugin provides the client at app level, so every composable in the tree resolves it without a wrapper component.

```ts
// src/main.ts
import { createApp } from 'vue'
import { createKizunaSyncPlugin } from '@kizunasync/vue'
import App from './App.vue'
import { kizunasync } from './kizunasync'

createApp(App).use(createKizunaSyncPlugin(kizunasync)).mount('#app')
```

The app mounts at once, because the client needs nothing opened first. You should now see your `App.vue` render as before.

## 5. Sign in

The app client follows `supabase.auth` on its own. It pulls and pushes as whichever user supabase-js holds a session for, and it picks up a sign-in, a token refresh, or a sign-out without a call from your code. Get that session in one of two ways:

- An app with its own sign-in screen signs in with supabase-js, for example with [`signInWithPassword`](https://supabase.com/docs/reference/javascript/auth-signinwithpassword#examples). [Supabase Auth](https://supabase.com/docs/guides/auth) covers every sign-in method.
- An app whose first visit has no sign-in screen adds `anonymousSignIn: true` to the `createSupabaseKizunaSync` options in `src/kizunasync.ts`. When a sync finds no session, the client restores the session this browser already had, or signs in a new anonymous user, and a sync that fails offline tries again on the next run. The project needs [anonymous sign-ins](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) enabled.

Switching accounts on the same device takes a [`reset()`](../reference/javascript/reset.md). When a different user signs in, the engine soft-blocks sync with `identity_changed` until `reset()` runs, so writes queued under one user never go out under another. [Sync soft-blocks after switching accounts](../operations/troubleshooting.md#sync-soft-blocks-after-switching-accounts) walks through it.

## 6. Read and write

Read and write in any component under `App`. This `src/App.vue` lists todos with [`useQuery`](../reference/vue/use-query.md) and adds one with [`useMutation`](../reference/vue/use-mutation.md).

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import { useMutation, useQuery } from '@kizunasync/vue'

type TTodo = { id: string; title: string }

const { data: todos, error } = useQuery<TTodo>((kizunasync) =>
  kizunasync.from('todos').select().order('created_at', { ascending: false }),
)
const { mutate } = useMutation()

function addTodo(): void {
  void mutate((kizunasync) =>
    kizunasync.from('todos').insert({ title: 'works on a plane', done: false, created_at: new Date().toISOString() }),
  )
}
</script>

<template>
  <button type="button" @click="addTodo">Add a todo</button>
  <p v-if="error" role="alert">{{ error.message }}</p>
  <ul>
    <li v-for="todo in todos" :key="todo.id">{{ todo.title }}</li>
  </ul>
</template>
```

The read answers from [local SQLite](https://grokipedia.com/page/SQLite) and runs again on every engine event that can change a row, so a local write and a pulled row both reach the list without a refetch call. The write commits to the local database at once and waits in the [outbox](../resources/glossary.md#outbox) until the app client pushes it.

The insert leaves out `id`, which [`insert`](../reference/javascript/insert-data.md) mints, and `user_id`, which the engine fills with the signed-in user's id because the table uses `byOwner`. An insert made before any user has signed in on this browser keeps only the columns you gave it. Pass `created_at` yourself: a row that omits it has no value locally until the server answers, so it sorts to the wrong end of this list. `error` carries a read that failed, including a local database the browser could not open.

The call shape follows Supabase's [`select`](https://supabase.com/docs/reference/javascript/select), [modifiers](https://supabase.com/docs/reference/javascript/using-modifiers), and [`insert`](https://supabase.com/docs/reference/javascript/insert) within the [local query subset](../reference/javascript/fetch-data.md#local-query-compatibility-matrix).

You should now see "works on a plane" at the top of the list as soon as you click **Add a todo**, before the server has seen the row.

## What runs on its own

Nothing else in your code has to call the engine to keep it in sync. Each run pushes the outbox and then pulls, and these signals start one:

- The app uses the client for the first time, as the first `useQuery` read does. The client opens the local database and syncs right away.
- A local write starts a run as soon as it lands in the outbox.
- A poll tick fires at a random point between half the poll interval and the whole interval. The interval is 15 seconds unless `pollIntervalMs` changes it, and `0` turns the poll off.
- The network coming back starts a run, as soon as the browser reports it.
- The tab coming back to the foreground starts a run when it becomes visible, resumes after being frozen, or returns from the back/forward cache. The app client refreshes the session before that run.
- A Supabase Realtime message from the server's doorbell starts a run. The message says that rows changed and carries no row data.
- A tab that becomes the leader for the database starts a run of its own at once.

Runs never overlap, and a burst of signals collapses into one run. Only the leader tab runs the loop: the tabs open on one database elect one leader, which owns the worker, and the other tabs send their calls to it and receive its events, so every tab still shows the same rows.

Call [`sync()`](../reference/javascript/sync.md) yourself only when a person asks for it, as a **Sync now** button or a pull-to-refresh gesture does, or in a test that needs the outbox delivered at a known point. [`createSupabaseKizunaSync`](../reference/javascript/initializing.md#parameters) lists the options that tune the loop. Step 7 makes the loop visible: the pending count falls back to 0 after a write with no click.

## 7. Show sync state

Surface outbox depth and a manual sync trigger with [`useSyncStatus`](../reference/vue/use-sync-status.md):

```vue
<!-- src/components/SyncButton.vue -->
<script setup lang="ts">
import { useSyncStatus } from '@kizunasync/vue'

const { outboxDepth, isOnline, isSyncing, isStalled, syncNow } = useSyncStatus()
</script>

<template>
  <button :disabled="isSyncing" @click="void syncNow()">
    <span v-if="!isOnline">Offline</span>
    <span v-else-if="isStalled">Reconnecting…</span>
    <span v-else-if="isSyncing">Syncing…</span>
    <span v-else>Sync ({{ outboxDepth }} pending)</span>
  </button>
</template>
```

Render it from `src/App.vue`: add `import SyncButton from './components/SyncButton.vue'` to its `<script setup>` block and `<SyncButton />` above the list.

Every reactive field is a ref, and `syncNow` is a plain function. `isOnline` follows the same network signal the client's sync loop follows. The composable also returns `health`, `nextRetryAt`, `lastError`, and `checkpoint` for a fuller indicator, which [Sync health](../reference/javascript/sync-health.md) documents field by field. `isSyncing` covers your own `syncNow()` call alone, and `isStalled` turns true once an attempt has gone two poll ticks without settling. [Offline writes](../sync/offline-writes.md#2-show-sync-state-in-your-ui) builds the complete indicator.

## Verify it worked

Start your app against a provisioned Supabase project, and sign in if your app has a sign-in screen. The list renders after the first local read, and a new todo appears at once. The button's pending count goes back to 0 shortly after, with no click, because the write itself woke the sync loop. Switch the browser's developer tools to offline, add another todo, and the button shows **Offline** until you go back online, when the count drains on its own. The rows then appear in the `todos` table in Supabase Studio, with your user's id in `user_id`.

## Common errors

- `useKizunaSync: no Kizuna client found` means a composable ran in an app that has no client provided. Install `createKizunaSyncPlugin` on the app that renders your components, as `src/main.ts` does, or call `provideKizunaSync` in an ancestor component.
- An error message above the list means the local database did not open, for example in a browser that can open neither the OPFS pool nor IndexedDB, which [Vite](./vite.md) explains. The app client keeps that error for the life of the page and does not try to open again.
- Writes stay pending and `health.lastError.code` is `AUTH_SESSION_MISSING` when no user has signed in. Sign in with supabase-js or pass `anonymousSignIn: true`, as step 5 describes. With `anonymousSignIn: true` on a project that has anonymous sign-ins turned off, every sync fails its sign-in until you turn them on.
- An app opened offline shows the local list and accepts writes even when the stored access token expired since its last refresh. The writes wait in the outbox, and the next run after the network returns reads the session, which supabase-js refreshes first, and pushes them.
- `BUCKET_UNSET` on a pull means a table declared with `byColumn` has no value yet, because `setBucket` never filled it. See [`BUCKET_UNSET`](../operations/troubleshooting.md#bucket_unset).
- The list shows empty for a moment on load because the first local read is asynchronous. `useQuery` also returns `isLoading`, which stays true until that read resolves.
- If writes never reach the server, confirm connectivity and that the session matches RLS. See [Sync goes quiet after sleep, background, or a token expiry](../operations/troubleshooting.md#sync-goes-quiet-after-sleep-background-or-a-token-expiry).

## Next steps

- [Vite](./vite.md): the browser engine, the worker, and the tab leader behind this client.
- [Offline writes](../sync/offline-writes.md): queue writes, show sync state, and handle a rejection.
- [Sync rules and buckets](../sync/sync-rules-and-buckets.md): which rows reach the device.
- [Media and attachments](../attachments/media-and-attachments.md): files through `useAttachment`.
- [React](react.md): the hook equivalents.
- [Swift and Kotlin](native-clients.md): the client without Vue.
