/**
 * Bucket-scoped tombstones against live Postgres.
 *
 * A delete stores the OLD bucket projection on `_tombstones.bucket_snapshot`.
 * Pull reuses `_row_matches_params`: it does not replay RLS on a gone row.
 * Cross-tenant PKs stay off the wire; same-bucket replicas still drop ghosts.
 * A tombstone reaches only a caller whose earlier pull delivered a live row of
 * its bucket value, so a first pull carries none. A bucketed table pulled
 * without its bucket column is refused by the pull policy (KZL01) before any
 * page is assembled, so a vacuous match can never deliver a deleted pk. Skips
 * loudly when Postgres is unreachable.
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
    `[pull-tombstone-bucket] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

const WS = '_tomb_ws'
const MEMBERS = '_tomb_members'
const OPEN = '_tomb_open'
const TABLES = [WS, OPEN] as const

type TTombstone = { deleted_at: string; pk: string; seq: string; table: string }
type TPullResp = {
  cursor: string
  has_more: boolean
  rows: unknown[]
  signal: unknown
  tombstones: TTombstone[]
}

const uid = (): string => crypto.randomUUID()
const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })

const mintedUsers: string[] = []

async function mintUser(): Promise<string> {
  const [u] = await db!`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), false) returning id`

  mintedUsers.push(u.id as string)

  return u.id as string
}

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

async function pullAs(
  sub: string,
  table: string,
  params: Record<string, string> = {},
): Promise<TPullResp> {
  const buckets = [{ table, params }]

  return asUser(sub, async (w) => {
    const [r] = await w<{ resp: TPullResp }[]>`
      select kizunasync.pull(${buckets}::jsonb, '0', 1, 500) as resp`

    return r.resp
  })
}

/** Bun's SQL client carries the Postgres SQLSTATE on `errno`; `code` is its own transport tag. */
function sqlstateOf(error: unknown): string | null {
  if (!(error instanceof Error) || !('errno' in error)) {
    return null
  }
  const { errno } = error

  return typeof errno === 'string' ? errno : null
}

/** The SQLSTATE of a pull the pack refuses; fails loud when the pull is answered instead. */
async function pullSqlstate(
  sub: string,
  table: string,
  params: Record<string, string> = {},
): Promise<string | null> {
  try {
    await pullAs(sub, table, params)
  } catch (error) {
    return sqlstateOf(error)
  }
  throw new Error(`pull of "${table}" should have been refused`)
}

async function provision(): Promise<void> {
  const conn = db!

  await conn.unsafe(`
    create table if not exists public.${MEMBERS} (
      user_id uuid not null,
      workspace_id uuid not null,
      primary key (user_id, workspace_id)
    );
    alter table public.${MEMBERS} enable row level security;
    revoke all on public.${MEMBERS} from anon, authenticated;

    create or replace function public._tomb_is_member(p_ws uuid) returns boolean
      language sql security definer set search_path = '' stable as $$
      select exists (
        select 1 from public.${MEMBERS} m
        where m.user_id = (select auth.uid()) and m.workspace_id = p_ws
      ) $$;
    grant execute on function public._tomb_is_member(uuid) to authenticated;

    create table if not exists public.${WS} (
      id uuid primary key,
      workspace_id uuid not null,
      title text
    );
    alter table public.${WS} enable row level security;
    grant select, insert, update, delete on public.${WS} to authenticated;
    drop policy if exists w_all on public.${WS};
    create policy w_all on public.${WS} for all to authenticated
      using (public._tomb_is_member(workspace_id))
      with check (public._tomb_is_member(workspace_id));

    create table if not exists public.${OPEN} (
      id uuid primary key,
      title text
    );
    alter table public.${OPEN} enable row level security;
    grant select, insert, update, delete on public.${OPEN} to authenticated;
    drop policy if exists o_all on public.${OPEN};
    create policy o_all on public.${OPEN} for all to authenticated using (true) with check (true);
  `)

  for (const table of TABLES) {
    await conn.unsafe(`
      drop trigger if exists kizunasync_track_change on public.${table};
      drop trigger if exists kizunasync_track_delete on public.${table};
      create trigger kizunasync_track_change after insert or update on public.${table}
        for each row execute function kizunasync.track_change();
      create trigger kizunasync_track_delete after delete on public.${table}
        for each row execute function kizunasync.track_delete();
    `)
  }
  await conn`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
    values
      (${WS}, 'read-write', 'workspace_id', 1, false),
      (${OPEN}, 'read-write', null, 1, false)
    on conflict (table_name) do update
      set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column`
}

async function cleanup(): Promise<void> {
  const conn = db!

  await conn.unsafe(`drop table if exists public.${WS} cascade`)
  await conn.unsafe(`drop table if exists public.${OPEN} cascade`)
  await conn.unsafe(`drop table if exists public.${MEMBERS} cascade`)
  await conn.unsafe(`drop function if exists public._tomb_is_member(uuid)`)

  for (const table of TABLES) {
    await conn`delete from kizunasync._changelog where table_name = ${table}`
    await conn`delete from kizunasync._tombstones where table_name = ${table}`
    await conn`delete from kizunasync._bucket_grants where table_name = ${table}`
    await conn`delete from kizunasync._config where table_name = ${table}`
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

function tombPks(page: TPullResp, table: string): string[] {
  return page.tombstones.filter((t) => t.table === table).map((t) => t.pk)
}

describe.skipIf(!reachable)('pull tombstones are bucket-scoped', () => {
  test('a workspace delete is delivered to a member who received the row, and withheld from a first pull and another bucket', async () => {
    const alice = await mintUser()
    const bob = await mintUser()
    const carol = await mintUser()
    const wsA = uid()
    const wsB = uid()

    await db!.unsafe(`insert into public.${MEMBERS} (user_id, workspace_id) values ($1, $2), ($3, $4), ($5, $2)`, [
      alice,
      wsA,
      bob,
      wsB,
      carol,
    ])
    const pk = uid()

    await db!.unsafe(`insert into public.${WS} (id, workspace_id, title) values ($1, $2, 'gone')`, [pk, wsA])
    expect((await pullAs(alice, WS, { workspace_id: wsA })).rows).toHaveLength(1)
    await db!.unsafe(`delete from public.${WS} where id = $1`, [pk])

    const [stored] = await db!<{ bucket_snapshot: Record<string, string> }[]>`
      select bucket_snapshot from kizunasync._tombstones
      where table_name = ${WS} and pk = ${pk}::uuid`

    expect(stored.bucket_snapshot).toEqual({ workspace_id: wsA })

    const alicePage = await pullAs(alice, WS, { workspace_id: wsA })
    const bobPage = await pullAs(bob, WS, { workspace_id: wsB })
    const aliceOtherBucket = await pullAs(alice, WS, { workspace_id: wsB })
    const carolFirstPage = await pullAs(carol, WS, { workspace_id: wsA })

    expect(tombPks(alicePage, WS)).toContain(pk)
    expect(tombPks(bobPage, WS)).not.toContain(pk)
    expect(tombPks(aliceOtherBucket, WS)).not.toContain(pk)
    expect(tombPks(carolFirstPage, WS)).not.toContain(pk)
    expect(await pullSqlstate(alice, WS)).toBe('KZL01')

    const delivered = alicePage.tombstones.find((t) => t.pk === pk)

    expect(delivered).toBeDefined()
    expect(Object.keys(delivered!).sort()).toEqual(['deleted_at', 'pk', 'seq', 'table'])
    expect(delivered).not.toHaveProperty('bucket_snapshot')

    expect(bobPage.signal).toBeNull()
    expect(bobPage.cursor).toBe(alicePage.cursor)
    expect(Number(alicePage.cursor)).toBeGreaterThanOrEqual(Number(delivered!.seq))
  })

  test('a re-delete under a new bucket keeps the old bucket tombstone beside the new one', async () => {
    const alice = await mintUser()
    const wsA = uid()
    const wsB = uid()

    await db!.unsafe(`insert into public.${MEMBERS} (user_id, workspace_id) values ($1, $2), ($1, $3)`, [
      alice,
      wsA,
      wsB,
    ])
    const pk = uid()

    await db!.unsafe(`insert into public.${WS} (id, workspace_id, title) values ($1, $2, 'first')`, [pk, wsA])
    await pullAs(alice, WS, { workspace_id: wsA })
    await db!.unsafe(`delete from public.${WS} where id = $1`, [pk])
    await db!.unsafe(`insert into public.${WS} (id, workspace_id, title) values ($1, $2, 'second')`, [pk, wsB])
    await pullAs(alice, WS, { workspace_id: wsB })
    await db!.unsafe(`delete from public.${WS} where id = $1`, [pk])

    const stored = await db!<{ bucket_value: string; bucket_snapshot: Record<string, string> }[]>`
      select bucket_value, bucket_snapshot from kizunasync._tombstones
      where table_name = ${WS} and pk = ${pk}::uuid
      order by seq`

    expect(stored).toEqual([
      { bucket_value: wsA, bucket_snapshot: { workspace_id: wsA } },
      { bucket_value: wsB, bucket_snapshot: { workspace_id: wsB } },
    ])

    expect(tombPks(await pullAs(alice, WS, { workspace_id: wsB }), WS)).toContain(pk)
    expect(tombPks(await pullAs(alice, WS, { workspace_id: wsA }), WS)).toContain(pk)
  })

  test('an unbucketed table stays table-scoped', async () => {
    const alice = await mintUser()
    const bob = await mintUser()
    const pk = uid()

    await db!.unsafe(`insert into public.${OPEN} (id, title) values ($1, 'shared-gone')`, [pk])
    await pullAs(alice, OPEN)
    await pullAs(bob, OPEN)
    await db!.unsafe(`delete from public.${OPEN} where id = $1`, [pk])

    expect(tombPks(await pullAs(alice, OPEN), OPEN)).toContain(pk)
    expect(tombPks(await pullAs(bob, OPEN), OPEN)).toContain(pk)
  })

  test('a leftover empty snapshot on a bucketed table is withheld', async () => {
    const alice = await mintUser()
    const wsA = uid()

    await db!.unsafe(`insert into public.${MEMBERS} (user_id, workspace_id) values ($1, $2)`, [
      alice,
      wsA,
    ])
    const pk = uid()

    await db!`
      insert into kizunasync._tombstones (seq, table_name, pk, bucket_snapshot)
      values (nextval('kizunasync._change_seq'), ${WS}, ${pk}::uuid, '{}'::jsonb)`
    expect(tombPks(await pullAs(alice, WS, { workspace_id: wsA }), WS)).not.toContain(pk)
  })

  test('empty params on a bucketed table are refused with KZL01', async () => {
    const alice = await mintUser()
    const wsA = uid()

    await db!.unsafe(`insert into public.${MEMBERS} (user_id, workspace_id) values ($1, $2)`, [
      alice,
      wsA,
    ])
    const pk = uid()

    await db!.unsafe(`insert into public.${WS} (id, workspace_id, title) values ($1, $2, 'gone')`, [
      pk,
      wsA,
    ])
    await pullAs(alice, WS, { workspace_id: wsA })
    await db!.unsafe(`delete from public.${WS} where id = $1`, [pk])
    expect(await pullSqlstate(alice, WS)).toBe('KZL01')
    expect(tombPks(await pullAs(alice, WS, { workspace_id: wsA }), WS)).toContain(pk)
  })
})
