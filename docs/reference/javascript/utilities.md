---
title: Utilities
description: Standalone functions, types, and constants @kizunasync/core exports beside its composed client surface.
status: alpha
docType: reference
library: javascript
pageKind: type
audience: app-developer
---

# JavaScript: Utilities

`@kizunasync/core` exports a handful of standalone functions, types, and constants beside the client [Initializing](./initializing.md#returns) returns. No other reference page names them, because the composed client already exposes the behavior most of them implement: an application reaches for one of these directly only when it assembles its own [`ITransfer`](./types.md#ports), [`IEngineTransport`](./types.md#ports), or [`ILogger`](./types.md#ports) instead of the shipped [`@kizunasync/supabase`](./create-supabase-transfer.md) and [`@kizunasync/web`](./create-web-worker-driver.md) adapters.

## Examples

```ts
// @kizunasync/core
import {
  contentKey,
  createLogger,
  createRequestSignal,
  createSignedUrlDownload,
  createTransferTimeoutError,
  INTERNAL_TABLES,
  isArrayRemove,
  isArrayUnion,
  isIncrement,
  isJsonObject,
  mimeForExt,
  noopLogger,
  parseFailureEnvelope,
  readEngineJson,
  reReadsRows,
  SCHEMA,
  SIGNED_URL_TTL_SECONDS,
  TRACKERS,
  type IEngineLeadership,
  type ILoggerOptions,
  type TLogLevel,
} from '@kizunasync/core'
```

### Bound a fetch by its own deadline

```ts
// src/storage-transfer.ts
import { createRequestSignal } from '@kizunasync/core'

export async function fetchWithDeadline(url: string): Promise<Response> {
  const { signal, timedOut, release } = createRequestSignal({ timeoutMs: 30_000 })

  try {
    return await fetch(url, { signal })
  } catch (error) {
    throw timedOut() ? new Error(`${url} did not answer within 30 seconds`) : error
  } finally {
    release()
  }
}
```

### Recover a failure that crossed postMessage as text

```ts
// src/engine-host.ts
import { parseFailureEnvelope } from '@kizunasync/core'

export function rethrowEngineFailures(worker: Worker): void {
  worker.addEventListener('message', (event) => {
    const failure = parseFailureEnvelope(event.data as string)

    if (failure !== null) throw failure
  })
}
```

### Share one logger with the Storage transfer

```ts
// src/storage-transfer.ts
import { createLogger } from '@kizunasync/core'
import { createSupabaseTransfer } from '@kizunasync/supabase'
import { createWebFileStore } from '@kizunasync/web'
import { supabase } from './supabase-client'

const logger = createLogger({ level: 'warn' })
const fileStore = createWebFileStore()

export const transfer = createSupabaseTransfer({ client: supabase, fileStore, logger })
```

## File paths and MIME types

Two pure functions behind the attachment pipeline's file naming.

| Name | Type | Required | Description |
|---|---|---|---|
| `contentKey(sha)` | `(sha: string) => string` | — | The content-addressed sandbox path for a payload hashed to `sha`: `` `content/${sha}` ``. Every [`IFileStore`](./types.md#ports) implementation in this tree keys a downloaded or attached file by this path. |
| `mimeForExt(ext)` | `(ext: string) => string \| null` | — | The MIME type for a file extension such as `'png'` or `'pdf'`, `null` for an extension the table does not carry. The reverse mapping, which names an upload from its content type, stays internal to the attachment queue. |

## Field transform guards

Type guards for the three sentinels [`increment`](./using-transforms.md#returns), [`arrayUnion`](./using-transforms.md#returns), and [`arrayRemove`](./using-transforms.md#returns) build, for code that narrows an `unknown` update value before branching on its shape.

| Name | Type | Required | Description |
|---|---|---|---|
| `isIncrement(value)` | `(value: unknown) => value is TIncrementSentinel` | — | `true` for the sentinel `increment()` returns. |
| `isArrayUnion(value)` | `(value: unknown) => value is TArrayUnionSentinel` | — | `true` for the sentinel `arrayUnion()` returns. |
| `isArrayRemove(value)` | `(value: unknown) => value is TArrayRemoveSentinel` | — | `true` for the sentinel `arrayRemove()` returns. |

## Engine call parsing

The guarded parse every JSON text crossing the engine boundary goes through, and the parser built on it for every bridge's `{ ok: true, value } | { ok: false, error }` call envelope, exported for a host that receives that envelope as text rather than as a return value.

| Name | Type | Required | Description |
|---|---|---|---|
| `isJsonObject(value)` | `(value: unknown) => value is Record<string, unknown>` | — | `true` for a JSON object: not `null`, not an array. |
| `readEngineJson(raw, isShape)` | `<T>(raw: string, isShape: (value: unknown) => value is T) => T` | — | Parses `raw` and narrows the result with `isShape`. Text that is not JSON, or does not match `isShape`, throws the same [`TEngineError`](./types.md#rejections-overwrites-and-errors) the engine itself throws for an unreadable envelope, coded `JSON`. |
| `parseFailureEnvelope(raw)` | `(raw: string) => TEngineError \| null` | — | Parses a failure envelope JSON string into the same [`TEngineError`](./types.md#rejections-overwrites-and-errors) every bridge throws, or `null` when `raw` does not parse as that shape, or its failure carries no catalog code. [`createWebWorkerDriver`](./create-web-worker-driver.md) uses it to turn a failure that crossed `postMessage` as text back into a typed error. |

## Query re-read events

The filter behind [React: useQuery](../react/use-query.md) and [Vue: useQuery](../vue/use-query.md): which [`TEngineEvent`](./types.md#sync-state) types can change what a row read would return, so a subscriber re-reads only on those.

| Name | Type | Required | Description |
|---|---|---|---|
| `reReadsRows(event)` | `(event: TEngineEvent) => boolean` | — | `true` for `LOCAL_CHANGED`, `RESET_REQUIRED`, and `CHECKPOINT_EXPIRED`, the events that carry a row change of their own or gate/rehydrate the local snapshot. Every other event either carries no row change (`QUEUE_DEPTH`, a verdict) or rides a `LOCAL_CHANGED` from the same commit (`COLUMN_OVERWRITTEN`). |

## Logging

The factory behind the client's `logging` option, documented on [Initializing](./initializing.md#parameters), for an application that builds one logger and shares it across more than one adapter.

| Name | Type | Required | Description |
|---|---|---|---|
| `createLogger(options?)` | `(options?: ILoggerOptions) => ILogger` | — | Returns `options.logger` verbatim when supplied, the built-in `adze`-backed logger for any level but `'silent'`, and `noopLogger` for `'silent'` or when `options` is omitted. |
| `noopLogger` | `ILogger` | — | The sink every method on it drops silently, `.child()` included, which returns itself. What `createLogger()` returns by default. |
| `ILoggerOptions` | `type` | — | `{ level?: TLogLevel; logger?: ILogger }`, the shape `createLogger` and the client's `logging` option share. |
| `TLogLevel` | `type` | — | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'`, also what [`createConsoleLogger`](./types.md#diagnostics-and-utilities) takes. |

## Request and transfer deadlines

Two pieces [Wait with a deadline](./with-deadline.md) is built from, for an adapter that bounds one `fetch` call directly instead of racing a whole promise.

| Name | Type | Required | Description |
|---|---|---|---|
| `createRequestSignal(options?)` | `(options?: ICreateRequestSignalOptions) => IRequestSignal` | — | Builds an `AbortSignal` that aborts on an `options.timeoutMs` deadline, on a caller's own `options.parentSignal`, or on both, so a `catch` block can read `timedOut()` to tell the two apart before calling `release()`. |
| `createTransferTimeoutError(options)` | `(options: ICreateTransferTimeoutErrorOptions) => Error` | — | Builds the retryable error a blown transfer deadline rejects with, coded `ETransferError.timedOut`. `options.operation` names the request (`'upload'`, `'sign'`, `'download'`); `options.detail` appends context in parentheses. |

## Signed URL downloads

The `download` half of an [`ITransfer`](./types.md#ports) adapter, built once and reused: [Create the Storage transfer](./create-supabase-transfer.md) calls it, and a host with its own Storage layer can call it directly.

| Name | Type | Required | Description |
|---|---|---|---|
| `createSignedUrlDownload(options)` | `(options: ICreateSignedUrlDownloadOptions) => ITransfer['download']` | — | Signs the object's URL under `options.controlTimeoutMs`, fetches it under `options.bytesTimeoutMs` through the caller's own `options.fetchBytes`, and writes the bytes through `options.fileStore`. `options.client` types only the one call the function makes (`storage.from(bucket).createSignedUrl`), so this function carries no supabase-js type dependency. Rejects with `ATTACHMENT_HASH_MISMATCH` before writing when the download's own options named a `sha256` and the fetched bytes hash to something else. |

## Multi-tab engine leadership

The optional member on [`IEngineTransport`](./types.md#ports) a transport implements when it shares one engine across more than one host, such as the browser worker driver's tabs.

| Name | Type | Required | Description |
|---|---|---|---|
| `IEngineLeadership` | `interface` | — | `isLeader()` reads whether this host currently drives the shared engine's automatic sync loop; every host's own calls still reach the engine regardless. `subscribe(onChange)` calls `onChange(leader)` on every change and returns the unsubscribe function. A transport with no `leadership` member always leads its own engine. |

## Server schema constants

The Postgres schema name and object names [`kizunasync init`](../../cli/cli.md#kizunasync-init) provisions, exported so client code names them without repeating the literals the [SQL pack](../sql-pack.md) installs.

| Name | Type | Required | Description |
|---|---|---|---|
| `SCHEMA` | `const` | — | `'kizunasync'`, the Postgres schema every server-side Kizuna object lives under. [`createRpcRemote`](./create-rpc-remote.md) and [`createSupabaseTransfer`](./create-supabase-transfer.md) pass it to `client.schema(...)` to reach that schema through [PostgREST](https://postgrest.org/). |
| `INTERNAL_TABLES` | `const` | — | `{ config: '_config', provisions: '_provisions', settings: '_settings' }`, the bookkeeping table names, unqualified. Schema-qualify with `SCHEMA`. |
| `TRACKERS` | `const` | — | `{ change: 'track_change', delete: 'track_delete' }`, the change-capture routine base names: the SQL function is `` `${SCHEMA}.<name>()` `` and the per-table trigger is `` `${SCHEMA}_<name>` ``. |
| `SIGNED_URL_TTL_SECONDS` | `const` | — | `60`, the TTL in seconds `createSignedUrlDownload` requests for every signed download URL it mints. |

## Notes

`INTERNAL_TABLES`, `SCHEMA`, and `TRACKERS` name what the SQL migration in `packages/supabase-pack` installs. Both sides are kept in lockstep by hand, because the migration is plain SQL and cannot import a TypeScript constant; a rename on one side needs the matching edit on the other.

## Related reference

- [Types](./types.md)
- [Using transforms](./using-transforms.md)
- [Wait with a deadline](./with-deadline.md)
- [Create the Storage transfer](./create-supabase-transfer.md)
- [Open the browser driver](./create-web-worker-driver.md)
- [Initializing](./initializing.md)
- [React: useQuery](../react/use-query.md)
- [Vue: useQuery](../vue/use-query.md)
