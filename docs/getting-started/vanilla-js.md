---
title: Vanilla JavaScript
description: Wire @kizunasync/web into vanilla JavaScript or any non-React/Vue UI.
status: alpha
docType: how-to
audience: app-developer
---

# Vanilla JavaScript

Run Kizuna in any JavaScript UI with no framework binding, so reads and writes stay local and the interface keeps working offline. Use `@kizunasync/web` in vanilla DOM, Svelte, Solid, Angular, or any host that is not [React](https://react.dev) or [Vue](https://vuejs.org). Provision with [`kizunasync`](../cli/cli.md) first, then create the app client once in `src/kizunasync.ts`, import it where a view needs it, and subscribe to engine events for re-renders.

There is no `@kizunasync/svelte` package, and every other JavaScript UI drives the core client the way this page shows.

## Before you begin

- A Supabase project provisioned with `kizunasync` in your app repository. Follow the [Quick start](./quickstart.md) and [Install](../cli/install.md) if you have not run [`kizunasync init`](../cli/cli.md#kizunasync-init).
- A bundler such as Vite ([Vite guide](https://vite.dev/guide/)) that resolves `@kizunasync/web` worker and [wasm](https://grokipedia.com/page/WebAssembly) imports. The file paths below follow Vite's vanilla TypeScript template.
- A way for users to sign in to Supabase: your own sign-in screen, or [anonymous sign-ins](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) enabled on the project. Step 5 covers both, and your [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#insert-policies) policies judge every pushed row under that user.
- Skim the [JavaScript reference introduction](../reference/javascript/introduction.md) for core client scope.

## 1. Install

Install `@kizunasync/core`, `@kizunasync/supabase`, and `@kizunasync/web` from npm as shown in [JavaScript: Installing](../reference/javascript/installing.md). `@kizunasync/supabase` declares `@supabase/supabase-js` as a peer, so add that package too if the app does not use it yet. You should now resolve [`createSupabaseKizunaSync`](../reference/javascript/initializing.md) from `@kizunasync/supabase`.

No bundler configuration is needed for the driver. `@kizunasync/web` starts its worker with `new URL('./worker.ts', import.meta.url)`, and that worker loads its WebAssembly the same way, so Vite emits both as real chunks without help.

The engine runs inside the worker. The worker compiles the Rust core to WebAssembly and opens the database through the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool. Where the browser cannot support that pool, the worker opens a relaxed [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) store instead. A pool another tab is holding is a different case. The worker retries it for about 1.8 s, then fails with an error naming the database, rather than opening an empty store. Neither backend uses `SharedArrayBuffer`, so the page needs no COOP or COEP headers.

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

Put the two values in `.env.local` at the root of the app. Vite exposes a variable to browser code only when its name starts with `VITE_`, and another bundler reads its own environment convention in place of `import.meta.env`.

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

Creating the client opens no database and starts no timer. The first query or write starts the worker, opens the local database, and runs the first sync right away. [`createWebWorkerDriver`](../reference/javascript/create-web-worker-driver.md) also hands the client the browser's online and offline events, so there is nothing else to pass.

Declare each table with the options `kizunasync init` recorded. [`kizunasync status`](../cli/cli.md#kizunasync-status) prints them per table as `syncMode` and `bucketColumn`: a `read-write` table takes `sync: 'read-write'`, and a bucket column that holds the owner's user id takes `bucket: byOwner('user_id')`. The engine fills a `byOwner` bucket with the signed-in user's id and remembers that user in the local database, so after a restart the bucket and every new insert carry that user before the app reaches the network. A table without a bucket column takes no `bucket` option, and [Define config](../reference/javascript/define-config.md) lists the remaining options.

## 4. Provide it to the app

A vanilla app needs no provider: any module that imports `kizunasync` from `./kizunasync` gets the one client. The entry file only mounts the view you write in step 6.

```ts
// src/main.ts
import { mountTodoList } from './todo-list'

mountTodoList(document.querySelector<HTMLDivElement>('#app')!)
```

## 5. Sign in

The app client follows `supabase.auth` on its own. It pulls and pushes as whichever user supabase-js holds a session for, and it picks up a sign-in, a token refresh, or a sign-out without a call from your code. Get that session in one of two ways:

- An app with its own sign-in screen signs in with supabase-js, for example with [`signInWithPassword`](https://supabase.com/docs/reference/javascript/auth-signinwithpassword#examples). [Supabase Auth](https://supabase.com/docs/guides/auth) covers every sign-in method.
- An app whose first visit has no sign-in screen adds `anonymousSignIn: true` to the `createSupabaseKizunaSync` options in `src/kizunasync.ts`. When a sync finds no session, the client restores the session this browser already had, or signs in a new anonymous user, and a sync that fails offline tries again on the next run. The project needs [anonymous sign-ins](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) enabled.

Switching accounts on the same device takes a [`reset()`](../reference/javascript/reset.md). When a different user signs in, the engine soft-blocks sync with `identity_changed` until `reset()` runs, so writes queued under one user never go out under another. [Sync soft-blocks after switching accounts](../operations/troubleshooting.md#sync-soft-blocks-after-switching-accounts) walks through it.

## 6. Read and write

Render with DOM APIs and render again on `LOCAL_CHANGED`, which the engine raises after an optimistic write and after a pull commits rows. [`on`](../reference/javascript/on.md) returns the unsubscribe function, which `mountTodoList` returns so a view that goes away can stop listening.

```ts
// src/todo-list.ts
import { EEngineEventType } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export function mountTodoList(root: HTMLElement): () => void {
  const list = document.createElement('ul')
  const addButton = document.createElement('button')

  addButton.type = 'button'
  addButton.textContent = 'Add a todo'
  addButton.addEventListener('click', () => {
    void kizunasync.from('todos').insert({ title: 'works on a plane', done: false, created_at: new Date().toISOString() })
  })
  root.replaceChildren(addButton, list)

  async function render(): Promise<void> {
    try {
      const { data: todos } = await kizunasync.from('todos').select().order('created_at', { ascending: false })

      list.replaceChildren(
        ...todos.map((todo) => {
          const item = document.createElement('li')

          item.textContent = String(todo.title)

          return item
        }),
      )
    } catch (error) {
      list.textContent = error instanceof Error ? error.message : String(error)
    }
  }
  void render()

  return kizunasync.on((event) => {
    if (event.type === EEngineEventType.LOCAL_CHANGED) {
      void render()
    }
  })
}
```

Those calls follow Supabase's [`select`](https://supabase.com/docs/reference/javascript/select), [modifiers](https://supabase.com/docs/reference/javascript/using-modifiers), and [`insert`](https://supabase.com/docs/reference/javascript/insert) within the [local query subset](../reference/javascript/fetch-data.md#local-query-compatibility-matrix). The read answers from [local SQLite](https://grokipedia.com/page/SQLite), and the write joins the [outbox](../resources/glossary.md#outbox) until the client pushes it. Each title goes in through `textContent`, so a title is never parsed as HTML, and [Offline writes](../sync/offline-writes.md#4-subscribe-to-engine-events) lists the other events, including the rejection ones a queue indicator needs.

The insert leaves out `id`, which [`insert`](../reference/javascript/insert-data.md) mints, and `user_id`, which the engine fills with the signed-in user's id because the table uses `byOwner`. An insert made before any user has signed in on this browser keeps only the columns you gave it. Pass `created_at` yourself: a row that omits it has no value locally until the server answers, so it sorts to the wrong end of this list. A read that fails, including a local database the worker could not open, puts its message in place of the list. You should now see a new todo at the top of the list as soon as you press **Add a todo**.

## What runs on its own

The app needs no sync call of its own for the data to move. Each of these events starts a sync run, which pushes the outbox and then pulls:

- The app uses the client for the first time, as the first `render()` does. The client opens the local database and syncs right away.
- A local write adds to the outbox, as the click handler in step 6 does.
- The poll fires at a random point between half the poll interval and the whole interval. `pollIntervalMs` defaults to `15000`, and `0` turns the poll off.
- The browser reports that the network is back.
- The tab becomes visible, resumes after the browser froze it, or comes back from the back/forward cache. The client refreshes the session before that run.
- The Realtime doorbell reports that a synced table changed on the server.
- This tab takes over the engine after the tab that ran it closed.

Tabs that open the same database share one engine. Only the tab running it drives the loop, and the other tabs send their reads and writes to that tab. A run that fails is retried by the next of these events, and consecutive failures stretch the poll delay up to 30 seconds with the default interval.

Call [`kizunasync.sync()`](../reference/javascript/sync.md) yourself only for a **Sync now** button, a pull-to-refresh gesture, or a test that needs the outbox delivered before it checks the server. [Sync health](../reference/javascript/sync-health.md) and [Outbox depth](../reference/javascript/outbox-depth.md) feed an indicator of your own.

## Verify it worked

Run the dev server, sign in if your app has a sign-in screen, and add a todo. The list updates without a page reload, and within a few seconds, with no call to `sync()`, the row appears in the Table Editor of Supabase Studio.

## Common errors

- A second client on one database appears when more than one module calls `createSupabaseKizunaSync` for the same database name. Create it once, in `src/kizunasync.ts`. See [Local web database will not open](../operations/troubleshooting.md#local-web-database-will-not-open).
- An error message in place of the list means the worker could not open the local database, and the message is the reason. The app client keeps that error for the life of the page and does not try to open again.
- Writes stay pending and `kizunasync.getSyncHealth().lastError?.code` is `AUTH_SESSION_MISSING` when no user has signed in. Sign in with supabase-js or pass `anonymousSignIn: true`, as step 5 describes.
- No persistent store means the worker reports that neither the OPFS pool nor the IndexedDB fallback could be installed.
- If the list never updates after an insert, confirm the view subscribes to `LOCAL_CHANGED` through the client it writes with.

## Next steps

- [Vite](vite.md): how the browser runs the engine, with React or Vue on top.
- [JavaScript reference](../reference/javascript/introduction.md): every client method.
- [Offline writes](../sync/offline-writes.md): the queue, the verdicts, and the rejection journal.
- [Media and attachments](../attachments/media-and-attachments.md): files through the same engine.
