---
title: Native download
description: Replace the transfer port's download half with one that reads real binary on React Native.
status: alpha
docType: reference
library: expo
pageKind: method
audience: app-developer
---

# Expo: Native download

`createExpoSupabaseDownload` returns the `download` function of the transfer port, implemented for iOS and Android. An app with an attachment column calls it once, in `src/kizunasync.ts`, where it replaces the download half of the Storage transfer passed to `createSupabaseKizunaSync`; nothing else in the app calls it. An app needs this page when it syncs an attachment column on React Native, or to diagnose an error a download raises.

It reads a peer's attachment over a short-lived signed URL with [Expo](https://expo.dev)'s own fetch, verifies the bytes, and writes them into the file store. The other four transfer methods need no native override, so the app composes this one over `createSupabaseTransfer`.

## Examples

### Basic

The call sits in `src/kizunasync.ts`, next to the file store.

```ts
// src/kizunasync.ts (excerpt)
import { openExpoFileStore } from '@kizunasync/expo/file-store'
import { createExpoSupabaseDownload } from '@kizunasync/expo/transfer'
import { supabase } from './supabase-client'

const fileStore = openExpoFileStore()
const download = createExpoSupabaseDownload({ client: supabase, fileStore })
```

### Compose the whole transfer port

This is `src/kizunasync.ts` from [Initializing](./initializing.md) with attachments added. The `transfer` option spreads `createSupabaseTransfer` and replaces its `download` key with this function.

```ts
// src/kizunasync.ts
import { attachment, byOwner, defineConfig } from '@kizunasync/core'
import { openExpoDriver } from '@kizunasync/expo'
import { openExpoFileStore } from '@kizunasync/expo/file-store'
import { createExpoSupabaseDownload } from '@kizunasync/expo/transfer'
import { createSupabaseKizunaSync, createSupabaseTransfer } from '@kizunasync/supabase'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: {
    todos: {
      sync: 'read-write',
      bucket: byOwner('user_id'),
      attachments: { image_path: attachment('todo-images') },
    },
  },
})

const fileStore = openExpoFileStore()
const ports = { client: supabase, fileStore }

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: openExpoDriver('todos.db'),
  config,
  fileStore,
  transfer: { ...createSupabaseTransfer(ports), download: createExpoSupabaseDownload(ports) },
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `options` | `object` | Yes | The client, the file store, and the optional logger and deadlines. |
| `options.client` | `SupabaseClient` | Yes | The authenticated supabase-js client. Its session decides which objects the signed URL request may sign, so Storage policies apply. |
| `options.fileStore` | `IFileStore` | Yes | Where the verified bytes are written, through `writeAtomic`. Open it with [`openExpoFileStore()`](./open-expo-file-store.md). |
| `options.logger` | `ILogger` | No | Sink for one debug line per completed download, carrying the byte count and the object path. Default: a logger that discards every line. |
| `options.controlTimeoutMs` | `number` | No | Deadline for the signed-URL request. A value at or below `0` disables it. Default: `DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS` (`30000`) from `@kizunasync/core`. This adapter and [`createSupabaseTransfer`](../javascript/create-supabase-transfer.md#parameters) share that same constant, so both use one deadline policy. |
| `options.bytesTimeoutMs` | `number` | No | Deadline for the request that carries the bytes, aborted through a real `AbortSignal` when it fires. A value at or below `0` disables it. Default: `DEFAULT_TRANSFER_BYTES_TIMEOUT_MS` (`120000`) from `@kizunasync/core`, shared with `createSupabaseTransfer`: a 6 MiB body on a slow mobile link needs more than a control request does. |
| `options.setTimer` / `options.clearTimer` | `(callback: () => void, delayMs: number) => unknown` / `(handle: unknown) => void` | No | Timer pair threaded into both deadlines. Default: the platform `setTimeout` and `clearTimeout`. |

The returned function takes the arguments the port defines.

| Name | Type | Required | Description |
|---|---|---|---|
| `target.bucket` | `string` | Yes | The Storage bucket holding the object. |
| `target.path` | `string` | Yes | The object key inside that Storage bucket, which is the attachment ref stored in the row column. |
| `toLocalPath` | `string` | Yes | The sandbox path the bytes are written to, chosen by the attachment queue. |
| `options.sha256` | `string` | No | The expected content hash. When present, the bytes are verified before they are written, so a corrupt transfer cannot poison the [content-addressed](https://grokipedia.com/page/Content-addressable_storage) cache. Default: none, and no verification. |

## Returns

`ITransfer['download']`, a function returning `Promise<void>` that resolves once the bytes are written to the file store. It reports no progress of its own; the attachment queue tracks state per ref, which [useAttachment](../react/use-attachment.md) reads.

## Errors

Every failure is thrown, and the attachment queue decides what to do with it from the `code` the error carries.

| Code | Condition |
|---|---|
| `ATTACHMENT_NOT_YET_AVAILABLE` | The signed URL request or the byte read returned 404, which means the uploading device has not pushed the bytes. The queue re-queues the download rather than failing it, and the attempt still counts against the budget. The sign path throws `attachment not available: <message>` and the read path throws `attachment fetch failed: 404`; both carry the code. Supabase documents that status in [404 NotFound](https://supabase.com/docs/guides/storage/debugging/error-codes#404-notfound). |
| `ATTACHMENT_TRANSFER_TIMEOUT`, message `attachment sign timed out after <ms>ms` or `attachment download timed out after <ms>ms` | `controlTimeoutMs` or `bytesTimeoutMs` elapsed before the request settled. The byte read is aborted through the `AbortSignal`; the sign request may still land after the deadline, which is harmless because the retry re-signs. |
| No code, message `attachment sign failed (<status>): <message>` | The signed URL request failed for any other reason, including 401, 403, and 5xx. The queue records the download as failed and retries on a later sync. |
| No code, message `attachment fetch failed: <status>` | The signed URL answered with a status other than 200 or 404. |
| `ATTACHMENT_HASH_MISMATCH`, message `attachment sha256 mismatch for <path>` | The bytes were read whole and hashed to something other than the expected value, checked before anything is written. |

## Notes

The override reads the bytes with Expo's fetch, a WHATWG-compliant client with real binary support, so `response.arrayBuffer()` yields them directly, with no `Blob` round-trip. [React Native](https://reactnative.dev) forbids building a `Blob` from an `ArrayBuffer`, which is what supabase-js `download()` does. On Expo web the app passes no `transfer`, and `createSupabaseKizunaSync` builds the Storage transfer over the [browser file store](../javascript/create-web-file-store.md).

The read goes over a signed URL that lasts 60 seconds, which works for a public Storage bucket and a private one alike because the signature is issued under the caller's own session. Supabase documents the request in [`createSignedUrl`](https://supabase.com/docs/reference/javascript/file-buckets-createsignedurl#parameters) and the plain read in [Downloading](https://supabase.com/docs/guides/storage/serving/downloads#downloading). Kizuna adds the verification and the atomic write: the hash is checked before the file lands, so a partial or wrong body never becomes a cached attachment.

Uploads, confirmation, metadata, and removal stay on `createSupabaseTransfer`, which is why the second example spreads it and replaces one key. Storage policies on `storage.objects` decide what the session may read, as [Access control](https://supabase.com/docs/guides/storage/security/access-control#access-policies) describes.

Import this module from `@kizunasync/expo/transfer` rather than the package root.

That import path keeps `expo/fetch` and the supabase-js peer out of the resolution graph for an app without attachments.

## Related reference

- [File store](./open-expo-file-store.md)
- [Initializing](./initializing.md)
- [JavaScript: Create the Storage transfer](../javascript/create-supabase-transfer.md)
- [JavaScript: Resolve a download](../javascript/resolve-download.md)
