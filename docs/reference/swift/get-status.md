---
title: Get attachment status
description: Read one attachment's queue state, progress, and last error.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Get attachment status

`getStatus(_:)` reads the current row of one reference in the attachment queue. It is a point-in-time read of local state and makes no request.

## Examples

### Basic

```swift
// TodoApp/AttachmentView.swift (excerpt)
import KizunaSync

if let status = try await kizunasync.getStatus(reference) {
  print("\(status.state) \(status.progress)")
}
```

### Decide what to show

```swift
// TodoApp/AttachmentView.swift (excerpt)
import KizunaSync

guard let status = try await kizunasync.getStatus(reference) else {
  showSpinner()
  return
}
switch status.state {
case "synced": showImage(at: status.localPath)
case "failed": showRetry(message: status.error)
default: showSpinner()
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | `String` | Yes | The value stored in the row's attachment column. |

## Returns

`KizunaSyncAttachmentStatus?`. The value is `nil` when this device has no queue row for the reference, which is the case for a reference a pull has not delivered; otherwise the object carries these fields.

| Name | Type | Required | Description |
|---|---|---|---|
| `state` | `String` | — | `queued` while the job waits, `uploading` or `downloading` while a transfer holds it, `synced` once the object is confirmed on [Storage](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) or the bytes are local, `failed` after a transfer error, `orphaned` once server evidence shows the row that referenced it is gone or rewritten, and `evicted` once this device dropped the reference on its own, without that evidence: the local bytes and the row are gone, and the object stays in Storage. |
| `progress` | `Int64` | — | Bytes the server has confirmed for an upload, which is also the offset an interrupted upload resumes from. Downloads do not report intermediate progress, so it stays `0` for them. |
| `error` | `String?` | — | The message from the last failed transfer. A later successful download clears it; a later successful upload leaves it in place beside a `synced` state, so read `state` first. `nil` when nothing has failed. |
| `localPath` | `String?` | — | Path of the bytes inside the sandbox, present as soon as a file exists there. `nil` for a reference a peer wrote that has not been fetched. |
| `permanent` | `Bool` | — | Whether the transfer budget stopped this reference for good: `state` reads `failed` and the queue skips it. [Retry an attachment](./attachment-retry.md) is the only way back. `false` for a `missing` reference. |
| `errorCode` | `String?` | — | The catalog code of the last recorded failure, for example `ATTACHMENT_UNVERIFIED` or `ATTACHMENT_UPLOAD_EXPIRED`. `nil` while the row records none. |

## Errors

| Code | Condition |
|---|---|
| `STORE` | The attachment queue could not be read. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

The queue advances during [Sync](./sync.md) and during [Resolve a download](./resolve-download.md), so the state changes at those points rather than continuously. To follow it without polling, use [Watch an attachment](./watch.md), which delivers the same values through a callback.

A reference the engine has a watcher for but no row is reported to that watcher as the state `missing`, so a viewer always has something to render. [Attachment state lifecycle](../../attachments/media-and-attachments.md#attachment-state-lifecycle) lists the transitions in order.

Every claimed attempt, upload or download, counts against `attachmentAttempts` (five by default, see [Initializing](./initializing.md#parameters)); the row that spends the budget lands here with `permanent: true` and drops out of the queue's own candidates. [Retry an attachment](./attachment-retry.md) forgives the budget, [Cancel an attachment](./attachment-cancel.md) stops a transfer without spending it, and [Remove an attachment](./attachment-remove.md) forgets the row outright.

## Related reference

- [Watch an attachment](./watch.md)
- [Attach a file](./from-file.md)
- [Resolve a download](./resolve-download.md)
- [Retry an attachment](./attachment-retry.md)
- [Cancel an attachment](./attachment-cancel.md)
- [Remove an attachment](./attachment-remove.md)
- [Types](./types.md)
- [Kotlin: Get attachment status](../kotlin/get-status.md)
- [JavaScript: Get attachment status](../javascript/get-status.md)
