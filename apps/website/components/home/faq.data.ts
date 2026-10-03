export const FAQ = [
  {
    question: 'What does it cost to run?',
    answer:
      'Kizuna runs entirely inside your own Supabase project: there is no Kizuna-operated billing service. The client engine, drivers, bindings, CLI, inspector, and protocol sources declare Apache-2.0; the server SQL pack declares PolyForm Shield 1.0.0. You still pay for and operate the Supabase, hosting, storage, egress, build, and support resources your application uses.',
  },
  {
    question: 'How are conflicts handled?',
    answer:
      'The default arrival mode applies column-level last-writer-wins using accepted server order; device clocks do not order that mode. A table can instead opt into HLC mode, where the server clamps and compares the origin HLC per column. RLS, constraints, preconditions, tombstones, and push policy can still reject a mutation. The documented causal+ and session guarantees are scoped to successful checkpoints, visible buckets, and retention.',
  },
  {
    question: "I deleted a row, why did/didn't it come back?",
    answer:
      'A hard delete writes a tombstone. While it is retained, a later mutation to that row is rejected with DELETE_WINS. The default tombstone TTL is 30 days; after retained history is reaped, a client behind the horizon receives CHECKPOINT_EXPIRED and rehydrates. A soft delete is an ordinary update to your deleted_at or status column, so it remains editable and recoverable under the configured conflict mode.',
  },
  {
    question: 'What about apps with a LOT of data?',
    answer:
      'Declared buckets limit pulls to equality-scoped subsets, pages use a keyset cursor, and attachments download lazily. CHECKPOINT_EXPIRED triggers snapshot rehydration rather than continuing an expired cursor. The repository does not publish a 100,000-row device benchmark or a universal latency target, so size and responsiveness must be measured with your schema, RLS, driver, hardware, and network.',
  },
  {
    question: 'Can I use my own SQLite library?',
    answer:
      'The Alpha exports IStoreLocator, and the repository contains the browser worker driver, Expo SQLite, and opt-in op-sqlite implementations. A driver names the database the Rust kernel opens rather than running SQL itself. The interface can change before a release, there is no Capacitor driver, and there is no standalone driver TCK. On Node/Bun and React Native the native binding must resolve, or createKizunaSync throws ENGINE_UNAVAILABLE naming the missing artifact; browsers always run it, because the browser driver carries it.',
  },
  {
    question: 'Does it work beyond Supabase? Other databases?',
    answer:
      'The current adapters and SQL pack are Supabase-specific: Postgres RLS, PostgREST RPCs, Auth JWT claims, Storage, Realtime, and pg_cron are part of the implementation. The repository does not provide a generic Postgres adapter or support another database backend.',
  },
  {
    question: 'Is my data safe? What credentials does Kizuna hold?',
    answer:
      'Clients call your Supabase with the current user session, and no Kizuna-operated service receives sync traffic. Public SECURITY DEFINER RPCs access private bookkeeping, while user-row helpers enforce grants and RLS under a non-BYPASSRLS role; attachment RPCs perform explicit ownership checks. Provisioning uses a direct database connection or a Supabase Personal Access Token for the Management API, not a browser service-role key. The repository inspector uses only credentials you configure server-side.',
  },
] as const
