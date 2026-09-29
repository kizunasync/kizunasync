/**
 * kizunasync.push verdict gate against real Postgres: the layer the corpus can't
 * reach (it runs the TS oracle over sqlite, never this SQL). Each case rolls back,
 * so the DB is untouched. Skips loudly (named reason) when no DB is reachable.
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
    `[rpc-verdict] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
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

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
  server_row?: unknown
}

type TOwnerKind = 'self' | 'anon' | 'registered'

/**
 * A strict owner-only table, shaped like rpc-authz-rls's `_authz_strict`:
 * owner-equality on every command, so a non-owner's target row is invisible as
 * well as unwritable. The demo's `todos` is a shared board and cannot carry that
 * case. Created inside the caller's rolled-back txn (DDL is transactional) so
 * this file keeps leaving the DB untouched.
 */
const STRICT_TABLE = '_verdict_strict'

async function provisionStrictTable(tx: SQL): Promise<void> {
  await tx.unsafe(`
    create table public.${STRICT_TABLE} (id uuid primary key, user_id uuid not null, title text);
    alter table public.${STRICT_TABLE} enable row level security;
    grant select, insert, update, delete on public.${STRICT_TABLE} to authenticated;
    create policy vs_all on public.${STRICT_TABLE} for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
    create trigger kizunasync_track_change after insert or update on public.${STRICT_TABLE}
      for each row execute function kizunasync.track_change();
    create trigger kizunasync_track_delete after delete on public.${STRICT_TABLE}
      for each row execute function kizunasync.track_delete();
  `)
  await tx`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
    values (${STRICT_TABLE}, 'read-write', 'user_id', 1, false)`
}

/**
 * Push an UPDATE to a row the actor may neither read nor write, on the strict
 * table, as a fresh anonymous actor under a real JWT, in a rolled-back txn.
 */
async function pushUpdateToHiddenRow(
  conn: SQL,
): Promise<{ verdict: IVerdict; rowSurvived: boolean }> {
  let out: { verdict: IVerdict; rowSurvived: boolean } | undefined

  try {
    await conn.begin(async (tx) => {
      await provisionStrictTable(tx as unknown as SQL)
      const [actor] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const [owner] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const pk = crypto.randomUUID()

      await tx.unsafe(
        `insert into public.${STRICT_TABLE} (id, user_id, title) values ($1, $2, $3)`,
        [pk, owner.id as string, 'hidden row'],
      )

      const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' })

      await tx`select set_config('request.jwt.claims', ${claims}, true)`
      await tx`set local role authenticated`

      const batch = {
        atomic: false,
        mutations: [
          {
            mutation_id: crypto.randomUUID(),
            table: STRICT_TABLE,
            pk,
            op: 'update',
            columns: { title: 'hijacked' },
          },
        ],
      }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`
      const verdict = (row.resp as { verdicts: IVerdict[] }).verdicts[0] as IVerdict

      await tx`reset role`
      const [survival] = await tx.unsafe(
        `select count(*)::int as n from public.${STRICT_TABLE} where id = $1 and title = 'hidden row'`,
        [pk],
      )

      out = { verdict, rowSurvived: (survival.n as number) > 0 }

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (out === undefined) {
    throw new Error('no verdict captured')
  }
  return out
}

/**
 * Push an UPDATE to a todo owned per `ownerKind`, as a fresh anonymous actor
 * under a real JWT, in a rolled-back txn. Returns the verdict and row survival.
 */
async function pushUpdate(
  conn: SQL,
  ownerKind: TOwnerKind,
): Promise<{ verdict: IVerdict; rowSurvived: boolean }> {
  let out: { verdict: IVerdict; rowSurvived: boolean } | undefined

  try {
    await conn.begin(async (tx) => {
      const [actor] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      let ownerId = actor.id

      if (ownerKind !== 'self') {
        const [owner] = await tx`
          insert into auth.users (id, is_anonymous)
          values (gen_random_uuid(), ${ownerKind === 'anon'})
          returning id`

        ownerId = owner.id
      }
      const [todo] = await tx`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${ownerId}, 'shared row', false)
        returning id`

      // Become the actor: populate auth.uid() via the request JWT claims, then drop to the authenticated role so RLS applies to the gate's trial write.
      const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' })

      await tx`select set_config('request.jwt.claims', ${claims}, true)`
      await tx`set local role authenticated`

      // Pass the batch as an OBJECT: Bun.sql encodes it as a json param, so `::jsonb` yields a real object. A JSON string would cast to a jsonb string scalar (double-encoded) and the gate would see zero mutations.
      const batch = {
        atomic: false,
        mutations: [
          {
            mutation_id: crypto.randomUUID(),
            table: 'todos',
            pk: todo.id,
            op: 'update',
            columns: { done: true },
          },
        ],
      }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`
      const verdict = (row.resp as { verdicts: IVerdict[] }).verdicts[0] as IVerdict

      // Read the row back as the table owner, outside the authenticated RLS role, so the check measures the ROW's survival rather than what the denied actor may see.
      await tx`reset role`
      const [survival] =
        await tx`select count(*)::int as n from public.todos where id = ${todo.id}::uuid`

      out = { verdict, rowSurvived: survival.n > 0 }

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (out === undefined) {
    throw new Error('no verdict captured')
  }
  return out
}

interface IOffenderBatch {
  verdicts: IVerdict[]
  offenderId: string
  offenderTitle: string
  offenderLikes: number
  siblingDone: boolean
}

/** What makes the offender fail: DDL run inside the rolled-back txn, and the columns the offender pushes. */
interface IOffenderCase {
  prepare: (tx: SQL) => Promise<void>
  offenderColumns: Record<string, unknown>
}

/** A transaction-scoped CHECK constraint the offender's title violates (class 23). */
const CHECK_VIOLATION: IOffenderCase = {
  prepare: async (tx) => {
    await tx`
      alter table public.todos
        add constraint kizunasync_test_title_not_forbidden check (title <> 'FORBIDDEN')`
  },
  offenderColumns: { title: 'FORBIDDEN' },
}

/** A value the integer column's type refuses, so building the row raises 22P02 (class 22). */
const TYPE_REFUSAL: IOffenderCase = {
  prepare: async () => undefined,
  offenderColumns: { likes: 'not a number' },
}

/** An app validation trigger that raises with no SQLSTATE of its own, which Postgres reports as P0001. */
const BARE_RAISE: IOffenderCase = {
  prepare: async (tx) => {
    await tx.unsafe(`
      create function public._verdict_bare_raise() returns trigger language plpgsql set search_path to '' as $$
      begin
        raise exception 'title RAISE is refused by an app trigger';
      end $$;
      grant execute on function public._verdict_bare_raise() to authenticated;
      create trigger verdict_bare_raise before update on public.todos
        for each row when (new.title = 'RAISE') execute function public._verdict_bare_raise();
    `)
  },
  offenderColumns: { title: 'RAISE' },
}

/**
 * Push a batch of two UPDATEs against fresh owned todos, as a real JWT actor,
 * in a rolled-back txn: the offender fails the way `offenderCase` arranges, the
 * other is an ordinary edit (the sibling). The failure's DDL and the rows it
 * guards exist only inside this rolled-back transaction: DDL is transactional
 * in Postgres, so it reverts along with everything else, leaving no trace.
 */
async function pushOffenderBatch(conn: SQL, offenderCase: IOffenderCase): Promise<IOffenderBatch> {
  let out: IOffenderBatch | undefined

  try {
    await conn.begin(async (tx) => {
      const [actor] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`

      await offenderCase.prepare(tx as unknown as SQL)

      const [offender] = await tx`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${actor.id}, 'ok for now', false)
        returning id`
      const [sibling] = await tx`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${actor.id}, 'sibling row', false)
        returning id`

      const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' })

      await tx`select set_config('request.jwt.claims', ${claims}, true)`
      await tx`set local role authenticated`

      const batch = {
        atomic: false,
        mutations: [
          {
            mutation_id: crypto.randomUUID(),
            table: 'todos',
            pk: offender.id,
            op: 'update',
            columns: offenderCase.offenderColumns,
          },
          {
            mutation_id: crypto.randomUUID(),
            table: 'todos',
            pk: sibling.id,
            op: 'update',
            columns: { done: true },
          },
        ],
      }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`
      const verdicts = (row.resp as { verdicts: IVerdict[] }).verdicts

      await tx`reset role`
      const [offenderRow] = await tx`select title, likes from public.todos where id = ${offender.id}::uuid`
      const [siblingRow] = await tx`select done from public.todos where id = ${sibling.id}::uuid`

      out = {
        verdicts,
        offenderId: offender.id as string,
        offenderTitle: offenderRow.title as string,
        offenderLikes: offenderRow.likes as number,
        siblingDone: siblingRow.done as boolean,
      }

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (out === undefined) {
    throw new Error('no verdicts captured')
  }
  return out
}

/** The rejection every offender case shares: CONSTRAINT with the pre-image, the offender untouched, the sibling applied. */
function expectConstraintWithSiblingApplied(batch: IOffenderBatch): void {
  const [offender, sibling] = batch.verdicts
  const serverRow = offender?.server_row as { id?: string; title?: string; likes?: number } | null

  expect(batch.verdicts).toHaveLength(2)
  expect(offender?.verdict).toBe('rejected')
  expect(offender?.reason).toBe('CONSTRAINT')
  expect(serverRow?.id).toBe(batch.offenderId)
  expect(serverRow?.title).toBe('ok for now')
  expect(serverRow?.likes).toBe(0)
  expect(batch.offenderTitle).toBe('ok for now')
  expect(batch.offenderLikes).toBe(0)
  expect(sibling?.verdict).toBe('applied')
  expect(batch.siblingDone).toBe(true)
}

describe.skipIf(!reachable)('kizunasync.push turns a genuine integrity failure into a per-mutation CONSTRAINT verdict', () => {
  test('a CHECK violation is rejected(CONSTRAINT) with the pre-image server_row, the RPC survives, and the sibling mutation still applies', async () => {
    const { verdicts, offenderId, offenderTitle, siblingDone } = await pushOffenderBatch(db!, CHECK_VIOLATION)

    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]?.verdict).toBe('rejected')
    expect(verdicts[0]?.reason).toBe('CONSTRAINT')
    // server_row renders the SAME way the precondition/existing-row rejections do (v_row, owned): the current (pre-mutation) server truth, not a hard null: the row is visible and owned.
    const serverRow = verdicts[0]?.server_row as { id?: string; title?: string; done?: boolean } | null

    expect(serverRow).not.toBeNull()
    expect(serverRow?.id).toBe(offenderId)
    expect(serverRow?.title).toBe('ok for now')
    expect(serverRow?.done).toBe(false)
    expect(verdicts[1]?.verdict).toBe('applied')
    // The offending mutation's write rolled back inside its own sub-block: title kept its pre-image.
    expect(offenderTitle).toBe('ok for now')
    // The sibling mutation, in the SAME non-atomic batch, still applied: the RPC never aborted.
    expect(siblingDone).toBe(true)
  })

  test('a value the column type refuses (22P02) is rejected(CONSTRAINT) and the sibling mutation still applies', async () => {
    expectConstraintWithSiblingApplied(await pushOffenderBatch(db!, TYPE_REFUSAL))
  })

  test('a validation trigger raising with no SQLSTATE of its own (P0001) is rejected(CONSTRAINT) and the sibling mutation still applies', async () => {
    expectConstraintWithSiblingApplied(await pushOffenderBatch(db!, BARE_RAISE))
  })
})

describe.skipIf(!reachable)('kizunasync.push verdict gate honors the table RLS', () => {
  // Editing your own todo (the dominant data-loss case): must apply, not vanish.
  test('editing your OWN todo is APPLIED', async () => {
    const { verdict } = await pushUpdate(db!, 'self')

    expect(verdict.verdict).toBe('applied')
  })

  // Another VISITOR's todo. The example fixture is a shared board, so the write is authorized and the gate applies it: RLS is the only authorization the gate consults, and it says yes here.
  test("another anonymous visitor's todo is APPLIED (shared board)", async () => {
    const { verdict, rowSurvived } = await pushUpdate(db!, 'anon')

    expect(verdict.verdict).toBe('applied')
    expect(rowSurvived).toBe(true)
  })

  // The strict-owner guarantee, which the shared-board `todos` cannot demonstrate: when the SELECT policy hides the target row, the rejection carries NO server_row, because there is nothing the caller is permitted to read.
  test('a row hidden by a strict owner-only policy is RLS_DENIED, with no server_row to leak', async () => {
    const { verdict, rowSurvived } = await pushUpdateToHiddenRow(db!)

    expect(verdict.verdict).toBe('rejected')
    expect(verdict.reason).toBe('RLS_DENIED')
    expect(rowSurvived).toBe(true)
    expect(verdict.server_row ?? null).toBeNull()
  })

  // A registered user's todo: the WRITE is still denied (the demo's UPDATE policy is owner-only), but the demo's SELECT policy exposes registered users' rows (the mary-row story). Authorization is the caller's RLS; there is no owner-only render gate. The rejection carries the current row the caller is PERMITTED to read as server_row, which the app's SELECT policy grants. The strict-owner "nothing to read, so server_row is null" case is the hidden-row case above and rpc-authz-rls's strict table.
  test("a registered user's todo edited by another user is RLS_DENIED; server_row is the row the caller's SELECT policy exposes", async () => {
    const { verdict, rowSurvived } = await pushUpdate(db!, 'registered')

    expect(verdict.verdict).toBe('rejected')
    expect(verdict.reason).toBe('RLS_DENIED')
    expect(rowSurvived).toBe(true)
    const serverRow = verdict.server_row as { title?: string } | null

    expect(serverRow).not.toBeNull()
    expect(serverRow?.title).toBe('shared row')
  })
})
