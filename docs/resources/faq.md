---
title: FAQ
description: Answers about offline periods, supabase-js, files, conflicts, security, platforms, and cost.
status: alpha
docType: reference
audience: app-developer
---

# FAQ

This page answers common questions about Kizuna by theme, and each answer ends with a link to the page that covers its subject in full.

## Setup and architecture

### Does Kizuna work with the supabase-js client, or instead of it?

It works with it. [`createSupabaseKizunaSync`](../reference/javascript/initializing.md) takes your app's supabase-js client and uses its session for every pull and push, its Realtime connection for the wake-up hint, and its Storage for attachments. Your screens read and write synced tables through `kizunasync.from(...)`, which answers from the local database, while your app keeps supabase-js for sign-in, Edge Functions, server RPCs, and the tables it does not sync (`rpc` and `schema` on the app client throw `LOCAL_UNSUPPORTED` rather than reach the network). Swift and Kotlin apps keep supabase-swift and supabase-kt for sign-in and hand the session token to the app client.

A write that goes to a synced table through supabase-js or SQL still reaches the devices that pull that row, because the triggers Kizuna installs record it. In the default arrival mode, though, a device that still has a queued write to the same column replaces that value when it pushes. A table you write only through supabase-js can sync `pull-only` instead, which makes its local copy read-only and leaves every write on your supabase-js path. [How Kizuna works](../getting-started/how-kizuna-works.md) shows where each piece sits.

### Do I need to run a sync server?

No. The server half of Kizuna is a SQL pack that `kizunasync init` installs into your own Supabase project: the `kizunasync` schema, five public RPCs (`pull`, `push`, and three attachment calls), two triggers on each synced table, and maintenance jobs that `pg_cron` runs inside the same database. Devices call those RPCs through your project's API with the signed-in user's session, so no service that Kizuna operates sits in the data path. [What Kizuna installs](../cli/whats-installed.md) lists every object the pack creates.

### Is sync real-time, or does it poll?

It polls, and a Realtime broadcast can wake it early. The sync loop runs after every local write, when the network returns, and when the app comes back to the foreground. Between those it polls every 15 seconds by default, at a random point so that many clients do not arrive at once, and it stretches the gap to at most 30 seconds after consecutive failures. When a synced table changes, the pack's triggers send a [wake-up](./glossary.md#wake-up) broadcast through Supabase Realtime that names only the table, and the client answers it with an ordinary pull. A missed broadcast costs latency and nothing else, because the next poll finds the change. [Create the Realtime wakeup](../reference/javascript/create-realtime-wakeup.md) explains the channel and how it recovers.

### Does Kizuna work outside Supabase?

No. The adapters and the SQL pack are written for Supabase and depend on Postgres Row Level Security, PostgREST RPCs, Supabase Auth JWT claims, Storage, Realtime, and `pg_cron`. Kizuna ships no generic Postgres adapter and no backend for another database. [Comparison with alternatives](./comparison-with-alternatives.md) describes sync products that work with other backends and when to choose each.

### Can I use my own SQLite library?

Only to locate the database file, because the Rust engine opens its own SQLite connection and runs every statement itself. A driver implements the exported `IStoreLocator` interface, which names the database the engine opens or, in the browser, hands over an engine the driver already runs in a worker. Kizuna ships the browser worker driver, an `expo-sqlite` driver, and an opt-in op-sqlite driver. It has no Capacitor driver and no standalone test kit for third-party drivers, and `IStoreLocator` can still change during the Alpha. On Node, Bun, and React Native the compiled engine has to load, or the app client's first use fails with `ENGINE_UNAVAILABLE` and names the missing artifact, while the browser driver always carries its engine. [Drivers and the TCK](../reference/drivers-and-tck.md) describes the boundary a driver implements.

## Offline and reconciliation

### What happens when a device stays offline for a very long time?

Its queued writes wait for as long as it takes, and the device catches up when it reconnects, rebuilding its local copy if it fell behind the server's retention. When the network returns, the app client pushes the [outbox](./glossary.md#outbox) first, in the order you made the writes, then pulls from its saved [cursor](./glossary.md#cursor). A device whose cursor predates the delete history the server still keeps (`tombstone_ttl_days`, 30 days by default) receives `CHECKPOINT_EXPIRED`, pulls its data again from the start, replaces its local copy, and replays the writes still pending on top. A queued update to a row someone deleted meanwhile is rejected instead of bringing the row back. The rejection reads `DELETE_WINS` while the delete history is kept and the user had already pulled a live row from that row's bucket, and `RLS_DENIED` otherwise.

On tables with client registration turned on, a registration silent for `client_ttl_days`, 90 by default, is pruned, and the device registers again on its next pull or push. An app build below a table's `min_schema_version` receives `RESET_REQUIRED` and stops syncing until an update ships and the app calls `reset()`, which discards the writes still queued. [Offline writes](../sync/offline-writes.md) explains the queue, and [Fencing and horizons](../sync/fencing-and-horizons.md) explains the cursor.

### What if the server rejects a write made offline?

The server answers that write with a typed [verdict](./glossary.md#verdict), and the engine undoes it on the device. The push RPC decides each queued write under your Row Level Security, constraints, preconditions, and delete history, and a rejection carries one of six reasons: `RLS_DENIED`, `COLUMN_DENIED`, `PRECONDITION`, `CONSTRAINT`, `DELETE_WINS`, or `SUPERSEDED`. The engine then replaces the local row with the server row your policies let you read, or deletes it when you may read none, records the outcome in the rejection journal, and emits `MUTATION_REJECTED`. Each queued write is judged on its own, because no app client exposes an all-or-nothing batch. A rule that must hold for several writes together belongs in one server-side operation, such as a Postgres function your app calls. Nothing throws at the call that made the write, which resolved long ago, so a screen that reads neither the event nor the journal shows the row reverting with no explanation. Network loss, a 5xx response, or an expired session is a transport failure rather than a rejection, so the write stays queued and the loop retries it. [Offline writes](../sync/offline-writes.md#3-handle-a-rejection) shows how to surface each reason.

### How do I show writes the server has not accepted yet?

Read the outbox depth, the number of writes still waiting to be pushed. In React, Vue, and Expo, `useSyncStatus()` returns `outboxDepth` together with `isOnline`, `isSyncing`, `isStalled`, `lastError`, and a `syncNow` action. Without a binding, `kizunasync.getOutboxDepth()` returns the count and `onSyncHealth` reports the sync loop's state, and Swift and Kotlin read `outboxDepth()` on the app client and the loop's state from the scheduler's `health()` and `onHealth`. A write leaves the count once its verdict comes back, and a rejected or dead-lettered write moves to the rejection journal. [Offline writes](../sync/offline-writes.md#2-show-sync-state-in-your-ui) has a sync indicator for each platform.

## Conflicts

### How are conflicts handled?

Per column, in your Postgres database. In the default `arrival` mode, two writes that name different columns of a row both keep their values. When two accepted writes touch the same column, the one the server receives later holds it, and device clocks play no part. A table set to `hlc` mode compares each column's origin Hybrid Logical Clock instead, after the server clamps a device clock running ahead by more than `hlc_max_skew_ms`, five seconds by default. Row Level Security, constraints, preconditions, and delete history can still reject a single write, which comes back as a typed verdict, while the push policy (a maximum batch size or required atomic batches) refuses the whole request with an error. Kizuna's guarantees (causal+ consistency to checkpoints and the four session guarantees) hold for successful checkpoints, the buckets a device pulls, and devices that sync within retention. [Conflict resolution](../sync/conflict-resolution.md) walks through both modes.

### Is last-writer-wins enough, or do I need a CRDT?

Text that several people type into at once needs a CRDT library on the device, while independent columns, counters, and sets work with Kizuna's [column-level last-writer-wins](./glossary.md#column-last-writer-wins-column-lww) and its transforms. Each write names only the columns it changes, so edits to different columns of one row never overwrite each other, and splitting contested state across columns keeps both edits. The `increment`, `arrayUnion`, and `arrayRemove` transforms send a delta that the database applies to the stored value, so two devices that each add one both count. Two people typing in one `text` column still end with one value, because Kizuna merges no text. Store such a document as an insert-only child table and merge its rows on the device with a library such as Yjs or Loro. [Collaborative fields](../sync/collaborative-fields.md) shows each pattern.

## Data and partial sync

### Do I have to sync the whole database to every device?

No. You declare which tables sync, and a [bucket](./glossary.md#bucket) on each table chooses which of its rows reach a device. A bucket is one equality column, such as `byOwner('user_id')` for the signed-in user's rows or `byColumn('workspace_id')` for a workspace your app picks with `setBucket`, and a pull fetches only the rows whose bucket column matches. Row Level Security still decides what each user may read, and a bucket narrows that set without ever widening it. Because a bucket is a declared column, a rule such as "rows of projects my team belongs to" needs a denormalized owner or tenant column. Changing a `byColumn` value replaces the local scope, so after the next pull the device holds only the new value's rows. [Sync rules & buckets](../sync/sync-rules-and-buckets.md) explains each helper.

### Should devices generate row IDs?

Yes: give a uuid key to every table devices create rows in while offline. An insert into a table keyed by `id` alone can leave `id` out, and the app client mints a uuid for it, so a device creates rows with no round trip. A key the database generates, such as an identity or `serial` column, has no value a device can produce on its own, so every offline insert into such a read-write table has to carry the value. `kizunasync` refuses a read-write table whose key is `generated always as identity`, because the database rejects any value a device sends for it. Composite keys work too, with columns of type `uuid`, `text`, `character varying`, `smallint`, `integer`, or `bigint`, and key columns never change once a row exists. [Row keys](../sync/sync-rules-and-buckets.md#row-keys) sets out the key rules.

### When can a deleted row come back?

A hard-deleted row stays deleted on every device that syncs within its tombstone retention, though an insert with the same key creates it again once the tombstone is reaped. A soft-deleted row comes back with any accepted update that clears its marker. A hard delete leaves a [tombstone](./glossary.md#tombstone), and while the table keeps it (`tombstone_ttl_days`, 30 days by default) any later queued write to that row is rejected, so an offline edit on another device cannot restore the row. The rejection reads `DELETE_WINS` when your account had already pulled a live row from that row's bucket, and `RLS_DENIED` otherwise. Devices that held the row drop their copy when the tombstone reaches them, and a device whose cursor falls behind the reaped history receives `CHECKPOINT_EXPIRED` and rebuilds its local copy without the row. With a `softDelete` column on the table, `delete()` instead stamps that column as an ordinary update and writes no tombstone. The row keeps its data, drops out of default reads, returns with `.includeDeleted()`, and follows the table's conflict rule like any other column. [Conflict resolution](../sync/conflict-resolution.md#deletes) describes both kinds of delete.

## Auth and security

### Is my data safe, and what credentials does Kizuna hold?

Your rows travel only between your users' devices and your Supabase project, under each user's own session, and no service that Kizuna operates receives sync traffic. The public RPCs run as `SECURITY DEFINER` only to reach Kizuna's private bookkeeping: every read and write of your rows goes through helpers owned by a `NOBYPASSRLS` role under the caller's JWT, so your policies decide. The attachment RPCs check that the owner segment of the Storage path matches the caller before they confirm or remove anything. Two signals sit outside that boundary by design: the Realtime doorbell shows any signed-in user that a synced table received a write and roughly when, and the pull cursor advances past commits that user's policies hide, which reveals that some write happened in the project but not its table, row, or content. Provisioning uses a direct database connection or a Supabase Personal Access Token for the Management API, never a service-role key, and the CLI reads a token you already have rather than minting one. The local sync inspector uses only the project URL and keys you supply to it, and its service-role key stays in server-only code. [Server-side validation](../sync/server-side-validation.md#security-boundary) walks through the security boundary.

### What happens when another user signs in on the same device?

Sync stops until your app calls `reset()`, so one user's queued writes never go out under another user's session. The engine reads the `sub` claim of each access token and remembers which user the local database belongs to. A token naming a different user latches a soft block with reason `identity_changed`, emits `RESET_REQUIRED`, and reports the block as `softBlockReason`. `reset()` wipes the local rows, the outbox, and the journals, mints a new client id, and lets the next sync pull the new user's data. It discards the previous user's queued writes, so let a sync drain them before sign-out when they matter. Signing out alone changes no identity: sync pauses with `AUTH_SESSION_MISSING` until a session returns, and the same user signing back in resumes without a reset. [Sync soft-blocks after switching accounts](../operations/troubleshooting.md#sync-soft-blocks-after-switching-accounts) walks through the switch.

### Is the local database encrypted?

No, Kizuna adds no encryption at rest. The engine links a plain SQLite build through rusqlite, not an encrypting build such as SQLCipher. The local database is therefore an ordinary SQLite store in OPFS or IndexedDB in the browser and an ordinary SQLite file on the device for Expo, Swift, and Kotlin. Its protection at rest is the protection your platform gives the app's storage. [How Kizuna works](../getting-started/how-kizuna-works.md#1-your-screen-uses-local-sqlite) shows where each driver keeps the database.

## Files and media

### How does Kizuna sync large files?

Through an attachment queue that uploads each file after its row reaches the server, resumably and in 6 MiB chunks once the file is larger than 6 MiB. The row holds a short reference string, and `fromFile` copies the file into a local sandbox, computes its SHA-256 digest, and queues the upload, which runs only once the outbox has pushed the row. A file of at most 6 MiB takes one standard Storage upload, and a larger one takes a resumable TUS upload whose session URL is saved before the first chunk, so a later attempt continues from the offset the server reports. Another device downloads the file when a view first asks for it and checks the bytes against the SHA-256 digest, and a transfer that keeps failing stops after five attempts by default until your app calls `retry`. Kizuna caps neither the size nor the type of a file, so set the Storage bucket's `file_size_limit`. The adapter also reads the whole file into memory to move it in either direction, which means resumable uploads do not make a very large file cheap in memory. [Media attachments](../attachments/media-and-attachments.md) wires the queue end to end.

## Scale and platforms

### What about apps with a lot of data?

Kizuna limits what each device stores and fetches, but it publishes no device benchmark or latency target, so measure what stays responsive with your own schema, policies, driver, hardware, and network. A bucket limits a device to an equality-scoped subset of each table, and the server reads only the change history labeled with the bucket values a pull requests. Pulls arrive in keyset pages of up to `pullLimit` entries, 500 by default. Attachments download only when a view first asks for them. A device whose cursor falls behind retention receives `CHECKPOINT_EXPIRED` and rebuilds from a fresh snapshot instead of continuing an expired history. [Sync rules & buckets](../sync/sync-rules-and-buckets.md) explains how a bucket narrows each pull.

### Which platforms are supported?

React, Vue, Expo and React Native, vanilla JavaScript, Swift, and Kotlin, all on one Rust engine. In the browser the engine runs as WebAssembly in a worker, and React Native, Swift, and Kotlin reach it through UniFFI. On iOS and Android an Expo app needs a development build, because Expo Go cannot load the native engine and reports `ENGINE_UNAVAILABLE`, while Expo web runs the browser driver and needs no native build. [Introduction](../getting-started/introduction.md) describes each client, [Expo / React Native](../getting-started/expo.md) explains the development build, and [Client library comparison](../reference/client-libraries.md) shows which capabilities each library exposes.

### Do two devices of the same user stay in sync?

Yes. Each device syncs as its own client, with its own local database, outbox, cursor, client id, and session for the same user. Each write names only the columns it changes, so edits to different columns of a row both survive. Postgres arbitrates two edits to the same column: the one the server accepted later holds it, or, on an `hlc` table, the one with the later origin clock. Each device sees the other's writes on its next pull, and the two agree once both have resumed successful pulls, after a rebuild for a device that fell behind retention. [Consistency model](../sync/consistency-model.md) states the guarantees and their limits.

## Operations, cost, and lock-in

### How do schema changes reach a device that has been offline?

Through a version gate: you raise the table's `min_schema_version` on the server together with the `schemaVersion` your app build declares, and an older build stops syncing until it updates. Every pull and push carries the build's `schemaVersion` from `defineConfig`, 1 by default, and the server compares it with the highest `min_schema_version` among the tables involved. A build below that minimum receives `RESET_REQUIRED` before any of its writes run, and the client stays blocked, with `needsReset` true, until the user installs an update and the app calls `reset()`. The reset pulls the data again from the start and discards the writes still queued on that device. [Configuration](../cli/configuration.md#kizunasync_config) documents `min_schema_version`, and [Reset](../reference/javascript/reset.md) lists what the reset clears.

### What does Kizuna cost to run?

Kizuna adds no bill of its own, because no service that Kizuna operates or charges for sits between your devices and your Supabase project. The engine, drivers, bindings, CLI, inspector, and protocol sources are Apache-2.0, and the server SQL pack is PolyForm Shield 1.0.0. You still pay for and operate the Supabase, hosting, storage, egress, build, and support resources your application uses, and pulls, pushes, and attachment transfers are requests to your own project. [Governance](../../GOVERNANCE.md#1-licensing) records the licensing commitments.

### How locked in am I?

Your data stays in your own Postgres tables, and removing Kizuna never drops those tables or their data. Kizuna adds no columns to your rows; it adds its own schema, RPCs, and two triggers on each synced table. The app clients, drivers, CLI, and wire protocol are Apache-2.0, and the server SQL pack is readable SQL under PolyForm Shield 1.0.0, a source-available license that excludes using it to offer a competing product. `kizunasync deprovision` drops the objects its provision ledger records, the triggers on your tables among them, and `--purge` also drops the `kizunasync` schema. [Remove](../cli/removing.md) walks through the teardown.

## Comparison

### How is Kizuna different from PowerSync, Electric, Firestore, and the others?

Kizuna runs its sync logic inside your own Supabase project, while PowerSync, Electric, and Zero run a sync service beside your database and Firestore keeps your data in its own backend. Kizuna's SQL functions apply your Row Level Security to every pull and push and answer each write with a typed verdict, files sync with their rows through Supabase Storage, and the JavaScript, Swift, and Kotlin clients all run the same Rust engine. [Comparison with alternatives](./comparison-with-alternatives.md) covers each product and when to choose it, and the [capability matrix](https://kizunasync.com/compare) puts them side by side.

## Related pages

- [Introduction](../getting-started/introduction.md)
- [How Kizuna works](../getting-started/how-kizuna-works.md)
- [Offline writes](../sync/offline-writes.md)
- [Consistency model](../sync/consistency-model.md)
- [Comparison with alternatives](./comparison-with-alternatives.md)
- [Glossary](./glossary.md)
