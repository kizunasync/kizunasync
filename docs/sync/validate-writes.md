---
title: Validate writes
description: Build RLS, a constraint, and a trigger for one table, and read the rejections they produce from your app.
status: alpha
docType: how-to
audience: app-developer
---

# Validate writes

Build one `projects` table where members may edit only their own rows and archived rows refuse further edits, then read what the server rejects from your app.

## Before you begin

- A synced Supabase project. See the [Quick start](../getting-started/quickstart.md) if you are starting from scratch.
- The app client already wired up in your app, exported as `kizunasync` from `src/kizunasync.ts`.
- The hook packages are `@kizunasync/react` (React, Expo, and React Native) and `@kizunasync/vue`. Mount `KizunaSyncProvider`, `provideKizunaSync`, or `createKizunaSyncPlugin` above those hooks. See [React](../getting-started/react.md), [Expo / React Native](../getting-started/expo.md), and [Vue](../getting-started/vue.md).
- Swift and Kotlin apps call `rejections()` and `dismissRejection` on the app client, `kizunasync`, once a push has brought the verdict back, for example on a `MUTATION_REJECTED` event from `on`. The app's `syncScheduler` runs that push after the local write. Compensated rows are already in [local SQLite](https://grokipedia.com/page/SQLite). See [Swift and Kotlin](../getting-started/native-clients.md).
- Svelte, Solid, Angular, and every other JavaScript UI drive the app client directly through the Vanilla / other tab. There is no `@kizunasync/svelte` package.

## 1. Restrict edits to the owning member with RLS

Add a `projects` table synced by `owner_id`, and a policy that lets a member update only their own rows.

Supabase documents that policy shape in [UPDATE policies](https://supabase.com/docs/guides/database/postgres/row-level-security#update-policies). Kizuna changes nothing about it, and the same policy decides a queued write on its way in.

```sql
-- supabase/migrations/20260928120000_projects_policies.sql
create policy "members edit their own projects"
  on public.projects for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
```

A member who edits a project they do not own gets a clean rejection. Say device B holds a cached copy of a project it owned earlier, loses that ownership through a transfer to another member, and edits the row while offline:

```ts
// src/projects.ts
import { kizunasync } from './kizunasync'

// Device B calls renameProject(projectId, 'renamed') while offline
export async function renameProject(projectId: string, name: string): Promise<void> {
  await kizunasync.from('projects').update({ name }).eq('id', projectId)
}
```

On reconnect [`kizunasync.push`](../reference/sql-pack.md#kizunasyncpush), an ordinary [Postgres](https://grokipedia.com/page/PostgreSQL) function the client reaches through [`rpc`](https://supabase.com/docs/reference/javascript/rpc), runs an `UPDATE` that affects zero rows, because the policy blocked it. The [verdict](../resources/glossary.md#verdict) comes back like this:

```json
{
  "mutation_id": "f1000000-0000-4000-8000-000000000011",
  "verdict": "rejected",
  "reason": "RLS_DENIED",
  "server_row": null
}
```

A `null` `server_row` means the row is deleted or invisible to this member. The engine then deletes the local row, writes a no-resurrection shadow for that key, journals the rejection, and emits `MUTATION_REJECTED` through [`kizunasync.on`](../reference/javascript/on.md). The edit reached the server and the server turned it away, which is the shape every server-side rule takes in an offline-first app. [Server-side validation](./server-side-validation.md) walks that path step by step.

## 2. Add a CHECK constraint

```sql
-- supabase/migrations/20260928120100_projects_budget_constraint.sql
alter table public.projects
  add constraint projects_budget_non_negative check (budget >= 0);
```

Make an offline edit that would violate it:

```ts
// src/projects.ts (excerpt)
import { kizunasync } from './kizunasync'

export async function cutBudget(projectId: string, currentBudget: number): Promise<void> {
  await kizunasync.from('projects').update({ budget: currentBudget - 10_000 }).eq('id', projectId)
}
```

Reconnect and watch what happens. `check_violation` carries SQLSTATE `23514`, which sits in class 23, one of the classes the server catches around each individual mutation. The push RPC itself therefore succeeds, and the other mutations in this non-atomic push can apply. The budget update comes back rejected with reason `CONSTRAINT`, one of the six [rejection reasons](../reference/protocol.md#rejection-reasons):

```json
{
  "mutation_id": "f1000000-0000-4000-8000-000000000021",
  "verdict": "rejected",
  "reason": "CONSTRAINT",
  "server_row": {
    "id": "9c112233-4455-4677-8899-aabbccddeeff",
    "owner_id": "b2000000-0000-4000-8000-000000000002",
    "name": "Q3 marketing",
    "budget": 5000,
    "archived_at": null
  }
}
```

The engine compensates the way it does for `RLS_DENIED` and `PRECONDITION`: it reverts the local row to the server's answer, journals the rejection, and emits `MUTATION_REJECTED`. `server_row` is the row's current server state rather than a snapshot of the rejected attempt. A mutation is one unit, so a rejected update applies none of its columns, including any the constraint does not cover. `useRejections()` surfaces it at once (see [step 4](#4-read-the-journal-in-the-app)), with no five-attempt wait and no dead letter.

The same rule can be expressed as a [precondition](../reference/javascript/update-data.md#with-a-precondition) instead. If your app already read the row before editing it, attach the value it read as a compare-and-set:

```ts
// src/projects.ts (excerpt)
import { kizunasync } from './kizunasync'

export async function cutBudgetIfUnchanged(projectId: string): Promise<void> {
  const { data: current } = await kizunasync.from('projects').select('budget').eq('id', projectId).maybeSingle()
  const budget = current?.budget

  if (typeof budget !== 'number') {
    throw new Error(`project ${projectId} is not in the local database`)
  }
  await kizunasync.from('projects').update(
    { budget: budget - 10_000 },
    { precondition: { budget } },
  ).eq('id', projectId)
}
```

Any concurrent change to `budget`, from any device and in any amount, fails that precondition inside the same push call and produces `rejected(PRECONDITION, server_row)`, the same shape the constraint produced.

A precondition catches the one column value you named, and only when your app read that value first. The constraint catches every path that could push `budget` negative, including a path you did not anticipate, at the cost of attempting the row write before the database can refuse it. Keep the constraint, and add a precondition or an [RLS](https://grokipedia.com/page/Row-level_security) clause wherever the same rule fits there, so the common rejection happens before the row mutation runs.

## 3. Add a backstop trigger for archived rows

Some rules have to hold against a write that never went through an app you control: a direct `psql` session, a script, or a future integration. Supabase covers the mechanism in [Trigger functions](https://supabase.com/docs/guides/database/postgres/triggers#trigger-functions), and the only Kizuna-specific part is which SQLSTATE you raise. Enforce "no edits to archived projects" as a trigger, and raise with a SQLSTATE in the same class a `CHECK` violation uses, so a refused edit gets a clean rejection instead of failing the whole push:

```sql
-- supabase/migrations/20260928120200_projects_archived_trigger.sql
create or replace function public.refuse_archived_edits() returns trigger as $$
begin
  if old.archived_at is not null then
    raise exception 'project % is archived and cannot be edited', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger projects_refuse_archived_edits
  before update on public.projects
  for each row execute function public.refuse_archived_edits();
```

Naming `check_violation` makes this trigger's refusal land exactly like step 2's constraint. The client gets a per-mutation `rejected(CONSTRAINT, server_row)` verdict inside the same push call, and the rest of a non-atomic batch is unaffected.

Leave the `USING ERRCODE` off and Postgres's default `RAISE EXCEPTION` raises SQLSTATE `P0001` instead. The pack catches that inside the same mutation boundary, alongside a class-22 data exception such as a value your column type refuses, and turns it into the same per-mutation `rejected(CONSTRAINT, server_row)` verdict step 2 produced; the rest of a non-atomic batch still applies. [Constraints and triggers](./server-side-validation.md#constraints-and-triggers) lists the full classification.

An error outside classes 22, 23, and exact `P0001`, or one the pack raises before your row is reached, still fails the whole push call. An unknown configured table takes that path, and so does a malformed batch, such as a mutation missing the [HLC](../resources/glossary.md#hybrid-logical-clock-hlc) an `hlc` table requires. Both remote adapters classify such a failure as permanent, which means they never retry it. The two adapters are the [`createRpcRemote`](../reference/javascript/create-rpc-remote.md) adapter from `@kizunasync/supabase` and the Rust HTTP remote in `kizunasync-remote-http`. When that failure repeats against the write it owns, it consumes the five-failure budget, records `PERMANENT_TRANSPORT`, and [dead-letters](../resources/glossary.md#dead-letter) that write; [Offline writes](./offline-writes.md#3-handle-a-rejection) covers how a wider batch narrows down to that one write first.

Raise any class-22 or class-23 SQLSTATE, or leave Postgres's `P0001` default, for an expected row-level validation outcome: the pack turns all three into the same per-mutation rejection. Reserve a different class for a failure that should abort the whole call instead.

## 4. Read the journal in the app

Every rejection, whatever caused it, lands in the same durable client-side journal that [`rejections()`](../reference/javascript/rejections.md) reads. [`useRejections()`](../reference/react/use-rejections.md) wraps it for React and re-runs on every rejection event:

:::tabs
```tsx tab=React
// src/components/project-rejections.tsx
import { useRejections } from '@kizunasync/react'

function ProjectRejections() {
  const { rejections, isLoading, error, dismiss } = useRejections()

  if (isLoading) {
    return null
  }
  if (error) {
    return <p>Could not read the rejection journal: {error.message}</p>
  }

  return (
    <ul>
      {rejections.map((r) => (
        <li key={r.mutationId}>
          {r.table} row {r.pk} was rejected ({r.reason.toLowerCase()}).
          <button onClick={() => dismiss(r.mutationId)}>Dismiss</button>
        </li>
      ))}
    </ul>
  )
}
```

```vue tab=Vue
<!-- src/components/ProjectRejections.vue -->
<script setup lang="ts">
import { useRejections } from '@kizunasync/vue'

const { rejections, isLoading, error, dismiss } = useRejections()
</script>

<template>
  <template v-if="isLoading" />
  <p v-else-if="error">Could not read the rejection journal: {{ error.message }}</p>
  <ul v-else>
    <li v-for="r in rejections" :key="r.mutationId">
      {{ r.table }} row {{ r.pk }} was rejected ({{ r.reason.toLowerCase() }}).
      <button @click="dismiss(r.mutationId)">Dismiss</button>
    </li>
  </ul>
</template>
```

```tsx tab="Expo/React Native"
// src/components/project-rejections.tsx
import { Pressable, Text, View } from 'react-native'
import { useRejections } from '@kizunasync/react'

function ProjectRejections() {
  const { rejections, isLoading, error, dismiss } = useRejections()

  if (isLoading) {
    return null
  }
  if (error) {
    return <Text>Could not read the rejection journal: {error.message}</Text>
  }

  return (
    <View>
      {rejections.map((r) => (
        <View key={r.mutationId}>
          <Text>
            {r.table} row {r.pk} was rejected ({r.reason.toLowerCase()}).
          </Text>
          <Pressable onPress={() => void dismiss(r.mutationId)}>
            <Text>Dismiss</Text>
          </Pressable>
        </View>
      ))}
    </View>
  )
}
```

```swift tab=Swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

// Call it after a MUTATION_REJECTED event from kizunasync.on, once the user has acknowledged the entry.
func dismissFirstRejection() async throws {
  let list = try await kizunasync.rejections()
  if let first = list.first {
    _ = try await kizunasync.dismissRejection(first.mutationId)
  }
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
package com.example.todo

// Call it after a MUTATION_REJECTED event from kizunasync.on, once the user has acknowledged the entry.
suspend fun dismissFirstRejection() {
    val list = kizunasync.rejections()
    list.firstOrNull()?.let { kizunasync.dismissRejection(it.mutationId) }
}
```

```ts tab="Vanilla / other"
// src/project-rejections.ts
import { EEngineEventType } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

// The app client alone: no framework binding required.
export async function dismissFirstRejection(): Promise<void> {
  const list = await kizunasync.rejections()
  // After the user acknowledges one:
  const first = list[0]

  if (first) {
    await kizunasync.dismissRejection(first.mutationId)
  }
}

// Or subscribe; the returned function unsubscribes.
export function watchRejections(refresh: () => void): () => void {
  return kizunasync.on((event) => {
    if (event.type === EEngineEventType.MUTATION_REJECTED || event.type === EEngineEventType.DEAD_LETTER) {
      refresh() // read kizunasync.rejections() again
    }
  })
}
```
:::

[`dismiss(mutationId)`](../reference/javascript/dismiss-rejection.md) acknowledges one entry. It stops appearing in the default `rejections()` read and stays queryable with `{ includeDismissed: true }`, because nothing in the journal is deleted for you. You should now see one entry per refused write, and the row back at the value the server holds.

The Swift and Kotlin tabs above use [Swift: List rejections](../reference/swift/rejections.md#returns) and [Kotlin: List rejections](../reference/kotlin/rejections.md#returns), whose Returns tables list the same fields.

## 5. Test it offline

Open your app with the network tab set to "Offline" in DevTools, make an edit a server rule will refuse (an edit to a project you do not own, for the RLS case above), then re-enable the network. The edit should apply locally at once, then revert to the server's state once the engine pushes, and appear in `useRejections()`.

For CLI-driven test data instead of manual edits, `kizunasync mock seed` and `kizunasync mock churn` (see the [CLI](../cli/cli.md#kizunasync-mock-test-tooling)) write deterministic rows and deterministic write churn to a synced table of your choice. Both write a fixed demo column shape (`id`, `user_id`, `title`, `done`, `image_path`), so point them at a table carrying those columns or write your own seed script for a table like `projects`. [Add failure cases](../operations/test-offline-behavior.md#5-add-failure-cases) shows the headless alternative: a fake `IProtocolRemote` you script to return one specific rejection, so the whole flow runs in a test with no device and no network.

## Next steps

- [Server-side validation](./server-side-validation.md): the full verdict taxonomy and how the client compensates.
- [Offline writes](./offline-writes.md): the outbox, `useSyncStatus`, and every rejection event in one place.
- [Test offline behavior](../operations/test-offline-behavior.md): deterministic headless tests for offline flows, including rejections.
