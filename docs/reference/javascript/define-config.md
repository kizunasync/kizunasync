---
title: Define config
description: Declare synced tables and sync options.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Define config

`defineConfig(input)` resolves the client sync configuration: it applies every documented default and returns a plain `TKizunaSyncConfig` value. Table keys and column names are typed against the generated supabase-js `Database`, so a typo is a compile error rather than a silent no-op at runtime.

## Examples

### Basic

```ts
// src/kizunasync.ts
import { attachment, byOwner, defineConfig } from '@kizunasync/core'
import type { Database } from './database.types'

export const config = defineConfig<Database>({
  tables: {
    todos: {
      sync: 'read-write',
      bucket: byOwner('user_id'),
      attachments: { image_path: attachment('todo-images') },
    },
  },
  pullLimit: 500,
})
```

`byOwner('user_id')` needs no further call: the engine fills that bucket with the signed-in user, and an insert that leaves `user_id` out gets the same value.

### A tenant column filled at runtime

```ts
// src/kizunasync.ts
import { byColumn, defineConfig } from '@kizunasync/core'

export const config = defineConfig({
  tables: {
    todos: { sync: 'read-write', bucket: byColumn('workspace_id') },
    todo_templates: { sync: 'pull-only' },
  },
})
```

`byColumn` leaves the value empty until [`setBucket`](./set-bucket.md#parameters) supplies it. [Sync rules and buckets](../../sync/sync-rules-and-buckets.md#2-write-your-first-config) walks the same config in a running project.

### A composite key

```ts
// src/kizunasync.ts
import { defineConfig } from '@kizunasync/core'

export const config = defineConfig({
  tables: {
    todos: { sync: 'read-write' },
    todo_tags: { sync: 'read-write', key: ['todo_id', 'tag'] },
  },
})
```

The pair `(todo_id, tag)` names each `todo_tags` row, so every insert into that table passes both columns. [Row keys](../../sync/sync-rules-and-buckets.md#row-keys) covers the column types a key accepts and why a table devices create rows in suits a uuid key.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `input.tables` | `{ [table]: ITableConfig }` | Yes | One entry per synced table. A table absent from this map is invisible to the client: `from()` on it throws `UNKNOWN_TABLE`. |
| `input.tables.<name>.sync` | `'read-write' \| 'pull-only'` | Yes | `'read-write'` syncs both directions. `'pull-only'` continues to pull; the kernel refuses every local write to the table at the builder, before it reaches the outbox, with `LOCAL_UNSUPPORTED` naming the table, and the server's own rule is the backstop for a client that ships without this field. |
| `input.tables.<name>.key` | `string \| readonly string[]` | No | The table's primary-key columns in key order. Their values name each row on the device and on the server, so the list matches the primary key `kizunasync sync` records for the table. [Row keys](../../sync/sync-rules-and-buckets.md#row-keys) lists the column types a key accepts. A table with attachment columns keeps `'id'`. Default: `'id'`. |
| `input.tables.<name>.bucket` | `TBucketSpec` | No | The partition column, declared with `byOwner(column)` or `byColumn(column)`. Default: no bucket, so the request is unpartitioned and server [Row Level Security](https://grokipedia.com/page/Row-level_security) alone defines visibility, valid only on a table provisioned without a bucket column; a table provisioned with one refuses an unscoped pull with `KZL01`. |
| `input.tables.<name>.attachments` | `{ [column]: TAttachmentSpec }` | No | Columns that hold an attachment reference, declared with `attachment(storageBucket, options?)`. Default: none, and the engine skips every queue branch for the table. |
| `input.tables.<name>.conflict` | `'arrival' \| 'hlc'` | No | Column [last-writer-wins](../../resources/glossary.md#column-last-writer-wins-column-lww) keyed on server arrival order, or on the origin clock the engine attaches to each mutation. Default: `'arrival'`. |
| `input.tables.<name>.softDelete` | `string` | No | The column that carries the deletion marker. When set, [`delete()`](https://supabase.com/docs/reference/javascript/delete#parameters) on the table stamps that column with the engine's own clock and queues the matching update, instead of a hard delete: the row stays in the local store, excluded from a default read or write target until [`includeDeleted()`](./using-filters.md#parameters) asks for it back. Default: none, so deletes write a tombstone. |
| `input.pullLimit` | `number` | No | Maximum rows and tombstones the client asks for per pull page. Default: `500`. |
| `input.realtimeWakeups` | `boolean` | No | When false, no doorbell is built and an explicit `wakeup` is dropped as well, which leaves the poll and the foreground signal as the recovery paths. Default: `true`. |
| `input.pollIntervalMs` | `number` | No | Jittered poll fallback in milliseconds. Set here it wins over the same option on [Initializing](./initializing.md#parameters); `0` arms no timer. Default: absent, so the client applies `15000`. |
| `input.schemaVersion` | `number` | No | The schema version this client stamps on every pull and push, and the value a server `min_schema_version` gate compares against. Set here it wins over the same option on [Initializing](./initializing.md#parameters), the same precedence `pollIntervalMs` follows. Default: absent, so the client applies `1`. |
| `input.attachmentAttempts` | `number` | No | How many transfer attempts one attachment gets before the queue stops it for good: the row lands `failed` with `permanent` set, no drive claims it again, and only [`attachments.retry(ref)`](./attachment-retry.md) puts it back. Default: absent, so the kernel applies its own budget of `5`. |

Helpers that build the values above:

| Name | Type | Required | Description |
|---|---|---|---|
| `byOwner(column)` | `(column: string) => TBucketSpec` | — | Marks the bucket as the owner of the local database: the user named by the first session token the client hands the engine, which the engine keeps in the database across restarts. The engine fills the bucket with that user, and fills `column` on an insert that leaves it out, so the app never calls `setBucket` for it. Before any session has reached the client the bucket stays unset. `column` cannot be `id`, because the owner never fills a primary key. `kizunasync init` reads the owner equality from the table's Row Level Security policy. |
| `byColumn(column)` | `(column: string) => TBucketSpec` | — | Marks the bucket as a runtime-parameterized column, such as a workspace id, whose value only the app knows and [`setBucket`](./set-bucket.md#parameters) fills. |
| `attachment(storageBucket, options?)` | `(storageBucket: string, options?: { ownerColumn?: string }) => TAttachmentSpec` | — | Maps the column to a [Storage](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading) bucket. `ownerColumn` is the row column the object key derives from; when omitted a `byOwner` bucket's column is used, otherwise the client throws at construction. |

## Returns

`TKizunaSyncConfig`, the value [`createKizunaSync` and `createSupabaseKizunaSync`](./initializing.md) consume.

| Name | Type | Required | Description |
|---|---|---|---|
| `tables` | `Record<string, IResolvedTableConfig>` | — | Each entry carries `sync` and `conflict` explicitly, plus `bucket`, `attachments`, and `softDelete` when they were declared, and `key` as a list of column names when it was declared, so `'slug'` resolves to `['slug']`. An entry without `key` is keyed by `id`. |
| `pullLimit` | `number` | — | Always present, defaulted to `500`. It becomes the engine's default page limit. |
| `realtimeWakeups` | `boolean` | — | Always present, defaulted to `true`. |
| `pollIntervalMs` | `number \| undefined` | — | Left absent when omitted, so an undeclared interval never reads as a deliberate `0`. |
| `schemaVersion` | `number \| undefined` | — | Left absent when omitted, so [`createKizunaSync`](./initializing.md#returns) applies its own default of `1`. |
| `attachmentAttempts` | `number \| undefined` | — | Left absent when omitted, so the kernel applies its own transfer budget. |

## Errors

`defineConfig` performs no runtime validation and throws nothing. The compiler checks the table and column names against `Database`. A configuration mistake surfaces later instead, when [`createKizunaSync`](./initializing.md#errors) builds the client: `ATTACHMENT_PORTS_MISSING` for missing attachment ports, and `CONFIG_INVALID` for a missing attachment owner column, an invalid `pullLimit`, `schemaVersion`, `pollIntervalMs`, `sync`, or `conflict` value, or a `clientId` that is not a uuid. A `byOwner` bucket on a key column, such as `byOwner('id')`, is refused with `CONFIG_INVALID` by the engine's own check, on the client's first use, and so is a `key` that is empty, holds something other than a column name, or repeats a column, or a `key` other than `'id'` on a table with attachment columns. Past those gates, a mistake surfaces where it bites: at [`from()`](./fetch-data.md) for an unconfigured table; at the builder as `LOCAL_UNSUPPORTED` for a write on a `pull-only` table; at [`setBucket()`](./set-bucket.md#errors) for a key no table declares as a bucket column; and at pull time as `BUCKET_UNSET` for a `byColumn` bucket [`setBucket`](./set-bucket.md#errors) never filled, or a `byOwner` bucket before any session has reached the client.

## Notes

Each app passes its own `defineConfig` object to `createKizunaSync`, and the object stays on the client. Every field above is one the client itself reads. Server-only settings live on the server instead, in [`kizunasync._config`](../../cli/configuration.md) and `kizunasync._settings`, which [`kizunasync init`](../../cli/cli.md#kizunasync-init) and [`kizunasync sync`](../../cli/cli.md#kizunasync-sync) provision through migrations you review. Tombstone retention, the push policy, and the per-table conflict journal live only there, and `kizunasync sync` carries a flag for each.

Editing this object leaves an already-provisioned database as it stands. Run `kizunasync sync` when the synced set, a primary key, a bucket, a conflict mode, or a soft-delete column changes on the server.

## Related reference

- [Initializing](./initializing.md)
- [Set bucket](./set-bucket.md)
- [Attach a file](./from-file.md)
- [Create the Realtime wakeup](./create-realtime-wakeup.md)
