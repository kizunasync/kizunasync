/**
 * constants: the shared cross-package constants, in one place.
 *
 * The server-side Postgres schema and the objects provisioned into it. These are
 * referenced by the CLI codegen (packages/cli) and the Supabase client wrappers
 * (packages/utilities), and mirrored by the raw SQL migrations in
 * packages/supabase, which cannot import TypeScript, so the two must be kept in
 * lockstep. The client-side local-store tables (`_kizunasync_*`) are a separate
 * namespace and are created by the Rust store (`crates/kizunasync-store`).
 */

/** The Postgres schema every server-side kizunasync object lives under. */
export const SCHEMA = 'kizunasync'

/** kizunasync internal tables, unqualified. Schema-qualify with `SCHEMA`. */
export const INTERNAL_TABLES = {
  config: '_config',
  provisions: '_provisions',
  settings: '_settings',
} as const

/**
 * Change-capture routine base names. The SQL function is `${SCHEMA}.<name>()`;
 * the per-table trigger is `${SCHEMA}_<name>`.
 */
export const TRACKERS = {
  change: 'track_change',
  delete: 'track_delete',
} as const

/** TTL (seconds) for the signed download URLs minted by ITransfer adapters. */
export const SIGNED_URL_TTL_SECONDS = 60
