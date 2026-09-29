/**
 * Pins for pack facts that appear in more than one place, so a drifting copy
 * fails here. Most read only the files. The secondary-index and trigger counts
 * read the rebuilt database as well, and skip loudly when none is reachable.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { SQL as Sql } from 'bun'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURSOR_TOKEN } from '../../protocol/spec/cursor-token'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const PACK = join(ROOT, 'packages/supabase-pack')
const SQL = readFileSync(join(PACK, 'supabase/migrations/0001_kizuna_init.sql'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(PACK, 'pack.manifest.json'), 'utf8')) as {
  pack: string[]
  demo: string[]
}
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

let db: Sql | null = null
let reachable = false

try {
  const probe = new Sql(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[pack-pinning] SKIPPED the database pins: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

describe('pack pinning', () => {
  test('every pack_version literal equals the workspace version', () => {
    const versions = [...SQL.matchAll(/'([^']+)'\s*,\s*'p_|'([^']+)'\s*,\s*'0\.|'([^']+)',\s*'/g)]
    const literals = [...SQL.matchAll(/'0\.[^']+'/g)].map((match) => match[0].slice(1, -1))
    const packVersions = [...SQL.matchAll(/'([^']+)',\s*'[^']*',\s*$/gm)]

    void versions
    void packVersions
    const seeded = [...SQL.matchAll(/'([0-9][^']*)'/g)]
      .map((match) => match[1])
      .filter((value) => value === PACKAGE_VERSION.version || /^\d+\.\d+\.\d+/.test(value ?? ''))
    const distinct = [...new Set(literals.filter((value) => /^\d+\.\d+/.test(value)))]

    expect(distinct).toEqual([PACKAGE_VERSION.version])
    expect(seeded.some((value) => value === PACKAGE_VERSION.version)).toBe(true)
  })

  test('no add column if not exists conflict_journal in the pack', () => {
    expect(SQL).not.toMatch(/add column if not exists conflict_journal/i)
    const sqlPack = readFileSync(join(ROOT, 'docs/reference/sql-pack.md'), 'utf8')

    expect(sqlPack).not.toMatch(/add column if not exists conflict_journal/)
  })

  test('_settings defaults match the CLI pack_defaults literals', () => {
    const config = readFileSync(join(ROOT, 'crates/kizunasync-cli/src/config.rs'), 'utf8')
    const expectDefault = (name: string, sqlNeedle: string, rustNeedle: string): void => {
      expect(SQL, name).toContain(sqlNeedle)
      expect(config, name).toContain(rustNeedle)
    }
    expectDefault('reap', "reap_schedule text not null default '16 3 * * *'", 'DEFAULT_REAP_SCHEDULE: &str = "16 3 * * *"')
    expectDefault('compact', "compact_schedule text not null default '47 3 * * *'", 'DEFAULT_COMPACT_SCHEDULE: &str = "47 3 * * *"')
    expectDefault('prune', "client_prune_schedule text not null default '31 3 * * *'", 'DEFAULT_CLIENT_PRUNE_SCHEDULE: &str = "31 3 * * *"')
    expectDefault('client ttl', 'client_ttl_days integer not null default 90', 'DEFAULT_CLIENT_TTL_DAYS: i64 = 90')
    expectDefault('skew', 'hlc_max_skew_ms integer not null default 5000', 'DEFAULT_HLC_MAX_SKEW_MS: i64 = 5000')
    expectDefault('tombstone', 'tombstone_ttl_days integer not null default 30', 'DEFAULT_TOMBSTONE_TTL_DAYS: i64 = 30')
    expectDefault('pull scan', 'max_pull_scan integer not null default 5000', 'DEFAULT_MAX_PULL_SCAN: i64 = 5000')
  })

  test('SQL cursor regex equals CURSOR_TOKEN.source', () => {
    expect(SQL).toContain(CURSOR_TOKEN.source)
  })

  test('_pull_impl default limit equals DEFAULT_PAGE_LIMIT', () => {
    const limits = readFileSync(join(ROOT, 'packages/protocol/spec/limits.ts'), 'utf8')
    const match = limits.match(/DEFAULT_PAGE_LIMIT = (\d+)/)

    expect(match?.[1]).toBe('500')
    expect(SQL).toMatch(/"limit"\s+integer\s+default 500/)
  })

  test('the pull scan cap and the bucket-entry cap equal the protocol limits', () => {
    const limits = readFileSync(join(ROOT, 'packages/protocol/spec/limits.ts'), 'utf8')
    const scanCap = limits.match(/DEFAULT_MAX_PULL_SCAN = (\d+)/)?.[1]
    const bucketCap = limits.match(/MAX_PULL_BUCKETS = (\d+)/)?.[1]

    expect(SQL).toContain(`max_pull_scan integer not null default ${scanCap} check (max_pull_scan >= 1)`)
    expect(SQL).toContain(`v_max_buckets     constant integer := ${bucketCap};`)
  })

  test('function inventory matches sql-pack spelled counts', () => {
    const functions = [...SQL.matchAll(/create or replace function kizunasync\./g)]

    expect(functions).toHaveLength(64)
    const tables = [...SQL.matchAll(/create (?:unlogged )?table if not exists kizunasync\./g)]

    expect(tables).toHaveLength(13)
    const sqlPack = readFileSync(join(ROOT, 'docs/reference/sql-pack.md'), 'utf8')

    expect(sqlPack).toMatch(/sixty-four functions/)
    expect(sqlPack).toMatch(/thirteen tables/)
    expect(sqlPack).toMatch(/Fifty-four further functions/)
    const whats = readFileSync(join(ROOT, 'docs/cli/whats-installed.md'), 'utf8')

    expect(whats).toMatch(/five families/)
    const familyRows = whats
      .split('## The rest of the functions')[1]
      ?.split('## The per-table hooks')[0]
      ?.split('\n')
      .filter((line) => /^\| [A-Z]/.test(line) && !line.startsWith('| Family |')) ?? []

    expect(familyRows).toHaveLength(5)
  })

  test('the helpers owned by kizunasync_rls match the sql-pack spelled count', () => {
    const owned = [...SQL.matchAll(/^alter function kizunasync\.\w+\([^)]*\) owner to kizunasync_rls;$/gm)]
    const sqlPack = readFileSync(join(ROOT, 'docs/reference/sql-pack.md'), 'utf8')
    const helperRows = sqlPack
      .split('### Internal helpers')[1]
      ?.split('\n## ')[0]
      ?.split('\n')
      .filter((line) => /^\| `\w+\(.*\)` \| kizunasync_rls \|/.test(line)) ?? []

    expect(owned).toHaveLength(10)
    expect(helperRows).toHaveLength(10)
    expect(sqlPack).toContain('the ten owned by `kizunasync_rls`')
  })

  test('the retention table names every pack table and what the reaper does for an undeclared table', () => {
    const packTables = [...SQL.matchAll(/create (?:unlogged )?table if not exists kizunasync\.(\w+)/g)].map((match) => match[1]).sort()
    const sqlPack = readFileSync(join(ROOT, 'docs/reference/sql-pack.md'), 'utf8')
    const retention = sqlPack.split('### Retention')[1]?.split('\n## ')[0] ?? ''
    const listed = [...retention.matchAll(/^\| `(\w+)` \|/gm)].map((match) => match[1]).sort()

    expect(listed).toEqual(packTables)
    expect(retention).toContain('A table with no `_config` row')
  })

  test('documented local ports match config.toml', () => {
    const toml = readFileSync(join(PACK, 'supabase/config.toml'), 'utf8')
    const api = toml.match(/\[api\][^\[]*port = (\d+)/)?.[1]
    const studio = toml.match(/\[studio\][^\[]*port = (\d+)/)?.[1]

    expect(api).toBe('55321')
    expect(studio).toBe('55323')

    for (const rel of ['docs/reference/sql-pack.md', 'docs/cli/local-supabase.md']) {
      const text = readFileSync(join(ROOT, rel), 'utf8')

      expect(text).toContain(`http://127.0.0.1:${api}`)
      expect(text).toContain(`http://127.0.0.1:${studio}`)
    }
    const inspector = readFileSync(join(ROOT, 'apps/sync-inspector/lib/use-doorbell-refresh.ts'), 'utf8')

    expect(inspector).toContain(`http://127.0.0.1:${api}`)
  })

  test('pack ∪ demo equals the sql files under migrations and demo', () => {
    const migrations = readdirSync(join(PACK, 'supabase/migrations')).filter((name) => name.endsWith('.sql'))
    const demo = readdirSync(join(PACK, 'supabase/demo')).filter((name) => name.endsWith('.sql'))

    expect(MANIFEST.pack).toEqual(['0001_kizuna_init.sql'])
    expect(new Set(MANIFEST.pack)).toEqual(new Set(migrations.filter((name) => name.startsWith('0001_kizuna'))))
    expect(MANIFEST.demo.sort()).toEqual(['0001_public_demo_hardening.sql', '0002_example.sql'])
    expect([...MANIFEST.pack, ...MANIFEST.demo].sort()).toEqual([...migrations, ...demo].sort())
  })
})

describe('provisions ledger seed pinning', () => {
  test('seed row counts match the sql-pack sentence', () => {
    const seed = SQL.split('insert into kizunasync._provisions')[1]?.split('on conflict (object_kind, object_name)')[0] ?? ''
    const rows = [...seed.matchAll(/^\s*\('([a-z]+)',/gm)].map((match) => match[1])
    const functions = rows.filter((kind) => kind === 'function')

    expect(rows).toHaveLength(69)
    expect(functions).toHaveLength(64)
    const sqlPack = readFileSync(join(ROOT, 'docs/reference/sql-pack.md'), 'utf8')

    expect(sqlPack).toContain(`The migration seeds ${rows.length} rows: ${functions.length} functions,`)
  })
})

describe.skipIf(!reachable)('pack inventory counts in the database', () => {
  test('secondary indexes match the docs spelled counts', async () => {
    const [row] = await db!`
      select count(*)::int as n
      from pg_index i
      join pg_class t on t.oid = i.indrelid
      join pg_namespace s on s.oid = t.relnamespace
      where s.nspname = 'kizunasync'
        and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)`

    expect(row.n).toBe(12)
    const sqlPack = readFileSync(join(ROOT, 'docs/reference/sql-pack.md'), 'utf8')
    const whats = readFileSync(join(ROOT, 'docs/cli/whats-installed.md'), 'utf8')

    expect(sqlPack).toMatch(/twelve secondary indexes/)
    expect(whats).toMatch(/The pack creates twelve indexes/)
  })

  test('triggers match the docs spelled count', async () => {
    const [row] = await db!`
      select count(*)::int as n
      from pg_trigger tr
      join pg_class t on t.oid = tr.tgrelid
      join pg_namespace s on s.oid = t.relnamespace
      where s.nspname = 'kizunasync' and not tr.tgisinternal`

    expect(row.n).toBe(1)
    const sqlPack = readFileSync(join(ROOT, 'docs/reference/sql-pack.md'), 'utf8')

    expect(sqlPack).toMatch(/one trigger on its own `_change_pending` table/)
  })

  test('the protocol reference lists each public RPC with the arguments and defaults the pack installs', async () => {
    const protocol = readFileSync(join(ROOT, 'docs/reference/protocol.md'), 'utf8')
    const surface = protocol.split('## Authenticated SQL surface')[1]?.split('\n## ')[0] ?? ''
    const documented = [...surface.matchAll(/^\| \[`kizunasync\.(\w+)`\]\([^)]*\) \| `([^`]*)` \|/gm)]
      .map((match) => ({
        name: match[1],
        args: (match[2] ?? '').replace(/ default [^,]+/g, ''),
        defaults: (match[2] ?? '').split(' default ').length - 1,
      }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    const installed = await db!`
      select p.proname::text as name,
             pg_get_function_identity_arguments(p.oid) as args,
             p.pronargdefaults::int as defaults
      from pg_proc p
      join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'kizunasync'
        and p.proname in ('pull', 'push', 'attachment_confirm', 'attachment_metadata', 'attachment_vacuum')
      order by p.proname`

    expect(documented).toEqual([...installed])
  })

  test('functions owned by kizunasync_rls match the docs spelled count', async () => {
    const [row] = await db!`
      select count(*)::int as n
      from pg_proc p
      join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'kizunasync' and pg_get_userbyid(p.proowner) = 'kizunasync_rls'`

    expect(row.n).toBe(10)
  })
})
