<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/vue</span>
</h1>

Vue 3 composables for the Kizuna app client. Wire one `IKizunaSync`, provide it once, and descendants read the local store reactively.

## Install

This workspace is private. Apps install the `kizunasync` package and import it as `kizunasync/vue`.

```bash
npm install kizunasync @supabase/supabase-js
```

Vue 3.5 or later is an optional peer dependency.

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

Install the plugin in `src/main.ts`:

```ts
// src/main.ts
import { createApp } from 'vue'
import { createKizunaSyncPlugin } from 'kizunasync/vue'
import App from './App.vue'
import { kizunasync } from './kizunasync'

createApp(App).use(createKizunaSyncPlugin(kizunasync)).mount('#app')
```

```vue
<!-- src/components/TodoList.vue -->
<script setup lang="ts">
import { useQuery, useMutation, useSyncStatus } from 'kizunasync/vue'

const { data: todos, isLoading, error } = useQuery(
  (k) => k.from('todos').select().order('created_at'),
)
const { mutate, isPending } = useMutation()
const { outboxDepth, isSyncing, syncNow } = useSyncStatus()

async function addTodo(title: string) {
  await mutate((k) => k.from('todos').insert({ title, done: false }))
}
</script>
```

`data` and the status fields are Vue `Ref`s. They update when the engine emits an event. The network is never on the read path.

Full bootstrap: [Vue guide](../../docs/getting-started/vue.md). Working app: [`examples/todo-vue`](../../examples/todo-vue).

## Composables

| Composable | Returns | Purpose |
|---|---|---|
| `provideKizunaSync(client)` | `void` | Seed the client from a component `setup()` |
| `createKizunaSyncPlugin(client)` | Vue plugin | App-level form: `app.use(createKizunaSyncPlugin(client))` |
| `useKizunaSync(opts?)` | `IKizunaSync` | Active client; `opts.client` wins, else `inject`. Throws if neither is present |
| `kizunasyncInjectionKey` | `InjectionKey<IKizunaSync>` | Injection key for manual `provide` / `inject` |
| `useQuery(build, opts?)` | `{ data, error, isLoading }` | Reactive local read. Re-runs, coalesced per microtask, on every event that can change a row (a committed write or pull, or a reset/rehydration signal) and on `opts.deps` |
| `useMutation(opts?)` | `{ mutate, isPending, error }` | `mutate(fn)` runs `fn(kizunasync)` and tracks pending / error |
| `useSyncStatus(opts?)` | `{ outboxDepth, isSyncing, lastError, checkpoint, isOnline, syncNow, health, isStalled, nextRetryAt, needsReset, softBlockReason }` | Reactive sync state. `isOnline` follows the app client's `connectivity`, or `opts.connectivity` when you pass one. `needsReset` is `checkpoint.softBlocked` and `softBlockReason` is `health.softBlockReason` |
| `useAttachment(ref, opts?)` | `{ state, progress, localUri, error, permanent, attempts, retry, cancel, remove, prefetch }` | Per-ref attachment status for a `MaybeRefOrGetter`. On an app client built without attachment ports, `error` carries `ATTACHMENT_PORTS_MISSING` once a ref is set |
| `useRejections(opts?)` | `{ rejections, error, isLoading, dismiss }` | Reactive rejection journal |
| `useOverwrites(opts?)` | `{ overwrites, error, isLoading, dismiss }` | Reactive overwrite journal (column-LWW) |

Every composable accepts an optional `{ client }` override. The override always wins. Here `previewClient` is a second app client, exported by `src/preview-client.ts` and built like `kizunasync` over a database of its own, and only this component reads from it:

```vue
<!-- src/components/PreviewList.vue -->
<script setup lang="ts">
import { useQuery } from 'kizunasync/vue'
import { previewClient } from '../preview-client'

const { data: todos } = useQuery((kizunasync) => kizunasync.from('todos').select(), { client: previewClient })
</script>

<template>
  <ul>
    <li v-for="todo in todos" :key="String(todo.id)">{{ todo.title }}</li>
  </ul>
</template>
```

## Related

- [Vue reference](../../docs/reference/vue/introduction.md)
- [Vue guide](../../docs/getting-started/vue.md)
- [Attachments](../../docs/attachments/media-and-attachments.md)
- [`@kizunasync/core`](../core/README.md)
