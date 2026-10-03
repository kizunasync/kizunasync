/**
 * Replay ownership against real Postgres: a recorded verdict answers only the user
 * who pushed its mutation, and the verdict ledger keeps no row copy. Another user
 * who replays the id, including one who read it from a pulled conflict entry, gets
 * `RLS_DENIED` with no row, and the replay neither applies nor records anything.
 * The owner gets the recorded kind and reason, with `server_row` rendered again
 * for the recorded row under the current RLS; with no row to render, a rejection
 * carries a null row and an applied verdict leaves `server_row` out.
 * `prune_clients()` also deletes verdicts older than `_settings.client_ttl_days`,
 * and its count stays the clients it pruned.
 *
 * The pack numbers a change and fills a journal row's `winner_seq` when the
 * writing transaction commits, so every push and pull here commits the way a
 * client's request does. Each replay case builds a committed fixture table that
 * every signed-in user reads and only a row's owner writes, then drops it with
 * every bookkeeping row it left. The prune case rolls back. Skips loudly (named
 * reason) when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const FIXTURE_TABLE = '_replay_ownership'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-replay-ownership] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

// MARK: - Types

type TConn = Awaited<ReturnType<SQL['reserve']>>

type TColumns = Record<string, unknown>

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
  server_row?: TColumns | null
}

interface IMutation {
  mutation_id: string
  table: string
  pk: string
  op: 'insert' | 'update'
  columns?: TColumns
  precondition?: TColumns
  transforms?: TColumns
}

interface IConflict {
  column_name: string
  winner_mutation_id: string
}

interface IPullPage {
  rows: { pk: string }[]
  conflicts?: IConflict[]
}

/** One `_verdicts` row, read back as the table owner. */
interface ILedgerEntry {
  verdict: IVerdict
  user_id: string | null
  table_name: string | null
  pk: string | null
}

/** The user who pushes the recorded mutation, and a second user who reads every row of the fixture but writes none of the owner's. */
interface IActors {
  owner: string
  reader: string
}

class Rollback extends Error {}

// MARK: - Fixture

/** Mutation ids a case pushed, so its cleanup can remove the verdicts they recorded. */
const pushedMutationIds = new Set<string>()

/** Every signed-in user reads every row and only a row's owner writes it; the journal is on, so an overwrite hands its winner id to every reader of the row. */
const provisionFixture = async (session: TConn): Promise<void> => {
  await session.unsafe(`
    create table public.${FIXTURE_TABLE} (
      id uuid primary key,
      user_id uuid not null default auth.uid(),
      title text not null default '',
      likes integer not null default 0
    );
    alter table public.${FIXTURE_TABLE} enable row level security;
    grant select, insert, update, delete on public.${FIXTURE_TABLE} to authenticated;
    create policy ro_read on public.${FIXTURE_TABLE} for select to authenticated using (true);
    create policy ro_insert on public.${FIXTURE_TABLE} for insert to authenticated
      with check (user_id = (select auth.uid()));
    create policy ro_update on public.${FIXTURE_TABLE} for update to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
    create policy ro_delete on public.${FIXTURE_TABLE} for delete to authenticated
      using (user_id = (select auth.uid()));
    create trigger kizunasync_track_change after insert or update on public.${FIXTURE_TABLE}
      for each row execute function kizunasync.track_change();
    create trigger kizunasync_track_delete after delete on public.${FIXTURE_TABLE}
      for each row execute function kizunasync.track_delete();
  `)
  await session`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, conflict_mode, conflict_journal, min_schema_version, register_clients)
    values (${FIXTURE_TABLE}, 'read-write', null, 'arrival', true, 1, false)`
}

/** Removes the fixture table and every bookkeeping row a case left, whatever it asserted. */
const dropFixture = async (session: TConn, actorIds: string[]): Promise<void> => {
  await session`rollback`.catch(() => undefined)
  await session.unsafe(`drop table if exists public.${FIXTURE_TABLE} cascade`)
  await session`delete from kizunasync._changelog where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._tombstones where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._conflict_journal where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._row_hlc where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._bucket_grants where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._config where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._verdicts where mutation_id = any(${`{${[...pushedMutationIds].join(',')}}`}::uuid[])`
  pushedMutationIds.clear()
  await session`delete from auth.users where id = any(${`{${actorIds.join(',')}}`}::uuid[])`
}

/** One session: the committed fixture table, two fresh users, then `body`, then the cleanup. */
async function inCommittedFixture<T>(body: (session: TConn, actors: IActors) => Promise<T>): Promise<T> {
  const pool = new SQL(DB_URL, { max: 1 })
  const session = await pool.reserve()
  const actorIds: string[] = []

  try {
    await provisionFixture(session)
    const [owner] = await session`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id::text as id`

    actorIds.push(owner.id as string)
    const [reader] = await session`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id::text as id`

    actorIds.push(reader.id as string)

    return await body(session, { owner: owner.id as string, reader: reader.id as string })
  } finally {
    await dropFixture(session, actorIds)
    session.release()
    await pool.end()
  }
}

/** Inserts a row owned by `ownerId` as the table owner, so the write bypasses RLS like a peer's committed change. */
const seedRow = async (session: TConn, ownerId: string, title: string): Promise<string> => {
  const pk = crypto.randomUUID()

  await session.unsafe(`insert into public.${FIXTURE_TABLE} (id, user_id, title) values ($1, $2, $3)`, [pk, ownerId, title])

  return pk
}

// MARK: - Helpers

const mutation = (fields: Omit<IMutation, 'mutation_id' | 'table'>): IMutation => ({
  mutation_id: crypto.randomUUID(),
  table: FIXTURE_TABLE,
  ...fields,
})

/** Opens a transaction under the user's JWT and the authenticated role; the caller commits it. */
const actAs = async (session: TConn, userId: string): Promise<void> => {
  await session`begin`
  await session`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`
  await session`set local role authenticated`
}

/** Pushes one mutation as the user in its own committed transaction and returns its verdict. */
const pushAs = async (session: TConn, userId: string, pushed: IMutation): Promise<IVerdict> => {
  pushedMutationIds.add(pushed.mutation_id)
  await actAs(session, userId)
  const batch = { atomic: false, mutations: [pushed] }
  const [row] = await session`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

  await session`commit`
  const verdict = (row.resp as { verdicts?: IVerdict[] }).verdicts?.[0]

  if (verdict === undefined) {
    throw new Error(`rpc-replay-ownership: expected one verdict, got ${JSON.stringify(row.resp)}`)
  }
  return verdict
}

/** Bootstraps the fixture table as the user in its own committed transaction. */
const pullAs = async (session: TConn, userId: string): Promise<IPullPage> => {
  const buckets = [{ table: FIXTURE_TABLE, params: {} }]

  await actAs(session, userId)
  const [row] = await session`select kizunasync.pull(${buckets}::jsonb, '0', 1, 500) as page`

  await session`commit`

  return row.page as IPullPage
}

const readRow = async (session: TConn, pk: string): Promise<TColumns | null> => {
  const [row] = await session.unsafe(`select to_jsonb(t) as row from public.${FIXTURE_TABLE} t where t.id = $1`, [pk])

  return (row?.row as TColumns | undefined) ?? null
}

const ledgerEntries = async (session: TConn, mutationId: string): Promise<ILedgerEntry[]> =>
  (await session`
    select verdict, user_id::text as user_id, table_name, pk::text as pk
      from kizunasync._verdicts
     where mutation_id = ${mutationId}::uuid`) as ILedgerEntry[]

/** The only answer a replay by another user may get: no recorded reason and no row. */
const foreignReplay = (mutationId: string): IVerdict => ({ mutation_id: mutationId, reason: 'RLS_DENIED', server_row: null, verdict: 'rejected' })

/** The recorded form of a verdict: its `server_row`, when it carries the key, is null. */
const recordedForm = (verdict: IVerdict): IVerdict => ('server_row' in verdict ? { ...verdict, server_row: null } : verdict)

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

// MARK: - A replay by another user

describe.skipIf(!reachable)('kizunasync.push answers a replayed mutation id for its owner alone', () => {
  test('another user replaying the id gets RLS_DENIED with no row, applies nothing, and records nothing', async () => {
    const result = await inCommittedFixture(async (session, { owner, reader }) => {
      const pk = await seedRow(session, owner, 'first')
      const rejected = mutation({ pk, op: 'update', columns: { title: 'second' }, precondition: { title: 'stale' } })
      const ownerVerdict = await pushAs(session, owner, rejected)
      const readerPk = crypto.randomUUID()
      const sameBytes = await pushAs(session, reader, rejected)
      const ownInsert = await pushAs(session, reader, { mutation_id: rejected.mutation_id, table: FIXTURE_TABLE, pk: readerPk, op: 'insert', columns: { title: 'reader', user_id: reader } })

      return {
        ownerVerdict,
        sameBytes,
        ownInsert,
        row: await readRow(session, pk),
        readerRow: await readRow(session, readerPk),
        ledger: await ledgerEntries(session, rejected.mutation_id),
        owner,
        pk,
        mutationId: rejected.mutation_id,
      }
    })

    expect(result.ownerVerdict).toMatchObject({ verdict: 'rejected', reason: 'PRECONDITION', server_row: { title: 'first' } })
    expect(result.sameBytes).toEqual(foreignReplay(result.mutationId))
    expect(result.ownInsert).toEqual(foreignReplay(result.mutationId))
    expect(result.row).toMatchObject({ title: 'first' })
    expect(result.readerRow).toBeNull()
    expect(result.ledger).toEqual([{ verdict: recordedForm(result.ownerVerdict), user_id: result.owner, table_name: FIXTURE_TABLE, pk: result.pk }])
  })

  test('a conflict-journal winner id replayed by a second user who can read the row reveals nothing', async () => {
    const result = await inCommittedFixture(async (session, { owner, reader }) => {
      const pk = await seedRow(session, owner, 'original')
      const winner = mutation({ pk, op: 'update', columns: { title: 'overwritten' } })
      const winnerVerdict = await pushAs(session, owner, winner)
      const page = await pullAs(session, reader)
      const replay = await pushAs(session, reader, { mutation_id: winner.mutation_id, table: FIXTURE_TABLE, pk, op: 'update', columns: { title: 'taken over' } })

      return {
        winnerVerdict,
        page,
        replay,
        row: await readRow(session, pk),
        ledger: await ledgerEntries(session, winner.mutation_id),
        owner,
        pk,
        mutationId: winner.mutation_id,
      }
    })

    expect(result.winnerVerdict).toEqual({ mutation_id: result.mutationId, verdict: 'applied' })
    expect(result.page.rows.map((entry) => entry.pk)).toContain(result.pk)
    expect(result.page.conflicts).toEqual([expect.objectContaining({ column_name: 'title', winner_mutation_id: result.mutationId })])
    expect(result.replay).toEqual(foreignReplay(result.mutationId))
    expect(result.row).toMatchObject({ title: 'overwritten' })
    expect(result.ledger).toEqual([{ verdict: result.winnerVerdict, user_id: result.owner, table_name: FIXTURE_TABLE, pk: result.pk }])
  })
})

// MARK: - A replay by the owner

describe.skipIf(!reachable)('kizunasync.push renders the row again when the owner replays', () => {
  test('a rejected verdict comes back with its kind and reason and the row as it stands', async () => {
    const result = await inCommittedFixture(async (session, { owner }) => {
      const pk = await seedRow(session, owner, 'first')
      const rejected = mutation({ pk, op: 'update', columns: { title: 'second' }, precondition: { title: 'stale' } })
      const first = await pushAs(session, owner, rejected)

      await session.unsafe(`update public.${FIXTURE_TABLE} set title = 'changed since' where id = $1`, [pk])

      return { first, replay: await pushAs(session, owner, rejected), ledger: await ledgerEntries(session, rejected.mutation_id), owner, pk }
    })

    expect(result.first).toMatchObject({ reason: 'PRECONDITION', server_row: { title: 'first' } })
    expect(result.replay).toEqual({ ...result.first, server_row: { id: result.pk, user_id: result.owner, title: 'changed since', likes: 0 } })
    expect(result.ledger.map((entry) => entry.verdict)).toEqual([recordedForm(result.first)])
  })

  test('an applied transform comes back with the arbitrated total as it stands', async () => {
    const result = await inCommittedFixture(async (session, { owner }) => {
      const pk = await seedRow(session, owner, 'counted')
      const increment = mutation({ pk, op: 'update', transforms: { likes: { op: 'increment', by: 2 } } })
      const first = await pushAs(session, owner, increment)

      await session.unsafe(`update public.${FIXTURE_TABLE} set likes = 10 where id = $1`, [pk])

      return { first, replay: await pushAs(session, owner, increment), ledger: await ledgerEntries(session, increment.mutation_id) }
    })

    expect(result.first).toMatchObject({ verdict: 'applied', server_row: { likes: 2 } })
    expect(result.replay).toMatchObject({ mutation_id: result.first.mutation_id, verdict: 'applied', server_row: { likes: 10 } })
    expect(result.ledger.map((entry) => entry.verdict)).toEqual([{ mutation_id: result.first.mutation_id, server_row: null, verdict: 'applied' }])
  })

  // The applied arm of the wire verdict carries a server_row only as column values, so a replay with no row to render leaves the key out.
  test('an applied transform whose row the owner cannot read at the replay comes back without a server row', async () => {
    const result = await inCommittedFixture(async (session, { owner }) => {
      const pk = await seedRow(session, owner, 'counted')
      const increment = mutation({ pk, op: 'update', transforms: { likes: { op: 'increment', by: 2 } } })
      const first = await pushAs(session, owner, increment)

      await session.unsafe(`alter policy ro_read on public.${FIXTURE_TABLE} using (user_id <> (select auth.uid()))`)

      return { first, replay: await pushAs(session, owner, increment), row: await readRow(session, pk) }
    })

    expect(result.first).toMatchObject({ verdict: 'applied', server_row: { likes: 2 } })
    expect(result.row).toMatchObject({ likes: 2 })
    expect(result.replay).toEqual({ mutation_id: result.first.mutation_id, verdict: 'applied' })
    expect('server_row' in result.replay).toBe(false)
  })

  test('an applied transform on a table unconfigured before the replay comes back without a server row', async () => {
    const result = await inCommittedFixture(async (session, { owner }) => {
      const pk = await seedRow(session, owner, 'counted')
      const increment = mutation({ pk, op: 'update', transforms: { likes: { op: 'increment', by: 2 } } })
      const first = await pushAs(session, owner, increment)

      await session`delete from kizunasync._config where table_name = ${FIXTURE_TABLE}`

      return { first, replay: await pushAs(session, owner, increment) }
    })

    expect(result.first).toMatchObject({ verdict: 'applied', server_row: { likes: 2 } })
    expect(result.replay).toEqual({ mutation_id: result.first.mutation_id, verdict: 'applied' })
    expect('server_row' in result.replay).toBe(false)
  })

  test('an applied verdict without a server row comes back without one', async () => {
    const result = await inCommittedFixture(async (session, { owner }) => {
      const insert = mutation({ pk: crypto.randomUUID(), op: 'insert', columns: { title: 'mine', user_id: owner } })
      const first = await pushAs(session, owner, insert)

      return { first, replay: await pushAs(session, owner, insert), ledger: await ledgerEntries(session, insert.mutation_id) }
    })

    expect(result.first).toEqual({ mutation_id: result.first.mutation_id, verdict: 'applied' })
    expect(result.replay).toEqual(result.first)
    expect(result.ledger.map((entry) => entry.verdict)).toEqual([result.first])
  })

  test('a row the owner cannot read comes back as no row', async () => {
    const result = await inCommittedFixture(async (session, { owner }) => {
      const pk = await seedRow(session, owner, 'first')
      const rejected = mutation({ pk, op: 'update', columns: { title: 'second' }, precondition: { title: 'stale' } })
      const first = await pushAs(session, owner, rejected)

      await session.unsafe(`alter policy ro_read on public.${FIXTURE_TABLE} using (user_id <> (select auth.uid()))`)

      return { first, replay: await pushAs(session, owner, rejected), row: await readRow(session, pk) }
    })

    expect(result.first).toMatchObject({ reason: 'PRECONDITION', server_row: { title: 'first' } })
    expect(result.row).toMatchObject({ title: 'first' })
    expect(result.replay).toEqual({ ...result.first, server_row: null })
  })

  test('a table with no _config row keeps the recorded null row', async () => {
    const result = await inCommittedFixture(async (session, { owner }) => {
      const pk = await seedRow(session, owner, 'first')
      const rejected = mutation({ pk, op: 'update', columns: { title: 'second' }, precondition: { title: 'stale' } })
      const first = await pushAs(session, owner, rejected)

      await session`delete from kizunasync._config where table_name = ${FIXTURE_TABLE}`

      return { first, replay: await pushAs(session, owner, rejected), row: await readRow(session, pk) }
    })

    expect(result.first).toMatchObject({ reason: 'PRECONDITION', server_row: { title: 'first' } })
    expect(result.row).toMatchObject({ title: 'first' })
    expect(result.replay).toEqual({ ...result.first, server_row: null })
  })
})

// MARK: - Verdict retention

describe.skipIf(!reachable)('kizunasync.prune_clients and the verdict ledger', () => {
  test('deletes verdicts older than client_ttl_days and still counts only the clients it pruned', async () => {
    const aged = [crypto.randomUUID(), crypto.randomUUID()]
    const fresh = crypto.randomUUID()
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      await tx`update kizunasync._settings set client_ttl_days = 30 where id`
      const [user] = await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id::text as id`

      await tx`
        insert into kizunasync._clients (client_id, user_id, last_seen)
        values (gen_random_uuid(), ${user.id}::uuid, now() - make_interval(days => 31))`
      await tx`
        insert into kizunasync._verdicts (mutation_id, verdict, recorded_at)
        values
          (${aged[0]}::uuid, '{"verdict":"applied"}'::jsonb, now() - make_interval(days => 31)),
          (${aged[1]}::uuid, '{"verdict":"applied"}'::jsonb, now() - make_interval(days => 45)),
          (${fresh}::uuid, '{"verdict":"applied"}'::jsonb, now() - make_interval(days => 29))`
      const [pruned] = await tx`select kizunasync.prune_clients()::text as pruned`
      const kept = await tx`
        select mutation_id::text as mutation_id from kizunasync._verdicts
         where mutation_id = any(${`{${[...aged, fresh].join(',')}}`}::uuid[])`

      return { pruned: pruned.pruned as string, kept: kept.map((entry: { mutation_id: string }) => entry.mutation_id) }
    })

    expect(Number(result.pruned)).toBe(1)
    expect(result.kept).toEqual([fresh])
  })
})
