---
title: Collaborative fields
description: Independent columns, increment and array transforms, the conflict journal, and client-side text merge on insert-only rows.
status: alpha
docType: how-to
audience: app-developer
---

# Collaborative fields

Shape the fields several people edit at once so their writes survive each other. This page covers independent columns, the `increment` and array transforms, the server-side conflict journal, and an insert-only child table for text. Kizuna keeps ordinary [Postgres](https://grokipedia.com/page/PostgreSQL) columns throughout, so each one is a plain column, a plain array, or a plain child table. The JavaScript helpers `increment()`, `arrayUnion()`, and `arrayRemove()` compile to the same `transforms` map that native `apply` accepts. A transform rides an `update` rather than a fourth mutation kind.

## Before you begin

- A table declared with `sync: 'read-write'`, both in your client config and in `kizunasync._config`. See [Sync rules & buckets](./sync-rules-and-buckets.md#2-write-your-first-config) if you have not declared one.
- The app client running in your app, exported as `kizunasync` from `src/kizunasync.ts`. Build one with the [Quick start](../getting-started/quickstart.md) if you are starting from scratch.

## 1. Split contested state into independent columns

Two devices that edit different columns of one row both keep their values, because the keys of a mutation's `columns` map are the mask it writes. Two devices that assign the same column keep the write Postgres accepted later, which is [column last-writer-wins](../resources/glossary.md#column-last-writer-wins-column-lww).

```ts
// src/todo-actions.ts
import { kizunasync } from './kizunasync'

// Device A calls renameTodo(todoId, 'Buy oat milk')
export async function renameTodo(todoId: string, title: string): Promise<void> {
  await kizunasync.from('todos').update({ title }).eq('id', todoId)
}

// Device B calls completeTodo(todoId) in an overlapping offline window
export async function completeTodo(todoId: string): Promise<void> {
  await kizunasync.from('todos').update({ done: true }).eq('id', todoId)
}
```

After both pushes the row is `{ title: 'Buy oat milk', done: true }`, and a later assign of `title` from either device replaces that string. Splitting a screen's editable state across columns keeps both writes, because each mask leaves the other columns alone. [Column masks](./conflict-resolution.md#column-masks) covers what happens when two writes do land on one column.

You should now see both columns holding their new values after both devices sync, with no rejection on either side.

## 2. Count with `increment()`

`increment(by)` sends a delta instead of a total, so two devices that each add one both count. The arbiter always applies the delta and never compares it against an [HLC](../resources/glossary.md#hybrid-logical-clock-hlc), and a later assign of the same column replaces the running total, including increments waiting in the [outbox](../resources/glossary.md#outbox). Mix it with ordinary assigns in the same call, as [Using transforms](../reference/javascript/using-transforms.md#parameters) shows for all three helpers.

:::tabs{group=lang}
```ts tab=TypeScript
// src/todo-actions.ts (excerpt)
import { increment } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export async function likeTodo(todoId: string): Promise<void> {
  await kizunasync.from('todos').update({ likes: increment(1) }).eq('id', todoId)
}

// CAS on version plus a likes delta in one mutation
export async function likeTodoAtVersion(todoId: string): Promise<void> {
  await kizunasync
    .from('todos')
    .update({ version: 2, likes: increment(1) }, { precondition: { version: 1 } })
    .eq('id', todoId)
}
```

```swift tab=Swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

func likeTodo(_ todoId: String) async throws {
  try await kizunasync.apply(
    table: "todos",
    pk: todoId,
    op: .update,
    columns: [:],
    transforms: ["likes": ["op": "increment", "by": 1]]
  )
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
package com.example.todo

import com.kizunasync.kizunasync.KizunaSyncOp

suspend fun likeTodo(todoId: String) {
    kizunasync.apply(
        table = "todos",
        pk = todoId,
        op = KizunaSyncOp.Update,
        transforms = mapOf("likes" to mapOf("op" to "increment", "by" to 1)),
    )
}
```
:::

The Swift and Kotlin tabs above match [Swift: Using transforms](../reference/swift/using-transforms.md#supported-transforms) and [Kotlin: Using transforms](../reference/kotlin/using-transforms.md#supported-transforms).

The second call pairs a transform with a `precondition`, the compare-and-set that [Update data](../reference/javascript/update-data.md) documents. The builder mirrors supabase-js [`update()`](https://supabase.com/docs/reference/javascript/update); what Kizuna changes is that the call returns from the local database and the server's verdict arrives with a later sync.

`by` must be a signed integer. Pass a number, or a decimal string for a value larger than a JavaScript number holds exactly. Transforming `id`, naming the same column in both the assigns and the transforms, or passing a float throws `LOCAL_CONSTRAINT` before the write is queued, alongside the other local refusals in the [local query compatibility matrix](../reference/javascript/fetch-data.md#local-query-compatibility-matrix).

The server rejects an increment against a non-numeric Postgres column with `CONSTRAINT`, one of the six [rejection reasons](../reference/protocol.md#rejection-reasons). A mutation is one unit, so the rejection covers the whole update: none of the columns it assigns apply either. A soft-delete table is one whose config names a `softDelete` column. It accepts an increment the same way an ordinary table does, because an increment rides an `update`. On that table, `delete()` stamps the [`softDelete` column](../reference/javascript/define-config.md#parameters) with its own update instead of writing a [tombstone](../resources/glossary.md#tombstone).

You should now see the counter reach the sum of both deltas after two devices sync, rather than whichever total one device computed.

## 3. Keep sets with `arrayUnion` and `arrayRemove`

`arrayUnion` and `arrayRemove` are [Firebase](https://grokipedia.com/page/Firebase)-shaped shortcuts on a Postgres array column. They take the same `transforms` map as [`increment`](../reference/javascript/using-transforms.md). Two devices that union different members both keep them. A later assign of the whole array is decided by arrival order, like any other assign.

:::tabs{group=lang}
```ts tab=TypeScript
// src/todo-actions.ts (excerpt)
import { arrayRemove, arrayUnion } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export async function tagUrgent(todoId: string): Promise<void> {
  await kizunasync.from('todos').update({ tags: arrayUnion('urgent') }).eq('id', todoId)
}

export async function untagUrgent(todoId: string): Promise<void> {
  await kizunasync.from('todos').update({ tags: arrayRemove('urgent') }).eq('id', todoId)
}
```

```swift tab=Swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

func tagUrgent(_ todoId: String) async throws {
  try await kizunasync.apply(
    table: "todos",
    pk: todoId,
    op: .update,
    columns: [:],
    transforms: ["tags": ["op": "arrayUnion", "values": ["urgent"]]]
  )
}

func untagUrgent(_ todoId: String) async throws {
  try await kizunasync.apply(
    table: "todos",
    pk: todoId,
    op: .update,
    columns: [:],
    transforms: ["tags": ["op": "arrayRemove", "values": ["urgent"]]]
  )
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
package com.example.todo

import com.kizunasync.kizunasync.KizunaSyncOp

suspend fun tagUrgent(todoId: String) {
    kizunasync.apply(
        table = "todos",
        pk = todoId,
        op = KizunaSyncOp.Update,
        transforms = mapOf("tags" to mapOf("op" to "arrayUnion", "values" to listOf("urgent"))),
    )
}

suspend fun untagUrgent(todoId: String) {
    kizunasync.apply(
        table = "todos",
        pk = todoId,
        op = KizunaSyncOp.Update,
        transforms = mapOf("tags" to mapOf("op" to "arrayRemove", "values" to listOf("urgent"))),
    )
}
```
:::

Either transform against a non-array column comes back [`CONSTRAINT`](../reference/protocol.md#rejection-reasons). The column stays a plain `text[]` you can index and write policies against. It carries no per-member add-ids, so removing a member while another device adds the same member resolves by arrival order rather than by set semantics.

When you need to know who added a tag and when, or to keep a per-member deletion history, use a child table such as `todo_tags(todo_id, tag)`. Its rows carry distinct primary keys, so they never contend.

You should now see both members present in the array after two devices union different values and sync.

## 4. Restore an overwritten assign from the journal

Turn on the table's [`conflict_journal`](../cli/configuration.md#kizunasync_config) column, with `kizunasync sync --conflict-journal` or the wizard's journal question.

When an arrival-mode or HLC-mode assign wins and overwrites a column value that was not null, the server records the losing value in [`kizunasync._conflict_journal`](../reference/sql-pack.md#kizunasync_conflict_journal). A pull attaches matching rows as an optional `conflicts` array, omitted when empty. A journal row is attached only when the winning row is in the page you received, so you see loser values only for rows your policies deliver to you. Authenticated clients have no `SELECT` on the journal table itself, and Supabase documents the policies that decide what a caller reads in [SELECT policies](https://supabase.com/docs/guides/database/postgres/row-level-security#select-policies).

Once the pull that carried the winning row commits its [checkpoint](../resources/glossary.md#checkpoint), the engine writes the loser value into the client-local `_kizunasync_overwrites` journal. It then emits `COLUMN_OVERWRITTEN` through [`kizunasync.on`](../reference/javascript/on.md). The event reaches the device that pulled the winning row, and the device whose value lost gets no notification. It reaches neither device when the winning write is the pulling device's own: the engine keeps the ids of the mutations it pushed and saw applied, and a conflict its own write won is neither journaled nor emitted, since telling a device that its own write beat someone else's is not news. The journal records no increment or array transform, because a transform overwrites nothing. [Server-side conflict journal](../reference/protocol.md#server-side-conflict-journal) gives the wire shape.

:::tabs{group=lang}
```ts tab=TypeScript
// src/overwrite-events.ts
import { EEngineEventType } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

// The returned function unsubscribes.
export function watchOverwrites(): () => void {
  return kizunasync.on((event) => {
    if (event.type === EEngineEventType.COLUMN_OVERWRITTEN) {
      // event.table, event.pk, event.column, event.loserValue, event.winnerMutationId
    }
  })
}
```

```swift tab=Swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

// The returned function unsubscribes.
func watchOverwrites(
  _ showConflict: @escaping @Sendable (_ table: String, _ pk: String, _ column: String, _ loserValueJson: String) -> Void
) async throws -> @Sendable () -> Void {
  try await kizunasync.on { event in
    guard case let .columnOverwritten(table, pk, column, loserValueJson, _, _) = event else { return }
    showConflict(table, pk, column, loserValueJson)
  }
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
package com.example.todo

import com.kizunasync.kizunasync.KizunaSyncEngineEvent

// The returned function unsubscribes.
suspend fun watchOverwrites(
    showConflict: (table: String, pk: String, column: String, loserValueJson: String) -> Unit,
): () -> Unit = kizunasync.on { event ->
    if (event is KizunaSyncEngineEvent.ColumnOverwritten) {
        showConflict(event.table, event.pk, event.column, event.loserValueJson)
    }
}
```
:::

You should now see one `COLUMN_OVERWRITTEN` event on the winning device, naming the column and the value the write replaced.

That event is fire-and-forget, so a device that was not listening at the time still has the durable side: [`kizunasync.overwrites()`](../reference/javascript/overwrites.md) reads the same information back from local storage, newest first, and [`dismissOverwrite(id)`](../reference/javascript/dismiss-overwrite.md) acknowledges one entry. [React: useOverwrites](../reference/react/use-overwrites.md) and [Vue: useOverwrites](../reference/vue/use-overwrites.md) wrap both calls for a component that lists what a peer replaced.

## 5. Keep character-level text in an insert-only child table

Kizuna transports bytes and does not merge text, so there is no `@kizunasync/yjs` package and no `conflict: 'yjs'` table mode. Two people typing in one `text` column resolve as one assign replacing another, which loses a sentence rather than blending it.

Model the shared document as an insert-only child table instead. Each device [inserts](../reference/javascript/insert-data.md) its own row, distinct primary keys never contend, and a client codec such as [Yjs](https://grokipedia.com/page/Yjs) or Loro merges the rows after they arrive.

```ts
// src/note-updates.ts
import { kizunasync } from './kizunasync'

// encodedUpdate is the codec's binary update as a base64 string: a column value is a string, number, boolean, null, or array.
export async function saveNoteUpdate(noteId: string, encodedUpdate: string): Promise<void> {
  await kizunasync.from('note_updates').insert({
    note_id: noteId,
    update_id: crypto.randomUUID(),
    bytes: encodedUpdate,
  })
}
```

You should now see one row per device in `note_updates` after several devices write at once, and no rejection on any of them.

## 6. Verify it worked

Run the counter case end to end with two clients on one row:

1. Give the row a numeric column with a known value, for example `likes` at `0`, and let both clients pull it.
2. Take both clients offline and call `update({ likes: increment(1) })` on each. [`getOutboxDepth()`](../reference/javascript/outbox-depth.md) should now report one entry more on each client.
3. Bring both back online and let each finish a [`sync()`](../reference/javascript/sync.md). `getOutboxDepth()` should now report zero on each client.
4. Read the row from either client with `kizunasync.from('todos').select('likes').eq('id', todoId).single()`.

That read should now return `likes` at `2` rather than `1`, because each device sent a delta and the arbiter applied both. You should also see no `COLUMN_OVERWRITTEN` event for `likes` on either client. A transform overwrites nothing, so the journal never records one. Reading `kizunasync._conflict_journal` directly takes `service_role`, so the event stream is the check an application can run for itself.

## What these fields do not promise

- Merging of two writes to the same column. One value replaces the other, and Kizuna provides no same-column multi-value merge or [CRDT](https://grokipedia.com/page/Conflict-free_replicated_data_type) semantics, a choice [Design trade-offs](../resources/design-tradeoffs.md#server-arbitration-instead-of-general-crdt-merge) sets out.
- A CRDT counter. `increment` is a delta the arbiter applies, and an assign to that column discards the running total.
- An observed-remove set. `arrayUnion` and `arrayRemove` carry no per-member add-ids.
- Anything beyond the [Consistency model](./consistency-model.md). That page carries the whole promise: [causal+ consistency to checkpoints](../resources/glossary.md#causal-to-checkpoints), the four session guarantees per device, and column-level last-writer-wins.

A stuck outbox does not hide independent remote rows. Pending mutations replay over the incoming checkpoint, so other people's columns stay visible underneath your unsent edits.

## Next steps

- [Offline writes](./offline-writes.md): the outbox, the checkpoint replay, and the rejection events.
- [Sync rules and buckets](./sync-rules-and-buckets.md): the conflict journal and the pull `conflicts` array.
- [Conflict resolution](./conflict-resolution.md): arrival mode, HLC mode, and the journal.
- [Using transforms](../reference/javascript/using-transforms.md): `increment`, `arrayUnion`, and `arrayRemove` in the JavaScript reference.
- [Swift: Using transforms](../reference/swift/using-transforms.md): the same `transforms` map on `KizunaSyncClient.apply`.
