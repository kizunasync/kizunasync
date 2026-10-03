/**
 * The schema gate against real Postgres (D-schema-version-handshake). A request is
 * compared with the highest `min_schema_version` among the tables it names, or
 * with the highest across every configured table when it names none, so one
 * stale table gates the whole pull page or push batch. A null `schema_version` is
 * gated the same way. A pull or push answered with a signal registers no client.
 *
 * Every case runs in a rolled-back transaction. It pins the demo `todos` row to
 * minimum 1 with client registration on, and the gate cases add a second
 * configured table whose minimum is above it. Skips loudly (named reason) when no
 * DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const NEWER_TABLE = '_schema_gate_newer'
const NEWER_MINIMUM = 3
const UNCONFIGURED_TABLE = '_schema_gate_unconfigured'
const RESET_REQUIRED = { type: 'RESET_REQUIRED' }

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-schema-gate] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

class Rollback extends Error {}

// MARK: - Types

interface IPullPage {
  cursor: string
  signal: unknown
}

type TPushResponse = { signal?: unknown; verdicts?: unknown[] }

interface IPushRequest {
  tables: string[]
  schemaVersion: number | null
  clientId?: string
}

interface IPullRequest {
  tables: string[]
  schemaVersion: number | null
  cursor?: string
  clientId?: string
}

// MARK: - Helpers

/** Runs `body` in a transaction that always rolls back, returning what it captured. */
async function inRolledBackTxn<T>(body: (tx: SQL) => Promise<T>): Promise<T> {
  let captured: T | undefined

  try {
    await db!.begin(async (tx) => {
      captured = await body(tx as unknown as SQL)

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (captured === undefined) {
    throw new Error('the transaction captured no result')
  }
  return captured
}

/** The demo `todos` row at minimum 1, registering clients, whatever an earlier case left in the shared database. */
async function pinTodos(tx: SQL): Promise<void> {
  await tx`update kizunasync._config set min_schema_version = 1, register_clients = true where table_name = 'todos'`
}

/** A second configured table whose minimum is above the pinned `todos` row's. */
async function provisionNewerTable(tx: SQL): Promise<void> {
  await pinTodos(tx)
  await tx.unsafe(`
    create table public.${NEWER_TABLE} (id uuid primary key, user_id uuid not null default auth.uid(), title text);
    alter table public.${NEWER_TABLE} enable row level security;
    grant select, insert, update, delete on public.${NEWER_TABLE} to authenticated;
    create policy sg_own on public.${NEWER_TABLE} for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
  `)
  await tx`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
    values (${NEWER_TABLE}, 'read-write', null, ${NEWER_MINIMUM}, false)`
}

/** A fresh user, then the transaction's role and JWT switched to it. */
async function becomeNewUser(tx: SQL): Promise<string> {
  await tx`reset role`
  const [user] = await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id::text as id`
  const userId = user.id as string

  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`
  await tx`set local role authenticated`

  return userId
}

async function pull(tx: SQL, { tables, schemaVersion, cursor = '0', clientId }: IPullRequest): Promise<IPullPage> {
  const buckets = tables.map((table) => ({ table, params: {} }))
  const [row] = await tx`select kizunasync.pull(${buckets}::jsonb, ${cursor}, ${schemaVersion}::integer, 10, ${clientId ?? null}::uuid) as page`

  return row.page as IPullPage
}

/** One update per named table, each of a pk no row carries, so an ungated push answers every one RLS_DENIED and writes nothing. */
async function push(tx: SQL, { tables, schemaVersion, clientId }: IPushRequest): Promise<TPushResponse> {
  const mutations = tables.map((table) => ({ mutation_id: crypto.randomUUID(), table, pk: crypto.randomUUID(), op: 'update', columns: { title: 'gated' } }))
  const [row] = await tx`
    select kizunasync.push(${{ atomic: false, mutations }}::jsonb, null::uuid, ${schemaVersion}::integer, ${clientId ?? null}::uuid) as resp`

  return row.resp as TPushResponse
}

async function registrationsOf(tx: SQL, userId: string): Promise<number> {
  await tx`reset role`
  const [row] = await tx`select count(*)::int as n from kizunasync._clients where user_id = ${userId}::uuid`

  return row.n as number
}

// MARK: - The highest minimum gates the request

describe.skipIf(!reachable)('the schema gate compares with the highest minimum among the requested tables', () => {
  test('a pull naming two tables is gated by the higher minimum, and the lower table alone is not', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await provisionNewerTable(tx)
      await becomeNewUser(tx)

      return {
        both: await pull(tx, { tables: ['todos', NEWER_TABLE], schemaVersion: NEWER_MINIMUM - 1 }),
        bothCurrent: await pull(tx, { tables: ['todos', NEWER_TABLE], schemaVersion: NEWER_MINIMUM }),
        lowerAlone: await pull(tx, { tables: ['todos'], schemaVersion: NEWER_MINIMUM - 1 }),
      }
    })

    expect(result.both).toMatchObject({ cursor: '0', signal: RESET_REQUIRED })
    expect(result.bothCurrent.signal).toBeNull()
    expect(result.lowerAlone.signal).toBeNull()
  })

  test('a push naming two tables is gated by the higher minimum, and the lower table alone is not', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await provisionNewerTable(tx)
      await becomeNewUser(tx)

      return {
        both: await push(tx, { tables: ['todos', NEWER_TABLE], schemaVersion: NEWER_MINIMUM - 1 }),
        bothCurrent: await push(tx, { tables: ['todos', NEWER_TABLE], schemaVersion: NEWER_MINIMUM }),
        lowerAlone: await push(tx, { tables: ['todos'], schemaVersion: NEWER_MINIMUM - 1 }),
      }
    })

    expect(result.both).toEqual({ signal: RESET_REQUIRED })
    expect(result.bothCurrent.verdicts).toHaveLength(2)
    expect(result.lowerAlone.verdicts).toHaveLength(1)
  })

  test('a request naming no configured table is gated by the highest minimum across the config', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await provisionNewerTable(tx)
      await becomeNewUser(tx)

      return {
        pulled: await pull(tx, { tables: [UNCONFIGURED_TABLE], schemaVersion: NEWER_MINIMUM - 1 }),
        pulledCurrent: await pull(tx, { tables: [UNCONFIGURED_TABLE], schemaVersion: NEWER_MINIMUM }),
        pushed: await push(tx, { tables: [UNCONFIGURED_TABLE], schemaVersion: NEWER_MINIMUM - 1 }),
      }
    })

    expect(result.pulled.signal).toEqual(RESET_REQUIRED)
    expect(result.pulledCurrent.signal).toBeNull()
    expect(result.pushed).toEqual({ signal: RESET_REQUIRED })
  })
})

// MARK: - A null schema_version

describe.skipIf(!reachable)('a null schema_version answers RESET_REQUIRED', () => {
  test('on pull and on push, before any mutation runs', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await provisionNewerTable(tx)
      await becomeNewUser(tx)

      return {
        pulled: await pull(tx, { tables: ['todos'], schemaVersion: null }),
        pushed: await push(tx, { tables: ['todos'], schemaVersion: null }),
      }
    })

    expect(result.pulled).toMatchObject({ cursor: '0', signal: RESET_REQUIRED })
    expect(result.pushed).toEqual({ signal: RESET_REQUIRED })
  })
})

// MARK: - No registration on a signal

describe.skipIf(!reachable)('a response that carries a signal registers no client', () => {
  test('a stale pull and a stale push leave the registry untouched', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await pinTodos(tx)
      const userId = await becomeNewUser(tx)
      const clientId = crypto.randomUUID()
      const pulled = await pull(tx, { tables: ['todos'], schemaVersion: 0, clientId })
      const pushed = await push(tx, { tables: ['todos'], schemaVersion: 0, clientId })

      return { pulled, pushed, registrations: await registrationsOf(tx, userId) }
    })

    expect(result.pulled.signal).toEqual(RESET_REQUIRED)
    expect(result.pushed).toEqual({ signal: RESET_REQUIRED })
    expect(result.registrations).toBe(0)
  })

  test('an expired checkpoint leaves the registry untouched, and a page without a signal registers', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await pinTodos(tx)
      await tx`update kizunasync._reap_state set reaped_seq = reaped_seq + 1000000 where id`
      const expiredUser = await becomeNewUser(tx)
      const expired = await pull(tx, { tables: ['todos'], schemaVersion: 1, cursor: '1', clientId: crypto.randomUUID() })
      const expiredRegistrations = await registrationsOf(tx, expiredUser)
      const liveUser = await becomeNewUser(tx)

      await pull(tx, { tables: ['todos'], schemaVersion: 1, clientId: crypto.randomUUID() })

      return { expired, expiredRegistrations, liveRegistrations: await registrationsOf(tx, liveUser) }
    })

    expect(result.expired.signal).toEqual({ type: 'CHECKPOINT_EXPIRED' })
    expect(result.expiredRegistrations).toBe(0)
    expect(result.liveRegistrations).toBe(1)
  })
})
