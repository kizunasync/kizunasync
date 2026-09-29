export const HONESTY = [
  {
    need: 'Concurrent collaborative text or canvas co-editing',
    answer: 'Use a CRDT engine. Yjs, Automerge, Loro. Different problem class.',
  },
  {
    need: 'Strict cross-user invariants: ledgers, bookings, inventory holds',
    answer: 'Keep those flows online-only and transactional. Offline writes are the wrong model regardless of engine.',
  },
  {
    need: 'Arbitrary RLS-predicate partial sync at enterprise scale',
    answer: 'Evaluate a dedicated server-side sync service. Kizuna supports declared equality buckets, with RLS as authorization.',
  },
  {
    need: 'Multi-terminal mesh sync while offline (full POS, kiosk fleets)',
    answer: 'Use a system designed and tested for peer or edge mesh replication. Kizuna synchronizes through one authoritative Supabase project.',
  },
] as const
