/**
 * Adversarial privilege tests against the real Postgres.
 *
 * An authenticated client must not be able to:
 *   - INSERT into _changelog / _tombstones (forge tombstones / pollute seq)
 *   - SELECT bookkeeping tables (_changelog, _tombstones, _config, _clients, _provisions, …): privacy
 *   - SELECT or DML on _verdicts / _row_hlc / _conflict_journal (forged replay / HLC poison / loser-value forge)
 *   - SELECT or DML on _bucket_grants (a forged grant would unlock another bucket value's deleted pks)
 *   - EXECUTE internal helpers (no grant; GUC is defense-in-depth only)
 *   - Call reap_tombstones / compact_changelog / prune_clients / _schedule_jobs / jobs_status
 *
 * It must still be able to call pull/push and attachment_*. The maintenance
 * functions run under a service_role JWT and refuse every other claim set, and
 * the owner role keeps no CREATE on the schema. Skips when no DB.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const PACK_SQL = readFileSync(join(import.meta.dir, '../supabase/migrations/0001_kizuna_init.sql'), 'utf8')

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-privilege-lockdown] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

class Rollback extends Error {}

const claims = (sub: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ sub, role: 'authenticated', ...extra })

const become = async (tx: SQL, sub: string, extra: Record<string, unknown> = {}): Promise<void> => {
  await tx`reset role`
  await tx`select set_config('request.jwt.claims', ${claims(sub, extra)}, true)`
  await tx`set local role authenticated`
}

async function asAuthenticated(
  conn: SQL,
  body: (tx: SQL, uid: string) => Promise<void>,
): Promise<void> {
  try {
    await conn.begin(async (tx) => {
      const [user] =
        await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`

      await body(tx as unknown as SQL, user.id as string)

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
}

const isDenied = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)

  return (
    message.includes('42501') ||
    message.includes('permission denied') ||
    message.includes('not callable outside pull/push') ||
    message.includes('not a client RPC')
  )
}

describe.skipIf(!reachable)('authenticated cannot write change-capture tables', () => {
  test('authenticated holds exactly SELECT on attachments', async () => {
    const rows = await db!`
      select privilege_type
      from information_schema.role_table_grants
      where grantee = 'authenticated'
        and table_schema = 'kizunasync'
        and table_name = 'attachments'
      order by privilege_type`

    expect(rows.map((row) => (row as { privilege_type: string }).privilege_type)).toEqual(['SELECT'])
  })

  test('service_role reads _bucket_grants, and no client role holds any privilege on it', async () => {
    const [row] = await db!`
      select
        has_table_privilege('service_role', 'kizunasync._bucket_grants', 'SELECT') as service_select,
        has_table_privilege('authenticated', 'kizunasync._bucket_grants', 'SELECT, INSERT, UPDATE, DELETE') as auth_any,
        has_table_privilege('anon', 'kizunasync._bucket_grants', 'SELECT, INSERT, UPDATE, DELETE') as anon_any`

    expect(row).toEqual({ service_select: true, auth_any: false, anon_any: false })
  })

  test('INSERT into attachments is denied', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`
          insert into kizunasync.attachments (id, bucket_id, object_path, created_by)
          values (gen_random_uuid(), 'attachments', ${`${uid}/x.bin`}, ${uid}::uuid)`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('INSERT into _changelog is denied', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`
          insert into kizunasync._changelog (table_name, pk, op)
          values ('todos', gen_random_uuid(), 'upsert')`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('INSERT into _tombstones is denied', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`
          insert into kizunasync._tombstones (table_name, pk)
          values ('todos', gen_random_uuid())`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('INSERT into _verdicts is denied', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`
          insert into kizunasync._verdicts (mutation_id, verdict)
          values (gen_random_uuid(), '{"verdict":"applied"}'::jsonb)`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('SELECT on _verdicts is denied', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`select * from kizunasync._verdicts limit 1`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('DML on _row_hlc is denied', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`
          insert into kizunasync._row_hlc (table_name, pk, column_hlc)
          values ('todos', gen_random_uuid(), '{}'::jsonb)`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('SELECT on _row_hlc is denied', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`select * from kizunasync._row_hlc limit 1`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('INSERT into _conflict_journal is denied', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`
          insert into kizunasync._conflict_journal (
            table_name, pk, column_name, loser_value, winner_mutation_id, conflict_mode
          ) values (
            'todos', gen_random_uuid(), 'title', '"lost"'::jsonb, gen_random_uuid(), 'arrival'
          )`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  for (const table of [
    '_changelog',
    '_tombstones',
    '_config',
    '_settings',
    '_reap_state',
    '_conflict_journal',
    '_clients',
    '_provisions',
    '_bucket_grants',
  ] as const) {
    test(`SELECT on ${table} is denied`, async () => {
      let denied = false

      await asAuthenticated(db!, async (tx, uid) => {
        await become(tx, uid)

        try {
          await tx.unsafe(`select * from kizunasync.${table} limit 1`)
        } catch (error) {
          denied = isDenied(error)
        }
      })
      expect(denied).toBe(true)
    })
  }
})

describe.skipIf(!reachable)('internals are not executable by authenticated', () => {
  const internals: Array<{ name: string; call: (tx: SQL) => Promise<unknown> }> = [
    // The kizunasync_rls-owned user-row helpers: authenticated reaches them only through kizunasync.pull/push, never directly. A direct call must fail on missing EXECUTE (the RLS-enforcing owner never widens the RPC surface).
    {
      name: '_render_user_row',
      call: (tx) =>
        tx`select kizunasync._render_user_row('todos', gen_random_uuid())`,
    },
    {
      name: '_render_user_row_projected',
      call: (tx) =>
        tx`select kizunasync._render_user_row_projected('todos', gen_random_uuid(), array['id', 'title'])`,
    },
    {
      name: '_lock_user_row',
      call: (tx) =>
        tx`select kizunasync._lock_user_row('todos', gen_random_uuid())`,
    },
    {
      name: '_apply_upsert',
      call: (tx) =>
        tx`select kizunasync._apply_upsert('todos', gen_random_uuid(), '{}'::jsonb)`,
    },
    {
      name: '_apply_update_masked',
      call: (tx) =>
        tx`select kizunasync._apply_update_masked('todos', gen_random_uuid(), '{}'::jsonb)`,
    },
    {
      name: '_apply_delete',
      call: (tx) =>
        tx`select kizunasync._apply_delete('todos', gen_random_uuid(), null::jsonb)`,
    },
    {
      name: '_apply_increment',
      call: (tx) =>
        tx`select kizunasync._apply_increment('todos', gen_random_uuid(), 'likes', 1)`,
    },
    {
      name: '_apply_array_union',
      call: (tx) =>
        tx`select kizunasync._apply_array_union('todos', gen_random_uuid(), 'labels', '["a"]'::jsonb)`,
    },
    {
      name: '_apply_array_remove',
      call: (tx) =>
        tx`select kizunasync._apply_array_remove('todos', gen_random_uuid(), 'labels', '["a"]'::jsonb)`,
    },
    {
      name: '_apply_transforms',
      call: (tx) =>
        tx`select kizunasync._apply_transforms('todos', gen_random_uuid(), '{}'::jsonb)`,
    },
    {
      name: '_conflicts_for_page',
      call: (tx) => tx`select kizunasync._conflicts_for_page('[]'::jsonb)`,
    },
    // The column-privilege helpers answer for the CALLER's role, so a direct call would let a client enumerate another table's ACL through the pack. _readable_columns is granted to kizunasync_rls alone, which `authenticated` is not a member of.
    {
      name: '_caller_role',
      call: (tx) => tx`select kizunasync._caller_role()`,
    },
    {
      name: '_readable_columns',
      call: (tx) => tx`select kizunasync._readable_columns('todos')`,
    },
    {
      name: '_writable_columns',
      call: (tx) => tx`select kizunasync._writable_columns('todos', 'UPDATE')`,
    },
    // Granted to kizunasync_rls alone, for _apply_delete's precondition; `authenticated` holds no EXECUTE on it.
    {
      name: '_normalize_cell',
      call: (tx) => tx`select kizunasync._normalize_cell('todos', 'title', '"x"'::jsonb)`,
    },
    {
      name: '_pull_envelope',
      call: (tx) =>
        tx`select kizunasync._pull_envelope('0', false, '[]'::jsonb, '[]'::jsonb)`,
    },
    {
      name: '_record_verdict',
      call: (tx) =>
        tx`select kizunasync._record_verdict(gen_random_uuid(), 'todos', gen_random_uuid(), '{"verdict":"applied"}'::jsonb)`,
    },
    {
      name: '_record_bucket_grants',
      call: (tx) => tx`select kizunasync._record_bucket_grants(array['todos'], array[''])`,
    },
    // Provisioning calls these from a migration, never pull or push, so they carry the maintenance functions' JWT refusal instead of the rpc gate.
    {
      name: '_seed_changelog',
      call: (tx) => tx`select kizunasync._seed_changelog('todos')`,
    },
    {
      name: '_relabel_changelog',
      call: (tx) => tx`select kizunasync._relabel_changelog('todos')`,
    },
    {
      name: '_journal_overwrites',
      call: (tx) =>
        tx`select kizunasync._journal_overwrites(
          'todos', gen_random_uuid(), gen_random_uuid(), '{"title":"n"}'::jsonb, '{"title":"o"}'::jsonb, 'arrival'
        )`,
    },
    {
      name: '_lookup_verdict',
      call: (tx) => tx`select kizunasync._lookup_verdict(gen_random_uuid())`,
    },
    {
      name: '_row_hlc_lock',
      call: (tx) => tx`select kizunasync._row_hlc_lock('todos', gen_random_uuid())`,
    },
    {
      name: '_pull_gate',
      call: (tx) => tx`select kizunasync._pull_gate('[]'::jsonb, '0', 1)`,
    },
    {
      name: '_pull_horizon',
      call: (tx) => tx`select kizunasync._pull_horizon(0, pg_current_snapshot())`,
    },
    {
      name: '_pull_candidates',
      call: (tx) =>
        tx`select * from kizunasync._pull_candidates(
          p_buckets => '[]'::jsonb, p_bucket_tables => array[]::text[], p_snap => pg_current_snapshot(),
          p_cursor => '0', p_new_high_water => 0
        )`,
    },
    {
      name: '_pull_page',
      call: (tx) =>
        tx`select kizunasync._pull_page(
          p_buckets => '[]'::jsonb, p_bucket_tables => array[]::text[], p_snap => pg_current_snapshot(),
          p_cursor => '0', p_new_high_water => 0, p_limit => 10
        )`,
    },
    {
      name: '_pull_impl',
      call: (tx) => tx`select kizunasync._pull_impl('[]'::jsonb, '0', 1, 10)`,
    },
    {
      name: '_push_guard',
      call: (tx) =>
        tx`select kizunasync._push_guard('{"atomic":false,"mutations":[]}'::jsonb, 1)`,
    },
    {
      name: '_push_impl',
      call: (tx) =>
        tx`select kizunasync._push_impl('{"atomic":false,"mutations":[]}'::jsonb, null, 1)`,
    },
  ]

  for (const internal of internals) {
    test(`direct ${internal.name} has no EXECUTE (or fails GUC)`, async () => {
      let denied = false

      await asAuthenticated(db!, async (tx, uid) => {
        await become(tx, uid, { session_id: crypto.randomUUID() })

        try {
          await internal.call(tx)
        } catch (error) {
          denied = isDenied(error)
        }
      })
      expect(denied).toBe(true)
    })
  }

  test('reap_tombstones is not executable by authenticated', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`select kizunasync.reap_tombstones()`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('prune_clients is not executable by authenticated', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`select kizunasync.prune_clients()`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('jobs_status is not executable by authenticated', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`select * from kizunasync.jobs_status()`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  test('_schedule_jobs is not executable by authenticated', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid)

      try {
        await tx`select kizunasync._schedule_jobs()`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })

  // The operator surface: `kizunasync jobs` runs maintenance on a service connection, so service_role holds EXECUTE on the four maintenance functions and no client role holds any of them.
  test('service_role holds execute on the maintenance functions, authenticated holds none', async () => {
    const rows = await db!`
      select
        p.proname as name,
        has_function_privilege('service_role', p.oid, 'execute') as service_exec,
        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
        has_function_privilege('anon', p.oid, 'execute') as anon_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'kizunasync'
        and p.proname in ('reap_tombstones', 'compact_changelog', 'prune_clients', '_schedule_jobs', 'jobs_status')
      order by p.proname`
    const audited = rows as unknown as {
      name: string
      service_exec: boolean
      auth_exec: boolean
      anon_exec: boolean
    }[]

    expect(audited.map((r) => r.name)).toEqual([
      '_schedule_jobs',
      'compact_changelog',
      'jobs_status',
      'prune_clients',
      'reap_tombstones',
    ])
    expect(audited.filter((r) => !r.service_exec).map((r) => r.name)).toEqual([])
    expect(audited.filter((r) => r.auth_exec || r.anon_exec).map((r) => r.name)).toEqual([])
  })

  test('setting the rpc GUC alone does not unlock _apply_upsert', async () => {
    let denied = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid, { session_id: crypto.randomUUID() })
      await tx`select set_config('kizunasync.rpc', '1', true)`

      try {
        await tx`select kizunasync._apply_upsert('todos', gen_random_uuid(), '{}'::jsonb)`
      } catch (error) {
        denied = isDenied(error)
      }
    })
    expect(denied).toBe(true)
  })
})

describe.skipIf(!reachable)('authenticated can use public RPCs', () => {
  test('pull is callable as authenticated (empty buckets)', async () => {
    let ok = false

    await asAuthenticated(db!, async (tx, uid) => {
      await become(tx, uid, { session_id: crypto.randomUUID() })
      const [row] = await tx`
        select kizunasync.pull('[]'::jsonb, '0', 1, 10) as page`

      ok = row?.page !== undefined && row?.page !== null
    })
    expect(ok).toBe(true)
  })

  // No default-ACL mechanism protects a freshly created function: PostgreSQL's per-schema default privileges can only ADD to the built-in PUBLIC-execute default, never subtract it (see 0001_kizuna_init.sql's Grants section). One blanket revoke at migration time locks every function, with EXECUTE granted back to the five public RPCs alone, so a migration that adds one without its own explicit `revoke execute ... from public` fails this audit.
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

describe('the owner role gets CREATE on the schema only around the ownership transfers', () => {
  test('0001 grants CREATE before the first transfer and revokes it after the last, so a re-run transfers again', () => {
    const grant = PACK_SQL.indexOf('grant create on schema kizunasync to kizunasync_rls;')
    const revoke = PACK_SQL.indexOf('revoke create on schema kizunasync from kizunasync_rls;')
    const transfers = [...PACK_SQL.matchAll(/owner to kizunasync_rls;/g)].map((match) => match.index ?? -1)

    expect(transfers.length).toBeGreaterThan(0)
    expect(grant).toBeGreaterThanOrEqual(0)
    expect(grant).toBeLessThan(Math.min(...transfers))
    expect(revoke).toBeGreaterThan(Math.max(...transfers))
  })
})

describe.skipIf(!reachable)('the owner role on an installed pack', () => {
  test('kizunasync_rls holds no CREATE on the kizunasync schema', async () => {
    const [row] = await db!`select has_schema_privilege('kizunasync_rls', 'kizunasync', 'CREATE') as can_create`

    expect((row as { can_create: boolean }).can_create).toBe(false)
  })
})

// MARK: - Maintenance guard

const MAINTENANCE = ['reap_tombstones', 'compact_changelog', 'prune_clients', '_schedule_jobs'] as const

/** Calls `kizunasync.<name>()` under a JWT whose role claim is `claimRole`, as `role` when one is named, in a rolled-back transaction: 'returned', or the error message. */
async function callMaintenanceAs(name: string, role: string | null, claimRole: string): Promise<string> {
  try {
    await db!.begin(async (tx) => {
      const jwt = JSON.stringify({ sub: crypto.randomUUID(), role: claimRole })

      await tx`select set_config('request.jwt.claims', ${jwt}, true)`

      if (role !== null) {
        await tx.unsafe(`set local role ${role}`)
      }
      await tx.unsafe(`select kizunasync.${name}()`)

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

describe.skipIf(!reachable)('the maintenance functions admit a service_role JWT alone', () => {
  for (const name of MAINTENANCE) {
    test(`${name} runs under a service_role claim, on the service role and on the migration role`, async () => {
      expect(await callMaintenanceAs(name, 'service_role', 'service_role')).toBe('returned')
      expect(await callMaintenanceAs(name, null, 'service_role')).toBe('returned')
    })

    test(`${name} refuses an authenticated or anon claim`, async () => {
      expect(await callMaintenanceAs(name, null, 'authenticated')).toContain('not a client RPC')
      expect(await callMaintenanceAs(name, null, 'anon')).toContain('not a client RPC')
    })
  }
})
