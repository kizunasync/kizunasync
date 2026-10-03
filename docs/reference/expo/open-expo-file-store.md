---
title: File store
description: Open the content-addressed attachment sandbox backed by expo-file-system.
status: alpha
docType: reference
library: expo
pageKind: method
audience: app-developer
---

# Expo: File store

`openExpoFileStore` returns the `IFileStore` that holds attachment bytes on iOS and Android. An app with an attachment column calls it once, in `src/kizunasync.ts`, next to the driver that [Initializing](./initializing.md) passes, and passes the store to `createSupabaseKizunaSync` together with the transfer built over it; nothing else in the app calls it. An app needs this page when a table in `defineConfig` declares an attachment column.

Attachment bytes never cross the SQL driver: the row column stores a ref, and the bytes live in this [content-addressed](https://grokipedia.com/page/Content-addressable_storage) sandbox until the transfer port moves them.

## Examples

### Basic

The call sits in `src/kizunasync.ts`, next to `openExpoDriver`.

```ts
// src/kizunasync.ts (excerpt)
import { openExpoFileStore } from 'kizunasync/expo/file-store'

const fileStore = openExpoFileStore()
```

Building the store touches no file system. The first attachment call that reads or writes bytes creates the sandbox.

### Wire it with the transfer port

This is `src/kizunasync.ts` from [Initializing](./initializing.md) with attachments added: the config maps `image_path` to the `todo-images` Storage bucket, and the client receives the store and the transfer port built over it.

```ts
// src/kizunasync.ts
import { attachment, byOwner, defineConfig } from 'kizunasync'
import { openExpoDriver } from 'kizunasync/expo'
import { openExpoFileStore } from 'kizunasync/expo/file-store'
import { createExpoSupabaseDownload } from 'kizunasync/expo/transfer'
import { createSupabaseKizunaSync, createSupabaseTransfer } from 'kizunasync/supabase'
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

The `transfer` option spreads `createSupabaseTransfer` and replaces its `download` with [Native download](./create-expo-supabase-download.md), which reads the bytes with Expo's fetch directly, with no `Blob` round-trip. On Expo web, pass [`createWebFileStore()`](../javascript/create-web-file-store.md) from `kizunasync/web` as `fileStore` and leave `transfer` out: `createSupabaseKizunaSync` builds the Storage transfer over that store.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This factory takes no arguments. The sandbox root is `kizunasync-attachments/` under the app's document directory. |

## Returns

`IFileStore`, returned synchronously. The first operation creates the sandbox directory, once.

| Name | Type | Required | Description |
|---|---|---|---|
| `capabilities.atomicRename` | `boolean` | — | `true`. Every write lands in a per-write temporary file and is then moved, so a partial write is never observable. |
| `capabilities.streams` | `boolean` | — | `true`. `readRange` is available, which a bounded-memory caller uses. The Storage transfer buffers a file through `read`, so this is not itself a streaming-upload guarantee. |
| `capabilities.quota` | `boolean` | — | `false`. The store reports no quota, because the platform gives it none to report. |
| `capabilities.contentUris` | `boolean` | — | `true`. `toUri` returns a `file:` URI that [React Native](https://reactnative.dev)'s `Image` renders directly. |
| `writeAtomic` | `(path: string, data: ArrayBuffer) => Promise<void>` | — | Writes through a temporary file and moves it into place. A destination that already exists is left alone, because identical content hashes to the same path. |
| `read` | `(path: string) => Promise<ArrayBuffer>` | — | Reads the whole file. |
| `readRange` | `(path: string, offset: number, length: number) => Promise<ArrayBuffer>` | — | Reads the byte range starting at `offset`, through the range read the pinned `expo-file-system/legacy` entry point exposes. |
| `exists` | `(path: string) => Promise<boolean>` | — | Whether the sandbox file is present. |
| `stat` | `(path: string) => Promise<IFileStat \| null>` | — | `{ size, modifiedAt }` with `modifiedAt` in epoch milliseconds, or `null` when the file is absent. |
| `delete` | `(path: string) => Promise<void>` | — | Removes the file. Deleting an absent file is not an error. |
| `list` | `(prefix: string) => Promise<string[]>` | — | The entries under a sandbox prefix, each returned as a full path. An unreadable directory yields an empty list. |
| `sha256` | `(path: string) => Promise<string>` | — | Hashes the file with the JavaScript implementation in `kizunasync`, which keeps hashing free of a native crypto dependency. |
| `importFromUri` | `(uri: string) => Promise<{ path: string; sha256: string; size: number; contentType: string \| null }>` | — | Copies an externally picked `file:` or content URI into the sandbox at its content-addressed path, and reports the hash, the size, and the media type inferred from the extension. |
| `toUri` | `(path: string) => Promise<string>` | — | The `file:` URI for a sandbox path. Do not assume the URI outlives the file. |

## Errors

Building the store throws nothing. When expo-file-system reports no document directory, which is the case outside a native app context, every operation rejects with `STORE_UNAVAILABLE` and the message `kizunasync/expo file store: documentDirectory is unavailable`. The first attachment call that reads or writes bytes, such as [Attach a file](../javascript/from-file.md#errors), reports that error, never the import of `src/kizunasync.ts`. The failed open stays failed for this store, so every later attachment call that reaches it rejects with the same `STORE_UNAVAILABLE`.

Building a client whose config declares an attachment column without both this store and a transfer port throws `ATTACHMENT_PORTS_MISSING` from [`createSupabaseKizunaSync`](../javascript/initializing.md). [ATTACHMENT_PORTS_MISSING](../../operations/troubleshooting.md#attachment_ports_missing) shows the [Expo](https://expo.dev) wiring for both.

## Notes

Bytes live under the document directory rather than the cache directory. The operating system evicts a cache, and evicting a file that is waiting to upload would lose it.

The store is content addressed: two rows that point at identical bytes share one sandbox file, and a second write of the same content is skipped rather than repeated. That is also why a lost race on the move is not an error when the destination exists, since the destination holds the same bytes.

The bytes leave this sandbox through the transfer port, which uploads them to Supabase Storage as an [ordinary upload request](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading) below 6 MiB and a resumable one above it. Kizuna adds the ordering: the ref reaches the server with the row, and [`sync()`](../javascript/sync.md) drives the upload only after the outbox drains.

Import this module from `kizunasync/expo/file-store` rather than the package root.

That import path keeps the optional `expo-file-system` peer out of the resolution graph for an app without attachments.

## Related reference

- [Native download](./create-expo-supabase-download.md)
- [Initializing](./initializing.md)
- [JavaScript: Browser file store](../javascript/create-web-file-store.md)
- [JavaScript: Attach a file](../javascript/from-file.md)
