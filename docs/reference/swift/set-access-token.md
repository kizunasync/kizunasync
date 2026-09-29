---
title: Set access token
description: Hand the client the signed-in user's JWT, and replace it after a refresh.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Set access token

`setAccessToken(_:)` replaces the bearer token the client sends on every pull, push, and attachment transfer. Supabase Auth owns the session; this method is how the current token reaches the engine.

## Examples

### In the host scheduler

The [Host scheduler](./scheduler.md) runs `refreshSession` before every sync, and this is where the app hands the client its token. It is `syncScheduler` from `TodoSync.swift` in [Swift and Kotlin](../../getting-started/native-clients.md#6-start-the-host-scheduler).

```swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync
import Supabase

let syncScheduler = KizunaSyncScheduler(
  client: kizunasync,
  refreshSession: {
    guard let session = try? await supabase.auth.session else { return false }
    try? await kizunasync.setAccessToken(session.accessToken)
    return true
  }
)
```

### On every auth change

```swift
// TodoApp/TodoApp.swift (excerpt)
import KizunaSync
import Supabase

for await (event, session) in supabase.auth.authStateChanges {
  if event == .tokenRefreshed || event == .signedIn {
    try await kizunasync.setAccessToken(session?.accessToken)
  }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `token` | `String?` | Yes | The access token to send from now on. `nil` clears it, which leaves the client sending the publishable key alone. |

## Returns

`Void`. The call applies the token to the remote, and to the attachment transfer as well when the client was created with an attachment root and a remote, so both halves of a run carry the same identity.

## Errors

| Code | Condition |
|---|---|
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

An [Initializing](./initializing.md) call starts an engine that holds only the token its config passes as `remote.accessToken`, if any, so hand the client a token again after `create(_:)` when the config passes none. A token passed at `create(_:)` counts as a call to this method: it authenticates pull and push, and its `sub` claim names the owner as the next paragraph describes.

The token's `sub` claim names the user. The first token a new database receives, or a database after [Reset](./reset.md), records that user as the owner of the local database and fills every `.byOwner` bucket with the user's id, and the database keeps the owner across launches. A later token of another user latches the soft block with the reason `identity_changed` and raises `.resetRequired` on [Subscribe to events](./on.md): pull and push stay off the network until [Reset](./reset.md) runs, so one user's queued writes never go out under another user's session. A token without a readable `sub` claim, and a cleared token, change neither the owner nor the block. The engine decodes the claim without verifying the token, because the server verifies it on every call.

The open engine holds the token in memory and never writes it to the database. Clearing it does not stop the client. The next run reaches the wire as the `anon` role, the sync functions refuse that role, and the attempt fails retryably with `42501` while the writes stay queued.

Refresh the session before a sync run, then pass the new token here. Kizuna adds that one obligation. Supabase refreshes the session for you. It documents the call under [`refreshSession`](https://supabase.com/docs/reference/swift/auth-refreshsession#examples) and the lifetimes in [Auth sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session). The [Host scheduler](./scheduler.md) does both on each wake, so a backgrounded app never polls with a dead bearer.

## Related reference

- [Initializing](./initializing.md)
- [Host scheduler](./scheduler.md)
- [Sync](./sync.md)
- [Set bucket](./set-bucket.md)
- [Kotlin: Set access token](../kotlin/set-access-token.md)
- [JavaScript: Set access token](../javascript/set-access-token.md)
