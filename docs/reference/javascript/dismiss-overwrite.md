---
title: Dismiss an overwrite
description: Acknowledge one journalled overwrite so it stops being listed.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Dismiss an overwrite

`dismissOverwrite(id)` flags one journal entry as acknowledged. It stops appearing in [List overwrites](./overwrites.md) unless that call asks for dismissed entries too.

## Examples

### Basic

```ts
// src/todo-list.ts
import type { TOverwriteRecord } from 'kizunasync'
import { kizunasync } from './kizunasync'

export async function acknowledgeOverwrite(entry: TOverwriteRecord): Promise<void> {
  await kizunasync.dismissOverwrite(entry.id)
}
```

### Acknowledge everything shown

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

for (const entry of await kizunasync.overwrites()) {
  await kizunasync.dismissOverwrite(entry.id)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | The `id` of a record from [List overwrites](./overwrites.md). |

## Returns

`Promise<void>` that settles once the flag is written. The entry stays in the journal with `dismissed` set to true, so a later call that passes `includeDismissed` returns it regardless.

## Errors

This method throws nothing. An id that matches no entry updates no rows and settles normally, so dismissing twice is safe.

## Notes

Dismissing is an acknowledgement, not a repair. The column already holds the peer's value: `loserValue` on the journal row is the only place your device's replaced value is still readable, and nothing here restores it. [Restore an overwritten assign](../../sync/collaborative-fields.md#4-restore-an-overwritten-assign-from-the-journal) shows the write that would.

[React: useOverwrites](../react/use-overwrites.md) returns this method beside the journal rows, so a component lists and acknowledges through one hook.

The flag is client-local, like the journal itself. It is not pushed, another device does not learn about it, and [Reset](./reset.md) deletes the entry along with everything else.

## Related reference

- [List overwrites](./overwrites.md)
- [Subscribe to events](./on.md)
- [Reset](./reset.md)
- [React: useOverwrites](../react/use-overwrites.md)
- [Vue: useOverwrites](../vue/use-overwrites.md)
- [Swift: Dismiss an overwrite](../swift/dismiss-overwrite.md)
- [Kotlin: Dismiss an overwrite](../kotlin/dismiss-overwrite.md)
