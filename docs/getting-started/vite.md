---
title: Vite
description: Wire @kizunasync/web into a Vite React or Vue app.
status: alpha
docType: how-to
audience: app-developer
---

# Vite

Wire `@kizunasync/web` into a Vite-based React or Vue app after [`kizunasync init`](../cli/cli.md#kizunasync-init) provisions your Supabase project. The browser runs the Rust engine as [WebAssembly](https://grokipedia.com/page/WebAssembly) in a dedicated worker. This page creates the app client once in `src/kizunasync.ts` and provides it from a React root, and [Vue](vue.md) provides the same module from `src/main.ts`.

## Before you begin

- A Supabase project provisioned with [`kizunasync`](../cli/cli.md) in your app repository. Follow the [Quick start](./quickstart.md) and [Install](../cli/install.md) if you have not run `kizunasync init`.
- A Vite app ([Vite guide](https://vite.dev/guide/)) that resolves `@kizunasync/web` worker and wasm imports. The file paths below follow Vite's React template.
- A way for users to sign in to Supabase: your own sign-in screen, or [anonymous sign-ins](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) enabled on the project. Step 5 covers both, and your [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#insert-policies) policies judge every pushed row under that user.
- Skim the [JavaScript reference introduction](../reference/javascript/introduction.md) for core client scope.

## 1. Install

Install `@kizunasync/core`, `@kizunasync/supabase`, and `@kizunasync/web` from npm as shown in [JavaScript: Installing](../reference/javascript/installing.md); add `@kizunasync/react` or `@kizunasync/vue` for hooks or composables. `@kizunasync/supabase` declares `@supabase/supabase-js` as a peer, so add that package too if the app does not use it yet. You should now resolve [`createSupabaseKizunaSync`](../reference/javascript/initializing.md) from `@kizunasync/supabase`.

Vite needs no driver-specific configuration. `@kizunasync/web` starts its worker with `new URL('./worker.ts', import.meta.url)`, and that worker loads its WebAssembly the same way, so Vite emits both as real chunks without help.

[`createWebWorkerDriver`](../reference/javascript/create-web-worker-driver.md) hands the client an engine rather than a [local SQLite](https://grokipedia.com/page/SQLite) connection. The worker compiles the Rust core to WebAssembly and opens the database through the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool. That pool is why the engine runs in a worker, because only a worker can take a synchronous access handle. Where the browser lacks the pool outright (no synchronous-access-handle support, a missing `getDirectory`, or a private-mode `SecurityError`), the worker opens a relaxed [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) store instead; any other failure raises `STORE_UNAVAILABLE` rather than silently reopening an empty store. A pool another tab is holding is a different case. The worker retries it for about 1.8 s, then fails with an error naming the database, rather than opening an empty store. Neither backend uses `SharedArrayBuffer`, so a browser build needs no COOP or COEP headers.

The engine answers `store_kind` with the store it opened and the durability that store gives an acknowledged write. The OPFS pool reports `full`, and the IndexedDB fallback reports `relaxed`, meaning a write survives an orderly shutdown but is not proven against an abrupt one. The driver copies that answer into `capabilities.durability` once the store is open.

Tabs share one engine rather than one file. Every tab on a database races for a [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) named after it, the winner starts the worker, and the others send their calls to the winner over a `BroadcastChannel` and receive its events the same way. When the leading tab goes away, the lock is released, one of the waiting tabs is promoted, and it starts a worker behind the transport the client already holds. Building the driver starts none of this: the lock request, the channel, and the worker wait for the app client's first call.

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

Create the app client once, at module scope, in `src/kizunasync.ts`. Every other file imports it from there, and [JavaScript: Initializing](../reference/javascript/initializing.md) lists every option.

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

Creating the client opens no database and starts no timer. The first query or write starts the worker, opens the local database, and runs the first sync right away. The driver also hands the client the browser's online and offline events, so there is nothing else to pass.

Declare each table with the options `kizunasync init` recorded. [`kizunasync status`](../cli/cli.md#kizunasync-status) prints them per table as `syncMode` and `bucketColumn`: a `read-write` table takes `sync: 'read-write'`, and a bucket column that holds the owner's user id takes `bucket: byOwner('user_id')`. The engine fills a `byOwner` bucket with the signed-in user's id and remembers that user in the local database, so after a restart the bucket and every new insert carry that user before the app reaches the network. A table without a bucket column takes no `bucket` option, and [Define config](../reference/javascript/define-config.md) lists the remaining options.

## 4. Provide it to the app

Wrap the app in [`KizunaSyncProvider`](../reference/react/initializing.md) in `src/main.tsx`, so every hook below it reads the same client. In a Vue app the root file is `src/main.ts`, and [Vue](vue.md) shows it over this same module.

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

One component can list the todos and add one. See [Fetch data](../reference/javascript/fetch-data.md) and [Insert data](../reference/javascript/insert-data.md) for the calls, and [`useQuery`](../reference/react/use-query.md) and [`useMutation`](../reference/react/use-mutation.md) for the hooks around them.

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

Those calls follow Supabase's [`select`](https://supabase.com/docs/reference/javascript/select), [modifiers](https://supabase.com/docs/reference/javascript/using-modifiers), and [`insert`](https://supabase.com/docs/reference/javascript/insert) within the [local query subset](../reference/javascript/fetch-data.md#local-query-compatibility-matrix). The read answers from local SQLite, and the write joins the [outbox](../resources/glossary.md#outbox) until the client pushes it.

The insert leaves out `id`, which `insert` mints, and `user_id`, which the engine fills with the signed-in user's id because the table uses `byOwner`. Pass `created_at` yourself: a row that omits it has no value locally until the server answers, so it sorts to the wrong end of this list. `error` carries a read that failed, including a local database the worker could not open. You should now see a new todo at the top of the list as soon as you press **Add a todo**.

## What runs on its own

The app needs no sync call of its own for the data to move. Each of these events starts a sync run, which pushes the outbox and then pulls:

- The app uses the client for the first time, as the first `useQuery` read does. The client opens the local database and syncs right away.
- A local write adds to the outbox, as the insert in step 6 does.
- The poll fires at a random point between half the poll interval and the whole interval. `pollIntervalMs` defaults to `15000`, and `0` turns the poll off.
- The browser reports that the network is back.
- The tab becomes visible, resumes after the browser froze it, or comes back from the back/forward cache.
- The Realtime doorbell reports that a synced table changed on the server.
- This tab takes over the engine after the tab that ran it closed.

Tabs that open the same database share one engine. Only the tab running it drives the loop, and the other tabs send their reads and writes to that tab. A run that fails is retried by the next of these events, and consecutive failures stretch the poll delay up to 30 seconds with the default interval.

`createSupabaseKizunaSync` installs the web foreground source for you: a return to a visible tab, the `resume` of a frozen tab, and a page restored from the back/forward cache each refresh the session, reconnect Realtime when the client holds channels but the socket is down, and then wake the scheduler. The reconnect matters because a backgrounded tab can lose its socket silently, which Supabase describes in [handling silent disconnections](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794).

Call [`sync()`](../reference/javascript/sync.md) yourself only for a **Sync now** button, a pull-to-refresh gesture, or a test that needs the outbox delivered before it checks the server. [React](react.md#7-show-sync-state) adds that button with `useSyncStatus`.

## Verify it worked

Start the dev server against the provisioned project, sign in if your app has a sign-in screen, and add a todo. It renders from local SQLite at once, and within a few seconds, with no call to `sync()`, the row appears in the Table Editor of Supabase Studio.

## Common errors

- A second client on one database appears when more than one module calls `createSupabaseKizunaSync` for the same database name. It joins the first as a follower and runs a second scheduler over the one engine. Create the client once, in `src/kizunasync.ts`. See [Local web database will not open](../operations/troubleshooting.md#local-web-database-will-not-open).
- An error message under the button means the worker could not open the local database, and the message is the reason. The app client keeps that error for the life of the page and does not try to open again.
- No persistent store means the worker reports that neither the OPFS pool nor the IndexedDB fallback could be installed, which is what a browser without `navigator.storage.getDirectory` and without `IndexedDB` looks like.
- Writes stay pending and `health.lastError.code` is `AUTH_SESSION_MISSING` when no user has signed in. Sign in with supabase-js or pass `anonymousSignIn: true`, as step 5 describes.
- `BUCKET_UNSET` on a pull means a table declared with `byColumn` has no value yet, because [`setBucket`](../reference/javascript/set-bucket.md) never filled it. See [`BUCKET_UNSET`](../operations/troubleshooting.md#bucket_unset).

## Next steps

- [React](react.md) or [Vue](vue.md): the UI bindings over this client, including a sync indicator.
- [Vanilla JavaScript](vanilla-js.md): the same client without a framework.
- [Sync rules and buckets](../sync/sync-rules-and-buckets.md): which rows reach the device.
- [Media and attachments](../attachments/media-and-attachments.md): files through the same engine.
