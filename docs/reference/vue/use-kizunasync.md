---
title: useKizunaSync
description: Resolve the IKizunaSync client from the provide scope, or from an explicit override.
status: alpha
docType: reference
library: vue
pageKind: method
audience: app-developer
---

# Vue: useKizunaSync

`useKizunaSync` returns the [`IKizunaSync`](../javascript/types.md) client the rest of the composables read. An explicit `{ client }` override wins when the caller passes one. The provided instance is the default. With neither in place the composable throws, rather than returning a silent `undefined`.

## Examples

### Basic

```vue
<!-- src/components/SyncButton.vue -->
<script setup lang="ts">
import { useKizunaSync } from 'kizunasync/vue'

const kizunasync = useKizunaSync()
</script>

<template>
  <button type="button" @click="kizunasync.sync()">Sync now</button>
</template>
```

### Override the provided client

A component that takes an optional `client` prop reads that client when a parent passes one, and the provided client otherwise.

```vue
<!-- src/components/OutboxBadge.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { IKizunaSync } from 'kizunasync'
import { useKizunaSync } from 'kizunasync/vue'

const props = defineProps<{ client?: IKizunaSync }>()
const kizunasync = useKizunaSync({ client: props.client })
const depth = ref(0)

onMounted(async () => {
  depth.value = await kizunasync.getOutboxDepth()
})
</script>

<template>
  <span>{{ depth }} waiting</span>
</template>
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `opts` | `IUseKizunaSyncOptions` | No | The single-property override object. Default: the provided client. |
| `opts.client` | `IKizunaSync` | No | Used instead of the provided client for this call. Every other composable accepts the same property, so a subtree can read a second client without a second provider. Default: the value seeded by [`createKizunaSyncPlugin` or `provideKizunaSync`](./initializing.md). |

## Returns

`IKizunaSync`, the client instance itself. Its members are documented field by field in [JavaScript: Initializing](../javascript/initializing.md#returns); the composables in this package wrap the ones a component usually needs.

Composables in this package, and the client members each one wraps:

| Name | Type | Required | Description |
|---|---|---|---|
| `useQuery` | `(build, opts?) => IUseQueryResult<T>` | — | Wraps `from(table).select(...)` and re-reads on every engine event. See [useQuery](./use-query.md). |
| `useMutation` | `(opts?) => IUseMutationResult` | — | Wraps any write run against `from(table)`. See [useMutation](./use-mutation.md). |
| `useSyncStatus` | `(opts?) => IUseSyncStatusResult` | — | Wraps `getOutboxDepth`, `getCheckpoint`, `getSyncHealth`, `onSyncHealth`, and `sync`. See [useSyncStatus](./use-sync-status.md). |
| `useAttachment` | `(ref, opts?) => IUseAttachmentResult` | — | Wraps `attachments.getStatus`, `attachments.watch`, and `attachments.resolveDownload`. See [useAttachment](./use-attachment.md). |
| `useRejections` | `(opts?) => IUseRejectionsResult` | — | Wraps `rejections` and `dismissRejection`. See [useRejections](./use-rejections.md). |
| `useOverwrites` | `(opts?) => IUseOverwritesResult` | — | Wraps `overwrites` and `dismissOverwrite`. See [useOverwrites](./use-overwrites.md). |

`useKizunaSync` is the way to reach everything else: [`setBucket`](../javascript/set-bucket.md) for a `byColumn` bucket, [`pullOnce`](../javascript/pull-once.md) and [`pushOnce`](../javascript/push-once.md) for one half of a cycle, [`reset`](../javascript/reset.md), and [`attachments.fromFile`](../javascript/from-file.md) when a picker returns a file.

A `byOwner` bucket needs no `setBucket` call. The engine fills it with the user id of the signed-in session, which Supabase describes in [What is a session](https://supabase.com/docs/guides/auth/sessions#what-is-a-session). Kizuna reads only that id, as a pull parameter and never as an authorization decision, because the server judges every row under its own policies.

## Errors

`useKizunaSync` throws an `Error` when the composable runs outside the provide scope and passes no override.

```text
useKizunaSync: no Kizuna client found. Pass an explicit { client }, or provide one from an ancestor: <KizunaSyncProvider client={kizunasync}> in React, provideKizunaSync(kizunasync) in Vue.
```

The same error surfaces from every other composable, because each one resolves its client through this function. `kizunasync` exports the text as `MISSING_CLIENT_MESSAGE` and both bindings throw it, so [React: useKizunaSync](../react/use-kizunasync.md) fails with the same string and names both entry points.

## Notes

`inject` only works during `setup()`, so call `useKizunaSync` there rather than inside an event handler. The client it returns is a plain object, not a ref, and it stays the same instance for the life of the provide scope.

Calling `kizunasync.sync()` from a handler is a manual run alongside the automatic loop. Each call reaches the engine and runs a full cycle of its own, which [Sync](../javascript/sync.md) describes; only the scheduler's automatic ticks coalesce.

## Related reference

- [Initializing](./initializing.md)
- [useQuery](./use-query.md)
- [JavaScript: Initializing](../javascript/initializing.md)
- [React: useKizunaSync](../react/use-kizunasync.md)
