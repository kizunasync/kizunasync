---
title: Introduction
description: What the Vue reference covers, its version, and which concerns Supabase's own SDK handles.
status: alpha
docType: reference
library: vue
pageKind: introduction
audience: app-developer
---

# Vue: Introduction

`kizunasync/vue` binds an [`IKizunaSync`](../javascript/types.md) client to [Vue](https://vuejs.org)'s reactivity. It opens no database and no remote of its own: the client is built with `kizunasync` and a driver, and this reference documents the plugin, the provide helpers, and the seven composables that read it.

## Version

`kizunasync/vue` `0.2.6-alpha.3` (Alpha). npm package `kizunasync`, import path `kizunasync/vue`; Vue `^3.5.13` optional peer. See [Installing](./installing.md).

## What this reference covers

- [Initializing](./initializing.md) registers one client for the app, and [useQuery](./use-query.md) turns a local select into refs a template renders. Those two pages are the shortest path to a working list.
- The rest of the surface covers writes with [useMutation](./use-mutation.md), the automatic sync loop with [useSyncStatus](./use-sync-status.md), one attachment ref with [useAttachment](./use-attachment.md), the durable rejection journal with [useRejections](./use-rejections.md), the durable overwrite journal with [useOverwrites](./use-overwrites.md), and the client itself with [useKizunaSync](./use-kizunasync.md).
- Every option the client takes is documented in the [JavaScript](../javascript/introduction.md) tree, because this package forwards the instance built there without wrapping it.

## What Supabase covers

| Concern | Use |
|---|---|
| Sign-in, sessions, and [JWT](https://grokipedia.com/page/JSON_Web_Token) refresh | [`signInWithPassword`](https://supabase.com/docs/reference/javascript/auth-signinwithpassword#examples) and [Auth sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session) |
| [Row Level Security](https://grokipedia.com/page/Row-level_security) policies | [Write a policy for each operation](https://supabase.com/docs/guides/database/postgres/row-level-security#write-a-policy-for-each-operation) |
| Realtime channels behind the wake-up doorbell | [`subscribe`](https://supabase.com/docs/reference/javascript/subscribe#parameters) |
| Storage buckets outside the attachment path | [`upload`](https://supabase.com/docs/reference/javascript/file-buckets-upload#parameters) |

Kizuna adds one thing to each row above. The session's access token rides every pull and push. The server judges the policies when a queued write reaches it, not when the component renders. A Realtime message wakes a sync run instead of carrying data. Attachment bytes move through the transfer port that [Media and attachments](../../attachments/media-and-attachments.md) describes.

## Related reference

- [Installing](./installing.md)
- [Initializing](./initializing.md)
- [React: Introduction](../react/introduction.md)
- [Expo: Introduction](../expo/introduction.md)
- [JavaScript: Introduction](../javascript/introduction.md)
