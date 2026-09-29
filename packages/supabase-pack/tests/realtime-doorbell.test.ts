/**
 * The realtime doorbell against real Postgres: the layer the corpus can't reach.
 *
 * 0001_kizuna_init.sql enables RLS on realtime.messages with a SELECT policy
 * (receive only). The SECURITY DEFINER trackers emit via realtime.send; they do
 * not need an INSERT policy for `authenticated`. A transaction rings each
 * table's topic once however many of its rows it writes, and kizunasync:clients
 * once however many registrations it writes. Each case rolls back, so the DB is
 * untouched. Skips loudly (named reason) when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

// Probe connectivity once up front so the skip is a loud, named reason.
let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[realtime-doorbell] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

/** Thrown to abort `db.begin()` so the transaction never commits. */
// MARK: - Rollback sentinel
class Rollback extends Error {}

/**
 * Update a todo the actor owns, as that actor under a real JWT and the
 * authenticated role (so the tracker's realtime.send runs under RLS), then return
 * how many NEW kizunasync:todos doorbells landed (after − before). The delta, not the
 * absolute count, is the verdict: realtime.messages may already hold committed
 * doorbells from earlier writes, so a raw count gives a false pass. All in a
 * rolled-back txn.
 */
async function ringDeltaAfterOwnUpdate(conn: SQL): Promise<number> {
  let delta: number | undefined

  try {
    await conn.begin(async (tx) => {
      const [actor] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`

      // The fixture insert skips the capture triggers, so the update below is the first write of this transaction to ring kizunasync:todos.
      await tx`set local session_replication_role = replica`
      const [todo] = await tx`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${actor.id}, 'doorbell row', false)
        returning id`

      await tx`set local session_replication_role = origin`
      const doorbells = tx`
        select count(*)::int as n
        from realtime.messages
        where topic = 'kizunasync:todos' and extension = 'broadcast' and event = 'changed'`
      const [before] = await doorbells

      // Become the actor: request JWT claims populate auth.uid(), then drop to the authenticated role so the AFTER-UPDATE tracker emits the doorbell under the same RLS the real client hits.
      const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' })

      await tx`select set_config('request.jwt.claims', ${claims}, true)`
      await tx`set local role authenticated`

      await tx`update public.todos set done = true where id = ${todo.id}::uuid`

      await tx`reset role`
      const [after] = await tx`
        select count(*)::int as n
        from realtime.messages
        where topic = 'kizunasync:todos' and extension = 'broadcast' and event = 'changed'`

      delta = after.n - before.n

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (delta === undefined) {
    throw new Error('no doorbell delta captured')
  }
  return delta
}

describe.skipIf(!reachable)('the realtime doorbell rings on an owned write', () => {
  test('an UPDATE to your OWN todo lands a NEW kizunasync:todos broadcast in realtime.messages', async () => {
    const rings = await ringDeltaAfterOwnUpdate(db!)

    expect(rings).toBeGreaterThan(0)
  })

  test('authenticated may receive kizunasync broadcasts and must not send them', async () => {
    const conn = db!
    const policies = await conn<{ polname: string; cmd: string }[]>`
      select pol.polname, pol.polcmd as cmd
      from pg_policy pol
      join pg_class rel on rel.oid = pol.polrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'realtime'
        and rel.relname = 'messages'
        and pol.polname like 'kizunasync wakeup%'`

    expect(policies.map((p) => p.polname).sort()).toEqual(['kizunasync wakeup receive'])
    expect(policies[0]?.cmd).toBe('r')

    let insertDenied = false

    try {
      await conn.begin(async (tx) => {
        const [actor] = await tx`
          insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
        const jwt = JSON.stringify({ sub: actor.id, role: 'authenticated' })

        await tx`select set_config('request.jwt.claims', ${jwt}, true)`
        await tx`set local role authenticated`

        try {
          await tx`
            insert into realtime.messages (topic, extension, payload, event)
            values ('kizunasync:todos', 'broadcast', '{}'::jsonb, 'changed')`
        } catch {
          insertDenied = true
        }
        // Always abort: a policy regression must not commit the probe INSERT.
        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        insertDenied = true
      }
    }
    expect(insertDenied).toBe(true)
  })
})

// MARK: - One doorbell per topic per transaction

const PROBE_TABLE = '_doorbell_probe'

const BUCKETS = [{ table: 'todos', params: {} }]

/** The `changed` broadcasts on `topic` that `tx` sees in realtime.messages. */
async function countDoorbells(tx: SQL, topic: string): Promise<number> {
  const [row] = await tx`
    select count(*)::int as n
    from realtime.messages
    where topic = ${topic} and extension = 'broadcast' and event = 'changed'`

  return (row as { n: number }).n
}

/** Runs `body` in a transaction that always rolls back, and returns what it captured. */
async function inRolledBackTxn<T>(conn: SQL, body: (tx: SQL) => Promise<T>): Promise<T> {
  let captured: T | undefined

  try {
    await conn.begin(async (tx) => {
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

describe.skipIf(!reachable)('a transaction rings each topic once', () => {
  test('many rows of two synced tables written in one transaction land one broadcast per table', async () => {
    const rings = await inRolledBackTxn(db!, async (tx) => {
      const [actor] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`

      await tx.unsafe(`create table public.${PROBE_TABLE} (id uuid primary key default gen_random_uuid(), n integer not null)`)
      await tx.unsafe(`
        create trigger kizunasync_track_change after insert or update on public.${PROBE_TABLE}
        for each row execute function kizunasync.track_change()`)
      await tx.unsafe(`
        create trigger kizunasync_track_delete after delete on public.${PROBE_TABLE}
        for each row execute function kizunasync.track_delete()`)
      const todosBefore = await countDoorbells(tx, 'kizunasync:todos')
      const probeBefore = await countDoorbells(tx, `kizunasync:${PROBE_TABLE}`)
      const [first, second] = await tx`
        insert into public.todos (user_id, title)
        select ${actor.id}::uuid, 'doorbell row ' || g from generate_series(1, 3) as g
        returning id`

      await tx`update public.todos set done = true where id = ${first.id}::uuid`
      await tx`delete from public.todos where id = ${second.id}::uuid`
      await tx.unsafe(`insert into public.${PROBE_TABLE} (n) select g from generate_series(1, 4) as g`)
      await tx.unsafe(`update public.${PROBE_TABLE} set n = n + 10 where n = 2`)
      await tx.unsafe(`delete from public.${PROBE_TABLE} where n = 1`)

      return {
        todos: (await countDoorbells(tx, 'kizunasync:todos')) - todosBefore,
        probe: (await countDoorbells(tx, `kizunasync:${PROBE_TABLE}`)) - probeBefore,
      }
    })

    expect(rings).toEqual({ todos: 1, probe: 1 })
  })

  test('two registrations written in one transaction land one kizunasync:clients broadcast', async () => {
    const rings = await inRolledBackTxn(db!, async (tx) => {
      const [actor] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const before = await countDoorbells(tx, 'kizunasync:clients')
      const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' })

      await tx`select set_config('request.jwt.claims', ${claims}, true)`
      await tx`set local role authenticated`
      await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10, ${crypto.randomUUID()}::uuid)`
      await tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 10, ${crypto.randomUUID()}::uuid)`
      await tx`reset role`
      const [registrations] = await tx`
        select count(*)::int as n from kizunasync._clients where user_id = ${actor.id}::uuid`

      return {
        registrations: (registrations as { n: number }).n,
        rings: (await countDoorbells(tx, 'kizunasync:clients')) - before,
      }
    })

    expect(rings).toEqual({ registrations: 2, rings: 1 })
  })
})
