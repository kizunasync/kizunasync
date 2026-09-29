/**
 * Import from SERVER components only. The service role bypasses RLS and must
 * never reach the browser bundle (`NEXT_PUBLIC_` would let Next inline it).
 * The shipped product never uses a service-role key (@../../../CONVENTIONS.md);
 * this inspector is local-dev tooling over the developer's own
 * packages/supabase-pack stack, so the key has no in-code fallback: only the
 * environment. Copy the repo-root `.env.example` to `.env` and paste the
 * per-stack keys from `bun run db:status`. The example file holds
 * placeholders, not real values.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// MARK: - Server-side Supabase client

function localApiUrl(): string {
  const config = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../packages/supabase-pack/supabase/config.toml',
  )
  const text = readFileSync(config, 'utf8')
  const match = text.match(/\[api\][^\[]*port = (\d+)/)

  if (match === null) {
    throw new Error(`could not read [api] port from ${config}`)
  }
  return `http://127.0.0.1:${match[1]}`
}

const LOCAL_SUPABASE_URL = localApiUrl()

/** Null when no service-role key is configured: the page renders setup help. */
export function createInspectorClient(): SupabaseClient | null {
  const url = process.env.INSPECTOR_SUPABASE_URL ?? LOCAL_SUPABASE_URL
  const key = process.env.INSPECTOR_SUPABASE_SERVICE_ROLE_KEY ?? ''

  if (key === '') {
    return null
  }
  return createClient(url, key, {
    // Server-side: no session to persist, no token to refresh.
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
