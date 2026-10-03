---
title: useMutation
description: Run a local write against the client and track its pending state and failure.
status: alpha
docType: reference
library: react
pageKind: method
audience: app-developer
---

# React: useMutation

`useMutation` runs a write function against the resolved client, tracks whether it is in flight, and captures a failure instead of throwing it into render. It owns the write lifecycle only: the rows it changes reach the screen through [useQuery](./use-query.md), which re-reads on the same engine event.

## Examples

### Basic

```tsx
// src/components/add-todo.tsx
import { useMutation } from 'kizunasync/react'

export function AddTodo() {
  const { mutate, isPending, error } = useMutation()

  return (
    <>
      <button
        type="button"
        disabled={isPending}
        onClick={() => void mutate((kizunasync) => kizunasync.from('todos').insert({ title: 'works on a plane', done: false }))}
      >
        Add a todo
      </button>
      {error !== null && <p role="alert">{error.message}</p>}
    </>
  )
}
```

The insert leaves `user_id` out. The table's bucket is `byOwner('user_id')`, so the engine fills that column with the id of the user signed in on this device.

### Update and delete

```tsx
// src/components/todo-row.tsx
import { useMutation } from 'kizunasync/react'

export function TodoRow({ todoId, title }: { todoId: string; title: string }) {
  const { mutate } = useMutation()

  return (
    <li>
      {title}
      <button type="button" onClick={() => void mutate((kizunasync) => kizunasync.from('todos').update({ done: true }).eq('id', todoId))}>
        Done
      </button>
      <button type="button" onClick={() => void mutate((kizunasync) => kizunasync.from('todos').delete().eq('id', todoId))}>
        Delete
      </button>
    </li>
  )
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `opts` | `IClientOption` | No | Client override. Default: the context client. |
| `opts.client` | `IKizunaSync` | No | Used instead of the [`KizunaSyncProvider`](./initializing.md) client. Default: the context client. |

## Returns

`IMutationResult`.

| Name | Type | Required | Description |
|---|---|---|---|
| `mutate` | `(fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>` | — | Runs `fn` with the resolved client and awaits its result. Stable across renders for one client. |
| `isPending` | `boolean` | — | `true` from the call until `fn` settles, including the failing path. |
| `error` | `Error \| null` | — | The failure the last call captured, wrapped in an `Error` when it was not one. Cleared at the start of the next call. |

## Errors

`mutate` never rejects. It clears `error`, awaits `fn`, and puts any throw or rejection in `error`, so the returned promise resolves either way and a component reads the outcome from state rather than from a `catch`.

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `from(table)` names a table absent from [`defineConfig`](../javascript/define-config.md). |
| `LOCAL_CONSTRAINT` | An insert whose [row key](../../sync/sync-rules-and-buckets.md#row-keys) columns are missing, `null`, or neither a string nor an integer, or that names a key that already exists locally; an update that names a key column in its values or its transforms, since the key is immutable, the transform refused from the builder with the message `update() cannot transform "<column>": the primary key is immutable`; or a transform argument that is not a signed integer. |
| `LOCAL_UNSUPPORTED` | An update or delete carries no filter, or only a filter that names no rows such as an empty `match({})`, refused when the write executes. The write chain refuses `range()`, `csv()`, and `abortSignal()`, and `returns()`, `overrideTypes()`, and `stripNulls()` until `select()` follows, besides the methods [Supported query operators](../query-operators.md) marks unsupported. Raised naming the table when the table's `sync` is `'pull-only'`. The chain also refuses `upsert()`, `rpc()`, and a malformed `or()`, `and()`, `not()`, or `filter()` clause. |
| `ENGINE_UNAVAILABLE` | The app client could not open its engine on its first use, for example in Expo Go, which carries no build of the engine. The client keeps that error, so every later write reports it too. [Rust engine](../expo/rust-engine.md#when-neither-condition-holds) lists the causes. |

## Notes

A write commits to local [SQLite](https://grokipedia.com/page/SQLite) and enters the [outbox](../../resources/glossary.md#outbox) in one transaction, so `mutate` resolving means the row is durable on this device, not that the server has accepted it. The server's verdict arrives with a later sync, and a rejected write is reverted and journalled: [Offline writes](../../sync/offline-writes.md#1-write-locally) walks that path, and [useRejections](./use-rejections.md) reads the journal.

The call shape follows Supabase's [`insert`](https://supabase.com/docs/reference/javascript/insert), [`update`](https://supabase.com/docs/reference/javascript/update), and [`delete`](https://supabase.com/docs/reference/javascript/delete). What differs is the timing: the local row changes at once, [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#write-a-policy-for-each-operation) is enforced when the queued write reaches the server, and the wait is a sync run rather than a request.

Leaving `id` out of an insert is deliberate. The builder mints the primary key, which avoids depending on `crypto.randomUUID` being present in the runtime.

A `delete()` against a table that declares [`softDelete`](../javascript/define-config.md#parameters) stamps that column with an update instead of writing a tombstone, so the row stays local and reappears with [`.includeDeleted()`](../javascript/using-filters.md#parameters).

## Related reference

- [useQuery](./use-query.md)
- [useRejections](./use-rejections.md)
- [JavaScript: Insert data](../javascript/insert-data.md)
- [JavaScript: Update data](../javascript/update-data.md)
- [JavaScript: Delete data](../javascript/delete-data.md)
- [Vue: useMutation](../vue/use-mutation.md)
