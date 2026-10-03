---
title: Upload with TUS
description: Send bytes to Supabase Storage over the resumable protocol, chunk by chunk.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Upload with TUS

`tusUpload(options)` from `kizunasync/supabase` implements the [TUS](https://tus.io) subset [Supabase Storage resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) documents: a 6 MiB chunk size, the `bucketName`/`objectName`/`contentType`/`cacheControl` metadata, and a Bearer token. [Create the Storage transfer](./create-supabase-transfer.md) calls it for every upload over its single-shot threshold; call it directly only when assembling a transfer adapter by hand.

## Examples

### Basic

```ts
// src/storage-transfer.ts
import { tusEndpointFromSupabaseUrl, tusUpload, type TTusUploadResult } from 'kizunasync/supabase'
import { supabase } from './supabase-client'

export async function uploadImage(objectName: string, bytes: Uint8Array): Promise<TTusUploadResult> {
  const { data } = await supabase.auth.getSession()

  if (data.session === null) {
    throw new Error('Sign in before uploading.')
  }
  return tusUpload({
    endpoint: tusEndpointFromSupabaseUrl(import.meta.env.VITE_SUPABASE_URL),
    accessToken: data.session.access_token,
    bucket: 'todo-images',
    objectName,
    contentType: 'image/jpeg',
    data: bytes,
  })
}
```

### Resume a session a prior attempt started

```ts
// src/storage-transfer.ts
import { tusUpload, type TTusUploadOptions, type TTusUploadResult } from 'kizunasync/supabase'

export async function uploadResumably(options: TTusUploadOptions): Promise<TTusUploadResult> {
  const resumeKey = `tus-upload:${options.objectName}`
  const result = await tusUpload({
    ...options,
    resumeUrl: localStorage.getItem(resumeKey) ?? undefined,
    onSessionCreated: (uploadUrl) => localStorage.setItem(resumeKey, uploadUrl),
  })

  localStorage.removeItem(resumeKey)

  return result
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `endpoint` | `string` | Yes | The resumable upload endpoint. `tusEndpointFromSupabaseUrl(supabaseUrl)`, listed below, derives it from a project URL. |
| `accessToken` | `string` | Yes | Bearer for the session create, the offset probe, and every chunk. |
| `bucket` | `string` | Yes | The Storage bucket name. |
| `objectName` | `string` | Yes | The object key within that Storage bucket. |
| `contentType` | `string` | Yes | Recorded on the object and sent as TUS metadata. |
| `data` | `Uint8Array` | Yes | The full object bytes, or a view of them. |
| `resumeUrl` | `string` | No | A TUS upload URL a prior attempt reported through `onSessionCreated`. The offset is probed before any bytes move; an expired session falls back to a fresh create. Default: none, always creates a new session. |
| `upsert` | `boolean` | No | Overwrite an existing object at the same key. Default: `false`. |
| `cacheControl` | `string` | No | Sent as TUS metadata. Default: none. |
| `onProgress` | `(bytesUploaded: number, bytesTotal: number) => void` | No | Called after each chunk PATCH settles. Default: none. |
| `onSessionCreated` | `(uploadUrl: string) => void` | No | Called once, before the first chunk, with the session's TUS location. Persist it to resume an interrupted upload later. Default: none. |
| `signal` | `AbortSignal` | No | Aborts every request this call makes. Default: none. |
| `requestTimeoutMs` | `number` | No | Deadline for the control requests: the offset probe and the session create. A value at or below `0` disables it. Default: none, no deadline. |
| `bytesTimeoutMs` | `number` | No | Deadline for each 6 MiB chunk PATCH. Kept separate from `requestTimeoutMs`, because a chunk on a slow link legitimately takes longer than a control request. Default: none, no deadline. |
| `setTimer` / `clearTimer` | `(callback: () => void, delayMs: number) => unknown` / `(handle: unknown) => void` | No | Injectable timer pair. Default: the platform `setTimeout` and `clearTimeout`. |

## Returns

`Promise<TTusUploadResult>`, settled once every chunk has landed.

| Name | Type | Required | Description |
|---|---|---|---|
| `uploadUrl` | `string` | — | The session's TUS location, the same value `onSessionCreated` reported. |
| `bytesUploaded` | `number` | — | The total bytes confirmed by the server, equal to `data.byteLength` on success. |

### The two exported constants and the endpoint helper

| Name | Type | Required | Description |
|---|---|---|---|
| `TUS_CHUNK_SIZE` | `number` | — | `6291456` (6 MiB), the chunk size the protocol requires. |
| `SINGLE_SHOT_MAX_BYTES` | `number` | — | Equal to `TUS_CHUNK_SIZE`, the size at which [Create the Storage transfer](./create-supabase-transfer.md#parameters) switches from a single-shot upload to this one. |
| `tusEndpointFromSupabaseUrl(supabaseUrl)` | `(supabaseUrl: string) => string` | — | The project URL followed by `/storage/v1/upload/resumable`, or, for a `*.supabase.co` host, `https://<ref>.storage.supabase.co/storage/v1/upload/resumable` instead. |

## Errors

| Code | Condition |
|---|---|
| `ATTACHMENT_UPLOAD_EXPIRED` | The offset probe on a `resumeUrl` answered `404` or `410`. `tusUpload` catches this one internally and starts a fresh session; it only reaches the caller from a probe made outside this function. |
| `ATTACHMENT_TRANSFER_TIMEOUT` | `requestTimeoutMs` or `bytesTimeoutMs` elapsed before a session create, an offset probe, or a chunk PATCH settled. |
| (untagged) | A session create, an offset probe, or a chunk PATCH failed for any other status. |

## Notes

The offset probe runs before any bytes move when `resumeUrl` is set, so an upload that was interrupted mid-chunk resumes from the confirmed offset rather than restarting. Every chunk after the first is exactly `TUS_CHUNK_SIZE` except the last, which carries the remainder.

This client is pure `fetch`, with no `tus-js-client` dependency, so the same code path runs on the web, on Node, and on [React Native](https://reactnative.dev).

## Related reference

- [Create the Storage transfer](./create-supabase-transfer.md)
- [Attach a file](./from-file.md)
- [Initializing](./initializing.md)
