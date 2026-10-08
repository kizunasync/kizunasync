---
title: Introduction
description: What Kizuna is, how it fits a Supabase app, and when to use something else.
status: alpha
docType: concept
audience: app-developer
---

# Introduction

Kizuna is offline-first sync for the Supabase project you already own. Your application keeps reading and writing a local [SQLite](https://grokipedia.com/page/SQLite) cache while you are away from the network. When the connection returns, it pushes the queued mutations and pulls the rows [Postgres](https://grokipedia.com/page/PostgreSQL) has committed. No Kizuna-operated service sits in the data path, and there is no second application datastore to keep honest.

![Offline-first sync for Supabase: a phone keeps writing offline, reconnects, pushes the queued write through kizunasync into your Supabase project, and the applied verdict fans out to the other devices. Your Postgres remains the source of truth.](/docs/images/kizunasync-flow.svg)

## Vision

That is the whole product, lived from the screen. You declare which tables belong in the synchronized set through [`defineConfig`](../reference/javascript/define-config.md). Kizuna keeps a local copy of the rows the current user is allowed to pull, so every screen can query that copy as if the device were the database.

A write updates the local view at once and enters a transactional [outbox](../resources/glossary.md#outbox), the queue of changes waiting for the server. An edit you make in a tunnel is therefore on screen before anything leaves the device. It comes back stamped applied or rejected once the client reaches your project again, which [Offline writes](../sync/offline-writes.md) walks through end to end.

Authority never leaves your project. Postgres remains the source of truth. [Supabase Auth](https://supabase.com/docs/guides/auth/sessions#what-is-a-session) issues the session Kizuna forwards on every pull and push, and Kizuna holds no identity of its own. Your [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies) policies judge a queued mutation with the same rules an online write meets. An offline mutation is optimistic. It counts as the server's write only after the push RPC returns an applied or rejected [verdict](../resources/glossary.md#verdict).

You provision that pack from the application repository with [`kizunasync`](../cli/cli.md) (`npx kizunasync`, `pnpm dlx kizunasync`, `yarn dlx kizunasync`, or `bunx kizunasync`). [`kizunasync init`](../cli/cli.md#kizunasync-init) installs the [`kizunasync` schema](../cli/whats-installed.md#the-kizunasync-schema), the protocol RPCs, and the [triggers](https://supabase.com/docs/guides/database/postgres/triggers#creating-a-trigger) on the tables you register.

Hosted configuration is a plan rather than a supported path, so the terminal is how a project is born. The shape that work might take lives in [Management and tooling surfaces](../resources/roadmap.md#management-and-tooling-surfaces).

Under those clients sits one Rust kernel. Swift and Kotlin reach it through generated [UniFFI](https://mozilla.github.io/uniffi-rs/) packages; JavaScript reaches the same kernel through a compiled [N-API](https://nodejs.org/api/n-api.html) addon or a compiled [WebAssembly](https://grokipedia.com/page/WebAssembly) worker. There is no second engine and no public Rust application SDK. The three app clients are peers: JavaScript [`createKizunaSync`](../reference/javascript/initializing.md), Swift [`KizunaSyncClient`](../reference/swift/introduction.md), and Kotlin [`KizunaSyncClient`](../reference/kotlin/introduction.md). Browser apps run the kernel in the driver's worker. [Node](https://grokipedia.com/page/Node.js), [Bun](https://bun.sh), and [React Native](https://reactnative.dev) load the matching compiled artifact; the driver names the store as `databasePath`, or `null` for a private in-memory database. Where the artifact cannot load, the app client's first use fails with `ENGINE_UNAVAILABLE` and names what to install. [Project status](./status.md#engine-selection) lists every lane.

## Features

- Application rows never leave your Postgres: Kizuna installs a schema, protocol RPCs, and triggers on the tables you register, and it never moves those rows into another vendor's datastore.
- Screens query local SQLite, so a read does not wait on the network; an operator the local builder does not implement throws `LOCAL_UNSUPPORTED` instead of falling through to Supabase, and [Supported query operators](../reference/query-operators.md) says which operators exist.
- Insert, update, and delete land in a durable outbox and replay after reconnect, so a tunnel, a flaky radio, or a closed laptop does not eat the write; whether that queue survives abrupt process death still depends on the driver and the platform.
- Two devices that touch different columns of the same row can both keep their edits; competing edits to one column follow server arrival order, or a [Hybrid Logical Clock](../resources/glossary.md#hybrid-logical-clock-hlc) on tables configured that way, which [Conflict resolution](../sync/conflict-resolution.md) sets out in full.
- [`increment`, `arrayUnion`, and `arrayRemove`](../sync/collaborative-fields.md) are [Firestore](https://firebase.google.com/docs/firestore)-style transforms on an `update`, not a fourth operation and not [CRDTs](https://grokipedia.com/page/Conflict-free_replicated_data_type), so counters and membership lists can move on more than one device without waiting for a lock.
- Files travel with the same engine: at or below 6 MiB they use a [standard Storage upload](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading), and larger files use a [resumable TUS upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url), both queued so a disconnect does not abandon the transfer. [Media and attachments](../attachments/media-and-attachments.md) is the guide, and native hosts opt in with `attachmentRoot`.
- A [bucket](../sync/sync-rules-and-buckets.md) chooses which rows you copy to the device, and the server still checks the caller's [JWT](https://grokipedia.com/page/JSON_Web_Token) on every pull and push, so selection never impersonates authorization.
- Consistency claims are executable. Schemas, decisions, and golden transcripts live in `packages/protocol/`. A guarantee that cannot match that corpus is not a guarantee. The [Protocol reference](../reference/protocol.md) documents that corpus.

## Use cases

Kizuna fits an application that already lives on Supabase, that has to keep a declared set of rows usable when the radio drops, and that can accept reconciliation after reconnect: a field inspection that must be filled in a basement, an inventory count that cannot wait for the warehouse access point, a personal productivity app whose owner expects yesterday's list on a train.

It is the wrong instrument for a character-level collaborative editor, for a server-authoritative realtime game loop, for a global constraint that has to hold while every device is offline, or for a write path that commits synced-table transactions at a high sustained rate, because [those commits are numbered one at a time](../sync/fencing-and-horizons.md#what-commit-time-numbering-costs). Unique inventory and rules like it cannot be guaranteed without contacting an authority; Kizuna surfaces the server's verdict when synchronization resumes, and [What the model does not provide](../sync/consistency-model.md#what-the-model-does-not-provide) is the full list. [Comparison with alternatives](../resources/comparison-with-alternatives.md) puts Kizuna next to PowerSync, Electric, Firestore, and others.

## Next steps

- [Quick start](./quickstart.md): provision your Supabase app with `kizunasync` from the terminal.
- [Playground](./playground.md): the hosted demo and the five reference apps.
- [How Kizuna works](./how-kizuna-works.md): outbox, pull, verdicts, and files in five steps.
- [Architecture](../resources/architecture.md): kernel, SQL pack, and what deliberately does not exist.
