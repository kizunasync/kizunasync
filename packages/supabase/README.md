<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/supabase</span>
</h1>

Supabase integration for Kizuna: the RPC remote, Realtime wakeup, Storage transfer, and one-call composition between `kizunasync` and a `SupabaseClient`.

## Install

This workspace is private. Apps install the `kizunasync` package and import it as `kizunasync/supabase`.

```bash
npm install kizunasync @supabase/supabase-js
```

## Exports

- `createSupabaseKizunaSync`: one-call composition. Takes `{ supabase, driver, config, ...options }` and returns a wired `IKizunaSync`. The remote is always the fenced RPC adapter below. A `fileStore` implies the Storage transfer. `realtimeWakeups` in the config implies the Realtime doorbell on the config's tables. An explicit `transfer` or `wakeup` always wins; `remoteOptions` reaches the RPC adapter untouched. With `anonymousSignIn`, a session gate that finds no session calls `recoverAnonymousSession` under `sessionTimeoutMs` and reads the session again; pass `{ captchaToken }` when the project protects anonymous sign-ins with a captcha.
- `createDocumentForeground`: wraps a `document`-shaped object into an `IForeground` port (`visibilitychange`, Page Lifecycle `resume`, and `pageshow` with `persisted: true`). `createSupabaseKizunaSync` uses it when `document` exists and neither a `foreground` option nor the driver's `platformPorts.foreground` is present.
- `createRpcRemote`: forwards pull/push envelopes to `kizunasync.pull` / `kizunasync.push`. Permanent SQL faults count against the dead-letter budget; network and environmental failures stay queued. `localOnlyColumns` strips device-only columns before push. Default request deadline is `DEFAULT_REQUEST_TIMEOUT_MS` (30000).
- `createSupabaseTransfer`: attachment byte mover over Supabase Storage, content-addressed against the local file store. Control calls default to 30s; byte-moving calls to 120s. Peer download metadata goes through `kizunasync.attachment_metadata`, not a direct `SELECT` on `attachments`.
- `createRealtimeWakeup`: a contentless per-table hint that a [pull](../../docs/resources/glossary.md#pull) may find work. Never a data channel.
- `recoverAnonymousSession`: recovers the same uid across a reload or expired token so a fresh anonymous identity does not orphan the outbox. Tries `getSession`, then `refreshSession`, then `signInAnonymously`.
- `withDeadline`: races a promise against an injectable timer for auth calls that have no fetch timeout of their own.
- `AUTH_SESSION_MISSING`, `AUTH_SESSION_TIMEOUT`, `DEFAULT_SESSION_TIMEOUT_MS`, and the matching error helpers: stable codes behind the session gate run before every pull/push and foreground refresh.
- `tusUpload`, `tusEndpointFromSupabaseUrl`, `TUS_CHUNK_SIZE`, `SINGLE_SHOT_MAX_BYTES`, `TTusUploadOptions`, `TTusUploadResult`: resumable-upload primitives and their option/result types. Single-shot ceiling and TUS chunk size are both 6 MiB. The queue persists the session URL and progress; a retry `HEAD`s that URL for the authoritative offset.

This package implements the TUS path. The mocked transfer tests here cover it. The optional live Storage suite runs only when its credentials and opt-in environment are present.

## Related

- [`@kizunasync/supabase-pack`](../supabase-pack/README.md): SQL pack that `kizunasync init` provisions
- [Docs](https://kizunasync.com/docs)
- [`@kizunasync/core`](../core/README.md)
