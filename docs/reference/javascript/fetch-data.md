---
title: Fetch data
description: Select rows from the local SQLite store, with the modifiers, options, and errors of the read builder.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Fetch data

`from(table).select(columns?, options?)` returns a builder that reads local [SQLite](https://grokipedia.com/page/SQLite). Filters, [`.order()`](https://supabase.com/docs/reference/javascript/using-modifiers-order#parameters), [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#parameters), [`.range()`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters), and the other [modifiers](https://supabase.com/docs/reference/javascript/using-modifiers) chain on it, and awaiting the builder runs the read. The call signature matches [`.select()`](https://supabase.com/docs/reference/javascript/select#parameters) in supabase-js, including the `count` and `head` options.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const { data } = await kizunasync
  .from('todos')
  .select('id, title, done')
  .eq('done', false)
  .order('title', { ascending: true })
```

### Single row

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function loadTodo(todoId: string) {
  const { data } = await kizunasync.from('todos').select('*').eq('id', todoId).single()

  return data
}
```

[React: useQuery](../react/use-query.md) and [Vue: useQuery](../vue/use-query.md) take the same chain ending in [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples) or [`.maybeSingle()`](https://supabase.com/docs/reference/javascript/using-modifiers-maybesingle#examples) and hold that row, or `null`, in `data`.

### One page of rows

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const PAGE_SIZE = 20

export async function loadPage(page: number) {
  const from = page * PAGE_SIZE
  const { data } = await kizunasync
    .from('todos')
    .select('id, title, done')
    .order('title')
    .range(from, from + PAGE_SIZE - 1)

  return data
}
```

Both ends of `range(from, to)` are inclusive and count from zero after the sort, so page `1` holds rows 20 through 39.

### Count the matches

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function loadOpenPage() {
  const { data, count } = await kizunasync
    .from('todos')
    .select('id, title', { count: 'exact' })
    .eq('done', false)
    .range(0, 19)

  return { todos: data, openTodos: count }
}
```

`count` is the number of open todos before [`.range()`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters) cut the page. Pass `head: true` as well to get the count with `data` set to `null`.

### Typed rows

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

interface ITodo {
  id: string
  title: string
  done: boolean
}

export async function loadTodos(): Promise<ITodo[]> {
  const { data } = await kizunasync.from('todos').select('id, title, done').returns<ITodo[]>()

  return data
}
```

`returns()` and `overrideTypes()` change only the static type, as in supabase-js; the rows are the same rows.

### CSV text

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function exportTodos(): Promise<string> {
  const { data } = await kizunasync.from('todos').select('id, title, done').order('title').csv()

  return data
}
```

### Stop a read the screen no longer needs

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export function loadTodosUntil(signal: AbortSignal) {
  return kizunasync.from('todos').select('id, title').abortSignal(signal)
}
```

When `signal` aborts before the read settles, the promise rejects with the signal's reason and the rows are discarded.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `columns` | `string` | No | Comma-separated projection. `*`, an empty string, and an omitted argument all return every stored column. A projected column the row does not carry comes back as `null`. Default: every column. |
| `options.count` | `'exact' \| 'planned' \| 'estimated'` | No | Returns, in `count`, how many rows the filters match before [`.range()`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters) and [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#parameters). The kernel counts every match, so all three modes return the exact count. Default: no count, and `count` is `null`. |
| `options.head` | `boolean` | No | Returns the count without the rows: `data` is `null`. Default: `false`. |

The builder carries the filters on [Using filters](./using-filters.md) plus the modifiers below. All of them join the plan the kernel evaluates when the read executes.

| Name | Type | Required | Description |
|---|---|---|---|
| [`.order(column, options?)`](https://supabase.com/docs/reference/javascript/using-modifiers-order#examples) | `(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => ILocalSelectBuilder` | No | Sorts the matched rows. The first call in the chain is the primary sort and later calls break ties. `ascending` defaults to `true`, and `nullsFirst` (the wire key the plan carries) defaults to the negation of `ascending`. |
| [`.limit(count)`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#examples) | `(count: number) => ILocalSelectBuilder` | No | Truncates after sorting. `count` must be an integer; a fractional count throws `LOCAL_UNSUPPORTED` synchronously, and a negative count is refused `LOCAL_UNSUPPORTED` when the read executes. |
| [`.range(from, to)`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters) | `(from: number, to: number) => ILocalSelectBuilder` | No | Keeps the rows at indexes `from` through `to` after sorting, both ends inclusive and counted from zero, the way supabase-js reads them. The plan skips `from` rows and keeps `to - from + 1`, so a `to` one below `from` keeps no row, and a window past the last row matches nothing. A later [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#examples) replaces only the row count, and a later [`.range()`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters) replaces both. `from` and `to` must be integers of zero or more, with `to` at least `from - 1`; anything else throws `LOCAL_UNSUPPORTED` synchronously. |
| `.includeDeleted()` | `() => ILocalSelectBuilder` | No | Keeps the rows a table's `softDelete` column marks. Without it a marked row is excluded before the plan runs, so [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#examples) counts only the rows you can see. No effect on a table with no `softDelete` column. |
| `.stripNulls()` | `() => ILocalSelectBuilder` | No | Returns each row without its null-valued keys. The one-row terminals carry it too. |
| `.abortSignal(signal)` | `(signal: AbortSignal) => ILocalSelectBuilder` | No | Rejects the read with `signal.reason` when the signal aborts before the read settles, and discards its rows. A signal with no reason rejects with an `AbortError` `DOMException`. |
| `.throwOnError()` and `.retry(enabled)` | `() => ILocalSelectBuilder` | No | Return the builder unchanged. A local read already rejects on error, and it makes no network attempt to retry. |
| `.returns<TResult>()` | `() => ILocalSelectBuilder<TResult[number]>` | No | Types the rows. `TResult` is the whole result type, an array for a list, as in supabase-js. Nothing changes at runtime. |
| `.overrideTypes<TResult, TOptions>()` | `() => ILocalSelectBuilder` | No | Merges `TResult` into the row type, or replaces it with `{ merge: false }`, as in supabase-js. Nothing changes at runtime. |
| [`.csv()`](https://supabase.com/docs/reference/javascript/using-modifiers-csv#examples) | `() => ISelectCsvQuery` | No | Terminal. Returns the rows as CSV text: a header of the selected columns in their order, or of every key the rows carry in the order it first appears for `*`, then one line per row. Fields holding a quote, a comma, or a line break are quoted per RFC 4180, null is an empty field, and an array or object is its JSON text. Lines end with `\n`. |
| [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples) | `<TRow>() => ISelectSingleQuery<TRow>` | No | Terminal. Yields the one matching row and throws when the match count is not exactly one. The type argument types that row. No further chaining is available after it. |
| [`.maybeSingle()`](https://supabase.com/docs/reference/javascript/using-modifiers-maybesingle#examples) | `<TRow>() => ISelectMaybeSingleQuery<TRow>` | No | Terminal. Yields the matching row or `null`, and throws on more than one. |

## Returns

`Promise<ISelectResult>` by default, and the two terminals narrow it.

| Name | Type | Required | Description |
|---|---|---|---|
| `data` | `TColumnValues[]` | — | The projected rows, sorted and truncated. [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples) narrows this to one `TColumnValues` object, [`.maybeSingle()`](https://supabase.com/docs/reference/javascript/using-modifiers-maybesingle#examples) to `TColumnValues \| null`, and [`.csv()`](https://supabase.com/docs/reference/javascript/using-modifiers-csv#examples) to a `string`. `null` when `options.head` is `true`. |
| `error` | `null` | — | Always `null`. A local read that cannot be served throws instead of returning an error envelope. |
| `count` | `number \| null` | — | The rows the filters matched before [`.range()`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters) and [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#parameters) when `options.count` is set, else `null`. |

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `from(table)` names a table absent from [Define config](./define-config.md#parameters). |
| `LOCAL_UNSUPPORTED` | The projection contains `(`, a relational embed, which the local store cannot follow because it holds each synced table without foreign-key joins (read related rows with a second query), or `:`, a rename. Both are refused when the read executes rather than when the column list is written. A negative [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#examples) count. [`.range()`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters) throws synchronously on a bound that is not an integer of zero or more, or on a `to` below `from - 1`. `options.count` outside `exact`, `planned`, and `estimated` throws synchronously. Also raised by the filters [Using filters](./using-filters.md#errors) lists, such as a `regexMatch()` pattern the local regex engine cannot compile. [`.order()`](https://supabase.com/docs/reference/javascript/using-modifiers-order#examples), [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#examples), and [`.range()`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters) throw naming `referencedTable` or its deprecated alias `foreignTable` for the same reason as an embed. The postgrest-js methods with no local meaning are typed stubs that throw naming themselves and the reason, never a bare `TypeError`: `rangeGt()`, `rangeGte()`, `rangeLt()`, `rangeLte()`, and `rangeAdjacent()` (Postgres range types have no local representation), `geojson()` (PostGIS output has no local representation), `explain()` (it describes the server query planner), `rollback()` (there is no server transaction; local writes enter the outbox), `setHeader()` (a local read sends no HTTP request), and `maxAffected()` (it caps an update or a delete). `stripNulls()` after [`.csv()`](https://supabase.com/docs/reference/javascript/using-modifiers-csv#examples) throws the same way, as it does in supabase-js. |
| `LOCAL_CONSTRAINT` | [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples) matched zero rows or more than one, or [`.maybeSingle()`](https://supabase.com/docs/reference/javascript/using-modifiers-maybesingle#examples) matched more than one. The kernel's message names the method and the count, for example `query: single() requires exactly one row; got 0`. |

This method throws its errors rather than returning them, so wrap the await in `try` when a query can violate one of the conditions above.

## Notes

Every read is served from the local database, and there is no network fallback: rows a peer wrote appear only after a pull commits a boundary, which the automatic loop runs on its own and [Sync](./sync.md) or [Pull once](./pull-once.md) runs on demand. Rows your own app wrote are visible immediately, before the outbox drains, which is the optimistic path [Offline writes](../../sync/offline-writes.md#1-write-locally) describes. [How Kizuna works](../../getting-started/how-kizuna-works.md#1-your-screen-uses-local-sqlite) places the local read in the whole cycle.

The server decides [Row Level Security](https://grokipedia.com/page/Row-level_security), never the device. The local store holds what earlier pulls delivered, so the server decided visibility when those rows arrived. The policies themselves stay in [Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security#select-policies).

[Supported query operators](../query-operators.md) lists every postgrest-js method and option with its status in the JavaScript, Swift, and Kotlin app clients, and the reason each unsupported one is refused. An unsupported call throws a typed `TEngineError` with code `LOCAL_UNSUPPORTED`, from `kizunasync`, and nothing falls back to the network.

The app client selects the engine when its first use opens it, as [Initializing](./initializing.md#errors) describes. It reads a driver-carried engine transport first, which is how the browser runs Rust as [WebAssembly](https://grokipedia.com/page/WebAssembly) in its worker. Failing that, it runs Rust through a linked [UniFFI](https://mozilla.github.io/uniffi-rs/) binding or the [N-API](https://nodejs.org/api/n-api.html) addon. In every case the driver reports [`databasePath`](./types.md#ports). A file path lets the kernel open the same database. `null` or the literal `':memory:'` creates a private in-memory database. Where no binding resolves, that first call rejects with a typed `TEngineError` with code `ENGINE_UNAVAILABLE` that names what to install, rather than downgrading to another engine, and so does every later call. The kernel runs the [conformance corpus](../../resources/glossary.md#conformance-corpus) for the supported local subset, and [Project status](../../getting-started/status.md#engine-selection) records which runtime reaches it how.

An `update` or `delete` whose filter matches no local row is a no-op with no error, matching supabase-js zero-row behavior. Every supported filter is evaluated by the kernel over the local SQLite store, and none of them reaches the network. [Offline writes](../../sync/offline-writes.md#1-write-locally) covers what happens to the mutation those builders queue.

### Example: filters offline

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const { data } = await kizunasync
  .from('todos')
  .select('id, title, rank')
  .gte('rank', 2)
  .or('done.eq.false,title.ilike.%urgent%')
  .order('rank')
  .limit(20)
```

### Example: handling LOCAL_UNSUPPORTED

```ts
// src/todo-list.ts
import { EEngineErrorCode, TEngineError } from 'kizunasync'
import { kizunasync } from './kizunasync'

try {
  await kizunasync.from('todos').select().regexMatch('title', '(works) \\1')
} catch (error) {
  if (error instanceof TEngineError && error.code === EEngineErrorCode.LOCAL_UNSUPPORTED) {
    // the local regex engine has no backreferences, so match the title with a simpler pattern
  }
}
```

## Related reference

- [Insert data](./insert-data.md)
- [Using filters](./using-filters.md)
- [Supported query operators](../query-operators.md)
- [Sync](./sync.md)
- [React: useQuery](../react/use-query.md)
- [Vue: useQuery](../vue/use-query.md)
- [Swift: Fetch data](../swift/fetch-data.md)
- [Kotlin: Fetch data](../kotlin/fetch-data.md)
