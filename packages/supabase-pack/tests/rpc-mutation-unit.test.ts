/**
 * kizunasync.push applies each mutation as one unit, against the real SQL. When a
 * mutation's verdict is `rejected`, none of its writes survive: the row, its
 * `_changelog` entries, its `_conflict_journal` entries, and its `_row_hlc` stamps
 * read back exactly as they were, and only the recorded verdict persists, with
 * its `server_row` nulled (P:verdict-completeness-transforms-and-conflict-rejection,
 * D-field-transforms).
 * An hlc-mode update writes its winning columns through the masked update, so it
 * lands on an existing row whatever that row's other columns require, and an
 * update of a missing row creates nothing.
 *
 * The pack writes a change's `_changelog` entry and fills a journal row's
 * `winner_seq` when the writing transaction commits, so every step here commits
 * the way a client's request does and the traces are read after the commit. Each
 * case builds its strict owner-only fixture table, then drops it with every
 * bookkeeping row it left. Skips loudly (named reason) when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const FIXTURE_TABLE = '_mutation_unit_strict'
const SEED = { title: 'start', done: false, likes: 0, stock: 2 }
const STALE_HLC = '2020-01-01T00:00:00.000Z|0|00000000-0000-4000-8000-c10000000002'
const WINNING_HLC = '2024-01-01T00:00:00.000Z|0|00000000-0000-4000-8000-c10000000001'
const NEWER_THAN_WINNING_HLC = '2025-01-01T00:00:00.000Z|0|00000000-0000-4000-8000-c10000000003'
const NON_NUMERIC_INCREMENT = { title: { op: 'increment', by: 1 } }

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-mutation-unit] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
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

type TConflictMode = 'arrival' | 'hlc'

type TColumns = Record<string, unknown>

/** The DDL of the fixture's owner and title columns: each shape isolates one check a synthesized insert tuple would face. */
interface IFixtureColumns {
  owner: string
  title: string
}

interface IFixture {
  conflictMode: TConflictMode
  columns: IFixtureColumns
}

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
  server_row?: TColumns | null
}

interface IBatchAbort {
  offender_mutation_id: string
  outcome: 'aborted'
  reason: string
}

type TPushResponse = { verdicts: IVerdict[] } | { batch: IBatchAbort }

interface IMutation {
  mutation_id: string
  table: string
  pk: string
  op: 'insert' | 'update'
  columns: TColumns
  transforms?: TColumns
  hlc?: string
}

interface IUpdate {
  pk: string
  columns: TColumns
  transforms?: TColumns
  hlc?: string
}

interface IPushRequest {
  actorId: string
  atomic: boolean
  mutations: IMutation[]
}

/** Every trace a mutation on one fixture row can leave, read back as the table owner. */
interface IRowEffects {
  row: TColumns | null
  changelog: string[]
  journal: string[]
  hlc: TColumns | null
}

interface IScenario extends IFixture {
  build: (pk: string, actorId: string) => IMutation

  /** Seeds the row for another owner, so the actor's RLS hides it. */
  hidden?: boolean

  /** Per-column `_row_hlc` stamps written for the seeded row before the push. */
  stamps?: Record<string, string>

  /** Privilege statements run as the table owner before the push. */
  privileges?: string
}

interface IOutcome {
  verdict: IVerdict
  before: IRowEffects
  after: IRowEffects
  recorded: IVerdict | null
}

// MARK: - Fixture

/** The owner column has no default, so a synthesized insert tuple fails the owner-only WITH CHECK. */
const STRICT: IFixtureColumns = { owner: 'user_id uuid not null', title: 'title text' }

/** A NOT NULL column without a default, like the demo table's `title`, which a synthesized insert tuple leaves NULL. */
const NOT_NULL_TITLE: IFixtureColumns = { owner: 'user_id uuid not null default auth.uid()', title: 'title text not null' }

/** Every column has a default or is nullable, so a synthesized insert tuple would create the row. */
const INSERTABLE: IFixtureColumns = { owner: 'user_id uuid not null default auth.uid()', title: 'title text' }

/** Column-level INSERT on every fixture column but `done`; a column revoke narrows nothing while the table-level grant stands. */
const WITHOUT_INSERT_ON_DONE = `
  revoke insert on public.${FIXTURE_TABLE} from authenticated;
  grant insert (id, user_id, title, likes, stock) on public.${FIXTURE_TABLE} to authenticated;
`

/**
 * A strict owner-only table, shaped like rpc-verdict's `_verdict_strict`, with the
 * conflict journal on so a column overwrite that survived would leave a journal
 * row.
 */
const provisionFixture = async (session: TConn, fixture: IFixture): Promise<void> => {
  await session.unsafe(`
    create table public.${FIXTURE_TABLE} (
      id uuid primary key,
      ${fixture.columns.owner},
      ${fixture.columns.title},
      done boolean not null default false,
      likes integer not null default 0,
      stock integer not null default 0 check (stock >= 0)
    );
    alter table public.${FIXTURE_TABLE} enable row level security;
    grant select, insert, update, delete on public.${FIXTURE_TABLE} to authenticated;
    create policy mu_all on public.${FIXTURE_TABLE} for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
    create trigger kizunasync_track_change after insert or update on public.${FIXTURE_TABLE}
      for each row execute function kizunasync.track_change();
    create trigger kizunasync_track_delete after delete on public.${FIXTURE_TABLE}
      for each row execute function kizunasync.track_delete();
  `)
  await session`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, conflict_mode, conflict_journal, min_schema_version, register_clients)
    values (${FIXTURE_TABLE}, 'read-write', 'user_id', ${fixture.conflictMode}, true, 1, false)`
}

/** Mutation ids a case pushed, so its cleanup can remove the verdicts they recorded. */
const pushedMutationIds = new Set<string>()

/** Removes the fixture table and every bookkeeping row a case left, whatever it asserted. */
const dropFixture = async (session: TConn, actorId: string | null): Promise<void> => {
  await session`rollback`.catch(() => undefined)
  await session.unsafe(`drop table if exists public.${FIXTURE_TABLE} cascade`)
  await session`delete from kizunasync._changelog where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._tombstones where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._conflict_journal where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._row_hlc where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._config where table_name = ${FIXTURE_TABLE}`
  await session`delete from kizunasync._verdicts where mutation_id = any(${`{${[...pushedMutationIds].join(',')}}`}::uuid[])`
  pushedMutationIds.clear()

  if (actorId !== null) {
    await session`delete from auth.users where id = ${actorId}::uuid`
  }
}

/** One session: the committed fixture table, a fresh actor, then `body`, then the cleanup. */
async function inCommittedFixture<T>(fixture: IFixture, body: (session: TConn, actorId: string) => Promise<T>): Promise<T> {
  const pool = new SQL(DB_URL, { max: 1 })
  const session = await pool.reserve()
  let actorId: string | null = null

  try {
    await provisionFixture(session, fixture)
    const [actor] = await session`
      insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`

    actorId = actor.id as string

    return await body(session, actorId)
  } finally {
    await dropFixture(session, actorId)
    session.release()
    await pool.end()
  }
}

/** Inserts the SEED row owned by `ownerId` as the table owner, so the write bypasses RLS like a peer's committed change. */
const seedRow = async (session: TConn, ownerId: string): Promise<string> => {
  const pk = crypto.randomUUID()

  await session.unsafe(
    `insert into public.${FIXTURE_TABLE} (id, user_id, title, done, likes, stock) values ($1, $2, $3, $4, $5, $6)`,
    [pk, ownerId, SEED.title, SEED.done, SEED.likes, SEED.stock],
  )

  return pk
}

// MARK: - Helpers

const update = ({ pk, columns, transforms, hlc }: IUpdate): IMutation => ({
  mutation_id: crypto.randomUUID(),
  table: FIXTURE_TABLE,
  pk,
  op: 'update',
  columns,
  ...(transforms === undefined ? {} : { transforms }),
  ...(hlc === undefined ? {} : { hlc }),
})

/** Reads back every committed trace of `pk` as the table owner. */
const readEffects = async (session: TConn, pk: string): Promise<IRowEffects> => {
  const [row] = await session.unsafe(`select to_jsonb(t) as row from public.${FIXTURE_TABLE} t where t.id = $1`, [pk])
  const changelog = await session`
    select seq::text as seq from kizunasync._changelog
     where table_name = ${FIXTURE_TABLE} and pk = ${pk}
     order by seq`
  const journal = await session`
    select column_name from kizunasync._conflict_journal
     where table_name = ${FIXTURE_TABLE} and pk = ${pk}
     order by id`
  const [stamps] = await session`
    select column_hlc from kizunasync._row_hlc where table_name = ${FIXTURE_TABLE} and pk = ${pk}`

  return {
    row: (row?.row as TColumns | undefined) ?? null,
    changelog: changelog.map((entry: { seq: string }) => entry.seq),
    journal: journal.map((entry: { column_name: string }) => entry.column_name),
    hlc: (stamps?.column_hlc as TColumns | undefined) ?? null,
  }
}

const recordedVerdict = async (session: TConn, mutationId: string): Promise<IVerdict | null> => {
  const [entry] = await session`select verdict from kizunasync._verdicts where mutation_id = ${mutationId}::uuid`

  return (entry?.verdict as IVerdict | undefined) ?? null
}

/** Pushes the batch as the actor under a real JWT in its own transaction, which commits; the session is the table owner again afterwards. */
const pushAs = async (session: TConn, { actorId, atomic, mutations }: IPushRequest): Promise<TPushResponse> => {
  const claims = JSON.stringify({ sub: actorId, role: 'authenticated' })
  const batch = { atomic, mutations }

  for (const mutation of mutations) {
    pushedMutationIds.add(mutation.mutation_id)
  }
  await session`begin`
  await session`select set_config('request.jwt.claims', ${claims}, true)`
  await session`set local role authenticated`
  const [row] = await session`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

  await session`commit`

  return row.resp as TPushResponse
}

const verdictsOf = (response: TPushResponse): IVerdict[] => {
  if (!('verdicts' in response)) {
    throw new Error(`rpc-mutation-unit: expected per-mutation verdicts, got ${JSON.stringify(response)}`)
  }
  return response.verdicts
}

/** Seeds one row, the actor's own unless `hidden`, pushes the mutation `build` makes for it alone, and captures its traces around the push. */
const runOnSeededRow = async (scenario: IScenario): Promise<IOutcome> =>
  inCommittedFixture(scenario, async (session, actorId) => {
    const pk = await seedRow(session, scenario.hidden === true ? crypto.randomUUID() : actorId)

    if (scenario.stamps !== undefined) {
      await session`
        insert into kizunasync._row_hlc (table_name, pk, column_hlc)
        values (${FIXTURE_TABLE}, ${pk}::uuid, ${scenario.stamps}::jsonb)`
    }
    if (scenario.privileges !== undefined) {
      await session.unsafe(scenario.privileges)
    }
    const before = await readEffects(session, pk)
    const mutation = scenario.build(pk, actorId)
    const [verdict] = verdictsOf(await pushAs(session, { actorId, atomic: false, mutations: [mutation] }))

    if (verdict === undefined) {
      throw new Error('rpc-mutation-unit: push returned no verdict')
    }
    return { verdict, before, after: await readEffects(session, pk), recorded: await recordedVerdict(session, mutation.mutation_id) }
  })

/** The rejection itself, the pre-mutation server_row, no surviving trace, and the ledger holding that verdict without its row copy. */
const expectRejectedWithoutEffect = (outcome: IOutcome, reason: string): void => {
  expect(outcome.verdict.verdict).toBe('rejected')
  expect(outcome.verdict.reason).toBe(reason)
  expect(outcome.verdict.server_row).toEqual(outcome.before.row)
  expect(outcome.after).toEqual(outcome.before)
  expect(outcome.recorded).toEqual({ ...outcome.verdict, server_row: null })
}

/** A refusal on a row the actor cannot see: no server_row, no surviving trace, and the ledger holding that verdict without its row copy. */
const expectHiddenRowDenied = (outcome: IOutcome): void => {
  expect(outcome.verdict.verdict).toBe('rejected')
  expect(outcome.verdict.reason).toBe('RLS_DENIED')
  expect(outcome.verdict.server_row ?? null).toBeNull()
  expect(outcome.after).toEqual(outcome.before)
  expect(outcome.recorded).toEqual({ ...outcome.verdict, server_row: null })
}

/** An applied hlc write: the column lands and its stamp advances to the push hlc. */
const expectHlcColumnApplied = (outcome: IOutcome): void => {
  expect(outcome.verdict.verdict).toBe('applied')
  expect(outcome.after.row?.done).toBe(true)
  expect(outcome.after.hlc).toEqual({ done: WINNING_HLC })
}

// MARK: - A rejected mutation leaves no effect

describe.skipIf(!reachable)('kizunasync.push rolls back every write of a rejected mutation', () => {
  test('arrival: a column assign with a non-numeric increment is CONSTRAINT and the column stays unchanged', async () => {
    const outcome = await runOnSeededRow({
      conflictMode: 'arrival',
      columns: STRICT,
      build: (pk) => update({ pk, columns: { done: true }, transforms: NON_NUMERIC_INCREMENT }),
    })

    expectRejectedWithoutEffect(outcome, 'CONSTRAINT')
    expect(outcome.after.row?.done).toBe(false)
  })

  test('arrival: a column assign with an increment that breaks check (stock >= 0) is CONSTRAINT and the column stays unchanged', async () => {
    const outcome = await runOnSeededRow({
      conflictMode: 'arrival',
      columns: STRICT,
      build: (pk) => update({ pk, columns: { done: true }, transforms: { stock: { op: 'increment', by: -5 } } }),
    })

    expectRejectedWithoutEffect(outcome, 'CONSTRAINT')
    expect(outcome.after.row?.done).toBe(false)
    expect(outcome.after.row?.stock).toBe(SEED.stock)
  })

  test('hlc: a winning column with a failing transform is CONSTRAINT and the column and its stamp stay unchanged', async () => {
    const outcome = await runOnSeededRow({
      conflictMode: 'hlc',
      columns: STRICT,
      stamps: { done: STALE_HLC },
      build: (pk) => update({ pk, columns: { done: true }, transforms: NON_NUMERIC_INCREMENT, hlc: WINNING_HLC }),
    })

    expectRejectedWithoutEffect(outcome, 'CONSTRAINT')
    expect(outcome.after.row?.done).toBe(false)
    expect(outcome.after.hlc).toEqual({ done: STALE_HLC })
  })

  // The control for the case above: the same winning hlc update without the transform lands, so the rejection is what kept the column out.
  test('hlc: the same winning column without the transform applies and advances its stamp', async () => {
    const outcome = await runOnSeededRow({
      conflictMode: 'hlc',
      columns: STRICT,
      stamps: { done: STALE_HLC },
      build: (pk) => update({ pk, columns: { done: true }, hlc: WINNING_HLC }),
    })

    expectHlcColumnApplied(outcome)
  })

  test('hlc: an insert of a new pk that breaks check (stock >= 0) is CONSTRAINT and leaves no _row_hlc placeholder', async () => {
    const result = await inCommittedFixture({ conflictMode: 'hlc', columns: STRICT }, async (session, actorId) => {
      const pk = crypto.randomUUID()
      const insert: IMutation = { mutation_id: crypto.randomUUID(), table: FIXTURE_TABLE, pk, op: 'insert', columns: { title: 'new', user_id: actorId, stock: -1 }, hlc: WINNING_HLC }
      const [verdict] = verdictsOf(await pushAs(session, { actorId, atomic: false, mutations: [insert] }))

      return { verdict, effects: await readEffects(session, pk) }
    })

    expect(result.verdict?.verdict).toBe('rejected')
    expect(result.verdict?.reason).toBe('CONSTRAINT')
    expect(result.effects).toEqual({ row: null, changelog: [], journal: [], hlc: null })
  })
})

// MARK: - The hlc write path

describe.skipIf(!reachable)('kizunasync.push writes an hlc update through the masked update', () => {
  test('an hlc update of one column applies when another NOT NULL column has no default', async () => {
    const outcome = await runOnSeededRow({
      conflictMode: 'hlc',
      columns: NOT_NULL_TITLE,
      stamps: { done: STALE_HLC },
      build: (pk) => update({ pk, columns: { done: true }, hlc: WINNING_HLC }),
    })

    expectHlcColumnApplied(outcome)
    expect(outcome.after.row?.title).toBe(SEED.title)
  })

  test('an hlc update of a missing row is RLS_DENIED and creates nothing', async () => {
    const result = await inCommittedFixture({ conflictMode: 'hlc', columns: INSERTABLE }, async (session, actorId) => {
      const pk = crypto.randomUUID()
      const [verdict] = verdictsOf(await pushAs(session, { actorId, atomic: false, mutations: [update({ pk, columns: { done: true }, hlc: WINNING_HLC })] }))

      return { verdict, effects: await readEffects(session, pk) }
    })

    expect(result.verdict?.verdict).toBe('rejected')
    expect(result.verdict?.reason).toBe('RLS_DENIED')
    expect(result.verdict?.server_row ?? null).toBeNull()
    expect(result.effects).toEqual({ row: null, changelog: [], journal: [], hlc: null })
  })

  test('a SUPERSEDED hlc update carries the row as the actor renders it', async () => {
    const outcome = await runOnSeededRow({
      conflictMode: 'hlc',
      columns: STRICT,
      stamps: { done: NEWER_THAN_WINNING_HLC },
      build: (pk) => update({ pk, columns: { done: true }, hlc: WINNING_HLC }),
    })

    expectRejectedWithoutEffect(outcome, 'SUPERSEDED')
    expect(outcome.verdict.server_row).toMatchObject({ done: false, title: SEED.title })
  })

  // A hidden row's stamps never shape the answer: an older and a newer stamp both answer RLS_DENIED, so the verdict cannot tell them apart.
  for (const [label, stamp] of [['an older', STALE_HLC], ['a newer', NEWER_THAN_WINNING_HLC]] as const) {
    test(`an hlc update of a hidden row is RLS_DENIED with no row under ${label} stored stamp`, async () => {
      const outcome = await runOnSeededRow({
        conflictMode: 'hlc',
        columns: STRICT,
        hidden: true,
        stamps: { done: stamp },
        build: (pk) => update({ pk, columns: { done: true }, hlc: WINNING_HLC }),
      })

      expectHiddenRowDenied(outcome)
    })

    test(`an hlc insert over a hidden pk is RLS_DENIED with no row under ${label} stored stamp`, async () => {
      const outcome = await runOnSeededRow({
        conflictMode: 'hlc',
        columns: STRICT,
        hidden: true,
        stamps: { title: stamp, done: stamp, user_id: stamp },
        build: (pk, actorId) => ({ mutation_id: crypto.randomUUID(), table: FIXTURE_TABLE, pk, op: 'insert', columns: { title: 'claimed', done: true, user_id: actorId }, hlc: WINNING_HLC }),
      })

      expectHiddenRowDenied(outcome)
    })
  }

  test('an hlc update needs only UPDATE on its columns, like an arrival update', async () => {
    const outcome = await runOnSeededRow({
      conflictMode: 'hlc',
      columns: STRICT,
      stamps: { done: STALE_HLC },
      privileges: WITHOUT_INSERT_ON_DONE,
      build: (pk) => update({ pk, columns: { done: true }, hlc: WINNING_HLC }),
    })

    expectHlcColumnApplied(outcome)
  })

  test('an hlc insert still needs INSERT on its columns', async () => {
    const result = await inCommittedFixture({ conflictMode: 'hlc', columns: STRICT }, async (session, actorId) => {
      const pk = crypto.randomUUID()
      const insert: IMutation = { mutation_id: crypto.randomUUID(), table: FIXTURE_TABLE, pk, op: 'insert', columns: { title: 'new', done: true, user_id: actorId }, hlc: WINNING_HLC }

      await session.unsafe(WITHOUT_INSERT_ON_DONE)
      const [verdict] = verdictsOf(await pushAs(session, { actorId, atomic: false, mutations: [insert] }))

      return { verdict, effects: await readEffects(session, pk) }
    })

    expect(result.verdict?.verdict).toBe('rejected')
    expect(result.verdict?.reason).toBe('COLUMN_DENIED')
    expect(result.effects).toEqual({ row: null, changelog: [], journal: [], hlc: null })
  })
})

// MARK: - Applied and batched mutations

describe.skipIf(!reachable)('kizunasync.push keeps the applied and batch paths unchanged', () => {
  test('a column assign with a valid increment applies both and returns server_row', async () => {
    const outcome = await runOnSeededRow({
      conflictMode: 'arrival',
      columns: STRICT,
      build: (pk) => update({ pk, columns: { done: true }, transforms: { likes: { op: 'increment', by: 2 } } }),
    })

    expect(outcome.verdict.verdict).toBe('applied')
    expect(outcome.verdict.server_row).toMatchObject({ done: true, likes: 2 })
    expect(outcome.after.row).toMatchObject({ done: true, likes: 2 })
    expect(outcome.after.changelog.length).toBeGreaterThan(outcome.before.changelog.length)
    expect(outcome.after.journal).toEqual(['done'])
    expect(outcome.recorded).toEqual({ ...outcome.verdict, server_row: null })
  })

  test('an atomic batch holding such a mutation aborts with no trace of any member', async () => {
    const result = await inCommittedFixture({ conflictMode: 'arrival', columns: STRICT }, async (session, actorId) => {
      const pk = await seedRow(session, actorId)
      const siblingPk = crypto.randomUUID()
      const before = await readEffects(session, pk)
      const insert: IMutation = { mutation_id: crypto.randomUUID(), table: FIXTURE_TABLE, pk: siblingPk, op: 'insert', columns: { title: 'sibling', user_id: actorId } }
      const offender = update({ pk, columns: { done: true }, transforms: NON_NUMERIC_INCREMENT })
      const response = await pushAs(session, { actorId, atomic: true, mutations: [insert, offender] })

      return {
        response,
        offenderId: offender.mutation_id,
        before,
        after: await readEffects(session, pk),
        sibling: await readEffects(session, siblingPk),
        recorded: [await recordedVerdict(session, insert.mutation_id), await recordedVerdict(session, offender.mutation_id)],
      }
    })

    expect(result.response).toMatchObject({ batch: { offender_mutation_id: result.offenderId, outcome: 'aborted', reason: 'CONSTRAINT' } })
    expect(result.after).toEqual(result.before)
    expect(result.sibling).toEqual({ row: null, changelog: [], journal: [], hlc: null })
    expect(result.recorded).toEqual([null, null])
  })

  test('a non-atomic batch applies the good mutation after the rejected one (no wedge)', async () => {
    const result = await inCommittedFixture({ conflictMode: 'arrival', columns: STRICT }, async (session, actorId) => {
      const failingPk = await seedRow(session, actorId)
      const goodPk = await seedRow(session, actorId)
      const before = await readEffects(session, failingPk)
      const response = await pushAs(session, {
        actorId,
        atomic: false,
        mutations: [update({ pk: failingPk, columns: { done: true }, transforms: NON_NUMERIC_INCREMENT }), update({ pk: goodPk, columns: { done: true } })],
      })

      return { verdicts: verdictsOf(response), before, after: await readEffects(session, failingPk), good: await readEffects(session, goodPk) }
    })

    expect(result.verdicts.map((verdict) => [verdict.verdict, verdict.reason])).toEqual([
      ['rejected', 'CONSTRAINT'],
      ['applied', undefined],
    ])
    expect(result.after).toEqual(result.before)
    expect(result.good.row?.done).toBe(true)
  })
})
