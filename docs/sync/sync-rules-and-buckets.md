---
title: "Sync rules & buckets"
description: Control which rows reach which device by declaring buckets in your client config.
status: alpha
docType: how-to
audience: app-developer
---

# Sync rules & buckets

Give a table a [bucket](../resources/glossary.md#bucket) column and a device pulls only the rows that match it, never the rest of the table.

You declare the bucket, the sync mode, and the per-table options in the config you create the app client with, then check the result with `kizunasync doctor`.

## Before you begin

- You have completed the [Quick start](../getting-started/quickstart.md) and have the app client wired into your app.
- `kizunasync init` has provisioned the SQL pack into your Supabase project (`supabase/migrations/`). See the [CLI](../cli/cli.md).
- You understand that Row Level Security is your security layer and that buckets are a selection layer on top of it.

## 1. Understand the two layers

Security is Row Level Security. The public RPC wrappers are `SECURITY DEFINER`, so the private ledgers stay unreachable. They hand every application-row read and write to `kizunasync_rls`, a `NOBYPASSRLS` role that carries the caller's [JWT](https://grokipedia.com/page/JSON_Web_Token) context. [Grants and security](../reference/sql-pack.md#grants-and-security) lists that boundary object by object. A bucket never grants access past your table policies, because the delegate never holds the privilege Supabase describes in [Bypassing Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security).

Selection is the bucket: of the rows this user may see, which ones should live on this device. A bucket is one equality column, and each pull is scoped to rows whose bucket column matches the current bucket value. The SQL pack labels every tracked row change with the bucket value it carried at write time and indexes that label, so a pull of a bucketed table reads only the entries labeled with the values it requested rather than scanning the whole change history. Rows outside the bucket are never fetched, and they stay on the server until you change the bucket.

Two consequences follow from declaring the bucket as a column:

- You cannot express a rule like "rows whose linked project's team contains me", because buckets are declared columns rather than arbitrary predicates. Model a denormalized owner or tenant column, or use a managed sync architecture whose server computes row membership for you.
- A row that changes bucket membership reaches its new owner on that device's next pull, and it leaves its old bucket a [tombstone](../resources/glossary.md#tombstone), so a device that pulls only the old value drops its stale copy on that same next pull. A device that pulls both values keeps the row throughout. Reassigning a record does not push it anywhere immediately.

You should now be able to name, for every table you plan to sync, the policy that authorizes its rows and the column that selects them.

## 2. Write your first config

[`defineConfig`](../reference/javascript/define-config.md) is the authoring surface, type-checked against the `Database` type that [`supabase gen types`](https://supabase.com/docs/guides/api/rest/generating-types) writes to `src/database.types.ts`, and its reference page carries the full field tables. The config lives in `src/kizunasync.ts`, the module that creates the app client once:

```ts
// src/kizunasync.ts
import { byColumn, byOwner, defineConfig } from '@kizunasync/core/config'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import type { Database } from './database.types'
import { supabase } from './supabase-client'

export const config = defineConfig<Database>({
  tables: {
    todos: {
      sync: 'read-write',
      bucket: byOwner('user_id'),            // pulls only this user's rows
    },
    boards: {
      sync: 'read-write',
      bucket: byOwner('created_by_user_id'), // auto-detected by kizunasync init from your RLS
    },
    workspace_items: {
      sync: 'read-write',
      bucket: byColumn('workspace_id'),      // filled at runtime with kizunasync.setBucket(...)
    },
    catalogs: { sync: 'pull-only' },         // reference data: cached locally, never pushed
  },
})

export const kizunasync = createSupabaseKizunaSync({ supabase, driver: createWebWorkerDriver('todos.db'), config })
```

Import the helpers from `@kizunasync/core/config` or `@kizunasync/core`, not from `@kizunasync/web`, `@kizunasync/expo`, or a driver package. Your editor should now report a typo in a table or column name as a compile error.

## 3. Choose the right bucket helper

### `byOwner(column)`

Use [`byOwner`](../reference/javascript/define-config.md#parameters) when rows belong to the signed-in user and your policies follow the [`auth.uid()`](https://supabase.com/docs/guides/database/postgres/row-level-security#authuid) shape Supabase documents for policy helpers. Review every bucket `kizunasync init` proposed before you keep it.

`kizunasync init` infers those buckets from your policy text with a deliberately limited heuristic, and it labels each proposal `[auto]`. The interactive wizard lets you replace a proposal. A scripted `kizunasync sync --add` provisions a pull-only table with no bucket, and it never guesses an owner. Pass `--sync` and `--bucket-column` when you want something else.

The engine fills a `byOwner` bucket by itself, so your app never calls `setBucket` for it. When the first session token reaches the app client, the engine records that token's user as the owner of the local store and scopes the table's pull to that user's rows. The store keeps the owner across restarts. An insert that leaves the owner column out is written with the owner's id, offline too. Each app client declares the bucket in its own config:

:::tabs{group=lang}
```ts tab=TypeScript
// src/kizunasync.ts (excerpt)
import { byOwner, defineConfig } from '@kizunasync/core/config'
import type { Database } from './database.types'

export const config = defineConfig<Database>({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})
```

```swift tab=Swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync

let tables = ["todos": KizunaSyncTableConfig(bucket: .byOwner("user_id"))]
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
package com.example.todo

import com.kizunasync.kizunasync.KizunaSyncBucket
import com.kizunasync.kizunasync.KizunaSyncTableConfig

val tables = mapOf("todos" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByOwner("user_id")))
```
:::

A different user signing in on the same device soft-blocks sync with `identity_changed` until [`reset()`](../reference/javascript/reset.md) runs, so writes queued under one user never go out under another. The reset also clears the owner, and the next sync fills the bucket with the user who is signed in. [Sync soft-blocks after switching accounts](../operations/troubleshooting.md#sync-soft-blocks-after-switching-accounts) covers the account switch.

You should now see a pull of a `byOwner` table succeed right after sign-in with no `setBucket` call in your code.

### `byColumn(column)`

Use [`byColumn`](../reference/javascript/define-config.md#parameters) for workspace or tenant scoping, where the active scope is a runtime choice rather than the signed-in identity. The column value comes from your app, through [`setBucket`](../reference/javascript/set-bucket.md) with a map of bucket column to value:

:::tabs{group=lang}
```ts tab=TypeScript
// src/switch-workspace.ts
import { kizunasync } from './kizunasync'

export function switchWorkspace(workspaceId: string): void {
  kizunasync.setBucket({ workspace_id: workspaceId })
}
```

```swift tab=Swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync

let tables = ["workspace_items": KizunaSyncTableConfig(bucket: .byColumn("workspace_id"))]

func switchWorkspace(to workspaceId: String) async throws {
  try await kizunasync.setBucket(["workspace_id": workspaceId])
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
package com.example.todo

import com.kizunasync.kizunasync.KizunaSyncBucket
import com.kizunasync.kizunasync.KizunaSyncTableConfig

val tables = mapOf("workspace_items" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByColumn("workspace_id")))

suspend fun switchWorkspace(workspaceId: String) {
    kizunasync.setBucket(mapOf("workspace_id" to workspaceId))
}
```
:::

A pull of a `byColumn` table that runs before the first `setBucket` call should now fail with [`BUCKET_UNSET`](../operations/troubleshooting.md#bucket_unset) rather than returning an empty result.

Calling `setBucket` with a value that differs from the one a table already kept replaces the local scope: the next pull re-bootstraps every synced table and the local snapshot ends up holding only the new value's rows. Queued outbox writes stay, and no remote attachment is deleted. Filling in a bucket for the first time, or repeating the value already kept, arms no rehydration. An app that switches tenants can therefore call `setBucket` on its own client and let the next sync replace the dataset, or isolate databases or clients up front when it would rather never hold two tenants' rows in the same store at once.

### No bucket

Omitting `bucket` sends an empty parameter map. That is valid only for a table provisioned without a bucket column: the pull then syncs every row your policies permit, and every delete, table-scoped. A table provisioned with a bucket column refuses an unscoped pull with `KZL01`, so declare `bucket: byOwner(...)` or another bucket matching the provisioned column instead.

```ts
// src/kizunasync.ts (excerpt)
import { defineConfig } from '@kizunasync/core/config'
import type { Database } from './database.types'

export const config = defineConfig<Database>({
  tables: {
    todos: { sync: 'read-write' }, // no bucket: todos is provisioned without a bucket column
  },
})
```

The example apps' `todos` table is provisioned without a bucket column, which is why they omit `bucket` here. Their RLS policies make `todos` a shared board: every visitor reads every row, and writes stay owner-scoped except for anonymous-owned rows, which any visitor can edit.

## 4. Set the sync mode

Every table entry requires a `sync` field:

| Value | Behavior |
|---|---|
| `'read-write'` | Enables the local [outbox](../resources/glossary.md#outbox). Local writes queue offline and push when connected. |
| `'pull-only'` | A read-only local cache. `kizunasync.from(table)`'s `insert`, `update`, and `delete` refuse at the builder with `LOCAL_UNSUPPORTED`, naming the table, before anything reaches the outbox. A push that somehow targets the table anyway is refused server-side as a [request-level outcome](./server-side-validation.md#request-level-outcomes), not as a per-mutation verdict, which is the backstop for a client shipped without this field. Your existing write paths keep going through supabase-js. |

Start every table at `pull-only`, confirm the local reads work, then move user-owned tables to `read-write` one at a time. You should now see rows for a `pull-only` table appear in the local database while writes continue through your existing path.

## 5. Add optional per-table fields

### Attachments

To sync file references through a column, declare an `attachments` map on the table. The column holds a storage reference string, and the bytes travel out of band through the attachment queue.

```ts
// src/kizunasync.ts (excerpt)
import { attachment, byOwner, defineConfig } from '@kizunasync/core/config'
import type { Database } from './database.types'

export const config = defineConfig<Database>({
  tables: {
    boards: {
      sync: 'read-write',
      bucket: byOwner('created_by_user_id'),
      attachments: {
        cover: attachment('board-images', { ownerColumn: 'created_by_user_id' }),
      },
    },
  },
})
```

[`attachment(storageBucket, { ownerColumn })`](../reference/javascript/define-config.md#parameters) maps the column to a Supabase Storage bucket, which the transfer port fills with [standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads) for small objects and a resumable session for large ones. `ownerColumn` is the row column whose value owns the object, because the storage key derives from it. A table that uses `byOwner` can omit `ownerColumn` and the engine takes it from the bucket column. Once any table declares attachments, the app client needs both the `fileStore` and `transfer` ports, and creating it without them throws `ATTACHMENT_PORTS_MISSING`. See [Media attachments](../attachments/media-and-attachments.md).

### Conflict resolution

The `conflict` field sets how the server resolves a concurrent edit to one column:

| Value | Behavior |
|---|---|
| `'arrival'` | Column-level [last-writer-wins](../resources/glossary.md#column-last-writer-wins-column-lww) by server arrival order. The default. Server-authoritative, and it trusts no client clock. |
| `'hlc'` | Column-level last-writer-wins by origin [HLC](../resources/glossary.md#hybrid-logical-clock-hlc) timestamp. Preserves origin order across offline clients, and trusts device clocks inside the drift bound. |

Both modes sit under the [delete-wins](./conflict-resolution.md#deletes) invariant. [Conflict resolution](./conflict-resolution.md) covers what each one does to a contested column.

Pass `kizunasync sync --conflict-journal`, or answer the wizard's journal question, to record overwritten column values in [`kizunasync._conflict_journal`](../reference/sql-pack.md#kizunasync_conflict_journal). The switch is the `conflict_journal` column of [`kizunasync._config`](../cli/configuration.md#kizunasync_config), and it defaults to `false`.

The journal keeps the replaced values the caller's policies let that caller see. Pull attaches the matching journal rows as an optional `conflicts` array, omitted when empty. The engine persists `_kizunasync_overwrites` and emits `COLUMN_OVERWRITTEN`. Authenticated clients have no `SELECT` on the journal, and `service_role` can read the audit rows. Increment and array transforms are never journaled. [Restore an overwritten assign](./collaborative-fields.md#4-restore-an-overwritten-assign-from-the-journal) shows the client side of the journal.

### Soft delete

A hard delete on a bucketed table leaves a [tombstone](../resources/glossary.md#tombstone) that reaches only a caller who already pulled a live row of the bucket it left, and that receipt is never revoked for age alone: a caller later removed from the bucket keeps receiving that bucket's deletions, and every member who shares the bucket receives the deleted primary key even for a row their own policies never let them read. Prefer `softDelete` over a hard delete on a table whose Row Level Security is finer than its bucket column, so a removal travels as an ordinary row update decided by your own policies instead.

Set `softDelete` to the column name that marks a row as deleted at the application level:

```ts
// src/kizunasync.ts (excerpt)
import { defineConfig } from '@kizunasync/core/config'
import type { Database } from './database.types'

export const config = defineConfig<Database>({
  tables: {
    notes: { sync: 'read-write', softDelete: 'deleted_at' },
  },
})
```

`kizunasync.from(table).delete()` then stamps that column with the engine's own clock and queues the matching update. It writes no [tombstone](../resources/glossary.md#tombstone). The row keeps its data, leaves the default read and write-target sets, and comes back with [`.includeDeleted()`](../reference/javascript/using-filters.md#parameters).

`SOFT_DELETE_VIOLATION` appears only on the low-level `apply` port, and only for a mutation with `op:'delete'`. The query builder never sends that operation for a table configured this way.

Your config should now carry an `attachments`, `conflict`, or `softDelete` entry on the tables that need one and nowhere else, and the server should carry the conflict journal for any table you turned it on for.

## 6. Configure top-level options

The [top-level fields](../reference/javascript/define-config.md#parameters) hold the options that apply across tables:

```ts
// src/kizunasync.ts (excerpt)
import { defineConfig } from '@kizunasync/core/config'
import type { Database } from './database.types'

export const config = defineConfig<Database>({
  tables: { /* ... */ },
  pullLimit: 500,          // rows and tombstones per pull page (default 500)
  realtimeWakeups: true,   // installs the wakeup port; correctness never depends on it
  pollIntervalMs: 30_000,  // jittered poll fallback interval in ms (default 15_000; 0 = off)
})
```

`pollIntervalMs` is the poll fallback that runs alongside Realtime [wakeups](../resources/glossary.md#wake-up). While the client process is active and able to schedule timers, it reschedules a `sync()` in `[pollIntervalMs/2, pollIntervalMs]`, so one missed wakeup costs freshness and nothing else. It is on by default because a Realtime channel can die on an expired token. The connectivity signal does not cover that case either, because it never fires when the link stays up but the route does not. Operating-system suspension can pause the timer regardless. Raise the interval to trade freshness for fewer requests, or set `0` to rely on wakeups plus your own [`sync()`](../reference/javascript/sync.md) calls.

`pullLimit` bounds a page by entry count alone. The server also stops a page once it has examined a set number of candidate rows, withheld ones (hidden by your policies, or outside the requested buckets) counted together with delivered ones, so a page can come back holding fewer entries than `pullLimit` while more still wait. That scan cap is a server-side setting rather than a client one, and [Configuration](../cli/configuration.md#kizunasync_settings) names the knob.

You should now see roughly one automatic sync per interval in your network log while the app is in the foreground, and none at all once you set `pollIntervalMs: 0`.

## 7. Verify it worked

The config you create the app client with is the client-side contract, and [`kizunasync._config`](../cli/configuration.md) is the server's. The two are declared separately, so editing the TypeScript alone leaves an already-provisioned database as it was.

Run [`kizunasync sync`](../cli/cli.md#kizunasync-sync) to move the server, then review the migration it emits, the same review Supabase recommends for any change in [Database migrations](https://supabase.com/docs/guides/deployment/database-migrations). [What Kizuna installs](../cli/whats-installed.md) describes the objects that migration creates.

`doctor` checks the project shape and the synced-table count rather than semantic agreement with your table policies.

:::tabs{group=pm}
```bash tab=npm
npx kizunasync doctor
npx kizunasync doctor --ci
```

```bash tab=pnpm
pnpm dlx kizunasync doctor
pnpm dlx kizunasync doctor --ci
```

```bash tab=yarn
yarn dlx kizunasync doctor
yarn dlx kizunasync doctor --ci
```

```bash tab=bun
bunx kizunasync doctor
bunx kizunasync doctor --ci
```
:::

You should now see [`kizunasync doctor`](../cli/cli.md#kizunasync-doctor) report the tables you declared. The engine's local store keeps generic table-name and primary-key bookkeeping rather than generated local DDL per application table.

## Common errors

- [`BUCKET_UNSET`](../operations/troubleshooting.md#bucket_unset) means a `byColumn` table was pulled before `kizunasync.setBucket(...)` filled it, or `setBucket` carried a key no table declares as a bucket column. A `byOwner` table reports it only while no user has signed in on the device, because the engine fills that bucket from the first session.
- `LOCAL_UNSUPPORTED` on insert, update, or delete means the table's `sync` is `'pull-only'`. Route the write through your existing supabase-js path instead.
- [`ATTACHMENT_PORTS_MISSING`](../operations/troubleshooting.md#attachment_ports_missing) means a table declares `attachment(...)` and the app client was created without both the `fileStore` and `transfer` ports. Pass both once any table uses attachments.
- Table missing from config means `kizunasync.from(table)` throws `UNKNOWN_TABLE` when the table is absent from the config the app client was created with.

## Next steps

- [Configuration](../cli/configuration.md): the `kizunasync._config` and `kizunasync._settings` columns `kizunasync init` and `kizunasync sync` write on the server.
- [Media and attachments](../attachments/media-and-attachments.md): wiring the `fileStore` and `transfer` ports and using `kizunasync.attachments.fromFile(...)`.
- [Collaborative fields](./collaborative-fields.md): increment, arrayUnion and arrayRemove, and the conflict journal.
- [Offline writes](./offline-writes.md): the outbox lifecycle, verdicts, and the `kizunasync.on(...)` event stream.
- [CLI](../cli/cli.md): `kizunasync init`, `kizunasync lint`, and `kizunasync doctor` in detail.
