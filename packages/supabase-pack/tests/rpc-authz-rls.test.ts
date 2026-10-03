/**
 * For kizunasync.pull / kizunasync.push against real Postgres, authorization is
 * the CALLER's RLS. The pack imposes no ownership opinion. Every user-row read
 * and write goes through the kizunasync_rls-owned SECURITY DEFINER helpers (a
 * NOBYPASSRLS owner with inherited jwt claims). The app's own policies govern.
 *
 * Four tables, each with a DIFFERENT policy shape:
 *   (F1) strict byOwner: user_id = auth.uid() on select/insert/update/delete.
 *        A non-owner CANNOT pull the row and CANNOT update/delete it (RLS_DENIED,
 *        no mutation); the owner can. Both callers pull the SAME bucket, so RLS
 *        is the only thing that can separate them.
 *   (PUBLIC) public-read: select using (true), write with check user_id=auth.uid().
 *        EVERY authenticated user pulls EVERY row; a write to your own row applies.
 *        The pack must not block this (the product owner's explicit requirement).
 *        Provisioned WITHOUT a bucket column: its callers pull with an empty
 *        bucket, which the pull policy refuses on a table that declares one.
 *   (F3) byColumn tenant: workspace membership, NOT auth.uid() equality. A member
 *        pulls the tenant's rows and may insert/update/delete; a non-member is
 *        filtered/blocked by RLS. No RLS_DENIED for a legitimate tenant.
 *   (byOwner scoping) the strict table pulled with a bucket param narrows to the
 *        scoped rows UNDER RLS, and the cursor/changelog still advance.
 *
 * Fixtures live in public (the pack hardcodes public.<table>) under distinctive
 * _authz_* names, provisioned once and dropped in afterAll; committed rows are
 * cleaned by table, and pushed mutations by id (kizunasync._verdicts has no
 * table_name column). NEVER resets / drops / truncates a real table. Skips
 * loudly when no DB is reachable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
    `[rpc-authz-rls] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Fixture names

const STRICT = '_authz_strict'
const PUBLIC = '_authz_public'
const WS = '_authz_ws'
const MEMBERS = '_authz_members'
const TABLES = [STRICT, PUBLIC, WS] as const

/**
 * Provisioned bucket columns. PUBLIC declares none because its readers are
 * unscoped: they pull with an empty bucket, which the pull policy refuses on a
 * table that declares a column.
 */
const BUCKET_COLUMNS: Record<string, string | null> = {
  [STRICT]: 'user_id',
  [PUBLIC]: null,
  [WS]: 'workspace_id',
}

type TVerdict = { mutation_id: string; verdict: 'applied' | 'rejected'; reason?: string }
type TPushResp = { verdicts?: TVerdict[]; batch?: unknown; signal?: unknown }
type TMutation = { mutation_id: string } & Record<string, unknown>
type TPullRow = { pk: string; row: Record<string, unknown> | null; seq: string; table: string }
type TPullResp = { cursor: string; has_more: boolean; rows: TPullRow[]; signal: unknown; tombstones: unknown[] }

const uid = (): string => crypto.randomUUID()
const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })

/** Committed seed insert (table names are test-fixture constants, never input). */
async function seedRow(table: string, cols: Record<string, string>): Promise<void> {
  const keys = Object.keys(cols)
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')

  await db!.unsafe(
    `insert into public.${table} (${keys.join(', ')}) values (${placeholders})`,
    keys.map((k) => cols[k]),
  )
}

async function titleOf(table: string, pk: string): Promise<string | undefined> {
  const rows = await db!.unsafe(`select title from public.${table} where id = $1`, [pk])

  return (rows[0]?.title as string | undefined) ?? undefined
}

/** A committed authenticated user (cleaned up in afterAll by id). */
const mintedUsers: string[] = []

/** A mutation_id pushed through kizunasync.push (cleaned up in afterAll by id). */
const pushedMutationIds: string[] = []

async function mintUser(): Promise<string> {
  const [u] = await db!`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), false) returning id`

  mintedUsers.push(u.id as string)

  return u.id as string
}

/** Run pull/push as `sub` on a reserved connection, one txn, jwt claims local. */
async function asUser<T>(sub: string, fn: (w: SQL) => Promise<T>): Promise<T> {
  const w = await new SQL(DB_URL, { max: 1 }).reserve()

  try {
    await w`begin`

    try {
      await w`select set_config('request.jwt.claims', ${claims(sub)}, true)`
      await w`set local role authenticated`
      const out = await fn(w as unknown as SQL)

      await w`commit`

      return out
    } catch (error) {
      await w`rollback`.catch(() => {})

      throw error
    }
  } finally {
    await w.release()
  }
}

async function pullAs(sub: string, table: string, params: Record<string, string> = {}): Promise<TPullResp> {
  const buckets = [{ table, params }]

  return asUser(sub, async (w) => {
    const [r] = await w<{ resp: TPullResp }[]>`
      select kizunasync.pull(${buckets}::jsonb, '0', 1, 500) as resp`

    return r.resp
  })
}

async function pushAs(sub: string, mutations: TMutation[]): Promise<TPushResp> {
  const batch = { atomic: false, mutations }

  for (const m of mutations) {
    pushedMutationIds.push(m.mutation_id)
  }

  return asUser(sub, async (w) => {
    const [r] = await w<{ resp: TPushResp }[]>`
      select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

    return r.resp
  })
}

async function provision(): Promise<void> {
  const conn = db!

  await conn.unsafe(`
    create table if not exists public.${STRICT} (id uuid primary key, user_id uuid not null, title text);
    alter table public.${STRICT} enable row level security;
    grant select, insert, update, delete on public.${STRICT} to authenticated;
    drop policy if exists s_all on public.${STRICT};
    create policy s_all on public.${STRICT} for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

    create table if not exists public.${PUBLIC} (id uuid primary key, user_id uuid not null, title text);
    alter table public.${PUBLIC} enable row level security;
    grant select, insert, update, delete on public.${PUBLIC} to authenticated;
    drop policy if exists p_sel on public.${PUBLIC};
    drop policy if exists p_write on public.${PUBLIC};
    create policy p_sel on public.${PUBLIC} for select to authenticated using (true);
    create policy p_write on public.${PUBLIC} for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

    create table if not exists public.${MEMBERS} (user_id uuid not null, workspace_id uuid not null, primary key (user_id, workspace_id));
    alter table public.${MEMBERS} enable row level security;
    revoke all on public.${MEMBERS} from anon, authenticated;
  `)
  await conn.unsafe(`
    create or replace function public._authz_is_member(p_ws uuid) returns boolean
      language sql security definer set search_path = '' stable as $$
      select exists (select 1 from public.${MEMBERS} m where m.user_id = auth.uid() and m.workspace_id = p_ws) $$;
    grant execute on function public._authz_is_member(uuid) to authenticated;

    create table if not exists public.${WS} (id uuid primary key, workspace_id uuid not null, title text);
    alter table public.${WS} enable row level security;
    grant select, insert, update, delete on public.${WS} to authenticated;
    drop policy if exists w_all on public.${WS};
    create policy w_all on public.${WS} for all to authenticated
      using (public._authz_is_member(workspace_id)) with check (public._authz_is_member(workspace_id));
  `)

  for (const t of TABLES) {
    await conn.unsafe(`
      drop trigger if exists kizunasync_track_change on public.${t};
      drop trigger if exists kizunasync_track_delete on public.${t};
      create trigger kizunasync_track_change after insert or update on public.${t}
        for each row execute function kizunasync.track_change();
      create trigger kizunasync_track_delete after delete on public.${t}
        for each row execute function kizunasync.track_delete();
    `)
    const bucketCol = BUCKET_COLUMNS[t] ?? null

    await conn`
      insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
      values (${t}, 'read-write', ${bucketCol}, 1, false)
      on conflict (table_name) do update set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column`
  }
}

async function cleanup(): Promise<void> {
  const conn = db!

  for (const t of [STRICT, PUBLIC, WS, MEMBERS]) {
    await conn.unsafe(`drop table if exists public.${t} cascade`)
  }
  await conn.unsafe(`drop function if exists public._authz_is_member(uuid)`)

  for (const t of TABLES) {
    await conn`delete from kizunasync._changelog where table_name = ${t}`
    await conn`delete from kizunasync._tombstones where table_name = ${t}`
    await conn`delete from kizunasync._row_hlc where table_name = ${t}`
    await conn`delete from kizunasync._bucket_grants where table_name = ${t}`
    await conn`delete from kizunasync._config where table_name = ${t}`
  }
  if (pushedMutationIds.length > 0) {
    await conn`delete from kizunasync._verdicts where mutation_id::text in ${conn(pushedMutationIds)}`
  }
  if (mintedUsers.length > 0) {
    await conn`delete from auth.users where id::text in ${conn(mintedUsers)}`
  }
}

beforeAll(async () => {
  if (reachable) {
    await provision()
  }
})

afterAll(async () => {
  if (db !== null) {
    await cleanup()
    await db.end()
  }
})

describe.skipIf(!reachable)('RLS is the sole authorization boundary for pull/push', () => {
  // MARK: - Strict byOwner

  test('F1: a non-owner cannot pull, update, or delete another user\'s private row', async () => {
    const a = await mintUser()
    const b = await mintUser()
    const pk = uid()

    // A's private row, committed (fires the change-capture trigger).
    await seedRow(STRICT, { id: pk, user_id: a, title: 'a-private' })

    // Pull: A sees it; B does not. Same bucket for both, so only RLS separates them.
    const aRows = (await pullAs(a, STRICT, { user_id: a })).rows.filter((r) => r.pk === pk)
    const bRows = (await pullAs(b, STRICT, { user_id: a })).rows.filter((r) => r.pk === pk)

    expect(aRows).toHaveLength(1)
    expect(bRows).toHaveLength(0)

    const bUpd = await pushAs(b, [{ mutation_id: uid(), table: STRICT, pk, op: 'update', columns: { title: 'hijacked' } }])
    const bDel = await pushAs(b, [{ mutation_id: uid(), table: STRICT, pk, op: 'delete', columns: {} }])

    expect(bUpd.verdicts?.[0]?.verdict).toBe('rejected')
    expect(bUpd.verdicts?.[0]?.reason).toBe('RLS_DENIED')
    expect(bDel.verdicts?.[0]?.verdict).toBe('rejected')
    expect(bDel.verdicts?.[0]?.reason).toBe('RLS_DENIED')

    expect(await titleOf(STRICT, pk)).toBe('a-private')

    const aUpd = await pushAs(a, [{ mutation_id: uid(), table: STRICT, pk, op: 'update', columns: { title: 'a-updated' } }])

    expect(aUpd.verdicts?.[0]?.verdict).toBe('applied')
    expect(await titleOf(STRICT, pk)).toBe('a-updated')
  })

  // MARK: - Public read

  test('PUBLIC READ: a using(true) table returns all rows to any authenticated user', async () => {
    const a = await mintUser()
    const b = await mintUser()
    const pkA = uid()
    const pkB = uid()

    await seedRow(PUBLIC, { id: pkA, user_id: a, title: 'a-pub' })
    await seedRow(PUBLIC, { id: pkB, user_id: b, title: 'b-pub' })

    // B pulls and sees BOTH rows (public read), including A's.
    const bSeen = (await pullAs(b, PUBLIC)).rows.filter((r) => r.pk === pkA || r.pk === pkB)

    expect(new Set(bSeen.map((r) => r.pk))).toEqual(new Set([pkA, pkB]))

    // A write permitted by WITH CHECK (own row) applies; a cross-owner write is denied.
    const own = await pushAs(b, [{ mutation_id: uid(), table: PUBLIC, pk: pkB, op: 'update', columns: { title: 'b-pub-2' } }])

    expect(own.verdicts?.[0]?.verdict).toBe('applied')
    const cross = await pushAs(b, [{ mutation_id: uid(), table: PUBLIC, pk: pkA, op: 'update', columns: { title: 'stolen' } }])

    expect(cross.verdicts?.[0]?.verdict).toBe('rejected')
    expect(cross.verdicts?.[0]?.reason).toBe('RLS_DENIED')
  })

  // MARK: - byColumn tenant

  test('F3: a byColumn(workspace_id) member is served; a non-member is filtered/blocked by RLS', async () => {
    const member = await mintUser()
    const outsider = await mintUser()
    const workspace = uid()

    await db!.unsafe(`insert into public.${MEMBERS} (user_id, workspace_id) values ($1, $2)`, [member, workspace])
    const pk = uid()

    await seedRow(WS, { id: pk, workspace_id: workspace, title: 'ws-row' })

    const memberRows = (await pullAs(member, WS, { workspace_id: workspace })).rows.filter((r) => r.pk === pk)
    const outsiderRows = (await pullAs(outsider, WS, { workspace_id: workspace })).rows.filter((r) => r.pk === pk)

    expect(memberRows).toHaveLength(1)
    expect(outsiderRows).toHaveLength(0)

    // Member insert/update/delete are accepted (no RLS_DENIED for a legitimate tenant).
    const pk2 = uid()
    const ins = await pushAs(member, [{ mutation_id: uid(), table: WS, pk: pk2, op: 'insert', columns: { workspace_id: workspace, title: 'by-member' } }])
    const upd = await pushAs(member, [{ mutation_id: uid(), table: WS, pk, op: 'update', columns: { title: 'member-edit' } }])

    expect(ins.verdicts?.[0]?.verdict).toBe('applied')
    expect(upd.verdicts?.[0]?.verdict).toBe('applied')

    const bad = await pushAs(outsider, [{ mutation_id: uid(), table: WS, pk, op: 'update', columns: { title: 'outsider' } }])

    expect(bad.verdicts?.[0]?.verdict).toBe('rejected')
    expect(bad.verdicts?.[0]?.reason).toBe('RLS_DENIED')
    const del = await pushAs(outsider, [{ mutation_id: uid(), table: WS, pk, op: 'delete', columns: {} }])

    expect(del.verdicts?.[0]?.reason).toBe('RLS_DENIED')
  })

  // MARK: - byOwner scoping + bookkeeping still advance

  test('byOwner: the bucket param scopes the pull under RLS and the cursor advances', async () => {
    const a = await mintUser()
    const p1 = uid()
    const p2 = uid()

    await seedRow(STRICT, { id: p1, user_id: a, title: 'own-1' })
    await seedRow(STRICT, { id: p2, user_id: a, title: 'own-2' })

    const page = await pullAs(a, STRICT, { user_id: a })
    const mine = page.rows.filter((r) => r.pk === p1 || r.pk === p2)

    expect(mine).toHaveLength(2)
    // The cursor advanced past '0': a real high-water token, not the echoed request cursor.
    expect(page.cursor).not.toBe('0')

    const p3 = uid()
    const applied = await pushAs(a, [{ mutation_id: uid(), table: STRICT, pk: p3, op: 'insert', columns: { user_id: a, title: 'own-3' } }])

    expect(applied.verdicts?.[0]?.verdict).toBe('applied')
    const after = (await pullAs(a, STRICT, { user_id: a })).rows.filter((r) => r.pk === p3)

    expect(after).toHaveLength(1)
  })
})
