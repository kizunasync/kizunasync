---
title: Push once
description: Make exactly one push request and reconcile its verdicts, without pulling.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Push once

`pushOnce()` makes exactly one push request and never pulls. It sends the run of outbox entries at the head of the queue, then reconciles one verdict per sent mutation in request order.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

await kizunasync.pushOnce()
```

### Drain the outbox before leaving a screen

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

let depth = await kizunasync.getOutboxDepth()

while (depth > 0) {
  await kizunasync.pushOnce()
  const next = await kizunasync.getOutboxDepth()
  if (next === depth) {
    break
  }
  depth = next
}
```

One call sends the head run rather than the whole queue, which is why this loops. It stops when a call clears nothing, because a soft-blocked client returns without reaching the wire and the depth would otherwise never fall. [Sync](./sync.md) is the usual choice, since it also pulls the verdicts' effects back.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

The request carries the selected mutations with their column masks verbatim, the exactly-once watermark from the last applied verdict, and the schema version from the `schemaVersion` option on [Initializing](./initializing.md#parameters).

## Returns

`Promise<void>` that settles when the single request has been reconciled. The call returns without reaching the wire when the outbox is empty, and also when the client is soft-blocked, which [Checkpoint](./checkpoint.md#returns) reports.

### What one call changes

| Name | Type | Required | Description |
|---|---|---|---|
| Outbox depth | `number` | — | An applied verdict clears its entry and advances the exactly-once watermark. A rejected verdict clears the entry too, after the revert below. Read the count with [Outbox depth](./outbox-depth.md). |
| Local rows | `TLocalRow[]` | — | A rejected verdict reverts the optimistic row to the authoritative state: the server row when the verdict carried one, or a local delete plus a tombstone shadow when it carried none. An applied verdict that carried a server row snaps the local row to it, which is how a transform total is corrected. |
| Rejection journal | `TRejectionRecord[]` | — | Written in the same transaction as the revert, so it survives a reload even though the event below does not. Read it with [List rejections](./rejections.md). |

### Events, and what raises them

| Name | Type | Required | Description |
|---|---|---|---|
| `MUTATION_REJECTED` | `{ type: 'MUTATION_REJECTED'; mutationId: TUuid; reason: TRejectReason }` | — | Raised once per rejected verdict, after the revert and the journal row land. |
| `BATCH_ABORTED` | `{ type: 'BATCH_ABORTED'; offenderMutationId: TUuid; reason: TRejectReason }` | — | Raised once when an atomic batch was refused, naming the offender. Every member reverts to its own pre-image, and only the offender gets a journal row. |
| `RESET_REQUIRED` | `{ type: 'RESET_REQUIRED'; reason?: 'reset_required' \| 'identity_changed' }` | — | Raised when the schema version is below the server minimum (`reason: 'reset_required'`) or a token of another user than the one the local database belongs to reached the engine (`reason: 'identity_changed'`). The outbox and the watermark are left alone, because the queued write is not at fault. |

The six reject reasons are `COLUMN_DENIED`, `CONSTRAINT`, `DELETE_WINS`, `PRECONDITION`, `RLS_DENIED`, and `SUPERSEDED`. [Conflict resolution](../../sync/conflict-resolution.md#validation-rejections) explains what each one decides.

## Errors

| Code | Condition |
|---|---|
| `VERDICT_BIJECTION` | The response did not carry exactly one verdict per sent mutation, in the same order and with matching ids. |
| `UNKNOWN_VERDICT_REASON` | A verdict carried a reject reason or a verdict kind outside the closed sets above. |
| `UNKNOWN_BATCH_OFFENDER` | A batch abort named an offender that was not a member of the sent batch. |
| `MALFORMED_PUSH_RESPONSE` | A batch abort answered a request that was not atomic, or the abort outcome was outside the closed union. The check runs before any store write, so nothing is reverted on a response the engine cannot trust. |
| `UNKNOWN_SIGNAL` | The response carried a lifecycle signal outside the closed set. |
| `UNKNOWN_OP` | An outbox row carries an operation outside insert, update, and delete. The check runs before the request is built, so nothing is sent. |

A transport failure leaves the outbox untouched and re-throws, so the next call re-sends identical bytes: the same mutation ids and the same watermark. A server that already recorded those verdicts returns them again rather than applying the writes twice, which is the exactly-once effect [Consistency model](../../sync/consistency-model.md#retry-and-exactly-once-effect) states.

## Notes

This method does not consult the connectivity port, and it does not implement the dead-letter budget. A write that keeps failing permanently is only dropped by [Sync](./sync.md), which counts the consecutive failures against the head entry.

Attachment bytes move only in a full run. That run drives the queue after the outbox has drained, which [Media and attachments](../../attachments/media-and-attachments.md#5-bytes-upload-after-the-outbox-drains) walks through.

An atomic batch is the consecutive run of entries at the head that share a batch id. Everything an app writes through the query builder is independent, so the usual case is one non-atomic request carrying the leading run of queued mutations.

## Related reference

- [Sync](./sync.md)
- [Pull once](./pull-once.md)
- [Outbox depth](./outbox-depth.md)
- [List rejections](./rejections.md)
- [Swift: Push once](../swift/push-once.md)
- [Kotlin: Push once](../kotlin/push-once.md)
