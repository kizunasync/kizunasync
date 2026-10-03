---
title: Retry an attachment
description: Forgive the transfer budget on one attachment and put it back in the queue.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Retry an attachment

`attachments.retry(ref)` forgives the transfer budget on one reference: the row returns to `queued` with its attempts cleared and `permanent` off, so the next drive or resolve takes it again. Call it after a transfer stopped for good and the person using the app asks to try once more.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function retryUpload(imagePath: string): Promise<void> {
  await kizunasync.attachments.retry(imagePath)
}
```

### Retry only a stopped transfer

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function retryStoppedUpload(imagePath: string): Promise<void> {
  const status = await kizunasync.attachments.getStatus(imagePath)

  if (status?.permanent) {
    await kizunasync.attachments.retry(imagePath)
  }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `ref` | `string` | Yes | The Storage object key stored in the row's attachment column, the same `ref` [Attach a file](./from-file.md) returned or a peer's row carries. |

## Returns

`Promise<void>` that settles once the row is written. A reference the queue has never seen is a no-op: nothing is created and no error is thrown.

## Errors

On an app client built with attachment ports, the call opens the engine when it is the client's first use. When that open fails, on this call or an earlier one, the call rejects with the open's typed error, such as `ENGINE_UNAVAILABLE` or `STORE_BUSY`, which [Initializing](./initializing.md#errors) lists. Apart from that, this method throws nothing. On an app client built without both the `fileStore` and `transfer` ports, it rejects with `ATTACHMENT_PORTS_MISSING`, as every attachment method does; [Troubleshooting](../../operations/troubleshooting.md#attachment_ports_missing) shows the fix.

## Notes

`retry` clears the budget on every call, whether or not `permanent` was set. Calling it on a row that is only `queued` or already `synced` costs nothing beyond the write.

`retry` wakes the automatic loop once the row is written, so an upload goes out on that [sync](./sync.md) run, which drives the queue once the outbox has drained. On a web tab that is not running the engine, the retried upload goes out when the engine's tab next wakes or polls. A download is lazy: no run fetches its bytes, and the entry stays queued until something asks for it.

Pair `retry` with [Resolve a download](./resolve-download.md) to fetch those bytes. [React: useAttachment](../react/use-attachment.md) does both in one step, because its `retry` action calls this method and then prefetches.

Retrying is forgiveness, not a diagnosis. `attempts` in [Get attachment status](./get-status.md#returns) still reports the count this device spent before the row stopped; nothing here rewrites the history, only the row's own claimability.

## Related reference

- [Get attachment status](./get-status.md)
- [Cancel an attachment](./attachment-cancel.md)
- [Remove an attachment](./attachment-remove.md)
- [Sync](./sync.md)
- [Swift: Retry an attachment](../swift/attachment-retry.md)
- [Kotlin: Retry an attachment](../kotlin/attachment-retry.md)
