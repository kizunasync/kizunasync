---
title: React
description: Wire KizunaSyncProvider and @kizunasync/react hooks into a React app.
status: alpha
docType: how-to
audience: app-developer
---

# React

Build a React app that reads and writes locally, so the interface keeps working with no network and catches up when one returns. You create the app client once in `src/kizunasync.ts`, wrap the app in [`KizunaSyncProvider`](../reference/react/initializing.md), and read and write through the `@kizunasync/react` hooks. The app client pushes your writes and pulls changes from other devices by itself.

## Before you begin

- A Supabase project provisioned with [`kizunasync`](../cli/cli.md) in your app repository. Follow the [Quick start](./quickstart.md) and [Install](../cli/install.md) if you have not run [`kizunasync init`](../cli/cli.md#kizunasync-init).
- React 19 or later ([React install guide](https://react.dev/learn/installation)) in a [Vite](https://vite.dev/guide/) app. The file paths below follow Vite's React template, and [Vite](./vite.md) explains how the browser runs the engine.
- A way for users to sign in to Supabase: your own sign-in screen, or [anonymous sign-ins](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) enabled on the project. Step 5 covers both, and your [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#insert-policies) policies judge every pushed row under that user.
- Skim the [React reference introduction](../reference/react/introduction.md) for package scope and the hook inventory.

## 1. Install

Install `@kizunasync/react`, `@kizunasync/core`, `@kizunasync/supabase`, `@kizunasync/web`, and `@supabase/supabase-js` from npm as shown in [React: Installing](../reference/react/installing.md). `@supabase/supabase-js` is the Supabase client step 2 creates, and `@kizunasync/supabase` takes it as a peer. You should now resolve `KizunaSyncProvider` from `@kizunasync/react`.

## 2. Connect Supabase

Create the Supabase client in a file of its own, so the app client and your sign-in code share one session.

```ts
// src/supabase-client.ts
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (url === undefined || publishableKey === undefined) {
  throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.')
}

export const supabase = createClient(url, publishableKey)
```

Put the two values in `.env.local` at the root of the app. Vite exposes a variable to browser code only when its name starts with `VITE_`.

```bash
# .env.local
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<your publishable key>
```

The project URL and the publishable key come from the project's API settings, which Supabase describes under [API keys](https://supabase.com/docs/guides/api/api-keys#publishable-keys-and-public-components). In a browser, supabase-js keeps the session in `localStorage` and refreshes the access token on its own, so a reload keeps the same user with no extra options.

## 3. Create the app client

Create the app client once, at module scope, in `src/kizunasync.ts`. Every other file imports it from there.

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

Declare each table with the options `kizunasync init` recorded. [`kizunasync status`](../cli/cli.md#kizunasync-status) prints them per table as `syncMode` and `bucketColumn`: a `read-write` table takes `sync: 'read-write'`, and a bucket column that holds the owner's user id takes `bucket: byOwner('user_id')`. The engine fills a `byOwner` bucket with the signed-in user's id and remembers that user in the local database, so after a restart the bucket and every new insert carry that user before the app reaches the network. A table without a bucket column takes no `bucket` option, and [Define config](../reference/javascript/define-config.md) lists the remaining options, `conflict` and `softDelete` among them.

## 4. Provide it to the app

Wrap the app in `KizunaSyncProvider` in `src/main.tsx`, so every hook below it reads the same client:

```tsx
// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { KizunaSyncProvider } from '@kizunasync/react'
import { TodoList } from './components/todo-list'
import { kizunasync } from './kizunasync'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KizunaSyncProvider client={kizunasync}>
      <TodoList />
    </KizunaSyncProvider>
  </StrictMode>,
)
```

The root renders `TodoList`, which you write in step 6. Nothing else in the app creates the client or passes it around.

## 5. Sign in

The app client follows `supabase.auth` on its own. It pulls and pushes as whichever user supabase-js holds a session for, and it picks up a sign-in, a token refresh, or a sign-out without a call from your code. Get that session in one of two ways:

- An app with its own sign-in screen signs in with supabase-js, for example with [`signInWithPassword`](https://supabase.com/docs/reference/javascript/auth-signinwithpassword#examples). [Supabase Auth](https://supabase.com/docs/guides/auth) covers every sign-in method.
- An app whose first visit has no sign-in screen adds `anonymousSignIn: true` to the `createSupabaseKizunaSync` options in `src/kizunasync.ts`. When a sync finds no session, the client restores the session this browser already had, or signs in a new anonymous user, and a sync that fails offline tries again on the next run. The project needs [anonymous sign-ins](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) enabled.

Switching accounts on the same device takes a [`reset()`](../reference/javascript/reset.md). When a different user signs in, the engine soft-blocks sync with `identity_changed` until `reset()` runs, so writes queued under one user never go out under another. [Sync soft-blocks after switching accounts](../operations/troubleshooting.md#sync-soft-blocks-after-switching-accounts) walks through it.

## 6. Read and write

One component can list the todos and add one. [`useQuery`](../reference/react/use-query.md) reads the local [SQLite](https://grokipedia.com/page/SQLite) database and renders again when the rows change, and [`useMutation`](../reference/react/use-mutation.md) runs the insert.

```tsx
// src/components/todo-list.tsx
import { useMutation, useQuery } from '@kizunasync/react'

type TTodo = { id: string; title: string }

export function TodoList() {
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
    <main>
      <button type="button" onClick={addTodo}>
        Add a todo
      </button>
      {error !== null && <p role="alert">{error.message}</p>}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
    </main>
  )
}
```

The insert leaves out `id`, which [`insert`](../reference/javascript/insert-data.md) mints, and `user_id`, which the engine fills with the signed-in user's id because the table uses `byOwner`. An insert made before any user has signed in on this browser keeps only the columns you gave it. Pass `created_at` yourself: a row that omits it has no value locally until the server answers, so it sorts to the wrong end of this list. `error` carries a read that failed, including a local database the browser could not open.

The call shape follows Supabase's [`select`](https://supabase.com/docs/reference/javascript/select), [modifiers](https://supabase.com/docs/reference/javascript/using-modifiers), and [`insert`](https://supabase.com/docs/reference/javascript/insert) within the [local query subset](../reference/query-operators.md). The read answers from local SQLite, and the insert commits locally and waits in the [outbox](../resources/glossary.md#outbox) until the client pushes it. You should now see a new todo at the top of the list as soon as you press **Add a todo**, with or without a network.

## What runs on its own

The app needs no sync call of its own for the data to move. Each of these events starts a sync run, which pushes the outbox and then pulls:

- The app uses the client for the first time, as the first `useQuery` read does. The client opens the local database and syncs right away.
- A local write adds to the outbox, as the insert in step 6 does.
- The poll fires at a random point between half the poll interval and the whole interval. `pollIntervalMs` defaults to `15000`, and `0` turns the poll off.
- The browser reports that the network is back.
- The tab becomes visible, resumes after the browser froze it, or comes back from the back/forward cache. The client refreshes the session before that run.
- The Realtime doorbell reports that a synced table changed on the server.
- This tab takes over the engine after the tab that ran it closed.

Tabs that open the same database share one engine. Only the tab running it drives the loop, and the other tabs send their reads and writes to that tab. A run that fails is retried by the next of these events, and consecutive failures stretch the poll delay up to 30 seconds with the default interval.

Call [`sync()`](../reference/javascript/sync.md) yourself only for a **Sync now** button, a pull-to-refresh gesture, or a test that needs the outbox delivered before it checks the server. The `syncNow` function in the next step is that call.

## 7. Show sync state

Surface the outbox depth and a manual sync trigger with [`useSyncStatus`](../reference/react/use-sync-status.md):

```tsx
// src/components/sync-bar.tsx
import { useSyncStatus } from '@kizunasync/react'

export function SyncBar() {
  const { outboxDepth, isOnline, isSyncing, isStalled, syncNow } = useSyncStatus()

  return (
    <button type="button" onClick={() => void syncNow()} disabled={isSyncing}>
      {!isOnline ? 'Offline' : isStalled ? 'Reconnecting…' : isSyncing ? 'Syncing…' : `Sync now (${outboxDepth} pending)`}
    </button>
  )
}
```

Render `<SyncBar />` anywhere under the provider, for example above the button in `src/components/todo-list.tsx`. `isOnline` follows the same network signal the client's sync loop follows. The hook also returns `health`, `nextRetryAt`, `lastError`, and `checkpoint` when you want a fuller indicator, and [Sync health](../reference/javascript/sync-health.md) documents that snapshot field by field. `isSyncing` covers your own `syncNow()` call alone, so a background poll never flickers the button, and `isStalled` turns true once an attempt has gone two poll ticks without settling. [Offline writes](../sync/offline-writes.md#2-show-sync-state-in-your-ui) builds the complete indicator.

## Verify it worked

Start the dev server against the provisioned project, and sign in if your app has a sign-in screen. The list renders after the first local read, and a new todo appears as soon as you add it. With the network on, the pending count returns to `0` within a few seconds without pressing the button, and the row appears in the Table Editor of Supabase Studio with your user's id in `user_id`. Switch the browser to offline in its developer tools, add a todo, and switch back: the count rises while offline and drains by itself once the connection returns.

## Common errors

- `useKizunaSync: no Kizuna client found` means a hook ran outside `KizunaSyncProvider` with no `{ client }` override.
- An error message under the button means the local database did not open, for example in a browser that can open neither the OPFS pool nor IndexedDB. The app client keeps that error for the life of the page and does not try to open again.
- Writes stay pending and `health.lastError.code` is `AUTH_SESSION_MISSING` when no user has signed in. Sign in with supabase-js or pass `anonymousSignIn: true`, as step 5 describes. With `anonymousSignIn: true` on a project that has anonymous sign-ins turned off, every sync fails its sign-in until you turn them on.
- Sync soft-blocks with `identity_changed` after another user signs in on the same browser. Run `reset()`, as step 5 describes.
- `BUCKET_UNSET` on a pull means a table declared with `byColumn` has no value yet, because [`setBucket`](../reference/javascript/set-bucket.md) never filled it. See [`BUCKET_UNSET`](../operations/troubleshooting.md#bucket_unset).
- A second client on one database appears when more than one module calls `createSupabaseKizunaSync` for the same database name. Create it once, in `src/kizunasync.ts`. See [Local web database will not open](../operations/troubleshooting.md#local-web-database-will-not-open).

## Next steps

- [Vite](./vite.md): how the browser runs the engine in a worker, and the same client module.
- [Offline writes](../sync/offline-writes.md): queue writes, show sync state, and handle a rejection.
- [Media and attachments](../attachments/media-and-attachments.md): files through `useAttachment`.
- [Expo / React Native](expo.md): the same hooks on a native host.
- [Swift and Kotlin](native-clients.md): the client without React.
