import { GITHUB_URL } from '@/lib/site'

export const PRIMARY_SOURCES = [
  {
    name: 'PowerSync architecture',
    what: 'Service, client SDK, backend integration, local SQLite, and Sync Streams/rules.',
    href: 'https://docs.powersync.com/architecture/architecture-overview',
  },
  {
    name: 'WatermelonDB synchronization',
    what: 'Local database plus application-provided pullChanges and pushChanges endpoints.',
    href: 'https://watermelondb.dev/docs/Sync/Intro',
  },
  {
    name: 'RxDB Supabase plugin',
    what: 'PostgREST pull/push, Realtime wake-ups, checkpoints, soft deletes, and conflicts.',
    href: 'https://rxdb.info/replication-supabase.html',
  },
  {
    name: 'Electric repository overview',
    what: 'Postgres read-path sync, Shapes, HTTP delivery, and the self-hosted service path.',
    href: 'https://github.com/electric-sql/electric/blob/main/README.md',
  },
  {
    name: 'TinyBase Supabase persister',
    what: 'Single JSON row through the Supabase client, RLS on that row, Realtime wake-ups, and MergeableStore metadata support.',
    href: 'https://tinybase.org/api/persister-supabase/functions/creation/createsupabasepersister/',
  },
  {
    name: 'Kizuna protocol corpus',
    what: 'The schemas, transcripts, executor, decisions, and test oracle behind Kizuna claims.',
    href: `${GITHUB_URL}/tree/main/packages/protocol`,
  },
] as const
