---
title: Using filters
description: Narrow a local read and pick the rows a local write targets.
status: alpha
docType: reference
library: javascript
pageKind: guide
audience: app-developer
---

# JavaScript: Using filters

A filter narrows the rows a read returns. It also picks the rows a write targets. The chain is the one supabase-js documents operator by operator under [Using filters](https://supabase.com/docs/reference/javascript/using-filters), with the same argument order and the same names. Every operator below becomes a node of the plan the Rust kernel evaluates against the local database. No request leaves the device, and no [Postgres](https://grokipedia.com/page/PostgreSQL) operator class decides the match.

## Examples

### Narrow a read

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const { data } = await kizunasync
  .from('todos')
  .select('id, title, done')
  .eq('done', false)
  .ilike('title', '%plane%')
```

### Pick the rows a write targets

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function completeTodos(todoIds: string[]): Promise<void> {
  await kizunasync
    .from('todos')
    .update({ done: true })
    .in('id', todoIds)
}
```

### Several patterns, a regular expression, and a null-safe comparison

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const { data } = await kizunasync
  .from('todos')
  .select('id, title')
  .likeAnyOf('title', ['%plane%', '%train%'])
  .regexMatch('title', '^[A-Z]')
  .isDistinct('image_path', null)
```

### A PostgREST-style clause list

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const { data } = await kizunasync
  .from('todos')
  .select('*')
  .or('done.is.false,title.like.works%')
```

## Parameters

Chained filters combine with AND, in the order they were added.

| Name | Type | Required | Description |
|---|---|---|---|
| [`.eq(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-eq#parameters) | `(column: string, value: TColumnValue) => builder` | No | Strict identity against the stored cell. A null or absent cell never matches, and a `null` argument matches no row, as `= NULL` does in SQL. `.is(column, null)` finds the nulls. |
| [`.neq(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-neq#parameters) | `(column: string, value: TColumnValue) => builder` | No | Strict inequality. A null or absent cell never matches, and a `null` argument matches no row, as `<> NULL` does in SQL. |
| [`.gt(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-gt#parameters) | `(column: string, value: TColumnValue) => builder` | No | Ordered comparison, greater than. |
| [`.gte(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-gte#parameters) | `(column: string, value: TColumnValue) => builder` | No | Ordered comparison, greater than or equal. |
| [`.lt(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-lt#parameters) | `(column: string, value: TColumnValue) => builder` | No | Ordered comparison, less than. |
| [`.lte(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-lte#parameters) | `(column: string, value: TColumnValue) => builder` | No | Ordered comparison, less than or equal. |
| [`.like(column, pattern)`](https://supabase.com/docs/reference/javascript/using-filters-like#parameters) | `(column: string, pattern: string) => builder` | No | Case-sensitive SQL pattern. `%` matches any run of characters, `_` matches one, and a backslash makes the next character literal. The pattern is anchored at both ends, so a substring match needs a leading and trailing `%`. |
| [`.ilike(column, pattern)`](https://supabase.com/docs/reference/javascript/using-filters-ilike#parameters) | `(column: string, pattern: string) => builder` | No | The same pattern grammar, case-insensitive. |
| [`.is(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-is#parameters) | `(column: string, value: null \| boolean) => builder` | No | Null and boolean identity. A column the row does not carry counts as null, so a null test matches an absent key. Any other operand is `LOCAL_UNSUPPORTED`. |
| [`.in(column, values)`](https://supabase.com/docs/reference/javascript/using-filters-in#parameters) | `(column: string, values: readonly TColumnValue[]) => builder` | No | Strict identity against any member of the list. A null or absent cell never matches, and a `null` member matches no row. |
| [`.contains(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-contains#parameters) | `(column: string, value: TContainsValue) => builder` | No | Containment. A string cell that parses as a JSON array or object is decoded first; every element or key of the argument must be present in the cell. Any other cell is compared as a scalar. |
| [`.containedBy(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-containedby#parameters) | `(column: string, value: TContainsValue) => builder` | No | The same containment test with the two sides swapped. |
| [`.or(filters, options?)`](https://supabase.com/docs/reference/javascript/using-filters-or#parameters) | `(filters: string, options?: { referencedTable?: string; foreignTable?: string }) => builder` | No | A comma-separated list of `column.operator.value` clauses, any one of which may match. `referencedTable` and `foreignTable` throw `LOCAL_UNSUPPORTED`: the local store holds each synced table without foreign-key joins. |
| `.and(filters)` | `(filters: string) => builder` | No | The same clause grammar, all of which must match. supabase-js has no dedicated page for it; the clause list is the one [`.or()`](https://supabase.com/docs/reference/javascript/using-filters-or#parameters) documents. |
| [`.not(column, operator, value)`](https://supabase.com/docs/reference/javascript/using-filters-not#parameters) | `(column: string, operator: string, value: unknown) => builder` | No | Negates one clause. The operator is one of the ten clause operators below. A clause that is unknown on a row, such as a comparison with a null cell, stays unknown when negated, so the row is left out either way. |
| [`.textSearch(column, query, options?)`](https://supabase.com/docs/reference/javascript/using-filters-textsearch#parameters) | `(column: string, query: string, options?: { type?: 'plain' \| 'phrase' \| 'websearch' }) => builder` | No | A local stand-in for full-text search, not a `tsvector` query. Reads only, never a write. Default `type`: `'plain'`. A `type` outside the three is `LOCAL_UNSUPPORTED`. |
| `.search(query, options?)` | `(query: string, options?: { columns?: string[] }) => builder` | No | Case-insensitive substring search with no supabase-js counterpart. With no `columns` it scans every string and number column of each row. Reads only, never a write. Default: every such column. |
| [`.match(query)`](https://supabase.com/docs/reference/javascript/using-filters-match#parameters) | `(query: Record<string, TColumnValue \| undefined>) => builder` | No | `eq` on every key whose value is not `undefined`, combined with AND. An empty object matches every row on a read; a write refuses it, because it names no rows. |
| [`.filter(column, operator, value)`](https://supabase.com/docs/reference/javascript/using-filters-filter#parameters) | `(column: string, operator: string, value: unknown) => builder` | No | One clause, `column.operator.value`, decoded with the clause grammar below, so it takes the ten clause operators and the `not.` prefix, as in `.filter('title', 'not.like', 'works%')`. |
| `.likeAnyOf(column, patterns)` | `(column: string, patterns: readonly string[]) => builder` | No | Matches when any pattern matches, with the `like` grammar. An empty list matches no row on a read. |
| `.likeAllOf(column, patterns)` | `(column: string, patterns: readonly string[]) => builder` | No | Matches when every pattern matches. An empty list matches every row on a read. |
| `.ilikeAnyOf(column, patterns)` and `.ilikeAllOf(column, patterns)` | `(column: string, patterns: readonly string[]) => builder` | No | The two lists above, case-insensitive. A write refuses an empty list, because it names no rows. |
| `.notIn(column, values)` | `(column: string, values: readonly TColumnValue[]) => builder` | No | The negation of `in`. A null or absent cell stays out, and so does every row when the list holds a `null`, as SQL `NOT IN` answers. |
| `.regexMatch(column, pattern)` | `(column: string, pattern: string) => builder` | No | Postgres `~`: the regular expression matches somewhere in the cell's text unless it anchors itself with `^` or `$`. The Rust `regex` crate evaluates it, so a backreference, lookaround, or invalid syntax is `LOCAL_UNSUPPORTED` naming the pattern. An array or object cell does not match. |
| `.regexIMatch(column, pattern)` | `(column: string, pattern: string) => builder` | No | Postgres `~*`, the same search case-insensitive. |
| `.isDistinct(column, value)` | `(column: string, value: TColumnValue) => builder` | No | `IS DISTINCT FROM`: true when exactly one of the cell and `value` is null, or both are present and unequal. It never answers unknown, so it keeps the null rows [`.neq()`](https://supabase.com/docs/reference/javascript/using-filters-neq#parameters) leaves out. |
| [`.overlaps(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-overlaps#parameters) | `(column: string, value: string \| readonly TContainsValue[]) => builder` | No | Postgres `&&`: the cell array shares at least one element with `value`. A string cell that parses as a JSON array is decoded first, as containment decodes it, and a cell that is no array does not match. `value` is an array, or text that parses as a JSON array. A Postgres range literal such as `'[1,5)'` is `LOCAL_UNSUPPORTED`, because range types have no local representation, and so is any other operand. |

The clause grammar that [`.or()`](https://supabase.com/docs/reference/javascript/using-filters-or#parameters), its AND counterpart, [`.filter()`](https://supabase.com/docs/reference/javascript/using-filters-filter#parameters), and the negation above accept:

| Name | Type | Required | Description |
|---|---|---|---|
| Clause operators | `'eq' \| 'neq' \| 'gt' \| 'gte' \| 'lt' \| 'lte' \| 'like' \| 'ilike' \| 'is' \| 'in'` | — | The ten operators a clause string may name. Any other operator throws. |
| Clause shape | `column.operator.value` | — | Split on the first two dots, so a value may itself contain dots. |
| Value literals | `null \| true \| false \| number \| string` | — | `null`, `true`, and `false` decode to those values, a bare numeric token decodes to a number when the number prints back as the same token (so `007`, `1.50`, and `12345678901234567890` stay strings), and everything else stays a string. Double quotes protect a value that contains a comma or a parenthesis, and inside them `\"` stands for a double quote and `\\` for a backslash. A single quote is an ordinary character. In a `like` or `ilike` clause, a `*` outside double quotes is a wildcard, the same as `%`, and a quoted `*` is a literal asterisk. An unclosed double quote or an unbalanced parenthesis throws `LOCAL_UNSUPPORTED` naming the clause. |
| List values | `in.(a,b,c)` | — | Parenthesized and split on its own top-level commas. |
| Nesting | — | — | A clause string passed here cannot nest another `or` or `and`; PostgREST supports nesting but this parser does not. Chain the builder or use the negation instead. |
| `not.` prefix | `column.not.operator.value` | — | Negates one clause, as PostgREST reads it: `title.not.like.works*` inside [`.or()`](https://supabase.com/docs/reference/javascript/using-filters-or#parameters) or its AND counterpart, or `'not.like'` as the operator [`.filter()`](https://supabase.com/docs/reference/javascript/using-filters-filter#parameters) takes. The operator after it is one of the ten. |

## Unsupported operators

These supabase-js operators exist on the builder as typed stubs so a call is a loud failure rather than a silent one. Each throws `LOCAL_UNSUPPORTED` naming the construct and the reason.

| Name | Type | Required | Description |
|---|---|---|---|
| [`.range(from, to)`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters) on an update or delete | `(...args: unknown[]) => never` | — | A write targets every row its filters match, so it has no window to page. A read accepts it, as [Fetch data](./fetch-data.md#parameters) documents. |
| `.rangeGt`, `.rangeGte`, `.rangeLt`, `.rangeLte`, `.rangeAdjacent` | `(...args: unknown[]) => never` | — | Postgres range types have no local representation. |
| [`.upsert(values)`](https://supabase.com/docs/reference/javascript/upsert#parameters) | `(values?: unknown) => never` | — | An offline device cannot know whether the server holds the row. Use insert or update, so the outbox carries a decided operation. |
| `.rpc(name)` | `(name?: unknown) => never` | — | It runs a server function, which the local database cannot run. Call [`rpc`](https://supabase.com/docs/reference/javascript/rpc#parameters) through supabase-js when online. |

A projection is subject to the same rule: a `columns` string containing `(` or `:` is a relational embed or a rename, which [Fetch data](./fetch-data.md#errors) rejects with the same code.

## Errors

| Code | Condition |
|---|---|
| `LOCAL_UNSUPPORTED` | One of the operators above was called, a clause string or `filter()` named an operator outside the ten, a clause was not shaped `column.operator.value`, a negation was given a value of the wrong type, an `is()` operand other than null, true, or false, a `textSearch()` type other than `plain`, `phrase`, or `websearch`, a `regexMatch()` or `regexIMatch()` pattern the local regex engine cannot compile, an `overlaps()` operand that is not an array (a range literal among them), `referencedTable` or `foreignTable` on [`.or()`](https://supabase.com/docs/reference/javascript/using-filters-or#parameters), or an `update` or `delete` was awaited with no filter at all or with a filter that names no rows, such as an empty `match({})` or pattern list. The kernel refuses a regular expression and an `overlaps()` operand when the read or write executes. |

## Notes

supabase-js forwards the [`.or()`](#parameters) and [`.and()`](#parameters) string to PostgREST without parsing it; Kizuna decodes it locally against the ten-operator subset listed in the clause grammar table above.

Filters follow the three-valued logic of SQL. A comparison with a null or absent cell, or with a `null` argument, answers unknown, a third value beside true and false. Negating an unknown clause leaves it unknown, [`.or()`](#parameters) and [`.and()`](#parameters) combine unknown clauses the way Postgres does, and a read returns a row, or a write targets it, only when the whole filter is true on that row. A `.not('rank', 'in', [2, null])` therefore matches no row, the same answer `rank not in (2, null)` gives in Postgres. [`.is()`](#parameters) never answers unknown, so it is the filter that finds nulls.

Filters that select rows for a write are a smaller set than the ones a read accepts: the write builder carries every operator in the Parameters table except the two search operators. A write also requires at least one filter that names rows; the kernel refuses an unfiltered write, or one whose filter matches every row by construction (an empty `match({})`, an empty `likeAllOf()` list), with `LOCAL_UNSUPPORTED` when it executes, rather than queuing it.

Both builders carry `.includeDeleted()`, with the same key and the same default as [Fetch data](./fetch-data.md#parameters): a row a `softDelete` column marks is excluded from a read and from write targeting until it is chained, so an `update()` or `delete()` whose filters would otherwise match that row skips it by default.

An update or delete resolves every row the filters match and applies the mutation to each in one `apply_where` call to the kernel. A write targeted by `id`, alone or alongside another filter, by [`.in('id', …)`](#parameters), or inside [`.or('id.eq.…')`](#parameters), matches a row a pull delivered.

Nothing here consults [Row Level Security](https://grokipedia.com/page/Row-level_security). The local database holds the rows earlier pulls delivered. The server decides what those pulls contain. A policy runs when the push carries the queued write, as [Validate writes](../../sync/validate-writes.md) shows. Postgres itself keeps the authoritative behavior for every operator. On mixed types, a value may therefore sort or match differently in the database than it does here. Same-type numbers compare numerically, and every other non-null pair compares as text.

A filtered write applies locally first. It then waits in the outbox until a run delivers it. [Offline writes](../../sync/offline-writes.md#1-write-locally) describes that optimistic path. [How Kizuna works](../../getting-started/how-kizuna-works.md#2-local-writes-enter-a-durable-outbox) places it in the whole cycle.

Rows a peer wrote appear only after [Sync](./sync.md) or [Pull once](./pull-once.md) commits a pull boundary, so a filter can only see what the [local store](../../resources/glossary.md#local-store) already has.

## Related reference

- [Fetch data](./fetch-data.md)
- [Update data](./update-data.md)
- [Delete data](./delete-data.md)
- [Using transforms](./using-transforms.md)
- [Swift: Using filters](../swift/using-filters.md)
- [Kotlin: Using filters](../kotlin/using-filters.md)
