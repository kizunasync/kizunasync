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
| [`.or(filters)`](https://supabase.com/docs/reference/javascript/using-filters-or#parameters) | `(filters: string) => builder` | No | A comma-separated list of `column.operator.value` clauses, any one of which may match. |
| `.and(filters)` | `(filters: string) => builder` | No | The same clause grammar, all of which must match. supabase-js has no dedicated page for it; the clause list is the one [`.or()`](https://supabase.com/docs/reference/javascript/using-filters-or#parameters) documents. |
| [`.not(column, operator, value)`](https://supabase.com/docs/reference/javascript/using-filters-not#parameters) | `(column: string, operator: string, value: unknown) => builder` | No | Negates one clause. The operator is one of the ten clause operators below. A clause that is unknown on a row, such as a comparison with a null cell, stays unknown when negated, so the row is left out either way. |
| [`.textSearch(column, query, options?)`](https://supabase.com/docs/reference/javascript/using-filters-textsearch#parameters) | `(column: string, query: string, options?: { type?: 'plain' \| 'phrase' \| 'websearch' }) => builder` | No | A local stand-in for full-text search, not a `tsvector` query. Reads only, never a write. Default `type`: `'plain'`. A `type` outside the three is `LOCAL_UNSUPPORTED`. |
| `.search(query, options?)` | `(query: string, options?: { columns?: string[] }) => builder` | No | Case-insensitive substring search with no supabase-js counterpart. With no `columns` it scans every string and number column of each row. Reads only, never a write. Default: every such column. |

The clause grammar that [`.or()`](https://supabase.com/docs/reference/javascript/using-filters-or#parameters), its AND counterpart, and the negation above accept:

| Name | Type | Required | Description |
|---|---|---|---|
| Clause operators | `'eq' \| 'neq' \| 'gt' \| 'gte' \| 'lt' \| 'lte' \| 'like' \| 'ilike' \| 'is' \| 'in'` | — | The ten operators a clause string may name. Any other operator throws. |
| Clause shape | `column.operator.value` | — | Split on the first two dots, so a value may itself contain dots. |
| Value literals | `null \| true \| false \| number \| string` | — | `null`, `true`, and `false` decode to those values, a bare numeric token decodes to a number when the number prints back as the same token (so `007`, `1.50`, and `12345678901234567890` stay strings), and everything else stays a string. Double quotes protect a value that contains a comma or a parenthesis, and inside them `\"` stands for a double quote and `\\` for a backslash. A single quote is an ordinary character. In a `like` or `ilike` clause, a `*` outside double quotes is a wildcard, the same as `%`, and a quoted `*` is a literal asterisk. An unclosed double quote or an unbalanced parenthesis throws `LOCAL_UNSUPPORTED` naming the clause. |
| List values | `in.(a,b,c)` | — | Parenthesized and split on its own top-level commas. |
| Nesting | — | — | A clause string passed here cannot nest another `or` or `and`; PostgREST supports nesting but this parser does not. Chain the builder or use the negation instead. |

## Unsupported operators

These supabase-js operators exist on the builder as typed stubs so a call is a loud failure rather than a silent one. Each throws `LOCAL_UNSUPPORTED` naming the construct.

| Name | Type | Required | Description |
|---|---|---|---|
| [`.range(from, to)`](https://supabase.com/docs/reference/javascript/using-modifiers-range#parameters) | `(...args: unknown[]) => never` | — | No local paging window. Sort and truncate with the modifiers on [Fetch data](./fetch-data.md#parameters) instead. |
| [`.overlaps(column, value)`](https://supabase.com/docs/reference/javascript/using-filters-overlaps#parameters) | `(...args: unknown[]) => never` | — | No local array or range overlap test. |
| [`.match(query)`](https://supabase.com/docs/reference/javascript/using-filters-match#parameters) | `(...args: unknown[]) => never` | — | Express the same equality set as chained identity filters. |
| [`.filter(column, operator, value)`](https://supabase.com/docs/reference/javascript/using-filters-filter#parameters) | `(...args: unknown[]) => never` | — | No generic operator escape hatch; the named operators above are the whole set. |
| [`.csv()`](https://supabase.com/docs/reference/javascript/using-modifiers-csv#examples) | `(...args: unknown[]) => never` | — | No CSV response shape; a local read returns rows. |
| [`.upsert(values)`](https://supabase.com/docs/reference/javascript/upsert#parameters) | `(values?: unknown) => never` | — | Read the row and then insert or update it, so the outbox carries a decided operation. |
| `.rpc(name)` | `(name?: unknown) => never` | — | A local database cannot run a server function. Call [`rpc`](https://supabase.com/docs/reference/javascript/rpc#parameters) on supabase-js directly for work that must run on the server. |

A projection is subject to the same rule: a `columns` string containing `(` or `:` is a relational embed or a rename, which [Fetch data](./fetch-data.md#errors) rejects with the same code.

## Errors

| Code | Condition |
|---|---|
| `LOCAL_UNSUPPORTED` | One of the operators above was called, a clause string named an operator outside the ten, a clause was not shaped `column.operator.value`, a negation was given a value of the wrong type, an `is()` operand other than null, true, or false, a `textSearch()` type other than `plain`, `phrase`, or `websearch`, or an `update` or `delete` was awaited with no filter at all. |

## Notes

supabase-js forwards the [`.or()`](#parameters) and [`.and()`](#parameters) string to PostgREST without parsing it; Kizuna decodes it locally against the ten-operator subset listed in the clause grammar table above.

Filters follow the three-valued logic of SQL. A comparison with a null or absent cell, or with a `null` argument, answers unknown, a third value beside true and false. Negating an unknown clause leaves it unknown, [`.or()`](#parameters) and [`.and()`](#parameters) combine unknown clauses the way Postgres does, and a read returns a row, or a write targets it, only when the whole filter is true on that row. A `.not('rank', 'in', [2, null])` therefore matches no row, the same answer `rank not in (2, null)` gives in Postgres. [`.is()`](#parameters) never answers unknown, so it is the filter that finds nulls.

Filters that select rows for a write are a smaller set than the ones a read accepts: the write builder carries the comparison, pattern, null, list, containment, clause-list, and negation operators, and it has neither of the two search operators. A write also requires at least one filter; the kernel refuses an unfiltered write with `LOCAL_UNSUPPORTED` when it executes, rather than queuing it.

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
