---
title: useRejections
description: Read the durable rejection journal and dismiss entries the reader has seen.
status: alpha
docType: reference
library: vue
pageKind: method
audience: app-developer
---

# Vue: useRejections

`useRejections` reads the client-local journal of every write the server refused, newest first, and returns the action that acknowledges one. The engine's rejection events are fire and forget; this journal survives reloads until each entry is dismissed, so a component can explain a write that vanished an hour ago.

## Examples

### Basic

```ts
// src/components/RejectionCount.vue (script setup)
import { useRejections } from '@kizunasync/vue'

const { rejections, dismiss } = useRejections()
```

### Render the journal

```vue
<!-- src/components/RejectionList.vue -->
<script setup lang="ts">
import { useRejections } from '@kizunasync/vue'

const { rejections, error, isLoading, dismiss } = useRejections()
</script>

<template>
  <p v-if="error !== null">The journal could not be read: {{ error.message }}</p>
  <ul v-else-if="!isLoading">
    <li v-for="entry in rejections" :key="entry.mutationId">
      {{ entry.table }} {{ entry.kind }}: {{ entry.reason }}
      <button @click="dismiss(entry.mutationId)">Dismiss</button>
    </li>
  </ul>
</template>
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `opts` | `IUseRejectionsOptions` | No | Client override plus the dismissed filter. Default: the provided client and live entries only. |
| `opts.client` | `IKizunaSync` | No | Used instead of the client seeded by [`createKizunaSyncPlugin` or `provideKizunaSync`](./initializing.md), resolved through [useKizunaSync](./use-kizunasync.md). Default: the provided client. |
| `opts.includeDismissed` | `boolean` | No | When `true`, entries already acknowledged stay in the list, which is what a history view wants. Read once when the composable is created. Default: `false`. |

## Returns

`IUseRejectionsResult`. The three state fields are refs; `dismiss` is a plain function.

| Name | Type | Required | Description |
|---|---|---|---|
| `rejections` | `Ref<TRejectionRecord[]>` | — | The journal rows the last read returned, newest first. `[]` before the first read resolves and after a failed one. |
| `error` | `Ref<Error \| null>` | — | The failure the last read raised, wrapped in an `Error` when it was not one. Cleared by the next successful read. |
| `isLoading` | `Ref<boolean>` | — | `true` until the first read settles, then `false` for the life of the subscription. |
| `dismiss` | `(mutationId: TUuid) => Promise<void>` | — | Calls [`dismissRejection`](../javascript/dismiss-rejection.md) for one entry and then awaits a fresh read, so the list already reflects the change when the promise settles. |

Fields on one `TRejectionRecord`:

| Name | Type | Required | Description |
|---|---|---|---|
| `mutationId` | `TUuid` | — | The identity of the refused write, and the argument `dismiss` takes. |
| `table` | `string` | — | The table the write targeted. |
| `pk` | `TRowKey` | — | The primary key of the row the write targeted. |
| `kind` | `'REJECTED' \| 'SUPERSEDED' \| 'DEAD_LETTER' \| 'BATCH_ABORTED'` | — | Which path refused the write: a per-mutation verdict, a newer write that won, an exhausted retry budget, or an atomic batch the server refused. |
| `reason` | `string` | — | The verdict reason as the server worded it, one of `CONSTRAINT`, `COLUMN_DENIED`, `DELETE_WINS`, `PRECONDITION`, `RLS_DENIED`, and `SUPERSEDED` for the first three kinds. A `DEAD_LETTER` entry carries `PERMANENT_TRANSPORT`, except an atomic batch the server dead-letters at once for its size (`KZP02`), which carries the server's own message instead. |
| `changedColumns` | `string[]` | — | The columns the refused mutation carried, which is what a component highlights when it offers to re-apply the edit. |
| `serverRow` | `TColumnValues \| null` | — | The authoritative row the verdict carried, or `null` when it carried none. This is the state the local row was reverted to. |
| `at` | `number` | — | Epoch milliseconds when the entry was journalled. |
| `dismissed` | `boolean` | — | Whether this entry has been acknowledged. Only ever `true` in a list read with `includeDismissed`. |

## Errors

A failed read lands in `error` rather than being swallowed, because a component that cannot read this journal has to be able to say so instead of rendering an empty list as though nothing had gone wrong.

`dismiss` rejects when [`dismissRejection`](../javascript/dismiss-rejection.md) fails, so a handler can catch it. A dismiss whose follow-up read fails resolves regardless, with that failure in `error`.

A composable that runs outside the provide scope and passes no `{ client }` override throws from [useKizunaSync](./use-kizunasync.md).

## Notes

The list re-reads on `MUTATION_REJECTED`, `BATCH_ABORTED`, and `DEAD_LETTER`, and on nothing else. Those three are the only events that add or change a journal row. A [`SUPERSEDED`](../javascript/rejections.md#the-four-kinds) entry needs no event of its own, because it rides `MUTATION_REJECTED`. Narrowing the subscription to those three therefore misses nothing, and it keeps a pull of a thousand rows from re-reading the journal. `onScopeDispose` unsubscribes with the owning component.

Dismissing is an acknowledgement, not a repair. The local row was already reverted to the server state when the verdict arrived, so re-applying the edit means writing it again through [useMutation](./use-mutation.md). [Read the journal in the app](../../sync/validate-writes.md#4-read-the-journal-in-the-app) shows both halves against a policy that refuses the write.

An `RLS_DENIED` reason means [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#write-a-policy-for-each-operation) refused the write on the server. Kizuna adds the timing: the policy is judged when the queued write reaches the server rather than when the component renders, so this journal is where the verdict surfaces.

## Related reference

- [useMutation](./use-mutation.md)
- [useSyncStatus](./use-sync-status.md)
- [JavaScript: List rejections](../javascript/rejections.md)
- [JavaScript: Dismiss a rejection](../javascript/dismiss-rejection.md)
- [React: useRejections](../react/use-rejections.md)
