---
title: Sync
description: Push the outbox, move attachment bytes, then pull to a closed checkpoint.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Sync

`sync()` pushes the outbox until it stops draining, drives queued attachment transfers when the client was created with an attachment root, then pulls until the checkpoint closes. It suspends on `Dispatchers.IO`, so an Android app can call it from a lifecycle scope without blocking a frame.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
kizunasync.sync()
```

### From the scheduler

```kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncScheduler
import io.github.jan.supabase.auth.auth

val scheduler = KizunaSyncScheduler(
    client = kizunasync,
    refreshSession = {
        supabase.auth.awaitInitialization()
        val token = supabase.auth.currentSessionOrNull()?.accessToken
        if (token != null) {
            kizunasync.setAccessToken(token)
        }
        token != null
    },
)
```

A scheduler built with the default `sync` calls this client's `sync()` on every run: when it starts, after every local write, on its timer, and on the network and foreground signals the app hands it. `refreshSession` is the one [Host scheduler](./scheduler.md#usage) shows: it hands the session's access token to [Set access token](./set-access-token.md) and skips the run when supabase-kt holds no session. `supabase` comes from `Supabase.kt` in [step 2 of Swift and Kotlin](../../getting-started/native-clients.md#2-connect-supabase).

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This function takes no arguments. Everything a run needs comes from [Initializing](./initializing.md#parameters). |

### What a run does, in order

| Name | Type | Required | Description |
|---|---|---|---|
| Push | Repeated | — | Sends the head of the outbox, then repeats while the depth keeps dropping. A soft-blocked client sends nothing. |
| Attachments | Conditional | — | Runs only when the client was created with both `attachmentRoot` and a `remote`: it reclaims rows a dead process left claimed, then drives up to 32 queued uploads, so a ref reaches the server before its bytes are needed. Downloads are not driven here; they run through [Resolve a download](./resolve-download.md). |
| Pull | Repeated | — | Drains the keyset sequence page by page until the boundary closes, so a bootstrap larger than one page becomes visible in one run rather than one page per run. |

## Returns

`Unit`. `sync()`, [Pull once](./pull-once.md), and [Push once](./push-once.md) serialize with each other and with the attachment transfer calls, so a second `sync()` waits for the first rather than running beside it. A local read or write answers at once, even while a `sync()` is in flight.

## Errors

| Code | Condition |
|---|---|
| `BUCKET_UNSET` | A table's bucket value is the empty string: a `KizunaSyncBucket.ByColumn` bucket that [Set bucket](./set-bucket.md) has not filled, or a `KizunaSyncBucket.ByOwner` bucket before the first session token, at create or through [Set access token](./set-access-token.md), named an owner. See [BUCKET_UNSET](../../operations/troubleshooting.md#bucket_unset). |
| `REMOTE` | A transport fault the client keeps retrying: network loss, a 5xx, an expired [session](https://supabase.com/docs/guides/auth/sessions#what-is-a-session) (`PGRST301`), or `42501`. The queued writes stay in the outbox. |
| `PERMANENT_TRANSPORT` | The server refused the request definitively: SQLSTATE class 22, 23, or 42 other than `42501`, plus exact `P0001` and `0A000`. The fifth consecutive one against a single-entry push, or against an atomic batch, dead-letters it. A permanent failure on an unbatched multi-entry slice charges nothing directly: the slice is narrowed and retried at once until only the failing entry sends alone. |
| `UNKNOWN_SIGNAL`, `MALFORMED_PUSH_RESPONSE`, `VERDICT_BIJECTION`, `UNKNOWN_BATCH_OFFENDER`, `UNKNOWN_VERDICT_REASON`, `UNKNOWN_OP` | The response broke the wire contract. These fail loudly rather than counting against the dead-letter budget. |
| `STORE`, `JSON` | The local database or the response could not be read. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

A run raises `LOCAL_CHANGED` when the pull boundary commits, `MUTATION_REJECTED` once per refused write, `BATCH_ABORTED` for an atomic batch the server refused, `DEAD_LETTER` when the retry budget drops a write, `COLUMN_OVERWRITTEN` for each column-level conflict, and `CHECKPOINT_EXPIRED` or `RESET_REQUIRED` for a lifecycle signal. Subscribe with [Subscribe to events](./on.md) to refresh a screen when one arrives.

The client has no timer of its own. On Kotlin, [Host scheduler](./scheduler.md) owns the poll interval and the wake after every local write, and refreshes the Supabase session before each run so a run never rides a dead Bearer, while it watches connectivity through the `ConnectivityManager` monitor the app hands it. An app that runs it calls `sync()` directly only where the gate and the refresh do not matter, such as a test; a **Sync now** button calls the scheduler's `wake()` instead. [Protocol overview](../../sync/protocol-overview.md#pull) describes the two halves on the wire, and [Consistency model](../../sync/consistency-model.md#checkpoints) explains what a closed checkpoint guarantees.

`RESET_REQUIRED` latches a soft block: the client stops making requests and applies nothing until [Reset](./reset.md) clears local state. A token of another user latches the same block with the reason `identity_changed`, as [Set access token](./set-access-token.md#notes) describes.

## Related reference

- [Pull once](./pull-once.md)
- [Push once](./push-once.md)
- [Outbox depth](./outbox-depth.md)
- [Host scheduler](./scheduler.md)
- [Subscribe to events](./on.md)
- [Swift: Sync](../swift/sync.md)
- [JavaScript: Sync](../javascript/sync.md)
