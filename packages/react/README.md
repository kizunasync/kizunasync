<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/react</span>
</h1>

React bindings for the Kizuna app client. A context `Provider` and hooks over an `IKizunaSync` from `kizunasync`.

## Install

This workspace is private. Apps install the `kizunasync` package and import it as `kizunasync/react`.

```bash
npm install kizunasync @supabase/supabase-js
```

`react >= 19` is an optional peer dependency. You also need a [driver](../../docs/resources/glossary.md#driver) (`kizunasync/web` in the browser, `kizunasync/expo` on React Native) and a remote (`createRpcRemote` or `createSupabaseKizunaSync` from `kizunasync/supabase`). Build the client with `createKizunaSync` / `createSupabaseKizunaSync`, then pass it to the Provider.

## Get started

Create the app client once, at module scope, in `src/kizunasync.ts`:

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

Creating the client opens no database and starts no timer. The first query or write opens the local database and runs the first sync.

Wrap the app in the Provider in `src/main.tsx`:

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

Read and write with the hooks:

```tsx
// src/components/todo-list.tsx
import { useMutation, useQuery } from 'kizunasync/react'

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

Full wiring: [React guide](../../docs/getting-started/react.md). Working app: [`examples/todo-react`](../../examples/todo-react).

## Hooks

| Export | Returns | Purpose |
|---|---|---|
| `KizunaSyncProvider` | — | Holds one `IKizunaSync` in context |
| `useKizunaSync(opts?)` | `IKizunaSync` | `opts.client` if passed, else context. Throws when neither is present |
| `useQuery(build, opts?)` | `{ data, error, isLoading }` | Runs `build(kizunasync)` on mount and on every event that can change a row (a committed write or pull, or a reset/rehydration signal), coalesced per microtask. `opts.deps` re-runs when external inputs change |
| `useMutation(opts?)` | `{ mutate, isPending, error }` | `mutate(fn)` runs `fn(client)` and tracks the write lifecycle |
| `useSyncStatus(opts?)` | `{ outboxDepth, isSyncing, lastError, checkpoint, isOnline, syncNow, health, isStalled, nextRetryAt, needsReset, softBlockReason }` | Outbox and checkpoint, refreshed on engine events. `isOnline` follows the app client's `connectivity`, or `opts.connectivity` when you pass one. `needsReset` is `checkpoint.softBlocked` and `softBlockReason` is `health.softBlockReason` |
| `useAttachment(ref, opts?)` | `{ state, progress, localUri, error, permanent, attempts, retry, cancel, remove, prefetch }` | One attachment ref. On an app client built without attachment ports, `error` carries `ATTACHMENT_PORTS_MISSING` once a ref is set |
| `useRejections(opts?)` | `{ rejections, error, isLoading, dismiss }` | Durable rejection journal |
| `useOverwrites(opts?)` | `{ overwrites, error, isLoading, dismiss }` | Durable overwrite journal (columns a peer won under column-LWW) |

Every hook accepts an optional `{ client }` override. It wins over context, so a Provider is optional when you pass the client explicitly.

## Related

- [React guide](../../docs/getting-started/react.md)
- [React reference](../../docs/reference/react/introduction.md)
- [`@kizunasync/core`](../core/README.md)
