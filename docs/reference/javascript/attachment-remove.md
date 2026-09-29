---
title: Remove an attachment
description: Forget one attachment reference and delete the sandbox bytes it cached.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Remove an attachment

`attachments.remove(ref)` deletes the queue row for one reference outright, and deletes the sandbox bytes it cached unless another live row shares them. The Storage object is left alone: [Vacuum attachments](./vacuum.md) is what removes a remote object, and only once the row column that named it has moved on.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function forgetImage(imagePath: string): Promise<void> {
  await kizunasync.attachments.remove(imagePath)
}
```

### Remove a permanently stopped transfer

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

export async function forgetStoppedImage(imagePath: string): Promise<void> {
  const status = await kizunasync.attachments.getStatus(imagePath)

  if (status?.permanent) {
    await kizunasync.attachments.remove(imagePath)
  }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `ref` | `string` | Yes | The Storage object key stored in the row's attachment column. |

## Returns

`Promise<void>` that settles once the row is gone and the sandbox bytes it owned alone have been deleted. A reference the queue has never seen is a no-op.

## Errors

On an app client built with attachment ports, the call opens the engine when it is the client's first use. When that open fails, on this call or an earlier one, the call rejects with the open's typed error, such as `ENGINE_UNAVAILABLE` or `STORE_BUSY`, which [Initializing](./initializing.md#errors) lists. Apart from that, this method throws nothing. A missing sandbox file during the delete is treated as already gone. On an app client built without both the `fileStore` and `transfer` ports, the call rejects with `ATTACHMENT_PORTS_MISSING`, as every attachment method does; [Troubleshooting](../../operations/troubleshooting.md#attachment_ports_missing) shows the fix.

## Notes

Content addressing means two references can share one local file. `remove` counts the other live rows at that same sandbox path before it deletes anything, the same rule [Vacuum attachments](./vacuum.md#returns) applies, so removing one reference never deletes bytes a sibling row still renders.

This is a local operation only. It touches no server state: the row column that names the reference, if any still does, is unaffected, and a peer's copy of the same reference is untouched. Write a different value into the row column, or leave it as it stands, separately.

## Related reference

- [Get attachment status](./get-status.md)
- [Retry an attachment](./attachment-retry.md)
- [Cancel an attachment](./attachment-cancel.md)
- [Vacuum attachments](./vacuum.md)
- [Swift: Remove an attachment](../swift/attachment-remove.md)
- [Kotlin: Remove an attachment](../kotlin/attachment-remove.md)
