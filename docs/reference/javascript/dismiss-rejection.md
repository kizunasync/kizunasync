---
title: Dismiss a rejection
description: Acknowledge one journalled rejection so it stops being listed.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Dismiss a rejection

`dismissRejection(mutationId)` flags one journal entry as acknowledged. It stops appearing in [List rejections](./rejections.md) unless that call asks for dismissed entries too.

## Examples

### Basic

```ts
// src/todo-list.ts
import type { TRejectionRecord } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export async function acknowledgeRejection(record: TRejectionRecord): Promise<void> {
  await kizunasync.dismissRejection(record.mutationId)
}
```

### Acknowledge everything shown

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

for (const record of await kizunasync.rejections()) {
  await kizunasync.dismissRejection(record.mutationId)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `mutationId` | `TUuid` | Yes | The `mutationId` of a record from [List rejections](./rejections.md). |

## Returns

`Promise<void>` that settles once the flag is written. The entry stays in the journal with `dismissed` set to true, so a later call that passes `includeDismissed` returns it regardless.

## Errors

This method throws nothing. An id that matches no entry updates no rows and settles normally, so dismissing twice is safe.

## Notes

Dismissing is an acknowledgement, not a retry. The write is already gone. The verdict clears its outbox entry on arrival and reverts the local row to the server state. Only a new write recovers the change, once the app fixes whatever the reason names. [Read the journal in the app](../../sync/validate-writes.md#4-read-the-journal-in-the-app) shows both halves.

[React: useRejections](../react/use-rejections.md) returns this method beside the journal rows, so a component lists and acknowledges through one hook.

The flag is client-local, like the journal itself. It is not pushed, another device does not learn about it, and [Reset](./reset.md) deletes the entry along with everything else.

## Related reference

- [List rejections](./rejections.md)
- [Subscribe to events](./on.md)
- [Reset](./reset.md)
- [Swift: Dismiss a rejection](../swift/dismiss-rejection.md)
- [Kotlin: Dismiss a rejection](../kotlin/dismiss-rejection.md)
