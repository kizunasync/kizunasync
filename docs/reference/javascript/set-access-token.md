---
title: Set access token
description: Hand the app client the user JWT of the current session.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Set access token

`setRemoteAccessToken(token)` hands the app client the user [JWT](https://grokipedia.com/page/JSON_Web_Token) of the current session. The engine records the user that token names as the owner of the local database, and the native HTTP remote attaches the token to every pull and push. The Supabase composition already calls it whenever the session changes, so an app assembling its own client with `createKizunaSync` is the caller that needs it.

## Examples

### Basic

```ts
// src/session.ts
import { kizunasync } from './kizunasync'
import { supabase } from './supabase-client'

const { data } = await supabase.auth.getSession()

await kizunasync.setRemoteAccessToken(data.session?.access_token ?? null)
```

### Follow the session for a hand-assembled client

```ts
// src/session.ts
import { kizunasync } from './kizunasync'
import { supabase } from './supabase-client'

supabase.auth.onAuthStateChange((_event, session) => {
  kizunasync.setRemoteAccessToken(session?.access_token ?? null).catch((error: unknown) => {
    console.warn('The app client refused the session token', error)
  })
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `token` | `string \| null` | Yes | The user access token from a Supabase session, or `null` to clear it. Clearing means the native HTTP remote sends no user JWT, so the server sees an unauthenticated caller. |

## Returns

`Promise<void>` that settles once the engine has the new value. Before the app client's first use the call opens nothing: the client keeps the latest token, `null` included, and hands it to the engine ahead of every other call when the engine opens. What the token reaches once it arrives:

| Name | Type | Required | Description |
|---|---|---|---|
| Store owner | — | — | The engine reads the user id from the token's `sub` claim. The first user a local database sees becomes its owner and fills every `byOwner` bucket. A token of another user soft-blocks sync with `identity_changed` and raises `RESET_REQUIRED`, and the block holds until [Reset](./reset.md) runs. A cleared token, or one without a readable subject, changes neither the owner nor the block. |
| Native HTTP remote | — | — | The [UniFFI](https://mozilla.github.io/uniffi-rs/) engine opens its own HTTP transport from the `nativeHttpRemote` option on [Initializing](./initializing.md#parameters), and this token is the Bearer it sends on every pull and push. |
| supabase-js remote | — | — | [Create the RPC remote](./create-rpc-remote.md) calls through the supabase-js client, which attaches the session itself, so the requests do not carry this token. The browser worker and the Node addon use this lane. |

## Errors

This method throws nothing of its own. A remote that rejects the new value raises the failure on the next pull or push instead. When no session could be read at all, that failure is the retryable `AUTH_SESSION_MISSING`.

When the engine failed to open, or the client was disposed before its first use, the call rejects with the error the client kept, such as `ENGINE_UNAVAILABLE`.

## Notes

Sign-in, refresh, and storage stay in [Supabase Auth](https://supabase.com/docs/guides/auth/sessions#what-is-a-session), so this method only forwards the value that library already holds.

On the Supabase composition the wiring is automatic: `createSupabaseKizunaSync` reads [`auth.getSession()`](https://supabase.com/docs/reference/javascript/auth-getsession#examples) at construction, subscribes to the auth state, and forwards each new access token. Neither step opens the engine, so a client built at module scope holds the token until its first use. With `refreshOnForeground` left on, a return to the foreground also refreshes the session before the scheduler wakes, so the next run does not ride an expired token.

A session lookup that does not settle inside `sessionTimeoutMs` fails the attempt retryably with `AUTH_SESSION_TIMEOUT` and leaves the write queued. [Initializing](./initializing.md#parameters) lists that deadline beside the request deadline.

## Related reference

- [Initializing](./initializing.md)
- [Create the RPC remote](./create-rpc-remote.md)
- [Recover an anonymous session](./recover-anonymous-session.md)
- [Reset](./reset.md)
- [Sync](./sync.md)
- [Swift: Set access token](../swift/set-access-token.md)
- [Kotlin: Set access token](../kotlin/set-access-token.md)
