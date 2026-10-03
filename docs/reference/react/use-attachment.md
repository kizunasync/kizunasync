---
title: useAttachment
description: Track one attachment ref's state, progress, and local URI, and drive its download.
status: alpha
docType: reference
library: react
pageKind: method
audience: app-developer
---

# React: useAttachment

`useAttachment` follows one attachment ref: its queue state, its transfer progress, the local URI to render, and the last failure. It subscribes to the queue's per-ref watch rather than to the engine's event stream, so a progress tick re-renders the component that shows the file and nothing else.

## Examples

### Basic

```tsx
// src/components/todo-image-status.tsx
import { useAttachment } from 'kizunasync/react'

export function TodoImageStatus({ imagePath }: { imagePath: string | null }) {
  const { state, progress, error } = useAttachment(imagePath)

  return <span>{error ?? `${state} ${progress}%`}</span>
}
```

### Render the three states

```tsx
// src/components/todo-image.tsx
import { useAttachment } from 'kizunasync/react'

export function TodoImage({ imageRef }: { imageRef: string | null }) {
  const { state, progress, localUri, retry } = useAttachment(imageRef)

  if (localUri !== null) return <img src={localUri} alt="" />
  if (state === 'uploading' || state === 'downloading') return <span>{progress}%</span>
  if (state === 'failed') return <button onClick={retry}>Retry</button>
  return null
}
```

### A stopped transfer, with retry and remove

```tsx
// src/components/todo-thumb.tsx
import { useAttachment } from 'kizunasync/react'

export function TodoThumb({ imageRef }: { imageRef: string | null }) {
  const { state, permanent, attempts, retry, remove } = useAttachment(imageRef)

  if (state !== 'failed' || !permanent) return null
  return (
    <div>
      <span>Image stopped after {attempts} tries</span>
      <button onClick={retry}>Retry</button>
      <button onClick={remove}>Remove</button>
    </div>
  )
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `ref` | `string \| null \| undefined` | Yes | The attachment ref stored in the row column, which is the Storage object key [`fromFile`](../javascript/from-file.md) returned. `null` or `undefined` leaves the hook idle with no subscription, which is what a row renders before a file is picked. |
| `opts` | `IClientOption` | No | Client override. Default: the context client. |
| `opts.client` | `IKizunaSync` | No | Used instead of the [`KizunaSyncProvider`](./initializing.md) client, resolved through [useKizunaSync](./use-kizunasync.md). Default: the context client. |

## Returns

`IUseAttachmentResult`.

| Name | Type | Required | Description |
|---|---|---|---|
| `state` | `TAttachmentState \| 'idle'` | — | The queue row's state: `queued`, `uploading`, `synced`, `downloading`, `failed`, or `orphaned`. `idle` when the ref is `null`, when the client was built without the file and transfer ports, or before the first status read resolves. [Attachment state lifecycle](../../attachments/media-and-attachments.md#attachment-state-lifecycle) describes each transition. |
| `progress` | `number` | — | Transfer progress from `0` to `100`, updated as bytes move and set to `100` when the upload confirms. `0` while idle. |
| `localUri` | `string \| null` | — | A renderable URI for the sandbox file, `file:` on native and a `blob:` object URL on web. Present at once for a file this device imported, and after a download lands for a peer's file. `null` while the bytes are not on this device. |
| `error` | `string \| null` | — | The message the last failed transfer recorded, kept until the next attempt clears it. A string rather than an `Error`, because it is read back from the queue row. |
| `permanent` | `boolean` | — | `true` when `state` is `failed` because the transfer budget, [`attachmentAttempts`](../javascript/define-config.md#parameters) in `defineConfig`, is spent. Only `retry` moves the row again. `false` for every other reason, including a transfer this hook's own `cancel` stopped. |
| `attempts` | `number` | — | Transfer attempts this row has consumed so far, out of the configured budget. |
| `retry` | `() => void` | — | Forgives the transfer budget through [`retry(ref)`](../javascript/attachment-retry.md), then prefetches. Use it on a `failed` ref whether or not it is `permanent`: on a live budget it starts the transfer again. |
| `cancel` | `() => void` | — | Stops an in-flight transfer through [`cancel(ref)`](../javascript/attachment-cancel.md). The row lands `failed` and stays retryable, and no attempt is charged. |
| `remove` | `() => void` | — | Forgets the reference and its sandbox bytes through [`remove(ref)`](../javascript/attachment-remove.md). The remote object is untouched; [Vacuum attachments](../javascript/vacuum.md) is what removes that. |
| `prefetch` | `() => void` | — | Calls [`resolveDownload`](../javascript/resolve-download.md) for this ref and refreshes the status when it settles. Fetching a ref that is already in flight is a no-op, because the queue deduplicates it. |

## Errors

Nothing is thrown from render, and neither `retry` nor `prefetch` rejects. A transfer failure lands in `error` with `state` set to `failed`, which leaves retry to the caller rather than looping.

| Code | Condition |
|---|---|
| `ATTACHMENT_PORTS_MISSING` | [`createSupabaseKizunaSync`](../javascript/initializing.md) throws it when a table declares an attachment column and the client was built without both the file store and the transfer port. A client built without them and with no attachment column reaches the hook, which stays `idle` and, once it follows a ref, reports the code's message in `error`: `createKizunaSync was called without both fileStore and transfer ports, so this app client has no attachment queue`. [ATTACHMENT_PORTS_MISSING](../../operations/troubleshooting.md#attachment_ports_missing) lists the two ports to pass. |

A component that renders outside [`KizunaSyncProvider`](./initializing.md) and passes no `{ client }` override throws from [useKizunaSync](./use-kizunasync.md).

## Notes

The first view of a ref with no local bytes starts one download on its own, once each time it becomes the current ref after a different missing ref was fetched. That is the lazy fetch: a peer's file arrives when a component asks to show it, not when the row syncs. A failure does not re-arm the fetch, so the `failed` state and `retry` are the recovery path.

`retry` and `prefetch` are two different calls: `prefetch` only asks for the download again, which is a no-op on a `permanent` row because no drive claims it, while `retry` clears the budget first. Calling `retry` is therefore always the safer control on a `failed` ref, `permanent` or not.

Uploads run the other way: [`fromFile`](../javascript/from-file.md) imports the picked file into the sandbox and returns the ref plus an immediate `localUri`, so the image renders before any byte moves, and [`sync()`](../javascript/sync.md) drives the upload after the outbox drains, which [Media and attachments](../../attachments/media-and-attachments.md#5-bytes-upload-after-the-outbox-drains) walks in order.

Changing the `ref` prop resubscribes and drops any status in flight for the previous one, so a list that recycles rows never shows one row's progress on another.

Supabase Storage owns the bucket, the object, and the policies on `storage.objects`, which [Access control](https://supabase.com/docs/guides/storage/security/access-control#access-policies) documents. Kizuna adds the queue in front of it: the ref reaches the server with the row, the bytes follow on a later run, and the hook reports where in that order this ref stands.

## Related reference

- [useQuery](./use-query.md)
- [useKizunaSync](./use-kizunasync.md)
- [JavaScript: Get attachment status](../javascript/get-status.md)
- [JavaScript: Watch an attachment](../javascript/watch.md)
- [JavaScript: Resolve a download](../javascript/resolve-download.md)
- [JavaScript: Retry an attachment](../javascript/attachment-retry.md)
- [JavaScript: Cancel an attachment](../javascript/attachment-cancel.md)
- [JavaScript: Remove an attachment](../javascript/attachment-remove.md)
- [Vue: useAttachment](../vue/use-attachment.md)
