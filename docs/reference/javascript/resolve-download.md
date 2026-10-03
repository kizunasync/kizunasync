---
title: Resolve a download
description: Fetch a peer's attachment bytes on first use and return a renderable URI.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Resolve a download

`attachments.resolveDownload(ref)` returns a renderable URI for an attachment, fetching the bytes on the spot when this device does not have them. Downloads are lazy: a sync schedules the entry, and this call is what moves the bytes.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function imageUri(imagePath: string): Promise<string | null> {
  return kizunasync.attachments.resolveDownload(imagePath)
}
```

### Render only once the bytes are here

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function showTodoImage(image: HTMLImageElement, imagePath: string): Promise<void> {
  const uri = await kizunasync.attachments.resolveDownload(imagePath)

  image.hidden = uri === null
  if (uri !== null) {
    image.src = uri
  }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `ref` | `string` | Yes | The Storage object key stored in the row's attachment column, which is the `ref` [Attach a file](./from-file.md) returned on the device that created it. |

## Returns

`Promise<string \| null>`.

| Name | Type | Required | Description |
|---|---|---|---|
| A URI | `string` | — | Returned when the bytes are in the sandbox, either because this device uploaded them or because a download has completed. |
| `null` | `null` | — | Returned when no queue entry exists for the reference, meaning no pull has delivered it, and when the download this call attempted did not produce bytes. |

### What one call does

| Name | Type | Required | Description |
|---|---|---|---|
| Cached bytes | — | — | Returned straight away, with no request. The sandbox copy from an upload counts, so the device that attached the file never re-downloads it. |
| A queued or failed download | — | — | Fetched now: the recorded hash is read, the object is downloaded to a path derived from that hash, the bytes are verified against it, and the entry moves to `synced`. |
| Bytes not on the server | — | — | Left as `queued` rather than `failed`, so the next call tries again. This is the normal state while the writing device has the object in its own upload queue. |

## Errors

This method throws nothing of its own. A failed transfer is recorded on the queue entry instead, where [Get attachment status](./get-status.md#returns) reports it as state `failed` with the message and, for a catalog code such as `ATTACHMENT_HASH_MISMATCH` or `ATTACHMENT_UNVERIFIED`, `errorCode`; the call itself returns `null`.

On an app client built with attachment ports, the call opens the engine when it is the client's first use. When that open fails, on this call or an earlier one, the call rejects with the open's typed error, such as `ENGINE_UNAVAILABLE` or `STORE_BUSY`, which [Initializing](./initializing.md#errors) lists. Returning cached bytes asks the file store for their URI, so a store that cannot open its sandbox rejects the call with `STORE_UNAVAILABLE`, as [Browser file store](./create-web-file-store.md#errors) describes. On an app client built without both the `fileStore` and `transfer` ports, the call rejects with `ATTACHMENT_PORTS_MISSING`, as every attachment method does; [Troubleshooting](../../operations/troubleshooting.md#attachment_ports_missing) shows the fix.

## Notes

A sync never downloads bytes. The pull schedules a download entry for every peer reference it sees, carrying metadata only, and the entry stays queued until something asks for it, which keeps a large shared bucket from being mirrored onto every device.

Every download fails closed rather than caching bytes nobody can verify. The expected hash comes from the server's recorded metadata first, or from this device's own hash when it uploaded the object and later evicted its local bytes. A downloaded body that hashes to something else fails with `ATTACHMENT_HASH_MISMATCH` before anything is written. With no hash on either side the call fails with `ATTACHMENT_UNVERIFIED` instead of accepting unverifiable bytes; [Get attachment status](./get-status.md#returns) reports either code in `errorCode`. On [Supabase](https://supabase.com) the fetch goes through a short-lived signed URL, so [Storage policies](../../attachments/media-and-attachments.md#storage-policies) decide who may read the object regardless.

React and [Expo](https://expo.dev) apps usually call [React: useAttachment](../react/use-attachment.md) instead, which pairs this method with [Watch an attachment](./watch.md) so a component re-renders when the bytes arrive.

## Related reference

- [Attach a file](./from-file.md)
- [Get attachment status](./get-status.md)
- [Watch an attachment](./watch.md)
- [Retry an attachment](./attachment-retry.md)
- [Create the Storage transfer](./create-supabase-transfer.md)
- [Swift: Resolve a download](../swift/resolve-download.md)
- [Kotlin: Resolve a download](../kotlin/resolve-download.md)
