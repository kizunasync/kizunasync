/**
 * Continuation-page fencing: a pull that fills the page limit while a writer
 * holds a change open delivers the committed backlog in keyset pages, and the
 * held change arrives from the continuation cursor once it commits. The corpus
 * never combines pagination with a held transaction, and the other live fencing
 * tests stay under limit 500, so they never reach `_pull_page`'s continuation
 * branch.
 *
 * Drives the public `kizunasync.pull` RPC across two connections. Cleans up
 * its own rows. Skips loudly when no DB.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const PAGE = 500
const BACKLOG = PAGE + 1
const MAX_DRAIN_PAGES = 8

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[pull-fencing-continuation] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

interface IRow {
  pk: string
  seq: string
  table: string
  row: { title?: string } & Record<string, unknown>
}
interface IPullResponse {
  cursor: string
  has_more: boolean
  rows: IRow[]
}

/**
 * Bun binds a JS array as a JSON scalar, which Postgres reads as a malformed
 * array literal (22P02). Encode the Postgres text form `{a,b}` and cast it, the
 * same shape `conformance/pg-reference-server.ts` uses for `text[]`. Every id
 * here is a server-generated uuid, so no element needs quoting.
 */
const uuidArray = (ids: string[]): string => `{${ids.join(',')}}`

async function pullImpl(owner: string, cursor: string, limit: number): Promise<IPullResponse> {
  const w = await new SQL(DB_URL, { max: 1 }).reserve()

  try {
    const claims = JSON.stringify({ sub: owner, role: 'authenticated' })

    await w`begin`
    await w`select set_config('request.jwt.claims', ${claims}, true)`
    await w`set local role authenticated`
    const buckets = [{ table: 'todos', params: { user_id: owner } }]
    const [r] = await w`select kizunasync.pull(${buckets}::jsonb, ${cursor}, 1, ${limit}) as resp`

    await w`commit`

    return r.resp as IPullResponse
  } finally {
    await w.release()
  }
}

describe.skipIf(!reachable)('pull continuation delivers a write held open across a full page', () => {
  test('a continuation page delivers the committed backlog during the hold, and its cursor later delivers the held row', async () => {
    const conn = db!
    const [owner] = await conn`
      insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
    const ownerId = owner.id as string
    const [base] = await conn`
      insert into public.todos (id, user_id, title, done)
      values (gen_random_uuid(), ${ownerId}, 'base', false) returning id`
    const baseId = base.id as string
    const [ins] = await conn`
      select seq from kizunasync._changelog where pk = ${baseId}::uuid order by seq desc limit 1`
    const baseCursor = String(ins.seq)

    const writer = await new SQL(DB_URL, { max: 1 }).reserve()
    const backlogIds: string[] = []
    let heldId = ''

    try {
      await writer`begin`
      const [held] = await writer`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${ownerId}, 'held', false) returning id`

      heldId = held.id as string

      for (let i = 0; i < BACKLOG; i += 1) {
        const [row] = await conn`
          insert into public.todos (id, user_id, title, done)
          values (gen_random_uuid(), ${ownerId}, ${`b${i}`}, false) returning id`

        backlogIds.push(row.id as string)
      }

      const pull1 = await pullImpl(ownerId, baseCursor, PAGE)

      expect(pull1.has_more).toBe(true)
      expect(pull1.rows).toHaveLength(PAGE)
      expect(pull1.rows.every((row) => backlogIds.includes(row.pk))).toBe(true)

      await writer`commit`
      const delivered = new Map(pull1.rows.map((row) => [row.pk, row.row.title]))
      let cursor = pull1.cursor

      for (let page = 0; page < MAX_DRAIN_PAGES; page++) {
        const next = await pullImpl(ownerId, cursor, PAGE)

        for (const row of next.rows) {
          delivered.set(row.pk, row.row.title)
        }
        cursor = next.cursor

        if (!next.has_more) {
          break
        }
      }

      expect(delivered.get(heldId)).toBe('held')
      expect(backlogIds.filter((id) => !delivered.has(id))).toEqual([])
    } finally {
      await writer`rollback`.catch(() => undefined)
      await writer.release()

      // Cleanup: leave the DB as found whatever asserted.
      const ids = [baseId, heldId, ...backlogIds].filter((id) => id.length > 0)

      await conn`delete from public.todos where user_id = ${ownerId}::uuid`
      await conn`delete from kizunasync._changelog where pk = any(${uuidArray(ids)}::uuid[])`
      await conn`delete from kizunasync._tombstones where pk = any(${uuidArray(ids)}::uuid[])`
      await conn`delete from kizunasync._clients where user_id = ${ownerId}::uuid`
      await conn`delete from kizunasync._bucket_grants where user_id = ${ownerId}::uuid`
      await conn`delete from auth.users where id = ${ownerId}::uuid`
    }
  })
})
