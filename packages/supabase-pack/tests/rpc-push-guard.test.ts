/**
 * The push guard's batch-shape check against real Postgres. A mutation the
 * decision layer could not read (an id that is no uuid, an op outside the three,
 * transforms off an update or outside the closed menu, an hlc table's write with
 * no hlc) refuses the whole batch with SQLSTATE 22023 before any mutation runs,
 * rather than failing the push halfway through it. The apply primitives count
 * rows right after each statement, so an `arrayRemove` with nothing to remove
 * reports no row. Every case rolls back. Skips loudly when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const INVALID_PARAMETER_VALUE = '22023'
const PUSH_HLC = '2026-01-01T00:00:00.000Z|0|00000000-0000-4000-8000-c10000000001'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-push-guard] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

// MARK: - Types

/** Rollback sentinel: aborts db.begin() so the case leaves the DB untouched. */
class Rollback extends Error {}

type TColumns = Record<string, unknown>

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
}

interface IFixture {
  actor: string
  todo: string
}

/** The push either answered or raised; a raise keeps its SQLSTATE and message. */
type TOutcome = { raised: false; verdicts: IVerdict[] } | { raised: true; sqlstate: string | null; message: string }

interface IMalformedCase {
  name: string
  mutation: (fx: IFixture) => TColumns
  problem: string
}

// MARK: - Helpers

/** Bun's SQL client carries the Postgres SQLSTATE on `errno`; `code` is its own transport tag. */
const sqlstateOf = (error: unknown): string | null => {
  if (!(error instanceof Error) || !('errno' in error)) {
    return null
  }
  const { errno } = error

  return typeof errno === 'string' ? errno : null
}

const mutation = (fx: IFixture, fields: TColumns): TColumns => ({
  mutation_id: crypto.randomUUID(),
  table: 'todos',
  pk: fx.todo,
  op: 'update',
  columns: {},
  ...fields,
})

/**
 * Pushes the batch `build` returns as a fresh actor who owns one todo, inside a
 * rolled-back transaction; `prepare` runs first as the table owner and may
 * point the fixture at another todo.
 */
async function attempt(build: (fx: IFixture) => TColumns[], prepare?: (tx: SQL, fx: IFixture) => Promise<void>): Promise<TOutcome> {
  let out: TOutcome | undefined

  try {
    await db!.begin(async (tx) => {
      const [actor] = await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const [todo] = await tx`
        insert into public.todos (id, user_id, title, labels) values (gen_random_uuid(), ${actor.id}, 'guarded', '{a,b}') returning id`
      const fx: IFixture = { actor: actor.id as string, todo: todo.id as string }

      await prepare?.(tx as unknown as SQL, fx)
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: fx.actor, role: 'authenticated' })}, true)`
      await tx`set local role authenticated`
      const batch = { atomic: false, mutations: build(fx) }

      try {
        const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

        out = { raised: false, verdicts: (row.resp as { verdicts: IVerdict[] }).verdicts }
      } catch (error) {
        out = { raised: true, sqlstate: sqlstateOf(error), message: error instanceof Error ? error.message : String(error) }
      }

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (out === undefined) {
    throw new Error('rpc-push-guard: no outcome captured from the transaction')
  }
  return out
}

const toHlcTable = async (tx: SQL): Promise<void> => {
  await tx`update kizunasync._config set conflict_mode = 'hlc' where table_name = 'todos'`
}

function expectRefused(outcome: TOutcome, problem: string): void {
  expect(outcome.raised).toBe(true)

  if (outcome.raised) {
    expect(outcome.sqlstate).toBe(INVALID_PARAMETER_VALUE)
    expect(outcome.message).toContain('mutation 2')
    expect(outcome.message).toContain(problem)
  }
}

function expectAnswered(outcome: TOutcome): IVerdict[] {
  if (outcome.raised) {
    throw new Error(`rpc-push-guard: expected verdicts, the push raised ${outcome.sqlstate}: ${outcome.message}`)
  }
  return outcome.verdicts
}

// MARK: - Batch shape

const MALFORMED: IMalformedCase[] = [
  { name: 'a mutation that is not an object', mutation: () => ['todos'] as unknown as TColumns, problem: 'is not an object' },
  { name: 'a mutation_id that is not a uuid', mutation: (fx) => mutation(fx, { mutation_id: 'not-a-uuid' }), problem: 'mutation_id' },
  { name: 'a mutation with no mutation_id', mutation: (fx) => ({ table: 'todos', pk: fx.todo, op: 'update', columns: {} }), problem: 'mutation_id' },
  { name: 'an op outside insert, update, and delete', mutation: (fx) => mutation(fx, { op: 'upsert' }), problem: 'op' },
  { name: 'a table that is not a string', mutation: (fx) => mutation(fx, { table: 42 }), problem: 'table' },
  { name: 'a pk that is not a uuid', mutation: (fx) => mutation(fx, { pk: 42 }), problem: 'pk' },
  {
    name: 'transforms on an insert',
    mutation: (fx) => mutation(fx, { op: 'insert', pk: crypto.randomUUID(), columns: { user_id: fx.actor, title: 'new' }, transforms: { likes: { op: 'increment', by: 1 } } }),
    problem: 'transforms',
  },
  { name: 'transforms on a delete', mutation: (fx) => mutation(fx, { op: 'delete', transforms: { likes: { op: 'increment', by: 1 } } }), problem: 'transforms' },
  { name: 'transforms that are not an object', mutation: (fx) => mutation(fx, { transforms: [] }), problem: 'transforms' },
  { name: 'a transform spec that is not an object', mutation: (fx) => mutation(fx, { transforms: { likes: 5 } }), problem: '"likes"' },
  { name: 'a transform op outside the menu', mutation: (fx) => mutation(fx, { transforms: { likes: { op: 'multiply', by: 2 } } }), problem: '"likes"' },
  { name: 'an increment whose by is not numeric', mutation: (fx) => mutation(fx, { transforms: { likes: { op: 'increment', by: 'lots' } } }), problem: '"likes"' },
  { name: 'an increment with no by', mutation: (fx) => mutation(fx, { transforms: { likes: { op: 'increment' } } }), problem: '"likes"' },
  { name: 'an arrayUnion with an empty values array', mutation: (fx) => mutation(fx, { transforms: { labels: { op: 'arrayUnion', values: [] } } }), problem: '"labels"' },
  { name: 'an arrayRemove with an empty values array', mutation: (fx) => mutation(fx, { transforms: { labels: { op: 'arrayRemove', values: [] } } }), problem: '"labels"' },
  { name: 'an arrayRemove whose values is not an array', mutation: (fx) => mutation(fx, { transforms: { labels: { op: 'arrayRemove', values: 'a' } } }), problem: '"labels"' },
]

describe.skipIf(!reachable)('the push guard refuses a malformed batch with 22023 before any mutation runs', () => {
  for (const entry of MALFORMED) {
    test(`${entry.name} refuses the whole batch`, async () => {
      const outcome = await attempt((fx) => [mutation(fx, { columns: { done: true } }), entry.mutation(fx)])

      expectRefused(outcome, entry.problem)
    })
  }

  test('a well-formed batch with every transform shape passes the guard and applies', async () => {
    const verdicts = expectAnswered(
      await attempt((fx) => [
        mutation(fx, { columns: { done: true }, transforms: { likes: { op: 'increment', by: 2 } } }),
        mutation(fx, { transforms: { likes: { op: 'increment', by: '3' }, version: { op: 'increment', by: -1 } } }),
        mutation(fx, { transforms: { labels: { op: 'arrayUnion', values: ['c'] } } }),
        mutation(fx, { transforms: { labels: { op: 'arrayRemove', values: ['a'] } } }),
        mutation(fx, { op: 'insert', pk: crypto.randomUUID(), columns: { user_id: fx.actor, title: 'new' }, transforms: {} }),
        mutation(fx, { op: 'delete', pk: crypto.randomUUID(), transforms: null }),
      ]),
    )

    expect(verdicts.map((verdict) => verdict.verdict)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied', 'rejected'])
    expect(verdicts[5]?.reason).toBe('RLS_DENIED')
  })
})

describe.skipIf(!reachable)('the push guard requires an hlc on every write to an hlc table', () => {
  test('an update with no hlc refuses the whole batch', async () => {
    const outcome = await attempt((fx) => [mutation(fx, { columns: { done: true }, hlc: PUSH_HLC }), mutation(fx, { columns: { title: 'late' } })], toHlcTable)

    expectRefused(outcome, 'hlc')
  })

  test('a delete with a null hlc refuses the whole batch', async () => {
    const outcome = await attempt((fx) => [mutation(fx, { columns: { done: true }, hlc: PUSH_HLC }), mutation(fx, { op: 'delete', hlc: null })], toHlcTable)

    expectRefused(outcome, 'hlc')
  })

  test('the same writes carrying an hlc pass the guard and apply', async () => {
    const verdicts = expectAnswered(
      await attempt((fx) => [mutation(fx, { columns: { title: 'stamped' }, hlc: PUSH_HLC }), mutation(fx, { op: 'delete', hlc: PUSH_HLC })], toHlcTable),
    )

    expect(verdicts.map((verdict) => verdict.verdict)).toEqual(['applied', 'applied'])
  })

  test('an arrival table takes a write with no hlc', async () => {
    const verdicts = expectAnswered(await attempt((fx) => [mutation(fx, { columns: { title: 'arrival' } })]))

    expect(verdicts.map((verdict) => verdict.verdict)).toEqual(['applied'])
  })
})

// MARK: - Row counts

describe.skipIf(!reachable)('the apply primitives count rows right after each statement', () => {
  test('an arrayRemove with no values reports no row, rather than the count of its column-type lookup', async () => {
    let affected: number | undefined

    try {
      await db!.begin(async (tx) => {
        await tx`select set_config('kizunasync.rpc', '1', true)`
        const [row] = await tx`select kizunasync._apply_array_remove('todos', gen_random_uuid(), 'labels', '[]'::jsonb) as n`

        affected = row.n as number

        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error
      }
    }
    expect(affected).toBe(0)
  })

  // The demo lets any visitor edit an anonymous visitor's todo and a todo keeps its owner, so the batch targets a todo a registered user owns.
  test('an arrayRemove on a todo the caller may not update is RLS_DENIED', async () => {
    const outcome = await attempt(
      (fx) => [mutation(fx, { columns: { done: true } }), mutation(fx, { transforms: { labels: { op: 'arrayRemove', values: ['a'] } } })],
      async (tx, fx) => {
        const [owner] = await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), false) returning id`
        const [todo] = await tx`
          insert into public.todos (id, user_id, title, labels) values (gen_random_uuid(), ${owner.id}, 'guarded', '{a,b}') returning id`

        fx.todo = todo.id as string
      },
    )
    const verdicts = expectAnswered(outcome)

    expect(verdicts.map((verdict) => verdict.reason)).toEqual(['RLS_DENIED', 'RLS_DENIED'])
  })
})
