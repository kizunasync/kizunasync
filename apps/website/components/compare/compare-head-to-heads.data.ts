export interface IComparison {
  id: string
  name: string
  what: string
  sourceLabel: string
  sourceUrl: string
  whyKizunaSync: string[]
  theyShine: string[]
  chooseThem: string
  chooseKizunaSync: string
}

export const COMPARISONS: IComparison[] = [
  {
    id: 'powersync',
    name: 'PowerSync',
    what: 'PowerSync documents a service, client SDKs, and a backend integration layer. The service replicates a source database and streams selected data into client-side SQLite through Sync Streams or legacy Sync Rules.',
    sourceLabel: 'PowerSync architecture overview',
    sourceUrl: 'https://docs.powersync.com/architecture/architecture-overview',
    whyKizunaSync: [
      'Its clients call RPCs and Storage in your Supabase project, so Kizuna puts no separate Kizuna service in the data path.',
      'Kizuna uses declared equality buckets and your Postgres grants/RLS. That is narrower than a service that materializes Sync Streams or rules.',
      'Kizuna includes its Supabase Storage attachment queue, with standard upload through 6 MiB and resumable TUS above that threshold.',
      'Kizuna is Alpha client software plus a SQL pack in your Supabase project, not a managed service. That is a scope difference, not a pricing advantage.',
    ],
    theyShine: [
      'PowerSync offers cloud-hosted and self-hosted service paths and supports several source database families.',
      'Its SDK manages a local SQLite database and download path through Sync Streams or legacy Sync Rules.',
      'Its upload queue calls an application-defined uploadData handler, leaving backend validation and writes under your control.',
    ],
    chooseThem:
      'You want the documented service architecture, broader selection machinery, or its documented SDK and deployment paths.',
    chooseKizunaSync:
      'You accept a source-only Supabase-specific Alpha and prefer its provisioned SQL, typed verdicts, and built-in attachment path.',
  },
  {
    id: 'watermelondb',
    name: 'WatermelonDB',
    what: 'WatermelonDB describes itself as a local database. Its sync adapter expects application-provided pullChanges and pushChanges functions backed by endpoints that implement the Watermelon Sync Protocol.',
    sourceLabel: 'WatermelonDB synchronization introduction',
    sourceUrl: 'https://watermelondb.dev/docs/Sync/Intro',
    whyKizunaSync: [
      'Kizuna provides a Supabase-specific SQL pack, pull/push RPCs, retention machinery, and typed per-mutation verdicts instead of asking you to implement the backend protocol.',
      'Kizuna has a first-party Supabase Storage attachment queue. This page makes no claim about third-party media integrations around WatermelonDB.',
      'Kizuna uses a global server sequence and fenced checkpoint protocol; WatermelonDB deliberately lets your backend satisfy its timestamp and consistency contract.',
    ],
    theyShine: [
      'The backend boundary is portable: you provide two protocol-compatible endpoints instead of adopting a Supabase-specific server pack.',
      'Its official backend guide defines first-sync, incremental pull, conflict checks, transactional push, and migration-sync responsibilities.',
    ],
    chooseThem:
      'You want WatermelonDB as the local database and are prepared to own or already own its backend protocol.',
    chooseKizunaSync:
      "Your server is Supabase and you prefer the repository-provided SQL/RPC contract, accepting Kizuna's Alpha status.",
  },
  {
    id: 'rxdb',
    name: 'RxDB',
    what: 'RxDB is a local document database with a generic replication engine. Its current Supabase plugin documents direct PostgREST pull/push, Realtime wake-ups, a (modified, id) checkpoint, optimistic concurrency, and soft-delete metadata.',
    sourceLabel: 'RxDB Supabase replication plugin',
    sourceUrl: 'https://rxdb.info/replication-supabase.html',
    whyKizunaSync: [
      'Kizuna exposes a relational SQLite query subset typed from a Supabase Database type instead of an RxDB document schema.',
      'Kizuna provisions a server changelog, fenced cursor, tombstone retention, and typed verdict ledger rather than relying on modified/deleted application columns.',
      'Kizuna includes an attachment queue tied to Supabase Storage. This comparison does not make a claim about RxDB attachment plugins or storage pricing.',
    ],
    theyShine: [
      'RxDB documents many storage and replication options and is not tied to one backend.',
      'The Supabase plugin connects directly to Supabase and supports queryBuilder customization on pulls.',
      "A document model and RxDB's broader plugin surface may fit applications that are not relational or Supabase-specific.",
    ],
    chooseThem:
      "You want RxDB's document model, runtime/storage breadth, or backend-neutral replication engine.",
    chooseKizunaSync:
      'You want the Kizuna SQL pack, relational local app client, typed server verdicts, and built-in Storage transfer in a Supabase-only design.',
  },
  {
    id: 'electricsql',
    name: 'Electric',
    what: "Electric's current repository describes a Postgres read-path sync engine. You run Electric in front of logical-replication-enabled Postgres and consume partial-replication Shapes through an HTTP API or client library.",
    sourceLabel: 'Electric official repository overview',
    sourceUrl: 'https://github.com/electric-sql/electric/blob/main/README.md',
    whyKizunaSync: [
      "Kizuna includes a local outbox and provisioned Supabase push RPC; Electric's current repository overview explicitly scopes its engine to the Postgres read path.",
      "Kizuna does not add a separate Kizuna process. Electric's documented self-hosted path runs an Electric service connected to Postgres.",
      'Kizuna includes Supabase Storage attachment transfers; Electric Shapes focus on Postgres rows.',
    ],
    theyShine: [
      'Electric focuses on partial read replication and HTTP delivery that can integrate with CDN infrastructure.',
      'Its repository links a low-level HTTP API, client libraries, and framework integrations for consuming Shapes.',
    ],
    chooseThem:
      "You want Electric's documented read-path Shape architecture and will select or design the write path separately.",
    chooseKizunaSync:
      'You want one Supabase-specific source tree that includes local queued writes, server verdicts, row pull, and attachments.',
  },
  {
    id: 'tinybase',
    name: 'TinyBase',
    what: 'TinyBase is a reactive in-memory data store for JavaScript with optional persistence and synchronization. Its MergeableStore adds hybrid logical clock metadata for last-write-wins merging, and its Supabase persister reads and writes one JSON serialization of the whole store as a single row through the Supabase client.',
    sourceLabel: 'TinyBase Supabase persister reference',
    sourceUrl: 'https://tinybase.org/api/persister-supabase/functions/creation/createsupabasepersister/',
    whyKizunaSync: [
      'Kizuna synchronizes rows of your existing Postgres tables under their RLS policies; the TinyBase Supabase persister stores the whole store as one JSON row in a table you create for it.',
      'Kizuna applies writes on the server and returns typed verdicts for RLS, preconditions, constraints, and tombstones; a MergeableStore merge is decided on the client by HLC order with no server validation step.',
      'Kizuna keeps data in SQLite on disk with bucket-scoped pulls; a TinyBase Store is held in memory, and its own guidance flags very large datasets as a concern.',
      'Kizuna retains tombstones for a configured window and expires stale cursors.',
      'Kizuna includes Supabase Storage attachments and Swift and Kotlin clients; TinyBase is JavaScript and TypeScript only.',
    ],
    theyShine: [
      'A reactive local data layer with queries, indexes, relationships, checkpoints for undo and redo, and bindings for React, Solid, and Svelte, in a dependency-free package from 7.3 kB gzipped for the store module alone to 16.4 kB for every module.',
      'Deterministic last-write-wins merging between MergeableStore instances over WebSocket, BroadcastChannel, or Cloudflare Durable Object synchronizers, with no server-side schema.',
      'Persisters for many SQLite, PostgreSQL, and browser storage targets, including a PowerSync persister when a sync service is wanted underneath.',
    ],
    chooseThem:
      'Your data is a per-user or per-document store that fits in memory, you want a rich reactive local API with undo, and a client-decided merge is acceptable.',
    chooseKizunaSync:
      'Your data is shared relational rows under Supabase RLS, you need server-side verdicts, attachments, or native mobile clients, and you accept a source-only Alpha.',
  },
  {
    id: 'diy',
    name: 'a custom implementation',
    what: 'A custom implementation can use any cursor, outbox, delete, conflict, authorization, and transfer design. Its guarantees are whatever its code and evidence establish; there is no meaningful generic feature score.',
    sourceLabel: 'Kizuna consistency and evidence boundaries',
    sourceUrl: '/docs/consistency-model',
    whyKizunaSync: [
      'Kizuna already implements idempotent mutation verdicts, a fenced server cursor, retained tombstones, checkpoint rehydration, attachment transfer, and framework bindings.',
      'Its protocol corpus and tests make specific behavior reviewable, while the documentation names the missing driver, live-service, and physical-device evidence.',
    ],
    theyShine: [
      "A narrow custom design can match one application more closely and avoid adopting Kizuna's Supabase-specific protocol.",
      'You control every dependency, release decision, query shape, and operational trade-off.',
    ],
    chooseThem:
      'Your requirements are narrow, your team owns the protocol expertise, and you will build the failure and migration evidence you need.',
    chooseKizunaSync:
      'The implemented Kizuna boundaries match your Supabase app and source-only Alpha adoption is acceptable.',
  },
]
