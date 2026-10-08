/**
 * Public-demo hardening fixture against real Postgres. This fixture is applied
 * only to the public kizunasync.com demo Supabase project, through the
 * Management API; it is never applied locally or by CI. This test proves it is
 * safe to apply: every case runs the example fixture 0002_example.sql (already
 * on disk) plus 0001_public_demo_hardening.sql (read from disk and executed by
 * hand) inside one rolled-back transaction, so nothing commits and the sibling
 * suite still passes after.
 *
 *   Shared board: it survives the hardening. A visitor reads every row,
 *       writes another anonymous visitor's row, and is refused mary's.
 *   Storage surface gone: the todos bucket is private, its policies and the
 *       writable helper are gone. A permissive attachment-metadata policy a
 *       demo database carries is dropped too, so the pack's owner-only
 *       policies are the only ones on the table.
 *   Accounts: samuel/david are gone; mary has no usable password.
 *   Reaper: it drops an anonymous visitor idle for 1 hour with no todos, and
 *       any anonymous visitor idle for 6 hours. Activity is the latest of the
 *       account's creation, sign-in, token refresh, and sync, so an open tab
 *       keeps its visitor. A write as a visitor still trips the write-cap
 *       trigger with its EXECUTE revoked (Helper reach), since Postgres checks
 *       EXECUTE at trigger creation, not trigger time.
 *   Helper reach: EXECUTE on both cap trigger functions and on the reaper is
 *       revoked from anon and authenticated. The anonymity probe stays
 *       executable by `authenticated` alone: the shared-board UPDATE and DELETE
 *       policies call it as the querying user.
 *
 * pg_cron is optional (the demo hardening file guards it the same way the init pack does): this suite
 * never asserts on cron.
 *
 * Every case runs inside a rolled-back txn. Seeded visitors, todos, and
 * accounts never commit; the DB is left as found. Never resets / drops /
 * truncates. Skips loudly (named reason) when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const MARY_ID = '11111111-1111-4111-8111-111111111111'

const FOREIGN_ROW_ID = 'bbbbbbbb-0000-4000-8000-000000000002'

/** The permissive attachment-metadata policy the hardening file drops by name. */
const PERMISSIVE_METADATA_POLICY = 'todos attachment metadata is readable by all authenticated.'

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, '../pack.manifest.json'), 'utf8'),
) as { demo: string[] }
const HARDENING = MANIFEST.demo.find((name) => name.includes('hardening'))

if (HARDENING === undefined) {
  throw new Error('pack.manifest.json demo[] has no hardening file')
}
const FIXTURE_SQL = readFileSync(
  join(import.meta.dir, '../supabase/demo', HARDENING),
  'utf8',
)

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[example-public-demo] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

/** Rollback sentinel: thrown to abort db.begin() so the txn never commits. */
class Rollback extends Error {}

interface IPublicDemoTxn {
  tx: SQL

  /** A fresh anonymous auth.users row, backdated by an interval literal (e.g. '2 hours') for the reaper case. */
  mintVisitor: (age?: string) => Promise<string>

  /** A fresh REGISTERED (non-mary) auth.users row. */
  mintRegistered: () => Promise<string>

  /** Set the visitor's last_sign_in_at to `ago` (an interval literal, e.g. '10 minutes') before now. */
  stampSignIn: (visitorId: string, ago: string) => Promise<void>

  /** Give the visitor a refresh token rotated `ago` before now, as a token refresh would. */
  stampRefresh: (visitorId: string, ago: string) => Promise<void>

  /** Give the visitor a kizunasync._clients row last seen `ago` before now, as a sync would. */
  stampClientSeen: (visitorId: string, ago: string) => Promise<void>

  /** mary's seeded row, inserted only if 0002's seed did not land locally. */
  ensureMary: () => Promise<void>

  /**
   * Become a visitor: JWT claims populate auth.uid(), then drop to the
   * authenticated role so the fixture policies apply.
   */
  become: (visitorId: string) => Promise<void>

  /** Reset to the connection's own role so bookkeeping reads bypass RLS. */
  becomeSuperuser: () => Promise<void>

  /** Seed a todo bypassing RLS, as another actor's committed write would be. */
  seedTodo: (ownerId: string, title: string) => Promise<string>

  /**
   * Run one statement inside a savepoint and report its rejection instead of
   * throwing, so a refusal leaves the surrounding transaction usable and the
   * case can still read the row back.
   */
  attempt: (run: (sp: SQL) => Promise<unknown>) => Promise<TRejection>
}

/**
 * The SQLSTATE + message of a rejected statement, or null when it succeeded.
 * Bun surfaces the SQLSTATE as `errno` on PostgresError.
 */
type TRejection = { sqlstate: string; message: string } | null

async function inTxn<T>(conn: SQL, fn: (ctx: IPublicDemoTxn) => Promise<T>): Promise<T> {
  let out: T | undefined

  try {
    await conn.begin(async (tx) => {
      // The hardening file flips the todos bucket private rather than deleting its row (Supabase guards direct deletes on Storage tables); seed it the way 0002 does so the flip has a deterministic row to act on even when 0002's own insert has not landed on this connection.
      await tx`
        insert into storage.buckets (id, name, public)
        values ('todos', 'todos', true)
        on conflict (id) do nothing`
      await tx.unsafe(FIXTURE_SQL)

      const mint = async (anonymous: boolean, age?: string): Promise<string> => {
        const [user] = await tx`
          insert into auth.users (id, is_anonymous, created_at)
          values (gen_random_uuid(), ${anonymous}, now() - ${age ?? '0 seconds'}::interval)
          returning id`

        return user.id as string
      }
      out = await fn({
        tx: tx as unknown as SQL,
        mintVisitor: (age) => mint(true, age),
        mintRegistered: () => mint(false),
        stampSignIn: async (visitorId, ago) => {
          await tx`update auth.users set last_sign_in_at = now() - ${ago}::interval where id = ${visitorId}::uuid`
        },
        stampRefresh: async (visitorId, ago) => {
          await tx`
            insert into auth.refresh_tokens (user_id, revoked, created_at, updated_at)
            values (${visitorId}, false, now() - ${ago}::interval, now() - ${ago}::interval)`
        },
        stampClientSeen: async (visitorId, ago) => {
          await tx`
            insert into kizunasync._clients (client_id, user_id, last_seen)
            values (gen_random_uuid(), ${visitorId}::uuid, now() - ${ago}::interval)`
        },
        ensureMary: async () => {
          await tx`
            insert into auth.users (id, is_anonymous)
            values (${MARY_ID}::uuid, false)
            on conflict (id) do nothing`
        },
        become: async (visitorId) => {
          await tx`reset role`
          const claims = JSON.stringify({ sub: visitorId, role: 'authenticated' })

          await tx`select set_config('request.jwt.claims', ${claims}, true)`
          await tx`set local role authenticated`
        },
        becomeSuperuser: async () => {
          await tx`reset role`
        },
        seedTodo: async (ownerId, title) => {
          const [todo] = await tx`
            insert into public.todos (id, user_id, title, done)
            values (gen_random_uuid(), ${ownerId}, ${title}, false)
            returning id`

          return todo.id as string
        },
        attempt: async (run) => {
          try {
            await tx.savepoint(async (sp) => {
              await run(sp as unknown as SQL)
            })

            return null
          } catch (error) {
            const pg = error as { errno?: unknown; message?: unknown }

            return {
              sqlstate: typeof pg.errno === 'string' ? pg.errno : String(pg.errno),
              message: typeof pg.message === 'string' ? pg.message : String(error),
            }
          }
        },
      })

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (out === undefined) {
    throw new Error('inTxn: no result captured')
  }
  return out
}

describe.skipIf(!reachable)('demo fixture: public-demo hardening', () => {
  // MARK: - Shared board

  test("a visitor sees its own todo, the seeded demo owner's, and another registered user's", async () => {
    const seen = await inTxn(db!, async (ctx) => {
      await ctx.ensureMary()
      const visitor = await ctx.mintVisitor()
      const otherRegistered = await ctx.mintRegistered()
      const mine = await ctx.seedTodo(visitor, "visitor's todo")
      const marys = await ctx.seedTodo(MARY_ID, "mary's todo")
      const theirs = await ctx.seedTodo(otherRegistered, "other registrant's todo")

      await ctx.become(visitor)
      const [count] = await ctx.tx`
        select
          count(*) filter (where id = ${mine}::uuid)::int as own,
          count(*) filter (where id = ${marys}::uuid)::int as mary_row,
          count(*) filter (where id = ${theirs}::uuid)::int as foreign_row
        from public.todos`

      return {
        own: count.own as number,
        maryRow: count.mary_row as number,
        foreignRow: count.foreign_row as number,
      }
    })

    expect(seen).toEqual({ own: 1, maryRow: 1, foreignRow: 1 })
  })

  test("a visitor can update another anonymous visitor's todo", async () => {
    const outcome = await inTxn(db!, async (ctx) => {
      const author = await ctx.mintVisitor()
      const peer = await ctx.mintVisitor()
      const theirs = await ctx.seedTodo(author, 'before the peer edit')

      await ctx.become(peer)
      const rejection = await ctx.attempt(
        (sp) => sp`update public.todos set title = 'edited by a peer' where id = ${theirs}::uuid`,
      )

      await ctx.becomeSuperuser()
      const [row] = await ctx.tx`select title from public.todos where id = ${theirs}::uuid`

      return { rejection, title: row.title as string }
    })

    expect(outcome.rejection).toBeNull()
    expect(outcome.title).toBe('edited by a peer')
  })

  // The demo's RLS-refusal story on the public project: mary's row is readable by everyone and writable by nobody else, so the client has something real to be refused on.
  test("a visitor cannot update the seeded demo owner's todo", async () => {
    const title = await inTxn(db!, async (ctx) => {
      await ctx.ensureMary()
      const visitor = await ctx.mintVisitor()
      const hers = await ctx.seedTodo(MARY_ID, "mary's row")

      await ctx.become(visitor)
      await ctx.attempt((sp) => sp`update public.todos set title = 'hijacked' where id = ${hers}::uuid`)

      await ctx.becomeSuperuser()
      const [row] = await ctx.tx`select title from public.todos where id = ${hers}::uuid`

      return row.title as string
    })

    expect(title).toBe("mary's row")
  })

  // MARK: - Storage surface gone

  test('the todos bucket is private with no storage policies or writable helper', async () => {
    const state = await inTxn(db!, async (ctx) => {
      await ctx.becomeSuperuser()
      const [bucket] = await ctx.tx`select public from storage.buckets where id = 'todos'`
      const [objectPolicies] = await ctx.tx`
        select count(*)::int as n from pg_policies
        where schemaname = 'storage' and tablename = 'objects' and policyname like '%todo%'`
      const [attachmentPolicies] = await ctx.tx`
        select count(*)::int as n from pg_policies
        where schemaname = 'kizunasync' and tablename = 'attachments'
          and policyname = ${PERMISSIVE_METADATA_POLICY}`
      const [fn] = await ctx.tx`
        select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'todo_image_writable'`

      return {
        bucketPublic: bucket.public as boolean,
        objectPolicies: objectPolicies.n as number,
        attachmentPolicies: attachmentPolicies.n as number,
        writableFn: fn.n as number,
      }
    })

    expect(state).toEqual({ bucketPublic: false, objectPolicies: 0, attachmentPolicies: 0, writableFn: 0 })
  })

  test('the hardening drops a permissive attachment-metadata policy a demo database carries', async () => {
    const policies = await inTxn(db!, async (ctx) => {
      await ctx.becomeSuperuser()
      await ctx.tx.unsafe(
        `create policy "${PERMISSIVE_METADATA_POLICY}" on kizunasync.attachments for select to authenticated using (true)`,
      )
      await ctx.tx.unsafe(FIXTURE_SQL)
      const rows = await ctx.tx`
        select policyname::text as name from pg_policies
        where schemaname = 'kizunasync' and tablename = 'attachments'
        order by policyname`

      return rows.map((row: { name: string }) => row.name)
    })

    expect(policies).toEqual([
      'Attachments are updatable by their owner.',
      'Attachments are visible to their owner.',
      'Attachments are writable by their owner.',
    ])
  })

  // MARK: - Accounts

  test('mary has no usable password and samuel/david are gone', async () => {
    const state = await inTxn(db!, async (ctx) => {
      await ctx.ensureMary()
      await ctx.becomeSuperuser()
      const [mary] = await ctx.tx`
        select encrypted_password is null as no_password
        from auth.users where id = ${MARY_ID}::uuid`
      const [others] = await ctx.tx`
        select count(*)::int as n from auth.users
        where email in ('samuel@kizunasync.local', 'david@kizunasync.local')`

      return { maryNoPassword: mary.no_password as boolean, othersRemaining: others.n as number }
    })

    expect(state).toEqual({ maryNoPassword: true, othersRemaining: 0 })
  })

  test("mary's foreign row is seeded once, and re-applying the hardening file keeps it single", async () => {
    const rows = await inTxn(db!, async (ctx) => {
      await ctx.becomeSuperuser()
      const read = () => ctx.tx`
        select user_id, title from public.todos
        where id = ${FOREIGN_ROW_ID}::uuid`
      const afterFirst = await read()

      await ctx.tx.unsafe(FIXTURE_SQL)

      return { afterFirst, afterSecond: await read() }
    })
    const expected = [{ user_id: MARY_ID, title: "Mary's row: you may read it, not write it" }]

    expect(rows.afterFirst).toEqual(expected)
    expect(rows.afterSecond).toEqual(expected)
  })

  // MARK: - Reaper

  test('reap_demo_visitors drops a todo-less visitor idle for 1h and every visitor idle for 6h, and the write-cap trigger still fires for authenticated', async () => {
    const state = await inTxn(db!, async (ctx) => {
      const idleEmpty = await ctx.mintVisitor('2 hours')
      const idleWithTodo = await ctx.mintVisitor('2 hours')

      await ctx.seedTodo(idleWithTodo, 'keeps its owner alive')
      const idleAncient = await ctx.mintVisitor('7 hours')

      await ctx.seedTodo(idleAncient, 'idle too long regardless')

      const freshVisitor = await ctx.mintVisitor()

      await ctx.become(freshVisitor)
      await ctx.seedTodo(freshVisitor, 'trips the write cap trigger')

      await ctx.becomeSuperuser()
      await ctx.tx`select public.reap_demo_visitors()`
      const [remaining] = await ctx.tx`
        select
          count(*) filter (where id = ${idleEmpty}::uuid)::int as idle_empty,
          count(*) filter (where id = ${idleWithTodo}::uuid)::int as idle_with_todo,
          count(*) filter (where id = ${idleAncient}::uuid)::int as idle_ancient
        from auth.users`
      const [counter] = await ctx.tx`
        select count(*)::int as n from public.demo_write_counters where user_id = ${freshVisitor}::uuid`

      return {
        idleEmpty: remaining.idle_empty as number,
        idleWithTodo: remaining.idle_with_todo as number,
        idleAncient: remaining.idle_ancient as number,
        writeCapFired: counter.n as number,
      }
    })

    expect(state).toEqual({ idleEmpty: 0, idleWithTodo: 1, idleAncient: 0, writeCapFired: 1 })
  })

  test('reap_demo_visitors keeps a visitor whose tab is still open, whatever its age', async () => {
    const survivors = await inTxn(db!, async (ctx) => {
      const refreshedEmpty = await ctx.mintVisitor('2 hours')

      await ctx.stampRefresh(refreshedEmpty, '10 minutes')
      const syncedEmpty = await ctx.mintVisitor('2 hours')

      await ctx.stampClientSeen(syncedEmpty, '10 minutes')
      const signedInEmpty = await ctx.mintVisitor('2 hours')

      await ctx.stampSignIn(signedInEmpty, '10 minutes')
      const activeAncient = await ctx.mintVisitor('7 hours')

      await ctx.seedTodo(activeAncient, 'its owner is still here')
      await ctx.stampRefresh(activeAncient, '10 minutes')
      const syncedAncient = await ctx.mintVisitor('7 hours')

      await ctx.stampClientSeen(syncedAncient, '10 minutes')

      await ctx.tx`select public.reap_demo_visitors()`
      const [remaining] = await ctx.tx`
        select
          count(*) filter (where id = ${refreshedEmpty}::uuid)::int as refreshed_empty,
          count(*) filter (where id = ${syncedEmpty}::uuid)::int as synced_empty,
          count(*) filter (where id = ${signedInEmpty}::uuid)::int as signed_in_empty,
          count(*) filter (where id = ${activeAncient}::uuid)::int as active_ancient,
          count(*) filter (where id = ${syncedAncient}::uuid)::int as synced_ancient
        from auth.users`

      return remaining
    })

    expect(survivors).toEqual({
      refreshed_empty: 1,
      synced_empty: 1,
      signed_in_empty: 1,
      active_ancient: 1,
      synced_ancient: 1,
    })
  })

  test('reap_demo_visitors drops a visitor whose last refresh and sync are older than the idle limits', async () => {
    const remaining = await inTxn(db!, async (ctx) => {
      const staleEmpty = await ctx.mintVisitor('3 hours')

      await ctx.stampRefresh(staleEmpty, '2 hours')
      await ctx.stampClientSeen(staleEmpty, '2 hours')
      const staleWithTodo = await ctx.mintVisitor('9 hours')

      await ctx.seedTodo(staleWithTodo, 'idle for seven hours')
      await ctx.stampRefresh(staleWithTodo, '7 hours')
      await ctx.stampClientSeen(staleWithTodo, '7 hours')

      await ctx.tx`select public.reap_demo_visitors()`
      const [row] = await ctx.tx`
        select count(*)::int as n from auth.users
        where id in (${staleEmpty}::uuid, ${staleWithTodo}::uuid)`

      return row.n as number
    })

    expect(remaining).toBe(0)
  })

  // MARK: - Helper reach

  test('both cap trigger functions are unreachable while the anonymity probe stays executable', async () => {
    const state = await inTxn(db!, async (ctx) => {
      await ctx.becomeSuperuser()
      const [grants] = await ctx.tx`
        select
          has_function_privilege('anon', 'public.todo_owner_is_anonymous(uuid)', 'execute') as probe_anon,
          has_function_privilege('authenticated', 'public.todo_owner_is_anonymous(uuid)', 'execute') as probe_authenticated,
          has_function_privilege('authenticated', 'public.todos_enforce_row_cap()', 'execute') as row_cap_authenticated,
          has_function_privilege('authenticated', 'public.todos_enforce_write_cap()', 'execute') as write_cap_authenticated`

      return {
        probeAnon: grants.probe_anon as boolean,
        probeAuthenticated: grants.probe_authenticated as boolean,
        rowCapAuthenticated: grants.row_cap_authenticated as boolean,
        writeCapAuthenticated: grants.write_cap_authenticated as boolean,
      }
    })

    expect(state).toEqual({
      probeAnon: false,
      probeAuthenticated: true,
      rowCapAuthenticated: false,
      writeCapAuthenticated: false,
    })
  })

  // Supabase's default privileges grant EXECUTE on a new function in `public` to each API role by name, which a revoke from PUBLIC leaves in place; the explicit grant stands in for that entry before the hardening file runs again.
  test('the reaper is executable by no API role, even with an explicit EXECUTE grant in place', async () => {
    const state = await inTxn(db!, async (ctx) => {
      await ctx.becomeSuperuser()
      await ctx.tx`grant execute on function public.reap_demo_visitors() to anon, authenticated`
      await ctx.tx.unsafe(FIXTURE_SQL)
      const [grants] = await ctx.tx`
        select
          has_function_privilege('anon', 'public.reap_demo_visitors()', 'execute') as reaper_anon,
          has_function_privilege('authenticated', 'public.reap_demo_visitors()', 'execute') as reaper_authenticated`

      return { reaperAnon: grants.reaper_anon as boolean, reaperAuthenticated: grants.reaper_authenticated as boolean }
    })

    expect(state).toEqual({ reaperAnon: false, reaperAuthenticated: false })
  })
})
