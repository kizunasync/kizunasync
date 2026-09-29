/**
 * Preconditions and the conflict journal compare a client's value with the
 * stored cell through the column's type, against real Postgres. A client may
 * write a value in another rendering than the one `to_jsonb` gives the stored
 * row (a timestamp at another offset, an uppercase uuid): the pack casts it
 * through the column type first, so it equals the value it names. A key that
 * names no column the caller may read still answers `PRECONDITION`, a value the
 * column type refuses is that mutation's `CONSTRAINT`, and a no-op update in
 * another rendering journals nothing.
 *
 * The todos cases roll back. The journal cases need a row whose insert already
 * committed, so they build a probe table, commit its row, roll the push back,
 * and drop the table with every bookkeeping row it left. Skips loudly when no DB
 * is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const STORED_AT = '2026-01-01T00:00:00+00:00'
const SAME_INSTANT_ELSEWHERE = '2026-01-01T02:00:00+02:00'
const ANOTHER_INSTANT = '2026-01-01T02:00:01+02:00'

const JOURNAL_TABLE = '_typed_compare_journal'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-typed-compare] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
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

type TConn = Awaited<ReturnType<SQL['reserve']>>

type TColumns = Record<string, unknown>

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
  server_row?: TColumns | null
}

interface ITodoFixture {
  actor: string
  todo: string
  sibling: string
}

interface IJournalRow {
  column_name: string
  loser_value: unknown
}

// MARK: - Helpers

const update = (pk: string, columns: TColumns, precondition?: TColumns): TColumns => ({
  mutation_id: crypto.randomUUID(),
  table: 'todos',
  pk,
  op: 'update',
  columns,
  ...(precondition === undefined ? {} : { precondition }),
})

async function becomeActor(tx: SQL, actor: string): Promise<void> {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor, role: 'authenticated' })}, true)`
  await tx`set local role authenticated`
}

async function push(tx: SQL, mutations: TColumns[]): Promise<IVerdict[]> {
  const batch = { atomic: false, mutations }
  const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

  return (row.resp as { verdicts: IVerdict[] }).verdicts
}

/**
 * A fresh actor owning two todos, both stamped `created_at = STORED_AT`, inside
 * a rolled-back transaction. `body` starts as the table owner.
 */
async function inTodoTxn<T>(body: (tx: SQL, fx: ITodoFixture) => Promise<T>): Promise<T> {
  let out: T | undefined

  try {
    await db!.begin(async (tx) => {
      const [actor] = await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const [todo] = await tx`
        insert into public.todos (id, user_id, title, created_at)
        values (gen_random_uuid(), ${actor.id}, 'typed', ${STORED_AT}::timestamptz)
        returning id`
      const [sibling] = await tx`
        insert into public.todos (id, user_id, title, created_at)
        values (gen_random_uuid(), ${actor.id}, 'sibling', ${STORED_AT}::timestamptz)
        returning id`

      out = await body(tx as unknown as SQL, { actor: actor.id as string, todo: todo.id as string, sibling: sibling.id as string })

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (out === undefined) {
    throw new Error('rpc-typed-compare: no result captured from the transaction')
  }
  return out
}

async function readTodo(tx: SQL, pk: string): Promise<TColumns | null> {
  await tx`reset role`
  const [row] = await tx`select title, done from public.todos where id = ${pk}::uuid`

  return (row as TColumns | undefined) ?? null
}

/** SELECT on every todos column but `hidden`, granted column by column after the table-level grant is revoked. */
async function hideColumn(tx: SQL, hidden: string): Promise<void> {
  const columns = await tx<{ attname: string }[]>`
    select a.attname::text as attname
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.todos'::regclass and a.attnum > 0 and not a.attisdropped and a.attname <> ${hidden}
    order by a.attnum`
  const list = columns.map((column) => `"${column.attname}"`).join(', ')

  await tx.unsafe('revoke select on public.todos from authenticated')
  await tx.unsafe(`grant select (${list}) on public.todos to authenticated`)
}

// MARK: - Preconditions

describe.skipIf(!reachable)('a precondition compares through the column type', () => {
  test('a precondition written in another rendering of the stored values holds', async () => {
    const { verdicts, row } = await inTodoTxn(async (tx, fx) => {
      await becomeActor(tx, fx.actor)
      const pushed = await push(tx, [
        update(fx.todo, { title: 'renamed' }, { created_at: SAME_INSTANT_ELSEWHERE, user_id: fx.actor.toUpperCase() }),
      ])

      return { verdicts: pushed, row: await readTodo(tx, fx.todo) }
    })

    expect(verdicts.map((verdict) => [verdict.verdict, verdict.reason])).toEqual([['applied', undefined]])
    expect(row?.title).toBe('renamed')
  })

  test('a precondition naming another instant still answers PRECONDITION', async () => {
    const { verdicts, row } = await inTodoTxn(async (tx, fx) => {
      await becomeActor(tx, fx.actor)
      const pushed = await push(tx, [update(fx.todo, { title: 'renamed' }, { created_at: ANOTHER_INSTANT })])

      return { verdicts: pushed, row: await readTodo(tx, fx.todo) }
    })

    expect(verdicts[0]?.reason).toBe('PRECONDITION')
    expect(verdicts[0]?.server_row?.title).toBe('typed')
    expect(row?.title).toBe('typed')
  })

  test('a precondition key that names no column of the table answers PRECONDITION, whatever its value', async () => {
    const verdicts = await inTodoTxn(async (tx, fx) => {
      await becomeActor(tx, fx.actor)

      return push(tx, [
        update(fx.todo, { title: 'renamed' }, { no_such_column: null }),
        update(fx.todo, { title: 'renamed' }, { no_such_column: 'typed' }),
      ])
    })

    expect(verdicts.map((verdict) => verdict.reason)).toEqual(['PRECONDITION', 'PRECONDITION'])
  })

  test('a precondition on a column the caller may not read answers PRECONDITION even when it names the stored value', async () => {
    const verdicts = await inTodoTxn(async (tx, fx) => {
      await hideColumn(tx, 'likes')
      await becomeActor(tx, fx.actor)

      return push(tx, [update(fx.todo, { title: 'renamed' }, { likes: 0 })])
    })

    expect(verdicts[0]?.reason).toBe('PRECONDITION')
    expect(Object.keys(verdicts[0]?.server_row ?? {})).not.toContain('likes')
  })

  test('a precondition value the column type refuses is CONSTRAINT, and the sibling mutation still applies', async () => {
    const { verdicts, row, sibling } = await inTodoTxn(async (tx, fx) => {
      await becomeActor(tx, fx.actor)
      const pushed = await push(tx, [
        update(fx.todo, { title: 'renamed' }, { likes: 'not a number' }),
        update(fx.sibling, { done: true }),
      ])

      return { verdicts: pushed, row: await readTodo(tx, fx.todo), sibling: await readTodo(tx, fx.sibling) }
    })

    expect(verdicts.map((verdict) => [verdict.verdict, verdict.reason])).toEqual([
      ['rejected', 'CONSTRAINT'],
      ['applied', undefined],
    ])
    expect(verdicts[0]?.server_row?.title).toBe('typed')
    expect(row?.title).toBe('typed')
    expect(sibling?.done).toBe(true)
  })

  test('a delete whose precondition is written in another rendering applies', async () => {
    const { verdicts, row } = await inTodoTxn(async (tx, fx) => {
      await becomeActor(tx, fx.actor)
      const pushed = await push(tx, [
        {
          mutation_id: crypto.randomUUID(),
          table: 'todos',
          pk: fx.todo,
          op: 'delete',
          columns: {},
          precondition: { created_at: SAME_INSTANT_ELSEWHERE, user_id: fx.actor.toUpperCase() },
        },
      ])

      return { verdicts: pushed, row: await readTodo(tx, fx.todo) }
    })

    expect(verdicts.map((verdict) => [verdict.verdict, verdict.reason])).toEqual([['applied', undefined]])
    expect(row).toBeNull()
  })

  test('a delete whose precondition names another instant answers PRECONDITION and the row survives', async () => {
    const { verdicts, row } = await inTodoTxn(async (tx, fx) => {
      await becomeActor(tx, fx.actor)
      const pushed = await push(tx, [
        { mutation_id: crypto.randomUUID(), table: 'todos', pk: fx.todo, op: 'delete', columns: {}, precondition: { created_at: ANOTHER_INSTANT } },
      ])

      return { verdicts: pushed, row: await readTodo(tx, fx.todo) }
    })

    expect(verdicts[0]?.reason).toBe('PRECONDITION')
    expect(row?.title).toBe('typed')
  })
})

// MARK: - Conflict journal

/**
 * An owner-only journaled table with no server-stamped column: an update that
 * changes nothing leaves the row equal, so the tracker queues no change for it.
 * Its row is committed before the push, so no queued insert stands in for the
 * change the journal ties an overwrite to.
 */
async function withJournalRow<T>(body: (conn: TConn, fx: { owner: string; pk: string; ref: string }) => Promise<T>): Promise<T> {
  const pool = new SQL(DB_URL, { max: 1 })
  const conn = await pool.reserve()
  const fx = { owner: crypto.randomUUID(), pk: crypto.randomUUID(), ref: crypto.randomUUID() }

  try {
    await conn.unsafe(`
      create table public.${JOURNAL_TABLE} (id uuid primary key, user_id uuid not null, due_at timestamptz not null, ref uuid not null);
      alter table public.${JOURNAL_TABLE} enable row level security;
      grant select, insert, update, delete on public.${JOURNAL_TABLE} to authenticated;
      create policy typed_owner on public.${JOURNAL_TABLE} for all to authenticated
        using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
      create trigger kizunasync_track_change after insert or update on public.${JOURNAL_TABLE}
        for each row execute function kizunasync.track_change();
      insert into kizunasync._config (table_name, sync_mode, bucket_column, conflict_mode, conflict_journal, min_schema_version, register_clients)
      values ('${JOURNAL_TABLE}', 'read-write', 'user_id', 'arrival', true, 1, false);
    `)
    await conn.unsafe(`insert into public.${JOURNAL_TABLE} (id, user_id, due_at, ref) values ($1, $2, $3, $4)`, [
      fx.pk,
      fx.owner,
      STORED_AT,
      fx.ref,
    ])

    return await body(conn, fx)
  } finally {
    await conn`rollback`.catch(() => undefined)
    await conn.unsafe(`drop table if exists public.${JOURNAL_TABLE} cascade`)
    await conn`delete from kizunasync._changelog where table_name = ${JOURNAL_TABLE}`
    await conn`delete from kizunasync._conflict_journal where table_name = ${JOURNAL_TABLE}`
    await conn`delete from kizunasync._config where table_name = ${JOURNAL_TABLE}`
    conn.release()
    await pool.end()
  }
}

/** Pushes one update as the owner and reads the journal and the queued changes before the transaction rolls back. */
async function pushJournaled(conn: TConn, fx: { owner: string; pk: string }, columns: TColumns): Promise<{ verdict: IVerdict | undefined; journal: IJournalRow[]; queued: number }> {
  await conn`begin`
  await conn`select set_config('request.jwt.claims', ${JSON.stringify({ sub: fx.owner, role: 'authenticated' })}, true)`
  await conn`set local role authenticated`
  const batch = { atomic: false, mutations: [{ mutation_id: crypto.randomUUID(), table: JOURNAL_TABLE, pk: fx.pk, op: 'update', columns }] }
  const [row] = await conn`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

  await conn`reset role`
  const journal = (await conn`
    select column_name, loser_value from kizunasync._conflict_journal where table_name = ${JOURNAL_TABLE} order by column_name`) as IJournalRow[]
  const [queued] = await conn`select count(*)::int as n from kizunasync._change_pending where table_name = ${JOURNAL_TABLE}`

  await conn`rollback`

  return { verdict: (row.resp as { verdicts: IVerdict[] }).verdicts[0], journal, queued: queued.n as number }
}

describe.skipIf(!reachable)('the conflict journal compares through the column type', () => {
  test('a no-op update written in another rendering applies, queues no change, and journals nothing', async () => {
    const outcome = await withJournalRow((conn, fx) =>
      pushJournaled(conn, fx, { due_at: SAME_INSTANT_ELSEWHERE, ref: fx.ref.toUpperCase() }),
    )

    expect(outcome.verdict?.verdict).toBe('applied')
    expect(outcome.queued).toBe(0)
    expect(outcome.journal).toEqual([])
  })

  test('an overwrite journals only the columns whose typed value changed', async () => {
    const outcome = await withJournalRow((conn, fx) =>
      pushJournaled(conn, fx, { due_at: ANOTHER_INSTANT, ref: fx.ref.toUpperCase() }),
    )

    expect(outcome.verdict?.verdict).toBe('applied')
    expect(outcome.queued).toBe(1)
    expect(outcome.journal).toEqual([{ column_name: 'due_at', loser_value: STORED_AT }])
  })
})
