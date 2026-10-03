---
title: Introduction
description: What the Expo reference covers, its version, and which concerns Supabase's own SDK handles.
status: alpha
docType: reference
library: expo
pageKind: introduction
audience: app-developer
---

# Expo: Introduction

`@kizunasync/expo` supplies the platform ports a [React Native](https://reactnative.dev) app needs: the SQLite driver, the NetInfo connectivity signal, the `AppState` foreground signal, the file sandbox for attachments, and the native download half of the transfer port. The client itself is built with [`createSupabaseKizunaSync`](../javascript/initializing.md), and the hooks come from [`@kizunasync/react`](../react/introduction.md).

## Version

`@kizunasync/expo` `0.2.6-alpha.2` (Alpha). Package `@kizunasync/expo` on npm; Expo SDK and React Native peers. See [Installing](./installing.md).

## What this reference covers

- [Initializing](./initializing.md) builds the client over the driver, and [Open the SQLite driver](./open-expo-driver.md) is the one every app needs, because it also carries the network and foreground signals. Those two pages are the shortest path to a working native client.
- The rest of the surface covers the alternative [op-sqlite driver](./open-op-sqlite-driver.md) and the [Verify op-sqlite](./verify-op-sqlite-driver.md) check a release runs on a device, the [Connectivity](./create-expo-connectivity.md) and [Foreground](./create-expo-foreground.md) ports for an app that passes its own, the [File store](./open-expo-file-store.md) and [Native download](./create-expo-supabase-download.md) that attachments need, and the [Rust engine](./rust-engine.md) selection on device.
- Every option the client takes is documented in the [JavaScript](../javascript/introduction.md) tree, and the components that read the client are documented in the [React](../react/introduction.md) tree.

## What Supabase covers

| Concern | Use |
|---|---|
| Sign-in, sessions, and token refresh on React Native | [`startAutoRefresh`](https://supabase.com/docs/reference/javascript/auth-startautorefresh#examples) and [Auth sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session) |
| [Row Level Security](https://grokipedia.com/page/Row-level_security) policies | [Write a policy for each operation](https://supabase.com/docs/guides/database/postgres/row-level-security#write-a-policy-for-each-operation) |
| Realtime channels behind the wake-up doorbell | [`subscribe`](https://supabase.com/docs/reference/javascript/subscribe#parameters) |
| Storage buckets, objects, and their policies | [`upload`](https://supabase.com/docs/reference/javascript/file-buckets-upload#parameters) and [Access control](https://supabase.com/docs/guides/storage/security/access-control#access-policies) |

Kizuna adds one thing to each row above. A foreground signal refreshes the session before the next run, so an attempt never runs on an expired access token. The server judges the policies when a queued write reaches it, not when the component renders. A Realtime message wakes a sync run instead of carrying data. Attachment bytes move through the transfer port that [Media and attachments](../../attachments/media-and-attachments.md) describes.

## Related reference

- [Installing](./installing.md)
- [Initializing](./initializing.md)
- [React: Introduction](../react/introduction.md)
- [Vue: Introduction](../vue/introduction.md)
- [JavaScript: Introduction](../javascript/introduction.md)
