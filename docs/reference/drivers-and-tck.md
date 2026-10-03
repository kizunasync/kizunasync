---
title: Drivers and the TCK
description: The platform-port boundary a driver implements, the evidence the protocol corpus supplies, and the evidence it does not.
status: alpha
docType: concept
audience: driver-author
---

# Drivers and the TCK

A driver is the piece that connects the engine to one platform: its [SQLite](https://grokipedia.com/page/SQLite) build, its network, its files, its notification channel. The engine holds every sync decision behind interfaces, so a driver supplies an implementation and never redefines what a pull or a push means.

That split decides what any test can prove about a driver. The shared protocol corpus is the wire oracle, and it says whether an implementation reproduces the recorded conversation. Whether a concrete SQLite build, filesystem, network stack, or app lifecycle keeps its side of the bargain is a separate question with separate tests, and this page is about which is which.

## Port model

Eight interfaces sit on the boundary. Five move data or bytes or open the engine, and three deliver signals that change when the engine works rather than what it decides.

| Port | Contract | Kind |
|---|---|---|
| `IStoreLocator` | `databasePath` (a file path, or `null` for a private in-memory store), an optional `engineTransport`, an optional `loadNativeEngine` that answers `{ ok: true, handle }` or `{ ok: false, message }`, and optional `platformPorts`, `{ connectivity?, foreground? }`, which carry the platform's own signals | Work |
| `IEngineTransport` | `call(method, paramsJson)` and `close()`, an engine a locator's `engineTransport` factory already opened, plus an optional `leadership` on a transport shared with other hosts | Work |
| `IProtocolRemote` | `pull(request)` and `push(request)` | Work |
| `IFileStore` | `writeAtomic`, `read`, `readRange`, `exists`, `stat`, `delete`, `list`, `sha256`, `importFromUri`, `toUri`, and a required capability descriptor | Work |
| `ITransfer` | `createUpload`, `download`, `confirm`, `metadata`, and `remove` | Work |
| `IWakeup` | `subscribe(onSignal)`, returning an unsubscribe function | Hint |
| `IConnectivity` | `isOnline()` and `subscribe(onChange)` | Hint |
| `IForeground` | `subscribe(onForeground)`, returning an unsubscribe function | Hint |

`IProtocolRemote` is the thinnest of the five. The first-party adapter is one call to [`rpc`](https://supabase.com/docs/reference/javascript/rpc#parameters) per direction, because Kizuna adds no envelope of its own over the [Postgres](https://grokipedia.com/page/PostgreSQL) function call; a driver for another backend has to produce the same request and response bytes some other way.

The three signal ports are separate on purpose, because they answer different questions. Connectivity is the device's network state. The engine uses it to keep mutations queued while offline, and to flush the outbox on the transition back. Wake-up is the server saying something changed, delivered on this stack as a private [broadcast from the database](https://supabase.com/docs/guides/realtime/broadcast#broadcast-from-the-database). Kizuna discards the message and pulls, so a wake-up adapter owes correctness nothing. Foreground is the app becoming visible again. It matters because a backgrounded timer may not run while an access token expires anyway, and the adapter that owns the session refreshes it before forwarding that signal.

A driver that knows its platform hands the app client that platform's connectivity and foreground ports on the locator's `platformPorts`, so the app does not pass them by hand; wake-up stays with the adapter that owns the Realtime connection. The browser worker driver carries the browser's `online` and `offline` events as its connectivity port. The [Expo](https://expo.dev) driver carries NetInfo connectivity and `AppState` foreground on iOS and Android. An explicit `connectivity` or `foreground` option on the app client wins over the driver's port. Without either, connectivity reports online at all times and `createKizunaSync` wires no foreground signal, while [`createSupabaseKizunaSync`](./javascript/initializing.md#parameters) falls back to the document's visibility on the web. The app client reads each port once, when it is created, and subscribes to it only when the engine opens.

A locator names the database the kernel opens and never runs SQL against it: the Rust engine owns the only connection to that store and issues its own transactions internally. A locator that carries an `engineTransport` instead hands the core an engine it already runs, which is the browser worker's path; the app client calls the factory on its first engine call and drives the `IEngineTransport` it returns. A locator that carries `loadNativeEngine` names the file and loads the UniFFI engine that opens it, which is the React Native path; the app client calls it on its first engine call unless the host injected a `uniffiHandle`.

## Capability descriptors

One port carries a capability descriptor, `IFileStore`. The engine and the app read what it declares rather than the driver's identity, so a new adapter needs no engine change.

| Capability | Port | Meaning |
|---|---|---|
| `atomicRename` | `IFileStore` | The adapter writes through a temp file and a rename, so a partial write is never observable. |
| `streams` | `IFileStore` | `readRange` is valid on this adapter. Callers without it fall back to a full read and a slice. |
| `quota` | `IFileStore` | The platform imposes a storage quota. The OPFS web store declares it true and the Expo file store declares it false. |
| `contentUris` | `IFileStore` | `toUri` returns a URI the host can render. |

A capability is the adapter's promise about its platform. It is not evidence that the platform keeps the promise, and no capability claims durability across an abrupt process kill.

`streams` decides whether a caller may use `readRange`; `atomicRename`, `quota`, and `contentUris` are declared by the first-party adapters and read by no engine code in the current tree. Declare each one for what the platform does rather than for what would look best. The browser file store is the instructive set to read against: [Returns](./javascript/create-web-file-store.md#returns) lists the value it gives each capability.

## Engine selection

`createKizunaSync` runs the Rust engine behind the app client, and what it decides is which artifact reaches that engine on this runtime. It decides once, on the app client's first engine call, so creating the client loads no artifact and cannot fail for a missing one.

A driver that carries its own engine transport wins first, which is the browser path. A [UniFFI](https://mozilla.github.io/uniffi-rs/) handle wins next, which is the [React Native](https://reactnative.dev) path: the host's `uniffiHandle` when it passed one, or else the handle the driver's `loadNativeEngine` loads. A loader that answers a failure ends the selection with its message, and the addon is not tried. [Selection](./expo/rust-engine.md#selection) states the two conditions an [Expo](https://expo.dev) app has to meet. The [N-API](https://nodejs.org/api/n-api.html) addon is tried last, which is the Node and [Bun](https://bun.sh) path. Every one of them needs the driver to report a `databasePath`. A file-backed Rust engine opens its own SQLite connection, so a driver that stays anonymous would leave the engine and the app writing to two different stores. The `kizunasync.engine` field on the returned client is diagnostic rather than a switch. It carries the one value `'rust'`, because the app client either runs the Rust engine or fails, and reading the field opens the engine like any other engine call.

| Candidate | Outcome |
|---|---|
| A driver-carried engine transport | Rust over that transport |
| A UniFFI handle the host injected or the driver loaded | Rust through the [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction) |
| A driver loader that answers a failure | A `TEngineError` with code `ENGINE_UNAVAILABLE` on the first engine call, carrying the loader's message |
| A loadable N-API addon | Rust through the addon |
| None of the three, or a driver with no `databasePath` | A `TEngineError` with code `ENGINE_UNAVAILABLE` on the first engine call, naming what to install and every path that was tried; the client keeps it, and [sync health](./javascript/sync-health.md) reports it |

No environment variable changes that order or its outcome, and there is no second implementation to fall back to.

`:memory:` is the deliberate exception. The native core opens its own private in-memory store, so reads issued through the locator passed in do not observe it. That matters only to code that queries the locator behind the app client's back, and tests that do exactly that hit this. If a web driver refuses to open at all, [Local web database will not open](../operations/troubleshooting.md#local-web-database-will-not-open) covers the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) lock that usually causes it.

There is one engine, and shared conflict vectors and corpus cases pin its semantics on every runtime that runs it. A passing vector still says nothing about storage durability on those runtimes. It says nothing about their lifecycle behavior either.

## What the corpus proves

`packages/protocol` holds the JSON Schemas, the canonical transcripts, the case manifest, the structural invariants, and a TypeScript reference server. The Rust conformance replay lives in `crates/kizunasync-conformance`, and it reads that same manifest. The manifest registers 50 entries, and 49 of them execute. The one blocked case has no bytes while its wake-up payload decision stays open. Inside those 49, the Rust replay passes over one pull step whose recorded request is not this client's identity pull. It reports that total as `skipped_steps`. [Conformance inventory](./protocol.md#conformance-inventory) lists them by group.

Those 47 executable cases cover pagination, [fencing](../resources/glossary.md#fencing), outbox rebase, lifecycle signals, conflict ordering, transforms, atomic batches, rejection handling, [tombstones](../resources/glossary.md#tombstone), and replay. Each case compares canonical request and response bytes, then asserts the local obligations the transcript carries. A case fails when the bytes differ, and it fails when the resulting local state differs. No case in the corpus induces a user `CHECK`, a foreign key, a not-null, or a validation-trigger failure. The corpus therefore exercises the SQL pack's `CONSTRAINT` translation only through the pack's own raise on a transform against a column of the wrong type.

Run the client half against an engine under test with the harness in the `conformance` subpath of the `core` workspace, which reads the corpus in place rather than copying bytes. [Replay the protocol corpus](../operations/test-offline-behavior.md#4-replay-the-protocol-corpus) walks through a run.

The corpus proves what its cases and schemas express, and nothing beyond that:

- A blocked case is not a passing behavior.
- The reference server is not a live Postgres deployment.
- A transcript fault is not a process-kill test.
- A run against an in-memory or fake driver is not browser, device, or filesystem evidence.
- The [TLA+](https://grokipedia.com/page/TLA%2B) models check protocol invariants over finite models, not a concrete implementation.

## What a driver needs beyond the corpus

Each port owes evidence the wire corpus cannot supply, because the corpus never touches the platform underneath.

An SQL adapter needs evidence for transaction and savepoint behavior, concurrency between connections, the journal mode it declares, file identity across reopen, and the platform's shutdown and recovery paths. A file adapter needs evidence for partial writes, rename semantics, hashing, range reads, quota exhaustion, and URI lifetime. A transfer adapter needs live-service evidence for authentication, resume, session expiry, and integrity checks. Those failure modes appear only against a real [Storage](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading) endpoint, never against a fake one. Wake-up, connectivity, and foreground adapters need subscription and lifecycle evidence, and correctness keeps resting on pull.

This repository contains port tests, engine-level corpus executors, the `createTempDatabase` locator under `kizunasync/testing`, and several platform tests. One first-party driver ships its own gate: the [op-sqlite driver](./expo/open-op-sqlite-driver.md) exports `verifyOpSqliteDriver`, which opens a database and runs a create, an insert, a select, and a delete against a real handle. A passing run is evidence for those five operations on that device and for nothing else, and that narrowness is the shape a driver's own evidence should take.

The repository does not expose one packaged command a third-party driver author can run as a complete standalone TCK, and it has no complete browser, device, multi-process, or kill matrix. "Conforms to the wire corpus" and "production-qualified on this platform" are therefore two claims, and [Status taxonomy](./status-taxonomy.md#what-a-maturity-claim-must-name) lists the lanes a driver claim has to name. [Match the test to the claim](../operations/test-offline-behavior.md#6-match-the-test-to-the-claim) maps the suites in this repository to the claims they support.

## Cursor obligation

Store the [cursor](../resources/glossary.md#cursor) as opaque text and return it verbatim. Sequence values are decimal strings, a flat cursor is a decimal string, a composite cursor can carry `~` and `.` to encode holes, and a continuation cursor prefixes `<start>:`, the checkpoint its transfer started from. No driver may parse, compare, increment, or coerce either representation through a JSON number. That is the failure this rule prevents: a sequence past 2^53 loses precision the moment it becomes a JavaScript number.

The SQL pack emits no holes, because it numbers changes at commit and advances to the largest sequence number its snapshot sees: the page that closes the checkpoint returns a flat cursor, and a page cut by the limit returns its start and position. It still honors a composite cursor. The reference oracle emits the composite form for refined fencing. Expiry is the server's decision, made on the transfer's start, so a driver replays whatever token it holds. An opaque client representation is what lets both forms share the same storage and remote interfaces. [Fencing and horizons](../sync/fencing-and-horizons.md) explains why the two differ, and [Cursor grammar](./protocol.md#cursor-grammar) fixes the token shapes.

## Attachment obligation

Attachment bytes never cross `IProtocolRemote`. `IFileStore` owns local bytes and `ITransfer` owns the Storage transport, and [Attachment boundary](./protocol.md#attachment-boundary) states where the protocol stops.

The Supabase adapter uses a [standard upload](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading) through 6 MiB and a [resumable upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) above it. Kizuna adds only the queue that decides when either runs. A resumable adapter announces its session token through `onSessionCreated` before the first byte moves, and the queue persists that token in the attachment row immediately. A later queue instance can therefore resume when both the local database and the remote session survived. That contract is not a physical process-loss or device-loss guarantee, and this repository has not measured one.

## Current maturity boundary

The public ports and the first-party adapters exist here, and the protocol corpus and cross-engine runners are executable. The standalone third-party TCK, a frozen transport error taxonomy, and a full physical qualification matrix do not exist; the [Packaged driver TCK](../resources/roadmap.md#packaged-driver-tck) entry tracks the first of those. Every driver claim belongs to one evidence lane, and "TCK", "corpus", and "device tested" are not three names for the same thing.

## Related reference

- [Protocol reference](./protocol.md): the wire surface a driver has to reproduce.
- [Protocol overview](../sync/protocol-overview.md): how the two calls fit together.
- [Status taxonomy](./status-taxonomy.md): the evidence lanes a maturity claim must name.
- [Architecture](../resources/architecture.md): where the ports sit in the whole system.
- [Test offline behavior](../operations/test-offline-behavior.md): running the corpus and the offline suites.
