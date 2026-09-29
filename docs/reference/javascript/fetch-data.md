---
title: Fetch data
description: Select rows from the local SQLite store, with the compatibility matrix for the whole local query subset.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Fetch data

`from(table).select(columns?)` returns a builder that reads local [SQLite](https://grokipedia.com/page/SQLite). Filters, [`.order()`](https://supabase.com/docs/reference/javascript/using-modifiers-order#parameters), and [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#parameters) chain on it, and awaiting the builder runs the read. The call signature matches [`.select()`](https://supabase.com/docs/reference/javascript/select#parameters) in supabase-js.

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

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `columns` | `string` | No | Comma-separated projection. `*`, an empty string, and an omitted argument all return every stored column. A projected column the row does not carry comes back as `null`. Default: every column. |

The builder carries the filters on [Using filters](./using-filters.md) plus the four modifiers below. All of them join the plan the kernel evaluates when the read executes.

| Name | Type | Required | Description |
|---|---|---|---|
| [`.order(column, options?)`](https://supabase.com/docs/reference/javascript/using-modifiers-order#examples) | `(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => ILocalSelectBuilder` | No | Sorts the matched rows. The first call in the chain is the primary sort and later calls break ties. `ascending` defaults to `true`, and `nullsFirst` (the wire key the plan carries) defaults to the negation of `ascending`. |
| [`.limit(count)`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#examples) | `(count: number) => ILocalSelectBuilder` | No | Truncates after sorting. `count` must be an integer; a fractional count throws `LOCAL_UNSUPPORTED` synchronously, and a negative count is refused `LOCAL_UNSUPPORTED` when the read executes. |
| `.includeDeleted()` | `() => ILocalSelectBuilder` | No | Keeps the rows a table's `softDelete` column marks. Without it a marked row is excluded before the plan runs, so [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#examples) counts only the rows you can see. No effect on a table with no `softDelete` column. |
| [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples) | `() => PromiseLike<ISelectOneResult>` | No | Terminal. Yields the one matching row and throws when the match count is not exactly one. No further chaining is available after it. |
| [`.maybeSingle()`](https://supabase.com/docs/reference/javascript/using-modifiers-maybesingle#examples) | `() => PromiseLike<ISelectMaybeOneResult>` | No | Terminal. Yields the matching row or `null`, and throws on more than one. |

## Returns

`Promise<ISelectResult>` by default, and the two terminals narrow it.

| Name | Type | Required | Description |
|---|---|---|---|
| `data` | `TColumnValues[]` | — | The projected rows, sorted and truncated. [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples) narrows this to one `TColumnValues` object and [`.maybeSingle()`](https://supabase.com/docs/reference/javascript/using-modifiers-maybesingle#examples) to `TColumnValues \| null`. |
| `error` | `null` | — | Always `null`. A local read that cannot be served throws instead of returning an error envelope. |

## Errors

| Code | Condition |
|---|---|
| `UNKNOWN_TABLE` | `from(table)` names a table absent from [Define config](./define-config.md#parameters). |
| `LOCAL_UNSUPPORTED` | The projection contains `(` or `:`, which is a relational embed or a rename, refused when the read executes rather than when the column list is written. A negative [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#examples) count. Also raised by the operators [Using filters](./using-filters.md#unsupported-operators) lists. `select(columns, options)` throws naming the option when `options.head` or `options.count` is set, synchronously, before a builder exists: neither has a local answer. [`.order()`](https://supabase.com/docs/reference/javascript/using-modifiers-order#examples) and [`.limit()`](https://supabase.com/docs/reference/javascript/using-modifiers-limit#examples) throw the same way naming `referencedTable` or its deprecated alias `foreignTable`: there is no referenced table to order or cap. Every other method `node_modules/@supabase/postgrest-js` exposes on its filter, transform, and base builder classes that this builder does not implement (`abortSignal()`, `returns()`, `overrideTypes()`, `explain()`, `rollback()`, `maxAffected()`, `throwOnError()`, `stripNulls()`, `setHeader()`, `retry()`, `geojson()`, `isDistinct()`, `notIn()`, `likeAllOf()` / `likeAnyOf()` / `ilikeAllOf()` / `ilikeAnyOf()`, `regexMatch()` / `regexIMatch()`, `rangeGt()` / `rangeGte()` / `rangeLt()` / `rangeLte()` / `rangeAdjacent()`, and a write's chained [`.select()`](https://supabase.com/docs/reference/javascript/select#parameters)) is a typed stub naming itself, never a bare `TypeError`. |
| `LOCAL_CONSTRAINT` | [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples) matched zero rows or more than one, or [`.maybeSingle()`](https://supabase.com/docs/reference/javascript/using-modifiers-maybesingle#examples) matched more than one. The kernel's message names the method and the count, for example `query: single() requires exactly one row; got 0`. |

This method throws its errors rather than returning them, so wrap the await in `try` when a query can violate one of the conditions above.

## Notes

Every read is served from the local database, and there is no network fallback: rows a peer wrote appear only after a pull commits a boundary, which the automatic loop runs on its own and [Sync](./sync.md) or [Pull once](./pull-once.md) runs on demand. Rows your own app wrote are visible immediately, before the outbox drains, which is the optimistic path [Offline writes](../../sync/offline-writes.md#1-write-locally) describes. [How Kizuna works](../../getting-started/how-kizuna-works.md#1-your-screen-uses-local-sqlite) places the local read in the whole cycle.

The server decides [Row Level Security](https://grokipedia.com/page/Row-level_security), never the device. The local store holds what earlier pulls delivered, so the server decided visibility when those rows arrived. The policies themselves stay in [Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security#select-policies).

### Local query compatibility matrix

`kizunasync.from(...)` sends a query plan to the Rust kernel, which evaluates it against [local SQLite](https://grokipedia.com/page/SQLite) only, and reads never touch the network. The method names mirror supabase-js, whose [filters](https://supabase.com/docs/reference/javascript/using-filters) and [modifiers](https://supabase.com/docs/reference/javascript/using-modifiers) pages document the semantics this subset reproduces. What Kizuna changes is where the answer comes from: the local database replies at once, and a write's verdict arrives on a later sync. Anything outside the supported subset throws a typed `TEngineError` with code `LOCAL_UNSUPPORTED`, from `@kizunasync/core`. There is no silent network fallback.

The app client selects the engine when its first use opens it, as [Initializing](./initializing.md#errors) describes. It reads a driver-carried engine transport first, which is how the browser runs Rust as [WebAssembly](https://grokipedia.com/page/WebAssembly) in its worker. Failing that, it runs Rust through a linked [UniFFI](https://mozilla.github.io/uniffi-rs/) binding or the [N-API](https://nodejs.org/api/n-api.html) addon. In every case the driver reports [`databasePath`](./types.md#ports). A file path lets the kernel open the same database. `null` or the literal `':memory:'` creates a private in-memory database. Where no binding resolves, that first call rejects with a typed `TEngineError` with code `ENGINE_UNAVAILABLE` that names what to install, rather than downgrading to another engine, and so does every later call. The kernel runs the [conformance corpus](../../resources/glossary.md#conformance-corpus) for the supported local subset, and [Project status](../../getting-started/status.md#engine-selection) records which runtime reaches it how.

| Method | Supported | Notes |
|---|---|---|
| [`insert(values)`](./insert-data.md) | Yes | The client mints the `id` (uuid) when it is absent, and columns reach the kernel unchanged otherwise. A duplicate primary key throws `LOCAL_CONSTRAINT` from the local store. Refused `LOCAL_UNSUPPORTED` when the table's `sync` is `'pull-only'`. |
| [`update(values, options?).eq(...)`](./update-data.md) | Yes | The kernel resolves every row the filters match and applies the mutation to each in one `apply_where` call. At least one filter is required. `values.id` is refused `LOCAL_CONSTRAINT` only when it differs from the row's primary key. `options.precondition` is a server-side compare-and-set mask. Refused `LOCAL_UNSUPPORTED` when the table's `sync` is `'pull-only'`. A soft-deleted row is excluded from targeting unless [`.includeDeleted()`](#parameters) is chained. |
| [`delete(options?).eq(...)`](./delete-data.md) | Yes | The same targeting and optional `precondition` as `update`, in one `apply_where` call. An unfiltered `delete()` is `LOCAL_UNSUPPORTED`, and so is a `delete()` on a `'pull-only'` table. On a table that declares `softDelete`, `delete()` stamps that column with an update instead of writing a tombstone; `SOFT_DELETE_VIOLATION` survives only on the low-level `apply` port. |
| `select(columns?)` | Yes | Column projection (`'a,b'`) evaluated by the kernel when the read executes; an empty segment (`'title,'`) is dropped. Relational embeds such as `author(name)` and renames are `LOCAL_UNSUPPORTED`. A row a `softDelete` column marks is excluded from the result unless [`.includeDeleted()`](#parameters) is chained. |
| [`.eq(col, val)`](./using-filters.md) | Yes | Equality filter, part of the plan the kernel evaluates. |
| [`.neq` / `.gt` / `.gte` / `.lt` / `.lte`](./using-filters.md#parameters) | Yes | Comparison filters the kernel evaluates. Null never matches a range. |
| [`.like` / `.ilike`](./using-filters.md#parameters) | Yes | SQL `LIKE` patterns (`%` and `_`), the second case-insensitive. |
| `.is(col, null\|bool)` | Yes | Null and boolean identity (`is null`, `is true`, `is false`). Any other operand is `LOCAL_UNSUPPORTED`. |
| `.in(col, values)` | Yes | Membership in a value list. |
| `.or('col.op.val,…')` / `.and('…')` | Yes | [PostgREST](https://postgrest.org/)-style clause strings. Commas inside double-quoted values are preserved, and `in.(a,b)` keeps its list commas. A single quote is an ordinary character. Nested and/or inside the string is unsupported, so chain builders or use [`.not()`](./using-filters.md#parameters). An invalid clause, an unclosed double quote, or an unbalanced parenthesis throws `LOCAL_UNSUPPORTED`. |
| `.not(col, op, val)` | Yes | Negates a comparison, like, is, or in clause. |
| `.search(query, opts?)` | Yes | Case-insensitive substring across string and number columns, or `opts.columns`. A local stand-in, not [Postgres](https://grokipedia.com/page/PostgreSQL) full-text search or FTS5. |
| `.textSearch(col, query, opts?)` | Yes | Column-scoped local stand-in: `plain` (the default) needs all tokens, `phrase` needs the full string, `websearch` takes tokens plus `"quoted phrases"`. A `type` outside the three is `LOCAL_UNSUPPORTED`. Not `tsvector` or FTS5. |
| [`.contains` / `.containedBy`](./using-filters.md#parameters) | Yes | Local jsonb and array containment over JSON-string or scalar cells. An offline stand-in for `@>` and `<@`, not live Postgres jsonb operators. |
| `.order(col, opts?)` | Yes | `opts` is `{ ascending?: boolean; nullsFirst?: boolean }`. The defaults mirror Postgres: nulls last for ascending, nulls first for descending. Pass `nullsFirst` to override; it is the wire key the plan carries. |
| `.limit(n)` | Yes | A row cap in the plan. `n` must be an integer; a fractional value throws `LOCAL_UNSUPPORTED` synchronously, and a negative value is refused `LOCAL_UNSUPPORTED` when the read executes. |
| [`.single()`](https://supabase.com/docs/reference/javascript/using-modifiers-single#examples) | Yes | Exactly one row as an object. Throws `LOCAL_CONSTRAINT` on zero or more than one. |
| [`.maybeSingle()`](https://supabase.com/docs/reference/javascript/using-modifiers-maybesingle#examples) | Yes | Zero or one row, `null` when there is none. Throws `LOCAL_CONSTRAINT` on more than one. |
| [`.range` / `.overlaps` / `.match` / `.filter`](./using-filters.md#unsupported-operators) | No | PostgREST-only operators. `LOCAL_UNSUPPORTED`. |
| `upsert(...)` / [`rpc(...)`](https://supabase.com/docs/reference/javascript/rpc) / [`.csv()`](https://supabase.com/docs/reference/javascript/db-csv) | No | `LOCAL_UNSUPPORTED`. Call a Postgres function through supabase-js directly when you need one, and treat the result as an online operation. |

An `update` or `delete` whose filter matches no local row is a no-op with no error, matching supabase-js zero-row behavior. Every supported filter is evaluated by the kernel over the local SQLite store, and none of them reaches the network. [Offline writes](../../sync/offline-writes.md#1-write-locally) covers what happens to the mutation those builders queue.

#### Example: filters offline

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

#### Example: handling LOCAL_UNSUPPORTED

```ts
// src/todo-list.ts
import { EEngineErrorCode, TEngineError } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

try {
  await kizunasync.from('todos').select().csv()
} catch (error) {
  if (error instanceof TEngineError && error.code === EEngineErrorCode.LOCAL_UNSUPPORTED) {
    // use .select() array results instead
  }
}
```

## Related reference

- [Insert data](./insert-data.md)
- [Using filters](./using-filters.md)
- [Sync](./sync.md)
- [React: useQuery](../react/use-query.md)
- [Vue: useQuery](../vue/use-query.md)
- [Swift: Fetch data](../swift/fetch-data.md)
- [Kotlin: Fetch data](../kotlin/fetch-data.md)
