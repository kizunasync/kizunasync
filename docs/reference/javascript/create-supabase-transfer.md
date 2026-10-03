---
title: Create the Storage transfer
description: Move attachment bytes through Supabase Storage and record their integrity metadata.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Create the Storage transfer

`createSupabaseTransfer(options)` from `kizunasync/supabase` builds the byte mover the attachment queue drives. It uploads through Supabase Storage, downloads through a short-lived signed URL, and records each object's hash so a peer can verify what it downloaded.

The `createSupabaseKizunaSync` call in `src/kizunasync.ts`, shown on [Initializing](./initializing.md#with-attachments), builds this adapter by itself once it receives a `fileStore`, so an app calls this factory only to change one of the values below, and passes the result as `transfer` in that same file. Read this page to see how bytes move, how long each request may take, and which errors an attachment entry records.

## Examples

### Basic

```ts
// src/kizunasync.ts (excerpt)
import { createSupabaseTransfer } from 'kizunasync/supabase'
import { createWebFileStore } from 'kizunasync/web'
import { supabase } from './supabase-client'

const fileStore = createWebFileStore()
const transfer = createSupabaseTransfer({ client: supabase, fileStore })
```

### Pass it to the client

The whole module, here giving large files on slow links more time:

```ts
// src/kizunasync.ts
import { attachment, byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync, createSupabaseTransfer } from 'kizunasync/supabase'
import { createWebFileStore, createWebWorkerDriver } from 'kizunasync/web'
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

const fileStore = createWebFileStore()

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
  fileStore,
  transfer: createSupabaseTransfer({ client: supabase, fileStore, bytesTimeoutMs: 300_000 }),
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `options.client` | `SupabaseClient` | Yes | The supabase-js client. Its Storage slice moves the bytes, its `kizunasync` schema records the metadata, and its session authorizes both. A resumable upload started with no session falls back to the client's publishable key as the Bearer. |
| `options.fileStore` | `IFileStore` | Yes | The local sandbox the bytes are read from and written to. [Browser file store](./create-web-file-store.md) provides one for the web. |
| `options.controlTimeoutMs` | `number` | No | Deadline for the short requests: the session lookup, the resumable create and offset probe, the signed URL, the confirm call, the metadata lookup, and the two removals. A value at or below `0` disables it. Default: `DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS` (`30000`) from `kizunasync`, shared with [Expo: Native download](../expo/create-expo-supabase-download.md#parameters). |
| `options.bytesTimeoutMs` | `number` | No | Deadline for the requests that carry bytes: the single-shot upload, each resumable chunk, and the download. A value at or below `0` disables it. Kept separate because a 6 MiB body on a mobile link legitimately takes longer than a control request. Default: `DEFAULT_TRANSFER_BYTES_TIMEOUT_MS` (`120000`) from `kizunasync`, shared with [Expo: Native download](../expo/create-expo-supabase-download.md#parameters). |
| `options.logger` | `ILogger` | No | Sink for the adapter's byte counts and outcomes. Default: silent. |
| `options.singleShotMaxBytes` | `number` | No | The size at which the upload switches to the resumable protocol. Intended for tests; the value the protocol requires is the default. Default: `6291456`, which is 6 MiB. |
| `options.tusEndpoint` | `string` | No | Overrides the resumable endpoint. Intended for tests. Default: the project URL followed by `/storage/v1/upload/resumable`, or, when that URL is a `*.supabase.co` host, `https://<ref>.storage.supabase.co/storage/v1/upload/resumable`. |
| `options.setTimer` / `options.clearTimer` | `(callback: () => void, delayMs: number) => unknown` / `(handle: unknown) => void` | No | Timer pair threaded into every deadline this adapter arms. Default: the platform `setTimeout` and `clearTimeout`. |

## Returns

`ITransfer`, the value [Initializing](./initializing.md#parameters) takes as its `transfer` argument.

| Name | Type | Required | Description |
|---|---|---|---|
| `createUpload` | `(localPath, target, options) => Promise<IUploadHandle>` | — | Sends a file at or under the threshold as one [standard upload](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading) with overwrite enabled, and anything larger as a [resumable upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) in 6 MiB chunks. The session URL is announced before the first chunk moves, so the queue persists it in case the transfer is interrupted. |
| `download` | `(target, toLocalPath, options?) => Promise<void>` | — | Signs the object for 60 seconds, fetches it, verifies the bytes against the expected hash, and writes them to the sandbox only then. The signed URL is used rather than the SDK download because [React Native](https://reactnative.dev) cannot build a blob the SDK way. |
| `confirm` | `(target, meta) => Promise<void>` | — | Records the object's hash, size, and content type through the `attachment_confirm` function, which is what lets a peer verify its download. |
| `metadata` | `(target) => Promise<{ sha256: string } \| null>` | — | Reads the recorded hash for one object through the definer RPC `kizunasync.attachment_metadata`, or `null` when the server has none. The RPC checks that the caller can read the owning row's table through [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) before it answers, which is what lets a peer verify a download it did not upload; the table itself grants no `SELECT` to a client role. |
| `remove` | `(target) => Promise<void>` | — | Deletes the Storage object and then clears its metadata through the `attachment_vacuum` function. |

## Errors

This adapter throws every failure to the queue, which records it on the attachment entry and retries on a later run.

| Code | Condition |
|---|---|
| `ATTACHMENT_TRANSFER_TIMEOUT` | A request outlived `controlTimeoutMs` or `bytesTimeoutMs`. |
| `AUTH_SESSION_TIMEOUT` | The session lookup before a resumable upload outlived `controlTimeoutMs`. |
| `ATTACHMENT_NOT_YET_AVAILABLE` | The object answered `404`, which Supabase documents under [error codes](https://supabase.com/docs/guides/storage/debugging/error-codes#404-notfound). The download entry stays queued rather than failing, because the writing device has probably not uploaded it, and the attempt still counts against the budget. |
| `ATTACHMENT_UPLOAD_EXPIRED` | The resumable session answered `404` or `410`, so it cannot be resumed. The port documents the session as valid for up to 24 hours; the client detects the end of it from the status rather than from a clock. The stored session URL is dropped and the next attempt starts from zero. |
| `ATTACHMENT_HASH_MISMATCH` | The downloaded bytes hashed to something other than the expected value, checked before anything is written to the sandbox. |
| (untagged) | A refused upload, a signed URL that failed for any other status, a rejected confirm or vacuum call, or a resumable upload started with no session and no publishable key configured either. |

## Notes

A single-shot upload cannot be aborted, because the Storage client exposes no signal for it. The deadline therefore bounds only how long this adapter waits, and a request that times out may land on the server regardless. That is harmless: the retry re-uploads with overwrite enabled.

Nothing here decides who may read or write an object. The bucket's own policies on `storage.objects` do, and [Storage policies](../../attachments/media-and-attachments.md#storage-policies) shows the rules the attachment path needs.

On iOS and Android the platform fetch differs, so [Expo: Native download](../expo/create-expo-supabase-download.md) replaces the download half. It supplies that one method, and the other four stay as they are.

The queue drives this adapter only from a full [Sync](./sync.md), after the outbox has drained, so the row already carries the reference when the object appears. Downloads are lazy and run from [Resolve a download](./resolve-download.md) instead.

## Related reference

- [Initializing](./initializing.md)
- [Attach a file](./from-file.md)
- [Resolve a download](./resolve-download.md)
- [Browser file store](./create-web-file-store.md)
- [Vacuum attachments](./vacuum.md)
