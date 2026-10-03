/**
 * kizunasync.push hlc-mode skew clamp against real Postgres. A write
 * carrying a far-future origin HLC is clamped server-side to ~now; a later
 * honest write overwrites it. Without the clamp the raw far-future HLC would
 * sit as the column high-water and lock the column out (every honest write
 * SUPERSEDED).
 *
 * Each case runs in a rolled-back txn (the DB is untouched): it flips todos to
 * conflict_mode 'hlc' locally, owns the row as the actor, and pushes under a real
 * JWT + the authenticated role. Skips loudly (named reason) when no DB is reachable.
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
    `[rpc-hlc-skew-clamp] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
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
  server_row?: unknown
}

const FAR_FUTURE_HLC = '9999-12-31T23:59:59.999Z|0|00000000-0000-4000-8000-deadbeef0001'

/**
 * Push a single hlc-mode update of `columns` to `pk` as `actorId`, returning the
 * verdict. The caller owns the surrounding txn (so a sequence of pushes shares the
 * committed state); honestHlc is built from the live clock at call time.
 */
async function pushHlc(
  tx: SQL,
  actorId: string,
  pk: string,
  columns: Record<string, unknown>,
  hlc: string,
): Promise<IVerdict> {
  const claims = JSON.stringify({ sub: actorId, role: 'authenticated' })

  await tx`select set_config('request.jwt.claims', ${claims}, true)`
  await tx`set local role authenticated`
  const batch = {
    atomic: false,
    mutations: [
      { mutation_id: crypto.randomUUID(), table: 'todos', pk, op: 'update', columns, hlc },
    ],
  }
  const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

  // Reset role so subsequent setup statements (and the next push) run unprivileged-free.
  await tx`reset role`

  return (row.resp as { verdicts: IVerdict[] }).verdicts[0] as IVerdict
}

describe.skipIf(!reachable)('kizunasync.push hlc-mode clamps far-future HLCs', () => {
  test('a far-future HLC write does NOT lock the column out, an honest write OVERWRITES it', async () => {
    let result:
      | { farVerdict: IVerdict; honestVerdict: IVerdict; finalTitle: string | null }
      | undefined

    try {
      await db!.begin(async (tx) => {
        // Opt todos into hlc mode inside this rolled-back txn only.
        await tx`update kizunasync._config set conflict_mode = 'hlc' where table_name = 'todos'`

        const [actor] = await tx`
          insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
        const [todo] = await tx`
          insert into public.todos (id, user_id, title, done)
          values (gen_random_uuid(), ${actor.id}, 'original', false)
          returning id`

        // 1. Poison attempt: applied (beats empty high-water), but high-water is CLAMPED to ~now.
        const farVerdict = await pushHlc(
          tx,
          actor.id,
          todo.id,
          { title: 'poisoned' },
          FAR_FUTURE_HLC,
        )

        // 2. Honest write (now + 10s): its physical part is clamped to serverNow+5s, which strictly exceeds the poison's clamped ceiling (clock advanced), so the honest write WINS. The higher logical (9 vs 0) guards the same-millisecond case.
        const honestPhysical = new Date(Date.now() + 10_000).toISOString()
        const honestHlc = `${honestPhysical}|9|00000000-0000-4000-8000-honest000001`
        const honestVerdict = await pushHlc(
          tx,
          actor.id,
          todo.id,
          { title: 'honest-recovery' },
          honestHlc,
        )

        const [finalRow] =
          await tx`select title from public.todos where id = ${todo.id}::uuid`

        result = {
          farVerdict,
          honestVerdict,
          finalTitle: finalRow?.title ?? null,
        }

        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error
      }
    }
    if (result === undefined) {
      throw new Error('no result captured')
    }

    // The poison write applied (won the empty high-water)…
    expect(result.farVerdict.verdict).toBe('applied')
    // …but did NOT lock the column: the honest write OVERWRITES it.
    expect(result.honestVerdict.verdict).toBe('applied')
    expect(result.finalTitle).toBe('honest-recovery')
  })

  test('a far-future HLC physical part is clamped to ~now by _clamp_hlc, keeping logical+node', async () => {
    const [row] = await db!`
      select kizunasync._clamp_hlc(${FAR_FUTURE_HLC}, now(), 5000) as clamped`
    const clamped = row.clamped as string
    const [iso, logical, node] = clamped.split('|')

    // Physical part bounded to ~now (this decade, not year 9999).
    expect(iso.startsWith('20')).toBe(true)
    expect(iso < '9999').toBe(true)
    // _clamp_hlc carries the logical counter and the node id through verbatim.
    expect(logical).toBe('0')
    expect(node).toBe('00000000-0000-4000-8000-deadbeef0001')
  })

  test('an in-bounds HLC passes through _clamp_hlc UNCHANGED (honest path byte-identical)', async () => {
    const inBounds = '2020-01-01T00:00:00.000Z|7|00000000-0000-4000-8000-inbounds0001'
    const [row] = await db!`select kizunasync._clamp_hlc(${inBounds}, now(), 5000) as clamped`

    expect(row.clamped).toBe(inBounds)
  })

  // The ceiling a push clamps to is _settings.hlc_max_skew_ms, not a constant: the stored high-water lands at now + the configured tolerance.
  async function clampedHighWaterMs(skewMs: number): Promise<number> {
    let stored: string | undefined
    let at = 0

    try {
      await db!.begin(async (tx) => {
        await tx`update kizunasync._config set conflict_mode = 'hlc' where table_name = 'todos'`
        await tx`update kizunasync._settings set hlc_max_skew_ms = ${skewMs} where id`
        const [actor] = await tx`
          insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
        const [todo] = await tx`
          insert into public.todos (id, user_id, title, done)
          values (gen_random_uuid(), ${actor.id}, 'original', false)
          returning id`

        at = Date.now()
        await pushHlc(tx as unknown as SQL, actor.id as string, todo.id as string, { title: 'far' }, FAR_FUTURE_HLC)
        const [row] = await tx`
          select column_hlc ->> 'title' as hlc
          from kizunasync._row_hlc where table_name = 'todos' and pk = ${todo.id}`

        stored = row?.hlc as string | undefined

        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error
      }
    }
    if (stored === undefined) {
      throw new Error('no stored HLC captured')
    }
    return Date.parse(stored.split('|')[0]) - at
  }

  test('the clamp ceiling follows _settings.hlc_max_skew_ms', async () => {
    const oneDayMs = 86_400_000
    const wide = await clampedHighWaterMs(oneDayMs)
    const tight = await clampedHighWaterMs(0)

    // Each ceiling sits at now + its own tolerance, within a generous slack for the round trip; the two are a day apart, which a constant could not produce.
    expect(Math.abs(wide - oneDayMs)).toBeLessThan(60_000)
    expect(Math.abs(tight)).toBeLessThan(60_000)
  })
})
