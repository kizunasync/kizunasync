/**
 * Postgres column-level privileges on a synced table, against the real stack.
 *
 * `revoke select on public.todos from authenticated` followed by a column grant
 * leaves the role holding SELECT on every column but one. The pack renders rows
 * from that readable projection instead of referencing the whole row, so:
 *   (a) a pulled row omits the column the role may not read;
 *   (b,c,d) a push writing a column the role may not INSERT/UPDATE is one
 *       COLUMN_DENIED verdict, with no partial apply and no inserted row;
 *   (e,f) an unreadable id or bucket column refuses the whole pull with KZL02;
 *   (g) a conflict-journal entry never names a column the page does not carry;
 *   (h) full table grants behave exactly as they did before;
 *   (i) DELETE is a table privilege, so a delete without it is COLUMN_DENIED too;
 *   (j) a generated column is never writable, so a write naming it is COLUMN_DENIED.
 *
 * Every grant edit is transaction-local and rolled back, so a concurrent
 * conformance run against the same database never observes the restricted ACL.
 * The committed fixture (one owner, one todo) is what gives pull a deliverable
 * row: the commit-status horizon never delivers the pulling transaction's own
 * writes. Skips loudly when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const HIDDEN_COLUMN = 'likes'
const BUCKET_COLUMN = 'user_id'
const FIXTURE_TITLE = 'column-privileges fixture'
const PAGE_LIMIT = 500

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-column-privileges] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Types

/** Rollback sentinel: aborts db.begin() so each case's grant edits never commit. */
class Rollback extends Error {}

type TPrivilege = 'select' | 'insert' | 'update'

interface IFixture {
  ownerId: string
  todoId: string

  /** The committed changelog seq of the fixture insert: the delivered row's seq. */
  seq: string

  /** One below `seq`, so a pull from it delivers the fixture row. */
  cursor: string
}

interface IColumnRestriction {
  hidden: string[]
  privileges: TPrivilege[]
}

interface IPullRequest {
  cursor: string
  params: Record<string, string>
}

interface IConflict {
  column_name: string
  pk: string
  table: string
}

interface IPulledRow {
  pk: string
  seq: string
  table: string
  row: Record<string, unknown>
}

interface IPullPage {
  conflicts?: IConflict[]
  cursor: string
  has_more: boolean
  rows: IPulledRow[]
  signal: unknown
  tombstones: unknown[]
}

interface IRefusal {
  message: string
  sqlstate: string | null
}

interface IDeleteAttempt {
  verdict: IVerdict
  surviving: string
}

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
  server_row?: Record<string, unknown> | null
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

// MARK: - Committed fixture

/**
 * Owner plus one todo, COMMITTED, then removed before the case returns. The
 * commit-status horizon never delivers the pulling transaction's own writes, so
 * a rolled-back row would never reach a page. Bun runs a file's root-level hooks
 * in the run-wide root scope, so the fixture is per case rather than per file:
 * a row left committed across the whole run moves the global changelog high
 * water under the conformance harness.
 */
const createFixture = async (): Promise<IFixture> => {
  const conn = db!
  const [owner] = await conn`
    insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
  const ownerId = owner.id as string
  const [todo] = await conn`
    insert into public.todos (id, user_id, title, done, likes)
    values (gen_random_uuid(), ${ownerId}, ${FIXTURE_TITLE}, false, 7)
    returning id`
  const todoId = todo.id as string
  const [change] = await conn`
    select seq::text as seq
    from kizunasync._changelog
    where table_name = 'todos' and pk = ${todoId}::uuid
    order by seq desc
    limit 1`
  const seq = change.seq as string

  return { ownerId, todoId, seq, cursor: (BigInt(seq) - 1n).toString() }
}

const dropFixture = async (fx: IFixture): Promise<void> => {
  const conn = db!

  await conn`delete from public.todos where user_id = ${fx.ownerId}::uuid`
  await conn`delete from kizunasync._changelog where pk = ${fx.todoId}::uuid`
  await conn`delete from kizunasync._tombstones where pk = ${fx.todoId}::uuid`
  await conn`delete from kizunasync._clients where user_id = ${fx.ownerId}::uuid`
  await conn`delete from auth.users where id = ${fx.ownerId}::uuid`
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

/**
 * One committed fixture, one rolled-back transaction around `body`, then the
 * fixture is removed. The grant edits `body` makes never commit, so a concurrent
 * conformance run never observes the restricted ACL.
 */
async function inFixtureTxn<T>(
  body: (tx: SQL, fx: IFixture) => Promise<T>,
): Promise<{ fixture: IFixture; value: T }> {
  const fixture = await createFixture()

  try {
    let out: T | undefined

    try {
      await db!.begin(async (tx) => {
        out = await body(tx as unknown as SQL, fixture)

        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error
      }
    }
    if (out === undefined) {
      throw new Error('rpc-column-privileges: no result captured from the transaction')
    }
    return { fixture, value: out }
  } finally {
    await dropFixture(fixture)
  }
}

const becomeOwner = async (tx: SQL, ownerId: string): Promise<void> => {
  const claims = JSON.stringify({ sub: ownerId, role: 'authenticated' })

  await tx`select set_config('request.jwt.claims', ${claims}, true)`
  await tx`set local role authenticated`
}

/**
 * Re-grants each privilege column by column, minus the hidden ones. A column
 * revoke alone does nothing while the table-level grant stands, so the
 * table-level privilege is revoked first. Column names come from the catalog so
 * the fixture never drifts from the demo table.
 */
const restrictColumns = async (tx: SQL, restriction: IColumnRestriction): Promise<void> => {
  const columns = await tx<{ attname: string }[]>`
    select a.attname::text as attname
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.todos'::regclass
      and a.attnum > 0
      and not a.attisdropped
    order by a.attnum`
  const kept = columns
    .map((column) => column.attname)
    .filter((name) => !restriction.hidden.includes(name))

  expect(kept.length).toBe(columns.length - restriction.hidden.length)
  const list = kept.map((name) => `"${name}"`).join(', ')

  for (const privilege of restriction.privileges) {
    await tx.unsafe(`revoke ${privilege} on public.todos from authenticated`)
    await tx.unsafe(`grant ${privilege} (${list}) on public.todos to authenticated`)
  }
}

const pullPage = async (tx: SQL, request: IPullRequest): Promise<IPullPage> => {
  const buckets = [{ table: 'todos', params: request.params }]
  const [row] = await tx<{ resp: IPullPage }[]>`
    select kizunasync.pull(${buckets}::jsonb, ${request.cursor}, 1, ${PAGE_LIMIT}) as resp`

  return row.resp
}

const pullRefusal = async (tx: SQL, request: IPullRequest): Promise<IRefusal> => {
  try {
    await pullPage(tx, request)
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      sqlstate: sqlstateOf(error),
    }
  }
  throw new Error('rpc-column-privileges: expected the pull to be refused, got a page')
}

const pushMutation = async (tx: SQL, mutation: Record<string, unknown>): Promise<IVerdict> => {
  const batch = { atomic: false, mutations: [mutation] }
  const [row] = await tx<{ resp: { verdicts: IVerdict[] } }[]>`
    select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`
  const [verdict] = row.resp.verdicts

  if (verdict === undefined) {
    throw new Error('rpc-column-privileges: push returned no verdict')
  }
  return verdict
}

const seedJournalEntry = async (tx: SQL, fx: IFixture, column: string): Promise<void> => {
  await tx`
    insert into kizunasync._conflict_journal (
      table_name, pk, column_name, loser_value, winner_mutation_id, conflict_mode, winner_seq
    ) values (
      'todos', ${fx.todoId}::uuid, ${column}, '3'::jsonb, gen_random_uuid(), 'arrival', ${fx.seq}::bigint
    )`
}

const deliveredRow = (page: IPullPage, pk: string): IPulledRow => {
  const row = page.rows.find((candidate) => candidate.pk === pk)

  if (row === undefined) {
    throw new Error(`rpc-column-privileges: the fixture row ${pk} was not delivered`)
  }
  return row
}

const conflictColumnsFor = (page: IPullPage, pk: string): string[] =>
  (page.conflicts ?? []).filter((entry) => entry.pk === pk).map((entry) => entry.column_name)

// MARK: - Pull projection

describe.skipIf(!reachable)('pull renders only the columns the role may select', () => {
  test('a delivered row omits an unreadable column and keeps the rest', async () => {
    const { fixture, value: page } = await inFixtureTxn(async (tx, fx) => {
      await restrictColumns(tx, { hidden: [HIDDEN_COLUMN], privileges: ['select'] })
      await becomeOwner(tx, fx.ownerId)

      return pullPage(tx, { cursor: fx.cursor, params: {} })
    })
    const row = deliveredRow(page, fixture.todoId)

    expect(page.signal).toBeNull()
    expect(Object.keys(row.row)).not.toContain(HIDDEN_COLUMN)
    expect(row.row.id).toBe(fixture.todoId)
    expect(row.row.title).toBe(FIXTURE_TITLE)
  })

  test('full table grants deliver every column and apply an update', async () => {
    const { fixture, value: captured } = await inFixtureTxn(async (tx, fx) => {
      await becomeOwner(tx, fx.ownerId)
      const page = await pullPage(tx, { cursor: fx.cursor, params: {} })
      const verdict = await pushMutation(tx, {
        mutation_id: crypto.randomUUID(),
        table: 'todos',
        pk: fx.todoId,
        op: 'update',
        columns: { [HIDDEN_COLUMN]: 11 },
      })

      return { page, verdict }
    })
    const row = deliveredRow(captured.page, fixture.todoId)

    expect(Object.keys(row.row)).toContain(HIDDEN_COLUMN)
    expect(row.row.likes).toBe(7)
    expect(captured.verdict.verdict).toBe('applied')
  })
})

// MARK: - Push column gate

describe.skipIf(!reachable)('push refuses a mutation writing a denied column', () => {
  test('an update touching only permitted columns is applied', async () => {
    const { value: verdict } = await inFixtureTxn(async (tx, fx) => {
      await restrictColumns(tx, {
        hidden: [HIDDEN_COLUMN],
        privileges: ['select', 'insert', 'update'],
      })
      await becomeOwner(tx, fx.ownerId)

      return pushMutation(tx, {
        mutation_id: crypto.randomUUID(),
        table: 'todos',
        pk: fx.todoId,
        op: 'update',
        columns: { title: 'renamed under a column grant' },
      })
    })

    expect(verdict.verdict).toBe('applied')
    expect(verdict.reason).toBeUndefined()
  })

  test('an update touching a denied column is COLUMN_DENIED with a projected server_row', async () => {
    const { value: verdict } = await inFixtureTxn(async (tx, fx) => {
      await restrictColumns(tx, {
        hidden: [HIDDEN_COLUMN],
        privileges: ['select', 'insert', 'update'],
      })
      await becomeOwner(tx, fx.ownerId)

      return pushMutation(tx, {
        mutation_id: crypto.randomUUID(),
        table: 'todos',
        pk: fx.todoId,
        op: 'update',
        columns: { [HIDDEN_COLUMN]: 3 },
      })
    })

    expect(verdict.verdict).toBe('rejected')
    expect(verdict.reason).toBe('COLUMN_DENIED')
    expect(verdict.server_row).not.toBeNull()
    expect(Object.keys(verdict.server_row ?? {})).not.toContain(HIDDEN_COLUMN)
    expect(verdict.server_row?.title).toBe(FIXTURE_TITLE)
  })

  test('an insert carrying a denied column is COLUMN_DENIED and writes no row', async () => {
    const newPk = crypto.randomUUID()
    const { value: captured } = await inFixtureTxn(async (tx, fx) => {
      await restrictColumns(tx, {
        hidden: [HIDDEN_COLUMN],
        privileges: ['select', 'insert', 'update'],
      })
      await becomeOwner(tx, fx.ownerId)
      const verdict = await pushMutation(tx, {
        mutation_id: crypto.randomUUID(),
        table: 'todos',
        pk: newPk,
        op: 'insert',
        columns: { user_id: fx.ownerId, title: 'denied insert', [HIDDEN_COLUMN]: 1 },
      })

      await tx`reset role`
      const [count] = await tx<{ present: string }[]>`
        select count(*)::text as present from public.todos where id = ${newPk}::uuid`

      return { verdict, present: count.present }
    })

    expect(captured.verdict.verdict).toBe('rejected')
    expect(captured.verdict.reason).toBe('COLUMN_DENIED')
    expect(captured.present).toBe('0')
  })
})

// MARK: - Pull column policy

describe.skipIf(!reachable)('pull refuses a table whose key columns are unreadable', () => {
  test('an unreadable id raises KZL02 naming the table and the column', async () => {
    const { value: refusal } = await inFixtureTxn(async (tx, fx) => {
      await restrictColumns(tx, { hidden: ['id'], privileges: ['select'] })
      await becomeOwner(tx, fx.ownerId)

      return pullRefusal(tx, { cursor: fx.cursor, params: {} })
    })

    expect(refusal.sqlstate).toBe('KZL02')
    expect(refusal.message).toContain('"todos"')
    expect(refusal.message).toContain('"id"')
    expect(refusal.message).toContain('is not readable by role')
  })

  test('an unreadable bucket column raises KZL02 on a bucketed table', async () => {
    const { value: refusal } = await inFixtureTxn(async (tx, fx) => {
      await tx`update kizunasync._config set bucket_column = ${BUCKET_COLUMN} where table_name = 'todos'`
      await restrictColumns(tx, { hidden: [BUCKET_COLUMN], privileges: ['select'] })
      await becomeOwner(tx, fx.ownerId)

      return pullRefusal(tx, { cursor: fx.cursor, params: { [BUCKET_COLUMN]: fx.ownerId } })
    })

    expect(refusal.sqlstate).toBe('KZL02')
    expect(refusal.message).toContain('"todos"')
    expect(refusal.message).toContain(`"${BUCKET_COLUMN}"`)
  })
})

// MARK: - Conflict journal projection

describe.skipIf(!reachable)('conflicts never name a column the page withheld', () => {
  test('a journal entry for a readable column rides the delivered page', async () => {
    const { fixture, value: page } = await inFixtureTxn(async (tx, fx) => {
      await seedJournalEntry(tx, fx, HIDDEN_COLUMN)
      await becomeOwner(tx, fx.ownerId)

      return pullPage(tx, { cursor: fx.cursor, params: {} })
    })

    expect(conflictColumnsFor(page, fixture.todoId)).toContain(HIDDEN_COLUMN)
  })

  test('a journal entry for an unreadable column is dropped from the page', async () => {
    const { fixture, value: page } = await inFixtureTxn(async (tx, fx) => {
      await seedJournalEntry(tx, fx, HIDDEN_COLUMN)
      await restrictColumns(tx, { hidden: [HIDDEN_COLUMN], privileges: ['select'] })
      await becomeOwner(tx, fx.ownerId)

      return pullPage(tx, { cursor: fx.cursor, params: {} })
    })

    expect(deliveredRow(page, fixture.todoId)).toBeDefined()
    expect(conflictColumnsFor(page, fixture.todoId)).toEqual([])
  })
})

// MARK: - Delete privilege

/**
 * DELETE is not column-grantable, so the gate asks has_table_privilege instead.
 * Both cases delete the same fixture row, which only the rollback restores.
 */
describe.skipIf(!reachable)('delete needs the table-level DELETE privilege', () => {
  const deleteFixtureRow = async (tx: SQL, fx: IFixture): Promise<IDeleteAttempt> => {
    await becomeOwner(tx, fx.ownerId)
    const verdict = await pushMutation(tx, {
      mutation_id: crypto.randomUUID(),
      table: 'todos',
      pk: fx.todoId,
      op: 'delete',
      columns: {},
    })

    await tx`reset role`
    const [row] = await tx<{ surviving: string }[]>`
      select count(*)::text as surviving from public.todos where id = ${fx.todoId}::uuid`

    return { verdict, surviving: row.surviving }
  }

  test('a delete with DELETE revoked is COLUMN_DENIED and the row survives', async () => {
    const { value: attempt } = await inFixtureTxn(async (tx, fx) => {
      await tx.unsafe('revoke delete on public.todos from authenticated')

      return deleteFixtureRow(tx, fx)
    })

    expect(attempt.verdict.verdict).toBe('rejected')
    expect(attempt.verdict.reason).toBe('COLUMN_DENIED')
    expect(attempt.surviving).toBe('1')
  })

  test('the same delete with the grant in place is applied', async () => {
    const { value: attempt } = await inFixtureTxn(deleteFixtureRow)

    expect(attempt.verdict.verdict).toBe('applied')
    expect(attempt.surviving).toBe('0')
  })
})

// MARK: - Generated columns

/**
 * Postgres computes a generated column itself, so a write naming one raises
 * 428C9 however the role's privileges read. The column gate leaves generated
 * columns out of the writable set, so the mutation is COLUMN_DENIED before any
 * apply. The column exists only inside each case's rolled-back transaction.
 */
describe.skipIf(!reachable)('a generated column is not writable', () => {
  const GENERATED_COLUMN = 'title_length'

  const addGeneratedColumn = async (tx: SQL): Promise<void> => {
    await tx.unsafe(`alter table public.todos add column ${GENERATED_COLUMN} integer generated always as (length(title)) stored`)
  }

  test('an update naming a generated column is COLUMN_DENIED with the rendered row', async () => {
    const { value: verdict } = await inFixtureTxn(async (tx, fx) => {
      await addGeneratedColumn(tx)
      await becomeOwner(tx, fx.ownerId)

      return pushMutation(tx, {
        mutation_id: crypto.randomUUID(),
        table: 'todos',
        pk: fx.todoId,
        op: 'update',
        columns: { title: 'short', [GENERATED_COLUMN]: 5 },
      })
    })

    expect(verdict.verdict).toBe('rejected')
    expect(verdict.reason).toBe('COLUMN_DENIED')
    expect(verdict.server_row?.title).toBe(FIXTURE_TITLE)
    expect(verdict.server_row?.[GENERATED_COLUMN]).toBe(FIXTURE_TITLE.length)
  })

  test('an insert naming a generated column is COLUMN_DENIED and writes no row', async () => {
    const newPk = crypto.randomUUID()
    const { value: captured } = await inFixtureTxn(async (tx, fx) => {
      await addGeneratedColumn(tx)
      await becomeOwner(tx, fx.ownerId)
      const verdict = await pushMutation(tx, {
        mutation_id: crypto.randomUUID(),
        table: 'todos',
        pk: newPk,
        op: 'insert',
        columns: { user_id: fx.ownerId, title: 'generated insert', [GENERATED_COLUMN]: 16 },
      })

      await tx`reset role`
      const [count] = await tx<{ present: string }[]>`
        select count(*)::text as present from public.todos where id = ${newPk}::uuid`

      return { verdict, present: count.present }
    })

    expect(captured.verdict.reason).toBe('COLUMN_DENIED')
    expect(captured.present).toBe('0')
  })

  test('an update of the other columns applies and Postgres recomputes the generated one', async () => {
    const { value: captured } = await inFixtureTxn(async (tx, fx) => {
      await addGeneratedColumn(tx)
      await becomeOwner(tx, fx.ownerId)
      const verdict = await pushMutation(tx, {
        mutation_id: crypto.randomUUID(),
        table: 'todos',
        pk: fx.todoId,
        op: 'update',
        columns: { title: 'short' },
      })

      await tx`reset role`
      const [row] = await tx.unsafe(`select ${GENERATED_COLUMN} as length from public.todos where id = $1`, [fx.todoId])

      return { verdict, length: row.length as number }
    })

    expect(captured.verdict.verdict).toBe('applied')
    expect(captured.length).toBe('short'.length)
  })
})
