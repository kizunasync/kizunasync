/**
 * Text cells keep unlike architectures unlike. A checkmark matrix would imply
 * equivalent scope and evidence across products, which their primary sources
 * do not support.
 */
export interface IMatrixRow {
  label: string
  cells: [string, string, string, string, string, string, string]
  note?: string
}

export const MATRIX_COLUMNS = ['Kizuna', 'PowerSync', 'WatermelonDB', 'RxDB', 'Electric', 'TinyBase', 'DIY'] as const

export const MATRIX: { group: string; rows: IMatrixRow[] }[] = [
  {
    group: 'Data path',
    rows: [
      {
        label: 'Read synchronization',
        cells: [
          'Client calls RPCs in your Supabase',
          'Client uses PowerSync Service',
          'Client calls your pull endpoint',
          'Supabase plugin pulls through PostgREST',
          'Client consumes Shape streams over HTTP or a client integration',
          'Persister loads one JSON row through PostgREST, or a synchronizer merges over WebSocket',
          'Defined by your design',
        ],
      },
      {
        label: 'Write synchronization',
        cells: [
          'Provisioned push RPC returns typed verdicts',
          'SDK queue calls your uploadData handler',
          'Client calls your pushChanges endpoint',
          'Supabase plugin pushes through PostgREST',
          "Outside Electric's documented read-path sync engine",
          'Persister saves the same JSON row; a synchronizer merges by HLC order on the client',
          'Defined by your design',
        ],
      },
      {
        label: 'Additional sync process',
        cells: [
          'No Kizuna-operated process',
          'PowerSync Service, cloud or self-hosted',
          'Your backend endpoints',
          'None for the Supabase plugin path',
          'Electric service connected to Postgres',
          'None on the Supabase persister path; a WebSocket or Durable Object relay for synchronizers',
          'Defined by your design',
        ],
      },
    ],
  },
  {
    group: 'Data model and selection',
    rows: [
      {
        label: 'Local model',
        cells: [
          'Relational SQLite tables',
          'PowerSync-managed SQLite views',
          'WatermelonDB collections',
          'RxDB documents',
          'Shape data; storage depends on the client integration',
          'In-memory Tables, Rows, Cells, and Values, optionally persisted',
          'Defined by your design',
        ],
      },
      {
        label: 'Partial selection',
        cells: [
          'Declared equality buckets',
          'Sync Streams or legacy Sync Rules',
          'Your pull endpoint returns accessible changes',
          'PostgREST queryBuilder plus checkpoint fields',
          'Shapes',
          'Whole store per row; a WHERE condition exists on tabular SQL persisters only',
          'Defined by your design',
        ],
        note: 'Kizuna buckets are selection, not authorization; Postgres grants and RLS still decide row access.',
      },
      {
        label: 'Authorization boundary',
        cells: [
          'Supabase grants + RLS under caller JWT',
          'Your backend authenticates upload; service scopes reads',
          'Your backend authenticates both endpoints',
          'Supabase grants + RLS',
          'Not specified by the repository overview used here',
          'RLS on the single store row; the WebSocket server does not authorize channel ids',
          'Defined by your design',
        ],
      },
    ],
  },
  {
    group: 'Current Kizuna-specific scope',
    rows: [
      {
        label: 'Installation status',
        cells: [
          'Alpha; npm kizunasync with its five @kizunasync/<platform> binary packages, Swift package kizunasync/kizunasync-swift, Maven com.kizunasync:kizunasync, published by the release workflows on a tag matching the workspace version (X.Y.Z with an optional prerelease identifier)',
          'Not compared on this page',
          'Not compared on this page',
          'Not compared on this page',
          'Not compared on this page',
          'Not compared on this page',
          'Your delivery process',
        ],
      },
      {
        label: 'Field transforms on update',
        cells: [
          'Shipped: increment, arrayUnion, arrayRemove. A later assign of the same column is arrival-LWW, not a CRDT.',
          'Not compared on this page',
          'Not compared on this page',
          'Not compared on this page',
          'Not compared on this page',
          'Not compared on this page',
          'Defined by your design',
        ],
      },
      {
        label: 'Media path evaluated here',
        cells: [
          'Storage references; standard upload ≤6 MiB, TUS above',
          'Not compared on this page',
          'Not compared on this page',
          'Not compared on this page',
          'Not compared on this page',
          'Not compared on this page',
          'Defined by your design',
        ],
        note: 'Kizuna unit tests and opt-in live tests do not constitute a cross-device benchmark.',
      },
    ],
  },
]
