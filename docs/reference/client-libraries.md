---
title: Client library comparison
description: Which capabilities the JavaScript, React, Vue, Expo / React Native, Swift, and Kotlin libraries expose, and the reference page that documents each one.
status: alpha
docType: reference
audience: app-developer
---

# Client library comparison

This table shows which capabilities each Kizuna client library exposes, with a link from every supported cell to the reference page that documents it.

| Capability | JavaScript | React | Vue | Expo / React Native | Swift | Kotlin |
|---|---|---|---|---|---|---|
| Local reads and writes | [Yes](./javascript/fetch-data.md) | [Yes](./react/use-query.md) | [Yes](./vue/use-query.md) | [JS client](./javascript/fetch-data.md) | [Yes](./swift/fetch-data.md) | [Yes](./kotlin/fetch-data.md) |
| Supabase-style filters and modifiers | [Yes](./javascript/using-filters.md) | [JS client](./javascript/using-filters.md) | [JS client](./javascript/using-filters.md) | [JS client](./javascript/using-filters.md) | [Yes](./swift/using-filters.md) | [Yes](./kotlin/using-filters.md) |
| Field transforms | [Yes](./javascript/using-transforms.md) | [JS client](./javascript/using-transforms.md) | [JS client](./javascript/using-transforms.md) | [JS client](./javascript/using-transforms.md) | [Yes](./swift/using-transforms.md) | [Yes](./kotlin/using-transforms.md) |
| Atomic write batches | No | No | No | No | No | No |
| Journal of rejected writes | [Yes](./javascript/rejections.md) | [Yes](./react/use-rejections.md) | [Yes](./vue/use-rejections.md) | [JS client](./javascript/rejections.md) | [Yes](./swift/rejections.md) | [Yes](./kotlin/rejections.md) |
| Journal of overwritten columns | [Yes](./javascript/overwrites.md) | [Yes](./react/use-overwrites.md) | [Yes](./vue/use-overwrites.md) | [JS client](./javascript/overwrites.md) | [Yes](./swift/overwrites.md) | [Yes](./kotlin/overwrites.md) |
| Attachments | [Yes, with `fileStore`](./javascript/initializing.md#with-attachments) | [Yes](./react/use-attachment.md) | [Yes](./vue/use-attachment.md) | [Yes, with Expo file store](./expo/open-expo-file-store.md) | [Yes, with `attachmentRoot`](./swift/initializing.md#with-attachments) | [Yes, with `attachmentRoot`](./kotlin/initializing.md#with-attachments) |
| Sync status hook or composable | [No; `getSyncHealth` instead](./javascript/sync-health.md) | [Yes](./react/use-sync-status.md) | [Yes](./vue/use-sync-status.md) | [React hooks](./react/use-sync-status.md) | [No; scheduler `health()` instead](./swift/scheduler.md#methods) | [No; scheduler `health()` instead](./kotlin/scheduler.md#methods) |
| Automatic sync loop | [Yes](./javascript/initializing.md#next-steps) | [JS client](./javascript/initializing.md#next-steps) | [JS client](./javascript/initializing.md#next-steps) | [JS client](./javascript/initializing.md#next-steps) | [App builds the scheduler](./swift/scheduler.md) | [App builds the scheduler](./kotlin/scheduler.md) |
| Realtime wake-up | [Yes](./javascript/create-realtime-wakeup.md) | [JS client](./javascript/create-realtime-wakeup.md) | [JS client](./javascript/create-realtime-wakeup.md) | [JS client](./javascript/create-realtime-wakeup.md) | [Port; app writes the adapter](./swift/scheduler.md#realtime-wake) | [Port; app writes the adapter](./kotlin/scheduler.md#realtime-wake) |
| Session refresh on foreground | [Yes](./javascript/initializing.md#notes) | [JS client](./javascript/initializing.md#notes) | [JS client](./javascript/initializing.md#notes) | [Yes](./expo/create-expo-foreground.md) | [Pass a `refreshSession` closure](./swift/scheduler.md) | [Pass an Android foreground source](./kotlin/scheduler.md#foreground-wake) |
| Browser tabs sharing one database | [Yes, in the browser](./javascript/create-web-worker-driver.md#notes) | [JS client](./javascript/create-web-worker-driver.md#notes) | [JS client](./javascript/create-web-worker-driver.md#notes) | [On Expo web](./expo/open-expo-driver.md) | Not applicable | Not applicable |
| How the Rust engine runs | [WebAssembly worker or N-API](./javascript/installing.md#what-the-install-resolves-per-platform) | [JS client](./javascript/installing.md#what-the-install-resolves-per-platform) | [JS client](./javascript/installing.md#what-the-install-resolves-per-platform) | [UniFFI; WebAssembly on web](./expo/rust-engine.md) | [UniFFI](./swift/introduction.md) | [UniFFI](./kotlin/introduction.md) |

## How to read the table

React, Vue, and Expo / React Native wrap the JavaScript app client, so "JS client" means the capability comes from that client unchanged, and "React hooks" means an Expo app uses the React package, as it can wherever the React column has a hook. On iOS and Android the Expo / React Native column needs a development build, because Expo Go cannot load the engine, as [Expo: Rust engine](./expo/rust-engine.md#when-neither-condition-holds) explains. Swift and Kotlin have no hooks: a native app subscribes to events with `on` and reads the state of its sync loop from the host scheduler it builds next to the client. A native app has no browser tabs, so the tab row reads "Not applicable" for Swift and Kotlin. The engine and the wire protocol carry atomic batches, but no app client exposes a way to create one, and [Offline writes](../sync/offline-writes.md#5-model-an-invariant-without-a-batch-builder) recommends one server-side operation for an all-or-nothing rule instead. [Supported query operators](./query-operators.md) lists the filters and modifiers method by method.

## Related reference

- [JavaScript: Introduction](./javascript/introduction.md)
- [React: Introduction](./react/introduction.md)
- [Vue: Introduction](./vue/introduction.md)
- [Expo: Introduction](./expo/introduction.md)
- [Swift: Introduction](./swift/introduction.md)
- [Kotlin: Introduction](./kotlin/introduction.md)
- [Comparison with alternatives](../resources/comparison-with-alternatives.md)
- [FAQ](../resources/faq.md)
