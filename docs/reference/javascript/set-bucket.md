---
title: Set bucket
description: Fill the runtime value of a byColumn bucket that every pull and push request carries.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Set bucket

`setBucket(params)` fills the value of a `byColumn` [bucket](../../resources/glossary.md#bucket), the partition the app picks at runtime, such as the workspace a user opens. Each bucket column starts empty, and a [pull](../../resources/glossary.md#pull) with an empty one fails rather than asking the server for an unpartitioned page. A `byOwner` bucket needs no call, because the engine fills it with the signed-in user.

## Examples

### Declare a runtime bucket

```ts
// src/kizunasync.ts
import { byColumn, defineConfig } from '@kizunasync/core'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byColumn('workspace_id') } },
})

export const kizunasync = createSupabaseKizunaSync({ supabase, driver: createWebWorkerDriver('todos.db'), config })
```

### Open a workspace

```ts
// src/workspace.ts
import { kizunasync } from './kizunasync'

export async function openWorkspace(workspaceId: string): Promise<void> {
  kizunasync.setBucket({ workspace_id: workspaceId })
  await kizunasync.sync()
}
```

The `sync()` call pulls the workspace's rows right away instead of at the next poll.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `params` | `TBucketParams` | Yes | A map of bucket column to its value, as `Record<string, boolean \| number \| string>`. A key that no configured table declares as a bucket column is refused with `BUCKET_UNSET` on the next engine call, naming the key and the columns that are configured. A column the map omits keeps the value it already had. |

`byColumn()` and `byOwner()` on [Define config](./define-config.md#parameters) name the bucket columns, and this method is for the `byColumn` kind. It accepts an owner column as well, but the engine overwrites that value with the owner once the store records one, and again at every later open.

## Returns

`void`, applied synchronously. The value is forwarded through the engine's command queue, so a pull issued right after this call cannot overtake it. The values it stores change two things.

| Name | Type | Required | Description |
|---|---|---|---|
| Pull buckets | `TBucket[]` | — | Every later pull carries one bucket per configured table with these equalities, which is what scopes the page the server returns. |
| Tombstone delivery | — | — | Scoped by the same bucket, so a row that leaves the bucket is not announced as a deletion. |

## Errors

A value the engine refuses surfaces as `BUCKET_UNSET` on the next engine call rather than on this one, because the call is queued behind the engine's other work. The message tells the two cases apart:

| Condition | Message |
|---|---|
| A key names a column no table declares as a bucket column. | `set_bucket: "<key>" is not a configured bucket column (configured: "<col>", "<col>")`, listing every configured bucket column, or `(configured: none)` when no table declares one. No parameter changes. |
| A `byColumn` column was never supplied a value. | `bucket unset`, raised by the next pull. The message names neither the column nor the table. |

[Troubleshooting](../../operations/troubleshooting.md#bucket_unset) shows the fix for both.

This call opens the engine when it is the app client's first use. When that open fails, on this call or an earlier one, this method throws the open's typed error, such as `ENGINE_UNAVAILABLE` or `STORE_BUSY`.

## Notes

The engine fills a `byOwner` bucket by itself. The first token the app client hands the engine records the store's owner, the user that token names, and every `byOwner` column takes that user's id. After a restart the engine fills the column at open from the owner the store kept, with no token and no network needed. A token of another user soft-blocks sync with `identity_changed` until [Reset](./reset.md) runs, so switching accounts on one device goes through a reset.

A `byColumn` value is not restored when the client opens, so set it on every launch before the first pull needs it. A pull that runs earlier fails with `BUCKET_UNSET`, and the automatic loop retries it on its next attempt.

A value that differs from the one a table already kept, and is not empty, replaces the local scope: the next pull re-bootstraps the table from the beginning, and its boundary drops the rows the new scope does not carry. Queued writes stay in the outbox and push under the new scope regardless, and no remote attachment is deleted. Filling a key the table keeps no value for yet, passing `''`, or passing the value it already kept replaces nothing. The kept value survives a restart, so reopening the same workspace after a reload re-bootstraps nothing. Switching workspaces inside one session therefore needs no separate reset.

A table provisioned without a bucket column is unpartitioned: the request carries an empty parameter map and server [Row Level Security](https://grokipedia.com/page/Row-level_security) alone decides visibility, under the [policies](https://supabase.com/docs/guides/database/postgres/row-level-security#select-policies) the project declares. A table provisioned with a bucket column refuses an unscoped pull with `KZL01`. [Sync rules and buckets](../../sync/sync-rules-and-buckets.md#3-choose-the-right-bucket-helper) compares the three shapes.

## Related reference

- [Define config](./define-config.md)
- [Sync](./sync.md)
- [Pull once](./pull-once.md)
- [Reset](./reset.md)
- [Swift: Set bucket](../swift/set-bucket.md)
- [Kotlin: Set bucket](../kotlin/set-bucket.md)
