/**
 * Retention against real Postgres: what reap_tombstones, compact_changelog and
 * prune_clients delete, and on which knob. Bucket grants follow their user only,
 * never their age. Compaction also drops the conflict-journal rows whose winning
 * changelog row is gone and the changelog rows a newer tombstone supersedes, and
 * a delete clears the row's HLC state even when it bypasses push.
 *
 * Every case runs inside a rolled-back transaction, so the database is untouched:
 * the three functions are called directly (they refuse a client JWT, and these run
 * as the owner with no JWT set). Skips loudly with a named reason when no database
 * is reachable.
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
    `[retention] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

class Rollback extends Error {}

/** Run `body` in a transaction that always rolls back, returning what it captured. */
async function inRolledBackTxn<T>(body: (tx: SQL) => Promise<T>): Promise<T> {
  let captured: T | undefined

  try {
    await db!.begin(async (tx) => {
      captured = await body(tx as unknown as SQL)

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (captured === undefined) {
    throw new Error('the transaction captured no result')
  }
  return captured
}

/** A tombstone for a table nothing declares, aged by `days`. */
async function seedTombstone(tx: SQL, table: string, days: number): Promise<string> {
  const [row] = await tx`
    insert into kizunasync._tombstones (seq, table_name, pk, deleted_at)
    values (nextval('kizunasync._change_seq'), ${table}, gen_random_uuid(), now() - make_interval(days => ${days}))
    returning pk::text as pk`

  return row.pk as string
}

/** Two changelog rows for one new todos pk, so the older one is superseded; returns the pk. */
async function seedSuperseded(tx: SQL): Promise<string> {
  const [first] = await tx`
    insert into kizunasync._changelog (seq, table_name, pk, op)
    values (nextval('kizunasync._change_seq'), 'todos', gen_random_uuid(), 'upsert')
    returning pk::text as pk`
  const pk = (first as { pk: string }).pk

  await tx`
    insert into kizunasync._changelog (seq, table_name, pk, op)
    values (nextval('kizunasync._change_seq'), 'todos', ${pk}::uuid, 'upsert')`

  return pk
}

async function newUser(tx: SQL): Promise<string> {
  const [user] =
    await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id::text as id`

  return (user as { id: string }).id
}

describe.skipIf(!reachable)('kizunasync.reap_tombstones', () => {
  test('reaps a configured table on its own TTL and leaves a fresh tombstone', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`update kizunasync._config set tombstone_ttl_days = 7 where table_name = 'todos'`
      const expired = await seedTombstone(tx, 'todos', 9)
      const fresh = await seedTombstone(tx, 'todos', 2)

      await tx`select kizunasync.reap_tombstones()`
      const [rows] = await tx`
        select
          count(*) filter (where pk::text = ${expired}) as expired_left,
          count(*) filter (where pk::text = ${fresh}) as fresh_left
        from kizunasync._tombstones`

      return rows as { expired_left: string; fresh_left: string }
    })

    expect(Number(result.expired_left)).toBe(0)
    expect(Number(result.fresh_left)).toBe(1)
  })

  test('a null per-table TTL inherits the project default from _settings', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`update kizunasync._config set tombstone_ttl_days = null where table_name = 'todos'`
      await tx`update kizunasync._settings set tombstone_ttl_days = 3 where id`
      const expired = await seedTombstone(tx, 'todos', 5)
      const fresh = await seedTombstone(tx, 'todos', 1)

      await tx`select kizunasync.reap_tombstones()`
      const [rows] = await tx`
        select
          count(*) filter (where pk::text = ${expired}) as expired_left,
          count(*) filter (where pk::text = ${fresh}) as fresh_left
        from kizunasync._tombstones`

      return rows as { expired_left: string; fresh_left: string }
    })

    expect(Number(result.expired_left)).toBe(0)
    expect(Number(result.fresh_left)).toBe(1)
  })

  test('reaps a table removed from _config, with its changelog and row HLC', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`update kizunasync._settings set tombstone_ttl_days = 30 where id`
      const removed = 'retired_table'
      const pk = await seedTombstone(tx, removed, 90)

      await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op, arrived_at)
        values (nextval('kizunasync._change_seq'), ${removed}, ${pk}::uuid, 'upsert', now() - make_interval(days => 90))`
      await tx`
        insert into kizunasync._row_hlc (table_name, pk, column_hlc)
        values (${removed}, ${pk}::uuid, '{}'::jsonb)`
      await tx`select kizunasync.reap_tombstones()`
      const [rows] = await tx`
        select
          (select count(*) from kizunasync._tombstones where table_name = ${removed}) as tombstones,
          (select count(*) from kizunasync._changelog where table_name = ${removed}) as changelog,
          (select count(*) from kizunasync._row_hlc where table_name = ${removed}) as row_hlc`

      return rows as { tombstones: string; changelog: string; row_hlc: string }
    })

    expect(Number(result.tombstones)).toBe(0)
    expect(Number(result.changelog)).toBe(0)
    expect(Number(result.row_hlc)).toBe(0)
  })

  test('writes reaped_at on a run that expires nothing', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`update kizunasync._reap_state set reaped_at = null, reaped_seq = 0 where id`
      await tx`select kizunasync.reap_tombstones()`
      const [state] = await tx`select reaped_at, reaped_seq::text as reaped_seq from kizunasync._reap_state where id`

      return state as { reaped_at: Date | null; reaped_seq: string }
    })

    expect(result.reaped_at).not.toBeNull()
    expect(Number(result.reaped_seq)).toBe(0)
  })

  test('raises the watermark to the highest reaped tombstone seq', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`update kizunasync._settings set tombstone_ttl_days = 1 where id`
      await tx`update kizunasync._reap_state set reaped_seq = 0, reaped_at = null where id`
      await seedTombstone(tx, 'retired_table', 10)
      const [last] = await tx`
        select max(seq)::text as seq from kizunasync._tombstones where table_name = 'retired_table'`

      await tx`select kizunasync.reap_tombstones()`
      const [state] = await tx`select reaped_seq::text as reaped_seq from kizunasync._reap_state where id`

      return { reaped: (state as { reaped_seq: string }).reaped_seq, seeded: (last as { seq: string }).seq }
    })

    expect(result.reaped).toBe(result.seeded)
  })
})

describe.skipIf(!reachable)('kizunasync.compact_changelog', () => {
  test('an empty registry compacts up to the sequence high-water', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      const [first] = await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', gen_random_uuid(), 'upsert')
        returning pk::text as pk, seq::text as seq`
      const pk = (first as { pk: string }).pk

      await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', ${pk}::uuid, 'upsert')`
      await tx`select kizunasync.compact_changelog()`
      const [rows] = await tx`
        select count(*) as kept, min(seq)::text as lowest
        from kizunasync._changelog where pk = ${pk}`

      return rows as { kept: string; lowest: string }
    })

    expect(Number(result.kept)).toBe(1)
  })

  test('a live client holds its cursor: the superseded row stays', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      await tx`update kizunasync._reap_state set reaped_seq = 0 where id`
      const [first] = await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', gen_random_uuid(), 'upsert')
        returning pk::text as pk, seq::text as seq`
      const pk = (first as { pk: string }).pk
      const older = (first as { seq: string }).seq

      await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', ${pk}::uuid, 'upsert')`
      const [user] =
        await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`

      await tx`
        insert into kizunasync._clients (client_id, user_id, cursor, last_seen)
        values (gen_random_uuid(), ${(user as { id: string }).id}::uuid, ${String(Number(older) - 1)}, now())`
      await tx`select kizunasync.compact_changelog()`
      const [rows] = await tx`select count(*) as kept from kizunasync._changelog where pk = ${pk}`

      return rows as { kept: string }
    })

    expect(Number(result.kept)).toBe(2)
  })

  test('a client silent past client_ttl_days stops holding the floor', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      await tx`update kizunasync._settings set client_ttl_days = 30 where id`
      const [first] = await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', gen_random_uuid(), 'upsert')
        returning pk::text as pk, seq::text as seq`
      const pk = (first as { pk: string }).pk
      const older = (first as { seq: string }).seq

      await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', ${pk}::uuid, 'upsert')`
      const [user] =
        await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`

      await tx`
        insert into kizunasync._clients (client_id, user_id, cursor, last_seen)
        values (
          gen_random_uuid(), ${(user as { id: string }).id}::uuid, ${String(Number(older) - 1)},
          now() - make_interval(days => 60)
        )`
      await tx`select kizunasync.compact_changelog()`
      const [rows] = await tx`select count(*) as kept from kizunasync._changelog where pk = ${pk}`

      return rows as { kept: string }
    })

    expect(Number(result.kept)).toBe(1)
  })

  test('a registration still at cursor 0 does not hold the floor', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      await tx`update kizunasync._reap_state set reaped_seq = 0 where id`
      const pk = await seedSuperseded(tx)
      const owner = await newUser(tx)

      await tx`
        insert into kizunasync._clients (client_id, user_id, cursor, last_seen)
        values (gen_random_uuid(), ${owner}::uuid, '0', now())`
      await tx`select kizunasync.compact_changelog()`
      const [rows] = await tx`select count(*) as kept from kizunasync._changelog where pk = ${pk}`

      return rows as { kept: string }
    })

    expect(Number(result.kept)).toBe(1)
  })

  test('the floor never sits below the reap horizon', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      const pk = await seedSuperseded(tx)
      const [oldest] = await tx`
        select min(seq)::text as seq from kizunasync._changelog where pk = ${pk}`
      const older = (oldest as { seq: string }).seq
      const owner = await newUser(tx)

      await tx`
        insert into kizunasync._clients (client_id, user_id, cursor, last_seen)
        values (gen_random_uuid(), ${owner}::uuid, ${String(Number(older) - 1)}, now())`
      await tx`update kizunasync._reap_state set reaped_seq = ${older}::bigint where id`
      await tx`select kizunasync.compact_changelog()`
      const [rows] = await tx`select count(*) as kept from kizunasync._changelog where pk = ${pk}`

      return rows as { kept: string }
    })

    expect(Number(result.kept)).toBe(1)
  })

  test('a changelog row a newer tombstone supersedes goes, and a row newer than the tombstone stays', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      const [deleted] = await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', gen_random_uuid(), 'upsert')
        returning pk::text as pk`
      const deletedPk = (deleted as { pk: string }).pk
      const [recreated] = await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', gen_random_uuid(), 'upsert')
        returning pk::text as pk`
      const recreatedPk = (recreated as { pk: string }).pk

      await tx`
        insert into kizunasync._tombstones (seq, table_name, pk, bucket_value)
        values
          (nextval('kizunasync._change_seq'), 'todos', ${deletedPk}::uuid, ''),
          (nextval('kizunasync._change_seq'), 'todos', ${recreatedPk}::uuid, 'moved-out')`
      const [latest] = await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', ${recreatedPk}::uuid, 'upsert')
        returning seq::text as seq`
      const [deletedCount] = await tx`select kizunasync.compact_changelog()::text as n`
      const deletedLeft = await tx`select seq from kizunasync._changelog where pk = ${deletedPk}`
      const recreatedLeft = await tx`
        select seq::text as seq from kizunasync._changelog where pk = ${recreatedPk}`
      const [tombstones] = await tx`
        select count(*) as n from kizunasync._tombstones where pk = any(${`{${deletedPk},${recreatedPk}}`}::text[])`

      return {
        compacted: Number((deletedCount as { n: string }).n),
        deletedLeft: deletedLeft.length,
        recreatedLeft: recreatedLeft.map((row) => (row as { seq: string }).seq),
        latest: (latest as { seq: string }).seq,
        tombstones: Number((tombstones as { n: string }).n),
      }
    })

    expect(result.deletedLeft).toBe(0)
    expect(result.recreatedLeft).toEqual([result.latest])
    expect(result.tombstones).toBe(2)
    expect(result.compacted).toBeGreaterThanOrEqual(2)
  })

  test('a live client below the row still holds a row a tombstone supersedes', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      await tx`update kizunasync._reap_state set reaped_seq = 0 where id`
      const [row] = await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', gen_random_uuid(), 'upsert')
        returning pk::text as pk, seq::text as seq`
      const pk = (row as { pk: string }).pk
      const owner = await newUser(tx)

      await tx`
        insert into kizunasync._tombstones (seq, table_name, pk, bucket_value)
        values (nextval('kizunasync._change_seq'), 'todos', ${pk}::uuid, '')`
      await tx`
        insert into kizunasync._clients (client_id, user_id, cursor, last_seen)
        values (gen_random_uuid(), ${owner}::uuid, ${String(Number((row as { seq: string }).seq) - 1)}, now())`
      await tx`select kizunasync.compact_changelog()`
      const [rows] = await tx`select count(*) as kept from kizunasync._changelog where pk = ${pk}`

      return rows as { kept: string }
    })

    expect(Number(result.kept)).toBe(1)
  })

  test('a conflict-journal row whose winning changelog row is gone goes with it', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      const [first] = await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', gen_random_uuid(), 'upsert')
        returning pk::text as pk, seq::text as seq`
      const pk = (first as { pk: string }).pk
      const [second] = await tx`
        insert into kizunasync._changelog (seq, table_name, pk, op)
        values (nextval('kizunasync._change_seq'), 'todos', ${pk}::uuid, 'upsert')
        returning seq::text as seq`
      const [orphan] = await tx`select nextval('kizunasync._change_seq')::text as seq`
      const winners = [
        (first as { seq: string }).seq,
        (second as { seq: string }).seq,
        (orphan as { seq: string }).seq,
      ]

      for (const winner of winners) {
        await tx`
          insert into kizunasync._conflict_journal (
            table_name, pk, column_name, loser_value, winner_mutation_id, conflict_mode, winner_seq
          ) values ('todos', ${pk}::uuid, 'title', '"lost"'::jsonb, gen_random_uuid(), 'arrival', ${winner}::bigint)`
      }
      await tx`select kizunasync.compact_changelog()`
      const left = await tx`
        select winner_seq::text as winner_seq from kizunasync._conflict_journal
        where pk = ${pk} order by winner_seq`

      return { left: left.map((row) => (row as { winner_seq: string }).winner_seq), kept: winners[1] }
    })

    expect(result.left).toEqual([result.kept])
  })
})

describe.skipIf(!reachable)('kizunasync.track_delete', () => {
  test('a direct delete clears the row HLC state', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const [todo] = await tx`
        insert into public.todos (id, user_id, title)
        values (gen_random_uuid(), ${owner}::uuid, 'stamped')
        returning id::text as id`
      const pk = (todo as { id: string }).id

      await tx`
        insert into kizunasync._row_hlc (table_name, pk, column_hlc)
        values ('todos', ${pk}::uuid, '{"title":"2026-01-01T00:00:00.000Z|0|node"}'::jsonb)`
      await tx`delete from public.todos where id = ${pk}::uuid`
      const [rows] = await tx`select count(*) as left from kizunasync._row_hlc where table_name = 'todos' and pk = ${pk}`

      return rows as { left: string }
    })

    expect(Number(result.left)).toBe(0)
  })
})

describe.skipIf(!reachable)('kizunasync.prune_clients', () => {
  test('deletes the clients past client_ttl_days and keeps the live ones', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      await tx`delete from kizunasync._clients`
      await tx`update kizunasync._settings set client_ttl_days = 30 where id`
      const [user] =
        await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const owner = (user as { id: string }).id
      const [stale] = await tx`
        insert into kizunasync._clients (client_id, user_id, last_seen)
        values (gen_random_uuid(), ${owner}::uuid, now() - make_interval(days => 31))
        returning client_id::text as client_id`
      const [live] = await tx`
        insert into kizunasync._clients (client_id, user_id, last_seen)
        values (gen_random_uuid(), ${owner}::uuid, now() - make_interval(days => 29))
        returning client_id::text as client_id`
      const [pruned] = await tx`select kizunasync.prune_clients()::text as pruned`
      const [rows] = await tx`
        select
          count(*) filter (where client_id::text = ${(stale as { client_id: string }).client_id}) as stale_left,
          count(*) filter (where client_id::text = ${(live as { client_id: string }).client_id}) as live_left
        from kizunasync._clients`

      return {
        pruned: (pruned as { pruned: string }).pruned,
        ...(rows as { stale_left: string; live_left: string }),
      }
    })

    expect(Number(result.pruned)).toBe(1)
    expect(Number(result.stale_left)).toBe(0)
    expect(Number(result.live_left)).toBe(1)
  })

  test('deletes the bucket grants of users missing from auth.users, and keeps the rest however old', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const [user] =
        await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id::text as id`
      const kept = (user as { id: string }).id
      const gone = crypto.randomUUID()

      await tx`
        insert into kizunasync._bucket_grants (user_id, table_name, bucket_value, granted_at)
        values
          (${kept}::uuid, 'todos', '', now() - make_interval(days => 3650)),
          (${gone}::uuid, 'todos', '', now())`
      await tx`select kizunasync.prune_clients()`
      const left = await tx`
        select user_id::text as user_id from kizunasync._bucket_grants
        where user_id = any(${`{${kept},${gone}}`}::uuid[])`

      return { kept, left: left.map((row) => (row as { user_id: string }).user_id) }
    })

    expect(result.left).toEqual([result.kept])
  })
})
