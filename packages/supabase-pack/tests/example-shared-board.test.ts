/**
 * Demo fixture shared board and abuse caps (the example fixture
 * 0002_example.sql) against real Postgres. RLS and the caps are
 * integrator-declared, not protocol; the corpus never covers them.
 *
 *   Shared board: every signed-in visitor reads every row, and any visitor
 *       edits or deletes a row an anonymous visitor owns. A REGISTERED owner's
 *       row (mary, the demo's RLS-refusal subject) stays readable by everyone,
 *       writable only by her. An insert is still stamped as the caller.
 *   Row cap: the 101st todo of one visitor raises SQLSTATE 23514.
 *   Churn cap: the 301st write of one visitor inside a minute raises 23514.
 *   Attachments and helpers: a visitor reads no other visitor's attachment
 *       metadata row, and an image path names the todo's owner and then the
 *       todo. PUBLIC and anon execute no fixture function, `authenticated`
 *       executes only the two policy helpers, and no API role runs the reaper,
 *       even where the platform grants EXECUTE on new functions. The reaper
 *       runs with an empty search_path.
 *   Title length: a title holds at most 50 code points. The 51st raises
 *       SQLSTATE 23514, push answers it with a CONSTRAINT rejection, and the
 *       fixture's title-length section adds the check to a todos table that
 *       lacks it.
 *   Fixed owner: a todo keeps the user_id it was inserted with. A direct
 *       update that changes it raises SQLSTATE 23514, push answers it with a
 *       CONSTRAINT rejection while its siblings apply, and a push insert that
 *       names user_id and an ordinary title update still apply.
 *
 * 23514 (check_violation) is the coded raise, a class-23 integrity failure that
 * push answers as the capped write's own CONSTRAINT rejection. A write the USING
 * clause hides touches zero rows and raises nothing; a WITH CHECK violation on
 * insert raises 42501.
 *
 * Every case runs inside a rolled-back txn. Seeded visitors, todos, and counter
 * buckets never commit; the DB is left as found. Never resets / drops /
 * truncates. Skips loudly (named reason) when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    `[example-shared-board] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

/** The caps are one row per visitor per minute, so they must not be shared. */
const ROW_CAP = 100
const WRITE_CAP = 300

/** SQLSTATE of a WITH CHECK violation: the insert claimed an owner it may not claim. */
const RLS_WITH_CHECK = '42501'

/** The fixture's title cap, in code points, and the check constraint that enforces it. */
const TITLE_MAX_LENGTH = 50
const TITLE_CHECK = 'todos_title_length'

/** The fixture's trigger that keeps a todo's user_id fixed after insert. */
const OWNER_TRIGGER = 'todos_keep_user_id'

/** Every function the fixture defines, and whether `authenticated` executes it: only the helpers its policies call do. */
const EXAMPLE_FUNCTIONS = {
  'public.todos_touch_updated_at()': false,
  'public.todos_keep_user_id()': false,
  'public.todo_owner_is_anonymous(uuid)': true,
  'public.todo_image_writable(text)': true,
  'public.todos_enforce_row_cap()': false,
  'public.todos_enforce_write_cap()': false,
  'public.reap_demo_visitors()': false,
} as const satisfies Record<string, boolean>

interface IFunctionGrants {
  signature: string
  public: boolean
  anon: boolean
  authenticated: boolean
}

const EXAMPLE_SQL = readFileSync(join(import.meta.dir, '../supabase/migrations/0002_example.sql'), 'utf8')

/** The fixture's own EXECUTE statements, re-runnable on their own. */
const EXAMPLE_FUNCTION_PRIVILEGES = EXAMPLE_SQL.match(/^(?:grant|revoke) [^;]* on function public\.[^;]*;/gm) ?? []

/** The grants every fixture function should carry: nothing for PUBLIC or anon, EXECUTE for authenticated on the policy helpers. */
const EXPECTED_FUNCTION_GRANTS: IFunctionGrants[] = Object.entries(EXAMPLE_FUNCTIONS).map(([signature, authenticated]) => ({
  signature,
  public: false,
  anon: false,
  authenticated,
}))

/** Who may execute each fixture function, in the matrix's order. */
async function readFunctionGrants(conn: SQL): Promise<IFunctionGrants[]> {
  const signatures = Object.keys(EXAMPLE_FUNCTIONS)
  const rows = await conn<IFunctionGrants[]>`
    select
      f.signature,
      has_function_privilege('public', f.signature, 'execute') as public,
      has_function_privilege('anon', f.signature, 'execute') as anon,
      has_function_privilege('authenticated', f.signature, 'execute') as authenticated
    from jsonb_array_elements_text(${signatures}::jsonb) with ordinality as f(signature, position)
    order by f.position`

  return rows.map((row) => ({ ...row }))
}

/** The statements between two MARK lines of the example fixture. */
function exampleSection(from: string, to: string): string {
  const start = EXAMPLE_SQL.indexOf(`-- MARK: - ${from}`)
  const end = EXAMPLE_SQL.indexOf(`-- MARK: - ${to}`)

  if (start < 0 || end < start) {
    throw new Error(`0002_example.sql has no section "${from}" before "${to}"`)
  }
  return EXAMPLE_SQL.slice(start, end)
}

/** Rollback sentinel: thrown to abort db.begin() so the txn never commits. */
class Rollback extends Error {}

interface IVisitorTxn {
  tx: SQL

  /** A fresh anonymous auth.users row: one demo visitor. */
  mintVisitor: () => Promise<string>

  /** A fresh REGISTERED auth.users row: a mary-shaped owner. */
  mintRegistered: () => Promise<string>

  /**
   * Become a visitor: JWT claims populate auth.uid(), then drop to the
   * authenticated role so the fixture policies and caps apply.
   */
  become: (visitorId: string) => Promise<void>

  /** Reset to the connection's own role so bookkeeping reads bypass RLS. */
  becomeSuperuser: () => Promise<void>

  /** Seed a todo bypassing RLS, as another actor's committed write would be. */
  seedTodo: (ownerId: string, title: string) => Promise<string>
}

async function inTxn<T>(conn: SQL, fn: (ctx: IVisitorTxn) => Promise<T>): Promise<T> {
  let out: T | undefined

  try {
    await conn.begin(async (tx) => {
      const mint = async (anonymous: boolean): Promise<string> => {
        const [user] = await tx`
          insert into auth.users (id, is_anonymous)
          values (gen_random_uuid(), ${anonymous})
          returning id`

        return user.id as string
      }
      out = await fn({
        tx: tx as unknown as SQL,
        mintVisitor: () => mint(true),
        mintRegistered: () => mint(false),
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

/**
 * The SQLSTATE + message of a rejected statement, or null when it succeeded.
 * Bun surfaces the SQLSTATE as `errno` on PostgresError. A rejection aborts the
 * surrounding transaction, so a case that expects one issues nothing after it.
 */
type TRejection = { sqlstate: string; message: string } | null

async function rejectionOf(run: () => Promise<unknown>): Promise<TRejection> {
  try {
    await run()

    return null
  } catch (error) {
    const pg = error as { errno?: unknown; message?: unknown }

    return {
      sqlstate: typeof pg.errno === 'string' ? pg.errno : String(pg.errno),
      message: typeof pg.message === 'string' ? pg.message : String(error),
    }
  }
}

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
}

/** One non-atomic push batch as the current role; the verdicts come back in mutation order. */
async function pushBatch(tx: SQL, mutations: Record<string, unknown>[]): Promise<IVerdict[]> {
  const batch = { atomic: false, mutations }
  const [row] = await tx<{ resp: { verdicts: IVerdict[] } }[]>`
    select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

  return row.resp.verdicts
}

describe.skipIf(!reachable)('demo fixture: shared board and abuse caps', () => {
  // MARK: - Shared board

  test("a visitor sees its OWN todos AND another visitor's", async () => {
    const seen = await inTxn(db!, async (ctx) => {
      const first = await ctx.mintVisitor()
      const second = await ctx.mintVisitor()
      const theirs = await ctx.seedTodo(first, "first visitor's todo")
      const mine = await ctx.seedTodo(second, "second visitor's todo")

      await ctx.become(second)
      const [count] = await ctx.tx`
        select
          count(*) filter (where id = ${mine}::uuid)::int as own,
          count(*) filter (where id = ${theirs}::uuid)::int as peer_row
        from public.todos`

      return { own: count.own as number, peerRow: count.peer_row as number }
    })

    expect(seen).toEqual({ own: 1, peerRow: 1 })
  })

  test("a visitor can update another visitor's todo", async () => {
    const after = await inTxn(db!, async (ctx) => {
      const first = await ctx.mintVisitor()
      const second = await ctx.mintVisitor()
      const theirs = await ctx.seedTodo(first, 'before the peer edit')

      await ctx.become(second)
      await ctx.tx`update public.todos set title = 'edited by a peer' where id = ${theirs}::uuid`

      await ctx.becomeSuperuser()
      const [row] = await ctx.tx`select title from public.todos where id = ${theirs}::uuid`

      return row.title as string
    })

    expect(after).toBe('edited by a peer')
  })

  test("a visitor can delete another visitor's todo", async () => {
    const remaining = await inTxn(db!, async (ctx) => {
      const first = await ctx.mintVisitor()
      const second = await ctx.mintVisitor()
      const theirs = await ctx.seedTodo(first, 'deletable by the board')

      await ctx.become(second)
      await ctx.tx`delete from public.todos where id = ${theirs}::uuid`

      await ctx.becomeSuperuser()
      const [row] = await ctx.tx`select count(*)::int as n from public.todos where id = ${theirs}::uuid`

      return row.n as number
    })

    expect(remaining).toBe(0)
  })

  // The demo's RLS-refusal story: mary's row must stay VISIBLE (there is nothing to be refused on otherwise) while remaining un-writable by the board.
  test("a REGISTERED owner's todo stays readable by a visitor, and still refuses the write", async () => {
    const outcome = await inTxn(db!, async (ctx) => {
      const visitor = await ctx.mintVisitor()
      const mary = await ctx.mintRegistered()
      const hers = await ctx.seedTodo(mary, "mary's row")

      await ctx.become(visitor)
      const [read] = await ctx.tx`select count(*)::int as n from public.todos where id = ${hers}::uuid`

      await ctx.tx`update public.todos set title = 'hijacked' where id = ${hers}::uuid`
      await ctx.tx`delete from public.todos where id = ${hers}::uuid`

      await ctx.becomeSuperuser()
      const [row] = await ctx.tx`
        select count(*)::int as n, max(title) as title from public.todos where id = ${hers}::uuid`

      return { readable: (read.n as number) === 1, survived: (row.n as number) === 1, title: row.title as string }
    })

    expect(outcome).toEqual({ readable: true, survived: true, title: "mary's row" })
  })

  test('a REGISTERED owner still writes her own todo', async () => {
    const after = await inTxn(db!, async (ctx) => {
      const mary = await ctx.mintRegistered()
      const hers = await ctx.seedTodo(mary, "mary's row")

      await ctx.become(mary)
      await ctx.tx`update public.todos set title = 'mary edited her own row' where id = ${hers}::uuid`

      await ctx.becomeSuperuser()
      const [row] = await ctx.tx`select title from public.todos where id = ${hers}::uuid`

      return row.title as string
    })

    expect(after).toBe('mary edited her own row')
  })

  test('a visitor cannot insert a row owned by another visitor', async () => {
    const rejection = await inTxn(db!, async (ctx) => {
      const author = await ctx.mintVisitor()
      const other = await ctx.mintVisitor()

      await ctx.become(author)

      return rejectionOf(
        () => ctx.tx`
          insert into public.todos (id, user_id, title, done)
          values (gen_random_uuid(), ${other}::uuid, 'forged as a peer', false)`,
      )
    })

    expect(rejection?.sqlstate).toBe(RLS_WITH_CHECK)
    expect(rejection?.message).toContain('row-level security policy')
  })

  test('a visitor cannot insert a row owned by a REGISTERED user', async () => {
    const rejection = await inTxn(db!, async (ctx) => {
      const visitor = await ctx.mintVisitor()
      const mary = await ctx.mintRegistered()

      await ctx.become(visitor)

      return rejectionOf(
        () => ctx.tx`
          insert into public.todos (id, user_id, title, done)
          values (gen_random_uuid(), ${mary}::uuid, 'forged as mary', false)`,
      )
    })

    expect(rejection?.sqlstate).toBe(RLS_WITH_CHECK)
    expect(rejection?.message).toContain('row-level security policy')
  })

  // MARK: - Row cap

  test(`todo number ${ROW_CAP + 1} is rejected with SQLSTATE 23514`, async () => {
    const outcome = await inTxn(db!, async (ctx) => {
      const visitor = await ctx.mintVisitor()

      await ctx.become(visitor)

      // One statement per row, as the push path issues them: a BEFORE ROW trigger counting inside a single multi-row INSERT would not see its own statement's earlier rows.
      const insert = (n: number): Promise<unknown> =>
        ctx.tx`insert into public.todos (id, user_id, title, done)
               values (gen_random_uuid(), ${visitor}, ${`todo ${n}`}, false)`

      for (let n = 1; n < ROW_CAP; n++) {
        await insert(n)
      }
      const atCap = await rejectionOf(() => insert(ROW_CAP))
      const overCap = await rejectionOf(() => insert(ROW_CAP + 1))

      return { atCap, overCap }
    })

    expect(outcome.atCap).toBeNull()
    expect(outcome.overCap?.sqlstate).toBe('23514')
    expect(outcome.overCap?.message).toContain('demo cap: 100 todos per visitor')
  })

  // MARK: - Churn cap

  test(`write number ${WRITE_CAP + 1} within the minute is rejected with SQLSTATE 23514`, async () => {
    const outcome = await inTxn(db!, async (ctx) => {
      const visitor = await ctx.mintVisitor()

      await ctx.become(visitor)

      // now() is the transaction timestamp, so every write below lands in the same minute bucket: the boundary is exact, not timing-dependent.
      const [todo] = await ctx.tx`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${visitor}, 'churn', false)
        returning id`
      const update = (n: number): Promise<unknown> =>
        ctx.tx`update public.todos set title = ${`churn ${n}`} where id = ${todo.id}::uuid`

      for (let n = 2; n < WRITE_CAP; n++) {
        await update(n)
      }
      const atCap = await rejectionOf(() => update(WRITE_CAP))
      const overCap = await rejectionOf(() => update(WRITE_CAP + 1))

      return { atCap, overCap }
    })

    expect(outcome.atCap).toBeNull()
    expect(outcome.overCap?.sqlstate).toBe('23514')
    expect(outcome.overCap?.message).toContain('demo cap: 300 writes per minute')
  })

  // MARK: - Attachments and helpers

  test("a visitor reads no other visitor's attachment metadata row, while its owner does", async () => {
    const seen = await inTxn(db!, async (ctx) => {
      const owner = await ctx.mintVisitor()
      const peer = await ctx.mintVisitor()
      const todo = await ctx.seedTodo(owner, 'carries an image')
      const path = `${owner}/${todo}/${crypto.randomUUID()}.jpg`

      await ctx.tx`
        insert into kizunasync.attachments (id, bucket_id, object_path, sha256, size, media_type, created_by)
        values (gen_random_uuid(), 'todos', ${path}, ${'a'.repeat(64)}, 10, 'image/jpeg', ${owner}::uuid)`
      const countAs = async (visitor: string): Promise<number> => {
        await ctx.become(visitor)
        const [row] = await ctx.tx`select count(*)::int as n from kizunasync.attachments where object_path = ${path}`

        return row.n as number
      }

      return { byPeer: await countAs(peer), byOwner: await countAs(owner) }
    })

    expect(seen).toEqual({ byPeer: 0, byOwner: 1 })
  })

  test("an image path is writable only under the todo's owner and then the todo", async () => {
    const verdicts = await inTxn(db!, async (ctx) => {
      const owner = await ctx.mintVisitor()
      const editor = await ctx.mintVisitor()
      const todo = await ctx.seedTodo(owner, 'carries an image')
      const file = `${crypto.randomUUID()}.jpg`

      await ctx.become(editor)
      const writable = async (path: string): Promise<boolean> => {
        const [row] = await ctx.tx`select public.todo_image_writable(${path}) as ok`

        return row.ok as boolean
      }

      return {
        ownerThenTodo: await writable(`${owner}/${todo}/${file}`),
        editorThenTodo: await writable(`${editor}/${todo}/${file}`),
        strangerThenTodo: await writable(`${crypto.randomUUID()}/${todo}/${file}`),
        notAUuidThenTodo: await writable(`not-a-uuid/${todo}/${file}`),
        ownerThenNoTodo: await writable(`${owner}/${crypto.randomUUID()}/${file}`),
      }
    })

    expect(verdicts).toEqual({
      ownerThenTodo: true,
      editorThenTodo: false,
      strangerThenTodo: false,
      notAUuidThenTodo: false,
      ownerThenNoTodo: false,
    })
  })

  test('the anonymity probe is executable by authenticated alone', async () => {
    const [grants] = await db!`
      select
        has_function_privilege('anon', 'public.todo_owner_is_anonymous(uuid)', 'execute') as anon,
        has_function_privilege('authenticated', 'public.todo_owner_is_anonymous(uuid)', 'execute') as authenticated,
        has_function_privilege('service_role', 'public.todo_owner_is_anonymous(uuid)', 'execute') as service_role`

    expect(grants).toEqual({ anon: false, authenticated: true, service_role: false })
  })

  // Supabase's default privileges grant EXECUTE on a new function in `public` to each API role by name, which a revoke from PUBLIC leaves in place; the explicit grant below stands in for that entry.
  test('no API role executes the reaper, even with an explicit EXECUTE grant in place', async () => {
    const grants = await inTxn(db!, async (ctx) => {
      await ctx.tx`grant execute on function public.reap_demo_visitors() to anon, authenticated`
      await ctx.tx.unsafe(exampleSection("Reaper: a visitor's rows die with the visitor", 'Reaper schedule'))
      const [row] = await ctx.tx`
        select
          has_function_privilege('anon', 'public.reap_demo_visitors()', 'execute') as anon,
          has_function_privilege('authenticated', 'public.reap_demo_visitors()', 'execute') as authenticated`

      return { anon: row.anon as boolean, authenticated: row.authenticated as boolean }
    })

    expect(grants).toEqual({ anon: false, authenticated: false })
  })

  test('the churn counter table is unreachable by the API roles', async () => {
    const grants = await db!`
      select grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'demo_write_counters'
        and grantee in ('anon', 'authenticated', 'service_role')`

    expect(grants.length).toBe(0)
  })

  test('the grant matrix names every function the fixture defines', () => {
    const defined = [...EXAMPLE_SQL.matchAll(/create (?:or replace )?function (public\.\w+)\s*\(/g)].map((match) => match[1])
    const covered = Object.keys(EXAMPLE_FUNCTIONS).map((signature) => signature.slice(0, signature.indexOf('(')))

    expect([...new Set(defined)].sort()).toEqual(covered.sort())
  })

  test('PUBLIC and anon execute no fixture function, and authenticated only the helpers its policies call', async () => {
    expect(await readFunctionGrants(db!)).toEqual(EXPECTED_FUNCTION_GRANTS)
  })

  // Supabase's default privileges grant EXECUTE on a new function in `public` to each API role by name; the explicit grants stand in for those entries before the fixture's own grant statements run again.
  test('the fixture grant statements hold where every API role holds an explicit EXECUTE grant', async () => {
    const grants = await inTxn(db!, async (ctx) => {
      for (const signature of Object.keys(EXAMPLE_FUNCTIONS)) {
        await ctx.tx.unsafe(`grant execute on function ${signature} to public, anon, authenticated`)
      }
      for (const statement of EXAMPLE_FUNCTION_PRIVILEGES) {
        await ctx.tx.unsafe(statement)
      }
      return readFunctionGrants(ctx.tx)
    })

    expect(grants).toEqual(EXPECTED_FUNCTION_GRANTS)
  })

  test('the reaper runs with an empty search_path', async () => {
    const [row] = await db!`select proconfig from pg_proc where oid = 'public.reap_demo_visitors()'::regprocedure`

    expect(row.proconfig).toEqual(['search_path=""'])
  })

  // MARK: - Title length

  test(`a title of ${TITLE_MAX_LENGTH} code points is accepted and one of ${TITLE_MAX_LENGTH + 1} is refused with SQLSTATE 23514`, async () => {
    const outcome = await inTxn(db!, async (ctx) => {
      const visitor = await ctx.mintVisitor()

      await ctx.become(visitor)
      const insert = (title: string): Promise<unknown> =>
        ctx.tx`insert into public.todos (id, user_id, title, done)
               values (gen_random_uuid(), ${visitor}, ${title}, false)`
      const atLimit = await rejectionOf(() => insert('t'.repeat(TITLE_MAX_LENGTH)))
      // An astral code point is two UTF-16 units and four bytes, and still one character.
      const astralAtLimit = await rejectionOf(() => insert(String.fromCodePoint(0x1f600).repeat(TITLE_MAX_LENGTH)))
      const overLimit = await rejectionOf(() => insert('t'.repeat(TITLE_MAX_LENGTH + 1)))

      return { atLimit, astralAtLimit, overLimit }
    })

    expect(outcome.atLimit).toBeNull()
    expect(outcome.astralAtLimit).toBeNull()
    expect(outcome.overLimit?.sqlstate).toBe('23514')
    expect(outcome.overLimit?.message).toContain(TITLE_CHECK)
  })

  test(`push applies a ${TITLE_MAX_LENGTH}-character title and answers a ${TITLE_MAX_LENGTH + 1}-character one with CONSTRAINT`, async () => {
    const outcome = await inTxn(db!, async (ctx) => {
      const visitor = await ctx.mintVisitor()
      const kept = crypto.randomUUID()
      const refused = crypto.randomUUID()
      const atLimit = 'k'.repeat(TITLE_MAX_LENGTH)
      const overLimit = 'k'.repeat(TITLE_MAX_LENGTH + 1)

      await ctx.become(visitor)
      const verdicts = await pushBatch(ctx.tx, [
        { mutation_id: crypto.randomUUID(), table: 'todos', pk: kept, op: 'insert', columns: { user_id: visitor, title: atLimit, done: false } },
        { mutation_id: crypto.randomUUID(), table: 'todos', pk: refused, op: 'insert', columns: { user_id: visitor, title: overLimit, done: false } },
        { mutation_id: crypto.randomUUID(), table: 'todos', pk: kept, op: 'update', columns: { title: overLimit } },
      ])

      await ctx.becomeSuperuser()
      const rows = await ctx.tx`
        select id::text as id, title from public.todos where id in (${kept}::uuid, ${refused}::uuid)`

      return {
        verdicts: verdicts.map((verdict) => ({ verdict: verdict.verdict, reason: verdict.reason ?? null })),
        rows: rows.map((row: { id: string; title: string }) => ({ id: row.id, title: row.title })),
        kept,
        atLimit,
      }
    })

    expect(outcome.verdicts).toEqual([
      { verdict: 'applied', reason: null },
      { verdict: 'rejected', reason: 'CONSTRAINT' },
      { verdict: 'rejected', reason: 'CONSTRAINT' },
    ])
    expect(outcome.rows).toEqual([{ id: outcome.kept, title: outcome.atLimit }])
  })

  test('the title-length section adds the check to a todos table that lacks it, and a second run changes nothing', async () => {
    const checks = await inTxn(db!, async (ctx) => {
      const titleChecks = async (): Promise<string[]> => {
        const rows = await ctx.tx`
          select pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conrelid = 'public.todos'::regclass and conname = ${TITLE_CHECK}`

        return rows.map((row: { definition: string }) => row.definition)
      }

      await ctx.tx.unsafe(`alter table public.todos drop constraint ${TITLE_CHECK}`)
      const dropped = await titleChecks()

      await ctx.tx.unsafe(exampleSection('Title length', 'Grants'))
      const added = await titleChecks()

      await ctx.tx.unsafe(exampleSection('Title length', 'Grants'))
      const rerun = await titleChecks()

      return { dropped, added, rerun }
    })
    const definition = `CHECK ((char_length(title) <= ${TITLE_MAX_LENGTH}))`

    expect(checks).toEqual({ dropped: [], added: [definition], rerun: [definition] })
  })

  // MARK: - Fixed owner

  test('a direct update that changes user_id is refused with SQLSTATE 23514 naming the column', async () => {
    const rejection = await inTxn(db!, async (ctx) => {
      const visitor = await ctx.mintVisitor()
      const peer = await ctx.mintVisitor()
      const todo = await ctx.seedTodo(visitor, 'mine')

      await ctx.become(visitor)

      // The UPDATE policy admits a row any anonymous visitor owns, so only the owner trigger refuses handing the todo to a peer.
      return rejectionOf(() => ctx.tx`update public.todos set user_id = ${peer}::uuid where id = ${todo}::uuid`)
    })

    expect(rejection?.sqlstate).toBe('23514')
    expect(rejection?.message).toContain('user_id')
  })

  test('push applies an insert naming user_id and a title update, and answers a user_id change with CONSTRAINT', async () => {
    const outcome = await inTxn(db!, async (ctx) => {
      const visitor = await ctx.mintVisitor()
      const peer = await ctx.mintVisitor()
      const todo = crypto.randomUUID()

      await ctx.become(visitor)
      const verdicts = await pushBatch(ctx.tx, [
        { mutation_id: crypto.randomUUID(), table: 'todos', pk: todo, op: 'insert', columns: { user_id: visitor, title: 'mine', done: false } },
        { mutation_id: crypto.randomUUID(), table: 'todos', pk: todo, op: 'update', columns: { user_id: peer } },
        { mutation_id: crypto.randomUUID(), table: 'todos', pk: todo, op: 'update', columns: { title: 'still mine' } },
      ])

      await ctx.becomeSuperuser()
      const [row] = await ctx.tx`select user_id::text as user_id, title from public.todos where id = ${todo}::uuid`

      return {
        verdicts: verdicts.map((verdict) => ({ verdict: verdict.verdict, reason: verdict.reason ?? null })),
        row: { userId: row.user_id as string, title: row.title as string },
        visitor,
      }
    })

    expect(outcome.verdicts).toEqual([
      { verdict: 'applied', reason: null },
      { verdict: 'rejected', reason: 'CONSTRAINT' },
      { verdict: 'applied', reason: null },
    ])
    expect(outcome.row).toEqual({ userId: outcome.visitor, title: 'still mine' })
  })

  test('an update that leaves user_id as it is applies, whether or not it names the column', async () => {
    const after = await inTxn(db!, async (ctx) => {
      const visitor = await ctx.mintVisitor()
      const todo = await ctx.seedTodo(visitor, 'mine')

      await ctx.become(visitor)
      await ctx.tx`update public.todos set title = 'renamed' where id = ${todo}::uuid`
      await ctx.tx`update public.todos set user_id = ${visitor}::uuid, done = true where id = ${todo}::uuid`

      await ctx.becomeSuperuser()
      const [row] = await ctx.tx`select user_id::text as user_id, title, done from public.todos where id = ${todo}::uuid`

      return { userId: row.user_id as string, title: row.title as string, done: row.done as boolean, visitor }
    })

    expect(after).toEqual({ userId: after.visitor, title: 'renamed', done: true, visitor: after.visitor })
  })

  test('the fixed-owner section installs its trigger on a todos table that lacks it, and a second run changes nothing', async () => {
    const triggers = await inTxn(db!, async (ctx) => {
      const ownerTriggers = async (): Promise<string[]> => {
        const rows = await ctx.tx`
          select pg_get_triggerdef(oid) as definition
          from pg_trigger
          where tgrelid = 'public.todos'::regclass and tgname = ${OWNER_TRIGGER}`

        return rows.map((row: { definition: string }) => row.definition)
      }

      await ctx.tx.unsafe(`drop trigger ${OWNER_TRIGGER} on public.todos`)
      const dropped = await ownerTriggers()

      await ctx.tx.unsafe(exampleSection('Fixed owner', 'Title length'))
      const added = await ownerTriggers()

      await ctx.tx.unsafe(exampleSection('Fixed owner', 'Title length'))
      const rerun = await ownerTriggers()

      return { dropped, added, rerun }
    })
    const definition = `CREATE TRIGGER ${OWNER_TRIGGER} BEFORE UPDATE ON public.todos FOR EACH ROW EXECUTE FUNCTION todos_keep_user_id()`

    expect(triggers).toEqual({ dropped: [], added: [definition], rerun: [definition] })
  })
})
