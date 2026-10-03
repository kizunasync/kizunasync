/**
 * Suite-wide check for the live SQL tests, loaded with `--preload` by the
 * package's `test` script so its hooks wrap every test file. A committed pull
 * records a `_bucket_grants` row per bucket value it delivered, and the users a
 * test mints are deleted in its teardown, so every file that commits pulls
 * deletes the grants it produced. This file proves the whole run leaves no
 * grant row behind that was not there when it started. Skips when Postgres is
 * unreachable, like every test file.
 */

import { afterAll, beforeAll, expect } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

type TGrant = { user_id: string; table_name: string; bucket_value: string }

/** The grant rows present before the first test file ran; null when no database answered. */
let before: Set<string> | null = null

const keyOf = (grant: TGrant): string => `${grant.user_id} ${grant.table_name} ${grant.bucket_value}`

async function readGrants(): Promise<TGrant[]> {
  const db = new SQL(DB_URL, { max: 1 })

  try {
    return await db<TGrant[]>`select user_id::text as user_id, table_name, bucket_value from kizunasync._bucket_grants order by 1, 2, 3`
  } finally {
    await db.end()
  }
}

beforeAll(async () => {
  try {
    before = new Set((await readGrants()).map(keyOf))
  } catch {
    before = null
  }
})

afterAll(async () => {
  if (before === null) {
    return
  }
  const known = before
  const left = (await readGrants()).filter((grant) => !known.has(keyOf(grant)))

  expect(left, 'bucket grants the test files left behind').toEqual([])
})
