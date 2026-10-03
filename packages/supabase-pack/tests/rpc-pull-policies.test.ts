/**
 * kizunasync.pull server-side pull policy from 0001_kizuna_init.sql against real
 * Postgres. One FAIL-LOUD guard, declared by the integrator the way the push
 * policies are (NOT protocol, NOT modeled by the oracle/corpus):
 *
 *   Unscoped pull of a bucketed table: a table provisioned with
 *       kizunasync._config.bucket_column must be pulled with a bucket that
 *       names that column, or the request raises KZL01. Tombstones carry only
 *       the stored bucket snapshot and never replay RLS, so an unscoped pull
 *       could not receive deletes without leaking every deleted pk.
 *   Pull named by the bucket column: the same table pulled with a bucket that
 *       names the column is accepted.
 *   Unbucketed todos: an unbucketed table (the shipped todos fixture) is pulled
 *       with an empty bucket: reads stay cross-account under RLS and its
 *       tombstones are table-scoped.
 *
 * The first two sections flip todos to bucketed INSIDE a rolled-back txn: the
 * pull in the SAME txn sees the restrictive config, and rollback restores the
 * shipped unbucketed row the concurrent conformance harness and the demo apps
 * depend on.
 * Skips loudly (named reason) when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const BUCKET_COLUMN = 'user_id'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-pull-policies] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

/**
 * Rollback sentinel: thrown to abort db.begin() so the txn never commits and the
 * per-test _config edit is reverted, restoring the shipped unbucketed todos row.
 */
class Rollback extends Error {}

type TPullResp = {
  cursor: string
  has_more: boolean
  rows: unknown[]
  signal: unknown
  tombstones: unknown[]
}

type TRefusal = { rejected: boolean; message: string; sqlstate: string | null }

/** Bun's SQL client carries the Postgres SQLSTATE on `errno`; `code` is its own transport tag. */
function sqlstateOf(error: unknown): string | null {
  if (!(error instanceof Error) || !('errno' in error)) {
    return null
  }
  const { errno } = error

  return typeof errno === 'string' ? errno : null
}

/**
 * Run `fn` inside a rolled-back txn. `tx` starts as the superuser owner so the
 * body can edit _config; flip to a fresh authenticated user with `becomeCaller`
 * right before the pull so the RLS-owned read helpers see a real caller.
 */
async function inTxn<T>(
  conn: SQL,
  fn: (tx: SQL, callerId: string, becomeCaller: () => Promise<void>) => Promise<T>,
): Promise<T> {
  let out: T | undefined

  try {
    await conn.begin(async (tx) => {
      const [actor] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const becomeCaller = async () => {
        const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' })

        await tx`select set_config('request.jwt.claims', ${claims}, true)`
        await tx`set local role authenticated`
      }
      out = await fn(tx as unknown as SQL, actor.id, becomeCaller)

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (out === undefined) {
    throw new Error('inTxn: no result captured')
  }
  return out
}

async function pullOrRefusal(tx: SQL, params: Record<string, string>): Promise<TRefusal | TPullResp> {
  const buckets = [{ table: 'todos', params }]

  try {
    const [row] = await tx<{ resp: TPullResp }[]>`
      select kizunasync.pull(${buckets}::jsonb, '0', 1, 500) as resp`

    return row.resp
  } catch (error) {
    return {
      rejected: true,
      message: error instanceof Error ? error.message : String(error),
      sqlstate: sqlstateOf(error),
    }
  }
}

function asRefusal(out: TRefusal | TPullResp): TRefusal {
  if (!('rejected' in out)) {
    throw new Error(`expected a refusal, got a page: ${JSON.stringify(out)}`)
  }
  return out
}

function asPage(out: TRefusal | TPullResp): TPullResp {
  if ('rejected' in out) {
    throw new Error(`expected a page, got a refusal: ${out.message}`)
  }
  return out
}

describe.skipIf(!reachable)('kizunasync.pull server-side pull policy', () => {
  // MARK: - Unscoped pull of a bucketed table

  test('a bucketed table pulled with empty params raises KZL01 naming the table and column', async () => {
    const out = await inTxn(db!, async (tx, _callerId, becomeCaller) => {
      await tx`update kizunasync._config set bucket_column = ${BUCKET_COLUMN} where table_name = 'todos'`
      await becomeCaller()

      return pullOrRefusal(tx, {})
    })
    const refusal = asRefusal(out)

    expect(refusal.sqlstate).toBe('KZL01')
    expect(refusal.message).toContain('"todos"')
    expect(refusal.message).toContain(`"${BUCKET_COLUMN}"`)
    expect(refusal.message).toContain('the pull bucket must name that column')
  })

  // MARK: - Pull named by the bucket column

  test('the same bucketed table pulled with its bucket column succeeds', async () => {
    const out = await inTxn(db!, async (tx, callerId, becomeCaller) => {
      await tx`update kizunasync._config set bucket_column = ${BUCKET_COLUMN} where table_name = 'todos'`
      await becomeCaller()

      return pullOrRefusal(tx, { [BUCKET_COLUMN]: callerId })
    })
    const page = asPage(out)

    expect(page.signal).toBeNull()
    expect(Array.isArray(page.rows)).toBe(true)
  })

  // MARK: - Unbucketed todos

  test('an unbucketed table pulled with empty params succeeds', async () => {
    const out = await inTxn(db!, async (tx, _callerId, becomeCaller) => {
      const [config] = await tx<{ bucket_column: string | null }[]>`
        select bucket_column from kizunasync._config where table_name = 'todos'`

      expect(config.bucket_column).toBeNull()
      await becomeCaller()

      return pullOrRefusal(tx, {})
    })
    const page = asPage(out)

    expect(page.signal).toBeNull()
    expect(Array.isArray(page.rows)).toBe(true)
  })
})
