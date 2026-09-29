---
title: Using transforms
description: Increment a number and add or remove array members without reading the row first.
status: alpha
docType: reference
library: javascript
pageKind: guide
audience: app-developer
---

# JavaScript: Using transforms

A field transform is a sentinel value placed in the values map of [Update data](./update-data.md). The builder splits it out before the write, so it travels as an intent the server applies to the stored row rather than as a value read on this device. There are three, and supabase-js has no counterpart for them: [`.update()`](https://supabase.com/docs/reference/javascript/update#parameters) carries plain assignments only.

## Examples

### Count something

```ts
// src/todo-list.ts
import { increment } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export async function countView(todoId: string): Promise<void> {
  await kizunasync
    .from('todos')
    .update({ views: increment(1) })
    .eq('id', todoId)
}
```

### Keep a set of tags

```ts
// src/todo-list.ts
import { arrayRemove, arrayUnion } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export async function tagForTravel(todoId: string): Promise<void> {
  await kizunasync
    .from('todos')
    .update({ tags: arrayUnion('travel', 'offline') })
    .eq('id', todoId)
}

export async function untagOffline(todoId: string): Promise<void> {
  await kizunasync
    .from('todos')
    .update({ tags: arrayRemove('offline') })
    .eq('id', todoId)
}
```

### A delta larger than a JavaScript number holds exactly

```ts
// src/todo-list.ts
import { increment } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export async function addViews(todoId: string): Promise<void> {
  await kizunasync
    .from('todos')
    .update({ views: increment('9007199254740993') })
    .eq('id', todoId)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `increment(by)` | `(by: number \| string) => TIncrementSentinel` | — | A signed integer delta. A number must be an integer, and a decimal string carries a value larger than a JavaScript number holds exactly. The wire form is a JSON number below 2147483648 in absolute value and a decimal string at or above it. |
| `arrayUnion(...values)` | `(...values: Array<boolean \| number \| string>) => TArrayUnionSentinel` | — | Adds each value the column does not already hold, preserving the existing order and appending the rest. At least one value is required, and `null` is not a member type. |
| `arrayRemove(...values)` | `(...values: Array<boolean \| number \| string>) => TArrayRemoveSentinel` | — | Removes every listed value from the column. At least one value is required, and `null` is not a member type. |

## Returns

Each factory returns a branded sentinel. A sentinel means something only inside a values map, so it belongs inline in the call rather than in a variable.

| Name | Type | Required | Description |
|---|---|---|---|
| `TIncrementSentinel` | `{ by: bigint }` | — | Encoded on the wire as `{ op: 'increment', by }`. |
| `TArrayUnionSentinel` | `{ values: Array<boolean \| number \| string> }` | — | Encoded on the wire as `{ op: 'arrayUnion', values }`. |
| `TArrayRemoveSentinel` | `{ values: Array<boolean \| number \| string> }` | — | Encoded on the wire as `{ op: 'arrayRemove', values }`. |

[Transforms](../protocol.md#transforms) defines those three wire shapes and the integer encoding rule.

### What the optimistic local apply does before the server answers

| Name | Type | Required | Description |
|---|---|---|---|
| Numeric column | `number \| string` | — | Read as an integer and advanced by the delta. A null or absent cell counts as zero. A cell that is not an integer is left untouched, and the server answers that mutation with reason `CONSTRAINT`. |
| Array column | `TColumnValue[]` | — | Members are compared by their JSON encoding. A cell that is not an array is treated as empty, so a union writes the listed values and a removal writes an empty array. |

## Errors

| Code | Condition |
|---|---|
| `LOCAL_CONSTRAINT` | The delta is not an integer, a union or a removal was called with no values, or the transform targets `id`, refused from the builder with the message `update() cannot transform "id": the primary key is immutable`. |

## Notes

A transform is applied at the server in arrival order (not as a conflict-free counter), so two offline devices each adding one both land, but a later plain assignment to the same column overwrites the running total. [Collaborative fields](../../sync/collaborative-fields.md#2-count-with-increment) shows which shapes hold up and which do not.

The array forms are column shortcuts rather than sets with per-member identity: two devices removing and re-adding the same member converge on the last arrival, not on a merged history. [Collaborative fields](../../sync/collaborative-fields.md#3-keep-sets-with-arrayunion-and-arrayremove) covers the boundary.

A transform rides an update, so everything on [Update data](./update-data.md#errors) also applies: at least one filter, one queued mutation per matched row, and a verdict that arrives with a later sync.

## Related reference

- [Update data](./update-data.md)
- [Using filters](./using-filters.md)
- [List rejections](./rejections.md)
- [Swift: Using transforms](../swift/using-transforms.md)
- [Kotlin: Using transforms](../kotlin/using-transforms.md)
