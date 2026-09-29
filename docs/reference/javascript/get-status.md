---
title: Get attachment status
description: Read the queue state, progress, local URI, and last error for one attachment.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Get attachment status

`attachments.getStatus(ref)` reads the queue row for one attachment: where it is in its lifecycle, how far the transfer got, whether a local copy exists, and what failed last.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function imageStatus(imagePath: string) {
  return kizunasync.attachments.getStatus(imagePath)
}
```

### Retry only what failed

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function retryFailedUpload(imagePath: string): Promise<void> {
  const status = await kizunasync.attachments.getStatus(imagePath)

  if (status?.state === 'failed' && !status.permanent) {
    await kizunasync.sync()
  }
}
```

A failed row whose budget is not spent goes back out on the next run, so `sync()` only brings that run forward. A `permanent` one waits for [`retry`](./attachment-retry.md).

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `ref` | `string` | Yes | The Storage object key stored in the row's attachment column. |

## Returns

`Promise<TAttachmentStatus \| null>`. It is `null` when the queue has no row for that reference, which means neither this device nor a pull has ever registered it.

| Name | Type | Required | Description |
|---|---|---|---|
| `state` | `TAttachmentState` | — | Where the entry stands in its lifecycle, from the seven values below. |
| `progress` | `number` | — | Percent complete for the transfer in flight. A single-shot upload reports `100` once, rather than a rising series. |
| `localUri` | `string \| null` | — | A renderable URI for the sandbox copy, or `null` when this device holds no bytes. |
| `error` | `string \| null` | — | The message from the last failed attempt, or `null`. |
| `permanent` | `boolean` | — | `true` when `state` is `failed` because the transfer budget is spent: no drive claims this row again until [`retry`](./attachment-retry.md) forgives it. `false` for every other reason a transfer can fail, including one the app itself stopped with [`cancel`](./attachment-cancel.md). |
| `attempts` | `number` | — | Transfer attempts this row has consumed, out of the [`attachmentAttempts`](./define-config.md#parameters) budget. |
| `errorCode` | `string \| null` | — | The engine catalog code of the last recorded failure, such as `ATTACHMENT_HASH_MISMATCH` or `TRANSFER`, or `null` when the row records none. |

### The seven states

| Name | Type | Required | Description |
|---|---|---|---|
| `queued` | `TAttachmentState` | — | Waiting. An upload waits for the outbox to drain; a download waits for [Resolve a download](./resolve-download.md) to ask for it. |
| `uploading` | `TAttachmentState` | — | Bytes are moving out, claimed by one worker so a second run cannot send them again. |
| `downloading` | `TAttachmentState` | — | Bytes are moving in, under the same claim. |
| `synced` | `TAttachmentState` | — | The server has the object and confirmed its hash, or the download completed and verified. The sandbox copy is kept as the local cache. |
| `failed` | `TAttachmentState` | — | The last attempt failed, with the reason in `error` and the attempt count recorded. While `permanent` is `false`, the next [Sync](./sync.md) retries an upload and the next resolve retries a download; once it is `true`, the transfer budget is spent and nothing claims the row until [`retry`](./attachment-retry.md) forgives it. |
| `orphaned` | `TAttachmentState` | — | The object is not referenced by any local row or queued write, on evidence from the server: a pulled tombstone for its row, a pulled row that now carries a different object, an applied push verdict that removed or replaced it, or a rejected verdict for the write that introduced it. [Vacuum attachments](./vacuum.md) removes the object next. |
| `evicted` | `TAttachmentState` | — | This device dropped the reference: a rehydration or a bucket-scope change left it with no server evidence of remote garbage, the object belongs to a peer, or a removal this device attempted could not complete before the attachment budget ran out. [Vacuum attachments](./vacuum.md) deletes the cached bytes without asking Storage. |

## Errors

On an app client built with attachment ports, the call opens the engine when it is the client's first use. When that open fails, on this call or an earlier one, the call rejects with the open's typed error, such as `ENGINE_UNAVAILABLE` or `STORE_BUSY`, which [Initializing](./initializing.md#errors) lists. A row with a local copy asks the file store for its URI, so a store that cannot open its sandbox rejects the call with `STORE_UNAVAILABLE`, as [Browser file store](./create-web-file-store.md#errors) describes. On an app client built without both the `fileStore` and `transfer` ports, the call rejects with `ATTACHMENT_PORTS_MISSING`, as every attachment method does; [Troubleshooting](../../operations/troubleshooting.md#attachment_ports_missing) shows the fix.

## Notes

The state describes the bytes, not the row. A row with its reference column set is already pushed and visible to peers while its object remains `queued`, which is why a peer sees the reference before it can render the file.

Polling this method is rarely the right shape. [Watch an attachment](./watch.md) delivers the same snapshot on every transition for one reference, without touching the global event stream.

In React, [React: useAttachment](../react/use-attachment.md) returns these same fields as component state, already subscribed.

An upload that keeps failing consumes the transfer budget. That budget is `attachmentAttempts` on [Define config](./define-config.md#parameters), five attempts by default. The claim that discovers the budget spent does not count itself. `attempts` therefore stops at the configured number. `permanent` turns `true` at that point, and no drive claims the row again. [Retry an attachment](./attachment-retry.md) is the only way back into the queue. [Common errors](../../attachments/media-and-attachments.md#common-errors) lists what each failure usually means.

## Related reference

- [Attach a file](./from-file.md)
- [Watch an attachment](./watch.md)
- [Resolve a download](./resolve-download.md)
- [Retry an attachment](./attachment-retry.md)
- [Cancel an attachment](./attachment-cancel.md)
- [Remove an attachment](./attachment-remove.md)
- [Vacuum attachments](./vacuum.md)
- [Swift: Get attachment status](../swift/get-status.md)
- [Kotlin: Get attachment status](../kotlin/get-status.md)
