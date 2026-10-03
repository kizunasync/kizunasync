---
title: useKizunaSync
description: Resolve the IKizunaSync client from the nearest KizunaSyncProvider, or from an explicit override.
status: alpha
docType: reference
library: react
pageKind: method
audience: app-developer
---

# React: useKizunaSync

`useKizunaSync` returns the [`IKizunaSync`](../javascript/types.md) client the rest of the hooks read. An explicit `{ client }` override wins when the caller passes one. The nearest [`KizunaSyncProvider`](./initializing.md) is the default. With neither in place the hook throws, rather than returning a silent `undefined`.

## Examples

### Basic

```tsx
// src/components/sync-button.tsx
import { useKizunaSync } from 'kizunasync/react'

export function SyncButton() {
  const kizunasync = useKizunaSync()

  return (
    <button type="button" onClick={() => void kizunasync.sync()}>
      Sync now
    </button>
  )
}
```

### Override the context client

A component that takes an optional `client` prop reads that client when a parent passes one, and the provider's client otherwise.

```tsx
// src/components/outbox-badge.tsx
import { useEffect, useState } from 'react'
import type { IKizunaSync } from 'kizunasync'
import { useKizunaSync } from 'kizunasync/react'

export function OutboxBadge({ client }: { client?: IKizunaSync }) {
  const kizunasync = useKizunaSync({ client })
  const [depth, setDepth] = useState(0)

  useEffect(() => {
    void kizunasync.getOutboxDepth().then(setDepth)
  }, [kizunasync])

  return <span>{depth} waiting</span>
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `opts` | `IClientOption` | No | The single-property override object. Default: the context client. |
| `opts.client` | `IKizunaSync` | No | Used instead of the provider's client for this call. Every other hook accepts the same property, so a subtree can read a second client without a second provider. Default: the nearest `KizunaSyncProvider` value. |

## Returns

`IKizunaSync`, the client instance itself. Its members are documented field by field in [JavaScript: Initializing](../javascript/initializing.md#returns); the hooks in this package wrap the ones a component usually needs.

Hooks in this package, and the client members each one wraps:

| Name | Type | Required | Description |
|---|---|---|---|
| `useQuery` | `(build, opts?) => IQueryResult<T>` | — | Wraps `from(table).select(...)` and re-reads on every engine event. See [useQuery](./use-query.md). |
| `useMutation` | `(opts?) => IMutationResult` | — | Wraps any write run against `from(table)`. See [useMutation](./use-mutation.md). |
| `useSyncStatus` | `(opts?) => ISyncStatusResult` | — | Wraps `getOutboxDepth`, `getCheckpoint`, `getSyncHealth`, `onSyncHealth`, and `sync`. See [useSyncStatus](./use-sync-status.md). |
| `useAttachment` | `(ref, opts?) => IUseAttachmentResult` | — | Wraps `attachments.getStatus`, `attachments.watch`, and `attachments.resolveDownload`. See [useAttachment](./use-attachment.md). |
| `useRejections` | `(opts?) => IRejectionsResult` | — | Wraps `rejections` and `dismissRejection`. See [useRejections](./use-rejections.md). |
| `useOverwrites` | `(opts?) => IOverwritesResult` | — | Wraps `overwrites` and `dismissOverwrite`. See [useOverwrites](./use-overwrites.md). |

`useKizunaSync` is the way to reach everything else: [`setBucket`](../javascript/set-bucket.md) for a `byColumn` bucket, [`pullOnce`](../javascript/pull-once.md) and [`pushOnce`](../javascript/push-once.md) for one half of a cycle, [`reset`](../javascript/reset.md), and [`attachments.fromFile`](../javascript/from-file.md) when a picker returns a file.

A `byOwner` bucket needs no `setBucket` call. The engine fills it with the user id of the signed-in session, which Supabase describes in [What is a session](https://supabase.com/docs/guides/auth/sessions#what-is-a-session). Kizuna reads only that id, as a pull parameter and never as an authorization decision, because the server judges every row under its own policies.

## Errors

`useKizunaSync` throws an `Error` when the component renders outside a provider and passes no override.

```text
useKizunaSync: no Kizuna client found. Pass an explicit { client }, or provide one from an ancestor: <KizunaSyncProvider client={kizunasync}> in React, provideKizunaSync(kizunasync) in Vue.
```

The same error surfaces from every other hook, because each one resolves its client through this function. `kizunasync` exports the text as `MISSING_CLIENT_MESSAGE` and both bindings throw it, so [Vue: useKizunaSync](../vue/use-kizunasync.md) fails with the same string and names both entry points.

## Notes

The returned client is a stable reference for as long as the provider holds it, so you can pass it to `useEffect` and `useCallback` dependency arrays without re-running them on each render.

Calling `kizunasync.sync()` from an event handler is a manual run alongside the automatic loop. Each call reaches the engine and runs a full cycle of its own, which [Sync](../javascript/sync.md) describes; only the scheduler's automatic ticks coalesce.

## Related reference

- [Initializing](./initializing.md)
- [useQuery](./use-query.md)
- [JavaScript: Initializing](../javascript/initializing.md)
- [Vue: useKizunaSync](../vue/use-kizunasync.md)
