---
title: Vacuum attachments
description: Remove the Storage objects and local bytes no row references any more.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Vacuum attachments

`attachments.vacuum()` collects the attachments this device dropped: it removes an object this device owns from Storage, deletes the local bytes no live row shares, and purges the queue row, or, when the object is not this device's to remove, evicts it locally instead. [`sync()`](./sync.md) calls it on its own once a push has drained, so the app rarely has to; call it directly for a sweep outside that cycle.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

await kizunasync.attachments.vacuum()
```

### A storage clean-up button

```ts
// src/settings.ts
import { kizunasync } from './kizunasync'

document.querySelector('#clean-up-storage')?.addEventListener('click', () => {
  void kizunasync.attachments.vacuum()
})
```

`sync()` already runs a sweep after every push that leaves the outbox empty, so an explicit call matters mostly while writes stay queued and the automatic sweep waits for them.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

## Returns

`Promise<void>` that settles once every entry due for cleanup has been visited. A visited entry takes one of two paths.

### A removable object

| Name | Type | Required | Description |
|---|---|---|---|
| The Storage object | — | — | Removed through the transfer port, which on [Supabase](https://supabase.com) also records the removal so the server's own attachment metadata stays in step. |
| The sandbox bytes | — | — | Deleted unless another live entry points at the same [content-addressed](https://grokipedia.com/page/Content-addressable_storage) path, because identical files share one local copy. |
| The queue row | — | — | Purged last, so an entry whose removal failed remains for the next call. |

### A local eviction

| Name | Type | Required | Description |
|---|---|---|---|
| The sandbox bytes | — | — | Deleted the same way, unless a live entry shares them. |
| The queue row | — | — | Kept, moved to state `evicted` rather than purged. Storage is never asked. |

An entry becomes orphaned only on evidence the server sent: a pulled tombstone for the row that carried it, a pulled row that now carries a different object, an applied push verdict for this device's write that removed or replaced it, or a rejected verdict for the write that introduced it. The reference must also be named by no local row and no queued write, and its owner segment must be this device's own signed-in user; an orphaned reference a peer owns is evicted rather than removed, because only the owner may remove an object from Storage. A reference this device drops for any other reason, such as a rehydration that replaced the local scope or a bucket value that changed, is evicted the same way, with no removal attempt. A removal Storage itself refuses with 401 or 403 ends as a local eviction after that one attempt; any other removal failure retries within the [`attachmentAttempts`](./define-config.md#parameters) budget and then evicts.

## Errors

On an app client built with attachment ports, the call opens the engine when it is the client's first use. When that open fails, on this call or an earlier one, the call rejects with the open's typed error, such as `ENGINE_UNAVAILABLE` or `STORE_BUSY`, which [Initializing](./initializing.md#errors) lists. Apart from that, this method throws nothing and does not stop on the first problem. An entry whose remote removal fails without ending in a local eviction records the message and an incremented attempt count, keeps its queue row, and the loop moves to the next one. Purging it instead would leak the remote object with no way to retry.

On an app client built without both the `fileStore` and `transfer` ports, the call rejects with `ATTACHMENT_PORTS_MISSING`, as every attachment method does; [Troubleshooting](../../operations/troubleshooting.md#attachment_ports_missing) shows the fix.

## Notes

Only an entry marked orphaned or evicted is collected here, which makes this queue cleanup rather than cache eviction. A `synced` attachment keeps its sandbox copy on purpose, so the device that has the bytes never downloads them again.

[Reset](./reset.md) is the other side: it deletes every local row and every sandbox file, and leaves the remote objects alone. Neither method removes an object a live row references.

Storage policies decide whether the removal is allowed at all. [Storage policies](../../attachments/media-and-attachments.md#storage-policies) shows the rules a bucket needs for the client to delete its own objects.

## Related reference

- [Attach a file](./from-file.md)
- [Get attachment status](./get-status.md)
- [Remove an attachment](./attachment-remove.md)
- [Sync](./sync.md)
- [Reset](./reset.md)
- [Create the Storage transfer](./create-supabase-transfer.md)
- [Swift: Vacuum attachments](../swift/vacuum.md)
- [Kotlin: Vacuum attachments](../kotlin/vacuum.md)
