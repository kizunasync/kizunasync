import { expect, test } from '@playwright/test'
import { closeEngines, insertRow, openEngine, PAGE_PATH, readRowIds, readStoreKindOn } from './harness'

// MARK: - The default path is the durable one, and it keeps what it was given

/**
 * Nothing configured, nothing refused: a Chromium tab must land on the OPFS
 * synchronous-access-handle pool and report full durability. Fallback is the
 * exception path, not the default.
 *
 * Then the part a VFS name cannot prove: a row written before the engine closed is
 * still there when the same database is opened again. The close is awaited through
 * the driver's own teardown. The reopen is not racing the outgoing worker for the
 * store it still holds.
 */
const DATABASE = 'durability-store'

const TABLE = 'items'

/** The bucket the page's table config declares, so the row is inside it. */
const OWNER = 'u1'

const OPFS = { kind: 'opfs-sahpool', durability: 'full' }

test('the default store is opfs-sahpool at full durability and survives a reopen', async ({
  page,
}) => {
  await page.goto(PAGE_PATH)
  await openEngine(page, { name: DATABASE, databasePath: DATABASE, table: TABLE })

  expect(await readStoreKindOn(page, DATABASE)).toEqual(OPFS)

  await insertRow(page, {
    name: DATABASE,
    table: TABLE,
    columns: { id: 'written-before-close', user_id: OWNER, title: 'still here after the reopen' },
  })
  await closeEngines(page)

  await openEngine(page, { name: DATABASE, databasePath: DATABASE, table: TABLE })

  expect(await readRowIds(page, DATABASE, TABLE)).toEqual(['written-before-close'])
  expect(await readStoreKindOn(page, DATABASE)).toEqual(OPFS)
})
