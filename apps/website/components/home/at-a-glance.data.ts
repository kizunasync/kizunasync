/**
 * Machine-readable quick-facts table: kept in the server HTML for AI
 * crawlers + the geo.extractability check, but visually hidden (sr-only).
 * The visible page carries the same facts in prose, the feature cards and
 * the FAQ; this is purely the structured, extractable mirror.
 */
export const AT_A_GLANCE = [
  ['License', 'Engine, drivers, CLI & panel: Apache-2.0; server SQL pack: PolyForm-Shield'],
  [
    'Distribution',
    'npm kizunasync and @kizunasync/*, Swift package kizunasync/kizunasync-swift, Maven com.kizunasync:kizunasync, published by the release workflows on a tag matching the workspace version (X.Y.Z with an optional prerelease identifier)',
  ],
  ['Kizuna-operated data plane', 'None; clients call SQL and Storage in your Supabase project'],
  ['Data + media sync', 'Rows plus attachment references; standard upload through 6 MiB, then TUS'],
  ['Conflict handling', 'Column LWW by server arrival by default; optional clamped-HLC mode'],
  ['Query API', 'Documented supabase-js-like subset over local SQLite; unsupported operations throw'],
  ['Deletes', 'Retained tombstones plus CHECKPOINT_EXPIRED rehydration beyond the horizon'],
  ['Status', 'Alpha; source-available in this repository'],
] as const
