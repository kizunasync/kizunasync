/**
 * kizunasync relies on NO default-privileges mechanism to lock down functions:
 * per PostgreSQL's documented behavior, a per-schema default-privileges entry is
 * ADDED to the built-in defaults and cannot SUBTRACT the built-in PUBLIC-execute
 * default a new function gets (see the Grants section of 0001_kizuna_init.sql).
 * Every function in the schema is locked by an explicit `revoke all on all
 * routines in schema kizunasync ...` at migration time; a migration that adds a
 * function must carry its own explicit revoke, and the audit test below enforces
 * that discipline, with only the five public RPCs executable. Skips
 * loudly when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[default-privileges] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

describe.skipIf(!reachable)('kizunasync default privileges (no auto EXECUTE for authenticated)', () => {
  // Regression guard: no default-ACL mechanism is used at all (see the file docblock), so this should always find zero rows. A change that adds a default-privileges grant to authenticated fails here directly.
  test('pg_default_acl grants no functions/execute to authenticated for schema kizunasync', async () => {
    const rows = await db!`
      select d.defaclacl::text as acl
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
      where n.nspname = 'kizunasync' and d.defaclobjtype = 'f'`

    for (const row of rows) {
      expect(row.acl as string).not.toContain('authenticated=X')
    }
  })

  // No default-ACL safety net exists, so a migration that adds a kizunasync function without its own explicit `revoke execute ... from public` fails this audit.
  test('every kizunasync function is locked down for authenticated except the five public RPCs', async () => {
    const PUBLIC_RPCS = new Set(['pull', 'push', 'attachment_confirm', 'attachment_metadata', 'attachment_vacuum'])
    const rows = await db!`
      select p.proname as name, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'kizunasync'
      order by p.proname`
    const leaked = rows.filter((r) => (r.auth_exec as boolean) && !PUBLIC_RPCS.has(r.name as string))

    expect(leaked.map((r) => r.name)).toEqual([])
  })
})
