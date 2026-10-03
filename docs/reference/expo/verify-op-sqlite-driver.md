---
title: Verify op-sqlite
description: Run the five-operation capability gate against a real op-sqlite handle.
status: alpha
docType: reference
library: expo
pageKind: method
audience: app-developer
---

# Expo: Verify op-sqlite

`verifyOpSqliteDriver` is the one function in `@kizunasync/expo` that opens a live op-sqlite connection. It opens that connection, runs a create, an insert, a select, and a delete through it, and reports each of the five steps rather than throwing. [`openOpSqliteDriver`](./open-op-sqlite-driver.md) opens no connection and never loads the peer: it returns a path locator for the Rust kernel, which opens the file itself. This gate is therefore the only place Kizuna loads op-sqlite and runs SQL through it.

An app needs this page only when it ships the [op-sqlite driver](./open-op-sqlite-driver.md). Such an app calls the gate from a development build before each release that includes that driver, either from a hidden debug screen or from the device test runner. Nothing in `src/kizunasync.ts` calls `verifyOpSqliteDriver`: that file names the store through `openOpSqliteDriver`, and the app client never sees the connection this gate opens.

## Examples

### Run the gate on a device

The function lives in `src/verify-op-sqlite.ts` and returns the whole result, so a debug screen can render each check and a device test can assert that `ok` is `true`.

```ts
// src/verify-op-sqlite.ts
import { verifyOpSqliteDriver, type TOpSqliteVerifyResult } from '@kizunasync/expo/op-sqlite'

export async function verifyOpSqlite(): Promise<TOpSqliteVerifyResult> {
  const result = await verifyOpSqliteDriver()

  if (!result.ok) {
    console.error(result.checks.filter((check) => !check.ok))
  }

  return result
}
```

### Inject a module in a unit test

```ts
// src/op-sqlite-driver.test.ts
import { expect, test } from 'bun:test'
import { verifyOpSqliteDriver, type IOpSqliteModule } from '@kizunasync/expo/op-sqlite'

const fakeOpSqlite: IOpSqliteModule = {
  open: () => ({
    executeSync: (sql) => (sql.startsWith('SELECT') ? { rows: [{ id: 'one', v: 1 }] } : { rows: [] }),
  }),
}

test('the op-sqlite gate passes against an injected module', async () => {
  const result = await verifyOpSqliteDriver('verify.db', { module: fakeOpSqlite })

  expect(result.ok).toBe(true)
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | No | The database the gate opens for the check. It is a scratch database, and the gate cleans up the row it writes but not the file. Default: `'kizunasync-op-sqlite-verify'`. |
| `options` | `TOpenOpSqliteOptions` | No | `location` as [`openOpSqliteDriver`](./open-op-sqlite-driver.md) takes it, but optional here, plus `module`. The gate passes `location` to op-sqlite's `open()` and builds no locator, so it skips that function's required-location check. Default: `{}`. |
| `options.location` | `string` | No | Absolute directory for the database file, as a path or a `file://` URI, passed to op-sqlite as `location` with the scheme and a trailing slash removed. Default: none, which leaves op-sqlite's own default directory. |
| `options.module` | `IOpSqliteModule` | No | An injected module with an `open({ name, location })` method, used in place of the native one. On a device, call without it. Default: a dynamic import of `@op-engineering/op-sqlite`. |

## Returns

`Promise<TOpSqliteVerifyResult>`.

| Name | Type | Required | Description |
|---|---|---|---|
| `ok` | `boolean` | — | `true` when every entry in `checks` passed. A thrown failure anywhere in the sequence makes it `false` rather than propagating. |
| `checks` | `Array<{ name: string; ok: boolean; detail?: string }>` | — | One entry per step reached, in order. |
| `checks[].name` | `string` | — | The step: `open`, `create_table`, `insert`, `select`, then `delete`. A thrown failure appends a final `error` entry instead of the remaining steps. |
| `checks[].ok` | `boolean` | — | Whether that step passed. Only `select` and `error` can be `false`; the other three either pass or throw. |
| `checks[].detail` | `string` | — | Present only on a failing entry. `select` carries the rows it got as JSON; `error` carries the stringified thrown value. |

## Errors

`verifyOpSqliteDriver` throws nothing. Every failure is caught and recorded as the `error` check with `ok: false`, so a release script can print every step instead of a stack trace. A missing or unlinked optional peer fails the load, and that entry's `detail` carries `verifyOpSqliteDriver: failed to load @op-engineering/op-sqlite`, followed by the install hint and the underlying cause.

## Notes

Run it on a physical device, or at least on a native binary host. There is no web build of op-sqlite, so the gate cannot pass on [Expo](https://expo.dev) web and is not a check to run there.

The five steps are a create, an insert, a select, and a delete against a private `_kizunasync_verify` table, plus the open itself. A passing run is evidence for those five operations and for nothing else, which is the distinction [Match the test to the claim](../../operations/test-offline-behavior.md#6-match-the-test-to-the-claim) draws. The protocol corpus covers the engine above the driver port, not the driver.

The `module` option exists so the same gate runs in a unit test without a native binary. That path proves the sequence and the result shape, not the native module.

## Related reference

- [op-sqlite driver](./open-op-sqlite-driver.md)
- [Open the SQLite driver](./open-expo-driver.md)
- [Initializing](./initializing.md)
- [Drivers and the TCK](../drivers-and-tck.md#what-a-driver-needs-beyond-the-corpus)
