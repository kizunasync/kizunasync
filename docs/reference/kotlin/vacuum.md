---
title: Vacuum attachments
description: Delete the objects and local files of attachments nothing references.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Vacuum attachments

`vacuum()` walks the attachment rows marked orphaned or evicted, removes each orphaned object from Storage when it can, deletes its sandbox file when no other live row shares it, and drops or updates the queue row depending on the outcome. Nothing that is referenced by a row is touched. The call does nothing without a session or on a soft-blocked store, and it deletes a local file only when it lies under the configured attachment root.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
kizunasync.vacuum()
```

### After clearing out finished todos

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncOp
import com.kizunasync.kizunasync.KizunaSyncQuery
import org.json.JSONArray

val removed = kizunasync.applyWhere(
    table = "todos",
    op = KizunaSyncOp.Delete,
    filters = JSONArray().put(KizunaSyncQuery.eq("done", true)),
)
kizunasync.sync()
kizunasync.vacuum()
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This function takes no arguments. It works from the rows already marked orphaned or evicted. |

## Returns

`Unit`. A successful removal drops the row entirely, after deleting its sandbox file. A removal refused with 401 or 403, or one that keeps failing once the attachment budget is spent, ends the row `evicted` instead: the local bytes are deleted, but the row and its hash stay, and the object is left in Storage. Any other failure keeps the row `orphaned`, with the attempt counted and the error recorded, so the next call tries it again instead of leaking the bytes silently.

## Errors

| Code | Condition |
|---|---|
| `STORE`, `JSON` | The attachment queue could not be read or updated. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

A row is orphaned only on server evidence: a pull that brings a tombstone for the row or a server row naming a different reference, or a push verdict confirming this device's own delete or a replacing write, once no local row and no queued write still names the reference, and the reference's owner segment matches the signed-in user. A local delete or update alone marks nothing until the push settles. A reference this device drops without that evidence is evicted instead, for example a rehydration, a [scope change](./set-bucket.md), an import whose column update failed, or a reference owned by another user: this call only deletes its local bytes, and Storage is never asked. Age alone never marks a reference orphaned or evicted, so this call is safe at any point. Run it after a batch of deletes syncs.

The sandbox is [content addressed](https://grokipedia.com/page/Content-addressable_storage), so two references that hold identical bytes share one file. The shared-file check is what keeps a vacuum from deleting bytes another live row points at. Supabase documents the object removal side under [Storage error codes](https://supabase.com/docs/guides/storage/debugging/error-codes#404-notfound), and [Media and attachments](../../attachments/media-and-attachments.md#5-bytes-upload-after-the-outbox-drains) puts the queue in context.

[Reset](./reset.md) is the other way bytes leave the device. It wipes the queue rather than walking it, so it hands the paths back for the caller to delete.

## Related reference

- [Attach a file](./from-file.md)
- [Get attachment status](./get-status.md)
- [Reset](./reset.md)
- [Sync](./sync.md)
- [Swift: Vacuum attachments](../swift/vacuum.md)
- [JavaScript: Vacuum attachments](../javascript/vacuum.md)
