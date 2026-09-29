---
title: Introduction
description: What the JavaScript reference covers, its version, and which concerns Supabase's own SDK handles.
status: alpha
docType: reference
library: javascript
pageKind: introduction
audience: app-developer
---

# JavaScript: Introduction

This reference documents `@kizunasync/core`, the `@kizunasync/supabase` adapters, and the `@kizunasync/web` browser ports. Together they are the JavaScript surface for local reads, local writes, sync, and attachments against a Supabase project that `kizunasync init` has provisioned.

## Version

`@kizunasync/core` `0.2.6-alpha.1` (Alpha). Packages `@kizunasync/core`, `@kizunasync/supabase`, and `@kizunasync/web` on npm. See [Installing](./installing.md).

## What this reference covers

The shortest path through the tree is [Initializing](./initializing.md), then [Fetch data](./fetch-data.md) and [Insert data](./insert-data.md). The client syncs on its own from its first use, and [Sync](./sync.md) covers the few cases that call it directly.

| Section | Pages |
|---|---|
| Config | [Define config](./define-config.md) declares the synced tables, their buckets and attachment columns, and the options every run reads. |
| Database | [Fetch data](./fetch-data.md), [Insert data](./insert-data.md), [Update data](./update-data.md), [Delete data](./delete-data.md), [Using filters](./using-filters.md), [Using transforms](./using-transforms.md). |
| Sync | [Sync](./sync.md), [Pull once](./pull-once.md), [Push once](./push-once.md), [Set bucket](./set-bucket.md), [Checkpoint](./checkpoint.md), [Outbox depth](./outbox-depth.md), [Sync health](./sync-health.md), [Reset](./reset.md). |
| Auth session | [Set access token](./set-access-token.md). |
| Rejections | [List rejections](./rejections.md), [Dismiss a rejection](./dismiss-rejection.md). |
| Overwrites | [List overwrites](./overwrites.md), [Dismiss an overwrite](./dismiss-overwrite.md). |
| Events | [Subscribe to events](./on.md). |
| Attachments | [Attach a file](./from-file.md), [Resolve a download](./resolve-download.md), [Get attachment status](./get-status.md), [Watch an attachment](./watch.md), [Retry an attachment](./attachment-retry.md), [Cancel an attachment](./attachment-cancel.md), [Remove an attachment](./attachment-remove.md), [Vacuum attachments](./vacuum.md). |
| Supabase adapters | [Create the RPC remote](./create-rpc-remote.md), [Create the Storage transfer](./create-supabase-transfer.md), [Upload with TUS](./tus-upload.md), [Create the Realtime wakeup](./create-realtime-wakeup.md), [Create the document foreground](./create-document-foreground.md), [Recover an anonymous session](./recover-anonymous-session.md), [Wait with a deadline](./with-deadline.md). |
| Browser driver | [Open the browser driver](./create-web-worker-driver.md), [Browser connectivity](./create-web-connectivity.md), [Browser file store](./create-web-file-store.md), [Build integration](./build-integration.md). |
| Inspector | [Inspector](./inspector.md). |
| Types | [Types](./types.md). |

The React and Vue bindings wrap this same client: see [React: Introduction](../react/introduction.md) and [Vue: Introduction](../vue/introduction.md). Expo and [React Native](https://reactnative.dev) replace the browser ports with [Expo: Introduction](../expo/introduction.md).

## What Supabase covers

| Concern | Use |
|---|---|
| Sign-in, sessions, and [JWT](https://grokipedia.com/page/JSON_Web_Token) refresh | [`signInWithPassword`](https://supabase.com/docs/reference/javascript/auth-signinwithpassword#examples), whose session the adapters read before every pull and push |
| Row Level Security policies | [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#write-a-policy-for-each-operation), applied server-side when a queued write is pushed |
| Realtime channels behind the wake-up doorbell | [`subscribe`](https://supabase.com/docs/reference/javascript/subscribe#parameters), wrapped by [Create the Realtime wakeup](./create-realtime-wakeup.md) |
| Storage buckets outside the attachment path | [`upload`](https://supabase.com/docs/reference/javascript/file-buckets-upload#parameters), while attachment bytes travel through [Create the Storage transfer](./create-supabase-transfer.md) |

## Related reference

- [Installing](./installing.md)
- [Initializing](./initializing.md)
- [Swift: Introduction](../swift/introduction.md)
- [Kotlin: Introduction](../kotlin/introduction.md)
