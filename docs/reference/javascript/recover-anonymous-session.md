---
title: Recover an anonymous session
description: Keep the same anonymous identity across a reload before minting a new one.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Recover an anonymous session

`recoverAnonymousSession(auth, options?)` from `kizunasync/supabase` returns the anonymous user this device already had, and mints a new one only once a read and a refresh both say the session is gone for good. It exists because a fresh anonymous user would orphan the [outbox](../../resources/glossary.md#outbox): the queued writes belong to the previous identity, and the server would refuse them.

## Examples

### Let the app client sign in

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { createWebWorkerDriver } from 'kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
  anonymousSignIn: true,
})
```

With `anonymousSignIn: true` the app client calls this helper whenever it finds no session, so the app itself never does.

### Call it directly

```ts
// src/session.ts
import { recoverAnonymousSession } from 'kizunasync/supabase'
import { supabase } from './supabase-client'

const user = await recoverAnonymousSession(supabase.auth)

console.info('This device syncs as', user?.id)
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `auth` | `IRecoverableAuth` | Yes | The auth slice of a supabase-js client, or anything exposing the same three methods. Anonymous sign-in must be enabled on the project. |
| `auth.getSession` | `() => Promise<{ data: { session: { user: { id: string } } \| null } }>` | Yes | Read first. A live session is returned as is. |
| `auth.refreshSession` | `() => Promise<{ data: { session }; error }>` | Yes | Tried second. The persisted refresh token restores an expired access token, which is the case a reload usually lands in. |
| `auth.signInAnonymously` | `() => Promise<{ data: { user }; error }>` | Yes | Tried last, only when the two reads above found no session and the failure means the session is gone rather than merely unreachable. |
| `options.captchaToken` | `() => Promise<string>` | No | Called only when a new identity must be minted, to satisfy the project's [captcha protection](https://supabase.com/docs/guides/auth/auth-captcha#enable-captcha-protection-for-your-supabase-project) when it is on. Never called when a persisted or refreshed session is recovered. Default: none, so `signInAnonymously` is called with no captcha token. `anonymousSignIn: { captchaToken }` hands the app client's recovery the same function. |

## Returns

`Promise<{ id: string } \| null>`.

The existing user comes back when a session was live, or when the refresh restored one, and that identity is unchanged, so the queued writes belong to it regardless. A newly minted anonymous user comes back when the refresh failed with a signal that the session itself is gone, and it is a different identity, so rows written under the previous one stay with it. `null` comes back when the mint reported no error and carried no user.

## Errors

Two steps can throw. A refresh failure that does not say the session is gone, a network fault or a 5xx among them, throws that same failure rather than minting a new identity: silently minting one there would orphan the outbox under a session that may still come back. A rejected [`signInAnonymously`](https://supabase.com/docs/reference/javascript/auth-signinanonymously#examples) throws as well. Either error keeps the `name` and `code` the auth API's own `AuthError` carried, wrapped in a plain `Error` when the failure was not one already.

The signals that count as "the session is gone," and so let the mint proceed, are the `AuthSessionMissingError` name and the `refresh_token_not_found`, `refresh_token_already_used`, and `session_not_found` codes.

## Notes

The `anonymousSignIn` option on [Initializing](./initializing.md#parameters) runs this helper for you. When the session read before a pull or a push finds no session, the Supabase composition calls it under the `sessionTimeoutMs` deadline and reads the session again. A recovery that fails or runs past the deadline fails that attempt retryably, and the automatic loop tries again on the next one.

This helper is for playgrounds, demos, and apps whose first run has no sign-in screen. An app with real accounts signs users in through supabase-js, and the app client follows that session by itself.

A second call for the same `auth` while one is already in flight joins it rather than racing it, so React's double-invoke effect in development, or two components mounting together, cannot mint two identities for one device. Only the call that started the flight has its own `captchaToken` invoked.

A new anonymous user starts an empty local dataset in the eyes of the server. Supabase covers the session lifecycle itself under [sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session).

A minted user is a new identity. When the local database already belongs to the previous anonymous user, sync soft-blocks with `identity_changed` until [Reset](./reset.md) runs, and the reset discards that user's queued writes.

## Related reference

- [Set access token](./set-access-token.md)
- [Reset](./reset.md)
- [Initializing](./initializing.md)
