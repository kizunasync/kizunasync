---
title: useQuery
description: Read the local database through a select builder and re-read on the engine events that can change a row.
status: alpha
docType: reference
library: react
pageKind: method
audience: app-developer
---

# React: useQuery

`useQuery` runs a local select on mount and again on every engine event that can change a row: a committed local write, a committed pull, or either [lifecycle signal](../../sync/protocol-overview.md#lifecycle-signals) (`CHECKPOINT_EXPIRED`, `RESET_REQUIRED`). Committed writes and pulled rows reach the component without a refetch call. The read answers from [local SQLite](https://grokipedia.com/page/SQLite) and reaches no network.

## Examples

### Basic

```tsx
// src/components/todo-list.tsx
import { useQuery } from '@kizunasync/react'

export function TodoList() {
  const { data, error, isLoading } = useQuery((kizunasync) => kizunasync.from('todos').select('id, title'))

  if (isLoading) {
    return <p>Loading…</p>
  }
  if (error !== null) {
    return <p role="alert">{error.message}</p>
  }

  return (
    <ul>
      {data.map((todo) => (
        <li key={String(todo.id)}>{String(todo.title)}</li>
      ))}
    </ul>
  )
}
```

### Order the rows

```tsx
// src/components/recent-todos.tsx
import { useQuery } from '@kizunasync/react'

export function RecentTodos() {
  const { data } = useQuery((kizunasync) =>
    kizunasync.from('todos').select().order('created_at', { ascending: false }).limit(50),
  )

  return <p>{data.length} recent todos</p>
}
```

### Re-read when a filter changes

The `done` prop is an input the engine cannot see, so it goes in `deps`.

```tsx
// src/components/filtered-todos.tsx
import { useQuery } from '@kizunasync/react'

export function FilteredTodos({ done }: { done: boolean }) {
  const { data } = useQuery(
    (kizunasync) => kizunasync.from('todos').select('id, title').eq('done', done),
    { deps: [done] },
  )

  return (
    <ul>
      {data.map((todo) => (
        <li key={String(todo.id)}>{String(todo.title)}</li>
      ))}
    </ul>
  )
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `build` | `(kizunasync: IKizunaSync) => ILocalSelectBuilder` | Yes | Called with the resolved client on every read. Returns the builder chain to await, not its result. [Fetch data](../javascript/fetch-data.md) documents the chain, and [Using filters](../javascript/using-filters.md) documents the operators the local subset supports. |
| `opts` | `IQueryOption` | No | Client override plus the dependency list. Default: the context client and no extra dependencies. |
| `opts.client` | `IKizunaSync` | No | Used instead of the [`KizunaSyncProvider`](./initializing.md) client. Default: the context client. |
| `opts.deps` | `readonly unknown[]` | No | External inputs the `build` closure captures, such as a filter value or a route parameter. Data-driven updates already arrive as engine events, so this list is only for inputs the engine cannot see. Keep its length stable across renders. Default: `[]`. |

## Returns

`IQueryResult<T>`, where `T` defaults to `TColumnValues`.

| Name | Type | Required | Description |
|---|---|---|---|
| `data` | `T[]` | — | The rows the last resolved read returned, cast to `T`. `[]` before the first read resolves; the rows from the last successful read when a later one fails. |
| `error` | `Error \| null` | — | The failure the builder threw or rejected with, wrapped in an `Error` when it was not one. Cleared by the next successful read. |
| `isLoading` | `boolean` | — | `true` until the first read resolves or fails, then `false` for the life of the subscription. Later reads do not set it again. |

## Errors

Nothing is thrown from render. A failure the builder raises lands in `error` with `data` unchanged, and the subscription stays live so the next row-changing engine event retries the read.

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `from(table)` names a table absent from [`defineConfig`](../javascript/define-config.md). The message lists the configured tables. |
| `LOCAL_UNSUPPORTED` | The chain uses `range`, `overlaps`, `match`, `filter`, or `csv`, or a `select()` projection with a relational embed or a rename. The message names the construct and points at the [local query compatibility matrix](../javascript/fetch-data.md#local-query-compatibility-matrix). The chain also refuses `upsert()`, `rpc()`, a malformed `or()`, `and()`, or `not()` clause, and a non-string `id` in `eq`. |
| `LOCAL_CONSTRAINT` | `single()` resolved zero rows or more than one, or `maybeSingle()` resolved more than one. The message carries the count it got. |
| `ENGINE_UNAVAILABLE` | The app client could not open its engine on its first use, for example in Expo Go, which carries no build of the engine. The client keeps that error, so every later read reports it too. [Rust engine](../expo/rust-engine.md#when-neither-condition-holds) lists the causes. |

Errors are values on this hook rather than exceptions, so an empty state renders from `data` and a message from `error` in the same component.

## Notes

Write the builder inline.

An inline closure has a fresh identity on every render. The hook reads it through a ref rather than a dependency, so it never spins a render loop. The subscription itself keys off the client and your `deps` list.

Reads are asynchronous, because the driver may run off the main thread. A monotonic counter discards a slow read whose result arrived after a newer one. Unmounting invalidates any read in flight, so a resolved promise cannot set state afterwards.

The call shape follows Supabase's [`select`](https://supabase.com/docs/reference/javascript/select) and its [filters](https://supabase.com/docs/reference/javascript/using-filters) and [modifiers](https://supabase.com/docs/reference/javascript/using-modifiers), within the local subset. Three things differ. The rows come from the local database rather than [PostgREST](https://postgrest.org/). An unsupported operator throws instead of falling back to the network. Rows a peer wrote appear when a pull commits them, rather than at request time.

## Related reference

- [useMutation](./use-mutation.md)
- [useKizunaSync](./use-kizunasync.md)
- [JavaScript: Fetch data](../javascript/fetch-data.md)
- [JavaScript: Using filters](../javascript/using-filters.md)
- [Vue: useQuery](../vue/use-query.md)
