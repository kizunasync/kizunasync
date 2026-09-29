---
title: Reset
description: Wipe every local sync table and start again from the bootstrap cursor.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Reset

`reset()` wipes the client's local state in one transaction and restarts the cursor at the bootstrap value. It touches nothing on the server, so the next run re-pulls the same rows from the beginning.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

await kizunasync.reset()
await kizunasync.sync()
```

### Clear the previous account on sign-out

```ts
// src/account.ts
import { kizunasync } from './kizunasync'
import { supabase } from './supabase-client'

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
  await kizunasync.reset()
}
```

The next user who signs in on this device starts from an empty local database, and the engine records that user as the store's new owner.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

## Returns

`Promise<void>` that settles once the wipe has committed and the sandbox bytes have been deleted. It removes all of the following.

| Name | Type | Required | Description |
|---|---|---|---|
| Local rows and tombstones | — | — | Every mirrored row and every deletion shadow. Local reads return nothing until the next pull commits a boundary. |
| Staged pull pages | — | — | Any sequence in flight, so the next pull starts a fresh one. |
| [Outbox](../../resources/glossary.md#outbox) entries | `TOutboxEntry[]` | — | Queued writes are discarded, not sent. A write the server never received is lost, so drain the queue with [Sync](./sync.md) first when that matters. |
| Rejection journal and dead letters | `TRejectionRecord[]` | — | Every entry [List rejections](./rejections.md) would return, dismissed or not. |
| Conflict journal rows | — | — | The overwrites recorded for tables whose `conflict_journal` column is on. |
| Attachment queue rows and their bytes | — | — | The queue is emptied and each sandbox file is deleted, unless a row written during the wipe continues to point at the same [content-addressed](https://grokipedia.com/page/Content-addressable_storage) path. Remote Storage objects are left alone; [Vacuum attachments](./vacuum.md) is what removes those. |
| Checkpoint cursor | `TCursor` | — | Reset to `'0'` and the schema version is written again, so [Checkpoint](./checkpoint.md#returns) reports a client that has never pulled. |
| Soft block | `boolean` | — | Cleared as part of the wipe together with its reason, which is what lets a client that answered the reset signal, or a store that changed hands, sync again. |
| Store owner and owner buckets | — | — | The user the store belonged to is forgotten, and every `byOwner` bucket goes back to an unset value. The next token, or the next pull or push under the token the engine already holds, records the owner again and fills those buckets with that user's id. |

One `LOCAL_CHANGED` event is raised after the wipe commits, so reactive bindings clear before the re-pull rather than after it.

## Notes

A `byColumn` value set with [Set bucket](./set-bucket.md) lives on the client rather than in the database, so it survives the wipe and the next pull carries it. The owner does not: the wipe clears it, and the `byOwner` buckets stay unset until the engine records the next owner.

This method is the client half of the reset signal. A pull or a push can answer `RESET_REQUIRED`. The client then soft-blocks: [Pull once](./pull-once.md) and [Push once](./push-once.md) return without reaching the wire, so no request leaves the device.

A `reset_required` block takes both halves. Ship a build whose schema version meets the server minimum, then call this method. An `identity_changed` block needs only this method.

[React: useSyncStatus](../react/use-sync-status.md#returns) and [Vue: useSyncStatus](../vue/use-sync-status.md#returns) surface the same condition as `needsReset`. They read it from `checkpoint.softBlocked`, not from a `CHECKPOINT_EXPIRED` event, because that event rehydrates on its own and needs no reset. [Protocol overview](../../sync/protocol-overview.md#lifecycle-signals) describes both signals and what each one asks of the client.

Switching accounts on one device is a reset. A token of a user other than the store's owner soft-blocks sync with `identity_changed`, so one user's queued writes are never pushed under another user's session, and the block holds until this method runs. Call it when the previous user signs out, as in the example above, or once the block appears. Either way the previous user's queued writes are discarded, so let a sync drain them before the sign-out when they matter. The reset also mints a new `client_id`, so the device registers under the new user instead of colliding with the registration the previous user owns.

A changed `byColumn` value needs no reset, because [Set bucket](./set-bucket.md#notes) already replaces the rows the old scope held. A table with no bucket column relies on server Row Level Security alone, and this method is what clears the rows the previous identity could see and the new one cannot.

## Related reference

- [Checkpoint](./checkpoint.md)
- [Set bucket](./set-bucket.md)
- [Sync](./sync.md)
- [List overwrites](./overwrites.md)
- [Vacuum attachments](./vacuum.md)
- [React: useSyncStatus](../react/use-sync-status.md)
- [Vue: useSyncStatus](../vue/use-sync-status.md)
- [Swift: Reset](../swift/reset.md)
- [Kotlin: Reset](../kotlin/reset.md)
