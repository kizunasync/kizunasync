/**
 * Opt-in server-side conflict journal (P:session-guarantees-and-exactly-once-effect loser-value recording). D-conflict-journal-visibility is
 * decided: push envelopes stay verdict-only; pull may attach optional
 * `conflicts` when a delivered page includes the winning changelog seq.
 * Recording still requires `_config.conflict_journal`. Each case rolls back,
 * except the one that reads `winner_seq`: the pack fills it when the pushing
 * transaction commits, so that case commits and removes what it wrote. Skips
 * loudly when no DB is reachable.
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
    `[rpc-conflict-journal] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

class Rollback extends Error {}

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
}

interface IJournalRow {
  column_name: string
  loser_value: unknown
  winner_mutation_id: string
  conflict_mode: string
  winner_seq: string | null
}

async function pushUpdate(
  tx: SQL,
  actorId: string,
  pk: string,
  columns: Record<string, unknown>,
): Promise<{ resp: Record<string, unknown>; verdict: IVerdict }> {
  const claims = JSON.stringify({ sub: actorId, role: 'authenticated' })

  await tx`select set_config('request.jwt.claims', ${claims}, true)`
  await tx`set local role authenticated`
  const mutationId = crypto.randomUUID()
  const batch = {
    atomic: false,
    mutations: [{ mutation_id: mutationId, table: 'todos', pk, op: 'update', columns }],
  }
  const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

  await tx`reset role`
  const resp = row.resp as Record<string, unknown>
  const verdict = (resp.verdicts as IVerdict[])[0] as IVerdict

  return { resp, verdict }
}

async function conflictsForPage(
  tx: SQL,
  pk: string,
  seq: string,
): Promise<unknown> {
  const page = [
    {
      pk,
      row: { title: 'overwritten' },
      seq,
      table: 'todos',
    },
  ]
  const [row] = await tx`select kizunasync._conflicts_for_page(${page}::jsonb) as conflicts`

  return row.conflicts
}

async function journalFor(tx: SQL, pk: string): Promise<IJournalRow[]> {
  return (await tx`
    select column_name, loser_value, winner_mutation_id::text, conflict_mode, winner_seq::text
      from kizunasync._conflict_journal
     where table_name = 'todos' and pk = ${pk}
     order by id`) as IJournalRow[]
}

describe.skipIf(!reachable)('kizunasync._conflict_journal (opt-in, D-conflict-journal-visibility on pull)', () => {
  test('default off: a same-column overwrite is not journalled', async () => {
    let rows: IJournalRow[] | undefined

    try {
      await db!.begin(async (tx) => {
        const [actor] = await tx`
          insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
        const [todo] = await tx`
          insert into public.todos (id, user_id, title, done)
          values (gen_random_uuid(), ${actor.id}, 'original', false)
          returning id`
        const { verdict } = await pushUpdate(tx as unknown as SQL, actor.id, todo.id, {
          title: 'overwritten',
        })

        expect(verdict.verdict).toBe('applied')
        rows = await journalFor(tx as unknown as SQL, todo.id)

        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error
      }
    }
    expect(rows).toEqual([])
  })

  test('opt-in: a same-column overwrite records the loser; push stays verdict-only; winner_seq joins the page', async () => {
    const conn = db!
    const [config] = await conn`select conflict_journal from kizunasync._config where table_name = 'todos'`
    const journalWas = config?.conflict_journal === true
    const [actor] = await conn`
      insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
    const [todo] = await conn`
      insert into public.todos (id, user_id, title, done)
      values (gen_random_uuid(), ${actor.id}, 'original', false)
      returning id`
    let mutationId: string | null = null

    try {
      await conn`update kizunasync._config set conflict_journal = true where table_name = 'todos'`
      const { resp, verdict } = await conn.begin(async (tx) =>
        pushUpdate(tx as unknown as SQL, actor.id, todo.id, { title: 'overwritten' }),
      )

      mutationId = verdict.mutation_id
      const rows = await journalFor(conn, todo.id)
      const seq = rows[0]?.winner_seq
      const pageConflicts = seq === undefined || seq === null ? null : await conflictsForPage(conn, todo.id, seq)

      expect(verdict.verdict).toBe('applied')
      expect(resp).not.toHaveProperty('journal')
      expect(resp).not.toHaveProperty('conflicts')
      expect(Object.keys(resp).sort()).toEqual(['verdicts'])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        column_name: 'title',
        loser_value: 'original',
        winner_mutation_id: verdict.mutation_id,
        conflict_mode: 'arrival',
      })
      expect(rows[0]!.winner_seq).toBeDefined()
      expect(rows[0]!.winner_seq).not.toBeNull()
      expect(pageConflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            column_name: 'title',
            conflict_mode: 'arrival',
            loser_value: 'original',
            pk: expect.any(String),
            table: 'todos',
            winner_mutation_id: verdict.mutation_id,
          }),
        ]),
      )
    } finally {
      await conn`update kizunasync._config set conflict_journal = ${journalWas} where table_name = 'todos'`
      await conn`delete from public.todos where id = ${todo.id}::uuid`
      await conn`delete from kizunasync._changelog where pk = ${todo.id}`
      await conn`delete from kizunasync._tombstones where pk = ${todo.id}`
      await conn`delete from kizunasync._conflict_journal where pk = ${todo.id}`

      if (mutationId !== null) {
        await conn`delete from kizunasync._verdicts where mutation_id = ${mutationId}::uuid`
      }
      await conn`delete from public.demo_write_counters where user_id = ${actor.id}::uuid`
      await conn`delete from auth.users where id = ${actor.id}::uuid`
    }
  })

  test('opt-in: an equal-value update is not an overwrite', async () => {
    let rows: IJournalRow[] | undefined

    try {
      await db!.begin(async (tx) => {
        await tx`update kizunasync._config set conflict_journal = true where table_name = 'todos'`
        const [actor] = await tx`
          insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
        const [todo] = await tx`
          insert into public.todos (id, user_id, title, done)
          values (gen_random_uuid(), ${actor.id}, 'same', false)
          returning id`
        const { verdict } = await pushUpdate(tx as unknown as SQL, actor.id, todo.id, {
          title: 'same',
        })

        expect(verdict.verdict).toBe('applied')
        rows = await journalFor(tx as unknown as SQL, todo.id)

        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error
      }
    }
    expect(rows).toEqual([])
  })

  test('opt-in: a rejected write does not journal', async () => {
    let captured: { verdict: IVerdict; rows: IJournalRow[] } | undefined

    try {
      await db!.begin(async (tx) => {
        await tx`update kizunasync._config set conflict_journal = true where table_name = 'todos'`
        const [actor] = await tx`
          insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
        const [owner] = await tx`
          insert into auth.users (id, is_anonymous) values (gen_random_uuid(), false) returning id`
        const [todo] = await tx`
          insert into public.todos (id, user_id, title, done)
          values (gen_random_uuid(), ${owner.id}, 'owned', false)
          returning id`
        const { verdict } = await pushUpdate(tx as unknown as SQL, actor.id, todo.id, {
          title: 'stolen',
        })

        captured = { verdict, rows: await journalFor(tx as unknown as SQL, todo.id) }

        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error
      }
    }
    expect(captured?.verdict.verdict).toBe('rejected')
    expect(captured?.verdict.reason).toBe('RLS_DENIED')
    expect(captured?.rows).toEqual([])
  })
})
