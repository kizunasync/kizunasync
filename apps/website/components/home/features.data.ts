import { ICONS } from '@kizunasync/ui'

export const FEATURES = [
  {
    icon: ICONS.databaseSync,
    title: 'Transactional offline writes',
    body: [
      'The local row and its outbox entry commit in one SQLite transaction. Durability across abrupt termination still depends on the driver, journal mode, filesystem, and platform; the repository has no complete kill-test matrix.',
      'Mutation IDs make a committed remote effect replay-safe. Only explicitly permanent failures count toward the five-attempt dead-letter budget; retryable failures remain queued.',
    ],
    href: '/docs/offline-writes',
  },
  {
    icon: ICONS.imageMultiple,
    title: 'Rows and files in one engine',
    body: [
      'attachments.fromFile imports a file into the platform sandbox, computes its sha256, and returns the reference stored in the row; bytes travel through separate file-store and transfer ports.',
      'Uploads through 6 MiB use standard Supabase Storage; larger uploads use resumable TUS with 6 MiB chunks. Downloads verify sha256 whenever a hash is known on either side; with none known on either, the transfer fails closed with ATTACHMENT_UNVERIFIED instead of accepting unverified bytes. Normal unit tests do not prove a hosted or physical-device transfer.',
    ],
    href: '/docs/media-and-attachments',
  },
  {
    icon: ICONS.shieldLock,
    title: 'Your RLS stays in charge',
    body: [
      'The five public RPCs use SECURITY DEFINER to reach private bookkeeping. User-row reads and writes are delegated through helpers owned by a non-BYPASSRLS role under the caller JWT.',
      'Buckets select candidate rows; grants and RLS authorize them. A denied mutation returns a typed rejection that the client journals and reconciles.',
    ],
    href: '/docs/consistency-model',
  },
  {
    icon: ICONS.graveStone,
    title: 'Retained delete protection',
    body: [
      'A hard delete leaves a tombstone for the configured retention period and rejects a later mutation with DELETE_WINS while that tombstone exists.',
      'When a client cursor predates retained history, the server returns CHECKPOINT_EXPIRED and the client rehydrates instead of replaying the expired cursor.',
    ],
    href: '/docs/how-kizuna-works',
  },
  {
    icon: ICONS.lightningBolt,
    title: 'Reactive local queries',
    body: ['Engine events invalidate matching in-process subscriptions, so React hooks and Vue composables can refresh reads from local SQLite.'],
    href: '/docs/react',
  },
  {
    icon: ICONS.languageTypescript,
    title: 'Typed by your Database',
    body: [
      'defineConfig<Database> can reuse generated Supabase table and row types. The Kizuna config still declares which tables synchronize, their modes, buckets, and attachment columns.',
      'The local query builder deliberately implements a documented subset; unsupported PostgREST constructs throw LOCAL_UNSUPPORTED.',
    ],
    href: '/docs/reference/javascript/define-config',
  },
  {
    icon: ICONS.terminal,
    title: 'Workspace provisioning CLI',
    body: [
      'The product CLI is the Rust kizunasync binary. Invoke it with npx kizunasync, pnpm dlx kizunasync, yarn dlx kizunasync, or bunx kizunasync, then preview init before applying with --yes.',
      'deprovision removes understood ledgered objects and by default leaves the schema, bookkeeping tables, indexes, and sequence in place; --purge continues into the schema itself. Your application tables and their data are never dropped, on either path.',
    ],
    href: '/docs/cli',
  },
  {
    icon: ICONS.serverOff,
    title: 'No Kizuna-operated data plane',
    body: [
      'Its SQL runs in your Supabase project and clients call that project directly, so Kizuna adds no separate operated sync service.',
      'Availability still depends on Supabase, PostgREST, Storage, Realtime wake-ups, pg_cron retention, the network, and the local driver.',
    ],
    href: '/docs/architecture-overview',
  },
  {
    icon: ICONS.database,
    title: 'Explicit driver and engine boundary',
    body: [
      'IStoreLocator is exported but remains Alpha. A driver names the database file the Rust kernel opens, or hands over an engine it already runs. The repository implements the browser worker driver and the Expo SQLite driver, plus an opt-in op-sqlite adapter.',
      'Browsers run Rust as WebAssembly in the driver\'s worker; Node/Bun and React Native select Rust when the matching binding and database path are available. No Capacitor driver or standalone published TCK exists.',
    ],
    href: '/docs/architecture-overview',
  },
  {
    icon: ICONS.speedometer,
    title: 'Repository Sync Inspector',
    body: [
      'apps/sync-inspector implements a read-only view over explicitly configured server-side credentials for a development stack.',
      'The code is present; hosting and an active deployment workflow remain open decisions. The repository does not ship a hosted management panel.',
    ],
    href: '/docs/status',
  },
] as const
