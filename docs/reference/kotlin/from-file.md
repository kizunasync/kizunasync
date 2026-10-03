---
title: Attach a file
description: Import a picked file into the sandbox and write its reference onto a row.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Attach a file

`fromFile` copies a file the user picked into the client's attachment sandbox, queues its upload, and writes the resulting reference onto the row's attachment column as an ordinary local update. The bytes never cross the binding: the picker stays in the app and the engine works from the path.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val result = kizunasync.fromFile(
    table = "todos",
    column = "image_path",
    pk = todoId,
    sourcePath = pickedFile.absolutePath,
    mediaType = "image/jpeg",
)
```

### Insert the row first

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncOp
import java.util.UUID

val todoId = UUID.randomUUID().toString()
kizunasync.apply(
    table = "todos",
    pk = todoId,
    op = KizunaSyncOp.Insert,
    columns = mapOf("title" to "works on a plane", "done" to false),
)
val result = kizunasync.fromFile(
    table = "todos",
    column = "image_path",
    pk = todoId,
    sourcePath = pickedFile.absolutePath,
)
```

Both writes wake the [Host scheduler](./scheduler.md), whose next run pushes the row and uploads the bytes.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `table` | `String` | Yes | Table of the row that owns the file. |
| `column` | `String` | Yes | Column declared as an attachment for that table in [Initializing](./initializing.md#parameters). |
| `pk` | `String` | Yes | Primary key of the row. The row has to exist already, because the reference is written onto it. A uuid names the row in any case, because the engine lowercases it as it does for a write. |
| `sourcePath` | `String` | Yes | Filesystem path of the file to import. It is read once and copied into the sandbox. |
| `mediaType` | `String?` | No | Content type recorded for the object; it picks the reference's extension. Default: `null`, which records `application/octet-stream`. |

## Returns

`KizunaSyncFromFileResult`, with these fields.

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | `String` | — | The value written onto the column, shaped `<owner>/<pk>/<uploadId>.<extension>`, where the owner comes from the row's configured owner column. |
| `sha256` | `String` | — | Hex digest of the imported bytes. The sandbox is [content addressed](https://grokipedia.com/page/Content-addressable_storage) by this digest, so importing the same bytes twice stores one copy. |
| `size` | `Long` | — | Size of the imported file in bytes. |
| `mediaType` | `String` | — | The content type that was recorded. |
| `localPath` | `String` | — | Path of the copy inside the sandbox, which is what a viewer reads until the upload finishes. |

## Errors

| Code | Condition |
|---|---|
| `ATTACHMENT_PORTS_MISSING` | The client was created without `attachmentRoot`. See [ATTACHMENT_PORTS_MISSING](../../operations/troubleshooting.md#attachment_ports_missing). |
| `UNKNOWN_TABLE` | `table` is not one of the tables the client was created with. |
| `LOCAL_CONSTRAINT` | `column` is not declared as an attachment on that table, or the row's owner or its `pk` is not a uuid. |
| `ATTACHMENT_ROW_GONE` | No live row holds `pk` in that table. Insert the row before importing the file. |
| `ATTACHMENT_OWNER_MISSING` | The row's owner column is missing or empty, so no object key can be derived. |
| `TRANSFER` | The source file could not be read. |
| `STORE`, `JSON` | The sandbox copy, the queue row, or the column update could not be written. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

The import writes the reference through the normal write path, so it is one more entry in the [outbox](../../resources/glossary.md#outbox) and it is visible to [Fetch data](./fetch-data.md) at once. The bytes move later: the next [Sync](./sync.md) pushes the column first and then drives the transfer, so the server never sees a reference to an object that is on its way. [Media and attachments](../../attachments/media-and-attachments.md#5-bytes-upload-after-the-outbox-drains) walks through the ordering.

Uploads go to the Storage bucket the column declares, using [resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url); Kizuna adds the durable queue around them, so an interrupted transfer resumes from its recorded offset instead of starting again. The object key is the reference, so a Storage policy scoped to the owner segment covers it, as [access control](https://supabase.com/docs/guides/storage/security/access-control#access-policies) describes.

If the column update fails after the file was queued, the queued object is evicted, since no server ever saw the reference: [Vacuum attachments](./vacuum.md) only deletes its sandbox bytes, and Storage is never asked. The original error from the write is raised.

## Related reference

- [Get attachment status](./get-status.md)
- [Watch an attachment](./watch.md)
- [Resolve a download](./resolve-download.md)
- [Vacuum attachments](./vacuum.md)
- [Swift: Attach a file](../swift/from-file.md)
- [JavaScript: Attach a file](../javascript/from-file.md)
