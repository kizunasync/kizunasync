---
title: Media attachments
description: Add photos, documents, and other files to synced rows with offline-first upload and lazy peer downloads.
status: alpha
docType: how-to
audience: app-developer
---

# Media attachments

Attach a photo, drawing, or document to a synced row, upload the bytes after the row reaches the server, and show the file to a peer who has never seen it. The row column holds a short reference string. The bytes travel separately through the engine's [file store](../reference/javascript/create-web-file-store.md) and [transfer](../reference/javascript/create-supabase-transfer.md) ports, and never enter your row data.

Steps 1 to 4, [Declare the attachment column](#1-declare-the-attachment-column-in-your-config) through [Import the file and write the ref](#4-import-the-file-and-write-the-ref), move a file from the user's device into a synced row. Steps 5 and 6, [Bytes upload after the outbox drains](#5-bytes-upload-after-the-outbox-drains) and [Give up after too many failures](#6-give-up-after-too-many-failures-and-offer-a-way-back), cover the queue that carries the bytes and what happens when it stops trying. Steps 7 and 8, [Display the attachment](#7-display-the-attachment-with-useattachment) and [Verify it worked](#8-verify-it-worked), render the file and confirm the round trip. [Storage policies](#storage-policies), [Platform notes](#platform-notes), and [Common errors](#common-errors) are the reference you come back to afterwards.

## Before you begin

- An app client in `src/kizunasync.ts`, built with `kizunasync/supabase` over [`kizunasync`](../reference/javascript/introduction.md) and a driver ([`kizunasync/web`](../reference/javascript/create-web-worker-driver.md) or [`kizunasync/expo`](../reference/expo/introduction.md)). Add [`kizunasync/react`](../reference/react/introduction.md) or [`kizunasync/vue`](../reference/vue/introduction.md) when you want the hooks. Svelte, Solid, Angular, and every other JavaScript UI call [`kizunasync.attachments`](../reference/javascript/from-file.md) on the app client through the Vanilla / other tab.
- Swift and Kotlin apps call [`KizunaSyncClient.fromFile`](../reference/swift/from-file.md) once you set `attachmentRoot` on [`create`](../reference/swift/initializing.md). `attachmentRoot` is the directory the client owns for attachment bytes, and the client creates it if it is missing. Declaring `attachments` without that root throws [`ATTACHMENT_PORTS_MISSING`](../operations/troubleshooting.md#attachment_ports_missing). [React Native](https://reactnative.dev) over [UniFFI](https://mozilla.github.io/uniffi-rs/) omits the same setting, spelled `attachment_root` there, so the JavaScript host's attachment queue owns the bytes instead. See [Swift and Kotlin](../getting-started/native-clients.md) and [Kotlin: Attach a file](../reference/kotlin/from-file.md).
- A Supabase Storage bucket, with the policies that let your users write to it. Supabase covers those in [Storage access control](https://supabase.com/docs/guides/storage/security/access-control#access-policies), and Kizuna adds only the object key shape those policies read. The examples below use a Storage bucket named `todos`.
- The `kizunasync` [SQL pack](../reference/sql-pack.md) applied to your project. Run [`kizunasync init`](../cli/cli.md#kizunasync-init) if you have not provisioned it.

## 1. Declare the attachment column in your config

Add an `attachments` map to the table entry in your [`defineConfig`](../reference/javascript/define-config.md) call. The [`attachment(bucket, { ownerColumn })`](../reference/javascript/define-config.md#parameters) helper names the Storage bucket and the row column whose value owns the object key. The file below is the whole `src/kizunasync.ts` of a web app with one attachment column, and [step 2](#2-wire-the-file-and-transfer-ports) explains its last three statements.

```ts
// src/kizunasync.ts
import { attachment, byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync, createSupabaseTransfer } from 'kizunasync/supabase'
import { createWebFileStore, createWebWorkerDriver } from 'kizunasync/web'
import type { Database } from './database.types'
import { supabase } from './supabase-client'

const config = defineConfig<Database>({
  tables: {
    todos: {
      sync: 'read-write',
      bucket: byOwner('user_id'),
      attachments: {
        image_path: attachment('todos', { ownerColumn: 'user_id' }),
      },
    },
  },
})

const fileStore = createWebFileStore()
const transfer = createSupabaseTransfer({ client: supabase, fileStore })

export const kizunasync = createSupabaseKizunaSync({ supabase, driver: createWebWorkerDriver('todos.db'), config, fileStore, transfer })
```

`image_path` stays an ordinary synced column. It holds the Storage object key the engine writes, never the bytes.

Omit `ownerColumn` and the table's [`byOwner`](../reference/javascript/define-config.md#parameters) bucket column is used instead. When neither resolves, creating the app client throws an `Error` naming the column that needs an owner.

You should now see the config compile with no type error, and `attachment()` accepted on the column you named.

## 2. Wire the file and transfer ports

The engine needs two ports for attachments: an `IFileStore` for the local [content-addressed](https://grokipedia.com/page/Content-addressable_storage) sandbox, built by [`createWebFileStore`](../reference/javascript/create-web-file-store.md) on the web and [`openExpoFileStore`](../reference/expo/open-expo-file-store.md) on native, and an `ITransfer` for Supabase Storage, built by [`createSupabaseTransfer`](../reference/javascript/create-supabase-transfer.md). The file in step 1 builds both and passes them to [`createSupabaseKizunaSync`](../reference/javascript/initializing.md) next to the driver. `createWebFileStore()` returns the store at once and opens its sandbox on the first attachment call that reads or writes bytes, so the module stays safe to import during a static render.

The driver, [`createWebWorkerDriver`](../reference/javascript/create-web-worker-driver.md), names the local database, and `createSupabaseKizunaSync` builds the remote that carries pull and push over your Supabase client, so the two attachment ports are the only extra wiring an attachment column needs. [Initializing](../reference/javascript/initializing.md) documents every option the app client takes. On Expo, the driver is the synchronous [`openExpoDriver('todos.db')`](../reference/expo/open-expo-driver.md), and [Expo: File store](../reference/expo/open-expo-file-store.md) builds the native file store and the transfer whose downloads go through `expo/fetch`.

A table that declares attachments while either port is missing throws [`ATTACHMENT_PORTS_MISSING`](../operations/troubleshooting.md#attachment_ports_missing). With no attachment column configured and no ports passed, `kizunasync.attachments` is still there, and each of its methods rejects with that code.

You should now see the module import without an error, and `kizunasync.attachments.getStatus(ref)` answer `null` for a reference the queue has never seen, rather than reject with `ATTACHMENT_PORTS_MISSING`.

## 3. Insert the row before picking a file

[`fromFile`](../reference/javascript/from-file.md) reads the row to find the owner value for the object key, so the row has to exist locally first. [`insert`](../reference/javascript/insert-data.md) commits it to [local SQLite](https://grokipedia.com/page/SQLite) and queues it in the [outbox](../resources/glossary.md#outbox) in one transaction. The insert leaves `user_id` out: on a `byOwner` table the engine fills the owner column with the id of the user who signed in on this device, offline too.

```ts
// src/add-todo.ts
import { kizunasync } from './kizunasync'

export async function addTodo(title: string): Promise<string> {
  const id = crypto.randomUUID()

  // image_path stays null until a file is attached
  await kizunasync.from('todos').insert({ id, title, image_path: null })

  return id
}
```

You should now see the row in the UI with `image_path` unset, and one more entry in the outbox.

## 4. Import the file and write the ref

Call [`attachments.fromFile`](../reference/javascript/from-file.md) with the table, column, primary key, and the file URI your platform's picker returned. It writes `result.ref` into the row column itself, so there is no [update](../reference/javascript/update-data.md) to make after it.

```ts
// src/attach-image.ts
import { kizunasync } from './kizunasync'

// pickedUri is the file URI your platform's picker returned
export async function attachImage(todoId: string, pickedUri: string): Promise<string> {
  const result = await kizunasync.attachments.fromFile({
    table: 'todos',
    column: 'image_path',
    pk: todoId,
    uri: pickedUri,
    mediaType: 'image/jpeg', // optional; inferred from the file when omitted
  })

  return result.ref
}
```

`fromFile` copies the picked file into a local content-addressed sandbox, computes a SHA-256 digest, mints a per-upload key of the form `${owner}/${pk}/${uploadId}.${ext}`, enqueues the upload, and writes the key into `image_path` as an ordinary synced column update. Both writes commit locally, so neither needs the network. That is the same optimistic path every write takes, described in [Offline writes](../sync/offline-writes.md#1-write-locally).

The queue row comes first and the column update right after it, so each drive checks that the row still carries the reference before it uploads. A row that is gone, tombstoned, carries a different reference, or has not received this one yet is released back to `queued` instead of being orphaned, and a later run picks the upload back up once the row names it.

`result` has this shape:

| Field | Type | Description |
|---|---|---|
| `ref` | `string` | The Storage object key. |
| `sha256` | `string` | SHA-256 hex digest of the file bytes. |
| `size` | `number` | File size in bytes. |
| `mediaType` | `string \| null` | Content type, inferred or provided. |
| `localUri` | `string` | Renderable URI for the sandbox copy, available before any upload. |

You should now see `result.localUri` render the picked file before any upload starts, and the row column holding `result.ref`.

## 5. Bytes upload after the outbox drains

[`sync()`](../reference/javascript/sync.md) pushes the [outbox](../resources/glossary.md#outbox) first. It drives attachment uploads only once that outbox is empty. The ref column therefore reaches the server before the bytes it points at. Queue rows, TUS session URLs, and progress live in SQLite. Engine startup returns any unfinished row to the candidate queue. The automated tests simulate interruption and resumption. The repository has no browser or native process-kill test, so a pass is evidence for the engine path and not for crash safety. [Project status](../getting-started/status.md#attachment-status) states it in the same terms.

The Supabase transfer chooses by byte size. A file of at most 6 MiB takes a single-shot [standard upload](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading). Kizuna issues that call from the queue rather than from your component. The upload therefore happens on a sync run, not at the moment the user picked the file. A larger file takes a [resumable TUS upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) in 6 MiB chunks. Kizuna persists the session URL before the first chunk. A later attempt reuses that URL and asks the server for its authoritative offset. A single-shot attempt restarts from zero. The adapter reads the whole sandbox file into memory before it picks a path, so resumability does not make a large file cheap in memory, whichever direction moves the bytes. Mocked unit tests cover both paths and the resume. The live Storage suite runs only when you set `KSYNC_TUS_E2E=1` and supply credentials. A default test run is therefore not evidence of a live upload. Apply a client-side size and type check to enforce your own maximum, and set the Storage bucket's [`file_size_limit`](https://supabase.com/docs/guides/storage/uploads/file-limits#per-bucket-restrictions) and [`allowed_mime_types`](https://supabase.com/docs/guides/storage/uploads/file-limits#per-bucket-restrictions) as well. Kizuna does not cap the size or the media type of the file it hands to Storage.

Every network wait carries a deadline, so one hung request cannot hold the scheduler forever. Control requests use [`controlTimeoutMs`](../reference/javascript/create-supabase-transfer.md#parameters), 30000 by default. That deadline covers the [session lookup](https://supabase.com/docs/guides/auth/sessions#what-is-a-session), which Kizuna bounds rather than awaiting indefinitely. It also covers the TUS create and offset probe, the signed URL, and [`attachment_confirm`](../reference/sql-pack.md#kizunasyncattachment_confirm). It covers [`attachment_vacuum`](../reference/sql-pack.md#kizunasyncattachment_vacuum), the Storage remove, and the metadata lookup as well. Requests that carry bytes use `bytesTimeoutMs`, 120000 by default: the single-shot upload, each TUS chunk, and the download. Pass `0` for either to disable that deadline.

```ts
// src/kizunasync.ts (excerpt)
import { createSupabaseTransfer } from 'kizunasync/supabase'
import { createWebFileStore } from 'kizunasync/web'
import { supabase } from './supabase-client'

const fileStore = createWebFileStore()
const transfer = createSupabaseTransfer({
  client: supabase,
  fileStore,
  controlTimeoutMs: 30_000,
  bytesTimeoutMs: 300_000, // a 6 MiB chunk on a slow mobile link
})
```

A blown deadline rejects with `ATTACHMENT_TRANSFER_TIMEOUT`. The queue records the attachment as `failed` and retries on the next sync, the same as any other transient failure. A TUS session survives a chunk timeout, because its [upload URL](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) stays valid for up to 24 hours, so the retry resumes rather than restarting. The single-shot path is the exception: storage-js exposes no abort signal, so a timed-out request may land on the server regardless. That costs nothing, because the retry re-uploads with [`upsert`](https://supabase.com/docs/guides/storage/uploads/standard-uploads#overwriting-files).

Supabase lists the status codes a failed Storage call returns in [Storage error codes](https://supabase.com/docs/guides/storage/debugging/error-codes). The transfer branches on the status: a [`404 NotFound`](https://supabase.com/docs/guides/storage/debugging/error-codes#404-notfound) on a peer's download means the bytes are not uploaded, so Kizuna returns the entry to `queued` instead of failing it, and the attempt still counts against the budget. A `401` means Storage refused the session rather than this object, so Kizuna returns the entry to `queued` as well, this time without charging the attempt: the same session refusal a resumable upload's offset probe answers. Every other status fails the attempt.

You should now see the attachment move from [`queued`](../reference/javascript/get-status.md#returns) to `uploading` to `synced` across one sync run, with `progress` reaching 100.

## 6. Give up after too many failures, and offer a way back

A transfer that keeps failing does not retry forever. `attachmentAttempts` in [`defineConfig`](../reference/javascript/define-config.md#parameters) sets the budget, five attempts by default, and the claim that discovers the budget spent is not itself counted. Past it, the row lands `failed` with `permanent: true`: no drive claims it again, and it drops out of the candidate list [`get-status`](../reference/javascript/get-status.md) and the queue's own drive loop both read from.

```ts
// src/kizunasync.ts (excerpt)
import { defineConfig } from 'kizunasync'
import type { Database } from './database.types'

const config = defineConfig<Database>({
  tables: { /* ... */ },
  attachmentAttempts: 3, // default 5
})
```

Three controls read and change a stopped row, all on `kizunasync.attachments`:

| Method | What it does |
|---|---|
| [`retry(ref)`](../reference/javascript/attachment-retry.md) | Forgives the budget: the row returns to `queued` with `permanent` off and attempts cleared, so the next drive or resolve takes it again. It wakes the automatic loop, so an upload needs no `sync()` call. |
| [`cancel(ref)`](../reference/javascript/attachment-cancel.md) | Stops an in-flight transfer at the app's own request. The row lands `failed` and stays retryable, and nothing is charged against the budget, so backing out of an upload never costs a later retry. |
| [`remove(ref)`](../reference/javascript/attachment-remove.md) | Forgets the reference and the sandbox bytes it cached, without touching the Storage object. [Vacuum attachments](../reference/javascript/vacuum.md) is what removes that, once no row column names it. |

`getStatus` and `watch` answer two more fields alongside the four from step 7: `permanent` and `attempts`. [React: useAttachment](../reference/react/use-attachment.md) and [Vue: useAttachment](../reference/vue/use-attachment.md) surface both, plus `cancel` and `remove`, next to the `retry` action they already expose.

```tsx
// src/components/todo-thumb.tsx
import { useAttachment } from 'kizunasync/react'

function TodoThumb({ imageRef }: { imageRef: string | null }) {
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

You should now see a row that keeps failing stop after the configured number of attempts, `permanent` turn `true`, and `retry()` put it back in the queue.

## 7. Display the attachment with useAttachment

[`useAttachment`](../reference/react/use-attachment.md) subscribes to one ref's status in the queue. The uploading device has `localUri` from the sandbox right away. For a peer, the hook prefetches the bytes once on first view through [`resolveDownload`](../reference/javascript/resolve-download.md). The transfer verifies the downloaded bytes' SHA-256 against the [`attachment_confirm`](../reference/sql-pack.md#kizunasyncattachment_confirm) metadata when the server already holds it, or against this device's own recorded hash otherwise. With neither hash known, the download fails closed with `ATTACHMENT_UNVERIFIED` and fetches nothing, retryable through [`retry(ref)`](../reference/javascript/attachment-retry.md). A mismatch between the downloaded bytes and the expected hash fails with `ATTACHMENT_HASH_MISMATCH` instead, and nothing is written to the sandbox.

:::tabs
```tsx tab=React
// src/components/todo-image.tsx
import { useAttachment } from 'kizunasync/react'

function TodoImage({ imageRef }: { imageRef: string | null }) {
  const { state, progress, localUri, error } = useAttachment(imageRef)

  if (imageRef == null || state === 'idle') return null
  if (localUri !== null) return <img src={localUri} alt="todo" />
  if (state === 'failed') return <span>{error ?? 'Attachment transfer failed'}</span>
  if (state === 'uploading') return <span>Uploading {progress}%</span>
  return <span>Syncing…</span>
}
```

```vue tab=Vue
<!-- src/components/TodoImage.vue -->
<script setup lang="ts">
import { useAttachment } from 'kizunasync/vue'

const props = defineProps<{ imageRef: string | null }>()
const { state, progress, localUri, error } = useAttachment(props.imageRef)
</script>

<template>
  <img v-if="localUri" :src="localUri" alt="todo" />
  <span v-else-if="state === 'failed'">{{ error ?? 'Attachment transfer failed' }}</span>
  <span v-else-if="state === 'uploading'">Uploading {{ progress }}%</span>
</template>
```

```tsx tab="Expo/React Native"
// src/components/todo-image.tsx
import { Image, Text } from 'react-native'
import { useAttachment } from 'kizunasync/react'

function TodoImage({ imageRef }: { imageRef: string | null }) {
  const { state, progress, localUri, error } = useAttachment(imageRef)

  if (imageRef == null || state === 'idle') return null
  if (localUri !== null) return <Image source={{ uri: localUri }} accessibilityLabel="todo" />
  if (state === 'failed') return <Text>{error ?? 'Attachment transfer failed'}</Text>
  if (state === 'uploading') return <Text>Uploading {progress}%</Text>
  return <Text>Syncing…</Text>
}
```

```swift tab=Swift
// TodoApp/TodoListView.swift (excerpt)
import Foundation
import KizunaSync

// Insert the row first; fromFile copies the picked file into the sandbox and writes its reference onto the row.
func attachPhoto(todoId: String, imageURL: URL) async throws -> String? {
  try await kizunasync.apply(
    table: "todos",
    pk: todoId,
    op: .insert,
    columns: ["title": "works on a plane", "image_path": NSNull()]
  )
  let result = try await kizunasync.fromFile(
    table: "todos",
    column: "image_path",
    pk: todoId,
    sourcePath: imageURL.path,
    mediaType: "image/jpeg"
  )
  return try await kizunasync.resolveDownload(result.reference)
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
package com.example.todo

import com.kizunasync.kizunasync.KizunaSyncOp

// Insert the row first; fromFile copies the picked file into the sandbox and writes its reference onto the row.
suspend fun attachPhoto(todoId: String, sourcePath: String): String? {
    kizunasync.apply(
        table = "todos",
        pk = todoId,
        op = KizunaSyncOp.Insert,
        columns = mapOf("title" to "works on a plane", "image_path" to null),
    )
    val result = kizunasync.fromFile(
        table = "todos",
        column = "image_path",
        pk = todoId,
        sourcePath = sourcePath,
        mediaType = "image/jpeg",
    )
    return kizunasync.resolveDownload(result.reference)
}
```

```ts tab="Vanilla / other"
// src/todo-image.ts
import { kizunasync } from './kizunasync'

// Enqueue with the app client; drive the UI from attachment status yourself.
export async function attachTodoImage(todoId: string, fileUri: string) {
  const { ref } = await kizunasync.attachments.fromFile({
    table: 'todos',
    column: 'image_path',
    pk: todoId,
    uri: fileUri,
  })

  // After the upload, read a local URI back through getStatus or resolveDownload.
  return kizunasync.attachments.getStatus(ref)
}
```
:::

The Swift and Kotlin tabs use [Swift: Attach a file](../reference/swift/from-file.md) and [Kotlin: Attach a file](../reference/kotlin/from-file.md). Both use the app client `kizunasync` and leave `user_id` out of the insert, which the `byOwner` bucket fills as in step 3. Native `fromFile` also writes the reference onto the row, and that local write wakes the app's `syncScheduler` ([Swift: Host scheduler](../reference/swift/scheduler.md)), whose next run uploads the bytes. [Swift: Resolve a download](../reference/swift/resolve-download.md) and [Kotlin: Resolve a download](../reference/kotlin/resolve-download.md) carry the full `resolveDownload` signature.

Both JavaScript bindings return the same ten fields, and [Vue: useAttachment](../reference/vue/use-attachment.md) has the Vue return table:

| Field | Type | Description |
|---|---|---|
| `state` | `TAttachmentState \| 'idle'` | The queue state, or `'idle'` when the ref is null or no queue row exists. |
| `progress` | `number` | 0 to 100, updated while bytes move. |
| `localUri` | `string \| null` | Renderable URI once the bytes are local. |
| `error` | `string \| null` | The last error message, or null. |
| `permanent` | `boolean` | `true` when the transfer budget is spent and only `retry` moves the row again. |
| `attempts` | `number` | Transfer attempts consumed so far, out of the configured budget. |
| `retry` | `() => void` | Forgive the budget and attempt the download again. |
| `cancel` | `() => void` | Stop an in-flight transfer without spending an attempt. |
| `remove` | `() => void` | Forget the reference and its sandbox bytes. |
| `prefetch` | `() => void` | Attempt the download again, without touching the budget. |

Vue wraps `state`, `progress`, `localUri`, `error`, `permanent`, and `attempts` in refs. `retry`, `cancel`, `remove`, and `prefetch` are plain functions in both.

### Attachment state lifecycle

[`TAttachmentState`](../reference/status-taxonomy.md#attachment-states), declared in [JavaScript: Types](../reference/javascript/types.md), is a closed union of seven values:

| State | When |
|---|---|
| `queued` | Waiting for the outbox to drain, waiting for the row to carry the ref, or scheduled as a peer download whose bytes nobody has viewed. |
| `uploading` | Bytes are moving to Storage. |
| `synced` | The upload was confirmed, or a download landed in the local sandbox. |
| `downloading` | Bytes are being fetched from Storage. |
| `failed` | The last attempt failed. While `permanent` is `false`, the next sync retries an upload and `retry` retries a download; once the transfer budget is spent, `permanent` turns `true` and only `retry` moves the row again. |
| `orphaned` | Server evidence, an applied push or a pulled row or [tombstone](../resources/glossary.md#tombstone), says this device's own object no longer belongs to any row, and no local row or queued write still names it. [`vacuum`](../reference/javascript/vacuum.md) removes the object. |
| `evicted` | This device dropped the reference with no such evidence, another user's object or one that only left this device, or gave up on an `orphaned` removal Storage refused or that spent its attempt budget. `vacuum` deletes only the cached bytes; the Storage object is left as it is. |

`'idle'` is not part of the union. The hooks return it when the ref is null or the queue has no row for it.

You should now see the placeholder while the bytes are missing and the image once `localUri` is set, without a reload.

## 8. Verify it worked

After `fromFile` and a sync, read the status back with [`getStatus`](../reference/javascript/get-status.md), or subscribe with [`watch`](../reference/javascript/watch.md) when you want every change:

```ts
// src/log-attachment.ts
import { kizunasync } from './kizunasync'

export async function logAttachment(ref: string): Promise<void> {
  const status = await kizunasync.attachments.getStatus(ref)

  console.log(status)
  // { state: 'synced', progress: 100, localUri: '...', error: null, ... }
}
```

You should now see `state: 'synced'`, and the object in the `todos` bucket of the Supabase dashboard at the path `${user_id}/${todo_id}/${uploadId}.jpg`. The metadata row lands in [`kizunasync.attachments`](../reference/sql-pack.md#kizunasyncattachments) at the same time.

## Storage policies

Storage objects are authorized by policies on `storage.objects`, which Supabase documents in [Storage access control](https://supabase.com/docs/guides/storage/security/access-control#access-policies). Those policies are ordinary [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does) policies, and Kizuna neither writes nor relaxes them. It adds only the key format: `${user_id}/${todo_id}/${uploadId}.ext` puts the owner and the referenced row in the path, so a policy can check both by reading the name.

The demo `todos` bucket comes from `0002_example.sql`, whose RLS keeps writes owner-scoped, with an exception for anonymous-owned rows any visitor can edit, while every visitor can read every row. Its policies are deliberately loose so the example runs unattended:

- The bucket is public and any user can read any todo image.
- Insert, update, and delete call `public.todo_image_writable(name)`, which checks two things. The object key's owner segment must name the referenced todo's own `user_id`, never merely the caller's. And the caller must be someone who may mutate that todo: its own owner, or, in the current helper, anyone editing a todo whose owner is anonymous.

Copy neither the public-read bucket nor that helper unchanged into a production project. Adapt `todo_image_writable` in `0002_example.sql` to your own ownership rules, and use a private bucket with signed URLs where reads need authorization. [Local Supabase](../cli/local-supabase.md) explains which migrations are demo fixtures and which one is the installable pack.

## Platform notes

Web: attachment bytes live in an [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) subtree named `kizunasync-attachments`, separate from the SQLite database file. [`createWebFileStore()`](../reference/javascript/create-web-file-store.md) calls `navigator.storage.persist()` on a best-effort basis, and the browser may decline. Render from `localUri`, which the configured file store produces.

[Expo](https://expo.dev) (React Native): bytes live under `documentDirectory/kizunasync-attachments/`, not the cache directory, through [`openExpoFileStore`](../reference/expo/open-expo-file-store.md). Transfers run in the foreground, and queue state is recovered on the next engine start as long as the app and the operating system preserved that directory.

Native Swift and Kotlin: set `attachmentRoot` on [`KizunaSyncClient.create`](../reference/kotlin/initializing.md), then call [`fromFile`](../reference/kotlin/from-file.md), [`resolveDownload`](../reference/kotlin/resolve-download.md), and [`watch`](../reference/kotlin/watch.md). There is no `useAttachment` hook on these platforms, so drive the UI from `watch` or [`getStatus`](../reference/kotlin/get-status.md).

Declaring `attachments` without `attachmentRoot` throws `ATTACHMENT_PORTS_MISSING`. React Native over UniFFI must omit `attachment_root` so the JavaScript host's attachment queue owns the bytes.

## Common errors

- `ATTACHMENT_ROW_GONE` means you called [`fromFile`](../reference/javascript/from-file.md) before inserting the row. Insert the row, then pick the file.
- `ATTACHMENT_OWNER_MISSING` means the `ownerColumn` value is empty or is not a string. On a `byOwner` table the engine fills the owner column only once a user has signed in on the device, so an insert made before that leaves it empty. Give the row a non-empty `user_id`, or whichever column you configured as [`ownerColumn`](../reference/javascript/define-config.md#parameters), before calling `fromFile`.
- `ATTACHMENT_PORTS_MISSING` means the JavaScript app client was created without both `fileStore` and `transfer` (see [Initializing](../reference/javascript/initializing.md)), or native `KizunaSyncClient.create` declared `attachments` without `attachmentRoot`. [Troubleshooting](../operations/troubleshooting.md#attachment_ports_missing) has the fix for both.
- `ATTACHMENT_TRANSFER_TIMEOUT` means a request outlived `controlTimeoutMs` or `bytesTimeoutMs`. The entry is `failed`; the next [`sync()`](../reference/javascript/sync.md) retries an upload, and [`retry(ref)`](../reference/javascript/attachment-retry.md) or `prefetch()` retries a download. Raise [`bytesTimeoutMs`](../reference/javascript/create-supabase-transfer.md#parameters) when large files on slow links time out repeatedly.
- `ATTACHMENT_UNVERIFIED` means a download has neither the server's `attachment_confirm` metadata nor a hash this device already recorded to check the bytes against. It fails closed rather than accepting unverified bytes; [`retry(ref)`](../reference/javascript/attachment-retry.md) tries again once the metadata exists.
- `ATTACHMENT_HASH_MISMATCH` means the downloaded bytes do not match the expected SHA-256, and nothing is written to the sandbox. A peer's own upload should not produce this; treat it as evidence of a corrupted or substituted object.
- Upload refused at the bucket means the bucket's [size limit](https://supabase.com/docs/guides/storage/uploads/file-limits#per-bucket-restrictions), its [allowed media types](https://supabase.com/docs/guides/storage/uploads/file-limits#per-bucket-restrictions), or its [access-control policies](https://supabase.com/docs/guides/storage/security/access-control#access-policies) rejected the write. Kizuna reports the platform's own status, so read it against [Storage error codes](https://supabase.com/docs/guides/storage/debugging/error-codes).
- `localUri` is null for a peer means the bytes have not been fetched. The hook prefetches once per ref, and `prefetch()` calls [`resolveDownload`](../reference/javascript/resolve-download.md) again. `retry()` does the same after forgiving the budget, so it works whether or not the row is `permanent`. Neither retries a failed upload, which a later sync handles.
- A transfer stopped for good (`permanent: true`) means the row spent its `attachmentAttempts` budget, and no drive claims it again. [`retry(ref)`](../reference/javascript/attachment-retry.md) puts it back in the queue, and [`remove(ref)`](../reference/javascript/attachment-remove.md) deletes its queue row instead. Step 6 shows both.

## Next steps

- [Offline writes](../sync/offline-writes.md): the ref column is an ordinary synced column, so the outbox and verdict rules apply to it like any other field.
- [Sync rules and buckets](../sync/sync-rules-and-buckets.md#attachments): the table bucket, ownership column, and conflict mode for the row that holds the ref.
- [Create the Storage transfer](../reference/javascript/create-supabase-transfer.md): every option `createSupabaseTransfer` takes.
- [Attach a file](../reference/javascript/from-file.md), [Get attachment status](../reference/javascript/get-status.md), and [Resolve a download](../reference/javascript/resolve-download.md): the three queue entry points, parameter by parameter.
- [Retry an attachment](../reference/javascript/attachment-retry.md), [Cancel an attachment](../reference/javascript/attachment-cancel.md), and [Remove an attachment](../reference/javascript/attachment-remove.md): the three controls over a row already in the queue.
- [SQL pack](../reference/sql-pack.md#kizunasyncattachments): the metadata table and the three attachment RPCs the transfer calls.
- [CLI](../cli/cli.md): `kizunasync init` and `kizunasync doctor` for provisioning and checking your project.
