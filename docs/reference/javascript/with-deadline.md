---
title: Wait with a deadline
description: Bound how long this client waits for a call that carries no timeout of its own.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Wait with a deadline

`withDeadline(run, options)` from `@kizunasync/supabase` races a promise-returning function against a timer. auth-js issues `getSession()` and `refreshSession()` with no fetch timeout and no `AbortSignal`, so on a half-open socket either call can hang indefinitely and hold the caller's slot with it. `createSupabaseKizunaSync` wraps both calls in it; call it directly only when composing a client by hand.

## Examples

### Basic

```ts
// src/session.ts
import { withDeadline } from '@kizunasync/supabase'
import { supabase } from './supabase-client'

const result = await withDeadline(() => supabase.auth.getSession(), {
  timeoutMs: 10_000,
  onTimeout: () => new Error('getSession timed out'),
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `run` | `() => Promise<T>` | Yes | The call to bound. Started once, so a synchronous throw becomes a rejection rather than escaping the call to `withDeadline` itself. |
| `options.timeoutMs` | `number` | Yes | Milliseconds `run()` may take before the deadline wins. A value at or below `0` disables the deadline entirely: no timer is armed, and `run()` is returned as is. |
| `options.onTimeout` | `() => Error` | Yes | Builds the rejection thrown when the deadline wins. Called lazily, only when the timer fires, so it can attach fresh context. |
| `options.setTimer` / `options.clearTimer` | `(callback: () => void, delayMs: number) => unknown` / `(handle: unknown) => void` | No | Injectable timer pair. Default: the platform `setTimeout` and `clearTimeout`. |

## Returns

`Promise<T>`, settling with whichever of `run()` or the deadline settles first.

## Errors

Rejects with whatever `options.onTimeout()` returns when the deadline wins before `run()` settles, or with whatever `run()` itself rejects with otherwise.

## Notes

This helper bounds how long the caller waits, and nothing more. auth-js exposes no way to abort `getSession()` or `refreshSession()`, so a call that loses the race keeps running in the background. The helper observes that late settlement internally, so it can never surface as an unhandled rejection. For those two calls a late completion only updates local auth storage, which is harmless to drop.

`createSupabaseKizunaSync` uses it for the `sessionTimeoutMs` deadline on the session read before every pull and push, on the anonymous sign-in the `anonymousSignIn` option runs, and on the foreground refresh, documented on [Initializing](./initializing.md#parameters). [Create the Storage transfer](./create-supabase-transfer.md) uses a separate deadline pair for the byte-moving requests, because a body under a slow link legitimately needs longer than a session lookup.

## Related reference

- [Initializing](./initializing.md)
- [Sync](./sync.md)
- [Create the Storage transfer](./create-supabase-transfer.md)
