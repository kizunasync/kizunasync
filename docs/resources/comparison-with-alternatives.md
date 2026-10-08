---
title: Comparison with alternatives
description: How Kizuna compares with PowerSync, Electric, Zero, Firestore, and other sync libraries, and when to choose each.
status: alpha
docType: concept
audience: app-developer
---

# Comparison with alternatives

This page compares Kizuna with ten other sync products and with a sync layer a team builds itself, from the point of view of a team whose app already runs on Supabase. Each section covers architecture and ownership (where the sync logic runs, where your rows live, and what checks a write), states how Kizuna differs, and names the cases where the other option fits better; prices and benchmarks are out of scope. Facts about the other products come from their official sources as read in October 2026, and if one is wrong or out of date, [open an issue on GitHub](https://github.com/kizunasync/kizunasync/issues) with a link to the page that shows the current behavior.

## Side-by-side matrix

The [capability matrix](https://kizunasync.com/compare) puts Kizuna and these eleven alternatives side by side, one capability per row, with the official source behind each documented cell.

## PowerSync

[PowerSync](https://docs.powersync.com/architecture/architecture-overview) is a sync service with client SDKs. The PowerSync Service replicates a source database and streams the rows each user should have, chosen by SQL queries called Sync Streams, into a SQLite database on the device. Local writes wait in an upload queue that calls an `uploadData` function you write, and that function sends them to your backend. The service runs as PowerSync Cloud or self-hosted, and it connects to Postgres, including [Supabase](https://docs.powersync.com/integrations/supabase), and to MongoDB, with MySQL and SQL Server in Beta.

### How Kizuna differs

- A PowerSync client connects to the PowerSync Service, which runs beside the source database in PowerSync Cloud or on servers you operate. Kizuna devices call the RPCs that the SQL pack installs in your Supabase project, with nothing Kizuna-operated in between ([Architecture](./architecture.md#the-server-data-path)).
- Sync Streams choose the rows a PowerSync device downloads, and Row Level Security applies to the writes that reach Postgres under the user's JWT. In Kizuna, pull and push read and write your rows under the caller's JWT, so your RLS policies decide which rows a device receives as well as whether each queued write applies ([Server-side validation](../sync/server-side-validation.md#security-boundary)).
- When your backend rejects a write, PowerSync's docs tell it to answer HTTP 2xx anyway; once the upload queue empties, local rows are brought back in line with server state and the discarded write disappears without a rollback call. Kizuna's push RPC answers each mutation with a typed verdict, and the engine reverts a rejected write and records it in the rejection journal ([Offline writes](../sync/offline-writes.md#3-handle-a-rejection)).
- PowerSync's upload queue records PUT, PATCH, and DELETE. Kizuna adds `increment`, `arrayUnion`, and `arrayRemove`, which the server applies to the stored value, so two devices that each add one both count ([Collaborative fields](../sync/collaborative-fields.md)).
- Attachments in PowerSync use helpers that its feature-status page lists as Alpha, with an upload and download adapter you write and no documented hash check of downloaded bytes. Kizuna's attachment queue moves files through Supabase Storage, switches to resumable TUS uploads above 6 MiB, and checks each download against its SHA-256 digest ([Media attachments](../attachments/media-and-attachments.md)).

### Choose PowerSync when

- You need a generally available product now. PowerSync lists its Postgres connector, Sync Streams, and main client SDKs as GA, and Kizuna is in Alpha ([Project status](../getting-started/status.md)).
- Your data lives outside Supabase, in another Postgres host, MongoDB, MySQL, or SQL Server, or you want the choice between a managed sync service and a self-hosted one.
- The rows a user receives depend on more than one equality column. Sync Streams select rows with SQL queries, while a Kizuna bucket is one equality column per table ([Sync rules & buckets](../sync/sync-rules-and-buckets.md#1-understand-the-two-layers)).
- You want server changes streamed to connected clients over HTTP or a WebSocket. Kizuna pulls when an optional Realtime wake-up arrives and polls every 15 seconds by default ([How Kizuna works](../getting-started/how-kizuna-works.md#5-wakeups-and-polling)).

## Electric

[Electric](https://electric.ax/docs/sync/guides/shapes) syncs subsets of Postgres data, called shapes, into local apps. A shape is one table with an optional `where` clause and column list. The sync engine is an Elixir service that you run from the official Docker image or use on Electric Cloud. It connects to Postgres 14 or newer through logical replication and serves shapes over an HTTP API, which the TypeScript client and the React hooks consume. Its [writes guide](https://electric.ax/docs/sync/guides/writes) states that Electric does not do write-path sync, so your app sends writes through an API of its own.

### How Kizuna differs

- Electric's sync service runs next to Postgres, on Electric Cloud or on infrastructure you deploy, and caches shape logs on its host disk. Kizuna's protocol runs as SQL inside your project, so nothing runs next to Supabase ([Architecture](./architecture.md#the-server-data-path)).
- Electric covers the read path only. Kizuna carries writes too, through a durable outbox on the device, a push RPC in your project, and a typed verdict for each mutation ([Offline writes](../sync/offline-writes.md)).
- Electric authorizes reads in an HTTP proxy or with a shape-scoped token from a gatekeeper you build. Kizuna forwards the user's Supabase session on every pull and push, and your RLS policies decide what each request may read and write ([Server-side validation](../sync/server-side-validation.md#security-boundary)).
- Electric's usual client holds shape rows in memory, its documented clients are TypeScript and Elixir, and its Postgres Sync docs describe no file sync. Kizuna keeps synced tables in local SQLite, runs the same Rust engine behind its [Swift and Kotlin](../getting-started/native-clients.md) clients, and queues [attachments](../attachments/media-and-attachments.md) through Supabase Storage.

### Choose Electric when

- You want read-path sync of Postgres into web or Expo apps, and you already have a write API or plan to design one.
- Your Postgres runs outside Supabase. Electric works with any standard Postgres 14 or newer that has logical replication enabled.
- You want live updates over Server-Sent Events or long polling from a generally available release. Electric 1.0 shipped in March 2025 with stable APIs, and Kizuna is in Alpha.

## Zero

[Zero](https://zero.rocicorp.dev/docs/when-to-use) is a query-driven sync engine for TypeScript apps, designed in its own words to be as close to a classic web app as a sync engine can be. A server called zero-cache replicates Postgres 15 or newer into a SQLite replica, and each client receives the rows its ZQL queries name over a WebSocket. Writes run as [mutators](https://zero.rocicorp.dev/docs/mutators), functions that apply optimistically on the client and then run in a transaction against your database through a push endpoint you host. You run zero-cache yourself or use Cloud Zero, which the Zero team operates.

### How Kizuna differs

- Zero does not support offline writes, and its fit guide names long periods offline as a reason to pick something else. Kizuna is offline-first: writes wait in a durable outbox and replay after reconnect, and a device whose cursor is older than the tombstone retention window (30 days by default) rebuilds its local copy ([Offline writes](../sync/offline-writes.md), [Conflict resolution](../sync/conflict-resolution.md#deletes)).
- Zero needs zero-cache beside your database, a server that keeps a SQLite replica of the published Postgres data. Kizuna adds no server ([Architecture](./architecture.md#the-server-data-path)).
- Zero authorizes reads and writes in your query and mutator code, and its auth guide says it has no permission system like RLS. Kizuna applies your RLS policies to every pull and push under the user's Supabase JWT ([Server-side validation](../sync/server-side-validation.md#security-boundary)).
- Zero supports TypeScript clients only, and on the web it stores sync state in IndexedDB. Kizuna keeps synced tables as SQLite tables on every platform it runs on ([How Kizuna works](../getting-started/how-kizuna-works.md#1-your-screen-uses-local-sqlite)) and ships Swift and Kotlin clients over the same Rust engine ([Swift and Kotlin](../getting-started/native-clients.md)).

### Choose Zero when

- Your app is mostly online, and you want query-driven partial sync with live updates over a WebSocket.
- You want each write to be a mutator: several changes in one function that commits or rolls back as a unit on the client and the server, with raw SQL available on the server side.
- You need a generally available product. Zero has been GA since March 2026, and Kizuna is in Alpha.
- Your Postgres runs outside Supabase, on RDS, Aurora, Neon, Cloud SQL, or in Docker.

## Legend-State

[Legend-State](https://legendapp.com/open-source/state/v3/intro/introduction) is a JavaScript library built on observables, with a sync engine and plugins for backends and for local persistence. Its [Supabase plugin](https://legendapp.com/open-source/state/v3/sync/supabase/), `syncedSupabase`, reads and writes your tables through the supabase-js client you pass and can subscribe to changes through Supabase Realtime. With the `retrySync` option, pending changes keep retrying after a restart until they sync. Like Kizuna, it needs no server beside Supabase, and its requests carry the user's session, so RLS applies. The linked docs describe version 3, which is in beta.

### How Kizuna differs

- Legend-State persists observables through a key-value plugin (localStorage, IndexedDB, MMKV, AsyncStorage, or the Expo SQLite key-value store), and its `select` and `eq` calls build the remote supabase-js request. Kizuna keeps synced tables in local SQLite and runs `kizunasync.from('todos').select().eq(...)` against that local copy ([Supported query operators](../reference/query-operators.md)).
- The Supabase plugin cannot list rows deleted in Supabase, so Legend-State asks for a soft-delete column, and its docs describe no retention window for deletes. Kizuna records hard deletes as tombstones, keeps them 30 days by default, and rebuilds the local copy of a device whose cursor is older ([Conflict resolution](../sync/conflict-resolution.md#deletes)).
- Legend-State retries an update whose function throws an error, and its docs describe no per-write applied or rejected result. Each Kizuna mutation gets a typed verdict; a rejected write is reverted locally and kept in the rejection journal ([Offline writes](../sync/offline-writes.md#3-handle-a-rejection)).
- `updatePartial` sends only the changed fields, and the docs describe no merge of concurrent edits and no server-side increment. Kizuna keeps concurrent edits to different columns and applies `increment`, `arrayUnion`, and `arrayRemove` on the server ([Collaborative fields](../sync/collaborative-fields.md)).
- Legend-State's sync runs in JavaScript, with first-party React and React Native bindings, and its docs describe no file sync. Kizuna adds Swift and Kotlin clients and an attachment queue on Supabase Storage ([Swift and Kotlin](../getting-started/native-clients.md), [Media attachments](../attachments/media-and-attachments.md)).

### Choose Legend-State when

- You want observables as your app state and a sync plugin that talks to Supabase directly, with your own filters, Realtime subscription, and persistence plugin.
- A local key-value copy with soft deletes fits your data, and you do not need a server verdict for each write.
- You also sync with Keel, Firebase Realtime Database, or a CRUD API, which Legend-State has plugins for.

## RxDB

[RxDB](https://rxdb.info/replication-supabase.html) is a local document database for JavaScript runtimes, including the browser, Node.js, Electron, Capacitor, and React Native, with a replication engine and plugins for HTTP, GraphQL, CouchDB, Firestore, WebRTC, and Supabase. Its Supabase plugin syncs RxDB collections with tables in your project through supabase-js, straight from the device with no sync server in between. Live changes arrive through Supabase Realtime, and RLS policies you write decide what each user reads and writes.

### How Kizuna differs

- RxDB stores JSON documents and queries them with Mango selectors; its SQLite storage keeps those documents as JSON and is a premium plugin for production use. Kizuna keeps your synced tables as SQLite tables and queries them with the supabase-js call shape ([Supported query operators](../reference/query-operators.md)).
- The Supabase plugin needs a soft-delete column, because clients would miss a hard delete, and RxDB's docs describe no retention window. Kizuna records hard deletes as tombstones for 30 days by default and rebuilds the local copy of a device whose cursor is older ([Conflict resolution](../sync/conflict-resolution.md#deletes)).
- When a push conflicts, RxDB returns the current server document and the client's conflict handler decides, and the default handler keeps the server document and drops the local change. Kizuna answers each mutation with a typed verdict and keeps concurrent edits to different columns ([Conflict resolution](../sync/conflict-resolution.md)).
- RxDB applies `$inc` and array operators to the local document and pushes the resulting document. Kizuna sends `increment`, `arrayUnion`, and `arrayRemove` as transforms the server applies, so two devices that each add one both count ([Collaborative fields](../sync/collaborative-fields.md)).

### Choose RxDB when

- You want a document model, a choice of storage engines and plugins, and replication to backends other than Supabase.
- Your app runs in Electron, Capacitor, or Node.js as well as in the browser and React Native.
- You want a library that carries no alpha or beta label and syncs to Supabase with no server in between. RxDB has been developed since 2016 and reports production use, and Kizuna is in Alpha.

## WatermelonDB

[WatermelonDB](https://watermelondb.dev/docs/Sync/Intro) is a local database for React Native and the web, backed by SQLite on iOS, Android, and Node.js and by LokiJS over IndexedDB in the browser, with React bindings through `withObservables`. Its sync client calls `pullChanges` and `pushChanges` functions you write against two endpoints on your backend that implement the Watermelon Sync Protocol. In its own words, Watermelon is only a local database, and you bring your own backend.

### How Kizuna differs

- WatermelonDB leaves the server side to you: the two endpoints, change tracking, and a push that applies all changes in one transaction. Kizuna installs that server side in your Supabase project, with pull and push RPCs, triggers that record changes, and tombstone retention ([What Kizuna installs](../cli/whats-installed.md)).
- Sync covers the whole local database at once, and the pull returns every collection. Kizuna pulls each table by its bucket, so a device copies only the rows its user is meant to have ([Sync rules & buckets](../sync/sync-rules-and-buckets.md)).
- If any record in the push changed on the server since the last pull, WatermelonDB aborts the whole push with one error, and the next sync merges per column with local changes winning. Kizuna returns a typed verdict for each mutation, and competing edits to one column follow server arrival order or a Hybrid Logical Clock ([Conflict resolution](../sync/conflict-resolution.md)).
- WatermelonDB documents no Supabase Auth support and no file sync. Kizuna forwards the user's Supabase session and syncs attachments through Supabase Storage ([Media attachments](../attachments/media-and-attachments.md)).

### Choose WatermelonDB when

You want a local database for React Native with observable queries, and you already own a sync backend or want a documented, backend-neutral protocol to implement on any server. Its maintainers describe it as feature-complete, and it has powered Nozbe Teams since 2017, while Kizuna is in Alpha.

## TinyBase

[TinyBase](https://tinybase.org/guides/synchronization/) is a reactive in-memory data store for local-first JavaScript and TypeScript apps. Persisters save a store to browser storage, SQLite, PostgreSQL, or Supabase, and synchronizers merge stores over WebSocket, BroadcastChannel, or Cloudflare Durable Objects. A MergeableStore stamps each cell update with a hybrid logical clock, so merges keep the latest value of each cell. Its [Supabase persister](https://tinybase.org/api/persister-supabase/functions/creation/createsupabasepersister/) reads and writes one JSON serialization of the whole store as a single row of a table you create.

### How Kizuna differs

- Kizuna syncs the rows of your existing Postgres tables in place. The TinyBase Supabase persister stores the whole store as one JSON row, so your RLS policies see one row rather than each record ([Architecture](./architecture.md#the-server-data-path)).
- A MergeableStore merge is decided on the client by clock order, and the docs describe no per-write result from a server. Kizuna applies each write on the server and returns a typed verdict, with a named reason such as `RLS_DENIED`, `PRECONDITION`, `CONSTRAINT`, or `DELETE_WINS` when it refuses one ([Server-side validation](../sync/server-side-validation.md#typed-rejections)).
- A TinyBase store lives in memory, syncs as a whole, and runs in JavaScript and TypeScript only. Kizuna keeps synced tables in SQLite, pulls each table by its bucket, and has Swift and Kotlin clients ([Sync rules & buckets](../sync/sync-rules-and-buckets.md), [Swift and Kotlin](../getting-started/native-clients.md)).

### Choose TinyBase when

- Your data is a per-user or per-document store that fits in memory, you want a reactive local store with queries, and a merge decided on the client is acceptable.
- You want stores to merge across tabs, devices, or a server you run, over BroadcastChannel, WebSocket, or Cloudflare Durable Objects.
- You want React, Solid, or Svelte bindings, or persistence to SQLite, PostgreSQL, PGlite, or LibSQL as well as Supabase.

## Triplit

[Triplit](https://github.com/aspen-cloud/triplit) is a database designed to run in any JavaScript environment, paired with a sync server. The [Triplit server](https://www.triplit.dev/docs/self-hosting) holds the remote database in SQLite, LMDB, or memory, on Triplit Cloud or on a server you deploy. Clients subscribe to queries over a WebSocket, receive only data they do not have yet, and keep a local copy and an outbox in IndexedDB or memory. Each attribute carries its own timestamp, so concurrent edits to different attributes of one entity both remain, as they do across columns in Kizuna ([Conflict resolution](../sync/conflict-resolution.md#column-masks)).

### How Kizuna differs

- Triplit keeps application rows in the Triplit server's own database, next to Supabase. Its Supabase integration lets that server accept Supabase Auth tokens, while the data stays outside your Postgres. Kizuna syncs your existing tables in place ([Architecture](./architecture.md#the-server-data-path)).
- Permission filters in the Triplit schema, checked against the client's token, authorize reads and writes. Kizuna relies on the Postgres RLS policies you already have, evaluated under the caller's JWT ([Server-side validation](../sync/server-side-validation.md#security-boundary)).
- Triplit rolls back and retries failed updates, and its docs do not show a per-write applied or rejected result with a reason. Kizuna returns a typed verdict for each mutation and records rejections in a journal your app can show ([Offline writes](../sync/offline-writes.md#3-handle-a-rejection)).
- Triplit documents no Swift or Kotlin client and no file sync. Kizuna has both ([Swift and Kotlin](../getting-started/native-clients.md), [Media attachments](../attachments/media-and-attachments.md)).

### Choose Triplit when

- You want one TypeScript database on the client and the server, with query subscriptions over a WebSocket, attribute-level last-writer-wins merge, and sets that accept concurrent additions and removals.
- Your application data can live in a Triplit server you run or in Triplit Cloud, with Supabase Auth signing users in.
- You want React, Solid, Vue, Svelte, or React Native and Expo bindings, and its AGPL-3.0 license fits your project.

## InstantDB

[InstantDB](https://www.instantdb.com/docs) is a backend with client SDKs. Apps read with InstaQL, a declarative query syntax the docs compare to GraphQL, write with `db.transact`, and receive other users' changes live through Instant's sync servers. The web client keeps a local cache in IndexedDB and a persistent outbox for offline writes. Data lives in Instant's own database, on Instant Cloud or on a server you host with Postgres 17 and object storage. [Instant's site](https://www.instantdb.com/) says the service is sunsetting and that Instant Cloud services continue until August 31, 2027; self-hosting remains documented.

### How Kizuna differs

- Instant stores application data in its own database, and its docs do not connect that data to an existing Supabase project. Kizuna syncs the tables you already have, in place ([Architecture](./architecture.md#the-server-data-path)).
- Every read and write in Instant passes its own permission rules, written in CEL, and users sign in through Instant's own auth. Kizuna uses your Supabase session and your RLS policies ([Server-side validation](../sync/server-side-validation.md#security-boundary)).
- Instant handles optimistic updates and rollbacks and documents no applied or rejected reason for each queued write. Kizuna returns a typed verdict for each mutation and keeps rejections in a journal ([Offline writes](../sync/offline-writes.md#3-handle-a-rejection)).
- Instant Storage uploads a file in its own call. The docs do not describe that upload as part of the outbox, and they describe no resume after an interrupted browser upload and no hash check on download. Kizuna queues attachments next to the outbox, resumes TUS uploads above 6 MiB, and verifies each download against SHA-256 ([Media attachments](../attachments/media-and-attachments.md)).

### Choose InstantDB when

You want queries, transactions, permissions, auth, and file storage in one backend, with JavaScript SDKs for React, Vue, React Native, Svelte, and SolidJS. Plan to self-host it, or to move before Instant Cloud services end on August 31, 2027.

## Firestore

[Cloud Firestore](https://firebase.google.com/docs/firestore) is a cloud-hosted NoSQL document database from Google that Apple, Android, and web apps reach directly through native SDKs. The SDKs [cache the documents an app uses](https://firebase.google.com/docs/firestore/manage-data/enable-offline) for offline access, queue writes while offline, and deliver changes to `onSnapshot` listeners. Cloud Firestore Security Rules, which can read Firebase Authentication state, check every client request.

### How Kizuna differs

- Firestore is a separate Google backend, so a Supabase app would move its data there. A login that is not Firebase Auth needs your server to mint Firebase custom tokens. Kizuna runs inside your Supabase project under the user's Supabase session ([Architecture](./architecture.md#the-server-data-path)).
- Firestore resolves several offline changes to the same document by last write wins. Kizuna keeps concurrent edits to different columns of a row, and competing edits to one column follow server arrival order or a Hybrid Logical Clock ([Conflict resolution](../sync/conflict-resolution.md)).
- Firestore documents no tombstone retention window for a client that stays offline a long time. Kizuna keeps tombstones for 30 days by default and rebuilds the local copy of a device whose cursor is older ([Conflict resolution](../sync/conflict-resolution.md#deletes)).
- Files go through Cloud Storage for Firebase, a separate product with its own upload API. Kizuna queues attachments next to the outbox and checks each download against SHA-256 ([Media attachments](../attachments/media-and-attachments.md)).

### Choose Firestore when

- Your app is not on Supabase, or you are ready to move to Firebase, and you want a generally available, Google-hosted document database with first-party Apple, Android, and web SDKs.
- You want live listeners, offline persistence that is on by default on Apple and Android, atomic batches of up to 500 writes, and server-side `increment`, `arrayUnion`, and `arrayRemove`, the transforms Kizuna models its own on ([Introduction](../getting-started/introduction.md#features)).
- Your documents stay under the 1 MiB limit, and last write wins per document is acceptable.

## A typical custom implementation

A typical custom implementation is the sync layer a team writes on top of supabase-js: a local store on the device, a queue of pending writes, pull queries with a checkpoint per user, and a Realtime subscription that triggers a refresh. The app talks to Supabase directly with the user's session, so RLS applies and no third-party server sits in the data path. Its guarantees are whatever its code and tests establish, and [Consistency model](../sync/consistency-model.md) lists the guarantees and limits Kizuna commits to, and a custom design has to answer the same questions.

### How Kizuna differs

- A custom build designs its own outbox, ordering, and retries. Kizuna ships a durable outbox, a typed verdict for each mutation, a local revert of rejected writes, and a rejection journal ([Offline writes](../sync/offline-writes.md)).
- A plain upsert overwrites the whole row. Kizuna merges per column and applies `increment`, `arrayUnion`, and `arrayRemove` in the database ([Conflict resolution](../sync/conflict-resolution.md), [Collaborative fields](../sync/collaborative-fields.md)).
- A custom build has to track deletes, choose a retention window, and rebuild clients that were away too long. Kizuna numbers changes at commit so a pull never skips a late transaction, keeps tombstones, and rebuilds a device whose cursor has expired ([Fencing and horizons](../sync/fencing-and-horizons.md)).
- Files need their own queue, TUS client, and integrity check. Kizuna's attachment queue resumes uploads above 6 MiB and verifies downloads against SHA-256 ([Media attachments](../attachments/media-and-attachments.md)).
- Each platform needs its own client, and the protocol stays private to the app. Kizuna runs one Rust engine behind its JavaScript, Swift, and Kotlin clients and publishes its protocol with a conformance corpus ([Protocol overview](../sync/protocol-overview.md)).

### Choose a custom implementation when

- Your requirements are narrow enough that a design for one application fits better than Kizuna's Supabase-specific protocol.
- Your team has the protocol expertise and will build the failure, migration, and long-offline tests the design needs.
- You want to control every dependency, release, query shape, and operational trade-off yourself, or your backend is not Supabase.

## Related pages

- [Architecture](./architecture.md)
- [Consistency model](../sync/consistency-model.md)
- [Design trade-offs](./design-tradeoffs.md)
- [Introduction](../getting-started/introduction.md)
- [Project status](../getting-started/status.md)
