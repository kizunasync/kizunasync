---
title: Create the RPC remote
description: Build the protocol remote that calls the pull and push functions over supabase-js.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Create the RPC remote

`createRpcRemote(client, options?)` from `kizunasync/supabase` builds the protocol remote: the pair of calls the engine makes to move data. It forwards the engine's request envelope to the `pull` and `push` functions the SQL pack installs, and adds nothing of its own to the body.

The `createSupabaseKizunaSync` call in `src/kizunasync.ts`, shown on [Initializing](./initializing.md#create-the-app-client), builds this remote by itself and forwards its `remoteOptions` here, so an app calls this factory only when it assembles the client by hand with `createKizunaSync`, in that same file. Read this page to see what the remote sends and which failures count as permanent.

## Examples

### Basic

```ts
// src/kizunasync.ts (excerpt)
import { createRpcRemote } from 'kizunasync/supabase'
import { supabase } from './supabase-client'

const remote = createRpcRemote(supabase)
```

### Pass it to the client

The hand-assembled module from [Initializing](./initializing.md#without-the-supabase-composition), in full:

```ts
// src/kizunasync.ts
import { createKizunaSync, defineConfig } from 'kizunasync'
import { createRpcRemote } from 'kizunasync/supabase'
import { createWebWorkerDriver } from 'kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({ tables: { todos: { sync: 'read-write' } } })

export const kizunasync = createKizunaSync(createWebWorkerDriver('todos.db'), createRpcRemote(supabase), config)
```

### Keep device-only columns off the wire

On the Supabase composition the same options travel as `remoteOptions`, with no call to this factory:

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
  remoteOptions: { localOnlyColumns: ['local_image_uri'], requestTimeoutMs: 60_000 },
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `client` | `SupabaseClient` | Yes | The supabase-js client. Every call goes through its `kizunasync` schema, so that schema must be exposed to the Data API, and the client's session is what authenticates the caller. |
| `options.localOnlyColumns` | `readonly string[]` | No | Column names stripped from every mutation before it is pushed, for values the server has no column to apply. Pull is unaffected, because a server row never carries them. Default: none. |
| `options.requestTimeoutMs` | `number` | No | How long one call may take before the request is aborted and the attempt fails retryably. A value at or below `0` disables the deadline. Default: `DEFAULT_REQUEST_TIMEOUT_MS` (`30000`), which matches the scheduler's backoff ceiling so a wedged socket costs at most one retry window. |

## Returns

`IProtocolRemote`, the value [Initializing](./initializing.md#parameters) takes as its `remote` argument.

| Name | Type | Required | Description |
|---|---|---|---|
| `pull` | `(request: TPullRequest) => Promise<TPullResponse>` | — | Calls the `pull` function with the buckets, the cursor, the schema version, and the page limit. |
| `push` | `(request: TPushRequest) => Promise<TPushResponse>` | — | Calls the `push` function with the batch, the exactly-once watermark, and the schema version, after stripping the device-only columns. |

Both are ordinary [Postgres function calls](https://supabase.com/docs/reference/javascript/rpc#parameters) through supabase-js, bound to an abort controller rather than left to run without a deadline, because supabase-js has none of its own.

## Errors

A failure is thrown as an `Error` tagged with whether it may be retried, which is what the dead-letter budget on [Sync](./sync.md#errors) reads.

| Code | Condition |
|---|---|
| Permanent | A Postgres data, constraint, or syntax fault, meaning SQLSTATE class 22, 23, or 42, plus exactly `P0001` from an uncoded exception in a trigger and exactly `0A000`, which the pack raises for a non-conforming client. These count against the retry budget. |
| Retryable | Everything else, including a blown deadline, a lost connection, a 5xx, an expired token, and `42501`. |

`42501` is the one class 42 code the table above treats as retryable, and that is deliberate. The pack turns a row-level refusal into a normal response carrying reason `RLS_DENIED`, and a column-level one into `COLUMN_DENIED`. `42501` therefore names a grant, a role, or a missing token instead. Supabase separates those from policies under [grants and policies](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies).

## Notes

This adapter knows nothing about your tables. The request bodies mirror the SQL argument names one for one, so the whole fenced transaction is decided on the server, which [SQL pack](../sql-pack.md#functions) documents.

The session comes from outside this adapter as well. On the Supabase composition, [Initializing](./initializing.md) is what reads the session before every call and applies it, and a missing one raises the retryable `AUTH_SESSION_MISSING` rather than falling back to the publishable key.

## Related reference

- [Initializing](./initializing.md)
- [Sync](./sync.md)
- [Set access token](./set-access-token.md)
- [Create the Storage transfer](./create-supabase-transfer.md)
- [SQL pack](../sql-pack.md)
