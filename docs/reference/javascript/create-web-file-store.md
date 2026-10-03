---
title: Browser file store
description: Open the browser sandbox that holds attachment bytes, backed by OPFS.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Browser file store

`createWebFileStore()` from `kizunasync/web` builds the [content-addressed](https://grokipedia.com/page/Content-addressable_storage) sandbox attachment bytes live in. It sits in its own [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) subtree, separate from the database file, so writing an image never contends with the exclusive handle [SQLite](https://grokipedia.com/page/SQLite) holds.

[Initializing](./initializing.md#with-attachments) calls it once, in `src/kizunasync.ts`, when a table declares an attachment column; nothing else in the app calls it. Read this page to see where attachment bytes live on the device, or to understand the errors a browser without OPFS raises.

## Examples

### Basic

```ts
// src/kizunasync.ts (excerpt)
import { createWebFileStore } from 'kizunasync/web'

const fileStore = createWebFileStore()
```

### Pass it to the client

The whole module, with the attachment column in the config:

```ts
// src/kizunasync.ts
import { attachment, byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
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
})
```

Building the store touches no storage, so the module stays safe to import during a static render, and the sandbox directory opens on the first attachment call that reads or writes bytes. Passing the store alone is enough: [Initializing](./initializing.md#parameters) builds [the Storage transfer](./create-supabase-transfer.md) over the same client when you do.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This factory takes no arguments. |

## Returns

`IFileStore`, returned synchronously, the value [Initializing](./initializing.md#parameters) takes as its `fileStore` argument. The first operation opens the sandbox directory, once, and asks the browser for persistent storage on a best-effort basis so the operating system is less likely to evict a pending upload.

| Name | Type | Required | Description |
|---|---|---|---|
| `writeAtomic` | `(path: string, data: ArrayBuffer) => Promise<void>` | — | Writes through a writable stream whose close commits the file, so a partial write is never observable and cannot poison the content-addressed cache. |
| `read` / `readRange` | `(path, ...) => Promise<ArrayBuffer>` | — | Reads the whole file, or the given byte window. |
| `exists` / `stat` | `(path: string) => Promise<...>` | — | Existence, and size with the last modified time. |
| `delete` | `(path: string) => Promise<void>` | — | Removes the file and revokes any object URL handed out for it. A file that is already gone resolves rather than throwing. |
| `list` | `(prefix: string) => Promise<string[]>` | — | Shallow listing of one directory. OPFS has no recursive match, so this does not walk subtrees. |
| `sha256` | `(path: string) => Promise<string>` | — | Hashes the file by streaming it rather than buffering it. |
| `importFromUri` | `(uri: string) => Promise<{ path; sha256; size; contentType }>` | — | Fetches an externally picked file and writes it to a path derived from its hash, which is why two identical files share one local copy. This is the call [Attach a file](./from-file.md) makes. |
| `toUri` | `(path: string) => Promise<string>` | — | Returns an object URL for the file, cached per path and revoked on delete. The caller must not assume it outlives the file. |
| `capabilities` | `IFileStoreCapabilities` | — | All four are declared: atomic rename, streams, quota, and content URIs. |

## Errors

Building the store throws nothing. When the browser exposes no OPFS at all, which is the case in some private browsing modes, every operation rejects with `STORE_UNAVAILABLE` and the message `kizunasync/web file store: OPFS is unavailable in this browser`. When the browser refuses the directory, the message is `kizunasync/web file store: OPFS refused the attachment directory: <message>`. The first attachment call that reads or writes bytes, such as [Attach a file](./from-file.md#errors), reports that error, never the import of `src/kizunasync.ts`, so a static render in Node, which has no OPFS either, imports the module cleanly. The failed open stays failed for this store, so every later attachment call that reaches it rejects with the same `STORE_UNAVAILABLE`.

Once the directory is open, a call rejects when a path cannot be created or a file is missing, and `importFromUri` rejects when the fetch of the picked file did not succeed.

## Notes

This store is required whenever a table declares an attachment column. Omitting it makes [Initializing](./initializing.md#errors) throw `ATTACHMENT_PORTS_MISSING` rather than dropping image bytes quietly.

Content addressing is what makes [Vacuum attachments](./vacuum.md) careful: two live rows can point at one sandbox file, so the vacuum checks for a sharer before deleting bytes.

[Expo](https://expo.dev) and [React Native](https://reactnative.dev) use [`openExpoFileStore`](../expo/open-expo-file-store.md) in its place, which stores bytes in the app's own file system.

## Related reference

- [Attach a file](./from-file.md)
- [Create the Storage transfer](./create-supabase-transfer.md)
- [Initializing](./initializing.md)
- [Vacuum attachments](./vacuum.md)
- [Open the browser driver](./create-web-worker-driver.md)
