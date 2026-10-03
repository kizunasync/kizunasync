---
title: useAttachment
description: Track one attachment ref's state, progress, and local URI, and drive its download.
status: alpha
docType: reference
library: vue
pageKind: method
audience: app-developer
---

# Vue: useAttachment

`useAttachment` follows one attachment ref. It reports the ref's queue state, its transfer progress, the local URI to render, and the last failure. It subscribes to the queue's per-ref watch rather than to the engine's event stream, so a progress tick updates the refs that show the file and no other reactive read.

## Examples

### Basic

```ts
// src/components/TodoImageStatus.vue (script setup)
import { useAttachment } from 'kizunasync/vue'

const props = defineProps<{ imageRef: string | null }>()
const { state, progress, error } = useAttachment(() => props.imageRef)
```

### Render the three states

```vue
<!-- src/components/TodoImage.vue -->
<script setup lang="ts">
import { useAttachment } from 'kizunasync/vue'

const props = defineProps<{ imageRef: string | null }>()
const { state, progress, localUri, retry } = useAttachment(() => props.imageRef)
</script>

<template>
  <img v-if="localUri !== null" :src="localUri" alt="" />
  <span v-else-if="state === 'uploading' || state === 'downloading'">{{ progress }}%</span>
  <button v-else-if="state === 'failed'" @click="retry">Retry</button>
</template>
```

### A stopped transfer, with retry and remove

```vue
<!-- src/components/TodoThumb.vue -->
<script setup lang="ts">
import { useAttachment } from 'kizunasync/vue'

const props = defineProps<{ imageRef: string | null }>()
const { state, permanent, attempts, retry, remove } = useAttachment(() => props.imageRef)
</script>

<template>
  <div v-if="state === 'failed' && permanent">
    <span>Image stopped after {{ attempts }} tries</span>
    <button @click="retry">Retry</button>
    <button @click="remove">Remove</button>
  </div>
</template>
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `attachmentRef` | `MaybeRefOrGetter<string \| null \| undefined>` | Yes | The attachment ref stored in the row column, which is the Storage object key [`fromFile`](../javascript/from-file.md) returned. A plain string is read once; a ref, a computed, or a getter is followed, and a new value swaps the subscription to that ref. `null` or `undefined` leaves it idle with no subscription, which is what a row renders before a file is picked. |
| `opts` | `IUseKizunaSyncOptions` | No | Client override. Default: the provided client. |
| `opts.client` | `IKizunaSync` | No | Used instead of the client seeded by [`createKizunaSyncPlugin` or `provideKizunaSync`](./initializing.md), resolved through [useKizunaSync](./use-kizunasync.md). Default: the provided client. |

## Returns

`IUseAttachmentResult`. The six state fields are refs; `retry`, `cancel`, `remove`, and `prefetch` are plain functions.

| Name | Type | Required | Description |
|---|---|---|---|
| `state` | `Ref<TAttachmentState \| 'idle'>` | — | The queue row's state: `queued`, `uploading`, `synced`, `downloading`, `failed`, or `orphaned`. `idle` when the ref is `null` or `undefined`, when the client was built without the file and transfer ports, or before the first status read resolves. [Attachment state lifecycle](../../attachments/media-and-attachments.md#attachment-state-lifecycle) describes each transition. |
| `progress` | `Ref<number>` | — | Transfer progress from `0` to `100`, updated as bytes move and set to `100` when the upload confirms. `0` while idle. |
| `localUri` | `Ref<string \| null>` | — | A renderable URI for the sandbox file, `file:` on native and a `blob:` object URL on web. Present at once for a file this device imported, and after a download lands for a peer's file. `null` while the bytes are not on this device. |
| `error` | `Ref<string \| null>` | — | The message the last failed transfer recorded, kept until the next attempt clears it. A string rather than an `Error`, because it is read back from the queue row. |
| `permanent` | `Ref<boolean>` | — | `true` when `state` is `failed` because the transfer budget, [`attachmentAttempts`](../javascript/define-config.md#parameters) in `defineConfig`, is spent. Only `retry` moves the row again. `false` for every other reason, including a transfer this composable's own `cancel` stopped. |
| `attempts` | `Ref<number>` | — | Transfer attempts this row has consumed so far, out of the configured budget. |
| `retry` | `() => void` | — | Forgives the transfer budget through [`retry(ref)`](../javascript/attachment-retry.md), then prefetches. Use it on a `failed` ref whether or not it is `permanent`: on a live budget it starts the transfer again. |
| `cancel` | `() => void` | — | Stops an in-flight transfer through [`cancel(ref)`](../javascript/attachment-cancel.md). The row lands `failed` and stays retryable, and no attempt is charged. |
| `remove` | `() => void` | — | Forgets the reference and its sandbox bytes through [`remove(ref)`](../javascript/attachment-remove.md). The remote object is untouched; [Vacuum attachments](../javascript/vacuum.md) is what removes that. |
| `prefetch` | `() => void` | — | Calls [`resolveDownload`](../javascript/resolve-download.md) for this ref and refreshes the status when it settles. Fetching a ref that is already in flight is a no-op, because the queue deduplicates it. |

## Errors

Nothing is thrown past the client resolution, and neither `retry` nor `prefetch` rejects. A transfer failure lands in `error` with `state` set to `failed`, which leaves retry to the caller rather than looping.

| Code | Condition |
|---|---|
| `ATTACHMENT_PORTS_MISSING` | [`createSupabaseKizunaSync`](../javascript/initializing.md) throws it when a table declares an attachment column and the client was built without both the file store and the transfer port. A client built without them and with no attachment column reaches the composable, which keeps `state` at `idle` and, once it follows a ref, reports the code's message in `error`: `createKizunaSync was called without both fileStore and transfer ports, so this app client has no attachment queue`. [ATTACHMENT_PORTS_MISSING](../../operations/troubleshooting.md#attachment_ports_missing) lists the two ports to pass. |

A composable that runs outside the provide scope and passes no `{ client }` override throws from [useKizunaSync](./use-kizunasync.md).

## Notes

The argument accepts a plain string, a ref, a computed, or a getter, which is the same set `toValue` accepts. When the value changes, the composable unsubscribes from the old ref, resets the four state refs to idle, and subscribes to the new one, so no field carries over from the attachment you were showing before. A prop reaches it as `() => props.imageRef` rather than `props.imageRef`, because the second form passes the value the prop held at setup. This matches [React: useAttachment](../react/use-attachment.md), which follows its `ref` argument across renders.

A read or download started for the previous ref is dropped rather than committed onto the current one, so a slow download that lands after you moved on leaves the current attachment alone. `retry` and `prefetch` act on whichever ref is current when you call them.

The first view of a ref with no local bytes starts one download on its own, once each time it becomes the current ref after a different missing ref was fetched. That is the lazy fetch: a peer's file arrives when a component asks to show it, not when the row syncs. A failure does not re-arm the fetch, so the `failed` state and `retry` are the recovery path.

`retry` and `prefetch` are two different calls: `prefetch` only asks for the download again, which is a no-op on a `permanent` row because no drive claims it, while `retry` clears the budget first. Calling `retry` is therefore always the safer control on a `failed` ref, `permanent` or not.

Uploads run the other way: [`fromFile`](../javascript/from-file.md) imports the picked file into the sandbox and returns the ref plus an immediate `localUri`, so the image renders before any byte moves, and [`sync()`](../javascript/sync.md) drives the upload after the outbox drains, which [Media and attachments](../../attachments/media-and-attachments.md#5-bytes-upload-after-the-outbox-drains) walks in order.

Supabase Storage owns the bucket, the object, and the policies on `storage.objects`, which [Access control](https://supabase.com/docs/guides/storage/security/access-control#access-policies) documents. Kizuna adds the queue in front of it: the ref reaches the server with the row, the bytes follow on a later run, and the composable reports where in that order this ref stands.

## Related reference

- [useQuery](./use-query.md)
- [useKizunaSync](./use-kizunasync.md)
- [JavaScript: Get attachment status](../javascript/get-status.md)
- [JavaScript: Watch an attachment](../javascript/watch.md)
- [JavaScript: Resolve a download](../javascript/resolve-download.md)
- [JavaScript: Retry an attachment](../javascript/attachment-retry.md)
- [JavaScript: Cancel an attachment](../javascript/attachment-cancel.md)
- [JavaScript: Remove an attachment](../javascript/attachment-remove.md)
- [React: useAttachment](../react/use-attachment.md)
