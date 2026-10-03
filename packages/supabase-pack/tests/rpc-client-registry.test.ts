/**
 * The client registry against real Postgres: which identity a pull or push
 * registers under, what the push watermark records, that one user cannot take
 * over another's row, and that a user keeps at most 100 registrations.
 *
 * The registry is opt-in per table (_config.register_clients), which the demo's
 * todos row sets. Every case runs in a rolled-back transaction under a real JWT
 * and the authenticated role. Skips loudly with a named reason when no database is
 * reachable.
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
    `[rpc-client-registry] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

class Rollback extends Error {}

const claims = (sub: string, sessionId: string): string =>
  JSON.stringify({ sub, role: 'authenticated', session_id: sessionId })

const become = async (tx: SQL, sub: string, sessionId: string): Promise<void> => {
  await tx`reset role`
  await tx`select set_config('request.jwt.claims', ${claims(sub, sessionId)}, true)`
  await tx`set local role authenticated`
}

/**
 * No `session_id` key at all, not a null one: the JWT that D-client-identity says a request
 * client_id needs no session match against.
 */
const claimsWithoutSession = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })

const becomeWithoutSession = async (tx: SQL, sub: string): Promise<void> => {
  await tx`reset role`
  await tx`select set_config('request.jwt.claims', ${claimsWithoutSession(sub)}, true)`
  await tx`set local role authenticated`
}

const BUCKETS = [{ table: 'todos', params: {} }]

/** The registrations `_register_client` keeps per user. */
const MAX_REGISTRATIONS = 100

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

async function newUser(tx: SQL): Promise<string> {
  const [user] =
    await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`

  return (user as { id: string }).id
}

describe.skipIf(!reachable)('client identity on pull and push', () => {
  test('pull registers under the request client_id, not the session', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)
      const session = crypto.randomUUID()
      const clientId = crypto.randomUUID()

      await become(tx, user, session)
      await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10, ${clientId}::uuid)`
      await tx`reset role`
      const [rows] = await tx`
        select
          count(*) filter (where client_id::text = ${clientId}) as by_client,
          count(*) filter (where client_id::text = ${session}) as by_session
        from kizunasync._clients where user_id = ${user}::uuid`

      return rows as { by_client: string; by_session: string }
    })

    expect(Number(result.by_client)).toBe(1)
    expect(Number(result.by_session)).toBe(0)
  })

  test('pull without a client_id registers under the JWT session id', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)
      const session = crypto.randomUUID()

      await become(tx, user, session)
      const [page] = await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10) as page`

      await tx`reset role`
      const [rows] = await tx`
        select client_id::text as client_id, cursor
        from kizunasync._clients where user_id = ${user}::uuid`

      return {
        ...(rows as { client_id: string; cursor: string }),
        session,
        pageCursor: String((page as { page: { cursor: string } }).page.cursor),
      }
    })

    expect(result.client_id).toBe(result.session)
    expect(result.cursor).toBe(result.pageCursor)
  })

  test('push records the last mutation the server accepted, not the requested one', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)
      const session = crypto.randomUUID()
      const clientId = crypto.randomUUID()
      const [todo] = await tx`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${user}::uuid, 'first', false)
        returning id`
      const pk = (todo as { id: string }).id
      const appliedId = crypto.randomUUID()
      const rejectedId = crypto.randomUUID()
      const claimedId = crypto.randomUUID()
      const batch = {
        atomic: false,
        mutations: [
          { mutation_id: appliedId, table: 'todos', pk, op: 'update', columns: { title: 'accepted' } },
          {
            mutation_id: rejectedId,
            table: 'todos',
            pk,
            op: 'update',
            columns: { title: 'refused' },
            precondition: { title: 'never-was-this' },
          },
        ],
      }

      await become(tx, user, session)
      const [row] = await tx`
        select kizunasync.push(${batch}::jsonb, ${claimedId}::uuid, 1, ${clientId}::uuid) as resp`

      await tx`reset role`
      const [registered] = await tx`
        select last_mutation_id::text as last_mutation_id
        from kizunasync._clients where client_id = ${clientId}::uuid`

      return {
        verdicts: (row as { resp: { verdicts: { verdict: string }[] } }).resp.verdicts,
        recorded: (registered as { last_mutation_id: string }).last_mutation_id,
        appliedId,
        rejectedId,
        claimedId,
      }
    })

    expect(result.verdicts.map((v) => v.verdict)).toEqual(['applied', 'rejected'])
    expect(result.recorded).toBe(result.appliedId)
    expect(result.recorded).not.toBe(result.claimedId)
  })

  test('a client_id registered to another user is refused, not silently rewritten', async () => {
    const failure = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const attacker = await newUser(tx)
      const clientId = crypto.randomUUID()

      await become(tx, owner, crypto.randomUUID())
      await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10, ${clientId}::uuid)`
      await become(tx, attacker, crypto.randomUUID())

      try {
        await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10, ${clientId}::uuid)`

        return 'the takeover succeeded'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })

    expect(failure).toContain('registered to another user')
  })

  test('pull registers under a request client_id even when the JWT carries no session_id', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)
      const clientId = crypto.randomUUID()

      await becomeWithoutSession(tx, user)
      await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10, ${clientId}::uuid)`
      await tx`reset role`
      const [rows] = await tx`
        select count(*) as registered
        from kizunasync._clients where client_id = ${clientId}::uuid and user_id = ${user}::uuid`

      return rows as { registered: string }
    })

    expect(Number(result.registered)).toBe(1)
  })

  test('push registers under a request client_id even when the JWT carries no session_id', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)
      const clientId = crypto.randomUUID()
      const [todo] = await tx`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${user}::uuid, 'first', false)
        returning id`
      const pk = (todo as { id: string }).id
      const batch = {
        atomic: false,
        mutations: [
          { mutation_id: crypto.randomUUID(), table: 'todos', pk, op: 'update', columns: { title: 'updated' } },
        ],
      }

      await becomeWithoutSession(tx, user)
      await tx`select kizunasync.push(${batch}::jsonb, ${crypto.randomUUID()}::uuid, 1, ${clientId}::uuid)`
      await tx`reset role`
      const [rows] = await tx`
        select count(*) as registered
        from kizunasync._clients where client_id = ${clientId}::uuid and user_id = ${user}::uuid`

      return rows as { registered: string }
    })

    expect(Number(result.registered)).toBe(1)
  })

  test('a user keeps at most 100 registrations, and the least recently seen goes first', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)
      const bystander = await newUser(tx)
      const clientId = crypto.randomUUID()

      await tx`
        insert into kizunasync._clients (client_id, user_id, last_seen)
        select gen_random_uuid(), ${user}::uuid, now() - make_interval(mins => n)
        from generate_series(1, ${MAX_REGISTRATIONS}) as n`
      await tx`
        insert into kizunasync._clients (client_id, user_id, last_seen)
        values (gen_random_uuid(), ${bystander}::uuid, now() - make_interval(days => 1))`
      const [oldest] = await tx`
        select client_id::text as client_id from kizunasync._clients
        where user_id = ${user}::uuid order by last_seen limit 1`

      await become(tx, user, crypto.randomUUID())
      await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10, ${clientId}::uuid)`
      await tx`reset role`
      const [rows] = await tx`
        select
          count(*) filter (where user_id = ${user}::uuid) as registered,
          count(*) filter (where client_id::text = ${clientId}) as fresh,
          count(*) filter (where client_id::text = ${(oldest as { client_id: string }).client_id}) as oldest,
          count(*) filter (where user_id = ${bystander}::uuid) as bystander
        from kizunasync._clients`

      return rows as { registered: string; fresh: string; oldest: string; bystander: string }
    })

    expect(Number(result.registered)).toBe(MAX_REGISTRATIONS)
    expect(Number(result.fresh)).toBe(1)
    expect(Number(result.oldest)).toBe(0)
    expect(Number(result.bystander)).toBe(1)
  })

  test('a known client registering again at the cap evicts nobody', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)

      await tx`
        insert into kizunasync._clients (client_id, user_id, last_seen)
        select gen_random_uuid(), ${user}::uuid, now() - make_interval(mins => n)
        from generate_series(1, ${MAX_REGISTRATIONS}) as n`
      const [oldest] = await tx`
        select client_id::text as client_id from kizunasync._clients
        where user_id = ${user}::uuid order by last_seen limit 1`
      const known = (oldest as { client_id: string }).client_id

      await become(tx, user, crypto.randomUUID())
      await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10, ${known}::uuid)`
      await tx`reset role`
      const [rows] = await tx`
        select count(*) as registered, count(*) filter (where client_id::text = ${known}) as known
        from kizunasync._clients where user_id = ${user}::uuid`

      return rows as { registered: string; known: string }
    })

    expect(Number(result.registered)).toBe(MAX_REGISTRATIONS)
    expect(Number(result.known)).toBe(1)
  })

  test('without a client_id, a JWT with no session_id registers nobody', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)

      await becomeWithoutSession(tx, user)
      await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10)`
      await tx`reset role`
      const [rows] = await tx`
        select count(*) as registered from kizunasync._clients where user_id = ${user}::uuid`

      return rows as { registered: string }
    })

    expect(Number(result.registered)).toBe(0)
  })
})
