---
title: Resolve a download
description: Get the local path of an attachment, fetching the bytes once if they are missing.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Resolve a download

`resolveDownload` answers the local path of an attachment's bytes. When the file is already in the sandbox it returns at once; when it is not, and a transfer is configured, it fetches the object once and then answers the fresh path.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import java.io.File

val path = kizunasync.resolveDownload(reference)
if (path != null) {
    imageFile.value = File(path)
}
```

### From a row a peer wrote

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncQuery
import org.json.JSONObject

val row = kizunasync.query(
    table = "todos",
    plan = KizunaSyncQuery.single(KizunaSyncQuery.eq("id", todoId)),
) as? JSONObject ?: return
val reference = row.optString("image_path")
val path = if (reference.isEmpty()) null else kizunasync.resolveDownload(reference)
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | `String` | Yes | The value stored in the row's attachment column, as [Attach a file](./from-file.md#returns) produced it on the device that added the file. |

## Returns

`String?`. The sandbox path of the bytes, or `null` when the reference has no queue row on this device, when no transfer is configured, when the queue row is mid-transfer, orphaned, or evicted, when the store is soft-blocked, or when the fetch did not produce a file.

## Errors

| Code | Condition |
|---|---|
| `ATTACHMENT_PORTS_MISSING` | A download had to run and the client was created without `attachmentRoot`. |
| `STORE`, `JSON` | The attachment queue could not be read or updated. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

The call is the lazy half of the attachment queue: a reference a [pull](../../resources/glossary.md#pull) delivered is registered as `queued` and nothing is fetched until something asks for it, so a list of 500 rows does not download 500 files. A row whose sandbox file disappeared, after an operating-system purge or a cleared cache, is re-fetched by the same path rather than answering `null` forever.

A transfer failure is recorded on the queue row rather than thrown: the call answers `null` and [Get attachment status](./get-status.md) carries `failed` with the message. A download with no known SHA-256, neither the server's nor one this device kept, fails the same way, with `errorCode` `ATTACHMENT_UNVERIFIED`, and fetches nothing; [Retry an attachment](./attachment-retry.md) or a later call tries again. Bytes not on Storage leave the row `queued`, the ordinary state while the writing device is uploading. Supabase documents the underlying object read and its failures under [Storage error codes](https://supabase.com/docs/guides/storage/debugging/error-codes#404-notfound).

## Related reference

- [Attach a file](./from-file.md)
- [Get attachment status](./get-status.md)
- [Watch an attachment](./watch.md)
- [Vacuum attachments](./vacuum.md)
- [Swift: Resolve a download](../swift/resolve-download.md)
- [JavaScript: Resolve a download](../javascript/resolve-download.md)
