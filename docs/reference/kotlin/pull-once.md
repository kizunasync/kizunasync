---
title: Pull once
description: Fetch one page of server changes without pushing.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Pull once

`pullOnce()` issues a single pull request and either stages the page or, when the server reports no more pages, commits the whole staged sequence in one transaction. It never pushes, so an outbox waiting to be sent is left alone.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
kizunasync.pullOnce()
```

### Refresh without sending queued writes

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncQuery

kizunasync.pullOnce()
val raw = kizunasync.query(table = "todos", plan = KizunaSyncQuery.many())
```

One call fetches one page. Most apps call [Sync](./sync.md) instead, which drains the whole sequence and pushes first.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This function takes no arguments. The request is built from the schema version, the bucket parameters, and the stored cursor; the client identity travels in the session token, never in the body. The request carries no page size, so the server default applies. |

## Returns

`Unit`. A page that reports more pages leaves the keyset position advanced and its rows and tombstones staged; only the closing page writes rows, tombstones, and the durable cursor, and it does so in one transaction.

## Errors

| Code | Condition |
|---|---|
| `BUCKET_UNSET` | A table's bucket value is the empty string, so the request would ask for a bucket nobody filled: a `KizunaSyncBucket.ByColumn` bucket that [Set bucket](./set-bucket.md) has not filled, or a `KizunaSyncBucket.ByOwner` bucket before the first session token, at create or through [Set access token](./set-access-token.md), named an owner. |
| `REMOTE` | A transport fault. The staged pages and the keyset position are dropped first, so the next pull restarts from the durable checkpoint rather than a mid-flight cursor. |
| `PERMANENT_TRANSPORT` | The server refused the request definitively. |
| `UNKNOWN_SIGNAL` | The response carried a lifecycle signal outside `RESET_REQUIRED` and `CHECKPOINT_EXPIRED`. |
| `STORE`, `JSON` | The local database or the response could not be read. A staged page that cannot be parsed fails loudly rather than being dropped. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

A soft-blocked client returns without a request. That is how a `RESET_REQUIRED` signal keeps a stale device off the wire until [Reset](./reset.md) runs. A `CHECKPOINT_EXPIRED` signal restarts the keyset from the beginning and marks the sequence a rehydration. The next closing boundary then replaces the local snapshot instead of merging into it.

Rows arrive under the buckets the client is configured with. [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#select-policies) decides what those buckets may contain: the policy is the boundary, and the bucket is the coarser filter Kizuna adds inside it. [Pull](../../sync/protocol-overview.md#pull) describes the request and its cursor, and [Sync rules and buckets](../../sync/sync-rules-and-buckets.md#1-understand-the-two-layers) explains how the two layers combine.

## Related reference

- [Sync](./sync.md)
- [Push once](./push-once.md)
- [Checkpoint](./checkpoint.md)
- [Set bucket](./set-bucket.md)
- [Swift: Pull once](../swift/pull-once.md)
- [JavaScript: Pull once](../javascript/pull-once.md)
