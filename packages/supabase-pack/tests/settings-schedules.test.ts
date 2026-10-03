/**
 * The schedule surface of kizunasync._settings against real Postgres: the crontab
 * grammar the check constraints enforce, and kizunasync._schedule_jobs() applying
 * those columns to pg_cron.
 *
 * The grammar cases are pure function calls. The scheduling case needs the
 * extension, which the pack asks for at install time and pg_cron grants only in
 * the database named by cron.database_name: everywhere else the case skips with
 * that reason, and the no-cron case proves the same function reports what it would
 * have applied. The install block is the one statement Supabase documents, with
 * no grant on the `cron` schema, in the pack and in the demo hardening file alike.
 * Every write runs in a rolled-back transaction.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

let db: SQL | null = null
let reachable = false
let cronInstalled = false
let cronCreatable = false
let cronDatabase: string | null = null
let hasJobsStatus = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  const [row] = await probe`
    select
      exists (select 1 from pg_extension where extname = 'pg_cron') as installed,
      exists (select 1 from pg_available_extensions where name = 'pg_cron') as available,
      current_database() = current_setting('cron.database_name', true) as in_cron_database,
      current_setting('cron.database_name', true) as cron_database,
      exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'kizunasync' and p.proname = 'jobs_status'
      ) as has_jobs_status`
  const facts = row as {
    installed: boolean
    available: boolean
    in_cron_database: boolean | null
    cron_database: string | null
    has_jobs_status: boolean
  }

  cronInstalled = facts.installed
  cronCreatable = facts.available && facts.in_cron_database === true
  cronDatabase = facts.cron_database
  hasJobsStatus = facts.has_jobs_status
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[settings-schedules] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

if (reachable && !cronInstalled) {
  console.warn(
    `[settings-schedules] SKIPPED (scheduling only): pg_cron is not installed on ${DB_URL}, so ` +
      'kizunasync._schedule_jobs() has no cron.job to write. The extension exists only in the ' +
      'database named by cron.database_name, which a scratch database is not. The grammar cases ' +
      'and the no-cron case still run.',
  )
}

if (reachable && !cronCreatable) {
  console.warn(
    `[settings-schedules] SKIPPED (pg_cron install block): pg_cron can be created only in the database ` +
      `named by cron.database_name (${cronDatabase ?? 'unset'}), and ${DB_URL} is not it, so the pack's ` +
      'install block absorbs the refusal and _schedule_jobs() has no cron.job to write.',
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

class Rollback extends Error {}

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/cron-schedule-vectors.json'), 'utf8'),
) as { accepted: string[]; refused: string[] }

const ACCEPTED = vectors.accepted
const REFUSED = vectors.refused

const PACK_SQL = readFileSync(join(import.meta.dir, '../supabase/migrations/0001_kizuna_init.sql'), 'utf8')
const DEMO_SQL = readFileSync(join(import.meta.dir, '../supabase/demo/0001_public_demo_hardening.sql'), 'utf8')

/** Supabase's documented install, guarded so every refusal that means "no cron here" leaves the migration clean. */
const CRON_INSTALL_BLOCK = `do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception
  when undefined_file or feature_not_supported or insufficient_privilege
    or object_not_in_prerequisite_state or raise_exception then
    null;
end $$;`

/** The `do` block of `sql` that creates pg_cron, empty when there is none. */
function cronInstallBlock(sql: string): string {
  return sql.match(/do \$\$\nbegin\n {2}create extension if not exists pg_cron[\s\S]*?end \$\$;/)?.[0] ?? ''
}

describe.skipIf(!reachable)('kizunasync._is_cron_schedule', () => {
  test('accepts the five-field crontab shapes the pack schedules with', async () => {
    const results = await Promise.all(
      ACCEPTED.map(async (schedule) => {
        const [row] = await db!`select kizunasync._is_cron_schedule(${schedule}) as ok`

        return { schedule, ok: (row as { ok: boolean }).ok }
      }),
    )

    expect(results.filter((r) => !r.ok).map((r) => r.schedule)).toEqual([])
  })

  test('refuses names, seconds, macros and out-of-range fields', async () => {
    const results = await Promise.all(
      REFUSED.map(async (schedule) => {
        const [row] = await db!`select kizunasync._is_cron_schedule(${schedule}) as ok`

        return { schedule, ok: (row as { ok: boolean }).ok }
      }),
    )

    expect(results.filter((r) => r.ok).map((r) => r.schedule)).toEqual([])
  })

  test('a null schedule is not a schedule', async () => {
    const [row] = await db!`select kizunasync._is_cron_schedule(null) as ok`

    expect((row as { ok: boolean }).ok).toBe(false)
  })

  test('the check constraint refuses a malformed schedule write', async () => {
    let refused = false

    try {
      await db!.begin(async (tx) => {
        await tx`update kizunasync._settings set reap_schedule = '@midnight' where id`

        throw new Rollback()
      })
    } catch (error) {
      refused = !(error instanceof Rollback)
    }
    expect(refused).toBe(true)
  })
})

describe.skipIf(!reachable || !cronInstalled)('kizunasync._schedule_jobs', () => {
  test('schedules the three jobs from _settings and reports what it applied', async () => {
    let applied: { pg_cron: boolean; jobs: Record<string, string> } | undefined
    let scheduled: { jobname: string; schedule: string }[] = []

    try {
      await db!.begin(async (tx) => {
        await tx`
          update kizunasync._settings
             set reap_schedule = '11 2 * * *',
                 compact_schedule = '22 2 * * *',
                 client_prune_schedule = '33 2 * * *'
           where id`
        const [row] = await tx`select kizunasync._schedule_jobs() as applied`

        applied = (row as { applied: { pg_cron: boolean; jobs: Record<string, string> } }).applied
        scheduled = (await tx`
          select jobname, schedule from cron.job
           where jobname in ('kizunasync-reap-tombstones', 'kizunasync-compact-changelog', 'kizunasync-prune-clients')
           order by jobname`) as unknown as { jobname: string; schedule: string }[]

        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error
      }
    }
    expect(applied?.pg_cron).toBe(true)
    expect(applied?.jobs).toEqual({
      'kizunasync-compact-changelog': '22 2 * * *',
      'kizunasync-prune-clients': '33 2 * * *',
      'kizunasync-reap-tombstones': '11 2 * * *',
    })
    expect(scheduled).toEqual([
      { jobname: 'kizunasync-compact-changelog', schedule: '22 2 * * *' },
      { jobname: 'kizunasync-prune-clients', schedule: '33 2 * * *' },
      { jobname: 'kizunasync-reap-tombstones', schedule: '11 2 * * *' },
    ])
  })
})

describe('the pg_cron install block', () => {
  test('the pack creates the extension and grants nothing on the cron schema', () => {
    expect(cronInstallBlock(PACK_SQL)).toBe(CRON_INSTALL_BLOCK)
    expect(PACK_SQL).not.toMatch(/grant [^;]*schema cron/)
    expect(PACK_SQL).not.toMatch(/undefined_object/)
  })

  test('the demo hardening file runs the same block and grants nothing on the cron schema', () => {
    expect(cronInstallBlock(DEMO_SQL)).toBe(CRON_INSTALL_BLOCK)
    expect(DEMO_SQL).not.toMatch(/grant [^;]*schema cron/)
  })
})

describe.skipIf(!reachable || !cronCreatable)('the pg_cron install block on a database cron runs in', () => {
  test('_schedule_jobs() schedules the three jobs right after the block', async () => {
    let applied: { pg_cron: boolean } | undefined
    let jobs: string[] = []

    try {
      await db!.begin(async (tx) => {
        await tx.unsafe(cronInstallBlock(PACK_SQL))
        const [row] = await tx`select kizunasync._schedule_jobs() as applied`

        applied = (row as { applied: { pg_cron: boolean } }).applied
        jobs = ((await tx`
          select jobname from cron.job
           where jobname in ('kizunasync-reap-tombstones', 'kizunasync-compact-changelog', 'kizunasync-prune-clients')
           order by jobname`) as unknown as { jobname: string }[]).map((job) => job.jobname)

        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error
      }
    }
    expect(applied?.pg_cron).toBe(true)
    expect(jobs).toEqual(['kizunasync-compact-changelog', 'kizunasync-prune-clients', 'kizunasync-reap-tombstones'])
  })
})

describe.skipIf(!reachable || cronInstalled)('kizunasync._schedule_jobs without pg_cron', () => {
  test('reports the schedules it would apply and schedules nothing', async () => {
    const [row] = await db!`select kizunasync._schedule_jobs() as applied`
    const applied = (row as { applied: { pg_cron: boolean; jobs: Record<string, string> } }).applied

    expect(applied.pg_cron).toBe(false)
    expect(Object.keys(applied.jobs).sort()).toEqual([
      'kizunasync-compact-changelog',
      'kizunasync-prune-clients',
      'kizunasync-reap-tombstones',
    ])
  })
})

describe.skipIf(!reachable || !hasJobsStatus)('kizunasync.jobs_status', () => {
  interface IJobStatus {
    jobname: string
    schedule: string
    active: boolean
    last_start: Date | null
    last_status: string | null
    last_message: string | null
  }

  const read = async (): Promise<IJobStatus[]> => {
    const rows = await db!`select * from kizunasync.jobs_status()`

    return rows as unknown as IJobStatus[]
  }

  test.skipIf(!cronInstalled)('lists the three pack jobs with their settings schedules', async () => {
    const [settings] = await db!`
      select reap_schedule, compact_schedule, client_prune_schedule from kizunasync._settings`
    const expected = settings as {
      reap_schedule: string
      compact_schedule: string
      client_prune_schedule: string
    }
    const rows = await read()

    expect(rows.map((r) => r.jobname)).toEqual([
      'kizunasync-compact-changelog',
      'kizunasync-prune-clients',
      'kizunasync-reap-tombstones',
    ])
    expect(rows.map((r) => r.schedule)).toEqual([
      expected.compact_schedule,
      expected.client_prune_schedule,
      expected.reap_schedule,
    ])
    expect(rows.every((r) => r.active)).toBe(true)

    // A job that has not run yet reports its schedule with a null run, never a row that pretends it ran.
    for (const row of rows) {
      if (row.last_start === null) {
        expect(row.last_status).toBeNull()
        expect(row.last_message).toBeNull()
      } else {
        expect(typeof row.last_status).toBe('string')
      }
    }
  })

  test.skipIf(!cronInstalled)('never reports a job the pack did not schedule', async () => {
    const rows = await read()

    expect(rows.filter((r) => !r.jobname.startsWith('kizunasync-'))).toEqual([])
    expect(rows.some((r) => r.jobname === 'kizunasync-demo-reap-visitors')).toBe(false)
  })

  test.skipIf(cronInstalled)('returns no rows where pg_cron is absent', async () => {
    expect(await read()).toEqual([])
  })

  // Two layers refuse a client, and both matter. The EXECUTE grant stops a request that has already become `authenticated` or `anon`, and the in-body guard stops a caller that can execute but carries a client JWT. The operator passes both: it arrives as service_role with a service_role claim.
  const callAs = async (role: string | null, claimRole: string): Promise<string> => {
    try {
      await db!.begin(async (tx) => {
        const claims = JSON.stringify({ sub: crypto.randomUUID(), role: claimRole })

        await tx`select set_config('request.jwt.claims', ${claims}, true)`

        if (role !== null) {
          await tx.unsafe(`set local role ${role}`)
        }
        await tx`select * from kizunasync.jobs_status()`

        throw new Rollback()
      })

      return 'returned'
    } catch (error) {
      if (error instanceof Rollback) {
        return 'returned'
      }
      return error instanceof Error ? error.message : String(error)
    }
  }

  test('the service role reads it, the client roles are refused by the grant', async () => {
    expect(await callAs('service_role', 'service_role')).toBe('returned')
    expect(await callAs('authenticated', 'authenticated')).toContain('permission denied')
    expect(await callAs('anon', 'anon')).toContain('permission denied')
  })

  test('the guard admits a service_role claim and refuses every other one', async () => {
    expect(await callAs(null, 'service_role')).toBe('returned')
    expect(await callAs(null, 'authenticated')).toContain('not a client RPC')
    expect(await callAs(null, 'anon')).toContain('not a client RPC')
  })

  test('is not executable by anon or authenticated', async () => {
    const [row] = await db!`
      select
        has_function_privilege('service_role', p.oid, 'execute') as service_exec,
        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
        has_function_privilege('anon', p.oid, 'execute') as anon_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'kizunasync' and p.proname = 'jobs_status'`
    const grants = row as { service_exec: boolean; auth_exec: boolean; anon_exec: boolean }

    expect(grants.service_exec).toBe(true)
    expect(grants.auth_exec).toBe(false)
    expect(grants.anon_exec).toBe(false)
  })
})
