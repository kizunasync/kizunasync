---
title: Attach a file
description: Import a picked file into the local sandbox and queue its upload.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Attach a file

`attachments.fromFile(args)` copies a picked file into the client's [content-addressed](https://grokipedia.com/page/Content-addressable_storage) sandbox, queues the upload, and writes the reference into the row's column as one local update. The bytes travel out of band; the row only ever holds the reference.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function attachImage(todoId: string, pickedFileUri: string): Promise<string> {
  const attached = await kizunasync.attachments.fromFile({
    table: 'todos',
    column: 'image_path',
    pk: todoId,
    uri: pickedFileUri,
    mediaType: 'image/jpeg',
  })

  return attached.localUri
}
```

The function returns `localUri`, which renders the sandbox copy at once, long before the bytes reach Storage. By then `fromFile` has written `attached.ref` into `image_path`, so the app makes no update of its own after the call. The object key derives from a column of the row, so the row must exist before the file is picked.

Insert the row first with [Insert data](./insert-data.md).

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `args.table` | `string` | Yes | A table that declares this attachment column on [Define config](./define-config.md#parameters). |
| `args.column` | `string` | Yes | The column that will hold the reference, declared with `attachment()`. |
| `args.pk` | `string` | Yes | The primary key of the row the file belongs to. The row must already exist locally. |
| `args.uri` | `string` | Yes | Where to read the file from. The file store fetches it, so on the web this is a `blob:` or `http:` object URL, and on a native client the platform file URI. |
| `args.mediaType` | `string` | No | The content type to record and upload with. Default: the content type the file store reported when it read the file. |

## Returns

`Promise<TFromFileResult>`, settled once the bytes are in the sandbox, the queue row is written, and the row's column holds the reference.

| Name | Type | Required | Description |
|---|---|---|---|
| `ref` | `string` | — | The Storage object key, built as `<owner>/<pk>/<uploadId>.<ext>`. The owner is the value of the row's owner column, so the key is identical on every device. The extension comes from the content type, and is `bin` for a type outside the known image and PDF set. |
| `sha256` | `string` | — | The hash of the imported bytes, recorded so a peer can verify its download. |
| `size` | `number` | — | The imported byte count. |
| `mediaType` | `string \| null` | — | The content type recorded for the upload. |
| `localUri` | `string` | — | A renderable URI for the sandbox copy, available immediately. It is not promised to outlive the file. |

The queue row is created in state `queued` with direction `upload`, and the column update enters the outbox like any other local write. Nothing leaves the device here: the bytes move on the next [Sync](./sync.md), after the outbox has drained, so the server row already carries the reference when the object lands.

## Errors

This method throws a typed `TEngineError` for the catalog codes below, and a plain error otherwise.

| Code | Condition |
|---|---|
| `ATTACHMENT_PORTS_MISSING` | The app client was built without both the `fileStore` and `transfer` ports, so it has no attachment queue, and every attachment method fails this way. [Initializing](./initializing.md#errors) refuses that combination outright when a table declares an attachment column. |
| `ATTACHMENT_ROW_GONE` | No local row has that primary key. Insert the row before picking a file. |
| `ATTACHMENT_OWNER_MISSING` | The row's owner column is empty or is not a string, so no object key can be derived. On a table whose owner column is its `byOwner` bucket, [Insert data](./insert-data.md) fills that column once a session has reached the client, so on such a table the code points at a row inserted before then, or at one that set the column to `null`. |
| `LOCAL_CONSTRAINT` | The owner value or the primary key is not a uuid, which the object key needs. |
| `STORE_UNAVAILABLE` | The file store cannot open its sandbox: a browser with no [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) for [Browser file store](./create-web-file-store.md#errors), or a platform with no document directory for [Expo: File store](../expo/open-expo-file-store.md#errors). |
| (the local write's error) | The update that writes the reference onto the row failed. The queued upload is evicted, so no job waits on a reference no row carries, and the write's own error is rethrown. |
| (untagged) | The column is not declared as an attachment column on that table, or the file store could not read the URI. |

On an app client built with attachment ports, the call opens the engine when it is the client's first use. When that open fails, on this call or an earlier one, the call rejects with the open's typed error, such as `ENGINE_UNAVAILABLE` or `STORE_BUSY`, which [Initializing](./initializing.md#errors) lists.

## Notes

The queue holds the upload back until the row's column names this exact reference, which `fromFile` writes before it returns. A later write that changes the column before the upload runs turns the queue entry orphaned, and [Vacuum attachments](./vacuum.md) collects it. Writing a new file to the same column supersedes the previous object the same way.

The upload runs through the transfer port. On Supabase that is [Create the Storage transfer](./create-supabase-transfer.md), which sends a file at or under 6 MiB as a single [standard upload](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading) and anything larger as a resumable one. [Media and attachments](../../attachments/media-and-attachments.md#4-import-the-file-and-write-the-ref) walks the whole path, including the Storage policies the bucket needs.

Once the reference is on the row, [React: useAttachment](../react/use-attachment.md) follows the upload and hands the component the URI to render, so the preview above and the synced file are the same element.

A peer sometimes deletes the row first. The local [tombstone](../../resources/glossary.md#tombstone) then shadows the key, so nothing uploads the file and the object turns orphaned instead.

## Related reference

- [Resolve a download](./resolve-download.md)
- [Get attachment status](./get-status.md)
- [Watch an attachment](./watch.md)
- [Retry an attachment](./attachment-retry.md)
- [Cancel an attachment](./attachment-cancel.md)
- [Remove an attachment](./attachment-remove.md)
- [Vacuum attachments](./vacuum.md)
- [Create the Storage transfer](./create-supabase-transfer.md)
- [Swift: Attach a file](../swift/from-file.md)
- [Kotlin: Attach a file](../kotlin/from-file.md)
