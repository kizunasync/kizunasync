---
title: useQuery
description: Read the local database through a select builder and re-read on the engine events that can change a row.
status: alpha
docType: reference
library: vue
pageKind: method
audience: app-developer
---

# Vue: useQuery

`useQuery` runs a local select when the composable is created and again on every engine event that can change a row: a committed local write, a committed pull, or either [lifecycle signal](../../sync/protocol-overview.md#lifecycle-signals) (`CHECKPOINT_EXPIRED`, `RESET_REQUIRED`). Committed writes and pulled rows reach the template without a refetch call. The read answers from [local SQLite](https://grokipedia.com/page/SQLite) and reaches no network.

## Examples

### Basic

```vue
<!-- src/components/TodoList.vue -->
<script setup lang="ts">
import { useQuery } from 'kizunasync/vue'

const { data, error, isLoading } = useQuery((kizunasync) => kizunasync.from('todos').select('id, title'))
</script>

<template>
  <p v-if="isLoading">Loading…</p>
  <p v-else-if="error !== null" role="alert">{{ error.message }}</p>
  <ul v-else>
    <li v-for="todo in data" :key="String(todo.id)">{{ todo.title }}</li>
  </ul>
</template>
```

### Order the rows

```ts
// src/components/RecentTodos.vue (script setup)
import { useQuery } from 'kizunasync/vue'

const { data } = useQuery((kizunasync) =>
  kizunasync.from('todos').select().order('created_at', { ascending: false }).limit(50),
)
```

### Re-read when a filter changes

`showDone` is an input the engine cannot see, so it goes in `deps`.

```ts
// src/components/FilteredTodos.vue (script setup)
import { ref } from 'vue'
import { useQuery } from 'kizunasync/vue'

const showDone = ref(false)

const { data } = useQuery(
  (kizunasync) => kizunasync.from('todos').select('id, title').eq('done', showDone.value),
  { deps: [showDone] },
)
```

### Read one row

End the chain with `.single()` and `data` holds that row as an object instead of an array. The `todoId` prop is an input the engine cannot see, so a getter over it goes in `deps`.

```vue
<!-- src/components/TodoDetail.vue -->
<script setup lang="ts">
import { useQuery } from 'kizunasync/vue'

const props = defineProps<{ todoId: string }>()

const { data: todo, error } = useQuery(
  (kizunasync) => kizunasync.from('todos').select('id, title, done').eq('id', props.todoId).single(),
  { deps: [() => props.todoId] },
)
</script>

<template>
  <p v-if="error !== null" role="alert">{{ error.message }}</p>
  <p v-else-if="todo === null">Loading…</p>
  <h2 v-else>{{ todo.title }}</h2>
</template>
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `build` | `(kizunasync: IKizunaSync) => ILocalSelectBuilder \| ISelectSingleQuery \| ISelectMaybeSingleQuery` | Yes | Called with the resolved client on every read. Returns the builder chain to await, not its result. A chain that ends in `.single()` or `.maybeSingle()` makes `data` one row instead of an array. [Fetch data](../javascript/fetch-data.md) documents the chain, and [Using filters](../javascript/using-filters.md) documents the operators the local subset supports. |
| `opts` | `IUseQueryOptions` | No | Client override and dependency list. Default: the provided client, no extra dependency. |
| `opts.client` | `IKizunaSync` | No | Used instead of the client seeded by [`createKizunaSyncPlugin` or `provideKizunaSync`](./initializing.md), resolved through [useKizunaSync](./use-kizunasync.md). Default: the provided client. |
| `opts.deps` | `WatchSource<unknown>[]` | No | Watch sources that re-read when any of them changes: a ref, a computed, or a getter the `build` closure reads. Engine events already cover the data, so this covers the inputs the engine cannot see, such as a filter bound to a control or a route param. Default: no extra trigger. |

## Returns

`IUseQueryResult<T>` for a list, or `IUseQuerySingleResult<T>` when the chain ends in `.single()` or `.maybeSingle()`, where `T` defaults to `TColumnValues`. The two differ only in `data`. Every field is a ref, so read it as `data.value` in script and as `data` in a template.

| Name | Type | Required | Description |
|---|---|---|---|
| `data` | `Ref<T[]>` or `Ref<T \| null>` | — | For a list, the rows the last resolved read returned, cast to `T`, and `[]` before the first read resolves. For one row, that row cast to `T`, and `null` before the first read resolves or when `maybeSingle()` matches no row. When a later read fails, `data` keeps what the last successful read returned. |
| `error` | `Ref<Error \| null>` | — | The failure the builder threw or rejected with, wrapped in an `Error` when it was not one. Cleared by the next successful read. |
| `isLoading` | `Ref<boolean>` | — | `true` until the first read resolves or fails, then `false` for the life of the subscription. Later reads do not set it again. |

## Errors

Nothing is thrown from `setup()` past the client resolution. A failure the builder raises lands in `error` with `data` unchanged, and the subscription stays live so the next row-changing engine event retries the read.

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `from(table)` names a table absent from [`defineConfig`](../javascript/define-config.md). The message lists the configured tables. |
| `LOCAL_UNSUPPORTED` | The chain uses a method with no local meaning, such as `rangeGt()` or `geojson()`, or a `select()` projection with a relational embed or a rename. The message names the construct and the reason, and [Supported query operators](../query-operators.md) lists every refused method. The chain also refuses `upsert()`, `rpc()`, a malformed `or()`, `and()`, `not()`, or `filter()` clause, and a `regexMatch()` pattern the local regex engine cannot compile. |
| `LOCAL_CONSTRAINT` | `single()` resolved zero rows or more than one, or `maybeSingle()` resolved more than one. The message carries the count it got. |
| `ENGINE_UNAVAILABLE` | The app client could not open its engine on its first use, for example in Expo Go, which carries no build of the engine. The client keeps that error, so every later read reports it too. [Rust engine](../expo/rust-engine.md#when-neither-condition-holds) lists the causes. |

Errors are refs on this composable rather than exceptions, so an empty state renders from `data` and a message from `error` in the same template.

## Notes

The builder closure runs again on every row-changing engine event, so an input it reads from a ref lands at the next such event rather than at the moment it changes.

Name that ref in `opts.deps` to read again the moment it changes instead.

The [Vue](https://vuejs.org) form takes watch sources, so a ref stays a ref rather than a snapshot of its value. The React binding takes the same list as plain values in a dependency array, which [React: useQuery](../react/use-query.md) documents.

Both triggers share the one sequence counter, so a dep change during a slow read discards that read rather than letting it land after the newer one. The dep watcher stops with the owning scope, alongside the engine subscription.

Reads are asynchronous, because the driver may run off the main thread. A monotonic counter discards a slow read whose result arrived after a newer one. `onScopeDispose` unsubscribes with the owning component and invalidates any read in flight, so a resolved promise cannot write to the refs afterwards.

When the composable is created it also calls `build` once to learn whether the chain returns a list or one row, which sets the first `data` to `[]` or `null`. Building the chain runs no query, because a select reads the database only when it is awaited. A `build` that throws at that point counts as a list, and the first read reports the error.

The call shape follows Supabase's [`select`](https://supabase.com/docs/reference/javascript/select) and its [filters](https://supabase.com/docs/reference/javascript/using-filters) and [modifiers](https://supabase.com/docs/reference/javascript/using-modifiers), within the local subset. Three things differ. The rows come from the local database rather than [PostgREST](https://postgrest.org/). An unsupported operator throws instead of falling back to the network. Rows a peer wrote appear when a pull commits them, rather than at request time.

## Related reference

- [useMutation](./use-mutation.md)
- [useKizunaSync](./use-kizunasync.md)
- [JavaScript: Fetch data](../javascript/fetch-data.md)
- [JavaScript: Using filters](../javascript/using-filters.md)
- [React: useQuery](../react/use-query.md)
