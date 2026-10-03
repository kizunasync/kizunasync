---
title: Watch an attachment
description: Receive a status snapshot on every transition of one attachment.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Watch an attachment

`attachments.watch(ref, callback)` subscribes to one attachment and returns the function that unsubscribes. The callback receives a fresh status snapshot on every transition of that reference, and nothing else on the screen re-renders.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export function showUploadProgress(imagePath: string, label: HTMLElement): () => void {
  return kizunasync.attachments.watch(imagePath, (status) => {
    label.textContent = `${status.progress}%`
  })
}
```

The callback runs until the returned function is called, so hold it wherever the screen's teardown lives.

### Read the current value first

```ts
// src/todo-list.ts
import type { TAttachmentStatus } from 'kizunasync'
import { kizunasync } from './kizunasync'

export async function followImage(imagePath: string, render: (status: TAttachmentStatus) => void): Promise<() => void> {
  const current = await kizunasync.attachments.getStatus(imagePath)

  if (current !== null) {
    render(current)
  }
  return kizunasync.attachments.watch(imagePath, render)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `ref` | `string` | Yes | The Storage object key stored in the row's attachment column. Subscribing to a reference the queue has never seen is allowed, and the callback waits. |
| `callback` | `(status: TAttachmentStatus) => void` | Yes | Called with the snapshot [Get attachment status](./get-status.md#returns) describes, including `permanent` and `attempts`. Several callbacks may watch the same reference. |

## Returns

`() => void`, the unsubscribe function. Call it when the component goes away, and the last unsubscribe for a reference releases its subscriber set. Five kinds of transition raise a callback.

| Name | Type | Required | Description |
|---|---|---|---|
| Enqueue | — | — | Raised when [Attach a file](./from-file.md) writes the queue row, so a preview can appear immediately. |
| Progress | `number` | — | Raised on each progress tick a resumable upload reports. A single-shot upload reports once, at completion. |
| Settlement | `TAttachmentState` | — | Raised when the entry reaches `synced`, `failed`, or `orphaned`, and when a claimed upload is released back to `queued` because the row column does not name it. |
| Download | `TAttachmentState` | — | Raised when [Resolve a download](./resolve-download.md) completes or fails a fetch for this reference. |
| Budget stop | `TAttachmentState` | — | Raised when a claim finds the transfer budget already spent: `permanent` turns `true` with no transfer attempt of its own to report. |
| App control | — | — | Raised by [Retry an attachment](./attachment-retry.md), [Cancel an attachment](./attachment-cancel.md), and [Remove an attachment](./attachment-remove.md), so a subscriber sees the same row change whether the app or the queue caused it. |

## Errors

`watch` throws nothing. On an app client built with attachment ports, the call opens the engine when it is the client's first use. When that open fails, on this call or an earlier one, `watch` returns an unsubscribe that does nothing and the callback never runs, while the client's other calls reject with the open's typed error, such as `ENGINE_UNAVAILABLE` or `STORE_BUSY`, which [Initializing](./initializing.md#errors) lists. On an app client built without both the `fileStore` and `transfer` ports, `watch` returns the same inert unsubscribe.

## Notes

The first callback arrives on the next transition, so a fresh subscription has nothing to show. Read the current value once with [Get attachment status](./get-status.md) when the UI needs something on screen immediately.

This subscription is deliberately outside the engine event stream. A byte-level progress tick raised through [Subscribe to events](./on.md) would re-render every query bound to that client, several times a second, for a change that concerns one image.

When the queue row is gone, the subscription skips that snapshot rather than delivering `null`. A purge during [Vacuum attachments](./vacuum.md) is what removes the row. React and [Expo](https://expo.dev) apps get the same behavior from [React: useAttachment](../react/use-attachment.md), which pairs this method with a resolve and re-renders only the component showing the file.

## Related reference

- [Get attachment status](./get-status.md)
- [Attach a file](./from-file.md)
- [Resolve a download](./resolve-download.md)
- [Retry an attachment](./attachment-retry.md)
- [Cancel an attachment](./attachment-cancel.md)
- [Remove an attachment](./attachment-remove.md)
- [Subscribe to events](./on.md)
- [Swift: Watch an attachment](../swift/watch.md)
- [Kotlin: Watch an attachment](../kotlin/watch.md)
