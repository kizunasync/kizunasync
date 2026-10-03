---
title: Test offline behavior
description: Exercise the sync engine deterministically, and know which platform guarantees need a real browser, device, or Supabase project.
status: alpha
docType: how-to
audience: app-developer
---

# Test offline behavior

Exercise local writes and synchronization against the real engine, a temp-file store, and an in-memory remote. Build the [N-API](https://nodejs.org/api/n-api.html) addon with `bun run cargo:napi` first. These tests need no network, browser, simulator, or physical device.

Every test on this page builds a client with [`createKizunaSync`](../reference/javascript/initializing.md). That client runs the Rust engine, which it opens on its first engine call, and where no artifact resolves that call fails with `ENGINE_UNAVAILABLE`. [Engine selection](../getting-started/status.md#engine-selection) describes both outcomes. Under Bun that addon is the artifact, and there is nothing else for the client to run. A pass covers the engine path the test executed, so the last section maps each claim to the evidence that supports it.

The `@kizunasync/*` packages are private monorepo workspaces, so the example tests below run from a checkout of `kizunasync/kizunasync`. To provision sync in your own app, follow the [Quick start](../getting-started/quickstart.md).

## Before you begin

- [Install Bun](https://bun.sh/docs/installation). This repository's test tooling runs on it throughout, so the examples on this page do not run under [Node.js](https://grokipedia.com/page/Node.js), Jest, or npm's test runner.
- Read [Offline writes](../sync/offline-writes.md) if the outbox and the order of a sync run are new to you.
- The CLI is not required for the in-memory tests on this page. Provision a live project with `kizunasync` through [Install](../cli/install.md) when you move past the fakes.
- For CLI-driven test data instead of hand-written fakes, [`kizunasync mock`](../cli/cli.md#kizunasync-mock-test-tooling) seeds deterministic rows and churn against a synced table.
- Corpus evidence is a result that proves conformance to the recorded protocol transcripts. It comes from the conformance runner in `crates/kizunasync-conformance` and the `core-on-rust` CI job. The example `sync-flow` files on this page do not produce it. Swift and Kotlin host tests live with the [UniFFI](https://mozilla.github.io/uniffi-rs/) packages. See [Swift and Kotlin](../getting-started/native-clients.md#6-start-the-host-scheduler) and [CI and CD](./ci-cd.md#rust-workflow).

## 1. Run the shipped example tests

The [React](https://react.dev), [Vue](https://vuejs.org), and [Expo](https://expo.dev) examples each carry a `sync-flow.test.ts`. Each one drives [`createKizunaSync`](../reference/javascript/initializing.md) on the Rust engine through the N-API addon. The Expo example also carries `wrapper-integration.test.ts`. That file drives [`createKizunaSync`](../reference/javascript/initializing.md) and the real [`createRpcRemote`](../reference/javascript/create-rpc-remote.md) adapter against a fake client, one that implements only `.schema().rpc()`. Supabase documents that call shape in [`rpc`](https://supabase.com/docs/reference/javascript/rpc#parameters). Kizuna sends only its two protocol functions through it, `kizunasync.pull` and `kizunasync.push`.

Build the addon with `bun run cargo:napi` first.

Run those four files from the repository root:

```bash
bun test \
  examples/todo-react/src/sync-flow.test.ts \
  examples/todo-vue/src/sync-flow.test.ts \
  examples/todo-expo/src/sync-flow.test.ts \
  examples/todo-expo/src/wrapper-integration.test.ts
```

Each suite rebuilds its example's engine configuration over in-memory fakes. None of them loads React DOM, Vue DOM, Expo, OP-SQLite, a browser worker, or a live Supabase project. You should now see four files pass with no network traffic.

## 2. Test a local write and sync

`kizunasync/testing` exports `createTempDatabase`, which names a fresh temp file per call and returns an `IStoreLocator` naming it. Supply the smallest [`IProtocolRemote`](../reference/drivers-and-tck.md#port-model) the scenario needs alongside it. The locator names its database file, so the client can open the Rust engine on the same one:

```ts
// src/sync-flow.test.ts
import { expect, test } from 'bun:test'
import {
  createKizunaSync,
  defineConfig,
  type IProtocolRemote,
} from 'kizunasync'
import { createTempDatabase } from 'kizunasync/testing'

test('an offline insert stays local until sync drains the outbox', async () => {
  const db = createTempDatabase()
  const remote: IProtocolRemote = {
    pull: (request) => Promise.resolve({
      cursor: request.cursor,
      has_more: false,
      rows: [],
      signal: null,
      tombstones: [],
    }),
    push: (request) => Promise.resolve({
      verdicts: request.batch.mutations.map((mutation) => ({
        mutation_id: mutation.mutation_id,
        verdict: 'applied' as const,
      })),
    }),
  }
  let minted = 0
  const kizunasync = createKizunaSync(
    db.driver,
    remote,
    defineConfig({
      tables: {
        todos: { sync: 'read-write' },
      },
    }),
    {
      uuid: () => `00000000-0000-4000-8000-${String((minted += 1)).padStart(12, '0')}`,
      now: () => '2030-03-17T00:00:00.000Z',
      pollIntervalMs: 0,
      shouldSyncAutomatically: () => false,
    },
  )

  try {
    await kizunasync.from('todos').insert({
      id: 'todo-1',
      title: 'offline first',
      user_id: 'user-1',
    })

    expect(await kizunasync.getOutboxDepth()).toBe(1)
    await kizunasync.sync()
    expect(await kizunasync.getOutboxDepth()).toBe(0)
  } finally {
    kizunasync.dispose()
    db.remove()
  }
})
```

You should now see the [outbox](../resources/glossary.md#outbox) depth go from one to zero without a request leaving the process. The fake remote stamps every mutation applied, so the test covers the drain, not a real Supabase project accepting the write.

The two options keep the drain where the test calls `sync()`. A local write wakes the automatic loop within a quarter of a second, and the first engine call starts that loop with an attempt of its own, so without `shouldSyncAutomatically: () => false` the outbox could drain before the test reads its depth. `pollIntervalMs: 0` arms no poll timer.

For multi-device pull, [tombstone](../resources/glossary.md#tombstone), and [idempotency](https://grokipedia.com/page/Idempotence) scenarios, read the shipped `sync-flow.test.ts` files as the current executable reference. Their remote is a `Map` that mimics a [PostgREST](https://postgrest.org/)-shaped backend. They therefore cover engine behavior, not the policies the [SQL pack](../reference/sql-pack.md) installs. All three example configs are bucketless. What keeps one fake owner's rows away from another is the fake backend itself, which filters by owner in its own code, rather than a client-side bucket. That matches how each example's real `defineConfig` reads.

## 3. Test the public app client

Section 2 stops at a hand-written remote. Reach for a real adapter when you want the boundary to Supabase covered as well. The shipped Expo `wrapper-integration.test.ts` builds three pieces:

1. `createTempDatabase()`'s locator.
2. [`createRpcRemote`](../reference/javascript/create-rpc-remote.md) around a fake Supabase client that implements only `.schema(name).rpc(fn, args)`.
3. The app client, built over both.

It asserts that an awaited [`insert`](../reference/javascript/insert-data.md), [`update`](../reference/javascript/update-data.md), or [`delete`](../reference/javascript/delete-data.md) changes the [local SQLite](https://grokipedia.com/page/SQLite) view, that [`sync()`](../reference/javascript/sync.md) calls only the `push` and `pull` RPCs, and that a later local [`select()`](../reference/javascript/fetch-data.md) makes no remote call. You should now see a suite that covers the adapter boundary. It makes no network request, so it evaluates none of the policies Supabase documents in [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#write-a-policy-for-each-operation); Kizuna enforces those on push, against the live database, and never locally.

## 4. Replay the protocol corpus

The client conformance harness lives in the `conformance` subpath of the `core` workspace. It reads the current manifest and transcript files that [Protocol overview](../sync/protocol-overview.md#conformance-boundary) describes, rather than copying bytes out of them. It drives a fresh engine for each runnable case. Both of those are why it runs inside a repository checkout and not from an installed `kizunasync`.

Two lanes in this repository already run it against the shipped engine. Both execute the same 49 of the 50 manifest entries and skip the same 1. `packages/core/src/conformance/client-executor.test.ts` is the N-API lane. It opens one engine per case with `makeTransportClient` over the addon's `KizunaSyncEngine` constructor. It replays the golden responses through a `TranscriptRemote` that asserts the request bytes the engine emitted, and it fails a case whose bytes or resulting local state diverge.

```bash
bun run cargo:napi
bun test packages/core/src/conformance/client-executor.test.ts
```

`packages/web/conformance/corpus.spec.ts` is the browser lane. It drives the same executor and the same corpus against that engine compiled to [WebAssembly](https://grokipedia.com/page/WebAssembly) inside the `kizunasync/web` worker, and asserts the identical counts, so a divergence between the two lanes is a finding about the engine on wasm and never a case to skip.

```bash
bun run cargo:wasm
bun run --filter @kizunasync/web test:browser
```

To replay the corpus against an engine of your own, implement `IProtocolClient` and pass a factory for it to `runCorpusClient(resolveCorpusRoot(), makeClient)`. Read `makeTransportClient` first, because it is the shipped implementation.

Anything that speaks the `IEngineTransport` port needs no executor of its own.

You should now see zero results with status `fail`. A manifest entry gated on an open entry in [Protocol decisions](../resources/protocol-decisions.md) comes back as `skipped-blocked`, which is a case the harness did not run rather than a case it passed. Request-byte conformance also says nothing about a new SQL driver, as [Drivers and the TCK](../reference/drivers-and-tck.md#what-a-driver-needs-beyond-the-corpus) sets out: add driver-specific transaction, persistence, and platform tests around any custom implementation.

## 5. Add failure cases

Cover at least the paths your application depends on:

- a local insert is visible before the remote receives it;
- a successful push drains the [outbox](../resources/glossary.md#outbox);
- a transport error leaves the mutation queued for a later sync;
- a rejection reaches [`rejections()`](../reference/javascript/rejections.md) and can be dismissed with [`dismissRejection`](../reference/javascript/dismiss-rejection.md);
- a second client pulls the first client's row;
- a tombstone removes that row on the second client;
- [owner-scoped buckets](../sync/sync-rules-and-buckets.md#byownercolumn) return no other owner's rows from your fake;
- an awaited filtered update or delete changes the intended local rows.

Use a fresh `createTempDatabase()` per test for isolation. To test close-and-reopen behavior, capture the first client's `path` and open a second client directly with `{ databasePath: path }`, rather than calling `createTempDatabase()` again. You should now see one test per case above, each of them failing when you break the behavior it covers.

Each `createTempDatabase()` call mints its own temp file, so two clients never share a store, and a second call mints a fresh path every time. The repository ships no process-kill test, so a normal test-runner restart is not proof of crash safety. The alternative is a restart test on the target runtime, which you write yourself.

## 6. Match the test to the claim

| Claim | Current evidence | Additional verification needed |
| --- | --- | --- |
| Engine, outbox, pull/push, and protocol transcripts | Bun unit, integration, and corpus tests | Add an app-specific fake-remote scenario when your rules differ |
| React and Vue hooks ([`useSyncStatus`](../reference/react/use-sync-status.md)) | Package tests in their configured headless runtimes | A real browser test for browser scheduling and storage behavior |
| Web worker and [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) driver ([`createWebWorkerDriver`](../reference/javascript/create-web-worker-driver.md)) | Unit tests cover helpers and declared capabilities; the Bun suite does not run the browser driver | Test in each supported browser and exercise multiple tabs |
| Expo adapters and [OP-SQLite bridge](../reference/expo/open-op-sqlite-driver.md) | Unit tests use fakes; `verifyOpSqliteDriver` is available for a native host | Run on the physical iOS and Android versions you support |
| Supabase [`rpc`](https://supabase.com/docs/reference/javascript/rpc#parameters), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security#write-a-policy-for-each-operation), and Storage | Adapter and SQL tests plus opt-in integration paths | Run against the installed [SQL pack](../reference/sql-pack.md) and your live or local Supabase project |
| Large-file [TUS upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) | Mocked TUS tests; the live suite is skipped unless explicitly enabled | Run the opt-in live Storage test with its documented environment variables |
| Forced process termination and recovery | No shipped process-kill test | Add a platform-level restart test before making durability claims |

The Supabase and TUS rows need a running project. Start the repository stack with `bun run db:start` and read [Local Supabase](../cli/local-supabase.md#1-start-the-stack). You should now be able to name, for every claim your app makes, the row that covers it and the verification it owes.

Supabase documents the CLI itself in [Local development](https://supabase.com/docs/guides/local-development#quickstart), and Kizuna adds one migration and its generated table configuration on top of that stack. [Media and attachments](../attachments/media-and-attachments.md#5-bytes-upload-after-the-outbox-drains) covers the upload path the TUS row exercises.

## Common errors

`Cannot find module 'kizunasync/testing'` means the import path is wrong. The test kit is a separate package subpath, so import it as `kizunasync/testing` and not from `kizunasync`.

`createTempDatabase is not a function` means the same for the testing subpath: import it from `kizunasync/testing`, not the main entry point.

Tests that see each other's rows are sharing one locator. `createTempDatabase()` isolates only when each test calls it for its own instance; a shared `db.driver` reused across tests shares its file too.

A package test that passes from the repository root and fails in isolation is reading different Bun configuration. Some package suites carry package-local settings, such as React's Happy DOM preload. Run those suites through the workspace test task or from that package's directory.

## Next steps

- [Offline writes](../sync/offline-writes.md): test the exact outbox and rejection behavior your UI exposes.
- [Media and attachments](../attachments/media-and-attachments.md): separate queue tests from live Storage and TUS tests.
- [CLI](../cli/cli.md): inspect the implemented validation commands.
- [Protocol overview](../sync/protocol-overview.md): understand what the transcript corpus constrains.
- [Swift and Kotlin](../getting-started/native-clients.md): UniFFI host tests are a different evidence layer.
