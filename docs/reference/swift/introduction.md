---
title: Introduction
description: What the Swift reference covers, its version, and which concerns Supabase's own SDK handles.
status: alpha
docType: reference
library: swift
pageKind: introduction
audience: app-developer
---

# Swift: Introduction

`KizunaSyncClient` is the typed Swift app client over the [UniFFI](https://mozilla.github.io/uniffi-rs/) engine in `kizunasync-ffi`, and the native peer of `createKizunaSync` in JavaScript. Reads answer from a local [SQLite](https://grokipedia.com/page/SQLite) file, and writes land there first, wait in a durable outbox, and settle against Supabase on a sync run. Every method except `from(_:)` hops off the calling thread, so a call from the main actor never blocks the interface.

## Version

`kizunasync-ffi` `0.2.6-alpha.3` (Alpha). Swift package `https://github.com/kizunasync/kizunasync-swift`, product `KizunaSync`. See [Installing](./installing.md).

## What this reference covers

- The shortest path through the client is [Initializing](./initializing.md), then the [Host scheduler](./scheduler.md), which syncs after every write, then [Insert data](./insert-data.md).
- Local reads and writes: [Fetch data](./fetch-data.md), [Insert data](./insert-data.md), [Update data](./update-data.md), [Delete data](./delete-data.md), [Write with filters](./apply-where.md), [Using filters](./using-filters.md), and [Using transforms](./using-transforms.md).
- Sync controls: [Sync](./sync.md), [Pull once](./pull-once.md), [Push once](./push-once.md), [Set bucket](./set-bucket.md), [Checkpoint](./checkpoint.md), [Outbox depth](./outbox-depth.md), and [Reset](./reset.md).
- The rest of the surface: [Set access token](./set-access-token.md), [List rejections](./rejections.md), [Dismiss a rejection](./dismiss-rejection.md), [List overwrites](./overwrites.md), [Dismiss an overwrite](./dismiss-overwrite.md), [Subscribe to events](./on.md), the attachment methods from [Attach a file](./from-file.md) to [Vacuum attachments](./vacuum.md), including [Retry](./attachment-retry.md), [Cancel](./attachment-cancel.md), and [Remove an attachment](./attachment-remove.md), the [Host scheduler](./scheduler.md), [Inspect](./inspect.md) and [Inspector](./inspector.md), [Dispose](./dispose.md), and [Types](./types.md).
- Swift has no hooks. `useQuery` and `useSyncStatus` belong to the JavaScript bindings; a Swift app pairs [Subscribe to events](./on.md) with Combine, and reads loop state from [`health()`](./scheduler.md) / `onHealth` on [Host scheduler](./scheduler.md). `from(_:)` is the fluent peer of JavaScript `kizunasync.from`.

## What Supabase covers

| Concern | Use |
|---|---|
| Sign-in, sessions, and token refresh | [`signInWithPassword`](https://supabase.com/docs/reference/swift/auth-signinwithpassword#examples) and [`refreshSession`](https://supabase.com/docs/reference/swift/auth-refreshsession#examples), then pass the token to [Set access token](./set-access-token.md) |
| Row Level Security policies | [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does), which judges every mutation a push carries |
| Realtime channels behind the wake-up doorbell | [`subscribe`](https://supabase.com/docs/reference/swift/subscribe#examples) from the app, calling `wake(reason:)` on the [Host scheduler](./scheduler.md) |
| Storage objects outside the attachment path | [`upload`](https://supabase.com/docs/reference/swift/storage-from-upload#examples) |

## Related reference

- [Installing](./installing.md)
- [Initializing](./initializing.md)
- [Kotlin: Introduction](../kotlin/introduction.md)
- [JavaScript: Introduction](../javascript/introduction.md)
