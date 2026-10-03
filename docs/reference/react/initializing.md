---
title: Initializing
description: Build the client once at module scope, then put it in React context with KizunaSyncProvider.
status: alpha
docType: reference
library: react
pageKind: initializing
audience: app-developer
---

# React: Initializing

`KizunaSyncProvider` places one [`IKizunaSync`](../javascript/types.md) client in React context, so every hook rendered under it resolves the same instance and the same local database. The client itself is built outside the component tree, at module scope, with [`createSupabaseKizunaSync`](../javascript/initializing.md), after `kizunasync init` has provisioned the [Supabase](https://supabase.com) project.

The app builds the client once in `src/kizunasync.ts`, and the root file `src/main.tsx` wraps the app in the provider. [React](../../getting-started/react.md) walks through both files and the screens that read and write, from install to the first synced row.

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

The config repeats the table options `kizunasync init` provisioned. The driver brings the browser's network signal, and the app client follows `supabase.auth` for the session, so nothing else is passed. Building the client opens no engine and no database: the engine opens on the client's first use, which is usually the first hook that reads, and the first sync starts right then.

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

### Mount the provider

```tsx
// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { KizunaSyncProvider } from 'kizunasync/react'
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

### Show loading and errors where the data renders

The root renders no loading screen of its own. A component reads the loading and error states from the hook that needs the data.

```tsx
// src/components/todo-list.tsx
import { useQuery } from 'kizunasync/react'

export function TodoList() {
  const { data: todos, error, isLoading } = useQuery((kizunasync) =>
    kizunasync.from('todos').select().order('created_at', { ascending: false }),
  )

  if (isLoading) {
    return <p>Loading…</p>
  }
  if (error !== null) {
    return <p role="alert">{error.message}</p>
  }

  return (
    <ul>
      {todos.map((todo) => (
        <li key={String(todo.id)}>{String(todo.title)}</li>
      ))}
    </ul>
  )
}
```

## Parameters

`KizunaSyncProvider` takes two props, typed `IKizunaSyncProviderProps`.

| Name | Type | Required | Description |
|---|---|---|---|
| `client` | `IKizunaSync` | Yes | The instance every hook under this provider resolves when it is given no `{ client }` override. Build it with [`createSupabaseKizunaSync`](../javascript/initializing.md), which lists every client option. |
| `children` | `ReactNode` | Yes | The subtree that may call [useKizunaSync](./use-kizunasync.md), [useQuery](./use-query.md), [useMutation](./use-mutation.md), [useSyncStatus](./use-sync-status.md), [useAttachment](./use-attachment.md), [useRejections](./use-rejections.md), and [useOverwrites](./use-overwrites.md). |

## Returns

`ReactNode`. The provider renders `children` inside a React context provider and contributes no element of its own.

## Errors

`KizunaSyncProvider` throws nothing. A hook that renders outside it, with no `{ client }` override, throws `Error` with this message.

```text
useKizunaSync: no Kizuna client found. Pass an explicit { client }, or provide one from an ancestor: <KizunaSyncProvider client={kizunasync}> in React, provideKizunaSync(kizunasync) in Vue.
```

Every hook resolves its client through [useKizunaSync](./use-kizunasync.md), so the failure surfaces at the first hook call rather than at the provider.

An engine that cannot open, with `ENGINE_UNAVAILABLE` or `STORE_BUSY`, throws nothing at import or at render either. The app client keeps that typed error and every engine call rejects with it, so [useQuery](./use-query.md) reports it in `error` and [useSyncStatus](./use-sync-status.md) in `lastError` and `health.lastError`.

## Notes

The client is a module-scope constant, so StrictMode's second effect run and every remount reuse the same instance over the same database file. Building it opens no worker and no connection, which keeps `src/kizunasync.ts` safe to import during a static render.

The app client follows `supabase.auth`. An app with its own sign-in signs the user in with supabase-js, for example with [`signInWithPassword`](https://supabase.com/docs/reference/javascript/auth-signinwithpassword), and the next sync carries that session. A `byOwner` bucket needs no [`setBucket`](../javascript/set-bucket.md) call: the engine fills it with the signed-in user, also offline after a restart. A different user signing in on the same device soft-blocks sync with `identity_changed` until [`reset()`](../javascript/reset.md) runs, so an account switch is a `reset()`.

Nesting a second provider is supported: a hook resolves the nearest one above it. The per-hook `{ client }` override wins over both, which is what lets a subtree read a different client during a gradual migration.

The client's lifetime belongs to your app, not to the component tree. Mounting and unmounting the provider does not open or close the database, and `dispose()` on the client releases the engine's own subscriptions when your app tears down for good.

On a native host `src/kizunasync.ts` swaps the driver and keeps the rest: [Expo: Initializing](../expo/initializing.md) shows `openExpoDriver`, which also carries the network and foreground signals [React Native](https://reactnative.dev) needs.

## Next steps

1. Read: [useQuery](./use-query.md) renders local rows and renders again when they change.
2. Write: [useMutation](./use-mutation.md) runs an insert, update, or delete against the local database.
3. Show sync state: [useSyncStatus](./use-sync-status.md) reports the outbox depth, the connection, and a `syncNow` trigger.
4. Reach the rest of the client: [useKizunaSync](./use-kizunasync.md) returns the instance the provider holds.

Nothing else has to run for the data to move. The client syncs on its own when it is first used, after every local write, on a jittered poll, when the network or the tab comes back, and on a Realtime doorbell signal, so `syncNow` is for a **Sync now** button, a pull-to-refresh gesture, or a test.

## Related reference

- [Installing](./installing.md)
- [useKizunaSync](./use-kizunasync.md)
- [JavaScript: Initializing](../javascript/initializing.md)
- [Vue: Initializing](../vue/initializing.md)
- [Expo: Initializing](../expo/initializing.md)
