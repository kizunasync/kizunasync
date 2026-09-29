import { expect, test } from '@playwright/test'
import { callEngine, openEngine, openEngineExpectingFailure, PAGE_PATH } from './harness'

// MARK: - A held OPFS store fails loud rather than swapping itself out

/**
 * Two dedicated workers, one store. The driver names differ, so the two pages win
 * separate elections and each runs a worker of its own, while the `database_path`
 * they open is the same: `sahpool_directory` derives one pool directory from that
 * path, and the second worker cannot take handles the first is holding.
 *
 * It must not fall back. A silent swap to the relaxed IndexedDB VFS costs a page a
 * reload's worth of rows while it still reports a healthy engine. The store retries
 * ten times over about 1.8 s and then fails with `VfsBusy`, naming the database.
 * The engine's failure envelope carries that to the page as `STORE_BUSY`: a store
 * some other context holds, which a later open may well get. That is not the flat
 * `ENGINE_UNAVAILABLE` a browser with no persistent VFS at all reports. Both `code`
 * and the message are asserted: `page.evaluate` rejects with a plain `Error`, so
 * the harness reads `code` inside the page and returns it as data.
 */

/** The store both pages open. Only this is shared; the driver names are not. */
const DATABASE = 'busy-shared'

const HOLDER = 'busy-holder'

const CONTENDER = 'busy-contender'

/**
 * Ten attempts with nine 200 ms waits between them. The floor is deliberately
 * under that: the assertion is that the store waited, not that it used this
 * exact schedule. The schedule belongs to the Rust unit tests.
 */
const MIN_RETRY_MS = 1_200

test('a second worker on a held OPFS store fails loud instead of falling back', async ({
  context,
}) => {
  const holder = await context.newPage()

  await holder.goto(PAGE_PATH)
  await openEngine(holder, { name: HOLDER, databasePath: DATABASE })
  expect(await callEngine(holder, 'ping')).toBe('pong')

  const contender = await context.newPage()

  await contender.goto(PAGE_PATH)

  const startedAt = Date.now()
  const failure = await openEngineExpectingFailure(contender, {
    name: CONTENDER,
    databasePath: DATABASE,
  })

  expect(failure).not.toBeNull()
  expect(failure?.code).toBe('STORE_BUSY')
  expect(failure?.message).toContain(DATABASE)
  expect(failure?.message).toContain('is held by another browser context')
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(MIN_RETRY_MS)

  // Failing means no second store was created behind the app's back. Nothing reports healthy over an empty database.
  const databases = await contender.evaluate(async () =>
    (await indexedDB.databases()).map((entry) => entry.name ?? '?'),
  )

  expect(databases).not.toContain('relaxed-idb')

  // The holder is untouched by the contention.
  expect(await callEngine(holder, 'ping')).toBe('pong')
})
