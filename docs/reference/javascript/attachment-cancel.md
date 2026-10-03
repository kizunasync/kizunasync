---
title: Cancel an attachment
description: Stop an in-flight transfer now, without spending it against the attempt budget.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Cancel an attachment

`attachments.cancel(ref)` stops a transfer at the app's own request. An in-flight upload handle is aborted first, then the row lands `failed` and retryable. Canceling says "not now," never "never again": the attempt is not charged against the transfer budget, so a person who backs out of an upload does not lose a retry to it.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function cancelUpload(imagePath: string): Promise<void> {
  await kizunasync.attachments.cancel(imagePath)
}
```

### Cancel from a progress control

```tsx
// src/components/upload-row.tsx
import { useAttachment } from 'kizunasync/react'

export function UploadRow({ imageRef }: { imageRef: string }) {
  const { state, progress, cancel } = useAttachment(imageRef)

  if (state !== 'uploading') return null
  return (
    <button onClick={cancel}>
      Stop upload ({progress}%)
    </button>
  )
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `ref` | `string` | Yes | The Storage object key stored in the row's attachment column. |

## Returns

`Promise<void>` that settles once the row is written. A reference with no transfer in flight is still marked `failed`, so calling it on an already-queued row is not an error, and a reference the queue has never seen is a no-op.

## Errors

On an app client built with attachment ports, the call opens the engine when it is the client's first use. When that open fails, on this call or an earlier one, the call rejects with the open's typed error, such as `ENGINE_UNAVAILABLE` or `STORE_BUSY`, which [Initializing](./initializing.md#errors) lists. Apart from that, this method throws nothing. An adapter whose upload handle cannot be aborted logs the failure and still writes the row, because the kernel state is what the app asked for regardless of whether the socket obeyed. On an app client built without both the `fileStore` and `transfer` ports, the call rejects with `ATTACHMENT_PORTS_MISSING`, as every attachment method does; [Troubleshooting](../../operations/troubleshooting.md#attachment_ports_missing) shows the fix.

## Notes

`cancel` and a genuine transfer failure both leave the reference in `failed`. `permanent` separates them. `cancel` never sets it, so the reference stays a candidate for the next drive or for an explicit [`retry`](./attachment-retry.md). `cancel` also leaves the queue's attempt count alone, so repeated cancelling never moves a reference toward the [transfer budget](./get-status.md#notes).

A cancel targets only the transfer, never the row or the reference. The queue entry, the sandbox bytes, and the object key stay exactly as they were; [Remove an attachment](./attachment-remove.md) is the method that forgets them.

## Related reference

- [Get attachment status](./get-status.md)
- [Retry an attachment](./attachment-retry.md)
- [Remove an attachment](./attachment-remove.md)
- [Attach a file](./from-file.md)
- [Swift: Cancel an attachment](../swift/attachment-cancel.md)
- [Kotlin: Cancel an attachment](../kotlin/attachment-cancel.md)
