---
title: Push once
description: Send one slice of the outbox and reconcile its verdicts.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Push once

`pushOnce()` sends the head of the [outbox](../../resources/glossary.md#outbox) in one request and applies the server's answer: an applied [verdict](../../resources/glossary.md#verdict) clears the entry and advances the exactly-once watermark, a rejected verdict reverts the row to the server state and journals the reason. It never pulls, and it never drops a write.

## Examples

### Basic

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

try await kizunasync.pushOnce()
```

### Push, then read what the server refused

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

try await kizunasync.pushOnce()
let refused = try await kizunasync.rejections()
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. The slice is chosen from the outbox in insertion order. |

## Returns

`Void`. One call sends up to 500 queued entries, or the whole consecutive run of an atomic batch when the head belongs to one, so a group that must apply together is never split across two requests. An empty outbox returns without a request.

## Errors

| Code | Condition |
|---|---|
| `REMOTE` | A transport fault. The entries stay queued for the next attempt. |
| `PERMANENT_TRANSPORT` | The server refused the request definitively. `pushOnce` re-raises it as is: only [Sync](./sync.md) keeps the consecutive-failure budget that eventually dead-letters the head. |
| `UNKNOWN_OP` | An outbox row carries an operation outside insert, update, and delete. |
| `MALFORMED_PUSH_RESPONSE` | The response carried neither verdicts nor a batch outcome, answered a non-atomic request with a batch abort, or carried a batch outcome outside the closed union. |
| `VERDICT_BIJECTION` | The verdicts did not correspond one to one with the mutations sent. |
| `UNKNOWN_VERDICT_REASON` | A rejection reason outside `COLUMN_DENIED`, `CONSTRAINT`, `DELETE_WINS`, `PRECONDITION`, `RLS_DENIED`, and `SUPERSEDED`. |
| `UNKNOWN_BATCH_OFFENDER` | A batch abort named a mutation that was not in the batch. |
| `UNKNOWN_SIGNAL` | The response carried a lifecycle signal other than `RESET_REQUIRED`. |
| `STORE`, `JSON` | The local database or the response could not be read. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Each refused write raises `MUTATION_REJECTED` and lands in the journal, which [List rejections](./rejections.md) reads and [Dismiss a rejection](./dismiss-rejection.md) acknowledges. An atomic batch the server refused raises `BATCH_ABORTED` naming the offender, and every member of that batch is reverted, the offender to the authoritative row the server returned and the rest to their captured pre-images.

Row Level Security is enforced here rather than at write time: a mutation a policy refuses comes back as a `RLS_DENIED` verdict instead of an HTTP error, so one bad row does not fail the request. Supabase documents the policy side under [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does); [Push](../../sync/protocol-overview.md#push) describes the request itself.

A soft-blocked client returns without a request, and a `RESET_REQUIRED` signal on the response latches that block while leaving the outbox untouched.

## Related reference

- [Sync](./sync.md)
- [Pull once](./pull-once.md)
- [List rejections](./rejections.md)
- [Outbox depth](./outbox-depth.md)
- [Kotlin: Push once](../kotlin/push-once.md)
- [JavaScript: Push once](../javascript/push-once.md)
