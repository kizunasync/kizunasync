/**
 * SQL pack cursor codec against the shared accept/reject vectors, plus every
 * token form the pack decodes: checkpoints with and without holes, and
 * continuations, which carry the start of their transfer, with and without holes.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, '../../protocol/spec/cursor-token-vectors.json'), 'utf8'),
) as { accept: string[]; reject: string[] }

/** Every form, with the start, high-water, and holes it decodes to. */
const FORMS: { token: string; start: string | null; highWater: string; holes: string[] }[] = [
  { token: '0', start: null, highWater: '0', holes: [] },
  { token: '42', start: null, highWater: '42', holes: [] },
  { token: '42~3.7', start: null, highWater: '42', holes: ['3', '7'] },
  { token: '0:5', start: '0', highWater: '5', holes: [] },
  { token: '7:42', start: '7', highWater: '42', holes: [] },
  { token: '7:42~3.7', start: '7', highWater: '42', holes: ['3', '7'] },
  { token: '100:10', start: '100', highWater: '10', holes: [] },
]

/** Tokens outside the grammar or its hole rules, continuation shapes and a null included. */
const MALFORMED: (string | null)[] = [
  null,
  '',
  ':',
  ':5',
  '5:',
  '-1:5',
  '+1:5',
  '1:2:3',
  '1::2',
  '01:5',
  '5:01',
  '1: 2',
  ' 1:2',
  'a:1',
  '1:2~',
  '1:~2',
  '5:5~5',
  '5:5~3.2',
  '5~',
  '5~0',
  '5~5',
  '5~3.2',
]

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[cursor-token] SKIPPED: no Postgres at ${DB_URL}. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

/** The token re-encoded from what the three decoders return: a continuation keeps its start in front of the checkpoint form. */
async function reencode(token: string): Promise<string> {
  const [row] = await db!`
    select kizunasync._cursor_start(${token})::text as start,
           kizunasync._encode_cursor(kizunasync._cursor_high_water(${token}), kizunasync._cursor_holes(${token})) as position`
  const { start, position } = row as { start: string | null; position: string }

  return start === null ? position : `${start}:${position}`
}

/** The decoders that refuse `token`, by name. */
async function refusingDecoders(token: string | null): Promise<string[]> {
  const refusing: string[] = []

  for (const decoder of ['_cursor_start', '_cursor_high_water', '_cursor_holes']) {
    try {
      await db!.unsafe(`select kizunasync.${decoder}($1)`, [token])
    } catch {
      refusing.push(decoder)
    }
  }

  return refusing
}

describe.skipIf(!reachable)('SQL cursor codec', () => {
  test('accepts every shared canonical token and round-trips it', async () => {
    for (const token of vectors.accept) {
      expect(await reencode(token), token).toBe(token)
    }
  })

  test('rejects every shared non-canonical token in every decoder', async () => {
    for (const token of vectors.reject) {
      expect(await refusingDecoders(token), token).toEqual(['_cursor_start', '_cursor_high_water', '_cursor_holes'])
    }
  })

  test('decodes every form into its start, high-water, and holes, and round-trips it', async () => {
    for (const form of FORMS) {
      const [row] = await db!`
        select kizunasync._cursor_start(${form.token})::text as start,
               kizunasync._cursor_high_water(${form.token})::text as high_water,
               kizunasync._cursor_holes(${form.token})::text[] as holes`

      expect(row, form.token).toEqual({ start: form.start, high_water: form.highWater, holes: form.holes })
      expect(await reencode(form.token), form.token).toBe(form.token)
    }
  })

  test('encodes a continuation as its start and its position', async () => {
    const [row] = await db!`
      select kizunasync._encode_continuation(0, 5) as bootstrap,
             kizunasync._encode_continuation(7, 42) as incremental,
             kizunasync._encode_continuation(100, 10) as below_start`

    expect(row).toEqual({ bootstrap: '0:5', incremental: '7:42', below_start: '100:10' })
  })

  test('rejects every malformed token in every decoder', async () => {
    for (const token of MALFORMED) {
      expect(await refusingDecoders(token), JSON.stringify(token)).toEqual(['_cursor_start', '_cursor_high_water', '_cursor_holes'])
    }
  })
})
